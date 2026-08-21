import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceAccessDeniedError,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  BatchProject,
  MediaArtifact,
  VideoTask,
  WorkspaceAccessGrant,
} from "@firefly/schemas";

import type { BatchProjectStore } from "../src/batch-project-store.ts";
import {
  MediaArtifactCreationConflictError,
  mediaArtifactObjectKey,
  type MediaArtifactCreateCandidate,
  type MediaArtifactCreateResult,
  type MediaArtifactCreationMetadata,
  type MediaArtifactListFilter,
  type MediaArtifactRecord,
  type MediaArtifactStore,
} from "../src/media-artifact-store.ts";
import {
  MediaArtifactRuntime,
  MediaArtifactRuntimeError,
} from "../src/media-artifact-runtime.ts";
import {
  MediaObjectStorageError,
  type CreateMediaReadAccessInput,
  type MediaObjectHead,
  type MediaObjectReadAccess,
  type MediaObjectStorage,
  type PutMediaObjectInput,
} from "../src/media-object-storage.ts";
import type { VideoTaskProductionStore } from "../src/video-task-store.ts";
import type {
  WorkspaceAdminState,
  WorkspaceAdminStore,
} from "../src/workspace-admin-store.ts";

const tenantId = "tenant_media_runtime";
const projectId = "project_media_runtime";
const videoTaskId = "task_media_runtime";
const actorAccountId = "account_media_owner";
const occurredAt = "2026-08-20T09:00:00.000Z";

const project: BatchProject = {
  id: projectId,
  tenantId,
  brandId: "brand_media_runtime",
  vehicleId: "vehicle_media_runtime",
  vehicleVersion: 1,
  name: "媒体运行时项目",
  batchName: "媒体运行时",
  aspectRatio: "16:9",
  visualStylePresetId: "style_media_runtime",
  assetPoolId: "pool_media_runtime",
  status: "active",
  revision: 1,
  createdAt: occurredAt,
  createdBy: actorAccountId,
  updatedAt: occurredAt,
  updatedBy: actorAccountId,
};

const task: VideoTask = {
  id: videoTaskId,
  tenantId,
  batchProjectId: projectId,
  name: "媒体运行时任务",
  ownerAccountId: actorAccountId,
  status: "active",
  currentStage: "video_preview",
  stageStatus: "awaiting_confirmation",
  revision: 8,
  audience: "家庭用户",
  theme: "城市出行",
  durationSeconds: 30,
  platformTags: ["douyin"],
  createdAt: occurredAt,
  createdBy: actorAccountId,
  updatedAt: occurredAt,
  updatedBy: actorAccountId,
};

const grant: WorkspaceAccessGrant = {
  id: "grant_media_runtime",
  tenantId,
  accountId: actorAccountId,
  access: {
    kind: "vehicle_project",
    brandId: project.brandId,
    vehicleId: project.vehicleId,
  },
  status: "active",
  revision: 1,
  createdAt: occurredAt,
  createdBy: actorAccountId,
  updatedAt: occurredAt,
  updatedBy: actorAccountId,
};

const session: WorkspaceSessionScope = {
  actorAccountId,
  tenantId,
  role: "creator",
  accessGrants: [grant],
};

function recordKey(
  artifact: Pick<MediaArtifact, "tenantId" | "batchProjectId" | "videoTaskId" | "id">,
): string {
  return [artifact.tenantId, artifact.batchProjectId, artifact.videoTaskId, artifact.id].join(":");
}

class MemoryMediaArtifactStore implements MediaArtifactStore {
  readonly records = new Map<string, MediaArtifactRecord>();
  readonly requests = new Map<string, MediaArtifactRecord>();
  createCount = 0;

  async load(
    scopedTenantId: string,
    scopedProjectId: string,
    scopedVideoTaskId: string,
    artifactId: string,
  ): Promise<MediaArtifactRecord | undefined> {
    return structuredClone(this.records.get(
      [scopedTenantId, scopedProjectId, scopedVideoTaskId, artifactId].join(":"),
    ));
  }

  async list(
    scopedTenantId: string,
    scopedProjectId: string,
    scopedVideoTaskId: string,
    filter: Readonly<MediaArtifactListFilter> = {},
  ): Promise<MediaArtifactRecord[]> {
    return [...this.records.values()].filter(({ artifact }) =>
      artifact.tenantId === scopedTenantId
      && artifact.batchProjectId === scopedProjectId
      && artifact.videoTaskId === scopedVideoTaskId
      && (filter.stage === undefined || artifact.stage === filter.stage)
      && (filter.role === undefined || artifact.role === filter.role)
    ).map((record) => structuredClone(record));
  }

