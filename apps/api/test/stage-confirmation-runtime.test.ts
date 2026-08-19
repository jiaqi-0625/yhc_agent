import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ConfirmStageCommand, VideoTaskProductionRecord } from "@firefly/domain";
import { RevisionConflictError, WorkspaceAccessDeniedError } from "@firefly/domain";
import type { BatchProject, WorkspaceAccessGrant } from "@firefly/schemas";

import { StageConfirmationRuntime } from "../src/stage-confirmation-runtime.ts";
import {
  LocalVideoTaskProductionStore,
  type VideoTaskProductionStore,
} from "../src/video-task-store.ts";

function productionRecord(): VideoTaskProductionRecord {
  return {
    schemaVersion: 6,
    videoTask: {
      id: "task_persisted",
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      name: "持久化测试任务",
      ownerAccountId: "account_owner",
      status: "active",
      currentStage: "strategy",
      stageStatus: "awaiting_confirmation",
      revision: 5,
      vehicleSnapshotId: "vehicle_snapshot_1",
      assetSnapshotId: "asset_snapshot_1",
      audience: "家庭用户",
      theme: "城市通勤",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-18T08:00:00.000Z",
      createdBy: "account_owner",
      updatedAt: "2026-08-18T09:00:00.000Z",
      updatedBy: "account_owner",
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskVehicleSnapshots: [{
      id: "vehicle_snapshot_1",
      projectId: "project_launch",
      vehicleId: "vehicle_e5",
      vehicleVersion: 1,
      brandId: "brand_firefly",
      brand: "萤火汽车",
      series: "E5",
      modelYear: 2026,
      trim: "长续航版",
      parameters: {},
      fixedClaims: [],
      optionalClaims: [],
      prohibitedClaims: [],
      referenceAssetIds: [],
      createdAt: "2026-08-18T08:00:00.000Z",
      createdBy: "account_owner",
    }],
    taskAssetSnapshots: [{
      id: "asset_snapshot_1",
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      videoTaskId: "task_persisted",
      version: 1,
      sourceProjectAssetPoolRevision: 1,
      vehicleSnapshotId: "vehicle_snapshot_1",
      assets: [{
        assetId: "asset_vehicle_1",
        version: 1,
        source: "company_catalog",
        sourceProvider: "mock_company_assets",
        category: "vehicle",
        vehicleId: "vehicle_e5",
      }],
      createdAt: "2026-08-18T08:01:00.000Z",
      createdBy: "account_owner",
    }],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
    stageMutationReceipts: [],
  };
}

function rollbackRecord(): VideoTaskProductionRecord {
  const record = productionRecord();
  record.videoTask.currentStage = "asset_matching";
  record.videoTask.stageStatus = "in_progress";
  record.videoTask.revision = 7;
  record.stageArtifactVersions = [1, 2].map((version) => ({
    id: `strategy_v${version}`,
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    videoTaskId: "task_persisted",
    stage: "strategy" as const,
    version,
    content: {
      artifactId: `strategy_content_v${version}`,
      schemaName: "marketing_strategy",
      schemaVersion: 1,
      contentHashSha256: version.toString(16).padStart(64, "0"),
    },
    dependencies: [{ kind: "vehicle_snapshot" as const, vehicleSnapshotId: "vehicle_snapshot_1" }],
    provenance: {
      kind: "human_confirmation" as const,
      confirmationId: `confirmation_v${version}`,
    },
    createdAt: `2026-08-18T0${version}:00:00.000Z`,
    createdBy: "account_owner",
  }));
  record.stageConfirmations = [1, 2].map((version) => ({
    id: `confirmation_v${version}`,
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    videoTaskId: "task_persisted",
    stage: "strategy" as const,
    artifactVersionId: `strategy_v${version}`,
    decision: "confirmed" as const,
    source: "human_action" as const,
    expectedTaskRevision: version,
    actorAccountId: "account_owner",
    occurredAt: `2026-08-18T0${version}:00:00.000Z`,
  }));
  record.activeStageArtifactVersionIds.strategy = "strategy_v2";
  return record;
}

const command: ConfirmStageCommand = {
  expectedTaskRevision: 5,
  stage: "strategy",
  artifact: {
    artifactId: "strategy_artifact_1",
    schemaName: "marketing_strategy",
    schemaVersion: 1,
    contentHashSha256: "b".repeat(64),
  },
  dependencies: [
    { kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" },
    { kind: "asset_snapshot", assetSnapshotId: "asset_snapshot_1" },
  ],
};

const project: BatchProject = {
  id: "project_launch",
  tenantId: "tenant_firefly",
  brandId: "brand_firefly",
  vehicleId: "vehicle_e5",
  vehicleVersion: 1,
  name: "萤火 E5 9:16 上市",
  batchName: "上市",
  aspectRatio: "9:16",
  visualStylePresetId: "style_default",
  assetPoolId: "asset_pool_e5",
  status: "active",
  revision: 1,
  createdAt: "2026-08-18T08:00:00.000Z",
  createdBy: "account_owner",
  updatedAt: "2026-08-18T08:00:00.000Z",
  updatedBy: "account_owner",
};

const projectGrant: WorkspaceAccessGrant = {
  id: "grant_owner_e5",
  tenantId: "tenant_firefly",
  accountId: "account_owner",
  access: {
    kind: "vehicle_project",
    brandId: project.brandId,
    vehicleId: project.vehicleId,
  },
  status: "active",
  revision: 1,
  createdAt: "2026-08-18T08:00:00.000Z",
  createdBy: "account_admin",
  updatedAt: "2026-08-18T08:00:00.000Z",
  updatedBy: "account_admin",
};

const session = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_owner",
  role: "creator" as const,
  accessGrants: [projectGrant],
};

function projectMemberSession(actorAccountId: string) {
  return {
    tenantId: "tenant_firefly",
    actorAccountId,
    role: "creator" as const,
    accessGrants: [
      {
        ...projectGrant,
        id: `grant_${actorAccountId}_e5`,
        accountId: actorAccountId,
      },
    ],
  };
}

test("confirmation persists the task, immutable version, and audit event in one record", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-store-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const firstStore = new LocalVideoTaskProductionStore(directory);
  await firstStore.save(productionRecord());
  const runtime = new StageConfirmationRuntime(
    firstStore,
    () => "2026-08-18T10:00:00.000Z",
    (kind) => (kind === "confirmation" ? "confirmation_1" : "artifact_version_1"),
  );

  const result = await runtime.confirmStage("task_persisted", command, project, session);
  assert.equal(result.videoTask.revision, 6);
  assert.equal(result.stageArtifactVersions.length, 1);
  assert.equal(result.stageConfirmations.length, 1);

  const restored = await new LocalVideoTaskProductionStore(directory).load("task_persisted");
  assert.deepEqual(restored, result);
  await assert.rejects(
    runtime.confirmStage("task_persisted", command, project, session),
    RevisionConflictError,
  );
  assert.deepEqual(await new LocalVideoTaskProductionStore(directory).load("task_persisted"), result);
  const persisted = JSON.parse(await readFile(join(directory, "task_persisted.json"), "utf8"));
  assert.equal(persisted.videoTask.revision, 6);
  assert.equal(persisted.stageArtifactVersions[0].id, "artifact_version_1");
  assert.equal(persisted.stageConfirmations[0].id, "confirmation_1");
});

