import { randomUUID } from "node:crypto";

import {
  AccountBudgetError,
  assertCanOperateVideoTask,
  calculateAccountBudgetBalance,
  chargeAccountBudgetReservation,
  createAccountBudget,
  createHighCostOperationCostEstimate,
  releaseAccountBudgetReservation,
  reserveAccountBudget,
  updateAccountBudgetLimit,
  WorkspaceAccessDeniedError,
  type AccountBudgetBalance,
  type BudgetMutationContext,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  AccountBudget,
  AccountBudgetReleaseReason,
  AccountBudgetReservationEntry,
  BatchProject,
  CurrencyCode,
  HighCostOperationCostEstimate,
  HighCostTaskOperation,
  VideoTask,
} from "@firefly/schemas";

import type { AccountBudgetStore } from "./account-budget-store.ts";

export interface HighCostPricingQuote {
  amountMinor: number;
  currency: CurrencyCode;
  pricingVersion: string;
  expiresAt: string;
}

export interface HighCostPricingProvider {
  estimate(
    videoTask: Readonly<VideoTask>,
    operation: HighCostTaskOperation,
    estimatedAt: string,
  ): Promise<HighCostPricingQuote>;
}

export interface ReservedAccountBudget {
  estimate: HighCostOperationCostEstimate;
  reservation: AccountBudgetReservationEntry;
  balance: AccountBudgetBalance;
}

export interface AccountBudgetAdministrationView {
  budget: AccountBudget;
  balance: AccountBudgetBalance;
}

export interface HighCostOperationExecutionResult<T> {
  value: T;
  operationResultId: string;
  actualAmountMinor: number;
}

export class AccountBudgetRuntime {
  constructor(
    private readonly store: AccountBudgetStore,
    private readonly pricing: HighCostPricingProvider,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: BudgetMutationContext["createId"] = (kind) =>
      `${kind}_${randomUUID()}`,
  ) {}

