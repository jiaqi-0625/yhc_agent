import assert from "node:assert/strict";
import test from "node:test";

import type { MediaArtifact } from "@firefly/schemas";

import {
  MediaArtifactCreationConflictError,
  mediaArtifactContentHash,
  mediaArtifactContentReference,
  mediaArtifactObjectKey,
  validateMediaArtifactCreateCandidate,
  type MediaArtifactCreateCandidate,
  type MediaArtifactCreationMetadata,
} from "../src/media-artifact-store.ts";
import type {
  PostgresQueryable,
  PostgresQueryResult,
  PostgresTransactionProvider,
} from "../src/postgres-contract.ts";
import { PostgresMediaArtifactStore } from "../src/postgres-media-artifact-store.ts";

type Step = (
  sql: string,
  parameters: readonly unknown[],
) => PostgresQueryResult<unknown>;

class ScriptedDatabase implements PostgresTransactionProvider {
  readonly calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  transactions = 0;

  constructor(readonly steps: Step[]) {}

  async query<Row>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push({ sql: normalized, parameters });
    const step = this.steps.shift();
    assert.ok(step, `Unexpected query: ${normalized}`);
    return step(normalized, parameters) as PostgresQueryResult<Row>;
  }

  async transaction<Result>(
    operation: (transaction: PostgresQueryable) => Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    return operation(this);
  }

  done(): void {
    assert.equal(this.steps.length, 0, "all scripted SQL was issued");
  }
}

const empty = { rows: [], rowCount: 0 };

function candidate(
  overrides: Partial<MediaArtifactCreateCandidate["artifact"]> = {},
  storageOverrides: Partial<MediaArtifactCreateCandidate["storage"]> = {},
): MediaArtifactCreateCandidate {
  const artifact = {
    schemaVersion: 1,
    id: "media_preview_1",
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    videoTaskId: "task_launch",
    stage: "video_preview",
    role: "preview",
    mediaType: "video/mp4",
    byteSize: 12_345_678,
    checksumSha256: "a".repeat(64),
    width: 1920,
    height: 1080,
    durationMs: 30_000,
    createdAt: "2026-08-20T09:00:00.000Z",
    createdBy: "account_creator",
    ...overrides,
  } as MediaArtifactCreateCandidate["artifact"];
  return {
    artifact,
    storage: {
      providerId: "s3_primary",
      bucketName: "firefly-private",
      objectKey: mediaArtifactObjectKey({
        tenantId: artifact.tenantId,
        batchProjectId: artifact.batchProjectId,
        videoTaskId: artifact.videoTaskId,
        artifactId: artifact.id,
      }),
      objectVersion: "version-1",
      ...storageOverrides,
    },
  };
}

function creation(
  overrides: Partial<MediaArtifactCreationMetadata> = {},
): MediaArtifactCreationMetadata {
  return {
    actorAccountId: "account_creator",
    requestId: "request_register_preview_1",
    payloadHash: "b".repeat(64),
    ...overrides,
  };
}

function row(
  artifact: MediaArtifact,
  metadata: MediaArtifactCreationMetadata = creation(),
  source = candidate(),
) {
  return {
    artifact_id: artifact.id,
    tenant_id: artifact.tenantId,
    batch_project_id: artifact.batchProjectId,
    video_task_id: artifact.videoTaskId,
    stage: artifact.stage,
    role: artifact.role,
    artifact_version: artifact.version,
    media_type: artifact.mediaType,
    byte_size: artifact.byteSize,
    checksum_sha256: artifact.checksumSha256,
    width: artifact.width,
    height: artifact.height,
    duration_ms: artifact.durationMs,
    created_at: new Date(artifact.createdAt),
    created_by: artifact.createdBy,
    storage_provider_id: source.storage.providerId,
    storage_bucket_name: source.storage.bucketName,
    storage_object_key: source.storage.objectKey,
    storage_object_version: source.storage.objectVersion ?? null,
    creation_actor_account_id: metadata.actorAccountId,
    creation_request_id: metadata.requestId,
    creation_payload_hash: metadata.payloadHash,
    artifact,
  };
}

test("media artifact validator rejects URLs, traversal, non-ASCII, and reused path syntax", () => {
  for (const objectKey of [
    "https://media.invalid/video.mp4",
    "/absolute/video.mp4",
    "C:/absolute/video.mp4",
    "tenants/./video.mp4",
    "tenants/../video.mp4",
    "tenants//video.mp4",
    "tenants\\video.mp4",
    "tenants/video.mp4?signature=secret",
    "tenants/video.mp4#fragment",
    "tenants/视频.mp4",
    "tenants/video.mp4\n",
  ]) {
    assert.throws(
      () => validateMediaArtifactCreateCandidate(candidate({}, { objectKey })),
      /object key|storage locator/u,
      objectKey,
    );
  }
  assert.throws(
    () => validateMediaArtifactCreateCandidate(candidate({
      mediaType: "Video/MP4" as unknown as "video/mp4",
    })),
    /candidate/u,
  );
  assert.throws(
    () => validateMediaArtifactCreateCandidate({
      ...candidate(),
      publicUrl: "https://media.invalid/video.mp4",
    } as unknown as MediaArtifactCreateCandidate),
    /candidate/u,
  );
});

