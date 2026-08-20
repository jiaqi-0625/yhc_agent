import assert from "node:assert/strict";
import test from "node:test";

import type {
  PostgresQueryResult,
  PostgresQueryable,
  PostgresTransactionProvider,
} from "../src/postgres-contract.ts";
import { PostgresWorkspaceAdminStore } from "../src/postgres-workspace-admin-store.ts";
import type { WorkspaceAdminState } from "../src/workspace-admin-store.ts";

interface QueryCall {
  sql: string;
  parameters: readonly unknown[];
}

class FakePostgres implements PostgresTransactionProvider {
  readonly calls: QueryCall[] = [];
  commits = 0;
  rollbacks = 0;
  readonly #responses: Array<PostgresQueryResult<unknown> | Error>;
  #tail: Promise<void> = Promise.resolve();

  constructor(...responses: Array<PostgresQueryResult<unknown> | Error>) {
    this.#responses = [...responses];
  }

  async query<Row>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters: structuredClone(parameters) });
    const response = this.#responses.shift();
    if (response === undefined) throw new Error(`Unexpected query: ${sql}`);
    if (response instanceof Error) throw response;
    return response as PostgresQueryResult<Row>;
  }

  async transaction<Result>(
    operation: (transaction: PostgresQueryable) => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#tail;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#tail = previous.then(() => gate);
    await previous;
    try {
      const result = await operation(this);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    } finally {
      release();
    }
  }
}

const emptyState = (tenantId: string): WorkspaceAdminState => ({
  schemaVersion: 1,
  tenantId,
  brands: [],
  vehicleVersions: [],
  vehicleAssetAssociations: [],
  accessGrants: [],
});
test("postgres workspace administration transaction is tenant-scoped and revision-guarded", async () => {
  const current = emptyState("tenant_firefly");
  const postgres = new FakePostgres(
    { rows: [], rowCount: 1 },
    { rows: [{ tenant_id: current.tenantId, revision: "7", state: current }], rowCount: 1 },
    { rows: [{ revision: "8" }], rowCount: 1 },
  );
  const store = new PostgresWorkspaceAdminStore(postgres);

  const saved = await store.transact("tenant_firefly", (snapshot) => {
    assert.notEqual(snapshot, current);
    return snapshot;
  });
  saved.brands.push({} as never);

  assert.equal(postgres.commits, 1);
  assert.match(postgres.calls[0]!.sql, /pg_advisory_xact_lock/u);
  assert.deepEqual(postgres.calls[0]!.parameters, ["workspace_admin:tenant_firefly"]);
  assert.match(postgres.calls[1]!.sql, /tenant_id = \$1 FOR UPDATE/u);
  assert.deepEqual(postgres.calls[1]!.parameters, ["tenant_firefly"]);
  assert.match(postgres.calls[2]!.sql, /tenant_id = \$1 AND revision = \$3/u);
  assert.equal(postgres.calls[2]!.parameters[0], "tenant_firefly");
  assert.equal(postgres.calls[2]!.parameters[2], "7");
  assert.deepEqual(JSON.parse(postgres.calls[2]!.parameters[1] as string), current);
});

test("postgres workspace administration rejects cross-tenant JSON and returns defensive snapshots", async () => {
  const wrong = emptyState("tenant_other");
  const malformed = new FakePostgres({
    rows: [{ tenant_id: "tenant_firefly", revision: 1, state: wrong }],
    rowCount: 1,
  });
  await assert.rejects(
    new PostgresWorkspaceAdminStore(malformed).load("tenant_firefly"),
    /invalid tenant scope/u,
  );

  const empty = new PostgresWorkspaceAdminStore(
    new FakePostgres(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ),
  );
  const first = await empty.load("tenant_firefly");
  first.brands.push({} as never);
  assert.deepEqual(await empty.load("tenant_firefly"), emptyState("tenant_firefly"));
  assert.deepEqual(await empty.listForAccount("tenant_firefly", "account_admin"), []);
});

test("postgres workspace administration rolls back updater failures before any write", async () => {
  const postgres = new FakePostgres(
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
  );
  const store = new PostgresWorkspaceAdminStore(postgres);
  await assert.rejects(
    store.transact("tenant_firefly", () => { throw new Error("update rejected"); }),
    /update rejected/u,
  );
  assert.equal(postgres.rollbacks, 1);
  assert.equal(postgres.calls.length, 2);
  assert.ok(postgres.calls.every((call) => !/^\s*(?:INSERT|UPDATE)\b/u.test(call.sql)));
});

test("postgres workspace administration reports optimistic write conflicts", async () => {
  const state = emptyState("tenant_firefly");
  const postgres = new FakePostgres(
    { rows: [], rowCount: 1 },
    { rows: [{ tenant_id: state.tenantId, revision: 2, state }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  );
  await assert.rejects(
    new PostgresWorkspaceAdminStore(postgres).transact("tenant_firefly", (value) => value),
    /changed concurrently/u,
  );
  assert.equal(postgres.rollbacks, 1);
});
