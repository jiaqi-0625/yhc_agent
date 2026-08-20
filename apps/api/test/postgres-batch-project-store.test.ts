import assert from "node:assert/strict";
import test from "node:test";

import type { BatchProject, ProjectAssetPool } from "@firefly/schemas";

import type { PostgresQueryResult, PostgresQueryable, PostgresTransactionProvider } from "../src/postgres-contract.ts";
import { PostgresBatchProjectStore } from "../src/postgres-batch-project-store.ts";

type Step = (sql: string, parameters: readonly unknown[]) => PostgresQueryResult<unknown>;

class ScriptedDatabase implements PostgresTransactionProvider {
  readonly calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  transactions = 0;
  constructor(readonly steps: Step[]) {}
  async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    const step = this.steps.shift();
    assert.ok(step, `Unexpected query: ${sql}`);
    return step(sql.replace(/\s+/gu, " ").trim(), parameters) as PostgresQueryResult<Row>;
  }
  async transaction<Result>(operation: (transaction: PostgresQueryable) => Promise<Result>): Promise<Result> {
    this.transactions += 1;
    return operation(this);
  }
  done(): void { assert.equal(this.steps.length, 0, "all scripted SQL was issued"); }
}

function project(): BatchProject {
  return {
    id: "project_launch", tenantId: "tenant_firefly", brandId: "brand_firefly",
    vehicleId: "vehicle_e5", vehicleVersion: 1, name: "萤火 E5 9:16 夏季 上新", batchName: "夏季 上新",
    aspectRatio: "9:16", visualStylePresetId: "style_clean", assetPoolId: "pool_launch",
    status: "active", revision: 1, createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_creator", updatedAt: "2026-08-19T00:00:00.000Z", updatedBy: "account_creator",
  } as BatchProject;
}

function pool(): ProjectAssetPool {
  return {
    id: "pool_launch", tenantId: "tenant_firefly", batchProjectId: "project_launch", vehicleId: "vehicle_e5",
    revision: 1, assets: [{
      assetId: "asset_e5_hero", version: 1, category: "vehicle", source: "company_catalog",
      sourceProvider: "mock_company_assets", vehicleId: "vehicle_e5",
    }], createdAt: "2026-08-19T00:00:00.000Z", createdBy: "account_creator",
    updatedAt: "2026-08-19T00:00:00.000Z", updatedBy: "account_creator",
  };
}

const creation = { requestId: "request_launch", actorAccountId: "account_creator", payloadHash: "hash_v1" };
const aggregate = () => ({ ...creation, project: project(), assetPool: pool() });
const empty = { rows: [], rowCount: 0 };

test("PostgreSQL batch create locks its tenant scope and persists idempotency metadata atomically", async () => {
  const database = new ScriptedDatabase([
    (sql, parameters) => { assert.match(sql, /pg_advisory_xact_lock/u); assert.deepEqual(parameters, ["batch-project-create:tenant_firefly"]); return empty; },
    (sql) => { assert.match(sql, /creation_actor_account_id/u); return empty; },
    (sql) => { assert.match(sql, /project_id = \$2 OR normalized_name = \$3/u); return empty; },
    (sql, parameters) => {
      assert.match(sql, /^INSERT INTO batch_project_aggregates/u);
      assert.equal(parameters[2], "萤火 E5 9:16 夏季 上新");
      assert.equal(parameters[3], "account_creator");
      assert.deepEqual(JSON.parse(parameters[6] as string), aggregate());
      return { rows: [], rowCount: 1 };
    },
  ]);
  const saved = await new PostgresBatchProjectStore(database).create(project(), pool(), creation);
  saved.project.name = "mutated";
  assert.equal(project().name, "萤火 E5 9:16 夏季 上新");
  assert.equal(database.transactions, 1);
  database.done();
});
test("PostgreSQL batch create replays the same payload across different candidate IDs and rejects a changed payload", async () => {
  const replayRow = {
    project_id: "project_launch",
    aggregate: aggregate(),
    revision: 4,
    creation_payload_hash: "hash_v1",
  };
  const retryProject = {
    ...project(),
    id: "project_retry",
    assetPoolId: "pool_retry",
  };
  const retryPool = {
    ...pool(),
    id: "pool_retry",
    batchProjectId: "project_retry",
  };
  const replayDb = new ScriptedDatabase([
    () => empty,
    (sql) => {
      assert.match(sql, /^SELECT project_id, aggregate, revision, creation_payload_hash/u);
      return { rows: [replayRow], rowCount: 1 };
    },
  ]);
  const replayed = await new PostgresBatchProjectStore(replayDb).create(
    retryProject,
    retryPool,
    creation,
  );
  assert.equal(replayed.project.id, "project_launch");
  replayDb.done();

  const conflictDb = new ScriptedDatabase([
    () => empty,
    () => ({ rows: [replayRow], rowCount: 1 }),
  ]);
  await assert.rejects(
    new PostgresBatchProjectStore(conflictDb).create(
      retryProject,
      retryPool,
      { ...creation, payloadHash: "hash_v2" },
    ),
    /conflicts with a different payload/u,
  );
  conflictDb.done();
});

