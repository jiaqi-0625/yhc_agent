import type { WorkspaceAccessGrant } from "@firefly/schemas";

import type {
  PostgresQueryable,
  PostgresTransactionProvider,
} from "./postgres-contract.ts";
import {
  assertWorkspaceAdminIdentifier,
  emptyWorkspaceAdminState,
  validateWorkspaceAdminState,
  validateWorkspaceAdminTransition,
  type WorkspaceAdminState,
  type WorkspaceAdminStore,
} from "./workspace-admin-store.ts";
import {
  synchronizePostgresVehicleCatalog,
  verifyPostgresVehicleCatalogProjection,
} from "./postgres-vehicle-catalog-store.ts";

interface WorkspaceAdminRow {
  tenant_id: string;
  revision: number | string;
  state: unknown;
}
function decodeState(value: unknown): WorkspaceAdminState {
  const decoded = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return structuredClone(decoded) as WorkspaceAdminState;
}

async function lockTenant(transaction: PostgresQueryable, tenantId: string): Promise<void> {
  await transaction.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`workspace_admin:${tenantId}`],
  );
}

async function selectState(
  queryable: PostgresQueryable,
  tenantId: string,
  forUpdate = false,
): Promise<WorkspaceAdminRow | undefined> {
  const result = await queryable.query<WorkspaceAdminRow>(
    `SELECT tenant_id, revision, state
       FROM workspace_admin_states
      WHERE tenant_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId],
  );
  if (result.rows.length > 1) {
    throw new Error("Persisted workspace administration state has duplicate tenant rows.");
  }
  return result.rows[0];
}

export class PostgresWorkspaceAdminStore implements WorkspaceAdminStore {
  constructor(private readonly postgres: PostgresTransactionProvider) {}

  async load(tenantId: string): Promise<WorkspaceAdminState> {
    assertWorkspaceAdminIdentifier(tenantId, "Tenant ID");
    const row = await selectState(this.postgres, tenantId);
    const state = row === undefined
      ? emptyWorkspaceAdminState(tenantId, {})
      : decodeState(row.state);
    if (row !== undefined && row.tenant_id !== tenantId) {
      throw new Error("Persisted workspace administration state has an invalid tenant scope.");
    }
    validateWorkspaceAdminState(state, tenantId);
    await verifyPostgresVehicleCatalogProjection(this.postgres, tenantId, state.vehicleVersions);
    return structuredClone(state);
  }

  async withSnapshot<Result>(
    tenantId: string,
    inspect: (current: WorkspaceAdminState) => Result | Promise<Result>,
  ): Promise<Result> {
    assertWorkspaceAdminIdentifier(tenantId, "Tenant ID");
    return this.postgres.transaction(async (transaction) => {
      await lockTenant(transaction, tenantId);
      const row = await selectState(transaction, tenantId, true);
      const current = row === undefined
        ? emptyWorkspaceAdminState(tenantId, {})
        : decodeState(row.state);
      validateWorkspaceAdminState(current, tenantId);
      await verifyPostgresVehicleCatalogProjection(transaction, tenantId, current.vehicleVersions);
      return inspect(structuredClone(current));
    });
  }

  async transact(
    tenantId: string,
    update: (
      current: WorkspaceAdminState,
    ) => WorkspaceAdminState | Promise<WorkspaceAdminState>,
  ): Promise<WorkspaceAdminState> {
    assertWorkspaceAdminIdentifier(tenantId, "Tenant ID");
    return this.postgres.transaction(async (transaction) => {
      await lockTenant(transaction, tenantId);
      const row = await selectState(transaction, tenantId, true);
      const current = row === undefined
        ? emptyWorkspaceAdminState(tenantId, {})
        : decodeState(row.state);
      validateWorkspaceAdminState(current, tenantId);
      const next = await update(structuredClone(current));
      validateWorkspaceAdminState(next, tenantId);
      validateWorkspaceAdminTransition(current, next);
      await synchronizePostgresVehicleCatalog(transaction, tenantId, next.vehicleVersions);
      const serialized = JSON.stringify(structuredClone(next));
      const write = row === undefined
        ? await transaction.query<{ revision: number | string }>(
            `INSERT INTO workspace_admin_states (tenant_id, revision, state, updated_at)
             VALUES ($1, 1, $2::jsonb, now())
             ON CONFLICT (tenant_id) DO NOTHING
             RETURNING revision`,
            [tenantId, serialized],
          )
        : await transaction.query<{ revision: number | string }>(
            `UPDATE workspace_admin_states
                SET state = $2::jsonb, revision = revision + 1, updated_at = now()
              WHERE tenant_id = $1 AND revision = $3
              RETURNING revision`,
            [tenantId, serialized, row.revision],
          );
      if (write.rowCount !== 1) {
        throw new Error("Workspace administration state changed concurrently.");
      }
      return structuredClone(next);
    });
  }

  async listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<readonly WorkspaceAccessGrant[]> {
    assertWorkspaceAdminIdentifier(accountId, "Account ID");
    const state = await this.load(tenantId);
    return structuredClone(
      state.accessGrants.filter((grant) => grant.accountId === accountId),
    );
  }
}
