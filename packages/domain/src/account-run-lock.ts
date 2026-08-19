import type {
  AccountHighCostTaskRunLock,
  HighCostTaskOperation,
  VideoTask,
} from "@firefly/schemas";

export interface AcquireAccountRunLockContext {
  tenantId: string;
  actorAccountId: string;
  occurredAt: string;
  createId: () => string;
}

export class AccountHighCostTaskRunningError extends Error {
  readonly code = "AIC-CONCURRENCY-ACCOUNT_HIGH_COST_TASK_RUNNING";
  readonly activeLock: AccountHighCostTaskRunLock;

  constructor(activeLock: Readonly<AccountHighCostTaskRunLock>) {
    super(
      `Account '${activeLock.accountId}' is already running high-cost task '${activeLock.videoTaskId}'.`,
    );
    this.name = "AccountHighCostTaskRunningError";
    this.activeLock = structuredClone(activeLock);
  }
}

export class AccountRunLockTokenMismatchError extends Error {
  readonly code = "AIC-CONCURRENCY-RUN_LOCK_TOKEN_MISMATCH";

  constructor() {
    super("The high-cost task run lock is no longer owned by this operation.");
    this.name = "AccountRunLockTokenMismatchError";
  }
}

export class AccountRunLockDeniedError extends Error {
  readonly code = "AIC-CONCURRENCY-RUN_LOCK_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "AccountRunLockDeniedError";
  }
}

export function acquireAccountHighCostTaskRunLock(
  current: Readonly<AccountHighCostTaskRunLock> | undefined,
  videoTask: Readonly<VideoTask>,
  operation: HighCostTaskOperation,
  context: Readonly<AcquireAccountRunLockContext>,
): AccountHighCostTaskRunLock {
  if (videoTask.tenantId !== context.tenantId) {
    throw new AccountRunLockDeniedError("The task is outside the authenticated tenant scope.");
  }
  if (videoTask.ownerAccountId !== context.actorAccountId) {
    throw new AccountRunLockDeniedError("Only the current task owner can acquire a run lock.");
  }
  if (videoTask.status !== "active") {
    throw new AccountRunLockDeniedError("Only an active video task can acquire a run lock.");
  }
  if (operation !== "video_generation" && operation !== "automatic_editing") {
    throw new AccountRunLockDeniedError("The requested operation is not a high-cost task operation.");
  }
  if (current) {
    if (current.tenantId !== context.tenantId || current.accountId !== context.actorAccountId) {
      throw new AccountRunLockDeniedError("The stored run lock has an invalid account scope.");
    }
    throw new AccountHighCostTaskRunningError(current);
  }

  return {
    id: context.createId(),
    tenantId: context.tenantId,
    accountId: context.actorAccountId,
    batchProjectId: videoTask.batchProjectId,
    videoTaskId: videoTask.id,
    taskRevision: videoTask.revision,
    operation,
    acquiredAt: context.occurredAt,
  };
}

export function releaseAccountHighCostTaskRunLock(
  current: Readonly<AccountHighCostTaskRunLock> | undefined,
  expectedLockId: string,
): undefined {
  if (!current) return undefined;
  if (current.id !== expectedLockId) throw new AccountRunLockTokenMismatchError();
  return undefined;
}
