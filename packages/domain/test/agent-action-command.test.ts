import assert from "node:assert/strict";
import test from "node:test";

import type { BatchProject, ProjectAssetPool, VehicleSnapshot } from "@firefly/schemas";

import {
  AgentActionCommandError,
  createVideoTask,
  generateVideoTaskStrategy,
  requestVideoTaskStrategyApproval,
  type AgentActionCommandContext,
} from "../src/index.ts";

const occurredAt = "2026-08-19T10:00:00.000Z";

const project: BatchProject = {
  id: "project_1",
  tenantId: "tenant_1",
  brandId: "brand_1",
  vehicleId: "vehicle_1",
  vehicleVersion: 3,
  name: "萤火 E5 9:16 上市",
  batchName: "上市",
  aspectRatio: "9:16",
  visualStylePresetId: "style_1",
  assetPoolId: "pool_1",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T08:00:00.000Z",
  createdBy: "account_owner",
  updatedAt: "2026-08-19T08:00:00.000Z",
  updatedBy: "account_owner",
};

const pool: ProjectAssetPool = {
  id: "pool_1",
  tenantId: project.tenantId,
  batchProjectId: project.id,
  vehicleId: project.vehicleId,
  revision: 2,
  assets: [{
    assetId: "vehicle_asset_1",
    version: 2,
    source: "company_catalog",
    sourceProvider: "mock_company_assets",
    category: "vehicle",
    vehicleId: project.vehicleId,
  }],
  createdAt: "2026-08-19T08:00:00.000Z",
  createdBy: "account_owner",
  updatedAt: "2026-08-19T09:00:00.000Z",
  updatedBy: "account_owner",
};

const evidence = {
  sourceName: "车型配置表",
  sourceReference: "vehicle-facts-v3",
  effectiveFrom: "2026-08-01",
};

const vehicleSnapshot: VehicleSnapshot = {
  id: "vehicle_snapshot_1",
  projectId: project.id,
  vehicleId: project.vehicleId,
  vehicleVersion: project.vehicleVersion,
  brandId: project.brandId,
  brand: "萤火汽车",
  series: "E5",
  modelYear: 2026,
  trim: "长续航版",
  parameters: {},
  fixedClaims: [{
    id: "claim_range",
    kind: "fixed",
    name: "续航",
    statement: "CLTC 续航 550 公里",
    evidence,
    requiredInVoiceover: true,
    requiredInSubtitle: true,
    mayRephrase: false,
    riskNotes: [],
  }],
  optionalClaims: [],
  prohibitedClaims: ["全国最低价"],
  referenceAssetIds: ["vehicle_asset_1"],
  createdAt: "2026-08-19T09:00:00.000Z",
  createdBy: "account_owner",
};

function sourceRecord() {
  return createVideoTask(project, {
    name: "家庭周末出行",
    audience: "家庭用户",
    theme: "周末出行",
    durationSeconds: 30,
    platformTags: ["douyin"],
  }, {
    tenantId: project.tenantId,
    actorAccountId: "account_owner",
    ownerAccountId: "account_owner",
    occurredAt: "2026-08-19T09:30:00.000Z",
    taskId: "task_1",
  });
}

function context(
  requestId: string,
  payloadHash: string,
  overrides: Partial<AgentActionCommandContext> = {},
): AgentActionCommandContext {
  let sequence = 0;
  return {
    tenantId: project.tenantId,
    batchProjectId: project.id,
    actorAccountId: "account_owner",
    requestId,
    payloadHash,
    occurredAt,
    createId: (kind) => `${kind}_${++sequence}`,
    ...overrides,
  };
}

test("strategy generation atomically locks snapshots, projects facts, and records a free receipt", () => {
  const source = sourceRecord();
  const commandContext = context("request_generate", "a".repeat(64));
  const result = generateVideoTaskStrategy(source, {
    expectedTaskRevision: 1,
    audience: "  家庭用户  ",
    theme: "周末出行",
  }, project, pool, vehicleSnapshot, commandContext);

  assert.equal(source.videoTask.vehicleSnapshotId, undefined);
  assert.equal(result.schemaVersion, 6);
  assert.equal(result.videoTask.revision, 2);
  assert.equal(result.taskVehicleSnapshots.length, 1);
  assert.equal(result.taskAssetSnapshots.length, 1);
  assert.equal(result.strategyDrafts.length, 1);
  assert.equal(result.strategyDrafts[0]?.items[0]?.statement, "CLTC 续航 550 公里");
  assert.equal(result.strategyDrafts[0]?.validation.valid, true);
  assert.equal(result.activeStrategyDraftId, result.strategyDrafts[0]?.id);
  assert.deepEqual(result.commandReceipts[0]?.cost, {
    kind: "free",
    amountMinor: 0,
    charged: false,
  });
  assert.equal(result.commandReceipts[0]?.result.kind, "strategy_generated");

  const replay = generateVideoTaskStrategy(result, {
    expectedTaskRevision: 1,
    audience: "家庭用户",
    theme: "周末出行",
  }, project, pool, vehicleSnapshot, commandContext);
  assert.deepEqual(replay, result);
  assert.equal(replay.commandReceipts.length, 1);
});

