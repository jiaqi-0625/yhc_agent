import type {
  AccountBudget,
  AccountBudgetChargeEntry,
  AccountBudgetReleaseEntry,
  AccountBudgetReleaseReason,
  AccountBudgetReservationEntry,
  CurrencyCode,
  HighCostOperationCostEstimate,
  HighCostTaskOperation,
  VideoTask,
} from "@firefly/schemas";

import { assertRevision } from "./workflow.ts";

export interface AccountBudgetBalance {
  limitAmountMinor: number;
  spentAmountMinor: number;
  reservedAmountMinor: number;
  availableAmountMinor: number;
  currency: CurrencyCode;
}

export interface BudgetMutationContext {
  actorAccountId: string;
  occurredAt: string;
  createId: (kind: "budget" | "estimate" | "reservation" | "charge" | "release") => string;
}

export type AccountBudgetErrorCode =
  | "AIC-COST-BUDGET_EXCEEDED"
  | "AIC-COST-BUDGET_SCOPE_INVALID"
  | "AIC-COST-CURRENCY_MISMATCH"
  | "AIC-COST-ESTIMATE_EXPIRED"
  | "AIC-COST-ESTIMATE_INVALID"
  | "AIC-COST-RESERVATION_NOT_FOUND"
  | "AIC-COST-RESERVATION_SETTLED"
  | "AIC-COST-ACTUAL_EXCEEDS_ESTIMATE"
  | "AIC-COST-BUDGET_LIMIT_TOO_LOW"
  | "AIC-COST-BUDGET_NOT_CONFIGURED"
  | "AIC-COST-BUDGET_ALREADY_CONFIGURED";

export class AccountBudgetError extends Error {
  constructor(
    readonly code: AccountBudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountBudgetError";
  }
}

export class AccountBudgetExceededError extends AccountBudgetError {
  readonly balance: AccountBudgetBalance;

  constructor(balance: Readonly<AccountBudgetBalance>, requestedAmountMinor: number) {
    super(
      "AIC-COST-BUDGET_EXCEEDED",
      `Available account budget ${balance.availableAmountMinor} ${balance.currency} minor units is below required ${requestedAmountMinor}.`,
    );
    this.name = "AccountBudgetExceededError";
    this.balance = structuredClone(balance);
  }
}

function assertMinorAmount(value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new AccountBudgetError(
      "AIC-COST-ESTIMATE_INVALID",
      "Cost amounts must use safe integer minor currency units.",
    );
  }
}

function activeReservations(
  budget: Readonly<AccountBudget>,
): Map<string, AccountBudgetReservationEntry> {
  const active = new Map<string, AccountBudgetReservationEntry>();
  const seenReservationIds = new Set<string>();
  for (const entry of budget.entries) {
    if (entry.tenantId !== budget.tenantId || entry.accountId !== budget.accountId) {
      throw new AccountBudgetError(
        "AIC-COST-BUDGET_SCOPE_INVALID",
        "A budget ledger entry is outside the account scope.",
      );
    }
    if (entry.kind === "reservation") {
      if (entry.currency !== budget.currency || seenReservationIds.has(entry.id)) {
        throw new AccountBudgetError(
          "AIC-COST-BUDGET_SCOPE_INVALID",
          "A budget reservation has an invalid currency or duplicate identity.",
        );
      }
      seenReservationIds.add(entry.id);
      active.set(entry.id, structuredClone(entry));
      continue;
    }
    const reservation = active.get(entry.reservationId);
    if (!reservation) {
      throw new AccountBudgetError(
        "AIC-COST-RESERVATION_SETTLED",
        "A budget reservation was settled more than once or out of order.",
      );
    }
    if (entry.kind === "charge" && entry.currency !== budget.currency) {
      throw new AccountBudgetError(
        "AIC-COST-CURRENCY_MISMATCH",
        "A budget charge currency does not match the account budget.",
      );
    }
    if (entry.kind === "charge" && entry.amountMinor > reservation.amountMinor) {
      throw new AccountBudgetError(
        "AIC-COST-ACTUAL_EXCEEDS_ESTIMATE",
        "A persisted charge exceeds its reserved estimate.",
      );
    }
    active.delete(entry.reservationId);
  }
  return active;
}

