import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AccountBudgetError,
  AccountBudgetExceededError,
  WorkspaceAccessDeniedError,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type { BatchProject, VideoTask, WorkspaceAccessGrant } from "@firefly/schemas";

import {
  AccountBudgetRuntime,
  type HighCostPricingProvider,
} from "../src/account-budget-runtime.ts";
import { LocalAccountBudgetStore } from "../src/account-budget-store.ts";
import { AccountRunLockRuntime } from "../src/account-run-lock-runtime.ts";
import { LocalAccountRunLockStore } from "../src/account-run-lock-store.ts";
import { HighCostOperationRuntime } from "../src/high-cost-operation-runtime.ts";
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
  createdBy: "account_creator",
  updatedAt: "2026-08-19T00:00:00.000Z",
  updatedBy: "account_creator",
};

function task(id = "task_preview", ownerAccountId = "account_creator"): VideoTask {
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

function creatorSession(accountId = "account_creator"): WorkspaceSessionScope {
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

const adminSession: WorkspaceSessionScope = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_admin",
  role: "content_admin",
  accessGrants: [],
};

class MutablePricing implements HighCostPricingProvider {
  amountMinor = 2_500;
  calls = 0;

  async estimate(_videoTask: Readonly<VideoTask>, operation: "video_generation" | "automatic_editing", estimatedAt: string) {
    this.calls += 1;
    return {
      amountMinor: this.amountMinor,
      currency: "CNY" as const,
      pricingVersion: `${operation}_mock_v1`,
      expiresAt: new Date(Date.parse(estimatedAt) + 15 * 60 * 1000).toISOString(),
    };
  }
}

function createRuntime(store = new LocalAccountBudgetStore(".data/test-account-budgets", false)) {
  const pricing = new MutablePricing();
  let sequence = 0;
  const runtime = new AccountBudgetRuntime(
    store,
    pricing,
    () => "2026-08-19T06:00:00.000Z",
    (kind) => `${kind}_${++sequence}`,
  );
  return { runtime, pricing, store };
}

async function configure(runtime: AccountBudgetRuntime, limitAmountMinor = 10_000) {
  return runtime.createForAccount(
    "account_creator",
    "CNY",
    limitAmountMinor,
    adminSession,
  );
}

test("only an administrator configures account budgets and updates use revisions", async () => {
  const { runtime } = createRuntime();
  await assert.rejects(
    runtime.createForAccount("account_creator", "CNY", 10_000, creatorSession()),
    WorkspaceAccessDeniedError,
  );
  const created = await configure(runtime);
  assert.equal(created.limitAmountMinor, 10_000);
  await assert.rejects(
    runtime.createForAccount("account_creator", "CNY", 20_000, adminSession),
    (error: unknown) =>
      error instanceof AccountBudgetError && error.code === "AIC-COST-BUDGET_ALREADY_CONFIGURED",
  );
  const updated = await runtime.updateLimit("account_creator", created.revision, 20_000, adminSession);
  assert.equal(updated.limitAmountMinor, 20_000);
  assert.equal(updated.revision, 2);
});

test("execution recalculates server pricing instead of trusting the displayed estimate", async () => {
  const { runtime, pricing } = createRuntime();
  await configure(runtime);
  const actor = creatorSession();
  const displayed = await runtime.estimate(task(), project, "video_generation", actor);
  assert.equal(displayed.amountMinor, 2_500);
  pricing.amountMinor = 3_000;
  const reserved = await runtime.reserveForOperation(task(), project, "video_generation", actor);
  assert.equal(pricing.calls, 2);
  assert.equal(reserved.estimate.amountMinor, 3_000);
  assert.equal(reserved.reservation.amountMinor, 3_000);
  assert.equal(reserved.balance.availableAmountMinor, 7_000);
});

test("insufficient quota is rejected by the backend before operation execution", async () => {
  const { runtime } = createRuntime();
  await configure(runtime, 2_499);
  let executed = false;
  await assert.rejects(
    runtime.execute(task(), project, "video_generation", creatorSession(), async () => {
      executed = true;
      return { value: "unexpected", operationResultId: "job_1", actualAmountMinor: 2_000 };
    }),
    AccountBudgetExceededError,
  );
  assert.equal(executed, false);
  assert.deepEqual(await runtime.loadBalance("tenant_firefly", "account_creator"), {
    limitAmountMinor: 2_499,
    spentAmountMinor: 0,
    reservedAmountMinor: 0,
    availableAmountMinor: 2_499,
    currency: "CNY",
  });
});

test("successful operation charges actual cost and releases unused estimate", async () => {
  const { runtime } = createRuntime();
  await configure(runtime);
  const result = await runtime.execute(
    task(),
    project,
    "video_generation",
    creatorSession(),
    async (authorization) => {
      assert.equal(authorization.estimate.amountMinor, 2_500);
      assert.equal(authorization.balance.reservedAmountMinor, 2_500);
      return { value: "preview.mp4", operationResultId: "video_job_1", actualAmountMinor: 2_100 };
    },
  );
  assert.equal(result.value, "preview.mp4");
  assert.equal(result.balance.spentAmountMinor, 2_100);
  assert.equal(result.balance.reservedAmountMinor, 0);
  assert.equal(result.balance.availableAmountMinor, 7_900);
});

test("failed operation releases reservation and never charges the account", async () => {
  const { runtime, store } = createRuntime();
  await configure(runtime);
  const providerError = Object.assign(new Error("mock provider failed"), {
    code: "MOCK_PROVIDER_FAILED",
  });
  await assert.rejects(
    runtime.execute(task(), project, "video_generation", creatorSession(), async () => {
      throw providerError;
    }),
    providerError,
  );
  assert.deepEqual(await runtime.loadBalance("tenant_firefly", "account_creator"), {
    limitAmountMinor: 10_000,
    spentAmountMinor: 0,
    reservedAmountMinor: 0,
    availableAmountMinor: 10_000,
    currency: "CNY",
  });
  const persisted = await store.load("tenant_firefly", "account_creator");
  const lastEntry = persisted?.entries.at(-1);
  assert.equal(lastEntry?.kind, "release");
  assert.equal(lastEntry?.kind === "release" ? lastEntry.failureCode : undefined, "MOCK_PROVIDER_FAILED");
});

test("concurrent reservations cannot overspend one account quota", async () => {
  const { runtime, pricing } = createRuntime();
  pricing.amountMinor = 2_000;
  await configure(runtime, 3_000);
  const actor = creatorSession();
  const outcomes = await Promise.allSettled([
    runtime.reserveForOperation(task("task_a"), project, "video_generation", actor),
    runtime.reserveForOperation(task("task_b"), project, "video_generation", actor),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof AccountBudgetExceededError);
  assert.equal(
    (await runtime.loadBalance("tenant_firefly", "account_creator"))?.reservedAmountMinor,
    2_000,
  );
});

test("high-cost execution releases both budget reservation and account run lock on failure", async () => {
  const { runtime: budgets } = createRuntime();
  await configure(budgets);
  const runLocks = new AccountRunLockRuntime(
    new LocalAccountRunLockStore(".data/test-budget-run-locks", false),
    () => "2026-08-19T06:00:00.000Z",
    () => "run_lock_budget_test",
  );
  const operations = new HighCostOperationRuntime(runLocks, budgets);
  const actor = creatorSession();
  await assert.rejects(
    operations.execute(task(), project, "video_generation", actor, async () => {
      assert.ok(await runLocks.loadForAccount("tenant_firefly", "account_creator"));
      assert.equal(
        (await budgets.loadBalance("tenant_firefly", "account_creator"))?.reservedAmountMinor,
        2_500,
      );
      throw new Error("render failed");
    }),
    /render failed/u,
  );
  assert.equal(await runLocks.loadForAccount("tenant_firefly", "account_creator"), undefined);
  assert.deepEqual(await budgets.loadBalance("tenant_firefly", "account_creator"), {
    limitAmountMinor: 10_000,
    spentAmountMinor: 0,
    reservedAmountMinor: 0,
    availableAmountMinor: 10_000,
    currency: "CNY",
  });
});

test("high-cost execution charges success and releases the account run lock", async () => {
  const { runtime: budgets } = createRuntime();
  await configure(budgets);
  const runLocks = new AccountRunLockRuntime(
    new LocalAccountRunLockStore(".data/test-budget-success-locks", false),
    () => "2026-08-19T06:00:00.000Z",
    () => "run_lock_budget_success",
  );
  const operations = new HighCostOperationRuntime(runLocks, budgets);
  const result = await operations.execute(
    task(),
    project,
    "video_generation",
    creatorSession(),
    async () => ({
      value: "preview.mp4",
      operationResultId: "video_job_success",
      actualAmountMinor: 2_000,
    }),
  );
  assert.equal(result.balance.spentAmountMinor, 2_000);
  assert.equal(result.balance.reservedAmountMinor, 0);
  assert.equal(await runLocks.loadForAccount("tenant_firefly", "account_creator"), undefined);
});

test("budget ledger and available balance survive a local service restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-account-budget-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const first = createRuntime(new LocalAccountBudgetStore(directory));
  await configure(first.runtime);
  await first.runtime.reserveForOperation(task(), project, "video_generation", creatorSession());
  const restored = createRuntime(new LocalAccountBudgetStore(directory));
  assert.deepEqual(await restored.runtime.loadBalance("tenant_firefly", "account_creator"), {
    limitAmountMinor: 10_000,
    spentAmountMinor: 0,
    reservedAmountMinor: 2_500,
    availableAmountMinor: 7_500,
    currency: "CNY",
  });
});

test("HTTP boundary preserves stable budget rejection codes", () => {
  const error = new AccountBudgetExceededError(
    {
      limitAmountMinor: 2_499,
      spentAmountMinor: 0,
      reservedAmountMinor: 0,
      availableAmountMinor: 2_499,
      currency: "CNY",
    },
    2_500,
  );
  assert.equal(error.code, "AIC-COST-BUDGET_EXCEEDED");
  assert.equal(errorStatus(error), 409);
});
