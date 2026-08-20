import type { BatchProject, ProjectAssetPool } from "@firefly/schemas";

import {
  assertIdentifier as assertBatchProjectStoreIdentifier,
  normalizedName as normalizeBatchProjectName,
  validateAggregate as validateBatchProjectAggregate,
  type BatchProjectAggregate,
  type BatchProjectCreateMetadata,
  type BatchProjectStore,
} from "./batch-project-store.ts";
import type {
  PostgresQueryable,
  PostgresTransactionProvider,
} from "./postgres-contract.ts";

interface BatchProjectRow {
  aggregate: unknown;
  revision: string | number;
  creation_payload_hash?: string;
}
function decodeAggregate(
  row: BatchProjectRow,
  expectedTenantId?: string,
  expectedProjectId?: string,
): BatchProjectAggregate {
  const value = typeof row.aggregate === "string" ? JSON.parse(row.aggregate) as unknown : row.aggregate;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Batch project aggregate has an invalid format or scope.");
  }
  const aggregate = value as BatchProjectAggregate;
  validateBatchProjectAggregate(
    aggregate,
    expectedTenantId ?? aggregate.project?.tenantId,
    expectedProjectId ?? aggregate.project?.id,
  );
  return structuredClone(aggregate);
}

async function lockCreationScope(transaction: PostgresQueryable, tenantId: string): Promise<void> {
  await transaction.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`batch-project-create:${tenantId}`],
  );
}

export class PostgresBatchProjectStore implements BatchProjectStore {
  constructor(readonly database: PostgresTransactionProvider) {}

