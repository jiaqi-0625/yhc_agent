import { createHash, randomUUID } from "node:crypto";

import {
  assertCanOperateVideoTask,
  assertCanViewBatchProject,
  assertCanViewVideoTask,
  type VideoTaskProductionRecord,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type { BatchProject, HighCostOperationCostEstimate } from "@firefly/schemas";
import {
  SEEDANCE_2_5_MODEL,
  type ProductionProviderScope,
  type VideoGenerationJob,
  type VideoGenerationProvider,
} from "@firefly/tools";

import type { AccountBudgetRuntime } from "./account-budget-runtime.ts";
import type { AccountRunLockRuntime } from "./account-run-lock-runtime.ts";
import type { BatchProjectStore } from "./batch-project-store.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import { storyboardScriptPlan } from "./storyboard-script-plan.ts";
import type { VideoTaskProductionStore } from "./video-task-store.ts";
import type { VideoGenerationRecord, VideoGenerationStore } from "./video-generation-store.ts";
import type { WorkspaceAdminState, WorkspaceAdminStore } from "./workspace-admin-store.ts";

export interface StartVideoGenerationInput {
  readonly requestId: string;
  readonly expectedTaskRevision: number;
  readonly shotIndex: number;
}

export interface ComposeVideoGenerationInput {
  readonly requestId: string;
  readonly expectedTaskRevision: number;
}

export interface VideoCompositionService {
  composeVideo(input: Readonly<{
    tenantId: string;
    batchProjectId: string;
    videoTaskId: string;
    compositionId: string;
    aspectRatio: string;
    durationSeconds: number;
    sourceDurationsSeconds: readonly number[];
    sources: readonly NonNullable<VideoGenerationRecord["output"]>[];
  }>): Promise<NonNullable<VideoGenerationRecord["compositeOutput"]>>;
}

const SEEDANCE_2_5_MIN_DURATION_SECONDS = 4;

/** The provider may need extra tail footage; composition trims it to the editorial shot length. */
export function seedanceRequestDurationSeconds(editorialDurationSeconds: number): number {
  if (!Number.isSafeInteger(editorialDurationSeconds) || editorialDurationSeconds < 1) {
    throw error("AIC-VIDEO-GENERATION-SHOT-DURATION-INVALID", "The storyboard shot duration must be a positive integer.", 409);
  }
  return Math.max(SEEDANCE_2_5_MIN_DURATION_SECONDS, editorialDurationSeconds);
}

export function videoGenerationShotDurations(durationSeconds: number): readonly number[] {
  try {
    return storyboardScriptPlan("", durationSeconds).map((shot) => shot.durationSeconds);
  } catch {
    throw error("AIC-VIDEO-GENERATION-DURATION-UNSUPPORTED", "The task duration is not supported by the multi-shot generation plan.", 409);
  }
}

export function selectAudioEnabledGenerationsForComposition(
  records: readonly Readonly<VideoGenerationRecord>[],
  shotCount: number,
): Array<VideoGenerationRecord | undefined> {
  return Array.from({ length: shotCount }, (_value, shotIndex) => [...records].reverse().find((candidate) =>
    candidate.audioEnabled === true
    && candidate.shotIndex === shotIndex
    && candidate.status === "succeeded"
    && candidate.output !== undefined
  ));
}

function error(code: string, message: string, statusCode: number): BusinessRuntimeError {
  return new BusinessRuntimeError(code, message, statusCode);
}

function scopeFrom(session: Readonly<WorkspaceSessionScope>, state: Readonly<WorkspaceAdminState>): WorkspaceSessionScope {
  return {
    actorAccountId: session.actorAccountId,
    tenantId: session.tenantId,
    role: session.role,
    accessGrants: state.accessGrants.filter((grant) => grant.accountId === session.actorAccountId),
  };
}

function providerScope(record: Readonly<VideoGenerationRecord>): ProductionProviderScope {
  return {
    tenantId: record.tenantId,
    actorAccountId: record.actorAccountId,
    batchProjectId: record.batchProjectId,
    videoTaskId: record.videoTaskId,
    taskRevision: record.sourceTaskRevision,
  };
}

function presenterSelected(task: Readonly<VideoTaskProductionRecord>): boolean {
  const snapshot = task.taskAssetSnapshots.find(
    (candidate) => candidate.id === task.videoTask.assetSnapshotId,
  );
  return snapshot?.assets.some((asset) => asset.category === "person") === true;
}

function publicView(record: Readonly<VideoGenerationRecord>) {
  return {
    id: record.id,
    audioEnabled: record.audioEnabled === true,
    videoTaskId: record.videoTaskId,
    sourceTaskRevision: record.sourceTaskRevision,
    shotIndex: record.shotIndex,
    providerId: record.providerId,
    status: record.status,
    progressPercent: record.progressPercent,
    estimate: { amountMinor: record.estimatedAmountMinor, currency: record.currency },
    ...(record.output === undefined ? {} : {
      output: {
        artifactId: record.output.artifactId,
        mediaType: record.output.mediaType,
        width: record.output.width,
        height: record.output.height,
        durationSeconds: record.output.durationSeconds,
        mediaUrl: `/v1/workspace/video-generations/${encodeURIComponent(record.id)}/media`,
      },
    }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ...(record.audioEnabled !== true || record.compositeOutput === undefined ? {} : {
      composite: {
        artifactId: record.compositeOutput.artifactId,
        mediaType: record.compositeOutput.mediaType,
        width: record.compositeOutput.width,
        height: record.compositeOutput.height,
        durationSeconds: record.compositeOutput.durationSeconds,
        mediaUrl: `/v1/workspace/video-generations/${encodeURIComponent(record.id)}/composite-media`,
        createdAt: record.compositeCreatedAt,
      },
    }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    settled: record.settledAt !== undefined,
  };
}

export class VideoGenerationRuntime {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskProductionStore,
    private readonly jobs: VideoGenerationStore,
    private readonly provider: VideoGenerationProvider,
    private readonly runLocks: AccountRunLockRuntime,
    private readonly budgets: AccountBudgetRuntime,
    private readonly composer?: VideoCompositionService,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => `video_generation_${randomUUID()}`,
  ) {}

  async #authorized(projectId: string, videoTaskId: string, session: Readonly<WorkspaceSessionScope>, operate: boolean): Promise<{ project: BatchProject; task: VideoTaskProductionRecord; scope: WorkspaceSessionScope }> {
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = scopeFrom(session, state);
      const aggregate = await this.projects.load(scope.tenantId, projectId);
      const task = await this.tasks.load(videoTaskId);
      if (!aggregate || !task || task.videoTask.batchProjectId !== projectId || task.videoTask.tenantId !== scope.tenantId) {
        throw error("AIC-VIDEO-GENERATION-NOT-FOUND", "The video generation target was not found.", 404);
      }
      assertCanViewBatchProject(scope, aggregate.project);
      assertCanViewVideoTask(scope, aggregate.project, task.videoTask);
      if (operate) assertCanOperateVideoTask(scope, aggregate.project, task.videoTask);
      return { project: structuredClone(aggregate.project), task: structuredClone(task), scope };
    });
  }

  #storyboard(task: Readonly<VideoTaskProductionRecord>) {
    const id = task.activeStageArtifactVersionIds.storyboard;
    const artifact = task.stageArtifactVersions.find((candidate) => candidate.id === id && candidate.stage === "storyboard");
    const confirmed = artifact && task.stageConfirmations.some((confirmation) => confirmation.artifactVersionId === artifact.id);
    if (!artifact || !confirmed || task.stageArtifactInvalidations.some((entry) => entry.artifactVersionId === artifact.id)) {
      throw error("AIC-VIDEO-GENERATION-STORYBOARD-NOT-READY", "A confirmed storyboard is required before video generation.", 409);
    }
    return artifact;
  }

  async estimate(projectId: string, videoTaskId: string, session: Readonly<WorkspaceSessionScope>): Promise<{ estimate: HighCostOperationCostEstimate; plan: { shotCount: number; shotDurationsSeconds: readonly number[]; totalEstimatedAmountMinor: number } }> {
    const { project, task, scope } = await this.#authorized(projectId, videoTaskId, session, true);
    this.#storyboard(task);
    const estimate = await this.budgets.estimate(task.videoTask, project, "video_generation", scope);
    const shotDurationsSeconds = storyboardScriptPlan(
      task.videoTask.scriptInput ?? "",
      task.videoTask.durationSeconds,
      { presenterNarration: presenterSelected(task) },
    ).map((shot) => shot.durationSeconds);
    return {
      estimate,
      plan: {
        shotCount: shotDurationsSeconds.length,
        shotDurationsSeconds,
        totalEstimatedAmountMinor: estimate.amountMinor * shotDurationsSeconds.length,
      },
    };
  }

  async start(projectId: string, videoTaskId: string, input: Readonly<StartVideoGenerationInput>, session: Readonly<WorkspaceSessionScope>) {
    const { project, task, scope } = await this.#authorized(projectId, videoTaskId, session, true);
    if (input.expectedTaskRevision !== task.videoTask.revision) {
      throw error("AIC-VIDEO-GENERATION-REVISION-CONFLICT", "The task changed before video generation started. Refresh and retry.", 409);
    }
    const shotPlan = storyboardScriptPlan(task.videoTask.scriptInput ?? "", task.videoTask.durationSeconds, {
      presenterNarration: presenterSelected(task),
    });
    if (!Number.isSafeInteger(input.shotIndex) || input.shotIndex < 0 || input.shotIndex >= shotPlan.length) {
      throw error("AIC-VIDEO-GENERATION-SHOT-INVALID", "The storyboard shot index is outside the server generation plan.", 400);
    }
    const storyboard = this.#storyboard(task);
    if (!task.videoTask.assetSnapshotId || !task.videoTask.scriptInput) {
      throw error("AIC-VIDEO-GENERATION-INPUT-NOT-READY", "The locked assets and confirmed script are required before video generation.", 409);
    }
    const replay = await this.jobs.loadByRequest(scope.tenantId, scope.actorAccountId, input.requestId);
    if (replay) {
      if (replay.batchProjectId !== projectId || replay.videoTaskId !== videoTaskId
        || replay.sourceTaskRevision !== input.expectedTaskRevision || replay.shotIndex !== input.shotIndex) {
        throw error("AIC-VIDEO-GENERATION-IDEMPOTENCY-CONFLICT", "The request ID was already used for different generation input.", 409);
      }
      return { generation: publicView(replay) };
    }

    const runLock = await this.runLocks.acquire(task.videoTask, project, "video_generation", scope);
    let authorization: Awaited<ReturnType<AccountBudgetRuntime["reserveForOperation"]>> | undefined;
    let createdRecord: VideoGenerationRecord | undefined;
    try {
      authorization = await this.budgets.reserveForOperation(task.videoTask, project, "video_generation", scope);
      const id = this.createId();
      const now = this.now();
      const idempotencyKey = createHash("sha256").update(`${scope.tenantId}:${videoTaskId}:${input.requestId}`).digest("hex");
      const initial: VideoGenerationRecord = {
        schemaVersion: 1,
        audioEnabled: true,
        id,
        tenantId: scope.tenantId,
        batchProjectId: projectId,
        videoTaskId,
        actorAccountId: scope.actorAccountId,
        requestId: input.requestId,
        sourceTaskRevision: task.videoTask.revision,
        storyboardArtifactVersionId: storyboard.id,
        assetSnapshotId: task.videoTask.assetSnapshotId,
        shotIndex: input.shotIndex,
        providerId: this.provider.providerId,
        providerJobId: idempotencyKey,
        idempotencyKey,
        status: "queued",
        progressPercent: 0,
        estimatedAmountMinor: authorization.estimate.amountMinor,
        currency: authorization.estimate.currency,
        reservation: authorization.reservation,
        runLock,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      const created = await this.jobs.create(initial);
      if (created.id !== initial.id) {
        await this.budgets.release(authorization.reservation, "operation_cancelled");
        await this.runLocks.release(runLock);
        return { generation: publicView(created) };
      }
      createdRecord = created;
      const plannedShot = shotPlan[input.shotIndex]!;
      const providerDurationSeconds = seedanceRequestDurationSeconds(plannedShot.durationSeconds);
      const prompt = [
        `生成一条汽车信息流广告的第 ${input.shotIndex + 1}/${shotPlan.length} 个真实视频分镜。`,
        `项目车型：${project.name}。`,
        `本镜头严格对应已确认脚本 ${plannedShot.startSeconds}–${plannedShot.endSeconds} 秒：${plannedShot.scriptExcerpt}`,
        `本镜头任务：${plannedShot.purpose}。不得混入其他时间段的卖点或画面。`,
        `画幅：${project.aspectRatio}，成片取本镜头前 ${plannedShot.durationSeconds} 秒。`,
        "保持车型外观一致，写实商业摄影，画面稳定，不添加无法核验的车型参数文字，不添加水印。",
        "必须生成完整音频：轻快克制的商业背景音乐、与画面同步的环境音和转场音效，以及自然清晰的中文女声旁白；本镜头不得静音。",
      ].join("\n");
      const providerJob = await this.provider.createGeneration({
        idempotencyKey,
        model: SEEDANCE_2_5_MODEL,
        assetSnapshotId: task.videoTask.assetSnapshotId,
        storyboardArtifactVersionId: storyboard.id,
        prompt,
        generateAudio: true,
        aspectRatio: project.aspectRatio,
        durationSeconds: providerDurationSeconds,
        watermark: false,
      }, providerScope(created));
      const saved = await this.#applyProviderJob(created, providerJob);
      return { generation: publicView(saved) };
    } catch (cause) {
      if (authorization) await this.budgets.release(authorization.reservation, "operation_failed", "VIDEO_GENERATION_START_FAILED").catch(() => undefined);
      await this.runLocks.release(runLock).catch(() => undefined);
      if (createdRecord) {
        const message = cause instanceof Error ? cause.message : "Video generation could not be started.";
        await this.jobs.save({
          ...createdRecord,
          status: "failed",
          failure: { code: "AIC-VIDEO-GENERATION-START-FAILED", message, retryable: true },
          settledAt: this.now(),
          updatedAt: this.now(),
        }, createdRecord.revision).catch(() => undefined);
      }
      throw cause;
    }
  }

  async #applyProviderJob(current: Readonly<VideoGenerationRecord>, providerJob: Readonly<VideoGenerationJob>): Promise<VideoGenerationRecord> {
    const updatedAt = this.now();
    let next: VideoGenerationRecord = {
      ...structuredClone(current),
      providerJobId: providerJob.providerJobId,
      status: providerJob.status,
      progressPercent: providerJob.progressPercent,
      ...(providerJob.output === undefined ? {} : { output: providerJob.output }),
      ...(providerJob.failure === undefined ? {} : { failure: providerJob.failure }),
      updatedAt,
    };
    if (["succeeded", "failed", "cancelled"].includes(next.status) && next.settledAt === undefined) {
      if (next.status === "succeeded" && next.output === undefined) {
        next = { ...next, status: "failed", failure: { code: "AIC-VIDEO-GENERATION-OUTPUT-MISSING", message: "The provider completed without an importable video.", retryable: true } };
      }
      if (next.status === "succeeded") {
        await this.budgets.charge(next.reservation, next.estimatedAmountMinor, next.id);
      } else {
        await this.budgets.release(next.reservation, next.status === "cancelled" ? "operation_cancelled" : "operation_failed", next.failure?.code);
      }
      await this.runLocks.release(next.runLock);
      next = { ...next, settledAt: updatedAt };
    }
    return this.jobs.save(next, current.revision);
  }

  async get(projectId: string, videoTaskId: string, jobId: string, session: Readonly<WorkspaceSessionScope>) {
    await this.#authorized(projectId, videoTaskId, session, false);
    const record = await this.jobs.load(jobId);
    if (!record || record.tenantId !== session.tenantId || record.batchProjectId !== projectId || record.videoTaskId !== videoTaskId) {
      throw error("AIC-VIDEO-GENERATION-NOT-FOUND", "The video generation job was not found.", 404);
    }
    if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") {
      return { generation: publicView(record) };
    }
    const refreshed = await this.provider.getGeneration(record.providerJobId, providerScope(record));
    return { generation: publicView(await this.#applyProviderJob(record, refreshed)) };
  }

  async latest(projectId: string, videoTaskId: string, session: Readonly<WorkspaceSessionScope>) {
    await this.#authorized(projectId, videoTaskId, session, false);
    const records = await this.jobs.listForTask(session.tenantId, projectId, videoTaskId);
    const record = records.at(-1);
    if (!record) return { generation: null, generations: [] };
    if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") {
      return { generation: publicView(record), generations: records.map(publicView) };
    }
    const refreshed = await this.provider.getGeneration(record.providerJobId, providerScope(record));
    const saved = await this.#applyProviderJob(record, refreshed);
    return {
      generation: publicView(saved),
      generations: records.map((candidate) => candidate.id === saved.id ? publicView(saved) : publicView(candidate)),
    };
  }

  async compose(projectId: string, videoTaskId: string, input: Readonly<ComposeVideoGenerationInput>, session: Readonly<WorkspaceSessionScope>) {
    if (!this.composer) throw error("AIC-VIDEO-COMPOSITION-NOT-CONFIGURED", "Video composition is not configured on this server.", 503);
    const { project, task, scope } = await this.#authorized(projectId, videoTaskId, session, true);
    if (input.expectedTaskRevision !== task.videoTask.revision) {
      throw error("AIC-VIDEO-GENERATION-REVISION-CONFLICT", "The task changed before video composition started. Refresh and retry.", 409);
    }
    this.#storyboard(task);
    const durations = storyboardScriptPlan(task.videoTask.scriptInput ?? "", task.videoTask.durationSeconds, {
      presenterNarration: presenterSelected(task),
    })
      .map((shot) => shot.durationSeconds);
    const records = await this.jobs.listForTask(scope.tenantId, projectId, videoTaskId);
    const replay = records.find((candidate) =>
      candidate.audioEnabled === true
      && candidate.compositeRequestId === input.requestId
      && candidate.compositeOutput !== undefined
    );
    if (replay) return { generation: publicView(replay), generations: records.map(publicView) };
    const selected = selectAudioEnabledGenerationsForComposition(records, durations.length);
    if (selected.some((candidate) => candidate === undefined)) {
      throw error("AIC-VIDEO-COMPOSITION-SHOTS-NOT-READY", "Every storyboard shot must finish successfully before composition.", 409);
    }
    const target = selected.at(-1)!;
    const runLock = await this.runLocks.acquire(task.videoTask, project, "video_generation", scope);
    try {
      const compositionId = `composition_${createHash("sha256").update(`${videoTaskId}:${input.requestId}`).digest("hex").slice(0, 48)}`;
      const compositeOutput = await this.composer.composeVideo({
        tenantId: scope.tenantId,
        batchProjectId: projectId,
        videoTaskId,
        compositionId,
        aspectRatio: project.aspectRatio,
        durationSeconds: task.videoTask.durationSeconds,
        sourceDurationsSeconds: durations,
        sources: selected.map((candidate) => candidate!.output!),
      });
      const now = this.now();
      const saved = await this.jobs.save({
        ...target,
        compositeOutput,
        compositeRequestId: input.requestId,
        compositeCreatedAt: now,
        updatedAt: now,
      }, target.revision);
      return {
        generation: publicView(saved),
        generations: records.map((candidate) => candidate.id === saved.id ? publicView(saved) : publicView(candidate)),
      };
    } finally {
      await this.runLocks.release(runLock);
    }
  }

  async media(jobId: string, session: Readonly<WorkspaceSessionScope>): Promise<VideoGenerationRecord> {
    const record = await this.jobs.load(jobId);
    if (!record) throw error("AIC-VIDEO-GENERATION-NOT-FOUND", "The video generation job was not found.", 404);
    await this.#authorized(record.batchProjectId, record.videoTaskId, session, false);
    if (!record.output || record.status !== "succeeded") throw error("AIC-VIDEO-GENERATION-MEDIA-NOT-READY", "The generated video is not ready.", 409);
    return record;
  }

  async compositeMedia(jobId: string, session: Readonly<WorkspaceSessionScope>): Promise<VideoGenerationRecord> {
    const record = await this.jobs.load(jobId);
    if (!record) throw error("AIC-VIDEO-GENERATION-NOT-FOUND", "The video generation job was not found.", 404);
    await this.#authorized(record.batchProjectId, record.videoTaskId, session, false);
    if (!record.compositeOutput) throw error("AIC-VIDEO-COMPOSITION-MEDIA-NOT-READY", "The composed video is not ready.", 409);
    return record;
  }
}