test("a failed atomic save leaves the previously loaded aggregate unchanged", async () => {
  const original = productionRecord();
  const failingStore: VideoTaskProductionStore = {
    async load() {
      return structuredClone(original);
    },
    async save() {
      throw new Error("simulated disk failure");
    },
    async transact(_videoTaskId, update) {
      const next = await update(structuredClone(original));
      await this.save(next);
      return next;
    },
  };
  const runtime = new StageConfirmationRuntime(failingStore);

  await assert.rejects(
    runtime.confirmStage("task_persisted", command, project, session),
    /simulated disk failure/u,
  );
  assert.equal(original.videoTask.revision, 5);
  assert.equal(original.stageArtifactVersions.length, 0);
  assert.equal(original.stageConfirmations.length, 0);
});

test("store returns defensive copies so callers cannot mutate persisted versions", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-tasks", false);
  await store.save(productionRecord());
  const loaded = await store.load("task_persisted");
  assert.ok(loaded);
  loaded.videoTask.revision = 999;
  const loadedAgain = await store.load("task_persisted");
  assert.equal(loadedAgain?.videoTask.revision, 5);
});

test("rollback audit and version selection are persisted atomically and reject duplicate revisions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-stage-rollback-store-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new LocalVideoTaskProductionStore(directory);
  await store.save(rollbackRecord());
  const runtime = new StageConfirmationRuntime(
    store,
    () => "2026-08-19T03:00:00.000Z",
    (kind) => `${kind}_persisted`,
  );
  const request = {
    expectedTaskRevision: 7,
    stage: "strategy" as const,
    targetArtifactVersionId: "strategy_v1",
    reason: "恢复首版策略",
  };

  const result = await runtime.rollbackStage("task_persisted", request, project, session);
  assert.equal(result.videoTask.revision, 8);
  assert.equal(result.activeStageArtifactVersionIds.strategy, "strategy_v1");
  assert.equal(result.stageRollbacks[0]?.id, "rollback_persisted");
  assert.deepEqual(
    await new LocalVideoTaskProductionStore(directory).load("task_persisted"),
    result,
  );
  await assert.rejects(
    runtime.rollbackStage("task_persisted", request, project, session),
    RevisionConflictError,
  );
  assert.deepEqual(
    await new LocalVideoTaskProductionStore(directory).load("task_persisted"),
    result,
  );
});

