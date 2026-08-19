import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import {
  AccountHighCostTaskRunLockSchema,
  HighCostTaskOperationSchema,
  type AccountHighCostTaskRunLock,
} from "../src/index.ts";

const lock = {
  id: "run_lock_1",
  tenantId: "tenant_firefly",
  accountId: "account_creator",
  batchProjectId: "project_launch",
  videoTaskId: "task_preview",
  taskRevision: 8,
  operation: "video_generation",
  acquiredAt: "2026-08-19T06:00:00.000Z",
} satisfies AccountHighCostTaskRunLock;

test("account run locks identify one server-scoped high-cost task operation", () => {
  assert.equal(Value.Check(AccountHighCostTaskRunLockSchema, lock), true);
  assert.equal(Value.Check(HighCostTaskOperationSchema, "automatic_editing"), true);
  assert.equal(Value.Check(HighCostTaskOperationSchema, "stage_confirmation"), false);
});

test("account run locks reject caller authority and mutable lifecycle fields", () => {
  assert.equal(
    Value.Check(AccountHighCostTaskRunLockSchema, { ...lock, releaseToken: "caller_token" }),
    false,
  );
  assert.equal(
    Value.Check(AccountHighCostTaskRunLockSchema, { ...lock, status: "released" }),
    false,
  );
  assert.equal(
    Value.Check(AccountHighCostTaskRunLockSchema, { ...lock, taskRevision: 0 }),
    false,
  );
});
