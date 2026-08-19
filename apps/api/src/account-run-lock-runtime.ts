import { randomUUID } from "node:crypto";

import {
  acquireAccountHighCostTaskRunLock,
  assertCanOperateVideoTask,
  releaseAccountHighCostTaskRunLock,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  AccountHighCostTaskRunLock,
  BatchProject,
  HighCostTaskOperation,
  VideoTask,
} from "@firefly/schemas";

import type { AccountRunLockStore } from "./account-run-lock-store.ts";

export class AccountRunLockRuntime {
  constructor(
    private readonly store: AccountRunLockStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => `run_lock_${randomUUID()}`,
  ) {}

  async acquire(
    videoTask: Readonly<VideoTask>,
    project: Readonly<BatchProject>,
    operation: HighCostTaskOperation,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<AccountHighCostTaskRunLock> {
    assertCanOperateVideoTask(session, project, videoTask);
    const lock = await this.store.transact(
      session.tenantId,
      session.actorAccountId,
      (current) =>
        acquireAccountHighCostTaskRunLock(current, videoTask, operation, {
          tenantId: session.tenantId,
          actorAccountId: session.actorAccountId,
          occurredAt: this.now(),
          createId: this.createId,
        }),
    );
    if (!lock) throw new Error("Account run lock acquisition returned no lock.");
    return lock;
  }

  async release(lock: Readonly<AccountHighCostTaskRunLock>): Promise<void> {
    await this.store.transact(lock.tenantId, lock.accountId, (current) =>
      releaseAccountHighCostTaskRunLock(current, lock.id),
    );
  }

  loadForAccount(tenantId: string, accountId: string) {
    return this.store.load(tenantId, accountId);
  }
}
