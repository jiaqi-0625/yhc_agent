import assert from "node:assert/strict";
import test from "node:test";

import type { VideoTaskProductionRecord } from "@firefly/domain";

import type { PostgresQueryResult, PostgresQueryable, PostgresTransactionProvider } from "../src/postgres-contract.ts";
import { PostgresVideoTaskProductionStore } from "../src/postgres-video-task-store.ts";

type Step = (sql: string, parameters: readonly unknown[]) => PostgresQueryResult<unknown>;
class ScriptedDatabase implements PostgresTransactionProvider {
  readonly calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  constructor(readonly steps: Step[]) {}
  async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    const step = this.steps.shift(); assert.ok(step, `Unexpected query: ${sql}`);
    return step(sql.replace(/\s+/gu, " ").trim(), parameters) as PostgresQueryResult<Row>;
  }
  async transaction<Result>(operation: (transaction: PostgresQueryable) => Promise<Result>): Promise<Result> { return operation(this); }
  done(): void { assert.equal(this.steps.length, 0); }
}

function record(id = "task_launch", name = "首发 主片"): VideoTaskProductionRecord {
  return {
    schemaVersion: 7,
    videoTask: {
      id, tenantId: "tenant_firefly", batchProjectId: "project_launch", name,
      ownerAccountId: "account_creator", status: "active", currentStage: "strategy", stageStatus: "in_progress",
      revision: 1, audience: "城市家庭", theme: "夏季上市", durationSeconds: 30, platformTags: ["douyin"],
      createdAt: "2026-08-19T08:00:00.000Z", createdBy: "account_creator",
      updatedAt: "2026-08-19T08:00:00.000Z", updatedBy: "account_creator",
    },
    stageArtifactVersions: [], stageConfirmations: [], activeStageArtifactVersionIds: {}, stageRollbacks: [],
    stageArtifactInvalidations: [], ownershipTransfers: [], taskAssetSnapshots: [], taskVehicleSnapshots: [],
    strategyDrafts: [], stageConfirmationRequests: [], commandReceipts: [],
    stageMutationReceipts: [],
  } as unknown as VideoTaskProductionRecord;
}

function recordWithOwnershipTransfer(): VideoTaskProductionRecord {
  const value = record();
  value.videoTask = {
    ...value.videoTask,
    ownerAccountId: "account_successor",
    revision: 2,
  };
  value.ownershipTransfers = [{
    id: "ownership_transfer_launch",
    tenantId: value.videoTask.tenantId,
    batchProjectId: value.videoTask.batchProjectId,
    videoTaskId: value.videoTask.id,
    fromOwnerAccountId: "account_creator",
    toOwnerAccountId: "account_successor",
    expectedTaskRevision: 1,
    reason: "正常工作交接",
    source: "human_action",
    actorAccountId: "account_admin",
    occurredAt: "2026-08-19T08:01:00.000Z",
  }];
  return value;
}
const creation = { requestId: "request_launch", actorAccountId: "account_creator", payloadHash: "hash_v1" };
const row = (value = record()) => ({ task_id: value.videoTask.id, tenant_id: value.videoTask.tenantId, project_id: value.videoTask.batchProjectId, aggregate: value, revision: "3", creation_actor_account_id: creation.actorAccountId, creation_request_id: creation.requestId, creation_payload_hash: creation.payloadHash });
const empty = { rows: [], rowCount: 0 };

test("PostgreSQL video create serializes a project scope and writes creation metadata", async () => {
  const database = new ScriptedDatabase([
    (sql, parameters) => { assert.match(sql, /pg_advisory_xact_lock/u); assert.deepEqual(parameters, ["video-task-create:tenant_firefly:project_launch"]); return empty; },
    (sql) => { assert.match(sql, /creation_request_id = \$4/u); return empty; },
    (sql, parameters) => { assert.match(sql, /pg_advisory_xact_lock/u); assert.deepEqual(parameters, ["video-task:task_launch"]); return empty; },
    (sql) => { assert.match(sql, /task_id = \$1 OR \(tenant_id = \$2/u); return empty; },
    (sql, parameters) => {
      assert.match(sql, /^INSERT INTO video_task_aggregates/u);
      assert.equal(parameters[3], "首发 主片");
      assert.deepEqual(parameters.slice(4, 7), ["account_creator", "request_launch", "hash_v1"]);
      return { rows: [], rowCount: 1 };
    },
  ]);
  const result = await new PostgresVideoTaskProductionStore(database).createWithResult(record(), creation);
  assert.equal(result.replayed, false);
  result.record.videoTask.name = "mutated";
  assert.equal(record().videoTask.name, "首发 主片");
  database.done();
});

test("PostgreSQL video create reports replay and payload conflict without inserting", async () => {
  const replayDb = new ScriptedDatabase([() => empty, () => ({ rows: [row()], rowCount: 1 })]);
  const replay = await new PostgresVideoTaskProductionStore(replayDb).createWithResult(record("task_retry"), creation);
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.videoTask.id, "task_launch");
  replayDb.done();

  const conflictDb = new ScriptedDatabase([() => empty, () => ({ rows: [row()], rowCount: 1 })]);
  await assert.rejects(
    new PostgresVideoTaskProductionStore(conflictDb).create(record("task_retry"), { ...creation, payloadHash: "hash_v2" }),
    /conflicts with a different payload/u,
  );
  conflictDb.done();
});

