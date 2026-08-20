import type { TemporaryAsset } from "@firefly/schemas";

import type {
  PostgresQueryable,
  PostgresTransactionProvider,
} from "./postgres-contract.ts";
import {
  assertTemporaryAssetProjectId,
  validateTemporaryAssetProjectRecord,
  validateTemporaryAssets,
  type TemporaryAssetProjectRecord,
  type TemporaryAssetStore,
} from "./temporary-asset-store.ts";

interface TemporaryAssetProjectRow {
  tenant_id: string | null;
  batch_project_id: string;
  revision: number | string;
  envelope: unknown;
}
function tenantIdForAssets(assets: readonly TemporaryAsset[]): string | undefined {
  const tenantIds = new Set(assets.map((asset) => asset.tenantId));
  if (tenantIds.size > 1) {
    throw new Error("Temporary assets cannot cross tenant scope.");
  }
  const tenantId = tenantIds.values().next().value as string | undefined;
  if (tenantId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(tenantId)) {
    throw new Error("Temporary assets have an invalid tenant scope.");
  }
  return tenantId;
}

function decodeRecord(
  row: Readonly<TemporaryAssetProjectRow>,
  batchProjectId: string,
): TemporaryAssetProjectRecord {
  const decoded = typeof row.envelope === "string"
    ? (JSON.parse(row.envelope) as unknown)
    : row.envelope;
  const record = structuredClone(decoded) as TemporaryAssetProjectRecord;
  validateTemporaryAssetProjectRecord(record, batchProjectId);
  if (row.batch_project_id !== batchProjectId) {
    throw new Error("Persisted temporary assets have an invalid project scope.");
  }
  const envelopeTenantId = tenantIdForAssets(record.assets);
  if (envelopeTenantId !== undefined && row.tenant_id !== envelopeTenantId) {
    throw new Error("Persisted temporary assets have an invalid tenant scope.");
  }
  return record;
}

async function selectProject(
  queryable: PostgresQueryable,
  batchProjectId: string,
  forUpdate = false,
): Promise<TemporaryAssetProjectRow | undefined> {
  const result = await queryable.query<TemporaryAssetProjectRow>(
    `SELECT tenant_id, batch_project_id, revision, envelope
       FROM temporary_asset_project_states
      WHERE batch_project_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [batchProjectId],
  );
  if (result.rows.length > 1) {
    throw new Error("Persisted temporary assets contain duplicate project rows.");
  }
  return result.rows[0];
}

export class PostgresTemporaryAssetStore implements TemporaryAssetStore {
  constructor(private readonly postgres: PostgresTransactionProvider) {}

  async loadProject(batchProjectId: string): Promise<TemporaryAsset[]> {
    assertTemporaryAssetProjectId(batchProjectId);
    const row = await selectProject(this.postgres, batchProjectId);
    if (row === undefined) return [];
    return structuredClone(decodeRecord(row, batchProjectId).assets);
  }

  async transactProject(
    batchProjectId: string,
    update: (
      current: TemporaryAsset[],
    ) => TemporaryAsset[] | Promise<TemporaryAsset[]>,
  ): Promise<TemporaryAsset[]> {
    assertTemporaryAssetProjectId(batchProjectId);
    return this.postgres.transaction(async (transaction) => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`temporary_assets:${batchProjectId}`],
      );
      const row = await selectProject(transaction, batchProjectId, true);
      const current = row === undefined ? [] : decodeRecord(row, batchProjectId).assets;
      const next = await update(structuredClone(current));
      validateTemporaryAssets(next, batchProjectId);
      if (row === undefined && next.length === 0) return [];
      const nextTenantId = tenantIdForAssets(next);
      if (
        row?.tenant_id !== null &&
        row?.tenant_id !== undefined &&
        nextTenantId !== undefined &&
        row.tenant_id !== nextTenantId
      ) {
        throw new Error("A temporary asset project cannot change its tenant scope.");
      }
      const tenantId = row?.tenant_id ?? nextTenantId;
      if (tenantId === undefined) {
        throw new Error("A new temporary asset project requires an explicit tenant scope.");
      }
      const envelope: TemporaryAssetProjectRecord = {
        schemaVersion: 1,
        batchProjectId,
        assets: structuredClone(next),
      };
      validateTemporaryAssetProjectRecord(envelope, batchProjectId);
      const serialized = JSON.stringify(envelope);
      const write = row === undefined
        ? await transaction.query<{ revision: number | string }>(
            `INSERT INTO temporary_asset_project_states
               (tenant_id, batch_project_id, revision, envelope, updated_at)
             VALUES ($1, $2, 1, $3::jsonb, now())
             ON CONFLICT (batch_project_id) DO NOTHING
             RETURNING revision`,
            [tenantId, batchProjectId, serialized],
          )
        : await transaction.query<{ revision: number | string }>(
            `UPDATE temporary_asset_project_states
                SET tenant_id = $2, envelope = $3::jsonb,
                    revision = revision + 1, updated_at = now()
              WHERE batch_project_id = $1 AND revision = $4
              RETURNING revision`,
            [batchProjectId, tenantId, serialized, row.revision],
          );
      if (write.rowCount !== 1) {
        throw new Error("Temporary asset project changed concurrently.");
      }
      return structuredClone(next);
    });
  }
}