test("media artifact object keys are deterministic ASCII scope paths", () => {
  assert.equal(
    mediaArtifactObjectKey({
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      videoTaskId: "task_launch",
      artifactId: "media_preview_1",
    }),
    "v1/tenants/tenant_firefly/projects/project_launch/tasks/task_launch/artifacts/media_preview_1/media",
  );
  assert.throws(
    () => mediaArtifactObjectKey({
      tenantId: "tenant/escape",
      batchProjectId: "project_launch",
      videoTaskId: "task_launch",
      artifactId: "media_preview_1",
    }),
    /Tenant ID contains invalid characters/u,
  );
  assert.throws(
    () => validateMediaArtifactCreateCandidate(candidate({}, {
      objectKey: "v1/tenants/tenant_firefly/projects/project_other/tasks/task_launch/artifacts/media_preview_1/media",
    })),
    /does not match its immutable scope/u,
  );
});

test("public artifact content hash is canonical metadata and not the blob checksum", () => {
  const artifact = { ...candidate().artifact, version: 3 } as MediaArtifact;
  const reversed = Object.fromEntries(Object.entries(artifact).reverse()) as unknown as MediaArtifact;
  const hash = mediaArtifactContentHash(artifact);

  assert.equal(hash, mediaArtifactContentHash(reversed));
  assert.notEqual(hash, artifact.checksumSha256);
  assert.notEqual(
    hash,
    mediaArtifactContentHash({ ...artifact, byteSize: artifact.byteSize + 1 }),
  );
  assert.deepEqual(mediaArtifactContentReference(artifact), {
    artifactId: artifact.id,
    schemaName: "media_artifact",
    schemaVersion: 1,
    contentHashSha256: hash,
  });
});

test("PostgreSQL create allocates a scoped version under advisory locks and inserts parameters", async () => {
  const input = candidate();
  const metadata = creation();
  const database = new ScriptedDatabase([
    (sql, parameters) => {
      assert.match(sql, /pg_advisory_xact_lock/u);
      assert.match(String(parameters[0]), /^media-artifact-request:/u);
      return empty;
    },
    (sql, parameters) => {
      assert.match(sql, /creation_actor_account_id = \$4/u);
      assert.deepEqual(parameters, [
        "tenant_firefly",
        "project_launch",
        "task_launch",
        "account_creator",
        "request_register_preview_1",
      ]);
      return empty;
    },
    (sql, parameters) => {
      assert.match(sql, /pg_advisory_xact_lock/u);
      assert.deepEqual(parameters, [
        "media-artifact-version:tenant_firefly:project_launch:task_launch:video_preview:preview",
      ]);
      return empty;
    },
    (sql, parameters) => {
      assert.match(sql, /pg_advisory_xact_lock/u);
      assert.match(String(parameters[0]), /^media-artifact-id:/u);
      return empty;
    },
    (sql, parameters) => {
      assert.match(sql, /pg_advisory_xact_lock/u);
      assert.match(String(parameters[0]), /^media-artifact-object:/u);
      assert.doesNotMatch(String(parameters[0]), /version-1/u);
      return empty;
    },
    (sql, parameters) => {
      assert.match(sql, /storage_object_key = \$4/u);
      assert.doesNotMatch(sql, /storage_object_version IS NOT DISTINCT/u);
      assert.deepEqual(parameters, [
        input.artifact.id,
        input.storage.providerId,
        input.storage.bucketName,
        input.storage.objectKey,
      ]);
      return empty;
    },
    (sql, parameters) => {
      assert.match(sql, /MAX\(artifact_version\)/u);
      assert.deepEqual(parameters, [
        "tenant_firefly",
        "project_launch",
        "task_launch",
        "video_preview",
        "preview",
      ]);
      return { rows: [{ next_version: "3" }], rowCount: 1 };
    },
    (sql, parameters) => {
      assert.match(sql, /^INSERT INTO media_artifacts/u);
      assert.equal(parameters.length, 23);
      assert.equal(parameters[6], 3);
      assert.equal(parameters[17], input.storage.objectKey);
      assert.equal(parameters[21], metadata.payloadHash);
      const persisted = JSON.parse(parameters[22] as string) as MediaArtifact;
      assert.equal(persisted.version, 3);
      assert.equal("objectKey" in persisted, false);
      return { rows: [], rowCount: 1 };
    },
  ]);

  const result = await new PostgresMediaArtifactStore(database).createWithResult(input, metadata);
  assert.equal(result.replayed, false);
  assert.equal(result.record.artifact.version, 3);
  assert.equal("version" in input.artifact, false);
  (result.record.artifact as { mediaType: string }).mediaType = "video/webm";
  assert.equal(
    (JSON.parse(database.calls.at(-1)?.parameters[22] as string) as MediaArtifact).mediaType,
    "video/mp4",
  );
  assert.equal(database.transactions, 1);
  database.done();
});

