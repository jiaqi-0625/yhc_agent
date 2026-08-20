import assert from "node:assert/strict";
import test from "node:test";

import type { AccountBudget } from "@firefly/schemas";

import type {
  PostgresQueryResult,
  PostgresQueryable,
  PostgresTransactionProvider,
} from "../src/postgres-contract.ts";
import { PostgresAccountBudgetStore } from "../src/postgres-account-budget-store.ts";

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

const budget = (tenantId = "tenant_firefly", accountId = "account_creator"): AccountBudget => ({
  schemaVersion: 1,
  id: "budget_creator",
  tenantId,
  accountId,
  currency: "CNY",
  limitAmountMinor: 20_000,
  revision: 1,
  entries: [],
  createdAt: "2026-08-19T06:00:00.000Z",
  createdBy: "account_admin",
  updatedAt: "2026-08-19T06:00:00.000Z",
  updatedBy: "account_admin",
});
test("postgres account budget insert uses composite tenant/account scope", async () => {
  const postgres = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ revision: 1 }], rowCount: 1 },
  ]);
  const saved = await new PostgresAccountBudgetStore(postgres).transact(
    "tenant_firefly",
    "account_creator",
    (current) => {
      assert.equal(current, undefined);
      return budget();
    },
  );
  saved.entries.push({} as never);

  assert.deepEqual(postgres.calls[0]!.parameters, [
    "account_budget:tenant_firefly:account_creator",
  ]);
  assert.match(postgres.calls[1]!.sql, /tenant_id = \$1 AND account_id = \$2 FOR UPDATE/u);
  assert.deepEqual(postgres.calls[1]!.parameters, ["tenant_firefly", "account_creator"]);
  assert.match(postgres.calls[2]!.sql, /ON CONFLICT \(tenant_id, account_id\) DO NOTHING/u);
  assert.deepEqual(postgres.calls[2]!.parameters.slice(0, 2), [
    "tenant_firefly",
    "account_creator",
  ]);
  assert.deepEqual(JSON.parse(postgres.calls[2]!.parameters[2] as string), budget());
});

test("postgres account budget validates relational and JSON scope and returns copies", async () => {
  const value = budget();
  const postgres = new FakePostgres([
    { rows: [{ tenant_id: value.tenantId, account_id: value.accountId, revision: 3, state: value }], rowCount: 1 },
    { rows: [{ tenant_id: value.tenantId, account_id: value.accountId, revision: 3, state: value }], rowCount: 1 },
  ]);
  const store = new PostgresAccountBudgetStore(postgres);
  const loaded = await store.load(value.tenantId, value.accountId);
  loaded!.entries.push({} as never);
  assert.deepEqual(await store.load(value.tenantId, value.accountId), value);

  const wrong = new FakePostgres([
    { rows: [{ tenant_id: "tenant_firefly", account_id: "account_creator", revision: 1, state: budget("tenant_other") }], rowCount: 1 },
  ]);
  await assert.rejects(
    new PostgresAccountBudgetStore(wrong).load("tenant_firefly", "account_creator"),
    /invalid format or scope/u,
  );
});

test("postgres account budget aborts invalid writes and optimistic conflicts", async () => {
  const invalid = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  await assert.rejects(
    new PostgresAccountBudgetStore(invalid).transact(
      "tenant_firefly",
      "account_creator",
      () => budget("tenant_other"),
    ),
    /invalid format or scope/u,
  );
  assert.equal(invalid.rollbacks, 1);
  assert.equal(invalid.calls.length, 2);

  const current = budget();
  const conflict = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [{ tenant_id: current.tenantId, account_id: current.accountId, revision: "4", state: current }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  await assert.rejects(
    new PostgresAccountBudgetStore(conflict).transact(
      current.tenantId,
      current.accountId,
      (value) => value!,
    ),
    /changed concurrently/u,
  );
  assert.equal(conflict.calls[2]!.parameters[3], "4");
  assert.equal(conflict.rollbacks, 1);
});