test("PostgreSQL batch replay rejects JSON outside the relational tenant and project scope", async () => {
  const tampered = aggregate();
  tampered.project = { ...tampered.project, tenantId: "tenant_other" };
  const database = new ScriptedDatabase([
    () => empty,
    () => ({
      rows: [{
        project_id: "project_launch",
        aggregate: tampered,
        revision: 4,
        creation_payload_hash: "hash_v1",
      }],
      rowCount: 1,
    }),
  ]);

  await assert.rejects(
    new PostgresBatchProjectStore(database).create(project(), pool(), creation),
    /invalid format or scope/u,
  );
  database.done();
});

test("PostgreSQL asset-pool transaction uses a row lock, tenant scope, and revision CAS", async () => {
  const database = new ScriptedDatabase([
    (sql, parameters) => {
      assert.match(sql, /WHERE tenant_id = \$1 AND project_id = \$2 FOR UPDATE/u);
      assert.deepEqual(parameters, ["tenant_firefly", "project_launch"]);
      return { rows: [{ aggregate: aggregate(), revision: "7" }], rowCount: 1 };
    },
    (sql, parameters) => {
      assert.match(sql, /WHERE tenant_id = \$1 AND project_id = \$2 AND revision = \$3/u);
      assert.equal(parameters[2], "7");
      assert.equal((JSON.parse(parameters[3] as string) as ReturnType<typeof aggregate>).assetPool.revision, 2);
      return { rows: [], rowCount: 1 };
    },
  ]);
  const updated = await new PostgresBatchProjectStore(database).transactAssetPool(
    "tenant_firefly", "project_launch", (current) => ({ ...current, revision: 2 }),
  );
  updated.revision = 99;
  assert.equal((JSON.parse(database.calls[1]!.parameters[3] as string) as ReturnType<typeof aggregate>).assetPool.revision, 2);
  database.done();
});

test("PostgreSQL batch reads stay tenant-scoped and return defensive JSON copies", async () => {
  const stored = aggregate();
  const database = new ScriptedDatabase([
    (sql, parameters) => { assert.match(sql, /tenant_id = \$1 AND project_id = \$2/u); assert.deepEqual(parameters, ["tenant_firefly", "project_launch"]); return { rows: [{ aggregate: stored, revision: 1 }], rowCount: 1 }; },
    (sql) => { assert.match(sql, /WHERE tenant_id = \$1 ORDER BY project_id/u); return { rows: [{ aggregate: stored, revision: 1 }], rowCount: 1 }; },
  ]);
  const store = new PostgresBatchProjectStore(database);
  const loaded = await store.load("tenant_firefly", "project_launch");
  loaded!.project.name = "mutated";
  const listed = await store.list("tenant_firefly");
  assert.equal(listed[0]!.project.name, project().name);
  database.done();
});