export function calculateAccountBudgetBalance(
  budget: Readonly<AccountBudget>,
): AccountBudgetBalance {
  const active = activeReservations(budget);
  const spentAmountMinor = budget.entries.reduce(
    (total, entry) => total + (entry.kind === "charge" ? entry.amountMinor : 0),
    0,
  );
  const reservedAmountMinor = [...active.values()].reduce(
    (total, entry) => total + entry.amountMinor,
    0,
  );
  return {
    limitAmountMinor: budget.limitAmountMinor,
    spentAmountMinor,
    reservedAmountMinor,
    availableAmountMinor: budget.limitAmountMinor - spentAmountMinor - reservedAmountMinor,
    currency: budget.currency,
  };
}

export function createAccountBudget(
  input: Readonly<{
    tenantId: string;
    accountId: string;
    currency: CurrencyCode;
    limitAmountMinor: number;
  }>,
  context: Readonly<BudgetMutationContext>,
): AccountBudget {
  assertMinorAmount(input.limitAmountMinor, true);
  if (!/^[A-Z]{3}$/u.test(input.currency)) {
    throw new AccountBudgetError("AIC-COST-CURRENCY_MISMATCH", "Invalid budget currency.");
  }
  return {
    schemaVersion: 1,
    id: context.createId("budget"),
    tenantId: input.tenantId,
    accountId: input.accountId,
    currency: input.currency,
    limitAmountMinor: input.limitAmountMinor,
    revision: 1,
    entries: [],
    createdAt: context.occurredAt,
    createdBy: context.actorAccountId,
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}

export function updateAccountBudgetLimit(
  budget: Readonly<AccountBudget>,
  expectedRevision: number,
  limitAmountMinor: number,
  context: Readonly<BudgetMutationContext>,
): AccountBudget {
  assertRevision(expectedRevision, budget.revision);
  assertMinorAmount(limitAmountMinor, true);
  const balance = calculateAccountBudgetBalance(budget);
  if (limitAmountMinor < balance.spentAmountMinor + balance.reservedAmountMinor) {
    throw new AccountBudgetError(
      "AIC-COST-BUDGET_LIMIT_TOO_LOW",
      "The budget limit cannot be lower than already spent and reserved amounts.",
    );
  }
  return {
    ...structuredClone(budget),
    limitAmountMinor,
    revision: budget.revision + 1,
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}

export function createHighCostOperationCostEstimate(
  videoTask: Readonly<VideoTask>,
  operation: HighCostTaskOperation,
  pricing: Readonly<{
    amountMinor: number;
    currency: CurrencyCode;
    pricingVersion: string;
    expiresAt: string;
  }>,
  context: Readonly<BudgetMutationContext>,
): HighCostOperationCostEstimate {
  assertMinorAmount(pricing.amountMinor);
  if (videoTask.ownerAccountId !== context.actorAccountId || videoTask.status !== "active") {
    throw new AccountBudgetError(
      "AIC-COST-BUDGET_SCOPE_INVALID",
      "Only the active task owner can receive an execution cost estimate.",
    );
  }
  if (
    operation !== "video_generation" &&
    operation !== "automatic_editing"
  ) {
    throw new AccountBudgetError(
      "AIC-COST-ESTIMATE_INVALID",
      "The operation does not require a high-cost estimate.",
    );
  }
  if (
    !/^[A-Z]{3}$/u.test(pricing.currency) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(pricing.pricingVersion) ||
    !Number.isFinite(Date.parse(pricing.expiresAt)) ||
    Date.parse(pricing.expiresAt) <= Date.parse(context.occurredAt)
  ) {
    throw new AccountBudgetError(
      "AIC-COST-ESTIMATE_INVALID",
      "The server pricing result is invalid or already expired.",
    );
  }
  return {
    id: context.createId("estimate"),
    tenantId: videoTask.tenantId,
    accountId: context.actorAccountId,
    batchProjectId: videoTask.batchProjectId,
    videoTaskId: videoTask.id,
    taskRevision: videoTask.revision,
    operation,
    amountMinor: pricing.amountMinor,
    currency: pricing.currency,
    pricingVersion: pricing.pricingVersion,
    estimatedAt: context.occurredAt,
    expiresAt: pricing.expiresAt,
  };
}

export function reserveAccountBudget(
  budget: Readonly<AccountBudget>,
  estimate: Readonly<HighCostOperationCostEstimate>,
  context: Readonly<BudgetMutationContext>,
): { budget: AccountBudget; reservation: AccountBudgetReservationEntry } {
  assertMinorAmount(estimate.amountMinor);
  if (budget.tenantId !== estimate.tenantId || budget.accountId !== estimate.accountId) {
    throw new AccountBudgetError(
      "AIC-COST-BUDGET_SCOPE_INVALID",
      "The estimate does not belong to this account budget.",
    );
  }
  if (budget.currency !== estimate.currency) {
    throw new AccountBudgetError(
      "AIC-COST-CURRENCY_MISMATCH",
      "The estimate currency does not match the account budget.",
    );
  }
  if (Date.parse(estimate.expiresAt) <= Date.parse(context.occurredAt)) {
    throw new AccountBudgetError(
      "AIC-COST-ESTIMATE_EXPIRED",
      "The cost estimate expired before execution.",
    );
  }
  if (
    budget.entries.some(
      (entry) => entry.kind === "reservation" && entry.estimateId === estimate.id,
    )
  ) {
    throw new AccountBudgetError(
      "AIC-COST-RESERVATION_SETTLED",
      "The cost estimate has already been reserved.",
    );
  }
  const balance = calculateAccountBudgetBalance(budget);
  if (balance.availableAmountMinor < estimate.amountMinor) {
    throw new AccountBudgetExceededError(balance, estimate.amountMinor);
  }
  const reservation: AccountBudgetReservationEntry = {
    id: context.createId("reservation"),
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
    occurredAt: context.occurredAt,
  };
  return {
    budget: {
      ...structuredClone(budget),
      revision: budget.revision + 1,
      entries: [...structuredClone(budget.entries), reservation],
      updatedAt: context.occurredAt,
      updatedBy: context.actorAccountId,
    },
    reservation,
  };
}

function findActiveReservation(
  budget: Readonly<AccountBudget>,
  reservationId: string,
): AccountBudgetReservationEntry {
  const reservation = activeReservations(budget).get(reservationId);
  if (reservation) return reservation;
  const existed = budget.entries.some(
    (entry) => entry.kind === "reservation" && entry.id === reservationId,
  );
  throw new AccountBudgetError(
    existed ? "AIC-COST-RESERVATION_SETTLED" : "AIC-COST-RESERVATION_NOT_FOUND",
    existed ? "The budget reservation is already settled." : "The budget reservation was not found.",
  );
}

export function chargeAccountBudgetReservation(
  budget: Readonly<AccountBudget>,
  reservationId: string,
  actualAmountMinor: number,
  operationResultId: string,
  context: Readonly<BudgetMutationContext>,
): AccountBudget {
  assertMinorAmount(actualAmountMinor, true);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(operationResultId)) {
    throw new AccountBudgetError(
      "AIC-COST-BUDGET_SCOPE_INVALID",
      "The operation result identity is invalid.",
    );
  }
  const reservation = findActiveReservation(budget, reservationId);
  if (actualAmountMinor > reservation.amountMinor) {
    throw new AccountBudgetError(
      "AIC-COST-ACTUAL_EXCEEDS_ESTIMATE",
      "The actual charge exceeds the server estimate reserved before execution.",
    );
  }
  const charge: AccountBudgetChargeEntry = {
    id: context.createId("charge"),
    kind: "charge",
    tenantId: budget.tenantId,
    accountId: budget.accountId,
    reservationId,
    amountMinor: actualAmountMinor,
    currency: budget.currency,
    operationResultId,
    occurredAt: context.occurredAt,
  };
  return {
    ...structuredClone(budget),
    revision: budget.revision + 1,
    entries: [...structuredClone(budget.entries), charge],
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}

export function releaseAccountBudgetReservation(
  budget: Readonly<AccountBudget>,
  reservationId: string,
  reason: AccountBudgetReleaseReason,
  failureCode: string | undefined,
  context: Readonly<BudgetMutationContext>,
): AccountBudget {
  if (
    !["operation_failed", "operation_cancelled", "reservation_expired"].includes(reason) ||
    (failureCode !== undefined && (failureCode.length < 1 || failureCode.length > 200))
  ) {
    throw new AccountBudgetError(
      "AIC-COST-BUDGET_SCOPE_INVALID",
      "The budget release reason or failure code is invalid.",
    );
  }
  findActiveReservation(budget, reservationId);
  const release: AccountBudgetReleaseEntry = {
    id: context.createId("release"),
    kind: "release",
    tenantId: budget.tenantId,
    accountId: budget.accountId,
    reservationId,
    reason,
    ...(failureCode === undefined ? {} : { failureCode }),
    occurredAt: context.occurredAt,
  };
  return {
    ...structuredClone(budget),
    revision: budget.revision + 1,
    entries: [...structuredClone(budget.entries), release],
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}
