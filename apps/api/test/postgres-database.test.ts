import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresDatabase,
  PostgresDatabaseClosedError,
  PostgresPersistenceError,
  PostgresTransactionContextClosedError,
  type PostgresPool,
  type PostgresPoolClient,
} from "../src/postgres-database.ts";
import type { PostgresQueryable, PostgresQueryResult } from "../src/postgres-contract.ts";

interface QueryCall {
  sql: string;
  parameters: readonly unknown[] | undefined;
}

class FakeClient implements PostgresPoolClient {
  readonly calls: QueryCall[] = [];
  releaseCount = 0;
  failOn = new Map<string, Error>();

  async query<Row>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    const failure = this.failOn.get(sql);
    if (failure !== undefined) {
      throw failure;
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.releaseCount += 1;
  }
}

class FakePool implements PostgresPool {
  readonly client = new FakeClient();
  readonly calls: QueryCall[] = [];
  connectCount = 0;
  endCount = 0;
  failOn = new Map<string, Error>();

  async query<Row>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    const failure = this.failOn.get(sql);
    if (failure !== undefined) {
      throw failure;
    }
    const rows = sql === "SELECT 1 AS ok" ? [{ ok: 1 } as Row] : [];
    return { rows, rowCount: rows.length };
  }

  async connect(): Promise<PostgresPoolClient> {
    this.connectCount += 1;
    return this.client;
  }

  async end(): Promise<void> {
    this.endCount += 1;
  }
}

class MultiClientFakePool implements PostgresPool {
  readonly clients = [new FakeClient(), new FakeClient()];
  readonly calls: QueryCall[] = [];
  connectCount = 0;
  endCount = 0;

  async query<Row>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PostgresPoolClient> {
    const client = this.clients[this.connectCount];
    this.connectCount += 1;
    if (client === undefined) {
      throw new Error("No fake client available.");
    }
    return client;
  }

  async end(): Promise<void> {
    this.endCount += 1;
  }
}

test("PostgresDatabase uses one checked-out client and commits a successful transaction", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);

  const result = await database.transaction(async (transaction) => {
    await transaction.query("SELECT value FROM records WHERE id = $1", ["record_1"]);
    return "committed";
  });

  assert.equal(result, "committed");
  assert.equal(pool.connectCount, 1);
  assert.deepEqual(pool.client.calls, [
    { sql: "BEGIN", parameters: [] },
    { sql: "SELECT value FROM records WHERE id = $1", parameters: ["record_1"] },
    { sql: "COMMIT", parameters: [] },
  ]);
  assert.equal(pool.client.releaseCount, 1);
});
test("PostgresDatabase rolls back and releases the client when an operation fails", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);
  const failure = new Error("operation failed");

  await assert.rejects(
    database.transaction(async (transaction) => {
      await transaction.query("UPDATE records SET value = $1", ["changed"]);
      throw failure;
    }),
    failure,
  );

  assert.deepEqual(pool.client.calls.map((call) => call.sql), ["BEGIN", "UPDATE records SET value = $1", "ROLLBACK"]);
  assert.equal(pool.client.releaseCount, 1);
});

test("PostgresDatabase reuses one client and one boundary for nested transactions", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);

  const result = await database.transaction(async () =>
    database.transaction(async () =>
      database.transaction(async (transaction) => {
        await transaction.query("SELECT nested", []);
        return "nested result";
      }),
    ),
  );

  assert.equal(result, "nested result");
  assert.equal(pool.connectCount, 1);
  assert.deepEqual(pool.client.calls.map((call) => call.sql), [
    "BEGIN",
    "SELECT nested",
    "COMMIT",
  ]);
  assert.equal(pool.client.releaseCount, 1);
});