  #context(actorAccountId: string, occurredAt = this.now()): BudgetMutationContext {
    return { actorAccountId, occurredAt, createId: this.createId };
  }

  #assertAdministrator(session: Readonly<WorkspaceSessionScope>): void {
    if (session.role !== "content_admin") {
      throw new WorkspaceAccessDeniedError(
        "AIC-AUTH-ROLE_DENIED",
        "Only a content administrator can configure account budgets.",
      );
    }
  }

  async createForAccount(
    accountId: string,
    currency: CurrencyCode,
    limitAmountMinor: number,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<AccountBudget> {
    this.#assertAdministrator(session);
    return this.store.transact(session.tenantId, accountId, (current) => {
      if (current) {
        throw new AccountBudgetError(
          "AIC-COST-BUDGET_ALREADY_CONFIGURED",
          "The account budget is already configured.",
        );
      }
      return createAccountBudget(
        { tenantId: session.tenantId, accountId, currency, limitAmountMinor },
        this.#context(session.actorAccountId),
      );
    });
  }

  async updateLimit(
    accountId: string,
    expectedRevision: number,
    limitAmountMinor: number,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<AccountBudget> {
    this.#assertAdministrator(session);
    return this.store.transact(session.tenantId, accountId, (current) => {
      if (!current) {
        throw new AccountBudgetError(
          "AIC-COST-BUDGET_NOT_CONFIGURED",
          "The account budget is not configured.",
        );
      }
      return updateAccountBudgetLimit(
        current,
        expectedRevision,
        limitAmountMinor,
        this.#context(session.actorAccountId),
      );
    });
  }

  async estimate(
    videoTask: Readonly<VideoTask>,
    project: Readonly<BatchProject>,
    operation: HighCostTaskOperation,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<HighCostOperationCostEstimate> {
    assertCanOperateVideoTask(session, project, videoTask);
    const estimatedAt = this.now();
    const pricing = await this.pricing.estimate(videoTask, operation, estimatedAt);
    return createHighCostOperationCostEstimate(
      videoTask,
      operation,
      pricing,
      this.#context(session.actorAccountId, estimatedAt),
    );
  }

  async reserveForOperation(
    videoTask: Readonly<VideoTask>,
    project: Readonly<BatchProject>,
    operation: HighCostTaskOperation,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ReservedAccountBudget> {
    const estimate = await this.estimate(videoTask, project, operation, session);
    let reservation: AccountBudgetReservationEntry | undefined;
    const budget = await this.store.transact(
      session.tenantId,
      session.actorAccountId,
      (current) => {
        if (!current) {
          throw new AccountBudgetError(
            "AIC-COST-BUDGET_NOT_CONFIGURED",
            "The account budget is not configured.",
          );
        }
        const result = reserveAccountBudget(
          current,
          estimate,
          this.#context(session.actorAccountId),
        );
        reservation = result.reservation;
        return result.budget;
      },
    );
    if (!reservation) throw new Error("Budget reservation transaction returned no reservation.");
    return { estimate, reservation, balance: calculateAccountBudgetBalance(budget) };
  }

  async charge(
    reservation: Readonly<AccountBudgetReservationEntry>,
    actualAmountMinor: number,
    operationResultId: string,
  ): Promise<AccountBudgetBalance> {
    const budget = await this.store.transact(
      reservation.tenantId,
      reservation.accountId,
      (current) => {
        if (!current) {
          throw new AccountBudgetError(
            "AIC-COST-BUDGET_NOT_CONFIGURED",
            "The account budget disappeared before settlement.",
          );
        }
        return chargeAccountBudgetReservation(
          current,
          reservation.id,
          actualAmountMinor,
          operationResultId,
          this.#context(reservation.accountId),
        );
      },
    );
    return calculateAccountBudgetBalance(budget);
  }

  async release(
    reservation: Readonly<AccountBudgetReservationEntry>,
    reason: AccountBudgetReleaseReason,
    failureCode?: string,
  ): Promise<AccountBudgetBalance> {
    const budget = await this.store.transact(
      reservation.tenantId,
      reservation.accountId,
      (current) => {
        if (!current) {
          throw new AccountBudgetError(
            "AIC-COST-BUDGET_NOT_CONFIGURED",
            "The account budget disappeared before release.",
          );
        }
        return releaseAccountBudgetReservation(
          current,
          reservation.id,
          reason,
          failureCode,
          this.#context(reservation.accountId),
        );
      },
    );
    return calculateAccountBudgetBalance(budget);
  }

  async execute<T>(
    videoTask: Readonly<VideoTask>,
    project: Readonly<BatchProject>,
    operation: HighCostTaskOperation,
    session: Readonly<WorkspaceSessionScope>,
    executeOperation: (
      authorization: Readonly<ReservedAccountBudget>,
    ) => Promise<HighCostOperationExecutionResult<T>>,
  ): Promise<HighCostOperationExecutionResult<T> & { balance: AccountBudgetBalance }> {
    const authorization = await this.reserveForOperation(videoTask, project, operation, session);
    let result: HighCostOperationExecutionResult<T>;
    try {
      result = await executeOperation(authorization);
    } catch (error: unknown) {
      const failureCode =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.length > 0
          ? error.code.slice(0, 200)
          : "OPERATION_FAILED";
      await this.release(authorization.reservation, "operation_failed", failureCode);
      throw error;
    }
    const balance = await this.charge(
      authorization.reservation,
      result.actualAmountMinor,
      result.operationResultId,
    );
    return { ...result, balance };
  }

  async loadBalance(tenantId: string, accountId: string): Promise<AccountBudgetBalance | undefined> {
    const budget = await this.store.load(tenantId, accountId);
    return budget ? calculateAccountBudgetBalance(budget) : undefined;
  }

  async loadForAdministration(
    accountId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<AccountBudgetAdministrationView | undefined> {
    this.#assertAdministrator(session);
    const budget = await this.store.load(session.tenantId, accountId);
    return budget
      ? { budget, balance: calculateAccountBudgetBalance(budget) }
      : undefined;
  }

  async loadForSession(
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<AccountBudgetAdministrationView | undefined> {
    const budget = await this.store.load(session.tenantId, session.actorAccountId);
    return budget
      ? { budget, balance: calculateAccountBudgetBalance(budget) }
      : undefined;
  }
}
