import assert from "node:assert/strict";
import test from "node:test";

import type { PostgresQueryable, PostgresQueryResult, PostgresTransactionProvider } from "../src/postgres-contract.ts";
import { PostgresVideoGenerationRequestStore } from "../src/postgres-video-generation-request-store.ts";
import {
  VideoGenerationRequestConflictError,
  videoGenerationPromptSha256,
  type VideoGenerationRequestRecord,
} from "../src/video-generation-request-store.ts";

type Step = (sql: string, parameters: readonly unknown[]) => PostgresQueryResult<unknown>;

class ScriptedDatabase implements PostgresTransactionProvider {
  readonly calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  constructor(private readonly steps: Step[]) {}
  async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push({ sql: normalized, parameters });
    const step = this.steps.shift();
    assert.ok(step, `Unexpected query: ${normalized}`);
    return step(normalized, parameters) as PostgresQueryResult<Row>;
  }
  async transaction<Result>(operation: (transaction: PostgresQueryable) => Promise<Result>): Promise<Result> {
    return operation(this);
  }
  done() { assert.equal(this.steps.length, 0); }
}

const promptText = "Create the exact confirmed C10 launch video.";
type RecordOverrides = { [Key in keyof VideoGenerationRequestRecord]?: VideoGenerationRequestRecord[Key] | undefined };

function record(overrides: RecordOverrides = {}): VideoGenerationRequestRecord {
  const value = {
    id: "video_generation_request_1",
    tenantId: "tenant_firefly",
    batchProjectId: "project_c10",
    videoTaskId: "task_c10",
    actorAccountId: "account_creator",
    requestId: "request_generate_1",
    taskRevision: 9,
    vehicleSnapshotId: "vehicle_snapshot_1",
    assetSnapshotId: "asset_snapshot_1",
    storyboardArtifactVersionId: "storyboard_version_3",
    providerId: "volcengine_ark",
    providerJobId: "cgt_job_1",
    providerStatus: "succeeded",
    outcomeStatus: "succeeded",
    modelId: "doubao-seedance-2-5-260628",
    resolution: "720p",
    aspectRatio: "9:16",
    durationSeconds: 15,
    promptText,
    promptSha256: videoGenerationPromptSha256(promptText),
    requestedAt: "2026-08-21T02:00:00.000Z",
    completedAt: "2026-08-21T02:03:00.000Z",
    chargedAmountMinor: 2_000,
    currency: "CNY",
    mediaArtifactId: "media_artifact_1",
    ...overrides,
  } as VideoGenerationRequestRecord & Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) delete value[key];
  }
  return value;
}

function row(source = record()) {
  return {
    generation_request_id: source.id,
    tenant_id: source.tenantId,
    batch_project_id: source.batchProjectId,
    video_task_id: source.videoTaskId,
    actor_account_id: source.actorAccountId,
    request_id: source.requestId,
    task_revision: source.taskRevision,
    vehicle_snapshot_id: source.vehicleSnapshotId,
    asset_snapshot_id: source.assetSnapshotId,
    storyboard_artifact_version_id: source.storyboardArtifactVersionId,
    provider_id: source.providerId,
    provider_job_id: source.providerJobId ?? null,
    provider_status: source.providerStatus,
    outcome_status: source.outcomeStatus,
    model_id: source.modelId,
    resolution: source.resolution,
    aspect_ratio: source.aspectRatio,
    duration_seconds: source.durationSeconds,
    prompt_text: source.promptText,
    prompt_sha256: source.promptSha256,
    requested_at: new Date(source.requestedAt),
    completed_at: new Date(source.completedAt),
    charged_amount_minor: source.chargedAmountMinor,
    currency: source.currency,
    media_artifact_id: source.mediaArtifactId ?? null,
    failure_code: source.failureCode ?? null,
  };
}

const empty = { rows: [], rowCount: 0 };

test("video generation request history inserts the exact immutable prompt and terminal result", async () => {
  const source = record();
  const database = new ScriptedDatabase([
    (sql) => { assert.match(sql, /pg_advisory_xact_lock/u); return empty; },
    (sql) => { assert.match(sql, /FROM video_generation_requests/u); return empty; },
    (sql, parameters) => {
      assert.match(sql, /INSERT INTO video_generation_requests/u);
      assert.equal(parameters[18], promptText);
      assert.equal(parameters[19], videoGenerationPromptSha256(promptText));
      assert.equal(parameters[24], "media_artifact_1");
      return { rows: [row(source)], rowCount: 1 };
    },
  ]);
  const result = await new PostgresVideoGenerationRequestStore(database).create(source);
  assert.equal(result.replayed, false);
  assert.deepEqual(result.record, source);
  database.done();
});

test("video generation request history replays exact records and rejects request-id conflicts", async () => {
  const source = record();
  const replayDatabase = new ScriptedDatabase([
    () => empty,
    () => ({ rows: [row(source)], rowCount: 1 }),
  ]);
  const reordered = Object.fromEntries(Object.entries(source).reverse()) as unknown as VideoGenerationRequestRecord;
  assert.equal((await new PostgresVideoGenerationRequestStore(replayDatabase).create(reordered)).replayed, true);
  replayDatabase.done();

  const conflictDatabase = new ScriptedDatabase([
    () => empty,
    () => ({ rows: [row(source)], rowCount: 1 }),
  ]);
  await assert.rejects(
    () => new PostgresVideoGenerationRequestStore(conflictDatabase).create(record({ id: "video_generation_request_2" })),
    VideoGenerationRequestConflictError,
  );
  conflictDatabase.done();
});

test("failed generation history keeps the exact prompt without charge or fabricated media", async () => {
  const failed = record({
    providerJobId: undefined,
    providerStatus: "request_failed",
    outcomeStatus: "failed",
    chargedAmountMinor: 0,
    mediaArtifactId: undefined,
    failureCode: "AIC-VIDEO-PROVIDER_REJECTED",
  });
  const database = new ScriptedDatabase([
    () => empty,
    () => empty,
    () => ({ rows: [row(failed)], rowCount: 1 }),
  ]);
  const result = await new PostgresVideoGenerationRequestStore(database).create(failed);
  assert.deepEqual(result.record, failed);
  database.done();
});

test("generation history rejects changed prompt hashes and incomplete successful outcomes", async () => {
  const store = new PostgresVideoGenerationRequestStore(new ScriptedDatabase([]));
  await assert.rejects(() => store.create(record({ promptSha256: "a".repeat(64) })), /prompt or hash/u);
  await assert.rejects(
    () => store.create(record({ mediaArtifactId: undefined })),
    /Successful generation request is incomplete/u,
  );
});

test("generation history resolves an exact actor request for provider-call replay protection", async () => {
  const source = record();
  const database = new ScriptedDatabase([
    (sql, parameters) => {
      assert.match(sql, /actor_account_id = \$4 AND request_id = \$5/u);
      assert.deepEqual(parameters, [
        source.tenantId, source.batchProjectId, source.videoTaskId,
        source.actorAccountId, source.requestId,
      ]);
      return { rows: [row(source)], rowCount: 1 };
    },
  ]);
  const loaded = await new PostgresVideoGenerationRequestStore(database).loadByActorRequest(
    source.tenantId,
    source.batchProjectId,
    source.videoTaskId,
    source.actorAccountId,
    source.requestId,
  );
  assert.deepEqual(loaded, source);
  database.done();
});