test("PostgreSQL video transaction holds an advisory and row lock then updates with revision CAS", async () => {
  const database = new ScriptedDatabase([
    (sql, parameters) => { assert.match(sql, /pg_advisory_xact_lock/u); assert.deepEqual(parameters, ["video-task:task_launch"]); return empty; },
    (sql) => { assert.match(sql, /task_id = \$1 FOR UPDATE/u); return { rows: [row()], rowCount: 1 }; },
    (sql, parameters) => {
      assert.match(sql, /WHERE task_id = \$1 AND revision = \$2/u);
      assert.equal(parameters[1], "3");
      assert.equal((JSON.parse(parameters[3] as string) as VideoTaskProductionRecord).videoTask.revision, 2);
      return { rows: [], rowCount: 1 };
    },
  ]);
  const updated = await new PostgresVideoTaskProductionStore(database).transact("task_launch", (current) => ({
    ...current!, videoTask: { ...current!.videoTask, revision: 2 },
  }));
  updated.videoTask.revision = 99;
  assert.equal((JSON.parse(database.calls[2]!.parameters[3] as string) as VideoTaskProductionRecord).videoTask.revision, 2);
  database.done();
});

test("PostgreSQL video transaction rejects a business revision jump", async () => {
  const database = new ScriptedDatabase([
    () => empty,
    () => ({ rows: [row()], rowCount: 1 }),
  ]);

  await assert.rejects(
    new PostgresVideoTaskProductionStore(database).transact("task_launch", (current) => ({
      ...current!,
      videoTask: { ...current!.videoTask, revision: current!.videoTask.revision + 2 },
    })),
    /must increment its revision exactly once/u,
  );
  database.done();
});

test("PostgreSQL video transaction rejects rewriting immutable history", async () => {
  const current = recordWithOwnershipTransfer();
  const database = new ScriptedDatabase([
    () => empty,
    () => ({ rows: [row(current)], rowCount: 1 }),
  ]);

  await assert.rejects(
    new PostgresVideoTaskProductionStore(database).transact("task_launch", (stored) => {
      const next = structuredClone(stored!);
      next.videoTask.revision += 1;
      next.ownershipTransfers[0]!.reason = "篡改后的交接原因";
      return next;
    }),
    /cannot rewrite immutable ownership transfer history/u,
  );
  database.done();
});

test("PostgreSQL video list applies tenant/project filters and load returns a defensive copy", async () => {
  const stored = record();
  const database = new ScriptedDatabase([
    (sql, parameters) => { assert.match(sql, /WHERE task_id = \$1/u); assert.deepEqual(parameters, ["task_launch"]); return { rows: [row(stored)], rowCount: 1 }; },
    (sql, parameters) => { assert.match(sql, /tenant_id = \$1 AND project_id = \$2 ORDER BY task_id/u); assert.deepEqual(parameters, ["tenant_firefly", "project_launch"]); return { rows: [row(stored)], rowCount: 1 }; },
  ]);
  const store = new PostgresVideoTaskProductionStore(database);
  const loaded = await store.load("task_launch"); loaded!.videoTask.name = "mutated";
  assert.equal((await store.list("tenant_firefly", "project_launch"))[0]!.videoTask.name, "首发 主片");
  database.done();
});

test("PostgreSQL video CAS failure is rejected instead of silently overwriting", async () => {
  const database = new ScriptedDatabase([
    () => empty,
    () => ({ rows: [row()], rowCount: 1 }),
    () => ({ rows: [], rowCount: 0 }),
  ]);
  await assert.rejects(
    new PostgresVideoTaskProductionStore(database).transact("task_launch", (current) => current!),
    /compare-and-swap/u,
  );
  database.done();
});

test("PostgreSQL video save rejects a stale business revision", async () => {
  const current = record();
  current.videoTask.revision = 3;
  const stale = record();
  stale.videoTask.revision = 2;
  stale.videoTask.name = "stale overwrite";
  const database = new ScriptedDatabase([
    () => empty,
    () => ({ rows: [row(current)], rowCount: 1 }),
  ]);

  await assert.rejects(
    new PostgresVideoTaskProductionStore(database).save(stale),
    /exactly one revision/u,
  );
  database.done();
});
