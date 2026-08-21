import type { PostgresQueryable, PostgresTransactionProvider } from "./postgres-contract.ts";
import {
  VideoGenerationRequestConflictError,
  validateVideoGenerationRequestRecord,
  type VideoGenerationProviderStatus,
  type VideoGenerationRequestCreateResult,
  type VideoGenerationRequestRecord,
  type VideoGenerationRequestStore,
} from "./video-generation-request-store.ts";

interface VideoGenerationRequestRow {
  generation_request_id: string;
  tenant_id: string;
  batch_project_id: string;
  video_task_id: string;
  actor_account_id: string;
  request_id: string;
  task_revision: number | string;
  vehicle_snapshot_id: string;
  asset_snapshot_id: string;
  storyboard_artifact_version_id: string;
  provider_id: string;
  provider_job_id: string | null;
  provider_status: string;
  outcome_status: string;
  model_id: string;
  resolution: string;
  aspect_ratio: string;
  duration_seconds: number | string;
  prompt_text: string;
  prompt_sha256: string;
  requested_at: Date | string;
  completed_at: Date | string;
  charged_amount_minor: number | string;
  currency: string;
  media_artifact_id: string | null;
  failure_code: string | null;
}

const columns = `generation_request_id, tenant_id, batch_project_id, video_task_id,
  actor_account_id, request_id, task_revision, vehicle_snapshot_id, asset_snapshot_id,
  storyboard_artifact_version_id, provider_id, provider_job_id, provider_status,
  outcome_status, model_id, resolution, aspect_ratio, duration_seconds, prompt_text,
  prompt_sha256, requested_at, completed_at, charged_amount_minor, currency,
  media_artifact_id, failure_code`;

function safeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Persisted video generation request has an invalid ${label}.`);
  }
  return parsed;
}

function isoTimestamp(value: Date | string, label: string): string {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Persisted video generation request has an invalid ${label}.`);
  }
  return new Date(parsed).toISOString();
}

function decode(row: Readonly<VideoGenerationRequestRow>): VideoGenerationRequestRecord {
  const record: VideoGenerationRequestRecord = {
    id: row.generation_request_id,
    tenantId: row.tenant_id,
    batchProjectId: row.batch_project_id,
    videoTaskId: row.video_task_id,
    actorAccountId: row.actor_account_id,
    requestId: row.request_id,
    taskRevision: safeInteger(row.task_revision, "task revision"),
    vehicleSnapshotId: row.vehicle_snapshot_id,
    assetSnapshotId: row.asset_snapshot_id,
    storyboardArtifactVersionId: row.storyboard_artifact_version_id,
    providerId: row.provider_id,
    ...(row.provider_job_id === null ? {} : { providerJobId: row.provider_job_id }),
    providerStatus: row.provider_status as VideoGenerationProviderStatus,
    outcomeStatus: row.outcome_status as "succeeded" | "failed",
    modelId: row.model_id,
    resolution: row.resolution as VideoGenerationRequestRecord["resolution"],
    aspectRatio: row.aspect_ratio as VideoGenerationRequestRecord["aspectRatio"],
    durationSeconds: safeInteger(row.duration_seconds, "duration"),
    promptText: row.prompt_text,
    promptSha256: row.prompt_sha256,
    requestedAt: isoTimestamp(row.requested_at, "request timestamp"),
    completedAt: isoTimestamp(row.completed_at, "completion timestamp"),
    chargedAmountMinor: safeInteger(row.charged_amount_minor, "charged amount"),
    currency: row.currency as "CNY",
    ...(row.media_artifact_id === null ? {} : { mediaArtifactId: row.media_artifact_id }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  };
  validateVideoGenerationRequestRecord(record);
  return structuredClone(record);
}

function same(left: Readonly<VideoGenerationRequestRecord>, right: Readonly<VideoGenerationRequestRecord>): boolean {
  const canonical = (value: Readonly<VideoGenerationRequestRecord>) => JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))),
  );
  return canonical(left) === canonical(right);
}

