import type { MediaArtifact } from "@firefly/schemas";

import type {
  PostgresQueryable,
  PostgresTransactionProvider,
} from "./postgres-contract.ts";
import {
  MediaArtifactCreationConflictError,
  assertMediaArtifactIdentifier,
  validateMediaArtifactCreateCandidate,
  validateMediaArtifactCreationMetadata,
  validateMediaArtifactListFilter,
  validateMediaArtifactRecord,
  type MediaArtifactCreateCandidate,
  type MediaArtifactCreateResult,
  type MediaArtifactCreationMetadata,
  type MediaArtifactListFilter,
  type MediaArtifactRecord,
  type MediaArtifactStore,
  type MediaArtifactStorage,
} from "./media-artifact-store.ts";

interface MediaArtifactRow {
  artifact_id: string;
  tenant_id: string;
  batch_project_id: string;
  video_task_id: string;
  stage: string;
  role: string;
  artifact_version: number | string;
  media_type: string;
  byte_size: number | string;
  checksum_sha256: string;
  width: number | string;
  height: number | string;
  duration_ms: number | string;
  created_at: Date | string;
  created_by: string;
  storage_provider_id: string;
  storage_bucket_name: string;
  storage_object_key: string;
  storage_object_version: string | null;
  creation_actor_account_id: string;
  creation_request_id: string;
  creation_payload_hash: string;
  artifact: unknown;
}

interface VersionRow {
  next_version: number | string;
}

interface ConflictRow {
  artifact_id: string;
  storage_provider_id: string;
  storage_bucket_name: string;
  storage_object_key: string;
  storage_object_version: string | null;
}

interface PostgresErrorLike {
  code?: unknown;
  constraint?: unknown;
}

const selectColumns = `artifact_id, tenant_id, batch_project_id, video_task_id,
  stage, role, artifact_version, media_type, byte_size, checksum_sha256, width,
  height, duration_ms, created_at, created_by, storage_provider_id,
  storage_bucket_name, storage_object_key, storage_object_version,
  creation_actor_account_id, creation_request_id, creation_payload_hash, artifact`;

function positiveSafeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Persisted media artifact has an invalid ${label}.`);
  }
  return parsed;
}

function timestamp(value: Date | string, label: string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Persisted media artifact has an invalid ${label}.`);
  }
  return parsed;
}

function decodeRow(
  row: Readonly<MediaArtifactRow>,
  expected?: Readonly<{
    tenantId: string;
    batchProjectId: string;
    videoTaskId: string;
    artifactId?: string;
  }>,
): MediaArtifactRecord {
  const decoded = typeof row.artifact === "string"
    ? JSON.parse(row.artifact) as unknown
    : row.artifact;
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("Persisted media artifact has an invalid format or scope.");
  }
  const artifact = structuredClone(decoded) as MediaArtifact;
  const storage: MediaArtifactStorage = {
    providerId: row.storage_provider_id,
    bucketName: row.storage_bucket_name,
    objectKey: row.storage_object_key,
    ...(row.storage_object_version === null
      ? {}
      : { objectVersion: row.storage_object_version }),
  };
  const record: MediaArtifactRecord = {
    artifact,
    storage,
    creation: {
      actorAccountId: row.creation_actor_account_id,
      requestId: row.creation_request_id,
      payloadHash: row.creation_payload_hash,
    },
  };
  const relationalVersion = positiveSafeInteger(row.artifact_version, "version");
  const relationalByteSize = positiveSafeInteger(row.byte_size, "byte size");
  const relationalWidth = positiveSafeInteger(row.width, "width");
  const relationalHeight = positiveSafeInteger(row.height, "height");
  const relationalDurationMs = positiveSafeInteger(row.duration_ms, "duration");
  if (
    artifact.id !== row.artifact_id
    || artifact.tenantId !== row.tenant_id
    || artifact.batchProjectId !== row.batch_project_id
    || artifact.videoTaskId !== row.video_task_id
    || artifact.stage !== row.stage
    || artifact.role !== row.role
    || artifact.version !== relationalVersion
    || artifact.mediaType !== row.media_type
    || artifact.byteSize !== relationalByteSize
    || artifact.checksumSha256 !== row.checksum_sha256
    || artifact.width !== relationalWidth
    || artifact.height !== relationalHeight
    || artifact.durationMs !== relationalDurationMs
    || timestamp(artifact.createdAt, "artifact creation timestamp")
      !== timestamp(row.created_at, "relational creation timestamp")
    || artifact.createdBy !== row.created_by
  ) {
    throw new Error("Persisted media artifact has an invalid format or scope.");
  }
  validateMediaArtifactRecord(record, expected);
  return structuredClone(record);
}