  async load(tenantId: string, projectId: string): Promise<BatchProjectAggregate | undefined> {
    assertBatchProjectStoreIdentifier(tenantId, "Tenant ID");
    assertBatchProjectStoreIdentifier(projectId, "Batch project ID");
    const result = await this.database.query<BatchProjectRow>(
      `SELECT aggregate, revision
         FROM batch_project_aggregates
        WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, projectId],
    );
    return result.rows[0] === undefined ? undefined : decodeAggregate(result.rows[0], tenantId, projectId);
  }

  async loadByProjectId(projectId: string): Promise<BatchProjectAggregate | undefined> {
    assertBatchProjectStoreIdentifier(projectId, "Batch project ID");
    const result = await this.database.query<BatchProjectRow>(
      `SELECT aggregate, revision
         FROM batch_project_aggregates
        WHERE project_id = $1
        ORDER BY tenant_id
        LIMIT 2`,
      [projectId],
    );
    if (result.rows.length > 1) throw new Error("Batch project ID is ambiguous across tenants.");
    return result.rows[0] === undefined ? undefined : decodeAggregate(result.rows[0], undefined, projectId);
  }

  async loadByRequest(
    tenantId: string,
    actorAccountId: string,
    requestId: string,
  ): Promise<BatchProjectAggregate | undefined> {
    assertBatchProjectStoreIdentifier(tenantId, "Tenant ID");
    assertBatchProjectStoreIdentifier(actorAccountId, "Actor account ID");
    assertBatchProjectStoreIdentifier(requestId, "Request ID");
    const result = await this.database.query<BatchProjectRow>(
      `SELECT aggregate, revision
         FROM batch_project_aggregates
        WHERE tenant_id = $1
          AND creation_actor_account_id = $2
          AND creation_request_id = $3`,
      [tenantId, actorAccountId, requestId],
    );
    return result.rows[0] === undefined
      ? undefined
      : decodeAggregate(result.rows[0], tenantId);
  }

  async list(tenantId: string): Promise<BatchProjectAggregate[]> {
    assertBatchProjectStoreIdentifier(tenantId, "Tenant ID");
    const result = await this.database.query<BatchProjectRow>(
      `SELECT aggregate, revision
         FROM batch_project_aggregates
        WHERE tenant_id = $1
        ORDER BY project_id`,
      [tenantId],
    );
    return result.rows.map((row) => decodeAggregate(row, tenantId));
  }

  async create(
    project: Readonly<BatchProject>,
    assetPool: Readonly<ProjectAssetPool>,
    metadata: Readonly<BatchProjectCreateMetadata>,
  ): Promise<BatchProjectAggregate> {
    assertBatchProjectStoreIdentifier(project.tenantId, "Tenant ID");
    assertBatchProjectStoreIdentifier(project.id, "Batch project ID");
    assertBatchProjectStoreIdentifier(metadata.actorAccountId, "Actor account ID");
    assertBatchProjectStoreIdentifier(metadata.requestId, "Request ID");
    const candidate = structuredClone({ ...metadata, project, assetPool });
    validateBatchProjectAggregate(candidate, project.tenantId, project.id);

    return this.database.transaction(async (transaction) => {
      await lockCreationScope(transaction, project.tenantId);
      const replayResult = await transaction.query<BatchProjectRow>(
        `SELECT aggregate, revision, creation_payload_hash
           FROM batch_project_aggregates
          WHERE tenant_id = $1
            AND creation_actor_account_id = $2
            AND creation_request_id = $3`,
        [project.tenantId, metadata.actorAccountId, metadata.requestId],
      );
      const replay = replayResult.rows[0];
      if (replay !== undefined) {
        if (replay.creation_payload_hash !== metadata.payloadHash) {
          throw new Error("Batch project creation request conflicts with a different payload.");
        }
        return decodeAggregate(replay, project.tenantId, project.id);
      }
      const conflicts = await transaction.query<{ project_id: string; normalized_name: string }>(
        `SELECT project_id, normalized_name
           FROM batch_project_aggregates
          WHERE tenant_id = $1
            AND (project_id = $2 OR normalized_name = $3)`,
        [project.tenantId, project.id, normalizeBatchProjectName(project.name)],
      );
      if (conflicts.rows.some((row) => row.project_id === project.id)) {
        throw new Error("A batch project with the same ID already exists.");
      }
      if (conflicts.rows.length > 0) {
        throw new Error("A batch project with the same name already exists.");
      }
      await transaction.query(
        `INSERT INTO batch_project_aggregates (
           tenant_id, project_id, revision, normalized_name,
           creation_actor_account_id, creation_request_id, creation_payload_hash, aggregate
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7::jsonb)`,
        [
          project.tenantId,
          project.id,
          normalizeBatchProjectName(project.name),
          metadata.actorAccountId,
          metadata.requestId,
          metadata.payloadHash,
          JSON.stringify(candidate),
        ],
      );
      return structuredClone(candidate);
    });
  }

  async transactAssetPool(
    tenantId: string,
    projectId: string,
    update: (current: ProjectAssetPool) => ProjectAssetPool | Promise<ProjectAssetPool>,
  ): Promise<ProjectAssetPool> {
    assertBatchProjectStoreIdentifier(tenantId, "Tenant ID");
    assertBatchProjectStoreIdentifier(projectId, "Batch project ID");
    return this.database.transaction(async (transaction) => {
      const loaded = await transaction.query<BatchProjectRow>(
        `SELECT aggregate, revision
           FROM batch_project_aggregates
          WHERE tenant_id = $1 AND project_id = $2
          FOR UPDATE`,
        [tenantId, projectId],
      );
      const row = loaded.rows[0];
      if (row === undefined) throw new Error("Batch project was not found.");
      const current = decodeAggregate(row, tenantId, projectId);
      const nextPool = await update(structuredClone(current.assetPool));
      const next = { ...current, assetPool: nextPool };
      validateBatchProjectAggregate(next, tenantId, projectId);
      const saved = await transaction.query(
      `UPDATE batch_project_aggregates
          SET revision = revision + 1, aggregate = $4::jsonb, updated_at = now()
        WHERE tenant_id = $1 AND project_id = $2 AND revision = $3`,
        [tenantId, projectId, row.revision, JSON.stringify(next)],
      );
      if (saved.rowCount !== 1) {
        throw new Error("Batch project transaction lost its revision compare-and-swap.");
      }
      return structuredClone(nextPool);
    });
  }
}
