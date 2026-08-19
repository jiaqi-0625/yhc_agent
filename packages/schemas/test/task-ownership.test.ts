import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import {
  TakeOverVideoTaskRequestSchema,
  VideoTaskOwnershipTransferSchema,
  type TakeOverVideoTaskRequest,
  type VideoTaskOwnershipTransfer,
} from "../src/index.ts";

const request = {
  expectedTaskRevision: 7,
  reason: "原负责人交接，由我继续制作",
} satisfies TakeOverVideoTaskRequest;

const transfer = {
  id: "ownership_transfer_1",
  tenantId: "tenant_firefly",
  batchProjectId: "project_launch",
  videoTaskId: "task_family",
  fromOwnerAccountId: "account_owner",
  toOwnerAccountId: "account_member",
  expectedTaskRevision: request.expectedTaskRevision,
  reason: request.reason,
  source: "human_action",
  occurredAt: "2026-08-19T04:00:00.000Z",
} satisfies VideoTaskOwnershipTransfer;

test("takeover request contains only revision and reason, never caller-selected identity", () => {
  assert.equal(Value.Check(TakeOverVideoTaskRequestSchema, request), true);
  assert.equal(
    Value.Check(TakeOverVideoTaskRequestSchema, { ...request, actorAccountId: "account_forged" }),
    false,
  );
  assert.equal(
    Value.Check(TakeOverVideoTaskRequestSchema, { ...request, newOwnerAccountId: "account_forged" }),
    false,
  );
  assert.equal(Value.Check(TakeOverVideoTaskRequestSchema, { ...request, reason: "" }), false);
  assert.equal(Value.Check(TakeOverVideoTaskRequestSchema, { ...request, expectedTaskRevision: 0 }), false);
});

test("ownership transfer is an immutable, human-sourced audit record", () => {
  assert.equal(Value.Check(VideoTaskOwnershipTransferSchema, transfer), true);
  assert.equal(
    Value.Check(VideoTaskOwnershipTransferSchema, { ...transfer, source: "agent" }),
    false,
  );
  assert.equal(
    Value.Check(VideoTaskOwnershipTransferSchema, {
      ...transfer,
      updatedAt: "2026-08-19T05:00:00.000Z",
    }),
    false,
  );
  assert.equal(
    Value.Check(VideoTaskOwnershipTransferSchema, {
      ...transfer,
      toOwnerAccountId: transfer.fromOwnerAccountId,
    }),
    true,
  );
});
