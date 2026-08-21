import assert from "node:assert/strict";
import test from "node:test";

import type { VideoTaskProductionRecord, WorkspaceSessionScope } from "@firefly/domain";
import type { BatchProject } from "@firefly/schemas";
import { SEEDANCE_2_5_MODEL, type VideoGenerationProvider } from "@firefly/tools";

import type { AccountBudgetRuntime } from "../src/account-budget-runtime.ts";
import type { AccountRunLockRuntime } from "../src/account-run-lock-runtime.ts";
import type { BatchProjectStore } from "../src/batch-project-store.ts";
import { MemoryVideoGenerationStore } from "../src/video-generation-store.ts";
import { VideoGenerationRuntime, seedanceRequestDurationSeconds, videoGenerationShotDurations } from "../src/video-generation-runtime.ts";
import type { VideoTaskProductionStore } from "../src/video-task-store.ts";
import type { WorkspaceAdminStore } from "../src/workspace-admin-store.ts";
import { DEVELOPMENT_ACCESS_GRANTS } from "../src/workspace-session-runtime.ts";

const project: BatchProject = {
  id: "project_video_generation",
  tenantId: "tenant_firefly",
  brandId: "brand_firefly_demo",
  vehicleId: "vehicle_firefly_e5_2026_long_range",
  vehicleVersion: 1,
  name: "萤火 E5",
  batchName: "生成测试",
  aspectRatio: "9:16",
  visualStylePresetId: "asset_style_firefly_demo_clean",
  assetPoolId: "pool_video_generation",
  status: "active",
  revision: 1,
  createdAt: "2026-08-21T00:00:00.000Z",
  createdBy: "account_creator_a",
  updatedAt: "2026-08-21T00:00:00.000Z",
  updatedBy: "account_creator_a",
};

const task = {
  videoTask: {
    id: "task_video_generation",
    tenantId: project.tenantId,
    batchProjectId: project.id,
    name: "真实生成",
    ownerAccountId: "account_creator_a",
    status: "active",
    currentStage: "delivery",
    stageStatus: "in_progress",
    revision: 11,
    audience: "家庭用户",
    theme: "清晨出发",
    durationSeconds: 10,
    platformTags: ["douyin"],
    scriptInput: "| 0–4 秒 | 车身前脸特写，过渡至后排空间展示 | 大五座空间 |\n| 4–8 秒 | 仪表与内饰 | 纯电版 CLTC 续航 660km |\n| 8–10 秒 | 整车定格 | 零跑 C10 焕新版 |",
    assetSnapshotId: "snapshot_locked",
    createdAt: "2026-08-21T00:00:00.000Z",
    createdBy: "account_creator_a",
    updatedAt: "2026-08-21T00:00:00.000Z",
    updatedBy: "account_creator_a",
  },
  activeStageArtifactVersionIds: { storyboard: "storyboard_version_1" },
  stageArtifactVersions: [{ id: "storyboard_version_1", stage: "storyboard" }],
  stageConfirmations: [{ artifactVersionId: "storyboard_version_1" }],
  stageArtifactInvalidations: [],
  taskAssetSnapshots: [{
    id: "snapshot_locked",
    assets: [{ assetId: "asset_presenter", version: 1, category: "person" }],
  }],
} as unknown as VideoTaskProductionRecord;

const grant = DEVELOPMENT_ACCESS_GRANTS.find((candidate) =>
  candidate.accountId === "account_creator_a" && candidate.access.brandId === project.brandId
)!;
const session: WorkspaceSessionScope = {
  actorAccountId: "account_creator_a",
  tenantId: project.tenantId,
  role: "creator",
  accessGrants: [grant],
};

test("server generation plans cover every supported advertisement duration", () => {
  assert.deepEqual(videoGenerationShotDurations(10), [4, 3, 3]);
  assert.deepEqual(videoGenerationShotDurations(15), [3, 3, 3, 3, 3]);
  assert.deepEqual(videoGenerationShotDurations(30), [5, 5, 5, 5, 5, 5]);
});

test("short editorial shots request Seedance's minimum duration and are trimmed during composition", () => {
  assert.equal(seedanceRequestDurationSeconds(2), 4);
  assert.equal(seedanceRequestDurationSeconds(4), 4);
  assert.equal(seedanceRequestDurationSeconds(8), 8);
});

