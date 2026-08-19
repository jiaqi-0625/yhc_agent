import assert from "node:assert/strict";
import test from "node:test";

import { Value } from "typebox/value";

import {
  ConfirmVideoTaskStageRequestSchema,
  ConfirmVideoTaskStageResponseSchema,
  RollbackVideoTaskStageRequestSchema,
  RollbackVideoTaskStageResponseSchema,
  StageMutationReceiptSchema,
  VideoTaskStageAuditResponseSchema,
  VideoTaskStageVersionsResponseSchema,
  type ConfirmStageMutationReceipt,
  type ConfirmVideoTaskStageRequest,
  type ConfirmVideoTaskStageResponse,
  type RollbackStageMutationReceipt,
  type RollbackVideoTaskStageRequest,
  type RollbackVideoTaskStageResponse,
  type StageArtifactInvalidation,
  type StageArtifactVersion,
  type StageConfirmation,
  type StageConfirmationRequest,
  type StageRollbackRecord,
  type VideoTask,
  type VideoTaskStrategyDraft,
  type VideoTaskStageAuditResponse,
  type VideoTaskStageVersionsResponse,
} from "../src/index.ts";

const occurredAt = "2026-08-19T16:00:00.000Z";

const videoTask = {
  id: "task_stage_api",
  tenantId: "tenant_firefly",
  batchProjectId: "project_stage_api",
  name: "阶段 API 验收任务",
  ownerAccountId: "account_creator",
  status: "active",
  currentStage: "asset_matching",
  stageStatus: "in_progress",
  revision: 8,
  vehicleSnapshotId: "vehicle_snapshot_1",
  assetSnapshotId: "asset_snapshot_1",
  audience: "城市家庭",
  theme: "新车上市",
  durationSeconds: 30,
  platformTags: ["douyin"],
  createdAt: "2026-08-19T15:00:00.000Z",
  createdBy: "account_creator",
  updatedAt: occurredAt,
  updatedBy: "account_creator",
} satisfies VideoTask;

