import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import {
  AccountBudgetSchema,
  HighCostOperationCostEstimateSchema,
  type AccountBudget,
  type HighCostOperationCostEstimate,
} from "../src/index.ts";

const estimate = {
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
} satisfies HighCostOperationCostEstimate;

const budget = {
  schemaVersion: 1,
  id: "budget_1",
  tenantId: "tenant_firefly",
  accountId: "account_creator",
  currency: "CNY",
  limitAmountMinor: 10_000,
  revision: 1,
  entries: [],
  createdAt: "2026-08-19T05:00:00.000Z",
  createdBy: "account_admin",
  updatedAt: "2026-08-19T05:00:00.000Z",
  updatedBy: "account_admin",
} satisfies AccountBudget;

test("cost estimates are server-bound, versioned, and use integer minor units", () => {
  assert.equal(Value.Check(HighCostOperationCostEstimateSchema, estimate), true);
  assert.equal(
    Value.Check(HighCostOperationCostEstimateSchema, { ...estimate, amountMinor: 25.5 }),
    false,
  );
  assert.equal(
    Value.Check(HighCostOperationCostEstimateSchema, { ...estimate, actorAccountId: "forged" }),
    false,
  );
  assert.equal(
    Value.Check(HighCostOperationCostEstimateSchema, { ...estimate, pricingVersion: "" }),
    false,
  );
});

test("account budgets persist strict reservation, charge, and release audit entries", () => {
  assert.equal(Value.Check(AccountBudgetSchema, budget), true);
  const withReservation = {
    ...budget,
    revision: 2,
    entries: [
      {
        id: "reservation_1",
        kind: "reservation",
        estimateId: estimate.id,
        tenantId: budget.tenantId,
        accountId: budget.accountId,
        batchProjectId: estimate.batchProjectId,
        videoTaskId: estimate.videoTaskId,
        taskRevision: estimate.taskRevision,
        operation: estimate.operation,
        amountMinor: estimate.amountMinor,
        currency: estimate.currency,
        occurredAt: "2026-08-19T06:01:00.000Z",
      },
    ],
  };
  assert.equal(Value.Check(AccountBudgetSchema, withReservation), true);
  assert.equal(
    Value.Check(AccountBudgetSchema, { ...withReservation, availableAmountMinor: 7_500 }),
    false,
  );
  assert.equal(
    Value.Check(AccountBudgetSchema, {
      ...withReservation,
      entries: [{ ...withReservation.entries[0], status: "charged" }],
    }),
    false,
  );
});