test("real video generation requires a human start then persists and polls the provider job", async () => {
  let createCalls = 0;
  let released = 0;
  let charged = 0;
  const provider: VideoGenerationProvider = {
    providerId: "mock_seedance",
    targetModel: SEEDANCE_2_5_MODEL,
    async createGeneration(input) {
      createCalls += 1;
      assert.equal(input.durationSeconds, 4);
      assert.equal(input.generateAudio, true);
      assert.match(input.prompt, /0–4 秒/u);
      assert.match(input.prompt, /后排空间展示/u);
      assert.match(input.prompt, /已选主播正面出镜口播本段旁白/u);
      assert.match(input.prompt, /中文女声旁白/u);
      return { providerJobId: "provider_job_1", idempotencyKey: input.idempotencyKey, model: SEEDANCE_2_5_MODEL, status: "queued", progressPercent: 0, createdAt: "2026-08-21T01:00:00.000Z", updatedAt: "2026-08-21T01:00:00.000Z" };
    },
    async getGeneration(providerJobId) {
      return { providerJobId, idempotencyKey: "stable", model: SEEDANCE_2_5_MODEL, status: "succeeded", progressPercent: 100, output: { artifactId: "artifact_1", storageKey: "tenant/project/task/provider.mp4", mediaType: "video/mp4", width: 1080, height: 1920, durationSeconds: 5, checksumSha256: "a".repeat(64) }, createdAt: "2026-08-21T01:00:00.000Z", updatedAt: "2026-08-21T01:01:00.000Z" };
    },
    async cancelGeneration() { throw new Error("not used"); },
  };
  const administration = {
    async withSnapshot(_tenantId: string, inspect: (state: { accessGrants: typeof DEVELOPMENT_ACCESS_GRANTS }) => unknown) {
      return inspect({ accessGrants: DEVELOPMENT_ACCESS_GRANTS });
    },
  } as unknown as WorkspaceAdminStore;
  const projects = {
    async load() { return { project }; },
  } as unknown as BatchProjectStore;
  const tasks = {
    async load() { return task; },
  } as unknown as VideoTaskProductionStore;
  const runLocks = {
    async acquire() { return { id: "run_lock_1", tenantId: project.tenantId, accountId: session.actorAccountId, batchProjectId: project.id, videoTaskId: task.videoTask.id, taskRevision: 11, operation: "video_generation", acquiredAt: "2026-08-21T01:00:00.000Z" }; },
    async release() { released += 1; },
  } as unknown as AccountRunLockRuntime;
  const reservation = { id: "reservation_1", kind: "reservation", estimateId: "estimate_1", tenantId: project.tenantId, accountId: session.actorAccountId, batchProjectId: project.id, videoTaskId: task.videoTask.id, taskRevision: 11, operation: "video_generation", amountMinor: 1000, currency: "CNY", occurredAt: "2026-08-21T01:00:00.000Z" } as const;
  const budgets = {
    async estimate() { return { id: "estimate_1", amountMinor: 1000, currency: "CNY" }; },
    async reserveForOperation() { return { estimate: { amountMinor: 1000, currency: "CNY" }, reservation, balance: {} }; },
    async charge() { charged += 1; return {}; },
    async release() { throw new Error("unexpected release"); },
  } as unknown as AccountBudgetRuntime;
  const runtime = new VideoGenerationRuntime(administration, projects, tasks, new MemoryVideoGenerationStore(), provider, runLocks, budgets, undefined, () => "2026-08-21T01:00:00.000Z", () => "generation_1");

  const started = await runtime.start(project.id, task.videoTask.id, { requestId: "request_1", expectedTaskRevision: 11, shotIndex: 0 }, session);
  assert.equal(started.generation.status, "queued");
  const replay = await runtime.start(project.id, task.videoTask.id, { requestId: "request_1", expectedTaskRevision: 11, shotIndex: 0 }, session);
  assert.equal(replay.generation.id, started.generation.id);
  assert.equal(createCalls, 1);

  const completed = await runtime.get(project.id, task.videoTask.id, started.generation.id, session);
  assert.equal(completed.generation.status, "succeeded");
  assert.equal(completed.generation.output?.mediaUrl, `/v1/workspace/video-generations/${started.generation.id}/media`);
  assert.equal(charged, 1);
  assert.equal(released, 1);
});
