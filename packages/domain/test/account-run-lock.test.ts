import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountHighCostTaskRunningError,
  AccountRunLockDeniedError,
  AccountRunLockTokenMismatchError,
  acquireAccountHighCostTaskRunLock,
  releaseAccountHighCostTaskRunLock,
} from "../src/index.ts";
import type { VideoTask } from "@firefly/schemas";

function videoTask(): VideoTask {
  return {
    id: "task_preview",
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    name: "预览生成任务",
    ownerAccountId: "account_creator",
    status: "active",
    currentStage: "video_preview",
    stageStatus: "in_progress",
    revision: 8,
    audience: "家庭用户",
    theme: "周末出行",
    durationSeconds: 30,
    platformTags: ["douyin"],
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_creator",
    updatedAt: "2026-08-19T05:00:00.000Z",
    updatedBy: "account_creator",
  };
}

const context = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_creator",
  occurredAt: "2026-08-19T06:00:00.000Z",
  createId: () => "run_lock_1",
};

test("acquiring a high-cost run lock binds the authenticated account and task revision", () => {
  assert.deepEqual(
    acquireAccountHighCostTaskRunLock(undefined, videoTask(), "video_generation", context),
    {
      id: "run_lock_1",
      tenantId: "tenant_firefly",
      accountId: "account_creator",
      batchProjectId: "project_launch",
      videoTaskId: "task_preview",
      taskRevision: 8,
      operation: "video_generation",
      acquiredAt: "2026-08-19T06:00:00.000Z",
    },
  );
});

test("an existing account lock rejects every second high-cost task", () => {
  const active = acquireAccountHighCostTaskRunLock(
    undefined,
    videoTask(),
    "video_generation",
    context,
  );
  const second = { ...videoTask(), id: "task_second" };
  assert.throws(
    () => acquireAccountHighCostTaskRunLock(active, second, "automatic_editing", context),
    (error: unknown) =>
      error instanceof AccountHighCostTaskRunningError &&
      error.activeLock.videoTaskId === "task_preview",
  );
});

test("run locks reject cross-scope, non-owner, terminal, and non-expensive operations", () => {
  assert.throws(
    () =>
      acquireAccountHighCostTaskRunLock(undefined, videoTask(), "video_generation", {
        ...context,
        tenantId: "tenant_other",
      }),
    AccountRunLockDeniedError,
  );
  assert.throws(
    () =>
      acquireAccountHighCostTaskRunLock(undefined, videoTask(), "video_generation", {
        ...context,
        actorAccountId: "account_other",
      }),
    AccountRunLockDeniedError,
  );
  assert.throws(
    () =>
      acquireAccountHighCostTaskRunLock(
        undefined,
        { ...videoTask(), status: "completed" },
        "video_generation",
        context,
      ),
    AccountRunLockDeniedError,
  );
  assert.throws(
    () =>
      acquireAccountHighCostTaskRunLock(
        undefined,
        videoTask(),
        "stage_confirmation" as "video_generation",
        context,
      ),
    AccountRunLockDeniedError,
  );
});

test("release is idempotent but a stale completion cannot clear a newer lock", () => {
  assert.equal(releaseAccountHighCostTaskRunLock(undefined, "run_lock_1"), undefined);
  const active = acquireAccountHighCostTaskRunLock(
    undefined,
    videoTask(),
    "video_generation",
    context,
  );
  assert.throws(
    () => releaseAccountHighCostTaskRunLock(active, "run_lock_stale"),
    AccountRunLockTokenMismatchError,
  );
  assert.equal(releaseAccountHighCostTaskRunLock(active, active.id), undefined);
});
