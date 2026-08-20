import type { AccountHighCostTaskRunLock } from "@firefly/schemas";

import type {
  PostgresQueryable,
  PostgresTransactionProvider,
} from "./postgres-contract.ts";
import {
  assertAccountRunLockIdentifier,
  validateAccountRunLock,
  type AccountRunLockStore,
} from "./account-run-lock-store.ts";

interface AccountRunLockRow {
  tenant_id: string;
  account_id: string;
  lock_id: string;
  batch_project_id: string;
  video_task_id: string;
  operation: string;
  acquired_at: string | Date;
  revision: number | string;
  envelope: unknown;
}
function timestampsRepresentSameInstant(left: string | Date, right: string): boolean {
  const leftTimestamp = left instanceof Date ? left.getTime() : Date.parse(left);
  const rightTimestamp = Date.parse(right);
  return (
    Number.isFinite(leftTimestamp) &&
    Number.isFinite(rightTimestamp) &&
    leftTimestamp === rightTimestamp
  );
}

function decodeLock(
  row: Readonly<AccountRunLockRow>,
  tenantId: string,
  accountId: string,
): AccountHighCostTaskRunLock {
  const decoded = typeof row.envelope === "string"
    ? (JSON.parse(row.envelope) as unknown)
    : row.envelope;
  const lock = structuredClone(decoded) as AccountHighCostTaskRunLock;
  validateAccountRunLock(lock, tenantId, accountId);
  if (
    row.tenant_id !== tenantId ||
    row.account_id !== accountId ||
    row.lock_id !== lock.id ||
    row.batch_project_id !== lock.batchProjectId ||
    row.video_task_id !== lock.videoTaskId ||
    row.operation !== lock.operation ||
    !timestampsRepresentSameInstant(row.acquired_at, lock.acquiredAt)
  ) {
    throw new Error("Persisted account run lock has an invalid relational scope.");
  }
  return lock;
}

async function selectLock(
  queryable: PostgresQueryable,
  tenantId: string,
  accountId: string,
  forUpdate = false,
): Promise<AccountRunLockRow | undefined> {
  const result = await queryable.query<AccountRunLockRow>(
    `SELECT tenant_id, account_id, lock_id, batch_project_id, video_task_id,
            operation, acquired_at, revision, envelope
       FROM account_run_lock_states
      WHERE tenant_id = $1 AND account_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, accountId],
  );
  if (result.rows.length > 1) {
    throw new Error("Persisted account run locks contain duplicate account rows.");
  }
  return result.rows[0];
}

export class PostgresAccountRunLockStore implements AccountRunLockStore {
  constructor(private readonly postgres: PostgresTransactionProvider) {}

  async load(
    tenantId: string,
    accountId: string,
  ): Promise<AccountHighCostTaskRunLock | undefined> {
    assertAccountRunLockIdentifier(tenantId, "Tenant ID");
    assertAccountRunLockIdentifier(accountId, "Account ID");
    const row = await selectLock(this.postgres, tenantId, accountId);
    return row === undefined ? undefined : structuredClone(decodeLock(row, tenantId, accountId));
  }

  async transact(
    tenantId: string,
    accountId: string,
    update: (
      current: AccountHighCostTaskRunLock | undefined,
    ) => AccountHighCostTaskRunLock | undefined | Promise<AccountHighCostTaskRunLock | undefined>,
  ): Promise<AccountHighCostTaskRunLock | undefined> {
    assertAccountRunLockIdentifier(tenantId, "Tenant ID");
    assertAccountRunLockIdentifier(accountId, "Account ID");
    return this.postgres.transaction(async (transaction) => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`account_run_lock:${tenantId}:${accountId}`],
      );
      const row = await selectLock(transaction, tenantId, accountId, true);
      const current = row === undefined ? undefined : decodeLock(row, tenantId, accountId);
      const next = await update(current === undefined ? undefined : structuredClone(current));
      if (next === undefined) {
        if (row !== undefined) {
          const deleted = await transaction.query(
            `DELETE FROM account_run_lock_states
              WHERE tenant_id = $1 AND account_id = $2 AND revision = $3`,
            [tenantId, accountId, row.revision],
          );
          if (deleted.rowCount !== 1) throw new Error("Account run lock changed concurrently.");
        }
        return undefined;
      }
      if (next.tenantId !== tenantId || next.accountId !== accountId) {
        throw new Error("An account run lock transaction cannot change its scope.");
      }
      validateAccountRunLock(next, tenantId, accountId);
      const serialized = JSON.stringify(structuredClone(next));
      const write = row === undefined
        ? await transaction.query<{ revision: number | string }>(
            `INSERT INTO account_run_lock_states
               (tenant_id, account_id, lock_id, batch_project_id, video_task_id,
                operation, acquired_at, revision, envelope, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, 1, $8::jsonb, now())
             ON CONFLICT (tenant_id, account_id) DO NOTHING
             RETURNING revision`,
            [
              tenantId,
              accountId,
              next.id,
              next.batchProjectId,
              next.videoTaskId,
              next.operation,
              next.acquiredAt,
              serialized,
            ],
          )
        : await transaction.query<{ revision: number | string }>(
            `UPDATE account_run_lock_states
                SET lock_id = $3, batch_project_id = $4, video_task_id = $5,
                    operation = $6, acquired_at = $7::timestamptz,
                    envelope = $8::jsonb, revision = revision + 1, updated_at = now()
              WHERE tenant_id = $1 AND account_id = $2 AND revision = $9
              RETURNING revision`,
            [
              tenantId,
              accountId,
              next.id,
              next.batchProjectId,
              next.videoTaskId,
              next.operation,
              next.acquiredAt,
              serialized,
              row.revision,
            ],
          );
      if (write.rowCount !== 1) throw new Error("Account run lock changed concurrently.");
      return structuredClone(next);
    });
  }
}