const artifactVersion = {
  id: "artifact_strategy_v2",
  tenantId: videoTask.tenantId,
  batchProjectId: videoTask.batchProjectId,
  videoTaskId: videoTask.id,
  stage: "strategy",
  version: 2,
  content: {
    artifactId: "strategy_draft_2",
    schemaName: "marketing_strategy",
    schemaVersion: 1,
    contentHashSha256: "a".repeat(64),
  },
  dependencies: [
    { kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" },
    { kind: "asset_snapshot", assetSnapshotId: "asset_snapshot_1" },
  ],
  provenance: { kind: "human_confirmation", confirmationId: "confirmation_strategy_v2" },
  createdAt: occurredAt,
  createdBy: "account_creator",
} satisfies StageArtifactVersion;

const confirmation = {
  id: "confirmation_strategy_v2",
  tenantId: videoTask.tenantId,
  batchProjectId: videoTask.batchProjectId,
  videoTaskId: videoTask.id,
  stage: "strategy",
  artifactVersionId: artifactVersion.id,
  decision: "confirmed",
  source: "human_action",
  expectedTaskRevision: 7,
  actorAccountId: "account_creator",
  comment: "人工确认策略事实与表达。",
  occurredAt,
} satisfies StageConfirmation;

const invalidation = {
  id: "invalidation_script_v1",
  tenantId: videoTask.tenantId,
  batchProjectId: videoTask.batchProjectId,
  videoTaskId: videoTask.id,
  stage: "script",
  artifactVersionId: "artifact_script_v1",
  reason: "恢复已审核的策略版本。",
  invalidatedDependency: {
    kind: "stage_artifact",
    stage: "strategy",
    artifactVersionId: "artifact_strategy_v2",
  },
  cause: {
    kind: "rollback",
    reasonCode: "upstream_rollback",
    rollbackId: "rollback_strategy_v2_to_v1",
  },
  occurredAt,
} satisfies StageArtifactInvalidation;

const rollback = {
  id: "rollback_strategy_v2_to_v1",
  tenantId: videoTask.tenantId,
  batchProjectId: videoTask.batchProjectId,
  videoTaskId: videoTask.id,
  stage: "strategy",
  fromArtifactVersionId: "artifact_strategy_v2",
  toArtifactVersionId: "artifact_strategy_v1",
  expectedTaskRevision: 7,
  reason: "恢复已审核的策略版本。",
  requestedBy: "account_creator",
  invalidationIds: [invalidation.id],
  occurredAt,
} satisfies StageRollbackRecord;

const confirmReceipt = {
  schemaVersion: 1,
  id: "stage_mutation_receipt_confirm_1",
  tenantId: videoTask.tenantId,
  batchProjectId: videoTask.batchProjectId,
  videoTaskId: videoTask.id,
  actorAccountId: "account_creator",
  requestId: "request_confirm_strategy_v2",
  payloadHash: "b".repeat(64),
  action: "confirm_stage",
  expectedTaskRevision: 7,
  resultingTaskRevision: 8,
  result: {
    kind: "stage_confirmed",
    stage: "strategy",
    confirmationId: confirmation.id,
    artifactVersionId: artifactVersion.id,
  },
  occurredAt,
} satisfies ConfirmStageMutationReceipt;

const rollbackReceipt = {
  schemaVersion: 1,
  id: "stage_mutation_receipt_rollback_1",
  tenantId: videoTask.tenantId,
  batchProjectId: videoTask.batchProjectId,
  videoTaskId: videoTask.id,
  actorAccountId: "account_creator",
  requestId: "request_rollback_strategy_v1",
  payloadHash: "c".repeat(64),
  action: "rollback_stage",
  expectedTaskRevision: 7,
  resultingTaskRevision: 8,
  result: {
    kind: "stage_rolled_back",
    stage: "strategy",
    stageRollbackId: rollback.id,
    invalidationIds: [invalidation.id],
  },
  occurredAt,
} satisfies RollbackStageMutationReceipt;

const activeStrategyDraft = {
  schemaVersion: 1,
  id: "strategy_draft_2",
  tenantId: videoTask.tenantId,
  batchProjectId: videoTask.batchProjectId,
  videoTaskId: videoTask.id,
  vehicleSnapshotId: "vehicle_snapshot_1",
  version: 2,
  status: "awaiting_confirmation",
  audience: videoTask.audience,
  theme: videoTask.theme,
  items: [{
    id: "strategy_item_1",
    claimId: "claim_range",
    kind: "fixed",
    title: "长续航",
    statement: "CLTC 续航 520 公里。",
    rationale: "覆盖家庭出行需求。",
    order: 1,
    locked: false,
  }],
  validation: { valid: true, issues: [] },
  generation: { kind: "vehicle_fact_projection", templateVersion: "v1" },
  createdAt: "2026-08-19T15:30:00.000Z",
  createdBy: "account_creator",
  updatedAt: "2026-08-19T15:45:00.000Z",
  updatedBy: "account_creator",
} satisfies VideoTaskStrategyDraft;

const confirmationRequest = {
  schemaVersion: 1,
  id: "confirmation_request_strategy_2",
  tenantId: videoTask.tenantId,
  batchProjectId: videoTask.batchProjectId,
  videoTaskId: videoTask.id,
  stage: "strategy",
  strategyDraftId: activeStrategyDraft.id,
  expectedTaskRevision: 6,
  source: "human_action",
  actorAccountId: "account_creator",
  occurredAt: "2026-08-19T15:45:00.000Z",
} satisfies StageConfirmationRequest;

test("stage mutation requests accept only client-owned business fields", () => {
  const confirmRequest = {
    requestId: "request_confirm_strategy_v2",
    expectedTaskRevision: 7,
    artifact: artifactVersion.content,
    comment: "人工验收通过。",
  } satisfies ConfirmVideoTaskStageRequest;
  const derivedStrategyRequest = {
    requestId: "request_confirm_derived_strategy_v2",
    expectedTaskRevision: 7,
    comment: "确认服务端派生的策略产物引用。",
  } satisfies ConfirmVideoTaskStageRequest;
  const rollbackRequest = {
    requestId: "request_rollback_strategy_v1",
    expectedTaskRevision: 7,
    targetArtifactVersionId: "artifact_strategy_v1",
    reason: "恢复已审核的策略版本。",
  } satisfies RollbackVideoTaskStageRequest;

  assert.equal(Value.Check(ConfirmVideoTaskStageRequestSchema, confirmRequest), true);
  assert.equal(Value.Check(ConfirmVideoTaskStageRequestSchema, derivedStrategyRequest), true);
  assert.equal(Value.Check(RollbackVideoTaskStageRequestSchema, rollbackRequest), true);

  for (const forged of [
    { actorAccountId: "account_attacker" },
    { tenantId: "tenant_attacker" },
    { batchProjectId: "project_attacker" },
    { videoTaskId: "task_attacker" },
    { source: "human_action" },
    { stage: "strategy" },
    { dependencies: artifactVersion.dependencies },
    { confirmationId: confirmation.id },
    { result: confirmReceipt.result },
    { resultingTaskRevision: 8 },
  ]) {
    assert.equal(Value.Check(ConfirmVideoTaskStageRequestSchema, { ...confirmRequest, ...forged }), false);
    assert.equal(Value.Check(RollbackVideoTaskStageRequestSchema, { ...rollbackRequest, ...forged }), false);
  }

  assert.equal(
    Value.Check(RollbackVideoTaskStageRequestSchema, {
      ...rollbackRequest,
      invalidationIds: [invalidation.id],
    }),
    false,
  );
});

test("stage mutation receipts correlate each action with its exact result", () => {
  assert.equal(Value.Check(StageMutationReceiptSchema, confirmReceipt), true);
  assert.equal(Value.Check(StageMutationReceiptSchema, rollbackReceipt), true);
  assert.equal(
    Value.Check(StageMutationReceiptSchema, { ...confirmReceipt, result: rollbackReceipt.result }),
    false,
  );
  assert.equal(
    Value.Check(StageMutationReceiptSchema, { ...rollbackReceipt, result: confirmReceipt.result }),
    false,
  );
  assert.equal(
    Value.Check(StageMutationReceiptSchema, { ...confirmReceipt, payloadHash: "not-a-hash" }),
    false,
  );
  assert.equal(
    Value.Check(StageMutationReceiptSchema, {
      ...rollbackReceipt,
      result: { ...rollbackReceipt.result, invalidationIds: [invalidation.id, invalidation.id] },
    }),
    false,
  );
  assert.equal(
    Value.Check(StageMutationReceiptSchema, { ...confirmReceipt, charged: false }),
    false,
  );
});

test("confirmation and rollback responses expose their correlated audits without internal extras", () => {
  const confirmResponse = {
    replayed: false,
    receipt: confirmReceipt,
    videoTask,
    confirmation,
    artifactVersion,
  } satisfies ConfirmVideoTaskStageResponse;
  const rollbackResponse = {
    replayed: false,
    receipt: rollbackReceipt,
    videoTask,
    rollback,
    invalidations: [invalidation],
  } satisfies RollbackVideoTaskStageResponse;

  assert.equal(Value.Check(ConfirmVideoTaskStageResponseSchema, confirmResponse), true);
  assert.equal(Value.Check(RollbackVideoTaskStageResponseSchema, rollbackResponse), true);
  assert.equal(
    Value.Check(ConfirmVideoTaskStageResponseSchema, { ...confirmResponse, receipt: rollbackReceipt }),
    false,
  );
  assert.equal(
    Value.Check(RollbackVideoTaskStageResponseSchema, { ...rollbackResponse, receipt: confirmReceipt }),
    false,
  );
  assert.equal(
    Value.Check(ConfirmVideoTaskStageResponseSchema, {
      ...confirmResponse,
      source: "agent",
    }),
    false,
  );
  assert.equal(
    Value.Check(RollbackVideoTaskStageResponseSchema, {
      ...rollbackResponse,
      invalidationIds: [invalidation.id],
    }),
    false,
  );
});

test("stage version and full-task audit queries expose only their frozen public records", () => {
  const versionsResponse = {
    videoTask,
    activeArtifactVersionId: artifactVersion.id,
    versions: [artifactVersion],
    confirmations: [confirmation],
    rollbacks: [rollback],
    invalidations: [invalidation],
    activeStrategyDraft,
    confirmationRequest,
  } satisfies VideoTaskStageVersionsResponse;
  const emptyVersionsResponse = {
    videoTask,
    versions: [],
    confirmations: [],
    rollbacks: [],
    invalidations: [],
  } satisfies VideoTaskStageVersionsResponse;
  const auditResponse = {
    videoTask,
    rollbacks: [rollback],
    invalidations: [invalidation],
  } satisfies VideoTaskStageAuditResponse;

  assert.equal(Value.Check(VideoTaskStageVersionsResponseSchema, versionsResponse), true);
  assert.equal(Value.Check(VideoTaskStageVersionsResponseSchema, emptyVersionsResponse), true);
  assert.equal(Value.Check(VideoTaskStageAuditResponseSchema, auditResponse), true);
  assert.equal(
    Value.Check(VideoTaskStageVersionsResponseSchema, {
      ...versionsResponse,
      commandReceipts: [confirmReceipt],
    }),
    false,
  );
  assert.equal(
    Value.Check(VideoTaskStageAuditResponseSchema, {
      ...auditResponse,
      payloadHash: rollbackReceipt.payloadHash,
    }),
    false,
  );
});
