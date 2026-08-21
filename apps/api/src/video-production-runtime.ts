import { createHash, randomUUID } from "node:crypto";

import {
  assertCanOperateVideoTask,
  assertCanViewBatchProject,
  assertCanViewVideoTask,
  nextVideoTaskWorkflowState,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  BatchProject,
  HighCostOperationCostEstimate,
  StageArtifactContentReference,
  VideoTask,
} from "@firefly/schemas";
import type {
  ProductionProviderScope,
  VideoGenerationProvider,
} from "@firefly/tools";

import type { BatchProjectStore } from "./batch-project-store.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import type { HighCostOperationRuntime } from "./high-cost-operation-runtime.ts";
import {
  mediaArtifactObjectKey,
  mediaArtifactContentReference,
  type MediaArtifactCreateCandidate,
  type MediaArtifactStore,
} from "./media-artifact-store.ts";
import type { MediaArtifactRuntime } from "./media-artifact-runtime.ts";
import type { MediaObjectStorage } from "./media-object-storage.ts";
import type { ArkVideoGenerationConfig } from "./video-generation-config.ts";
import type { VideoTaskProductionStore } from "./video-task-store.ts";
import {
  videoGenerationPromptSha256,
  type VideoGenerationProviderStatus,
  type VideoGenerationRequestRecord,
  type VideoGenerationRequestStore,
} from "./video-generation-request-store.ts";
import type { WorkspaceAdminState, WorkspaceAdminStore } from "./workspace-admin-store.ts";

const maximumVideoBytes = 500_000_000;

export interface StartVideoProductionInput {
  readonly requestId: string;
  readonly expectedTaskRevision: number;
}

export interface VideoProductionResult {
  readonly videoTask: VideoTask;
  readonly artifact: StageArtifactContentReference;
  readonly mediaArtifactId: string;
  readonly providerJobId: string;
  readonly chargedAmountMinor: number;
  readonly currency: "CNY";
}

function runtimeError(code: string, message: string, statusCode: number): BusinessRuntimeError {
  return new BusinessRuntimeError(code, message, statusCode);
}

function failureCode(error: unknown): string {
  if (
    typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" && error.code.trim().length > 0
  ) return error.code.trim().slice(0, 200);
  return "AIC-VIDEO-GENERATION_FAILED";
}

function generationAspectRatio(value: string): VideoGenerationRequestRecord["aspectRatio"] {
  switch (value) {
    case "16:9": case "4:3": case "1:1": case "3:4": case "9:16": case "21:9":
      return value;
    default: throw runtimeError("AIC-VIDEO-ASPECT-RATIO_INVALID", "The project aspect ratio is unsupported.", 409);
  }
}

