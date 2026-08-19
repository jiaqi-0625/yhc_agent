import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import {
  AssignVideoTaskOwnerRequestSchema,
  CreateVideoTaskRequestSchema,
  VideoTaskOwnershipTransferSchema,
  type AssignVideoTaskOwnerRequest,
  type CreateVideoTaskRequest,
  type VideoTaskOwnershipTransfer,
} from "../src/index.ts";

const creationRequest = {
  requestId: "request_task_1",
  name: "家庭周末出行",
  audience: "有孩家庭",
  theme: "周末出游",
  durationSeconds: 30,
  platformTags: ["douyin", "xiaohongshu"],
  scriptInput: "已有脚本",
  ownerAccountId: "account_target",
} satisfies CreateVideoTaskRequest;

test("task creation accepts only task brief, optional target owner, and idempotency fields", () => {
  assert.equal(Value.Check(CreateVideoTaskRequestSchema, creationRequest), true);
  for (const injected of [
    "tenantId",
    "batchProjectId",
    "actorAccountId",
    "status",
    "currentStage",
    "stageStatus",
    "revision",
    "vehicleSnapshotId",
    "assetSnapshotId",
    "createdAt",
    "createdBy",
    "updatedAt",
    "updatedBy",
  ]) {
    assert.equal(
      Value.Check(CreateVideoTaskRequestSchema, { ...creationRequest, [injected]: "forged" }),
      false,
      injected,
    );
  }
  assert.equal(
    Value.Check(CreateVideoTaskRequestSchema, {
      ...creationRequest,
      ownerAccountId: undefined,
      scriptInput: undefined,
    }),
    true,
  );
  assert.equal(
    Value.Check(CreateVideoTaskRequestSchema, { ...creationRequest, platformTags: ["douyin", "douyin"] }),
    false,
  );
  assert.equal(
    Value.Check(CreateVideoTaskRequestSchema, { ...creationRequest, durationSeconds: 601 }),
    false,
  );
});

const assignmentRequest = {
  expectedTaskRevision: 3,
  targetOwnerAccountId: "account_target",
  reason: "负责人工作交接",
} satisfies AssignVideoTaskOwnerRequest;

test("explicit owner assignment freezes target, revision, and human reason only", () => {
  assert.equal(Value.Check(AssignVideoTaskOwnerRequestSchema, assignmentRequest), true);
  for (const injected of ["actorAccountId", "tenantId", "batchProjectId", "source", "occurredAt"]) {
    assert.equal(
      Value.Check(AssignVideoTaskOwnerRequestSchema, { ...assignmentRequest, [injected]: "forged" }),
      false,
      injected,
    );
  }
  assert.equal(
    Value.Check(AssignVideoTaskOwnerRequestSchema, { ...assignmentRequest, expectedTaskRevision: 0 }),
    false,
  );
  assert.equal(
    Value.Check(AssignVideoTaskOwnerRequestSchema, { ...assignmentRequest, reason: "" }),
    false,
  );
});

test("ownership audit optionally records the assigning actor without invalidating legacy transfers", () => {
  const transfer = {
    id: "ownership_transfer_2",
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    videoTaskId: "task_family",
    fromOwnerAccountId: "account_owner",
    toOwnerAccountId: "account_target",
    expectedTaskRevision: 3,
    reason: "负责人工作交接",
    source: "human_action",
    actorAccountId: "account_assigner",
    occurredAt: "2026-08-19T04:00:00.000Z",
  } satisfies VideoTaskOwnershipTransfer;

  assert.equal(Value.Check(VideoTaskOwnershipTransferSchema, transfer), true);
  const { actorAccountId: _legacyOmission, ...legacyTransfer } = transfer;
  assert.equal(Value.Check(VideoTaskOwnershipTransferSchema, legacyTransfer), true);
  assert.equal(
    Value.Check(VideoTaskOwnershipTransferSchema, { ...transfer, updatedAt: transfer.occurredAt }),
    false,
  );
});