test("PostgresDatabase query uses the checked-out client inside a transaction", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);

  await database.transaction(async () => {
    await database.query("SELECT through_database WHERE id = $1", ["record_3"]);
  });

  assert.deepEqual(pool.calls, []);
  assert.deepEqual(pool.client.calls, [
    { sql: "BEGIN", parameters: [] },
    { sql: "SELECT through_database WHERE id = $1", parameters: ["record_3"] },
    { sql: "COMMIT", parameters: [] },
  ]);
});

test("PostgresDatabase rolls back with the original nested error even when it is caught", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);
  const nestedFailure = new Error("nested operation failed");

  await assert.rejects(
    database.transaction(async () => {
      try {
        await database.transaction(async () => {
          throw nestedFailure;
        });
      } catch (error) {
        assert.equal(error, nestedFailure);
      }
      await database.query("SELECT after_caught_error", []);
    }),
    (error: unknown) => error === nestedFailure,
  );

  assert.deepEqual(pool.client.calls.map((call) => call.sql), [
    "BEGIN",
    "SELECT after_caught_error",
    "ROLLBACK",
  ]);
  assert.equal(pool.client.releaseCount, 1);
});

test("PostgresDatabase marks a caught transaction query failure as rollback-only", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);
  const queryFailure = new Error("query failed");
  pool.client.failOn.set("SELECT broken_transaction_query", queryFailure);

  let caughtFailure: unknown;
  await assert.rejects(
    database.transaction(async (transaction) => {
      try {
        await transaction.query("SELECT broken_transaction_query", []);
      } catch (error) {
        caughtFailure = error;
        assert.ok(error instanceof PostgresPersistenceError);
        assert.equal(error.cause, queryFailure);
      }
    }),
    (error: unknown) => error === caughtFailure,
  );

  assert.deepEqual(pool.client.calls.map((call) => call.sql), [
    "BEGIN",
    "SELECT broken_transaction_query",
    "ROLLBACK",
  ]);
  assert.equal(pool.client.releaseCount, 1);
});

test("PostgresDatabase marks a caught database query failure inside a transaction as rollback-only", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);
  const queryFailure = new Error("database query failed");
  pool.client.failOn.set("SELECT broken_database_query", queryFailure);

  let caughtFailure: unknown;
  await assert.rejects(
    database.transaction(async () => {
      try {
        await database.query("SELECT broken_database_query", []);
      } catch (error) {
        caughtFailure = error;
        assert.ok(error instanceof PostgresPersistenceError);
        assert.equal(error.cause, queryFailure);
      }
    }),
    (error: unknown) => error === caughtFailure,
  );

  assert.deepEqual(pool.calls, []);
  assert.deepEqual(pool.client.calls.map((call) => call.sql), [
    "BEGIN",
    "SELECT broken_database_query",
    "ROLLBACK",
  ]);
});

test("PostgresDatabase isolates concurrent transaction contexts by client", async () => {
  const pool = new MultiClientFakePool();
  const database = new PostgresDatabase(pool);
  let releaseFirstTransaction: (() => void) | undefined;
  const firstTransactionCanFinish = new Promise<void>((resolve) => {
    releaseFirstTransaction = resolve;
  });
  let firstQueryComplete: (() => void) | undefined;
  const firstQueryCompleted = new Promise<void>((resolve) => {
    firstQueryComplete = resolve;
  });

  const first = database.transaction(async () => {
    await database.query("SELECT first_context", []);
    firstQueryComplete?.();
    await firstTransactionCanFinish;
  });
  await firstQueryCompleted;
  const second = database.transaction(async () => {
    await database.query("SELECT second_context", []);
  });
  await second;
  releaseFirstTransaction?.();
  await first;

  assert.equal(pool.connectCount, 2);
  assert.deepEqual(pool.calls, []);
  assert.deepEqual(pool.clients[0]?.calls.map((call) => call.sql), [
    "BEGIN",
    "SELECT first_context",
    "COMMIT",
  ]);
  assert.deepEqual(pool.clients[1]?.calls.map((call) => call.sql), [
    "BEGIN",
    "SELECT second_context",
    "COMMIT",
  ]);
  assert.equal(pool.clients[0]?.releaseCount, 1);
  assert.equal(pool.clients[1]?.releaseCount, 1);
});