  async createWithResult(
    candidate: Readonly<MediaArtifactCreateCandidate>,
    metadata: Readonly<MediaArtifactCreationMetadata>,
  ): Promise<MediaArtifactCreateResult> {
    const requestKey = [
      candidate.artifact.tenantId,
      candidate.artifact.videoTaskId,
      metadata.actorAccountId,
      metadata.requestId,
    ].join(":");
    const existingRequest = this.requests.get(requestKey);
    if (existingRequest !== undefined) {
      if (existingRequest.creation.payloadHash !== metadata.payloadHash) {
        throw new MediaArtifactCreationConflictError();
      }
      return { record: structuredClone(existingRequest), replayed: true };
    }
    const version = [...this.records.values()].filter(({ artifact }) =>
      artifact.tenantId === candidate.artifact.tenantId
      && artifact.batchProjectId === candidate.artifact.batchProjectId
      && artifact.videoTaskId === candidate.artifact.videoTaskId
      && artifact.stage === candidate.artifact.stage
      && artifact.role === candidate.artifact.role
    ).length + 1;
    const record: MediaArtifactRecord = {
      artifact: { ...structuredClone(candidate.artifact), version } as MediaArtifact,
      storage: structuredClone(candidate.storage),
      creation: structuredClone(metadata),
    };
    if (this.records.has(recordKey(record.artifact))) {
      throw new MediaArtifactCreationConflictError();
    }
    this.createCount += 1;
    this.records.set(recordKey(record.artifact), structuredClone(record));
    this.requests.set(requestKey, structuredClone(record));
    return { record: structuredClone(record), replayed: false };
  }
}

class FakeMediaObjectStorage implements MediaObjectStorage {
  readonly providerId = "s3" as const;
  readonly bucketName = "firefly-media-test";
  headCount = 0;
  signCount = 0;
  lastReadInput: CreateMediaReadAccessInput | undefined;
  head: MediaObjectHead = {
    contentLength: 4096,
    contentType: "video/mp4",
    checksumSha256: "a".repeat(64),
    versionId: "object-version-1",
  };
  headError: Error | undefined;
  signError: Error | undefined;

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
  async putObject(_input: PutMediaObjectInput): Promise<MediaObjectHead> {
    return structuredClone(this.head);
  }
  async headObject(): Promise<MediaObjectHead> {
    this.headCount += 1;
    if (this.headError !== undefined) throw this.headError;
    return structuredClone(this.head);
  }
  async createReadAccess(
    input: CreateMediaReadAccessInput,
  ): Promise<MediaObjectReadAccess> {
    this.signCount += 1;
    this.lastReadInput = structuredClone(input);
    if (this.signError !== undefined) throw this.signError;
    return {
      method: "GET",
      url: "https://media.example.test/private/object?signature=temporary",
      expiresAt: new Date("2026-08-20T09:05:00.000Z"),
    };
  }
}

function candidate(
  artifactId = "artifact_media_preview",
): MediaArtifactCreateCandidate {
  return {
    artifact: {
      schemaVersion: 1,
      id: artifactId,
      tenantId,
      batchProjectId: projectId,
      videoTaskId,
      stage: "video_preview",
      role: "preview",
      mediaType: "video/mp4",
      byteSize: 4096,
      checksumSha256: "a".repeat(64),
      width: 1920,
      height: 1080,
      durationMs: 30_000,
      createdAt: occurredAt,
      createdBy: actorAccountId,
    },
    storage: {
      providerId: "s3",
      bucketName: "firefly-media-test",
      objectKey: mediaArtifactObjectKey({
        tenantId,
        batchProjectId: projectId,
        videoTaskId,
        artifactId,
      }),
      objectVersion: "object-version-1",
    },
  };
}

function fixture() {
  let accessGrants: WorkspaceAccessGrant[] = [structuredClone(grant)];
  const administration = {
    async withSnapshot<Result>(
      scopedTenantId: string,
      inspect: (state: WorkspaceAdminState) => Result | Promise<Result>,
    ): Promise<Result> {
      assert.equal(scopedTenantId, tenantId);
      return inspect({
        schemaVersion: 1,
        tenantId,
        brands: [],
        vehicleVersions: [],
        vehicleAssetAssociations: [],
        accessGrants: structuredClone(accessGrants),
      });
    },
  } as unknown as WorkspaceAdminStore;
  const projects = {
    async load(scopedTenantId: string, scopedProjectId: string) {
      return scopedTenantId === tenantId && scopedProjectId === projectId
        ? { project: structuredClone(project) }
        : undefined;
    },
  } as unknown as BatchProjectStore;
  const tasks = {
    async load(scopedTaskId: string) {
      return scopedTaskId === videoTaskId
        ? { videoTask: structuredClone(task) }
        : undefined;
    },
  } as unknown as VideoTaskProductionStore;
  const artifacts = new MemoryMediaArtifactStore();
  const storage = new FakeMediaObjectStorage();
  const runtime = new MediaArtifactRuntime(
    administration,
    projects,
    tasks,
    artifacts,
    storage,
  );
  return {
    runtime,
    artifacts,
    storage,
    revoke: () => {
      accessGrants = [{ ...structuredClone(grant), status: "revoked", revision: 2 }];
    },
  };
}

function hasRuntimeCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof MediaArtifactRuntimeError && error.code === code;
}

test("ready media registration verifies object metadata, computes its reference, and replays", async () => {
  const value = fixture();
  const input = candidate();
  const created = await value.runtime.registerReadyArtifact(
    projectId,
    videoTaskId,
    "request_media_registration",
    input,
    session,
  );
  assert.equal(created.replayed, false);
  assert.equal(created.artifact.version, 1);
  assert.deepEqual(created.reference, {
    artifactId: input.artifact.id,
    schemaName: "media_artifact",
    schemaVersion: 1,
    contentHashSha256: created.reference.contentHashSha256,
  });
  assert.match(created.reference.contentHashSha256, /^[0-9a-f]{64}$/u);

  const replay = await value.runtime.registerReadyArtifact(
    projectId,
    videoTaskId,
    "request_media_registration",
    input,
    session,
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay, { ...created, replayed: true });
  assert.equal(value.storage.headCount, 2);
  assert.equal(value.artifacts.createCount, 1);
});

test("registration rejects head mismatches, absent objects, non-owners, and idempotency conflicts", async () => {
  const unscopedKey = fixture();
  await assert.rejects(
    unscopedKey.runtime.registerReadyArtifact(
      projectId,
      videoTaskId,
      "request_unscoped_key",
      {
        ...candidate(),
        storage: { ...candidate().storage, objectKey: "other/task/video.mp4" },
      },
      session,
    ),
    hasRuntimeCode("AIC-MEDIA-ARTIFACT-NOT_READY"),
  );
  assert.equal(unscopedKey.storage.headCount, 0);
  assert.equal(unscopedKey.artifacts.createCount, 0);

  const mismatch = fixture();
  mismatch.storage.head = { ...mismatch.storage.head, contentLength: 4097 };
  await assert.rejects(
    mismatch.runtime.registerReadyArtifact(
      projectId,
      videoTaskId,
      "request_head_mismatch",
      candidate(),
      session,
    ),
    hasRuntimeCode("AIC-MEDIA-ARTIFACT-NOT_READY"),
  );
  assert.equal(mismatch.artifacts.createCount, 0);

  const absent = fixture();
  absent.storage.headError = new MediaObjectStorageError("head", "OBJECT_NOT_FOUND");
  await assert.rejects(
    absent.runtime.registerReadyArtifact(
      projectId,
      videoTaskId,
      "request_absent_object",
      candidate(),
      session,
    ),
    hasRuntimeCode("AIC-MEDIA-ARTIFACT-NOT_READY"),
  );

  const notOwner = fixture();
  await assert.rejects(
    notOwner.runtime.registerReadyArtifact(
      projectId,
      videoTaskId,
      "request_not_owner",
      { ...candidate(), artifact: { ...candidate().artifact, createdBy: "account_other" } },
      { ...session, actorAccountId: "account_other" },
    ),
    (error: unknown) => error instanceof WorkspaceAccessDeniedError,
  );

  const conflict = fixture();
  await conflict.runtime.registerReadyArtifact(
    projectId,
    videoTaskId,
    "request_conflict",
    candidate(),
    session,
  );
  await assert.rejects(
    conflict.runtime.registerReadyArtifact(
      projectId,
      videoTaskId,
      "request_conflict",
      candidate("artifact_different_payload"),
      session,
    ),
    hasRuntimeCode("AIC-MEDIA-ARTIFACT-IDEMPOTENCY_CONFLICT"),
  );
});

test("access reauthorizes scope before signing and exposes no storage locator", async () => {
  const value = fixture();
  const registered = await value.runtime.registerReadyArtifact(
    projectId,
    videoTaskId,
    "request_access_ready",
    candidate(),
    session,
  );
  const response = await value.runtime.createAccess(
    projectId,
    videoTaskId,
    registered.artifact.id,
    "download",
    session,
  );
  assert.equal(response.artifact.id, registered.artifact.id);
  assert.equal(response.access.method, "GET");
  assert.equal(response.access.expiresAt, "2026-08-20T09:05:00.000Z");
  assert.equal(value.storage.signCount, 1);
  assert.equal(
    value.storage.lastReadInput?.downloadFilename,
    `${registered.artifact.id}.mp4`,
  );
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /bucket|objectKey|objectVersion|firefly-media-test/iu);

  await assert.rejects(
    value.runtime.createAccess(
      projectId,
      videoTaskId,
      "artifact_missing",
      "download",
      session,
    ),
    hasRuntimeCode("AIC-MEDIA-ARTIFACT-NOT_FOUND"),
  );
  assert.equal(value.storage.signCount, 1);

  value.revoke();
  await assert.rejects(
    value.runtime.createAccess(
      projectId,
      videoTaskId,
      registered.artifact.id,
      "playback",
      session,
    ),
    (error: unknown) => error instanceof WorkspaceAccessDeniedError,
  );
  assert.equal(value.storage.signCount, 1);
});

