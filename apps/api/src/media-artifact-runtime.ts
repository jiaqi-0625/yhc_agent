import { createHash, timingSafeEqual } from "node:crypto";

import {
  assertCanOperateVideoTask,
  assertCanViewBatchProject,
  assertCanViewVideoTask,
  WorkspaceAccessDeniedError,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  MediaArtifact,
  MediaArtifactAccessPurpose,
  MediaArtifactAccessResponse,
  StageArtifactContentReference,
  VideoTaskStage,
} from "@firefly/schemas";

import type { BatchProjectStore } from "./batch-project-store.ts";
import {
  MediaArtifactCreationConflictError,
  mediaArtifactContentReference,
  mediaArtifactObjectKey,
  type MediaArtifactCreateCandidate,
  type MediaArtifactStore,
} from "./media-artifact-store.ts";
import {
  MediaObjectStorageError,
  type MediaObjectHead,
  type MediaObjectReadAccess,
  type MediaObjectStorage,
} from "./media-object-storage.ts";
import type { VideoTaskProductionStore } from "./video-task-store.ts";
import type {
  WorkspaceAdminState,
  WorkspaceAdminStore,
} from "./workspace-admin-store.ts";

export type MediaArtifactRuntimeErrorCode =
  | "AIC-MEDIA-ARTIFACT-NOT_FOUND"
  | "AIC-MEDIA-ARTIFACT-NOT_READY"
  | "AIC-MEDIA-ARTIFACT-IDEMPOTENCY_CONFLICT"
  | "AIC-MEDIA-ARTIFACT-ACCESS_UNAVAILABLE";

export class MediaArtifactRuntimeError extends Error {
  constructor(
    readonly code: MediaArtifactRuntimeErrorCode,
    message: string,
    readonly statusCode: 404 | 409 | 503,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "MediaArtifactRuntimeError";
  }
}

export interface RegisterReadyMediaArtifactResult {
  readonly artifact: MediaArtifact;
  readonly reference: StageArtifactContentReference;
  readonly replayed: boolean;
}

export interface StageMediaArtifactVerificationInput {
  readonly tenantId: string;
  readonly batchProjectId: string;
  readonly videoTaskId: string;
  readonly stage: "video_preview" | "delivery";
  readonly artifact: StageArtifactContentReference;
}

export interface StageMediaArtifactVerifier {
  verifyStageArtifact(
    input: Readonly<StageMediaArtifactVerificationInput>,
  ): Promise<void>;
}

function notFound(): MediaArtifactRuntimeError {
  return new MediaArtifactRuntimeError(
    "AIC-MEDIA-ARTIFACT-NOT_FOUND",
    "The requested media artifact was not found.",
    404,
  );
}

function notReady(): MediaArtifactRuntimeError {
  return new MediaArtifactRuntimeError(
    "AIC-MEDIA-ARTIFACT-NOT_READY",
    "The media artifact is not ready for this operation.",
    409,
  );
}

function idempotencyConflict(): MediaArtifactRuntimeError {
  return new MediaArtifactRuntimeError(
    "AIC-MEDIA-ARTIFACT-IDEMPOTENCY_CONFLICT",
    "The media artifact request ID was already used with different input.",
    409,
  );
}

function accessUnavailable(): MediaArtifactRuntimeError {
  return new MediaArtifactRuntimeError(
    "AIC-MEDIA-ARTIFACT-ACCESS_UNAVAILABLE",
    "Media artifact access is temporarily unavailable.",
    503,
    true,
  );
}

function currentScope(
  session: Readonly<WorkspaceSessionScope>,
  state: Readonly<WorkspaceAdminState>,
): WorkspaceSessionScope {
  return {
    actorAccountId: session.actorAccountId,
    tenantId: session.tenantId,
    role: session.role,
    accessGrants: state.accessGrants.filter(
      (grant) => grant.accountId === session.actorAccountId,
    ),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Media artifact payload contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  throw new Error("Media artifact payload contains an unsupported value.");
}

function payloadHash(candidate: Readonly<MediaArtifactCreateCandidate>): string {
  return createHash("sha256").update(canonicalJson(candidate), "utf8").digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left.toLowerCase(), "hex");
  const rightBytes = Buffer.from(right.toLowerCase(), "hex");
  return leftBytes.byteLength === 32
    && rightBytes.byteLength === 32
    && timingSafeEqual(leftBytes, rightBytes);
}

function headMatchesArtifact(
  head: Readonly<MediaObjectHead>,
  artifact: Readonly<Pick<MediaArtifact, "byteSize" | "mediaType" | "checksumSha256">>,
  objectVersion: string | undefined,
): boolean {
  return head.contentLength === artifact.byteSize
    && head.contentType === artifact.mediaType
    && sameHash(head.checksumSha256, artifact.checksumSha256)
    && (head.versionId ?? undefined) === objectVersion;
}

