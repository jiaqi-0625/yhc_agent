import type { WorkspaceSessionScope } from "@firefly/domain";
import type {
  BatchProject,
  HighCostTaskOperation,
  VideoTask,
} from "@firefly/schemas";

import {
  AccountBudgetRuntime,
  type HighCostOperationExecutionResult,
  type ReservedAccountBudget,
} from "./account-budget-runtime.ts";
import { AccountRunLockRuntime } from "./account-run-lock-runtime.ts";

export class HighCostOperationRuntime {
  constructor(
    private readonly runLocks: AccountRunLockRuntime,
    private readonly budgets: AccountBudgetRuntime,
  ) {}

  estimate(
    videoTask: Readonly<VideoTask>,
    project: Readonly<BatchProject>,
    operation: HighCostTaskOperation,
    session: Readonly<WorkspaceSessionScope>,
  ) {
    return this.budgets.estimate(videoTask, project, operation, session);
  }

  async execute<T>(
    videoTask: Readonly<VideoTask>,
    project: Readonly<BatchProject>,
    operation: HighCostTaskOperation,
    session: Readonly<WorkspaceSessionScope>,
    executeOperation: (
      authorization: Readonly<ReservedAccountBudget>,
    ) => Promise<HighCostOperationExecutionResult<T>>,
  ) {
    const lock = await this.runLocks.acquire(videoTask, project, operation, session);
    try {
      return await this.budgets.execute(
        videoTask,
        project,
        operation,
        session,
        executeOperation,
      );
    } finally {
      await this.runLocks.release(lock);
    }
  }
}
