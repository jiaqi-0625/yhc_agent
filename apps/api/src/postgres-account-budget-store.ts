import type { AccountBudget } from "@firefly/schemas";

import type {
  PostgresQueryable,
  PostgresTransactionProvider,
} from "./postgres-contract.ts";
import {
  assertAccountBudgetIdentifier,
  validateAccountBudget,
  type AccountBudgetStore,
} from "./account-budget-store.ts";

interface AccountBudgetRow {
  tenant_id: string;
  account_id: string;
  revision: number | string;
  state: unknown;
}
function decodeBudget(value: unknown): AccountBudget {
  const decoded = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return structuredClone(decoded) as AccountBudget;
}

async function lockBudget(
  transaction: PostgresQueryable,
  tenantId: string,
  accountId: string,
): Promise<void> {
  await transaction.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`account_budget:${tenantId}:${accountId}`],
  );
}

async function selectBudget(
  queryable: PostgresQueryable,
  tenantId: string,
  accountId: string,
  forUpdate = false,
): Promise<AccountBudgetRow | undefined> {
  const result = await queryable.query<AccountBudgetRow>(
    `SELECT tenant_id, account_id, revision, state
       FROM account_budget_states
      WHERE tenant_id = $1 AND account_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, accountId],
  );
  if (result.rows.length > 1) {
    throw new Error("Persisted account budget has duplicate scoped rows.");
  }
  return result.rows[0];
}

export class PostgresAccountBudgetStore implements AccountBudgetStore {
  constructor(private readonly postgres: PostgresTransactionProvider) {}

  async load(tenantId: string, accountId: string): Promise<AccountBudget | undefined> {
    assertAccountBudgetIdentifier(tenantId, "Tenant ID");
    assertAccountBudgetIdentifier(accountId, "Account ID");
    const row = await selectBudget(this.postgres, tenantId, accountId);
    if (row === undefined) return undefined;
    if (row.tenant_id !== tenantId || row.account_id !== accountId) {
      throw new Error("Persisted account budget has an invalid format or scope.");
    }
    const budget = decodeBudget(row.state);
    validateAccountBudget(budget, tenantId, accountId);
    return structuredClone(budget);
  }

  async transact(
    tenantId: string,
    accountId: string,
    update: (
      current: AccountBudget | undefined,
    ) => AccountBudget | Promise<AccountBudget>,
  ): Promise<AccountBudget> {
    assertAccountBudgetIdentifier(tenantId, "Tenant ID");
    assertAccountBudgetIdentifier(accountId, "Account ID");
    return this.postgres.transaction(async (transaction) => {
      await lockBudget(transaction, tenantId, accountId);
      const row = await selectBudget(transaction, tenantId, accountId, true);
      let current: AccountBudget | undefined;
      if (row !== undefined) {
        if (row.tenant_id !== tenantId || row.account_id !== accountId) {
          throw new Error("Persisted account budget has an invalid format or scope.");
        }
        current = decodeBudget(row.state);
        validateAccountBudget(current, tenantId, accountId);
      }
      const next = await update(current === undefined ? undefined : structuredClone(current));
      validateAccountBudget(next, tenantId, accountId);
      const serialized = JSON.stringify(structuredClone(next));
      const write = row === undefined
        ? await transaction.query<{ revision: number | string }>(
            `INSERT INTO account_budget_states
               (tenant_id, account_id, revision, state, updated_at)
             VALUES ($1, $2, 1, $3::jsonb, now())
             ON CONFLICT (tenant_id, account_id) DO NOTHING
             RETURNING revision`,
            [tenantId, accountId, serialized],
          )
        : await transaction.query<{ revision: number | string }>(
            `UPDATE account_budget_states
                SET state = $3::jsonb, revision = revision + 1, updated_at = now()
              WHERE tenant_id = $1 AND account_id = $2 AND revision = $4
              RETURNING revision`,
            [tenantId, accountId, serialized, row.revision],
          );
      if (write.rowCount !== 1) {
        throw new Error("Account budget changed concurrently.");
      }
      return structuredClone(next);
    });
  }
}