test("strategy generation rejects idempotency conflicts and snapshot version replacement", () => {
  const generated = generateVideoTaskStrategy(sourceRecord(), {
    expectedTaskRevision: 1,
    audience: "家庭用户",
    theme: "周末出行",
  }, project, pool, vehicleSnapshot, context("request_generate", "a".repeat(64)));

  assert.throws(
    () => generateVideoTaskStrategy(generated, {
      expectedTaskRevision: 1,
      audience: "年轻用户",
      theme: "城市通勤",
    }, project, pool, vehicleSnapshot, context("request_generate", "b".repeat(64))),
    (error: unknown) =>
      error instanceof AgentActionCommandError &&
      error.code === "AIC-AGENT-COMMAND-IDEMPOTENCY_CONFLICT",
  );
  assert.throws(
    () => generateVideoTaskStrategy(sourceRecord(), {
      expectedTaskRevision: 1,
      audience: "家庭用户",
      theme: "周末出行",
    }, project, pool, { ...vehicleSnapshot, vehicleVersion: 2 }, context("request_other", "c".repeat(64))),
    AgentActionCommandError,
  );
});

test("strategy regeneration preserves human locks and ignores the mutable project pool", () => {
  const generated = generateVideoTaskStrategy(sourceRecord(), {
    expectedTaskRevision: 1,
    audience: "家庭用户",
    theme: "周末出行",
  }, project, pool, vehicleSnapshot, context("request_generate", "a".repeat(64)));
  const locked = structuredClone(generated);
  const firstItem = locked.strategyDrafts[0]?.items[0];
  assert.ok(firstItem);
  firstItem.locked = true;
  firstItem.title = "人工锁定的续航表达";

  const regenerated = generateVideoTaskStrategy(locked, {
    expectedTaskRevision: 2,
    audience: "城市家庭",
    theme: "日常通勤",
  }, project, { ...pool, assets: [] }, vehicleSnapshot, context("request_regenerate", "d".repeat(64)));

  assert.equal(regenerated.videoTask.revision, 3);
  assert.equal(regenerated.strategyDrafts[1]?.version, 2);
  assert.equal(regenerated.strategyDrafts[1]?.items[0]?.id, firstItem.id);
  assert.equal(regenerated.strategyDrafts[1]?.items[0]?.title, "人工锁定的续航表达");
  assert.equal(regenerated.strategyDrafts[1]?.items[0]?.locked, true);
  assert.equal(regenerated.strategyDrafts[1]?.validation.valid, true);
});

test("approval request only enters awaiting confirmation and records immutable human intent", () => {
  const generated = generateVideoTaskStrategy(sourceRecord(), {
    expectedTaskRevision: 1,
    audience: "家庭用户",
    theme: "周末出行",
  }, project, pool, vehicleSnapshot, context("request_generate", "a".repeat(64)));
  const result = requestVideoTaskStrategyApproval(
    generated,
    { expectedTaskRevision: 2 },
    context("request_approval", "b".repeat(64), {
      occurredAt: "2026-08-19T10:05:00.000Z",
    }),
  );

  assert.equal(result.videoTask.revision, 3);
  assert.equal(result.videoTask.stageStatus, "awaiting_confirmation");
  assert.equal(result.videoTask.currentStage, "strategy");
  assert.equal(result.strategyDrafts[0]?.status, "awaiting_confirmation");
  assert.equal(result.stageConfirmationRequests.length, 1);
  assert.equal(result.stageConfirmationRequests[0]?.source, "human_action");
  assert.equal(result.stageConfirmations.length, 0);
  assert.equal(result.commandReceipts[1]?.result.kind, "strategy_confirmation_requested");
  assert.equal(result.commandReceipts[1]?.cost.charged, false);
});

test("approval request rejects invalid facts and non-owner commands", () => {
  const { evidence: _evidence, ...claimWithoutEvidence } = vehicleSnapshot.fixedClaims[0]!;
  const invalidSnapshot = {
    ...vehicleSnapshot,
    fixedClaims: [claimWithoutEvidence],
  };
  const generated = generateVideoTaskStrategy(sourceRecord(), {
    expectedTaskRevision: 1,
    audience: "家庭用户",
    theme: "周末出行",
  }, project, pool, invalidSnapshot, context("request_generate", "a".repeat(64)));
  assert.equal(generated.strategyDrafts[0]?.validation.valid, false);
  assert.throws(
    () => requestVideoTaskStrategyApproval(
      generated,
      { expectedTaskRevision: 2 },
      context("request_approval", "b".repeat(64)),
    ),
    (error: unknown) =>
      error instanceof AgentActionCommandError &&
      error.code === "AIC-AGENT-COMMAND-STRATEGY_VALIDATION_FAILED",
  );
  assert.throws(
    () => generateVideoTaskStrategy(sourceRecord(), {
      expectedTaskRevision: 1,
      audience: "家庭用户",
      theme: "周末出行",
    }, project, pool, vehicleSnapshot, context("request_intruder", "c".repeat(64), {
      actorAccountId: "account_intruder",
    })),
    AgentActionCommandError,
  );
});