function assertScopeIdentifiers(
  tenantId: string,
  batchProjectId: string,
  videoTaskId: string,
): void {
  assertMediaArtifactIdentifier(tenantId, "Tenant ID");
  assertMediaArtifactIdentifier(batchProjectId, "Batch project ID");
  assertMediaArtifactIdentifier(videoTaskId, "Video task ID");
}

async function advisoryLock(
  transaction: PostgresQueryable,
  key: string,
): Promise<void> {
  await transaction.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [key],
  );
}

function sameStorage(
  row: Readonly<ConflictRow>,
  storage: Readonly<MediaArtifactStorage>,
): boolean {
  return row.storage_provider_id === storage.providerId
    && row.storage_bucket_name === storage.bucketName
    && row.storage_object_key === storage.objectKey;
}

function postgresError(error: unknown): PostgresErrorLike {
  return typeof error === "object" && error !== null ? error as PostgresErrorLike : {};
}

export class PostgresMediaArtifactStore implements MediaArtifactStore {
  constructor(readonly database: PostgresTransactionProvider) {}

  async load(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
    artifactId: string,
  ): Promise<MediaArtifactRecord | undefined> {
    assertScopeIdentifiers(tenantId, batchProjectId, videoTaskId);
    assertMediaArtifactIdentifier(artifactId, "Media artifact ID");
    const result = await this.database.query<MediaArtifactRow>(
      `SELECT ${selectColumns}
         FROM media_artifacts
        WHERE tenant_id = $1
          AND batch_project_id = $2
          AND video_task_id = $3
          AND artifact_id = $4`,
      [tenantId, batchProjectId, videoTaskId, artifactId],
    );
    if (result.rows.length > 1) {
      throw new Error("Persisted media artifacts contain a duplicate artifact ID.");
    }
    return result.rows[0] === undefined
      ? undefined
      : decodeRow(result.rows[0], { tenantId, batchProjectId, videoTaskId, artifactId });
  }

  async list(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
    filter: Readonly<MediaArtifactListFilter> = {},
  ): Promise<MediaArtifactRecord[]> {
    assertScopeIdentifiers(tenantId, batchProjectId, videoTaskId);
    validateMediaArtifactListFilter(filter);
    const parameters: unknown[] = [tenantId, batchProjectId, videoTaskId];
    const conditions = [
      "tenant_id = $1",
      "batch_project_id = $2",
      "video_task_id = $3",
    ];
    if (filter.stage !== undefined) {
      parameters.push(filter.stage);
      conditions.push(`stage = $${parameters.length}`);
    }
    if (filter.role !== undefined) {
      parameters.push(filter.role);
      conditions.push(`role = $${parameters.length}`);
    }
    const result = await this.database.query<MediaArtifactRow>(
      `SELECT ${selectColumns}
         FROM media_artifacts
        WHERE ${conditions.join(" AND ")}
        ORDER BY stage, role, artifact_version, artifact_id`,
      parameters,
    );
    return result.rows.map((row) => decodeRow(row, {
      tenantId,
      batchProjectId,
      videoTaskId,
    }));
  }