function validReadAccess(access: Readonly<MediaObjectReadAccess>): boolean {
  if (access.method !== "GET" || !(access.expiresAt instanceof Date)) return false;
  if (!Number.isFinite(access.expiresAt.getTime())) return false;
  try {
    const parsed = new URL(access.url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.hash.length === 0;
  } catch {
    return false;
  }
}

function downloadFilename(artifact: Readonly<MediaArtifact>): string {
  const extension = artifact.mediaType === "video/mp4"
    ? ".mp4"
    : artifact.mediaType === "video/webm"
      ? ".webm"
      : "";
  return `${artifact.id}${extension}`;
}

export class MediaArtifactRuntime implements StageMediaArtifactVerifier {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskProductionStore,
    private readonly artifacts: MediaArtifactStore,
    private readonly storage: MediaObjectStorage,
  ) {}

  async #authorizedTask(
    projectId: string,
    videoTaskId: string,
    session: Readonly<WorkspaceSessionScope>,
  ) {
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = currentScope(session, state);
      const projectAggregate = await this.projects.load(scope.tenantId, projectId);
      if (projectAggregate === undefined) throw notFound();
      const project = projectAggregate.project;
      assertCanViewBatchProject(scope, project);
      const taskRecord = await this.tasks.load(videoTaskId);
      if (
        taskRecord === undefined
        || taskRecord.videoTask.tenantId !== scope.tenantId
        || taskRecord.videoTask.batchProjectId !== project.id
      ) {
        throw notFound();
      }
      assertCanViewVideoTask(scope, project, taskRecord.videoTask);
      return {
        scope,
        project: structuredClone(project),
        task: structuredClone(taskRecord.videoTask),
      };
    });
  }

  async createAccess(
    projectId: string,
    videoTaskId: string,
    artifactId: string,
    purpose: MediaArtifactAccessPurpose,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<MediaArtifactAccessResponse> {
    const authorized = await this.#authorizedTask(projectId, videoTaskId, session);
    const record = await this.artifacts.load(
      authorized.scope.tenantId,
      authorized.project.id,
      authorized.task.id,
      artifactId,
    );
    if (record === undefined) throw notFound();
    if (
      record.storage.providerId !== this.storage.providerId
      || record.storage.bucketName !== this.storage.bucketName
    ) {
      throw accessUnavailable();
    }

    let head: MediaObjectHead;
    try {
      head = await this.storage.headObject(record.storage.objectKey);
    } catch (error) {
      if (error instanceof MediaObjectStorageError && error.code === "OBJECT_NOT_FOUND") {
        throw notFound();
      }
      throw accessUnavailable();
    }
    if (!headMatchesArtifact(head, record.artifact, record.storage.objectVersion)) {
      throw notReady();
    }

    let access: MediaObjectReadAccess;
    try {
      access = await this.storage.createReadAccess({
        objectKey: record.storage.objectKey,
        ...(record.storage.objectVersion === undefined
          ? {}
          : { versionId: record.storage.objectVersion }),
        purpose,
        ...(purpose === "download"
          ? { downloadFilename: downloadFilename(record.artifact) }
          : {}),
      });
    } catch (error) {
      if (error instanceof MediaObjectStorageError && error.code === "OBJECT_NOT_FOUND") {
        throw notFound();
      }
      throw accessUnavailable();
    }
    if (!validReadAccess(access)) throw accessUnavailable();
    return {
      artifact: structuredClone(record.artifact),
      access: {
        method: "GET",
        url: access.url,
        expiresAt: access.expiresAt.toISOString(),
      },
    };
  }

  async registerReadyArtifact(
    projectId: string,
    videoTaskId: string,
    requestId: string,
    candidate: Readonly<MediaArtifactCreateCandidate>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<RegisterReadyMediaArtifactResult> {
    const authorized = await this.#authorizedTask(projectId, videoTaskId, session);
    if (authorized.scope.role !== "creator") {
      throw new WorkspaceAccessDeniedError(
        "AIC-AUTH-ROLE_DENIED",
        "Only an authorized production account can register media artifacts.",
      );
    }
    assertCanOperateVideoTask(authorized.scope, authorized.project, authorized.task);
    if (
      candidate.artifact.tenantId !== authorized.scope.tenantId
      || candidate.artifact.batchProjectId !== authorized.project.id
      || candidate.artifact.videoTaskId !== authorized.task.id
      || candidate.artifact.createdBy !== authorized.scope.actorAccountId
      || candidate.storage.providerId !== this.storage.providerId
      || candidate.storage.bucketName !== this.storage.bucketName
      || candidate.storage.objectKey !== mediaArtifactObjectKey({
        tenantId: authorized.scope.tenantId,
        batchProjectId: authorized.project.id,
        videoTaskId: authorized.task.id,
        artifactId: candidate.artifact.id,
      })
    ) {
      throw notReady();
    }

    let head: MediaObjectHead;
    try {
      head = await this.storage.headObject(candidate.storage.objectKey);
    } catch (error) {
      if (error instanceof MediaObjectStorageError && error.code === "OBJECT_NOT_FOUND") {
        throw notReady();
      }
      throw accessUnavailable();
    }
    if (!headMatchesArtifact(head, candidate.artifact, candidate.storage.objectVersion)) {
      throw notReady();
    }

    try {
      const result = await this.artifacts.createWithResult(candidate, {
        actorAccountId: authorized.scope.actorAccountId,
        requestId,
        payloadHash: payloadHash(candidate),
      });
      return {
        artifact: structuredClone(result.record.artifact),
        reference: mediaArtifactContentReference(result.record.artifact),
        replayed: result.replayed,
      };
    } catch (error) {
      if (error instanceof MediaArtifactCreationConflictError) {
        throw idempotencyConflict();
      }
      throw error;
    }
  }

  async verifyStageArtifact(
    input: Readonly<StageMediaArtifactVerificationInput>,
  ): Promise<void> {
    if (
      input.artifact.schemaName !== "media_artifact"
      || input.artifact.schemaVersion !== 1
    ) {
      throw notReady();
    }
    const record = await this.artifacts.load(
      input.tenantId,
      input.batchProjectId,
      input.videoTaskId,
      input.artifact.artifactId,
    );
    if (record === undefined || record.artifact.stage !== input.stage) throw notReady();
    const expected = mediaArtifactContentReference(record.artifact);
    if (!sameHash(expected.contentHashSha256, input.artifact.contentHashSha256)) {
      throw notReady();
    }
  }
}

export function isMediaArtifactStage(
  stage: VideoTaskStage,
): stage is "video_preview" | "delivery" {
  return stage === "video_preview" || stage === "delivery";
}
