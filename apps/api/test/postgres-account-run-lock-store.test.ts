import assert from "node:assert/strict";
import test from "node:test";

import type { AccountHighCostTaskRunLock } from "@firefly/schemas";

import type {
  PostgresQueryResult,
  PostgresQueryable,
  PostgresTransactionProvider,
} from "../src/postgres-contract.ts";
import { PostgresAccountRunLockStore } from "../src/postgres-account-run-lock-store.ts";

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

const lock = (): AccountHighCostTaskRunLock => ({
  id: "run_lock_1",
  tenantId: "tenant_firefly",
  accountId: "account_creator",
  batchProjectId: "project_launch",
  videoTaskId: "task_preview",
  taskRevision: 8,
  operation: "video_generation",
  acquiredAt: "2026-08-19T06:00:00.000Z",
});
const row = (value: AccountHighCostTaskRunLock, revision: number | string = 1) => ({
  tenant_id: value.tenantId,
  account_id: value.accountId,
  lock_id: value.id,
  batch_project_id: value.batchProjectId,
  video_task_id: value.videoTaskId,
  operation: value.operation,
  acquired_at: value.acquiredAt,
  revision,
  envelope: value,
});

test("postgres account run lock insert enforces one tenant/account slot", async () => {
  const postgres = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ revision: 1 }], rowCount: 1 },
  ]);
  const saved = await new PostgresAccountRunLockStore(postgres).transact(
    "tenant_firefly",
    "account_creator",
    () => lock(),
  );
  saved!.taskRevision = 99;

  assert.deepEqual(postgres.calls[0]!.parameters, [
    "account_run_lock:tenant_firefly:account_creator",
  ]);
  assert.match(postgres.calls[1]!.sql, /tenant_id = \$1 AND account_id = \$2 FOR UPDATE/u);
  assert.match(postgres.calls[2]!.sql, /ON CONFLICT \(tenant_id, account_id\) DO NOTHING/u);
  assert.deepEqual(postgres.calls[2]!.parameters.slice(0, 7), [
    "tenant_firefly",
    "account_creator",
    "run_lock_1",
    "project_launch",
    "task_preview",
    "video_generation",
    "2026-08-19T06:00:00.000Z",
  ]);
  assert.deepEqual(JSON.parse(postgres.calls[2]!.parameters[7] as string), lock());
});

test("postgres account run locks survive store restart and cross-check relational scope", async () => {
  const value = lock();
  const postgres = new FakePostgres([
    { rows: [row(value, 3)], rowCount: 1 },
    { rows: [row(value, 3)], rowCount: 1 },
  ]);
  const loaded = await new PostgresAccountRunLockStore(postgres).load(
    value.tenantId,
    value.accountId,
  );
  loaded!.taskRevision = 99;
  assert.deepEqual(
    await new PostgresAccountRunLockStore(postgres).load(value.tenantId, value.accountId),
    value,
  );

  const mismatched = new FakePostgres([{
    rows: [{ ...row(value), operation: "automatic_editing" }],
    rowCount: 1,
  }]);
  await assert.rejects(
    new PostgresAccountRunLockStore(mismatched).load(value.tenantId, value.accountId),
    /invalid relational scope/u,
  );
});

test("postgres account run lock accepts equivalent timestamp offsets", async () => {
  const value = {
    ...lock(),
    acquiredAt: "2026-08-19T14:00:00.000+08:00",
  };
  const postgres = new FakePostgres([{
    rows: [{ ...row(value), acquired_at: new Date("2026-08-19T06:00:00.000Z") }],
    rowCount: 1,
  }]);

  assert.deepEqual(
    await new PostgresAccountRunLockStore(postgres).load(value.tenantId, value.accountId),
    value,
  );
});

test("postgres account run lock rejects a timestamp for a different instant", async () => {
  const value = {
    ...lock(),
    acquiredAt: "2026-08-19T14:00:00.000+08:00",
  };
  const postgres = new FakePostgres([{
    rows: [{ ...row(value), acquired_at: "2026-08-19T07:00:00.000Z" }],
    rowCount: 1,
  }]);

  await assert.rejects(
    new PostgresAccountRunLockStore(postgres).load(value.tenantId, value.accountId),
    /invalid relational scope/u,
  );
});

test("postgres account run lock release deletes with revision CAS", async () => {
  const value = lock();
  const postgres = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [row(value, "4")], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  assert.equal(
    await new PostgresAccountRunLockStore(postgres).transact(
      value.tenantId,
      value.accountId,
      () => undefined,
    ),
    undefined,
  );
  assert.match(postgres.calls[2]!.sql, /DELETE FROM account_run_lock_states/u);
  assert.deepEqual(postgres.calls[2]!.parameters, [value.tenantId, value.accountId, "4"]);
});

test("postgres account run lock collision and invalid scope roll back atomically", async () => {
  const collision = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
  ]);
  await assert.rejects(
    new PostgresAccountRunLockStore(collision).transact(
      "tenant_firefly",
      "account_creator",
      () => lock(),
    ),
    /changed concurrently/u,
  );
  assert.equal(collision.rollbacks, 1);

  const invalid = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  await assert.rejects(
    new PostgresAccountRunLockStore(invalid).transact(
      "tenant_firefly",
      "account_creator",
      () => ({ ...lock(), accountId: "account_other" }),
    ),
    /cannot change its scope/u,
  );
  assert.equal(invalid.calls.length, 2);
  assert.equal(invalid.rollbacks, 1);
});