  async createWithResult(
    candidate: Readonly<MediaArtifactCreateCandidate>,
    metadata: Readonly<MediaArtifactCreationMetadata>,
  ): Promise<MediaArtifactCreateResult> {
    validateMediaArtifactCreateCandidate(candidate);
    validateMediaArtifactCreationMetadata(metadata);
    const input = structuredClone(candidate);
    const creation = structuredClone(metadata);
    const { artifact: unversioned, storage } = input;
    const { tenantId, batchProjectId, videoTaskId, stage, role } = unversioned;
    assertScopeIdentifiers(tenantId, batchProjectId, videoTaskId);
    if (unversioned.createdBy !== creation.actorAccountId) {
      throw new Error("Media artifact creator does not match creation metadata.");
    }

    return this.database.transaction(async (transaction) => {
      await advisoryLock(
        transaction,
        `media-artifact-request:${tenantId}:${batchProjectId}:${videoTaskId}:${creation.actorAccountId}:${creation.requestId}`,
      );
      const replayResult = await transaction.query<MediaArtifactRow>(
        `SELECT ${selectColumns}
           FROM media_artifacts
          WHERE tenant_id = $1
            AND batch_project_id = $2
            AND video_task_id = $3
            AND creation_actor_account_id = $4
            AND creation_request_id = $5`,
        [
          tenantId,
          batchProjectId,
          videoTaskId,
          creation.actorAccountId,
          creation.requestId,
        ],
      );
      if (replayResult.rows.length > 1) {
        throw new Error("Persisted media artifacts contain duplicate creation requests.");
      }
      const replayRow = replayResult.rows[0];
      if (replayRow !== undefined) {
        if (replayRow.creation_payload_hash !== creation.payloadHash) {
          throw new MediaArtifactCreationConflictError();
        }
        return {
          record: decodeRow(replayRow, { tenantId, batchProjectId, videoTaskId }),
          replayed: true,
        };
      }

      await advisoryLock(
        transaction,
        `media-artifact-version:${tenantId}:${batchProjectId}:${videoTaskId}:${stage}:${role}`,
      );
      const identityLocks = [
        `media-artifact-id:${unversioned.id}`,
        `media-artifact-object:${storage.providerId}:${storage.bucketName}:${storage.objectKey}`,
      ].sort();
      for (const key of identityLocks) await advisoryLock(transaction, key);

      const conflicts = await transaction.query<ConflictRow>(
        `SELECT artifact_id, storage_provider_id, storage_bucket_name,
                storage_object_key, storage_object_version
           FROM media_artifacts
          WHERE artifact_id = $1
             OR (
               storage_provider_id = $2
               AND storage_bucket_name = $3
               AND storage_object_key = $4
             )`,
        [
          unversioned.id,
          storage.providerId,
          storage.bucketName,
          storage.objectKey,
        ],
      );
      if (conflicts.rows.some((row) => row.artifact_id === unversioned.id)) {
        throw new MediaArtifactCreationConflictError(
          "A media artifact with the same ID already exists.",
        );
      }
      if (conflicts.rows.some((row) => sameStorage(row, storage))) {
        throw new MediaArtifactCreationConflictError(
          "A media artifact with the same object locator already exists.",
        );
      }

      const versionResult = await transaction.query<VersionRow>(
        `SELECT COALESCE(MAX(artifact_version), 0) + 1 AS next_version
           FROM media_artifacts
          WHERE tenant_id = $1
            AND batch_project_id = $2
            AND video_task_id = $3
            AND stage = $4
            AND role = $5`,
        [tenantId, batchProjectId, videoTaskId, stage, role],
      );
      const versionRow = versionResult.rows[0];
      if (versionRow === undefined) {
        throw new Error("Media artifact version allocation failed.");
      }
      const artifact = {
        ...unversioned,
        version: positiveSafeInteger(versionRow.next_version, "allocated version"),
      } as MediaArtifact;
      const record: MediaArtifactRecord = { artifact, storage, creation };
      validateMediaArtifactRecord(record, { tenantId, batchProjectId, videoTaskId });

      try {
        const inserted = await transaction.query(
          `INSERT INTO media_artifacts (
             artifact_id, tenant_id, batch_project_id, video_task_id, stage, role,
             artifact_version, media_type, byte_size, checksum_sha256, width,
             height, duration_ms, created_at, created_by, storage_provider_id,
             storage_bucket_name, storage_object_key, storage_object_version,
             creation_actor_account_id, creation_request_id,
             creation_payload_hash, artifact
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb
           )`,
          [
            artifact.id,
            artifact.tenantId,
            artifact.batchProjectId,
            artifact.videoTaskId,
            artifact.stage,
            artifact.role,
            artifact.version,
            artifact.mediaType,
            artifact.byteSize,
            artifact.checksumSha256,
            artifact.width,
            artifact.height,
            artifact.durationMs,
            artifact.createdAt,
            artifact.createdBy,
            storage.providerId,
            storage.bucketName,
            storage.objectKey,
            storage.objectVersion ?? null,
            creation.actorAccountId,
            creation.requestId,
            creation.payloadHash,
            JSON.stringify(artifact),
          ],
        );
        if (inserted.rowCount !== 1) {
          throw new Error("Media artifact insert did not persist exactly one record.");
        }
      } catch (error: unknown) {
        const databaseError = postgresError(error);
        if (databaseError.code === "23505") {
          throw new MediaArtifactCreationConflictError(
            "Media artifact identity, object locator, request, or version already exists.",
          );
        }
        if (databaseError.code === "23503") {
          throw new Error("Media artifact task scope does not exist.");
        }
        throw error;
      }
      return { record: structuredClone(record), replayed: false };
    });
  }
}
