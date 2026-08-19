import assert from "node:assert/strict";
import test from "node:test";

import type { AccountBudget, VideoTask } from "@firefly/schemas";

import {
  AccountBudgetError,
  AccountBudgetExceededError,
  RevisionConflictError,
  calculateAccountBudgetBalance,
  chargeAccountBudgetReservation,
  createAccountBudget,
  createHighCostOperationCostEstimate,
  releaseAccountBudgetReservation,
  reserveAccountBudget,
  updateAccountBudgetLimit,
  type BudgetMutationContext,
} from "../src/index.ts";

function task(accountId = "account_creator"): VideoTask {
  return {
    id: "task_preview",
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    name: "预览生成任务",
    ownerAccountId: accountId,
    status: "active",
    currentStage: "video_preview",
    stageStatus: "in_progress",
    revision: 8,
    audience: "家庭用户",
    theme: "周末出行",
    durationSeconds: 30,
    platformTags: ["douyin"],
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: accountId,
    updatedAt: "2026-08-19T05:00:00.000Z",
    updatedBy: accountId,
  };
}

function context(actorAccountId = "account_creator", occurredAt = "2026-08-19T06:00:00.000Z") {
  let sequence = 0;
  return {
    actorAccountId,
    occurredAt,
    createId: (kind) => `${kind}_${++sequence}`,
  } satisfies BudgetMutationContext;
}

function budget(limitAmountMinor = 10_000): AccountBudget {
  return createAccountBudget(
    {
      tenantId: "tenant_firefly",
      accountId: "account_creator",
      currency: "CNY",
      limitAmountMinor,
    },
    context("account_admin", "2026-08-19T05:00:00.000Z"),
  );
}

function estimate(estimateContext = context()) {
  return createHighCostOperationCostEstimate(
    task(),
    "video_generation",
    {
      amountMinor: 2_500,
      currency: "CNY",
      pricingVersion: "mock_video_v1",
      expiresAt: "2026-08-19T06:15:00.000Z",
    },
    estimateContext,
  );
}

test("server cost estimates bind account, task revision, price version, and expiry", () => {
  const result = estimate();
  assert.deepEqual(result, {
    id: "estimate_1",
    tenantId: "tenant_firefly",
    accountId: "account_creator",
    batchProjectId: "project_launch",
    videoTaskId: "task_preview",
    taskRevision: 8,
    operation: "video_generation",
    amountMinor: 2_500,
    currency: "CNY",
    pricingVersion: "mock_video_v1",
    estimatedAt: "2026-08-19T06:00:00.000Z",
    expiresAt: "2026-08-19T06:15:00.000Z",
  });
});

test("reservation blocks estimated cost and successful settlement charges only actual cost", () => {
  const source = budget();
  const reserved = reserveAccountBudget(source, estimate(), context());
  assert.deepEqual(calculateAccountBudgetBalance(reserved.budget), {
    limitAmountMinor: 10_000,
    spentAmountMinor: 0,
    reservedAmountMinor: 2_500,
    availableAmountMinor: 7_500,
    currency: "CNY",
  });
  const charged = chargeAccountBudgetReservation(
    reserved.budget,
    reserved.reservation.id,
    2_100,
    "video_job_1",
    context("account_creator", "2026-08-19T06:10:00.000Z"),
  );
  assert.deepEqual(calculateAccountBudgetBalance(charged), {
    limitAmountMinor: 10_000,
    spentAmountMinor: 2_100,
    reservedAmountMinor: 0,
    availableAmountMinor: 7_900,
    currency: "CNY",
  });
  assert.deepEqual(source.entries, []);
});

test("failed operations release the full reservation without charging the account", () => {
  const reserved = reserveAccountBudget(budget(), estimate(), context());
  const released = releaseAccountBudgetReservation(
    reserved.budget,
    reserved.reservation.id,
    "operation_failed",
    "MOCK_PROVIDER_FAILED",
    context("account_creator", "2026-08-19T06:05:00.000Z"),
  );
  assert.deepEqual(calculateAccountBudgetBalance(released), {
    limitAmountMinor: 10_000,
    spentAmountMinor: 0,
    reservedAmountMinor: 0,
    availableAmountMinor: 10_000,
    currency: "CNY",
  });
  assert.equal(released.entries.at(-1)?.kind, "release");
});

test("insufficient available budget rejects reservation without partial mutation", () => {
  const source = budget(2_499);
  assert.throws(
    () => reserveAccountBudget(source, estimate(), context()),
    (error: unknown) =>
      error instanceof AccountBudgetExceededError &&
      error.code === "AIC-COST-BUDGET_EXCEEDED" &&
      error.balance.availableAmountMinor === 2_499,
  );
  assert.equal(source.revision, 1);
  assert.deepEqual(source.entries, []);
});

test("expired, cross-account, and wrong-currency estimates are rejected", () => {
  const source = budget();
  assert.throws(
    () =>
      reserveAccountBudget(
        source,
        estimate(),
        context("account_creator", "2026-08-19T06:15:00.000Z"),
      ),
    (error: unknown) => error instanceof AccountBudgetError && error.code === "AIC-COST-ESTIMATE_EXPIRED",
  );
  assert.throws(
    () => reserveAccountBudget(source, { ...estimate(), accountId: "account_other" }, context()),
    (error: unknown) =>
      error instanceof AccountBudgetError && error.code === "AIC-COST-BUDGET_SCOPE_INVALID",
  );
  assert.throws(
    () => reserveAccountBudget(source, { ...estimate(), currency: "USD" }, context()),
    (error: unknown) => error instanceof AccountBudgetError && error.code === "AIC-COST-CURRENCY_MISMATCH",
  );
});

test("actual charges cannot exceed estimates and reservations settle only once", () => {
  const reserved = reserveAccountBudget(budget(), estimate(), context());
  assert.throws(
    () =>
      chargeAccountBudgetReservation(
        reserved.budget,
        reserved.reservation.id,
        2_501,
        "video_job_1",
        context(),
      ),
    (error: unknown) =>
      error instanceof AccountBudgetError && error.code === "AIC-COST-ACTUAL_EXCEEDS_ESTIMATE",
  );
  const charged = chargeAccountBudgetReservation(
    reserved.budget,
    reserved.reservation.id,
    2_500,
    "video_job_1",
    context(),
  );
  assert.throws(
    () =>
      releaseAccountBudgetReservation(
        charged,
        reserved.reservation.id,
        "operation_failed",
        undefined,
        context(),
      ),
    (error: unknown) =>
      error instanceof AccountBudgetError && error.code === "AIC-COST-RESERVATION_SETTLED",
  );
});

test("budget limit changes use revision checks and cannot undercut committed amounts", () => {
  const source = budget();
  assert.throws(
    () => updateAccountBudgetLimit(source, 2, 20_000, context("account_admin")),
    RevisionConflictError,
  );
  const reserved = reserveAccountBudget(source, estimate(), context());
  assert.throws(
    () => updateAccountBudgetLimit(reserved.budget, 2, 2_499, context("account_admin")),
    (error: unknown) =>
      error instanceof AccountBudgetError && error.code === "AIC-COST-BUDGET_LIMIT_TOO_LOW",
  );
  const raised = updateAccountBudgetLimit(
    reserved.budget,
    2,
    20_000,
    context("account_admin"),
  );
  assert.equal(raised.limitAmountMinor, 20_000);
  assert.equal(raised.revision, 3);
});
