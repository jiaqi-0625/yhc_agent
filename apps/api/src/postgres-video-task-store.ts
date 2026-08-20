import type { VideoTaskProductionRecord } from "@firefly/domain";

import type { PostgresQueryable, PostgresTransactionProvider } from "./postgres-contract.ts";
import {
  assertVideoTaskId as assertVideoTaskStoreId,
  assertIdentifier as assertVideoTaskStoreIdentifier,
  normalizedName as normalizeVideoTaskName,
  upgradeRecord as upgradeVideoTaskProductionRecord,
  validateCreationMetadata as validateVideoTaskCreationMetadata,
  validateRecord as validateVideoTaskProductionRecord,
  type VideoTaskCreateResult,
  type VideoTaskCreationMetadata,
  type VideoTaskCreationStore,
} from "./video-task-store.ts";

interface VideoTaskRow {
  task_id: string;
  tenant_id: string;
  project_id: string;
  aggregate: unknown;
  revision: string | number;
  creation_actor_account_id?: string | null;
  creation_request_id?: string | null;
  creation_payload_hash?: string | null;
}
interface LoadedVideoTask {
  record: VideoTaskProductionRecord;
  revision: string | number;
  creation?: VideoTaskCreationMetadata;
}

function decodeRow(row: VideoTaskRow): LoadedVideoTask {
  const value = typeof row.aggregate === "string" ? JSON.parse(row.aggregate) as unknown : row.aggregate;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Persisted video task has an invalid format or scope.");
  }
  const raw = value as VideoTaskProductionRecord;
  const record = upgradeVideoTaskProductionRecord(raw, raw.videoTask?.id);
  validateVideoTaskProductionRecord(record);
  if (
    record.videoTask.id !== row.task_id ||
    record.videoTask.tenantId !== row.tenant_id ||
    record.videoTask.batchProjectId !== row.project_id
  ) {
    throw new Error("Persisted video task has an invalid format or scope.");
  }
  const fields = [row.creation_actor_account_id, row.creation_request_id, row.creation_payload_hash];
  if (fields.some((field) => field == null) && fields.some((field) => field != null)) {
    throw new Error("Persisted video task has invalid creation metadata.");
  }
  const creation = fields[0] == null ? undefined : {
    actorAccountId: row.creation_actor_account_id!,
    requestId: row.creation_request_id!,
    payloadHash: row.creation_payload_hash!,
  };
  if (creation !== undefined) validateVideoTaskCreationMetadata(creation);
  return { record: structuredClone(record), revision: row.revision, ...(creation === undefined ? {} : { creation }) };
}