async function lock(transaction: PostgresQueryable, record: Readonly<VideoGenerationRequestRecord>) {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `video_generation_request:${record.tenantId}:${record.batchProjectId}:${record.videoTaskId}:${record.actorAccountId}:${record.requestId}`,
  ]);
}

export class PostgresVideoGenerationRequestStore implements VideoGenerationRequestStore {
  constructor(private readonly database: PostgresTransactionProvider) {}

  async create(
    record: Readonly<VideoGenerationRequestRecord>,
  ): Promise<VideoGenerationRequestCreateResult> {
    validateVideoGenerationRequestRecord(record);
    return this.database.transaction(async (transaction) => {
      await lock(transaction, record);
      const replay = await transaction.query<VideoGenerationRequestRow>(
        `SELECT ${columns}
           FROM video_generation_requests
          WHERE tenant_id = $1 AND batch_project_id = $2 AND video_task_id = $3
            AND actor_account_id = $4 AND request_id = $5`,
        [record.tenantId, record.batchProjectId, record.videoTaskId, record.actorAccountId, record.requestId],
      );
      if (replay.rows.length > 1) throw new Error("Duplicate video generation request history exists.");
      if (replay.rows[0] !== undefined) {
        const existing = decode(replay.rows[0]);
        if (!same(existing, record)) throw new VideoGenerationRequestConflictError();
        return { record: existing, replayed: true };
      }
      const result = await transaction.query<VideoGenerationRequestRow>(
        `INSERT INTO video_generation_requests (${columns})
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
         ) RETURNING ${columns}`,
        [
          record.id, record.tenantId, record.batchProjectId, record.videoTaskId,
          record.actorAccountId, record.requestId, record.taskRevision,
          record.vehicleSnapshotId, record.assetSnapshotId, record.storyboardArtifactVersionId,
          record.providerId, record.providerJobId ?? null, record.providerStatus,
          record.outcomeStatus, record.modelId, record.resolution, record.aspectRatio,
          record.durationSeconds, record.promptText, record.promptSha256, record.requestedAt,
          record.completedAt, record.chargedAmountMinor, record.currency,
          record.mediaArtifactId ?? null, record.failureCode ?? null,
        ],
      );
      if (result.rows.length !== 1 || result.rows[0] === undefined) {
        throw new Error("Video generation request history was not persisted.");
      }
      return { record: decode(result.rows[0]), replayed: false };
    });
  }

  async load(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
    generationRequestId: string,
  ): Promise<VideoGenerationRequestRecord | undefined> {
    const result = await this.database.query<VideoGenerationRequestRow>(
      `SELECT ${columns} FROM video_generation_requests
        WHERE tenant_id = $1 AND batch_project_id = $2 AND video_task_id = $3
          AND generation_request_id = $4`,
      [tenantId, batchProjectId, videoTaskId, generationRequestId],
    );
    if (result.rows.length > 1) throw new Error("Duplicate video generation request history exists.");
    return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
  }

  async list(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
  ): Promise<VideoGenerationRequestRecord[]> {
    const result = await this.database.query<VideoGenerationRequestRow>(
      `SELECT ${columns} FROM video_generation_requests
        WHERE tenant_id = $1 AND batch_project_id = $2 AND video_task_id = $3
        ORDER BY requested_at, generation_request_id`,
      [tenantId, batchProjectId, videoTaskId],
    );
    return result.rows.map(decode);
  }

  async loadByActorRequest(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
    actorAccountId: string,
    requestId: string,
  ): Promise<VideoGenerationRequestRecord | undefined> {
    const result = await this.database.query<VideoGenerationRequestRow>(
      `SELECT ${columns} FROM video_generation_requests
        WHERE tenant_id = $1 AND batch_project_id = $2 AND video_task_id = $3
          AND actor_account_id = $4 AND request_id = $5`,
      [tenantId, batchProjectId, videoTaskId, actorAccountId, requestId],
    );
    if (result.rows.length > 1) throw new Error("Duplicate video generation request history exists.");
    return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
  }
}