test("a failed rollback save does not partially update the loaded aggregate", async () => {
  const original = rollbackRecord();
  const failingStore: VideoTaskProductionStore = {
    async load() {
      return structuredClone(original);
    },
    async save() {
      throw new Error("simulated rollback disk failure");
    },
    async transact(_videoTaskId, update) {
      const next = await update(structuredClone(original));
      await this.save(next);
      return next;
    },
  };
  const runtime = new StageConfirmationRuntime(failingStore);

  await assert.rejects(
    runtime.rollbackStage(
      "task_persisted",
      {
        expectedTaskRevision: 7,
        stage: "strategy",
        targetArtifactVersionId: "strategy_v1",
        reason: "恢复首版策略",
      },
      project,
      session,
    ),
    /simulated rollback disk failure/u,
  );
  assert.equal(original.videoTask.revision, 7);
  assert.equal(original.activeStageArtifactVersionIds.strategy, "strategy_v2");
  assert.equal(original.stageRollbacks.length, 0);
  assert.equal(original.stageArtifactInvalidations.length, 0);
});

test("stage writes reject missing, cross-brand, and non-owner access before changing the aggregate", async () => {
  const original = rollbackRecord();
  const store = new LocalVideoTaskProductionStore(".data/test-video-task-access", false);
  await store.save(original);
  const runtime = new StageConfirmationRuntime(store);
  const noProjectAccess = { ...session, accessGrants: [] };

  await assert.rejects(
    runtime.rollbackStage(
      "task_persisted",
      {
        expectedTaskRevision: 7,
        stage: "strategy",
        targetArtifactVersionId: "strategy_v1",
        reason: "尝试越权回退",
      },
      project,
      noProjectAccess,
    ),
    WorkspaceAccessDeniedError,
  );
  await assert.rejects(
    runtime.rollbackStage(
      "task_persisted",
      {
        expectedTaskRevision: 7,
        stage: "strategy",
        targetArtifactVersionId: "strategy_v1",
        reason: "尝试跨品牌回退",
      },
      { ...project, brandId: "brand_other" },
      session,
    ),
    WorkspaceAccessDeniedError,
  );
  const memberGrant = {
    ...projectGrant,
    id: "grant_member_e5",
    accountId: "account_member",
  };
  await assert.rejects(
    runtime.rollbackStage(
      "task_persisted",
      {
        expectedTaskRevision: 7,
        stage: "strategy",
        targetArtifactVersionId: "strategy_v1",
        reason: "尝试非负责人回退",
      },
      project,
      {
        tenantId: "tenant_firefly",
        actorAccountId: "account_member",
        role: "creator",
        accessGrants: [memberGrant],
      },
    ),
    WorkspaceAccessDeniedError,
  );
  assert.deepEqual(await store.load("task_persisted"), original);
});