test("PostgreSQL create replays the same payload and rejects a changed payload", async () => {
  const persisted = {
    ...candidate().artifact,
    version: 2,
  } as MediaArtifact;
  const replayRow = row(persisted);
  const replayDatabase = new ScriptedDatabase([
    () => empty,
    () => ({ rows: [replayRow], rowCount: 1 }),
  ]);
  const replay = await new PostgresMediaArtifactStore(replayDatabase).createWithResult(
    candidate({ id: "ignored_on_replay" }),
    creation(),
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.artifact.id, persisted.id);
  replayDatabase.done();

  const conflictDatabase = new ScriptedDatabase([
    () => empty,
    () => ({ rows: [replayRow], rowCount: 1 }),
  ]);
  await assert.rejects(
    new PostgresMediaArtifactStore(conflictDatabase).createWithResult(
      candidate(),
      creation({ payloadHash: "c".repeat(64) }),
    ),
    MediaArtifactCreationConflictError,
  );
  conflictDatabase.done();
});

test("PostgreSQL rejects reusing an object key even when the object version differs", async () => {
  const input = candidate({}, { objectVersion: "version-2" });
  const existing = row(
    { ...candidate().artifact, id: "media_existing", version: 1 } as MediaArtifact,
    creation({ requestId: "request_existing" }),
    candidate({}, { objectVersion: "version-1" }),
  );
  const database = new ScriptedDatabase([
    () => empty,
    () => empty,
    () => empty,
    () => empty,
    () => empty,
    () => ({ rows: [existing], rowCount: 1 }),
  ]);

  await assert.rejects(
    new PostgresMediaArtifactStore(database).createWithResult(input, creation()),
    (error: unknown) => error instanceof MediaArtifactCreationConflictError
      && /same object locator/u.test(error.message),
  );
  database.done();
});

test("PostgreSQL reads are fully scoped, parameterized, validated, and defensive", async () => {
  const persisted = { ...candidate().artifact, version: 4 } as MediaArtifact;
  const persistedRow = row(persisted);
  const database = new ScriptedDatabase([
    (sql, parameters) => {
      assert.match(sql, /tenant_id = \$1/u);
      assert.match(sql, /artifact_id = \$4/u);
      assert.doesNotMatch(sql, /tenant_firefly|media_preview_1/u);
      assert.deepEqual(parameters, [
        "tenant_firefly",
        "project_launch",
        "task_launch",
        "media_preview_1",
      ]);
      return { rows: [persistedRow], rowCount: 1 };
    },
    (sql, parameters) => {
      assert.match(sql, /stage = \$4/u);
      assert.match(sql, /role = \$5/u);
      assert.deepEqual(parameters, [
        "tenant_firefly",
        "project_launch",
        "task_launch",
        "video_preview",
        "preview",
      ]);
      return { rows: [persistedRow], rowCount: 1 };
    },
  ]);
  const store = new PostgresMediaArtifactStore(database);
  const loaded = await store.load(
    "tenant_firefly",
    "project_launch",
    "task_launch",
    "media_preview_1",
  );
  (loaded!.artifact as { mediaType: string }).mediaType = "video/webm";
  (loaded!.storage as { objectKey: string }).objectKey = "mutated/key.mp4";
  const listed = await store.list(
    "tenant_firefly",
    "project_launch",
    "task_launch",
    { stage: "video_preview", role: "preview" },
  );
  assert.equal(listed[0]?.artifact.mediaType, "video/mp4");
  assert.equal(listed[0]?.storage.objectKey, candidate().storage.objectKey);
  assert.equal(persisted.mediaType, "video/mp4");
  database.done();
});

test("PostgreSQL read rejects a JSON envelope outside relational scope", async () => {
  const persisted = { ...candidate().artifact, version: 1 } as MediaArtifact;
  const tampered = {
    ...row(persisted),
    tenant_id: "tenant_other",
  };
  const database = new ScriptedDatabase([
    () => ({ rows: [tampered], rowCount: 1 }),
  ]);

  await assert.rejects(
    new PostgresMediaArtifactStore(database).load(
      "tenant_firefly",
      "project_launch",
      "task_launch",
      "media_preview_1",
    ),
    /invalid format or scope/u,
  );
  database.done();
});

