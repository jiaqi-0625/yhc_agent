import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AccountHighCostTaskRunningError,
  AccountRunLockTokenMismatchError,
  WorkspaceAccessDeniedError,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type { BatchProject, VideoTask, WorkspaceAccessGrant } from "@firefly/schemas";

import { AccountRunLockRuntime } from "../src/account-run-lock-runtime.ts";
import { LocalAccountRunLockStore } from "../src/account-run-lock-store.ts";
import { errorStatus } from "../src/http-boundary.ts";

const project: BatchProject = {
  id: "project_launch",
  tenantId: "tenant_firefly",
  brandId: "brand_firefly",
  vehicleId: "vehicle_e5",
  name: "萤火虫 E5 9:16 上新",
  batchName: "上新",
  aspectRatio: "9:16",
  visualStylePresetId: "style_clean",
  assetPoolId: "asset_pool_launch",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T00:00:00.000Z",
  createdBy: "account_creator_a",
  updatedAt: "2026-08-19T00:00:00.000Z",
  updatedBy: "account_creator_a",
};

function task(id: string, ownerAccountId: string): VideoTask {
  return {
    id,
    tenantId: "tenant_firefly",
    batchProjectId: project.id,
    name: `${id} 视频任务`,
    ownerAccountId,
    status: "active",
    currentStage: "video_preview",
    stageStatus: "in_progress",
    revision: 8,
    audience: "家庭用户",
    theme: "周末出行",
    durationSeconds: 30,
    platformTags: ["douyin"],
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: ownerAccountId,
    updatedAt: "2026-08-19T05:00:00.000Z",
    updatedBy: ownerAccountId,
  };
}

function session(accountId: string): WorkspaceSessionScope {
  const grant: WorkspaceAccessGrant = {
    id: `grant_${accountId}`,
    tenantId: "tenant_firefly",
    accountId,
    access: {
      kind: "vehicle_project",
      brandId: project.brandId,
      vehicleId: project.vehicleId,
    },
    status: "active",
    revision: 1,
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_admin",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_admin",
  };
  return {
    tenantId: "tenant_firefly",
    actorAccountId: accountId,
    role: "creator",
    accessGrants: [grant],
  };
}

function runtime() {
  let sequence = 0;
  const store = new LocalAccountRunLockStore(".data/test-account-run-locks", false);
  return {
    store,
    runtime: new AccountRunLockRuntime(
      store,
      () => "2026-08-19T06:00:00.000Z",
      () => `run_lock_${++sequence}`,
    ),
  };
}

test("the same account cannot run a second high-cost video task", async () => {
  const { runtime: service } = runtime();
  const actor = session("account_creator_a");
  const first = await service.acquire(
    task("task_first", actor.actorAccountId),
    project,
    "video_generation",
    actor,
  );
  await assert.rejects(
    service.acquire(
      task("task_second", actor.actorAccountId),
      project,
      "automatic_editing",
      actor,
    ),
    (error: unknown) =>
      error instanceof AccountHighCostTaskRunningError && error.activeLock.id === first.id,
  );
});

test("different accounts can each run one high-cost task", async () => {
  const { runtime: service } = runtime();
  const accountA = session("account_creator_a");
  const accountB = session("account_creator_b");
  const [lockA, lockB] = await Promise.all([
    service.acquire(task("task_a", accountA.actorAccountId), project, "video_generation", accountA),
    service.acquire(task("task_b", accountB.actorAccountId), project, "video_generation", accountB),
  ]);
  assert.equal(lockA.accountId, "account_creator_a");
  assert.equal(lockB.accountId, "account_creator_b");
  assert.notEqual(lockA.id, lockB.id);
});

test("concurrent acquisition for one account creates exactly one lock", async () => {
  const { runtime: service } = runtime();
  const actor = session("account_creator_a");
  const outcomes = await Promise.allSettled([
    service.acquire(task("task_a", actor.actorAccountId), project, "video_generation", actor),
    service.acquire(task("task_b", actor.actorAccountId), project, "video_generation", actor),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof AccountHighCostTaskRunningError);
  const active = await service.loadForAccount("tenant_firefly", actor.actorAccountId);
  assert.ok(active);
  assert.equal(
    active.videoTaskId,
    outcomes.find((outcome) => outcome.status === "fulfilled")?.value.videoTaskId,
  );
});

test("only a current task owner with project access can acquire a run lock", async () => {
  const { runtime: service } = runtime();
  const actor = session("account_creator_a");
  await assert.rejects(
    service.acquire(task("task_other", "account_creator_b"), project, "video_generation", actor),
    WorkspaceAccessDeniedError,
  );
  assert.equal(await service.loadForAccount("tenant_firefly", actor.actorAccountId), undefined);
});

test("release opens the account slot and stale lock ids cannot clear a replacement", async () => {
  const { runtime: service } = runtime();
  const actor = session("account_creator_a");
  const first = await service.acquire(
    task("task_first", actor.actorAccountId),
    project,
    "video_generation",
    actor,
  );
  await service.release(first);
  const second = await service.acquire(
    task("task_second", actor.actorAccountId),
    project,
    "automatic_editing",
    actor,
  );
  await assert.rejects(service.release(first), AccountRunLockTokenMismatchError);
  assert.deepEqual(
    await service.loadForAccount("tenant_firefly", actor.actorAccountId),
    second,
  );
  await service.release(second);
  assert.equal(await service.loadForAccount("tenant_firefly", actor.actorAccountId), undefined);
});

test("active locks survive a local service restart until the operation releases them", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-account-run-lock-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const actor = session("account_creator_a");
  const firstRuntime = new AccountRunLockRuntime(
    new LocalAccountRunLockStore(directory),
    () => "2026-08-19T06:00:00.000Z",
    () => "run_lock_persisted",
  );
  const lock = await firstRuntime.acquire(
    task("task_persisted", actor.actorAccountId),
    project,
    "video_generation",
    actor,
  );
  const restoredRuntime = new AccountRunLockRuntime(new LocalAccountRunLockStore(directory));
  assert.deepEqual(
    await restoredRuntime.loadForAccount("tenant_firefly", actor.actorAccountId),
    lock,
  );
  await assert.rejects(
    restoredRuntime.acquire(
      task("task_blocked_after_restart", actor.actorAccountId),
      project,
      "video_generation",
      actor,
    ),
    AccountHighCostTaskRunningError,
  );
  await restoredRuntime.release(lock);
  assert.equal(
    await new LocalAccountRunLockStore(directory).load("tenant_firefly", actor.actorAccountId),
    undefined,
  );
});

test("HTTP boundary preserves the stable account-busy conflict code", () => {
  const activeLock = {
    id: "run_lock_busy",
    tenantId: "tenant_firefly",
    accountId: "account_creator_a",
    batchProjectId: project.id,
    videoTaskId: "task_busy",
    taskRevision: 8,
    operation: "video_generation" as const,
    acquiredAt: "2026-08-19T06:00:00.000Z",
  };
  const error = new AccountHighCostTaskRunningError(activeLock);
  assert.equal(error.code, "AIC-CONCURRENCY-ACCOUNT_HIGH_COST_TASK_RUNNING");
  assert.equal(errorStatus(error), 409);
});
