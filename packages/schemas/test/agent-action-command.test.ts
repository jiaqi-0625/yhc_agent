import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentActionCommandReceiptSchema,
  ExecuteAgentActionRequestSchema,
  ExecuteAgentActionResponseSchema,
  StageConfirmationRequestSchema,
  VideoTaskStrategyDraftSchema,
} from "../src/index.ts";
import { Value } from "typebox/value";

const card = {
  schemaVersion: 1,
  kind: "agent_action_card",
  videoTaskId: "task_1",
  action: "generate_strategy",
  label: "生成卖点策略草稿",
  summary: "基于车型事实生成策略。",
  expectedRevision: 1,
  cost: { kind: "estimated", amount: 12, currency: "CNY" },
  payload: { schemaVersion: 1, audience: "家庭用户", theme: "周末出行" },
} as const;

const receipt = {
  schemaVersion: 1,
  id: "command_receipt_1",
  tenantId: "tenant_1",
  batchProjectId: "project_1",
  videoTaskId: "task_1",
  actorAccountId: "account_1",
  requestId: "request_1",
  payloadHash: "a".repeat(64),
  action: "generate_strategy",
  expectedTaskRevision: 1,
  resultingTaskRevision: 2,
  cost: { kind: "free", amountMinor: 0, charged: false },
  result: { kind: "strategy_generated", strategyDraftId: "strategy_draft_1" },
  occurredAt: "2026-08-19T10:00:00.000Z",
} as const;

test("Agent action execution wrapper keeps request id outside the frozen card", () => {
  const request = { requestId: "request_1", card };
  assert.equal(Value.Check(ExecuteAgentActionRequestSchema, request), true);
  assert.equal(Value.Check(ExecuteAgentActionRequestSchema, { ...request, actorAccountId: "forged" }), false);
  assert.equal(Value.Check(ExecuteAgentActionRequestSchema, { card: { ...card, requestId: "forged" } }), false);
});

test("command receipt records authoritative zero cost and rejects display-cost shapes", () => {
  assert.equal(Value.Check(AgentActionCommandReceiptSchema, receipt), true);
  assert.equal(Value.Check(AgentActionCommandReceiptSchema, {
    ...receipt,
    cost: card.cost,
  }), false);
  assert.equal(Value.Check(AgentActionCommandReceiptSchema, {
    ...receipt,
    cost: { kind: "free", amountMinor: 0, charged: true },
  }), false);
  assert.equal(Value.Check(AgentActionCommandReceiptSchema, {
    ...receipt,
    payloadHash: "not-a-hash",
  }), false);
});

test("V2 strategy draft and confirmation request are strict scoped contracts", () => {
  const draft = {
    schemaVersion: 1,
    id: "strategy_draft_1",
    tenantId: "tenant_1",
    batchProjectId: "project_1",
    videoTaskId: "task_1",
    vehicleSnapshotId: "vehicle_snapshot_1",
    version: 1,
    status: "draft",
    audience: "家庭用户",
    theme: "周末出行",
    items: [{
      id: "strategy_item_1",
      claimId: "claim_1",
      kind: "fixed",
      title: "续航",
      statement: "CLTC 续航 550 公里",
      rationale: "车型事实快照中的固定卖点。",
      order: 1,
      locked: false,
    }],
    validation: { valid: false, issues: [{
      code: "AIC-STRATEGY-EVIDENCE_REQUIRED",
      severity: "error",
      message: "缺少事实依据。",
    }] },
    generation: { kind: "vehicle_fact_projection", templateVersion: "v1" },
    createdAt: "2026-08-19T10:00:00.000Z",
    createdBy: "account_1",
    updatedAt: "2026-08-19T10:00:00.000Z",
    updatedBy: "account_1",
  };
  const confirmationRequest = {
    schemaVersion: 1,
    id: "confirmation_request_1",
    tenantId: "tenant_1",
    batchProjectId: "project_1",
    videoTaskId: "task_1",
    stage: "strategy",
    strategyDraftId: "strategy_draft_1",
    expectedTaskRevision: 2,
    source: "human_action",
    actorAccountId: "account_1",
    occurredAt: "2026-08-19T10:01:00.000Z",
  };
  assert.equal(Value.Check(VideoTaskStrategyDraftSchema, draft), true);
  assert.equal(Value.Check(StageConfirmationRequestSchema, confirmationRequest), true);
  assert.equal(Value.Check(StageConfirmationRequestSchema, { ...confirmationRequest, approved: true }), false);
});

test("execution response returns the authoritative receipt and current task", () => {
  const videoTask = {
    id: "task_1",
    tenantId: "tenant_1",
    batchProjectId: "project_1",
    name: "任务 1",
    ownerAccountId: "account_1",
    status: "active",
    currentStage: "strategy",
    stageStatus: "in_progress",
    revision: 2,
    audience: "家庭用户",
    theme: "周末出行",
    durationSeconds: 30,
    platformTags: ["douyin"],
    createdAt: "2026-08-19T09:00:00.000Z",
    createdBy: "account_1",
    updatedAt: "2026-08-19T10:00:00.000Z",
    updatedBy: "account_1",
  };
  assert.equal(Value.Check(ExecuteAgentActionResponseSchema, {
    receipt,
    replayed: false,
    videoTask,
  }), true);
});