function currentScope(
  session: Readonly<WorkspaceSessionScope>,
  state: Readonly<WorkspaceAdminState>,
): WorkspaceSessionScope {
  return {
    actorAccountId: session.actorAccountId,
    tenantId: session.tenantId,
    role: session.role,
    accessGrants: state.accessGrants.filter((grant) => grant.accountId === session.actorAccountId),
  };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function safeDownloadUrl(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch {
    throw runtimeError("AIC-VIDEO-OUTPUT_URL_INVALID", "The generated video could not be downloaded.", 502);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:"
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.hash.length > 0
    || hostname === "localhost"
    || hostname === "[::1]"
    || /^127\./u.test(hostname)
    || /^10\./u.test(hostname)
    || /^192\.168\./u.test(hostname)
    || /^169\.254\./u.test(hostname)
    || /^172\.(?:1[6-9]|2[0-9]|3[01])\./u.test(hostname)
  ) {
    throw runtimeError("AIC-VIDEO-OUTPUT_URL_INVALID", "The generated video could not be downloaded.", 502);
  }
  return parsed;
}

interface Mp4Metadata { width: number; height: number; durationMs: number }

interface Box { type: string; start: number; dataStart: number; end: number }

function boxes(bytes: Uint8Array, start = 0, end = bytes.byteLength): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const wide = view.getBigUint64(offset + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(wide);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    result.push({ type, start: offset, dataStart: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

export function parseMp4Metadata(bytes: Uint8Array): Mp4Metadata {
  if (bytes.byteLength < 16 || boxes(bytes).find((box) => box.type === "ftyp") === undefined) {
    throw runtimeError("AIC-VIDEO-OUTPUT_INVALID", "The generated file is not a valid MP4 video.", 502);
  }
  const top = boxes(bytes);
  const moov = top.find((box) => box.type === "moov");
  if (!moov) throw runtimeError("AIC-VIDEO-OUTPUT_INVALID", "The generated MP4 metadata is missing.", 502);
  const moovChildren = boxes(bytes, moov.dataStart, moov.end);
  const mvhd = moovChildren.find((box) => box.type === "mvhd");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!mvhd || mvhd.dataStart + 20 > mvhd.end) {
    throw runtimeError("AIC-VIDEO-OUTPUT_INVALID", "The generated MP4 duration is missing.", 502);
  }
  const version = bytes[mvhd.dataStart];
  const timescaleOffset = mvhd.dataStart + (version === 1 ? 20 : 12);
  const durationOffset = mvhd.dataStart + (version === 1 ? 24 : 16);
  if (durationOffset + (version === 1 ? 8 : 4) > mvhd.end) {
    throw runtimeError("AIC-VIDEO-OUTPUT_INVALID", "The generated MP4 duration is invalid.", 502);
  }
  const timescale = view.getUint32(timescaleOffset);
  const durationUnits = version === 1
    ? Number(view.getBigUint64(durationOffset))
    : view.getUint32(durationOffset);
  const tracks = moovChildren.filter((box) => box.type === "trak");
  let width = 0;
  let height = 0;
  for (const track of tracks) {
    const tkhd = boxes(bytes, track.dataStart, track.end).find((box) => box.type === "tkhd");
    if (!tkhd || tkhd.end - 8 < tkhd.dataStart) continue;
    const candidateWidth = view.getUint32(tkhd.end - 8) / 65536;
    const candidateHeight = view.getUint32(tkhd.end - 4) / 65536;
    if (candidateWidth > width && candidateHeight > height) {
      width = candidateWidth;
      height = candidateHeight;
    }
  }
  const durationMs = timescale > 0 ? Math.round(durationUnits * 1000 / timescale) : 0;
  if (
    !Number.isSafeInteger(durationMs) || durationMs <= 0
    || !Number.isInteger(width) || width <= 0 || width > 32768
    || !Number.isInteger(height) || height <= 0 || height > 32768
  ) {
    throw runtimeError("AIC-VIDEO-OUTPUT_INVALID", "The generated MP4 metadata is invalid.", 502);
  }
  return { width, height, durationMs };
}

export class VideoProductionRuntime {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskProductionStore,
    private readonly mediaStore: MediaArtifactStore,
    private readonly generationRequests: VideoGenerationRequestStore,
    private readonly mediaRuntime: MediaArtifactRuntime,
    private readonly storage: MediaObjectStorage,
    private readonly highCost: HighCostOperationRuntime,
    private readonly provider: VideoGenerationProvider,
    private readonly config: ArkVideoGenerationConfig,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async #authorized(projectId: string, taskId: string, session: Readonly<WorkspaceSessionScope>) {
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = currentScope(session, state);
      const projectAggregate = await this.projects.load(scope.tenantId, projectId);
      if (!projectAggregate) throw runtimeError("AIC-VIDEO-TASK_NOT_FOUND", "The video task was not found.", 404);
      const project = projectAggregate.project;
      assertCanViewBatchProject(scope, project);
      const record = await this.tasks.load(taskId);
      if (!record || record.videoTask.tenantId !== scope.tenantId || record.videoTask.batchProjectId !== project.id) {
        throw runtimeError("AIC-VIDEO-TASK_NOT_FOUND", "The video task was not found.", 404);
      }
      assertCanViewVideoTask(scope, project, record.videoTask);
      assertCanOperateVideoTask(scope, project, record.videoTask);
      return { scope, project: structuredClone(project), record };
    });
  }

  async estimate(
    projectId: string,
    taskId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<HighCostOperationCostEstimate> {
    const authorized = await this.#authorized(projectId, taskId, session);
    return this.highCost.estimate(authorized.record.videoTask, authorized.project, "video_generation", authorized.scope);
  }

  async status(
    projectId: string,
    taskId: string,
    session: Readonly<WorkspaceSessionScope>,
  ) {
    const authorized = await this.#authorized(projectId, taskId, session);
    if (
      authorized.record.videoTask.currentStage !== "video_preview"
      || authorized.record.videoTask.stageStatus !== "awaiting_confirmation"
    ) {
      return { videoTask: authorized.record.videoTask, artifact: null, access: null };
    }
    const artifacts = await this.mediaStore.list(
      authorized.scope.tenantId,
      authorized.project.id,
      taskId,
      { stage: "video_preview", role: "preview" },
    );
    const latest = artifacts.sort((left, right) => right.artifact.version - left.artifact.version)[0];
    if (!latest) return { videoTask: authorized.record.videoTask, artifact: null, access: null };
    const access = await this.mediaRuntime.createAccess(
      projectId,
      taskId,
      latest.artifact.id,
      "playback",
      authorized.scope,
    );
    return {
      videoTask: authorized.record.videoTask,
      artifact: mediaArtifactContentReference(latest.artifact),
      mediaArtifact: latest.artifact,
      access,
    };
  }

  async start(
    projectId: string,
    taskId: string,
    input: Readonly<StartVideoProductionInput>,
    session: Readonly<WorkspaceSessionScope>,
    signal?: AbortSignal,
  ): Promise<VideoProductionResult> {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.requestId) || !Number.isSafeInteger(input.expectedTaskRevision)) {
      throw runtimeError("AIC-VIDEO-REQUEST_INVALID", "The video generation request is invalid.", 400);
    }
    const authorized = await this.#authorized(projectId, taskId, session);
    const { record, project, scope } = authorized;
    const replay = await this.generationRequests.loadByActorRequest(
      scope.tenantId,
      project.id,
      taskId,
      scope.actorAccountId,
      input.requestId,
    );
    if (replay !== undefined) {
      if (replay.taskRevision !== input.expectedTaskRevision) {
        throw runtimeError(
          "AIC-VIDEO-REQUEST_ID_CONFLICT",
          "The video generation request ID is already bound to another task revision.",
          409,
        );
      }
      if (
        replay.outcomeStatus !== "succeeded"
        || replay.mediaArtifactId === undefined
        || replay.providerJobId === undefined
      ) {
        throw runtimeError(
          "AIC-VIDEO-PREVIOUS_REQUEST_FAILED",
          "The previous video generation attempt failed; submit a new explicit request.",
          409,
        );
      }
      const replayedMedia = await this.mediaStore.load(
        scope.tenantId,
        project.id,
        taskId,
        replay.mediaArtifactId,
      );
      if (!replayedMedia) {
        throw runtimeError(
          "AIC-VIDEO-AUDIT_MEDIA_MISSING",
          "The recorded generated video is unavailable.",
          500,
        );
      }
      return {
        videoTask: structuredClone(record.videoTask),
        artifact: mediaArtifactContentReference(replayedMedia.artifact),
        mediaArtifactId: replay.mediaArtifactId,
        providerJobId: replay.providerJobId,
        chargedAmountMinor: replay.chargedAmountMinor,
        currency: replay.currency,
      };
    }
    if (
      record.videoTask.revision !== input.expectedTaskRevision
      || record.videoTask.status !== "active"
      || record.videoTask.currentStage !== "video_preview"
      || record.videoTask.stageStatus !== "in_progress"
    ) {
      throw runtimeError("AIC-VIDEO-STATE_INVALID", "Video generation requires the current editable video preview stage.", 409);
    }
    const storyboardArtifactVersionId = record.activeStageArtifactVersionIds.storyboard;
    const assetSnapshotId = record.videoTask.assetSnapshotId;
    const vehicleSnapshotId = record.videoTask.vehicleSnapshotId;
    const vehicleSnapshot = record.taskVehicleSnapshots.find((item) => item.id === vehicleSnapshotId);
    if (!storyboardArtifactVersionId || !assetSnapshotId || !vehicleSnapshot) {
      throw runtimeError("AIC-VIDEO-INPUT_NOT_CONFIRMED", "Confirmed storyboard, assets, and vehicle facts are required.", 409);
    }
    const lockedVehicleSnapshotId = vehicleSnapshot.id;
    const lockedAssetSnapshotId = assetSnapshotId;
    const lockedStoryboardArtifactVersionId = storyboardArtifactVersionId;
    const aspectRatio = generationAspectRatio(project.aspectRatio);
    const prompt = [
      `Create a polished ${record.videoTask.durationSeconds}-second ${project.aspectRatio} automotive information-feed advertising video.`,
      `Audience: ${record.videoTask.audience}. Theme: ${record.videoTask.theme}.`,
      `Script direction: ${record.videoTask.scriptInput}.`,
      `Official locked vehicle facts (do not add unsupported claims):\n${vehicleSnapshot.factsText ?? "Use only the locked vehicle snapshot."}`,
      "Use the confirmed storyboard and locked project assets as the production plan. No fabricated specifications, prices, endorsements, or comparative claims.",
    ].join("\n\n").slice(0, 20_000);
    const requestedAt = this.now();
    const generationRequestId = `video_generation_request_${randomUUID().replaceAll("-", "")}`;
    let providerJobId: string | undefined;
    let providerStatus: VideoGenerationProviderStatus = "request_failed";
    let mediaArtifactId: string | undefined;
    const providerScope: ProductionProviderScope = {
      tenantId: scope.tenantId,
      actorAccountId: scope.actorAccountId,
      batchProjectId: project.id,
      videoTaskId: taskId,
      taskRevision: record.videoTask.revision,
    };
    let execution;
    try {
      execution = await this.highCost.execute(
        record.videoTask,
        project,
        "video_generation",
        scope,
        async (authorization) => {
        let job = await this.provider.createGeneration({
          idempotencyKey: input.requestId,
          model: this.provider.targetModel,
          assetSnapshotId,
          storyboardArtifactVersionId,
          prompt,
          aspectRatio: project.aspectRatio,
          durationSeconds: record.videoTask.durationSeconds,
        }, providerScope, { ...(signal === undefined ? {} : { signal }) });
        providerJobId = job.providerJobId;
        providerStatus = job.status;
        const deadline = Date.now() + this.config.timeoutMs;
        while (job.status === "queued" || job.status === "running") {
          if (Date.now() >= deadline) {
            job = await this.provider.cancelGeneration(job.providerJobId, providerScope).catch(() => job);
            providerStatus = job.status;
            throw runtimeError("AIC-VIDEO-TIMEOUT", "Video generation timed out before completion.", 504);
          }
          await wait(this.config.pollIntervalMs, signal);
          job = await this.provider.getGeneration(job.providerJobId, providerScope, {
            ...(signal === undefined ? {} : { signal }),
          });
          providerStatus = job.status;
        }
        if (job.status !== "succeeded" || !job.output) {
          throw runtimeError(job.failure?.code ?? "AIC-VIDEO-GENERATION_FAILED", "Video generation did not produce an output.", 502);
        }
        const outputUrl = safeDownloadUrl(job.output.downloadUrl);
        let response: Response;
        try {
          response = await this.fetchImpl(outputUrl, {
            ...(signal === undefined ? {} : { signal }),
            redirect: "follow",
            headers: { accept: "video/mp4" },
          });
        } catch {
          throw runtimeError("AIC-VIDEO-DOWNLOAD_FAILED", "The generated video could not be downloaded.", 502);
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > maximumVideoBytes)) {
          throw runtimeError("AIC-VIDEO-DOWNLOAD_FAILED", "The generated video could not be downloaded.", 502);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength < 16 || bytes.byteLength > maximumVideoBytes) {
          throw runtimeError("AIC-VIDEO-OUTPUT_INVALID", "The generated video size is invalid.", 502);
        }
        const metadata = parseMp4Metadata(bytes);
        const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
        const artifactId = `media_artifact_${randomUUID().replaceAll("-", "")}`;
        const objectKey = mediaArtifactObjectKey({
          tenantId: scope.tenantId,
          batchProjectId: project.id,
          videoTaskId: taskId,
          artifactId,
        });
        const stored = await this.storage.putObject({
          objectKey,
          body: bytes,
          contentType: "video/mp4",
          contentLength: bytes.byteLength,
          checksumSha256,
        });
        const candidate: MediaArtifactCreateCandidate = {
          artifact: {
            schemaVersion: 1,
            id: artifactId,
            tenantId: scope.tenantId,
            batchProjectId: project.id,
            videoTaskId: taskId,
            stage: "video_preview",
            role: "preview",
            mediaType: "video/mp4",
            byteSize: bytes.byteLength,
            checksumSha256,
            width: metadata.width,
            height: metadata.height,
            durationMs: metadata.durationMs,
            createdAt: this.now(),
            createdBy: scope.actorAccountId,
          },
          storage: {
            providerId: this.storage.providerId,
            bucketName: this.storage.bucketName,
            objectKey,
            ...(stored.versionId === null ? {} : { objectVersion: stored.versionId }),
          },
        };
        const registered = await this.mediaRuntime.registerReadyArtifact(
          project.id,
          taskId,
          input.requestId,
          candidate,
          scope,
        );
        mediaArtifactId = registered.artifact.id;
        const updated = await this.tasks.transact(taskId, (current) => {
          if (!current || current.videoTask.revision !== input.expectedTaskRevision) {
            throw runtimeError("AIC-VIDEO-TASK_CHANGED", "The video task changed during generation.", 409);
          }
          const workflow = nextVideoTaskWorkflowState({
            taskStatus: current.videoTask.status,
            currentStage: current.videoTask.currentStage,
            stageStatus: current.videoTask.stageStatus,
          }, { type: "stage_confirmation_requested", stage: "video_preview" });
          return {
            ...structuredClone(current),
            videoTask: {
              ...structuredClone(current.videoTask),
              status: workflow.taskStatus,
              currentStage: workflow.currentStage,
              stageStatus: workflow.stageStatus,
              revision: current.videoTask.revision + 1,
              updatedAt: this.now(),
              updatedBy: scope.actorAccountId,
            },
          };
        });
        return {
          value: {
            videoTask: structuredClone(updated.videoTask),
            artifact: registered.reference,
            mediaArtifactId: registered.artifact.id,
            providerJobId: job.providerJobId,
          },
          operationResultId: registered.artifact.id,
          actualAmountMinor: authorization.estimate.amountMinor,
        };
        },
      );
    } catch (error: unknown) {
      const failedRecord: VideoGenerationRequestRecord = {
        id: generationRequestId,
        tenantId: scope.tenantId,
        batchProjectId: project.id,
        videoTaskId: taskId,
        actorAccountId: scope.actorAccountId,
        requestId: input.requestId,
        taskRevision: record.videoTask.revision,
        vehicleSnapshotId: lockedVehicleSnapshotId,
        assetSnapshotId: lockedAssetSnapshotId,
        storyboardArtifactVersionId: lockedStoryboardArtifactVersionId,
        providerId: this.provider.providerId,
        ...(providerJobId === undefined ? {} : { providerJobId }),
        providerStatus,
        outcomeStatus: "failed",
        modelId: this.provider.targetModel,
        resolution: this.config.resolution,
        aspectRatio,
        durationSeconds: record.videoTask.durationSeconds,
        promptText: prompt,
        promptSha256: videoGenerationPromptSha256(prompt),
        requestedAt,
        completedAt: this.now(),
        chargedAmountMinor: 0,
        currency: "CNY",
        ...(mediaArtifactId === undefined ? {} : { mediaArtifactId }),
        failureCode: failureCode(error),
      };
      await this.generationRequests.create(failedRecord);
      throw error;
    }
    const succeededRecord: VideoGenerationRequestRecord = {
      id: generationRequestId,
      tenantId: scope.tenantId,
      batchProjectId: project.id,
      videoTaskId: taskId,
      actorAccountId: scope.actorAccountId,
      requestId: input.requestId,
      taskRevision: record.videoTask.revision,
      vehicleSnapshotId: lockedVehicleSnapshotId,
      assetSnapshotId: lockedAssetSnapshotId,
      storyboardArtifactVersionId: lockedStoryboardArtifactVersionId,
      providerId: this.provider.providerId,
      providerJobId: execution.value.providerJobId,
      providerStatus: "succeeded",
      outcomeStatus: "succeeded",
      modelId: this.provider.targetModel,
      resolution: this.config.resolution,
      aspectRatio,
      durationSeconds: record.videoTask.durationSeconds,
      promptText: prompt,
      promptSha256: videoGenerationPromptSha256(prompt),
      requestedAt,
      completedAt: this.now(),
      chargedAmountMinor: execution.actualAmountMinor,
      currency: "CNY",
      mediaArtifactId: execution.value.mediaArtifactId,
    };
    await this.generationRequests.create(succeededRecord);
    return {
      ...execution.value,
      chargedAmountMinor: execution.actualAmountMinor,
      currency: "CNY",
    };
  }
}

export function createConfiguredVideoPricingProvider(config: ArkVideoGenerationConfig) {
  return {
    async estimate(_videoTask: Readonly<VideoTask>, operation: string, estimatedAt: string) {
      if (operation !== "video_generation") {
        throw runtimeError("AIC-COST-OPERATION_UNAVAILABLE", "Pricing is unavailable for this operation.", 409);
      }
      return {
        amountMinor: config.estimatedCostMinor,
        currency: "CNY" as const,
        pricingVersion: `ark_${config.modelId}_${config.resolution}_v1`.replace(/[^A-Za-z0-9_-]/gu, "_"),
        expiresAt: new Date(new Date(estimatedAt).getTime() + 10 * 60_000).toISOString(),
      };
    },
  };
}
