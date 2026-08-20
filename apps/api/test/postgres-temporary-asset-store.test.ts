import assert from "node:assert/strict";
import test from "node:test";

import type { TemporaryAsset } from "@firefly/schemas";

import type {
  PostgresQueryResult,
  PostgresQueryable,
  PostgresTransactionProvider,
} from "../src/postgres-contract.ts";
import { PostgresTemporaryAssetStore } from "../src/postgres-temporary-asset-store.ts";

interface QueryCall { sql: string; parameters: readonly unknown[] }

class FakePostgres implements PostgresTransactionProvider {
  readonly calls: QueryCall[] = [];
  rollbacks = 0;
  constructor(private readonly responses: Array<PostgresQueryResult<unknown> | Error>) {}

  async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters: structuredClone(parameters) });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected query: ${sql}`);
    if (response instanceof Error) throw response;
    return response as PostgresQueryResult<Row>;
  }

  async transaction<Result>(operation: (transaction: PostgresQueryable) => Promise<Result>): Promise<Result> {
    try {
      return await operation(this);
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }
}

function asset(
  id = "temporary_asset_1",
  tenantId = "tenant_firefly",
  batchProjectId = "project_launch",
): TemporaryAsset {
  return {
    id,
    tenantId,
    batchProjectId,
    vehicleId: "vehicle_e5",
    version: 1,
    revision: 1,
    category: "vehicle",
    fileName: `${id}.png`,
    mediaType: "image/png",
    byteSize: 1024,
    width: 1920,
    height: 1080,
    checksumSha256: "a".repeat(64),
    sourceDescription: "Uploaded by the project producer.",
    rightsDeclaration: "Project usage rights confirmed.",
    rightsConfirmed: true,
    validationStatus: "valid",
    validationIssues: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_creator",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_creator",
  };
}

test("postgres temporary assets persist a tenant/project-scoped JSONB envelope", async () => {
  const postgres = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ revision: 1 }], rowCount: 1 },
  ]);
  const saved = await new PostgresTemporaryAssetStore(postgres).transactProject(
    "project_launch",
    () => [asset()],
  );
  saved[0]!.revision = 99;

  assert.deepEqual(postgres.calls[0]!.parameters, ["temporary_assets:project_launch"]);
  assert.match(postgres.calls[1]!.sql, /batch_project_id = \$1 FOR UPDATE/u);
  assert.deepEqual(postgres.calls[1]!.parameters, ["project_launch"]);
  assert.match(postgres.calls[2]!.sql, /ON CONFLICT \(batch_project_id\) DO NOTHING/u);
  assert.deepEqual(postgres.calls[2]!.parameters.slice(0, 2), [
    "tenant_firefly",
    "project_launch",
  ]);
  const envelope = JSON.parse(postgres.calls[2]!.parameters[2] as string) as {
    schemaVersion: number;
    batchProjectId: string;
    assets: TemporaryAsset[];
  };
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.batchProjectId, "project_launch");
  assert.equal(envelope.assets[0]!.revision, 1);
});
test("postgres temporary assets survive a new store and reject project or tenant crossover", async () => {
  const envelope = {
    schemaVersion: 1 as const,
    batchProjectId: "project_launch",
    assets: [asset()],
  };
  const postgres = new FakePostgres([
    {
      rows: [{ tenant_id: "tenant_firefly", batch_project_id: "project_launch", revision: 4, envelope }],
      rowCount: 1,
    },
    {
      rows: [{ tenant_id: "tenant_firefly", batch_project_id: "project_launch", revision: 4, envelope }],
      rowCount: 1,
    },
  ]);
  const loaded = await new PostgresTemporaryAssetStore(postgres).loadProject("project_launch");
  loaded[0]!.revision = 55;
  assert.equal(
    (await new PostgresTemporaryAssetStore(postgres).loadProject("project_launch"))[0]!.revision,
    1,
  );

  const wrongTenant = new FakePostgres([{
    rows: [{ tenant_id: "tenant_other", batch_project_id: "project_launch", revision: 1, envelope }],
    rowCount: 1,
  }]);
  await assert.rejects(
    new PostgresTemporaryAssetStore(wrongTenant).loadProject("project_launch"),
    /invalid tenant scope/u,
  );

  const wrongProjectEnvelope = { ...envelope, batchProjectId: "project_other" };
  const wrongProject = new FakePostgres([{
    rows: [{ tenant_id: "tenant_firefly", batch_project_id: "project_launch", revision: 1, envelope: wrongProjectEnvelope }],
    rowCount: 1,
  }]);
  await assert.rejects(
    new PostgresTemporaryAssetStore(wrongProject).loadProject("project_launch"),
    /invalid format or scope/u,
  );
});

test("postgres temporary asset transactions reject mixed tenants and CAS conflicts", async () => {
  const mixed = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  await assert.rejects(
    new PostgresTemporaryAssetStore(mixed).transactProject("project_launch", () => [
      asset("asset_a", "tenant_firefly"),
      asset("asset_b", "tenant_other"),
    ]),
    /cannot cross tenant scope/u,
  );
  assert.equal(mixed.rollbacks, 1);
  assert.equal(mixed.calls.length, 2);

  const currentEnvelope = {
    schemaVersion: 1 as const,
    batchProjectId: "project_launch",
    assets: [asset()],
  };
  const conflict = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [{ tenant_id: "tenant_firefly", batch_project_id: "project_launch", revision: "7", envelope: currentEnvelope }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  await assert.rejects(
    new PostgresTemporaryAssetStore(conflict).transactProject("project_launch", (value) => value),
    /changed concurrently/u,
  );
  assert.equal(conflict.calls[2]!.parameters[3], "7");
  assert.equal(conflict.rollbacks, 1);
});

test("postgres temporary assets do not persist an unscoped empty project", async () => {
  const postgres = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  assert.deepEqual(
    await new PostgresTemporaryAssetStore(postgres).transactProject(
      "project_launch",
      () => [],
    ),
    [],
  );
  assert.equal(postgres.calls.length, 2);
  assert.ok(postgres.calls.every((call) => !/^\s*(?:INSERT|UPDATE)\b/u.test(call.sql)));
});