test("access does not sign deleted or metadata-drifted media objects", async () => {
  const deleted = fixture();
  const deletedArtifact = await deleted.runtime.registerReadyArtifact(
    projectId,
    videoTaskId,
    "request_deleted_access",
    candidate("artifact_deleted_access"),
    session,
  );
  deleted.storage.headError = new MediaObjectStorageError("head", "OBJECT_NOT_FOUND");
  await assert.rejects(
    deleted.runtime.createAccess(
      projectId,
      videoTaskId,
      deletedArtifact.artifact.id,
      "playback",
      session,
    ),
    hasRuntimeCode("AIC-MEDIA-ARTIFACT-NOT_FOUND"),
  );
  assert.equal(deleted.storage.signCount, 0);

  const drifted = fixture();
  const driftedArtifact = await drifted.runtime.registerReadyArtifact(
    projectId,
    videoTaskId,
    "request_drifted_access",
    candidate("artifact_drifted_access"),
    session,
  );
  drifted.storage.head = { ...drifted.storage.head, checksumSha256: "b".repeat(64) };
  await assert.rejects(
    drifted.runtime.createAccess(
      projectId,
      videoTaskId,
      driftedArtifact.artifact.id,
      "download",
      session,
    ),
    hasRuntimeCode("AIC-MEDIA-ARTIFACT-NOT_READY"),
  );
  assert.equal(drifted.storage.signCount, 0);
});

test("cross-scope artifact identifiers do not sign and storage failures are sanitized", async () => {
  const value = fixture();
  const foreign = candidate("artifact_foreign_scope");
  const foreignArtifact: MediaArtifact = {
    ...foreign.artifact,
    batchProjectId: "project_foreign_scope",
    version: 1,
  };
  value.artifacts.records.set(recordKey(foreignArtifact), {
    artifact: foreignArtifact,
    storage: structuredClone(foreign.storage),
    creation: {
      actorAccountId,
      requestId: "request_foreign_scope",
      payloadHash: "b".repeat(64),
    },
  });
  await assert.rejects(
    value.runtime.createAccess(
      projectId,
      videoTaskId,
      foreignArtifact.id,
      "playback",
      session,
    ),
    hasRuntimeCode("AIC-MEDIA-ARTIFACT-NOT_FOUND"),
  );
  assert.equal(value.storage.signCount, 0);

  const registered = await value.runtime.registerReadyArtifact(
    projectId,
    videoTaskId,
    "request_storage_error",
    candidate("artifact_storage_error"),
    session,
  );
  value.storage.signError = new Error("secret SDK endpoint and credential");
  await assert.rejects(
    value.runtime.createAccess(
      projectId,
      videoTaskId,
      registered.artifact.id,
      "playback",
      session,
    ),
    (error: unknown) => {
      assert.ok(error instanceof MediaArtifactRuntimeError);
      assert.equal(error.code, "AIC-MEDIA-ARTIFACT-ACCESS_UNAVAILABLE");
      assert.equal(error.statusCode, 503);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /secret|credential|endpoint/iu);
      return true;
    },
  );
});

test("stage media verification rejects forged schema, stage, and content hashes", async () => {
  const value = fixture();
  const registered = await value.runtime.registerReadyArtifact(
    projectId,
    videoTaskId,
    "request_verify_stage",
    candidate("artifact_verify_stage"),
    session,
  );
  await value.runtime.verifyStageArtifact({
    tenantId,
    batchProjectId: projectId,
    videoTaskId,
    stage: "video_preview",
    artifact: registered.reference,
  });
  for (const artifact of [
    { ...registered.reference, schemaName: "video_url" },
    { ...registered.reference, schemaVersion: 2 },
    { ...registered.reference, contentHashSha256: "f".repeat(64) },
  ]) {
    await assert.rejects(
      value.runtime.verifyStageArtifact({
        tenantId,
        batchProjectId: projectId,
        videoTaskId,
        stage: "video_preview",
        artifact,
      }),
      hasRuntimeCode("AIC-MEDIA-ARTIFACT-NOT_READY"),
    );
  }
  await assert.rejects(
    value.runtime.verifyStageArtifact({
      tenantId,
      batchProjectId: projectId,
      videoTaskId,
      stage: "delivery",
      artifact: registered.reference,
    }),
    hasRuntimeCode("AIC-MEDIA-ARTIFACT-NOT_READY"),
  );
});