test("PostgreSQL read fails closed when relational media metadata and JSON diverge", async () => {
  const persisted = { ...candidate().artifact, version: 1 } as MediaArtifact;
  const relationalTamper = new ScriptedDatabase([
    () => ({
      rows: [{ ...row(persisted), byte_size: persisted.byteSize + 1 }],
      rowCount: 1,
    }),
  ]);
  await assert.rejects(
    new PostgresMediaArtifactStore(relationalTamper).load(
      "tenant_firefly",
      "project_launch",
      "task_launch",
      "media_preview_1",
    ),
    /invalid format or scope/u,
  );
  relationalTamper.done();

  const envelopeTamper = new ScriptedDatabase([
    () => ({
      rows: [{
        ...row(persisted),
        artifact: { ...persisted, checksumSha256: "d".repeat(64) },
      }],
      rowCount: 1,
    }),
  ]);
  await assert.rejects(
    new PostgresMediaArtifactStore(envelopeTamper).load(
      "tenant_firefly",
      "project_launch",
      "task_launch",
      "media_preview_1",
    ),
    /invalid format or scope/u,
  );
  envelopeTamper.done();
});

class SerialMediaDatabase implements PostgresTransactionProvider {
  readonly rows: ReturnType<typeof row>[] = [];
  readonly versionLocks: string[] = [];
  #tail: Promise<void> = Promise.resolve();

  async transaction<Result>(
    operation: (transaction: PostgresQueryable) => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await operation(this);
    } finally {
      release();
    }
  }

  async query<Row>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes("pg_advisory_xact_lock")) {
      const key = String(parameters[0]);
      if (key.startsWith("media-artifact-version:")) this.versionLocks.push(key);
      return empty as PostgresQueryResult<Row>;
    }
    if (sql.includes("creation_actor_account_id = $4")) {
      const found = this.rows.filter((item) =>
        item.tenant_id === parameters[0]
        && item.batch_project_id === parameters[1]
        && item.video_task_id === parameters[2]
        && item.creation_actor_account_id === parameters[3]
        && item.creation_request_id === parameters[4]);
      return { rows: found as Row[], rowCount: found.length };
    }
    if (sql.includes("SELECT artifact_id, storage_provider_id")) {
      const found = this.rows.filter((item) =>
        item.artifact_id === parameters[0]
        || (
          item.storage_provider_id === parameters[1]
          && item.storage_bucket_name === parameters[2]
          && item.storage_object_key === parameters[3]
        ));
      return { rows: found as Row[], rowCount: found.length };
    }
    if (sql.includes("MAX(artifact_version)")) {
      const versions = this.rows.filter((item) =>
        item.tenant_id === parameters[0]
        && item.batch_project_id === parameters[1]
        && item.video_task_id === parameters[2]
        && item.stage === parameters[3]
        && item.role === parameters[4])
        .map((item) => Number(item.artifact_version));
      const nextVersion = Math.max(0, ...versions) + 1;
      return { rows: [{ next_version: nextVersion } as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO media_artifacts")) {
      const artifact = JSON.parse(parameters[22] as string) as MediaArtifact;
      const metadata = {
        actorAccountId: String(parameters[19]),
        requestId: String(parameters[20]),
        payloadHash: String(parameters[21]),
      };
      const source = candidate({}, {
        providerId: String(parameters[15]),
        bucketName: String(parameters[16]),
        objectKey: String(parameters[17]),
        ...(parameters[18] === null ? {} : { objectVersion: String(parameters[18]) }),
      });
      this.rows.push(row(artifact, metadata, source));
      return { rows: [], rowCount: 1 };
    }
    assert.fail(`Unexpected query: ${sql}`);
  }
}

test("concurrent creates allocate distinct versions in the same task-stage-role scope", async () => {
  const database = new SerialMediaDatabase();
  const store = new PostgresMediaArtifactStore(database);
  const [first, second] = await Promise.all([
    store.createWithResult(candidate(), creation()),
    store.createWithResult(
      candidate(
        { id: "media_preview_2", createdAt: "2026-08-20T09:01:00.000Z" },
        {
          objectVersion: "version-2",
        },
      ),
      creation({ requestId: "request_register_preview_2", payloadHash: "c".repeat(64) }),
    ),
  ]);

  assert.deepEqual(
    [first.record.artifact.version, second.record.artifact.version].sort(),
    [1, 2],
  );
  assert.equal(new Set(database.versionLocks).size, 1);
  assert.equal(database.versionLocks.length, 2);
});