test("PostgresDatabase rejects work inherited from an inactive transaction context", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);
  let releaseDetachedWork: (() => void) | undefined;
  const detachedWorkCanRun = new Promise<void>((resolve) => {
    releaseDetachedWork = resolve;
  });
  let detachedQuery: Promise<void> | undefined;
  let detachedTransaction: Promise<void> | undefined;

  await database.transaction(async () => {
    detachedQuery = (async () => {
      await detachedWorkCanRun;
      await database.query("SELECT detached_query", []);
    })();
    detachedTransaction = (async () => {
      await detachedWorkCanRun;
      await database.transaction(async () => undefined);
    })();
  });

  releaseDetachedWork?.();
  assert.ok(detachedQuery);
  assert.ok(detachedTransaction);
  await assert.rejects(detachedQuery, PostgresTransactionContextClosedError);
  await assert.rejects(detachedTransaction, PostgresTransactionContextClosedError);
  assert.equal(pool.connectCount, 1);
  assert.deepEqual(pool.calls, []);
  assert.deepEqual(pool.client.calls.map((call) => call.sql), ["BEGIN", "COMMIT"]);
  assert.equal(pool.client.releaseCount, 1);
});

test("PostgresDatabase rejects a retained transaction query handle after release", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);
  let retainedTransaction: PostgresQueryable | undefined;

  await database.transaction(async (transaction) => {
    retainedTransaction = transaction;
  });

  assert.ok(retainedTransaction);
  await assert.rejects(
    retainedTransaction.query("SELECT after_release", []),
    PostgresTransactionContextClosedError,
  );
  assert.deepEqual(pool.client.calls.map((call) => call.sql), ["BEGIN", "COMMIT"]);
  assert.equal(pool.client.releaseCount, 1);
});

test("PostgresDatabase releases the client when BEGIN fails", async () => {
  const pool = new FakePool();
  pool.client.failOn.set("BEGIN", new Error("driver detail secret"));
  const database = new PostgresDatabase(pool);

  await assert.rejects(
    database.transaction(async () => undefined),
    (error: unknown) =>
      error instanceof PostgresPersistenceError &&
      error.operation === "begin" &&
      error.cause instanceof Error &&
      error.cause.message === "driver detail secret" &&
      !error.message.includes("driver detail secret"),
  );
  assert.deepEqual(pool.client.calls.map((call) => call.sql), ["BEGIN"]);
  assert.equal(pool.client.releaseCount, 1);
});

test("PostgresPersistenceError preserves SQLSTATE and hides driver details", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);
  const driverError = Object.assign(
    new Error("duplicate key contains password=super-secret"),
    { code: "23505" },
  );
  pool.failOn.set("SELECT sensitive_failure", driverError);

  await assert.rejects(
    database.query("SELECT sensitive_failure", []),
    (error: unknown) => {
      assert.ok(error instanceof PostgresPersistenceError);
      assert.equal(error.sqlState, "23505");
      assert.equal(error.cause, driverError);
      assert.equal(error.operation, "query");
      assert.ok(!error.message.includes("duplicate key"));
      assert.ok(!error.message.includes("super-secret"));
      return true;
    },
  );
});

test("PostgresDatabase supports parameterized pool queries, health checks, and idempotent close", async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);

  await database.query("SELECT value FROM records WHERE id = $1", ["record_2"]);
  await database.ping();
  await database.close();
  await database.close();

  assert.deepEqual(pool.calls, [
    { sql: "SELECT value FROM records WHERE id = $1", parameters: ["record_2"] },
    { sql: "SELECT 1 AS ok", parameters: [] },
  ]);
  assert.equal(pool.endCount, 1);
  await assert.rejects(database.query("SELECT 1", []), PostgresDatabaseClosedError);
});