async function advisoryLock(transaction: PostgresQueryable, key: string): Promise<void> {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

const selectColumns = `task_id, tenant_id, project_id, aggregate, revision, creation_actor_account_id,
  creation_request_id, creation_payload_hash`;

export class PostgresVideoTaskProductionStore implements VideoTaskCreationStore {
  constructor(readonly database: PostgresTransactionProvider) {}

  async load(videoTaskId: string): Promise<VideoTaskProductionRecord | undefined> {
    assertVideoTaskStoreId(videoTaskId);
    const result = await this.database.query<VideoTaskRow>(
      `SELECT ${selectColumns} FROM video_task_aggregates WHERE task_id = $1`,
      [videoTaskId],
    );
    return result.rows[0] === undefined ? undefined : structuredClone(decodeRow(result.rows[0]).record);
  }

  async list(tenantId: string, batchProjectId?: string): Promise<VideoTaskProductionRecord[]> {
    assertVideoTaskStoreIdentifier(tenantId, "Tenant ID");
    if (batchProjectId !== undefined) assertVideoTaskStoreIdentifier(batchProjectId, "Batch project ID");
    const result = await this.database.query<VideoTaskRow>(
      batchProjectId === undefined
        ? `SELECT ${selectColumns} FROM video_task_aggregates WHERE tenant_id = $1 ORDER BY task_id`
        : `SELECT ${selectColumns} FROM video_task_aggregates WHERE tenant_id = $1 AND project_id = $2 ORDER BY task_id`,
      batchProjectId === undefined ? [tenantId] : [tenantId, batchProjectId],
    );
    return result.rows.map((row) => structuredClone(decodeRow(row).record));
  }

  async create(record: Readonly<VideoTaskProductionRecord>, metadata: Readonly<VideoTaskCreationMetadata>): Promise<VideoTaskProductionRecord> {
    return (await this.createWithResult(record, metadata)).record;
  }

  async createWithResult(record: Readonly<VideoTaskProductionRecord>, metadata: Readonly<VideoTaskCreationMetadata>): Promise<VideoTaskCreateResult> {
    validateVideoTaskProductionRecord(record);
    validateVideoTaskCreationMetadata(metadata);
    const candidate = structuredClone(record);
    const creation = structuredClone(metadata);
    const { tenantId, batchProjectId, id } = candidate.videoTask;
    return this.database.transaction(async (transaction) => {
      await advisoryLock(transaction, `video-task-create:${tenantId}:${batchProjectId}`);
      const replayResult = await transaction.query<VideoTaskRow>(
        `SELECT ${selectColumns} FROM video_task_aggregates
          WHERE tenant_id = $1 AND project_id = $2
            AND creation_actor_account_id = $3 AND creation_request_id = $4`,
        [tenantId, batchProjectId, creation.actorAccountId, creation.requestId],
      );
      const replayRow = replayResult.rows[0];
      if (replayRow !== undefined) {
        const replay = decodeRow(replayRow);
        if (replay.creation?.payloadHash !== creation.payloadHash) {
          throw new Error("Video task creation request conflicts with a different payload.");
        }
        return { record: structuredClone(replay.record), replayed: true };
      }
      // The project lock serializes normalized names and request keys. The
      // task lock additionally serializes the globally unique task identity
      // when two projects create the same deterministic ID concurrently.
      await advisoryLock(transaction, `video-task:${id}`);
      const conflicts = await transaction.query<{ task_id: string; normalized_name: string }>(
        `SELECT task_id, normalized_name FROM video_task_aggregates
          WHERE task_id = $1 OR (tenant_id = $2 AND project_id = $3 AND normalized_name = $4)`,
        [id, tenantId, batchProjectId, normalizeVideoTaskName(candidate.videoTask.name)],
      );
      if (conflicts.rows.some((row) => row.task_id === id)) {
        throw new Error("A video task with the same ID already exists.");
      }
      if (conflicts.rows.length > 0) {
        throw new Error("A video task with the same name already exists in this batch project.");
      }
      await transaction.query(
        `INSERT INTO video_task_aggregates (
           task_id, tenant_id, project_id, revision, normalized_name,
           creation_actor_account_id, creation_request_id, creation_payload_hash, aggregate
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8::jsonb)`,
        [id, tenantId, batchProjectId, normalizeVideoTaskName(candidate.videoTask.name), creation.actorAccountId, creation.requestId, creation.payloadHash, JSON.stringify(candidate)],
      );
      return { record: structuredClone(candidate), replayed: false };
    });
  }

  async save(record: VideoTaskProductionRecord): Promise<void> {
    validateVideoTaskProductionRecord(record);
    await this.database.transaction(async (transaction) => {
      await advisoryLock(transaction, `video-task:${record.videoTask.id}`);
      const result = await transaction.query<VideoTaskRow>(
        `SELECT ${selectColumns} FROM video_task_aggregates WHERE task_id = $1 FOR UPDATE`,
        [record.videoTask.id],
      );
      const row = result.rows[0];
      if (row === undefined) {
        await this.insertWithoutCreation(transaction, record);
        return;
      }
      const current = decodeRow(row);
      this.assertScopeUnchanged(current.record, record, "save");
      if (JSON.stringify(current.record) === JSON.stringify(record)) return;
      if (record.videoTask.revision !== current.record.videoTask.revision + 1) {
        throw new Error("A video task save must advance the persisted task by exactly one revision.");
      }
      await this.updateLocked(transaction, record, row.revision);
    });
  }

  async transact(videoTaskId: string, update: (current: VideoTaskProductionRecord | undefined) => VideoTaskProductionRecord | Promise<VideoTaskProductionRecord>): Promise<VideoTaskProductionRecord> {
    assertVideoTaskStoreId(videoTaskId);
    return this.database.transaction(async (transaction) => {
      await advisoryLock(transaction, `video-task:${videoTaskId}`);
      const result = await transaction.query<VideoTaskRow>(
        `SELECT ${selectColumns} FROM video_task_aggregates WHERE task_id = $1 FOR UPDATE`,
        [videoTaskId],
      );
      const row = result.rows[0];
      const current = row === undefined ? undefined : decodeRow(row);
      const next = await update(current === undefined ? undefined : structuredClone(current.record));
      validateVideoTaskProductionRecord(next, videoTaskId);
      if (next.videoTask.id !== videoTaskId) {
        throw new Error("A video task transaction cannot change the aggregate identity.");
      }
      if (current !== undefined) {
        this.assertScopeUnchanged(current.record, next, "transaction");
        await this.updateLocked(transaction, next, current.revision);
      } else {
        await this.insertWithoutCreation(transaction, next);
      }
      return structuredClone(next);
    });
  }

  private assertScopeUnchanged(current: VideoTaskProductionRecord, next: VideoTaskProductionRecord, operation: "save" | "transaction"): void {
    if (current.videoTask.tenantId !== next.videoTask.tenantId || current.videoTask.batchProjectId !== next.videoTask.batchProjectId) {
      throw new Error(`A video task ${operation} cannot change the aggregate scope.`);
    }
  }

  private async updateLocked(transaction: PostgresQueryable, record: VideoTaskProductionRecord, revision: string | number): Promise<void> {
    const result = await transaction.query(
      `UPDATE video_task_aggregates
          SET revision = revision + 1, normalized_name = $3, aggregate = $4::jsonb,
              updated_at = now()
        WHERE task_id = $1 AND revision = $2`,
      [record.videoTask.id, revision, normalizeVideoTaskName(record.videoTask.name), JSON.stringify(record)],
    );
    if (result.rowCount !== 1) throw new Error("Video task transaction lost its revision compare-and-swap.");
  }

  private async insertWithoutCreation(transaction: PostgresQueryable, record: VideoTaskProductionRecord): Promise<void> {
    await transaction.query(
      `INSERT INTO video_task_aggregates (
         task_id, tenant_id, project_id, revision, normalized_name,
         creation_actor_account_id, creation_request_id, creation_payload_hash, aggregate
       ) VALUES ($1, $2, $3, 1, $4, NULL, NULL, NULL, $5::jsonb)`,
      [record.videoTask.id, record.videoTask.tenantId, record.videoTask.batchProjectId, normalizeVideoTaskName(record.videoTask.name), JSON.stringify(record)],
    );
  }
}
