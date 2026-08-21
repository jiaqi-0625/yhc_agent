import type { PostgresTransactionProvider } from "./postgres-contract.ts";
import type { VideoGenerationRecord, VideoGenerationStore } from "./video-generation-store.ts";

interface VideoGenerationRow { job_id: string; revision: number | string; state: unknown; }

function decode(row: Readonly<VideoGenerationRow>): VideoGenerationRecord {
  const state = typeof row.state === "string" ? JSON.parse(row.state) as unknown : row.state;
  const record = structuredClone(state) as VideoGenerationRecord;
  if (record.id !== row.job_id || record.revision !== Number(row.revision)) {
    throw new Error("Persisted video generation job has an invalid relational scope.");
  }
  return record;
}

export class PostgresVideoGenerationStore implements VideoGenerationStore {
  constructor(private readonly postgres: PostgresTransactionProvider) {}

  async load(jobId: string): Promise<VideoGenerationRecord | undefined> {
    const result = await this.postgres.query<VideoGenerationRow>(
      "SELECT job_id, revision, state FROM video_generation_jobs WHERE job_id = $1",
      [jobId],
    );
    return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
  }

  async loadLatestForTask(tenantId: string, batchProjectId: string, videoTaskId: string): Promise<VideoGenerationRecord | undefined> {
    const result = await this.postgres.query<VideoGenerationRow>(
      `SELECT job_id, revision, state FROM video_generation_jobs
        WHERE tenant_id = $1 AND project_id = $2 AND video_task_id = $3
        ORDER BY created_at DESC, job_id DESC LIMIT 1`,
      [tenantId, batchProjectId, videoTaskId],
    );
    return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
  }

  async listForTask(tenantId: string, batchProjectId: string, videoTaskId: string): Promise<VideoGenerationRecord[]> {
    const result = await this.postgres.query<VideoGenerationRow>(
      `SELECT job_id, revision, state FROM video_generation_jobs
        WHERE tenant_id = $1 AND project_id = $2 AND video_task_id = $3
        ORDER BY created_at ASC, job_id ASC`,
      [tenantId, batchProjectId, videoTaskId],
    );
    return result.rows.map(decode).sort((left, right) =>
      left.shotIndex - right.shotIndex || left.createdAt.localeCompare(right.createdAt, "en")
    );
  }

  async loadByRequest(tenantId: string, actorAccountId: string, requestId: string): Promise<VideoGenerationRecord | undefined> {
    const result = await this.postgres.query<VideoGenerationRow>(
      `SELECT job_id, revision, state FROM video_generation_jobs
        WHERE tenant_id = $1 AND actor_account_id = $2 AND request_id = $3`,
      [tenantId, actorAccountId, requestId],
    );
    return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
  }

  async create(record: Readonly<VideoGenerationRecord>): Promise<VideoGenerationRecord> {
    const result = await this.postgres.query<VideoGenerationRow>(
      `INSERT INTO video_generation_jobs
         (job_id, tenant_id, project_id, video_task_id, actor_account_id, request_id,
          provider_job_id, status, revision, state, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9::jsonb,$10::timestamptz,$11::timestamptz)
       ON CONFLICT (tenant_id, actor_account_id, request_id) DO UPDATE SET updated_at = video_generation_jobs.updated_at
       RETURNING job_id, revision, state`,
      [record.id, record.tenantId, record.batchProjectId, record.videoTaskId, record.actorAccountId,
        record.requestId, record.providerJobId, record.status, JSON.stringify(record), record.createdAt, record.updatedAt],
    );
    if (result.rows[0] === undefined) throw new Error("Video generation job was not persisted.");
    return decode(result.rows[0]);
  }

  async save(record: Readonly<VideoGenerationRecord>, expectedRevision: number): Promise<VideoGenerationRecord> {
    const next = { ...structuredClone(record), revision: expectedRevision + 1 };
    const result = await this.postgres.query<VideoGenerationRow>(
      `UPDATE video_generation_jobs
          SET provider_job_id = $2, status = $3, revision = revision + 1,
              state = $4::jsonb, updated_at = $5::timestamptz
        WHERE job_id = $1 AND revision = $6
        RETURNING job_id, revision, state`,
      [record.id, record.providerJobId, record.status, JSON.stringify(next), record.updatedAt, expectedRevision],
    );
    if (result.rows[0] === undefined) throw new Error("Video generation job changed concurrently.");
    return decode(result.rows[0]);
  }
}