test("store upgrades WS-102 schema v1 records and selects each stage's latest version", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-v1-store-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const current = rollbackRecord();
  const legacy = {
    schemaVersion: 1,
    videoTask: current.videoTask,
    stageArtifactVersions: current.stageArtifactVersions,
    stageConfirmations: current.stageConfirmations,
  };
  await writeFile(join(directory, "task_persisted.json"), `${JSON.stringify(legacy)}\n`, "utf8");

  const upgraded = await new LocalVideoTaskProductionStore(directory).load("task_persisted");
  assert.equal(upgraded?.schemaVersion, 6);
  assert.equal(upgraded?.activeStageArtifactVersionIds.strategy, "strategy_v2");
  assert.deepEqual(upgraded?.stageRollbacks, []);
  assert.deepEqual(upgraded?.stageArtifactInvalidations, []);
  assert.deepEqual(upgraded?.ownershipTransfers, []);
  assert.deepEqual(upgraded?.taskAssetSnapshots, []);
  assert.deepEqual(upgraded?.stageMutationReceipts, []);
});

test("store upgrades WS-103 schema v2 records with an empty ownership audit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-v2-store-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const current = rollbackRecord();
  const legacy = {
    ...current,
    schemaVersion: 2,
  };
  delete (legacy as Partial<VideoTaskProductionRecord>).ownershipTransfers;
  delete (legacy as Partial<VideoTaskProductionRecord>).taskAssetSnapshots;
  await writeFile(join(directory, "task_persisted.json"), `${JSON.stringify(legacy)}\n`, "utf8");

  const upgraded = await new LocalVideoTaskProductionStore(directory).load("task_persisted");
  assert.equal(upgraded?.schemaVersion, 6);
  assert.deepEqual(upgraded?.ownershipTransfers, []);
  assert.deepEqual(upgraded?.taskAssetSnapshots, []);
  assert.deepEqual(upgraded?.stageMutationReceipts, []);
  assert.equal(upgraded?.activeStageArtifactVersionIds.strategy, "strategy_v2");
});

test("store upgrades WS-202 schema v3 records with an empty task asset snapshot history", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-v3-store-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const current = rollbackRecord();
  const legacy = {
    ...current,
    schemaVersion: 3,
  };
  delete (legacy as Partial<VideoTaskProductionRecord>).taskAssetSnapshots;
  await writeFile(join(directory, "task_persisted.json"), `${JSON.stringify(legacy)}\n`, "utf8");

  const upgraded = await new LocalVideoTaskProductionStore(directory).load("task_persisted");
  assert.equal(upgraded?.schemaVersion, 6);
  assert.deepEqual(upgraded?.taskAssetSnapshots, []);
  assert.deepEqual(upgraded?.stageMutationReceipts, []);
  assert.equal(upgraded?.ownershipTransfers.length, current.ownershipTransfers.length);
  assert.equal(upgraded?.activeStageArtifactVersionIds.strategy, "strategy_v2");
});

test("two concurrent takeover requests with the same revision produce exactly one new owner", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-concurrent-takeover", false);
  await store.save(rollbackRecord());
  let sequence = 0;
  const runtime = new StageConfirmationRuntime(
    store,
    () => "2026-08-19T05:00:00.000Z",
    (kind) => `${kind}_${++sequence}`,
  );
  const takeoverRequest = {
    expectedTaskRevision: 7,
    reason: "并发接管测试",
  };

  const outcomes = await Promise.allSettled([
    runtime.takeOverTask(
      "task_persisted",
      takeoverRequest,
      project,
      projectMemberSession("account_member_a"),
    ),
    runtime.takeOverTask(
      "task_persisted",
      takeoverRequest,
      project,
      projectMemberSession("account_member_b"),
    ),
  ]);
  const fulfilled = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<VideoTaskProductionRecord> =>
      outcome.status === "fulfilled",
  );
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.reason instanceof RevisionConflictError);

  const persisted = await store.load("task_persisted");
  assert.ok(persisted);
  assert.equal(persisted.videoTask.revision, 8);
  assert.equal(persisted.videoTask.ownerAccountId, fulfilled[0]?.value.videoTask.ownerAccountId);
  assert.equal(persisted.ownershipTransfers.length, 1);
  assert.equal(persisted.ownershipTransfers[0]?.toOwnerAccountId, persisted.videoTask.ownerAccountId);
});
