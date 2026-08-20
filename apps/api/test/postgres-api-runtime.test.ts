import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import type { PostgresDatabaseConfig } from "../src/database-config.ts";
import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import type {
  PostgresQueryable,
  PostgresTransactionProvider,
} from "../src/postgres-contract.ts";
import {
  createPostgresApiRuntime,
  PostgresProjectAssetCoordinator,
  type PostgresApiDatabase,
} from "../src/postgres-api-runtime.ts";
import {
  resolvePersistenceBackend,
  startConfiguredApiServer,
} from "../src/server.ts";

const config: PostgresDatabaseConfig = {
  connectionString: "postgresql://test.invalid/firefly",
  max: 2,
  connectionTimeoutMillis: 100,
  idleTimeoutMillis: 100,
  statementTimeoutMillis: 100,
  sslMode: "verify-full",
  ssl: { rejectUnauthorized: true },
};

class ReadinessDatabase implements PostgresApiDatabase {
  pingCount = 0;
  closeCount = 0;
  failPing = false;

  async ping(): Promise<void> {
    this.pingCount += 1;
    if (this.failPing) throw new Error("secret database connection detail");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  async query<Row>(sql: string): Promise<{ rows: Row[]; rowCount: number }> {
    if (sql.includes("to_regclass")) {
      return {
        rows: [{ relation: "firefly_schema_migrations" } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("firefly_schema_migrations")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  async transaction<Result>(
    operation: (transaction: PostgresApiDatabase) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }
}

class TrackingLocalBusinessRuntime extends LocalBusinessRuntime {
  getWorkCount = 0;

  override getWork(workId: string): ReturnType<LocalBusinessRuntime["getWork"]> {
    this.getWorkCount += 1;
    return super.getWork(workId);
  }
}

test("production rejects local persistence and unknown backends", () => {
  assert.throws(
    () => resolvePersistenceBackend({ NODE_ENV: "production", PERSISTENCE_BACKEND: "local" }),
    /Production requires PERSISTENCE_BACKEND=postgres/u,
  );
  assert.throws(
    () => resolvePersistenceBackend({ PERSISTENCE_BACKEND: "sqlite" }),
    /PERSISTENCE_BACKEND/u,
  );
  assert.throws(
    () => resolvePersistenceBackend({ NODE_ENV: "production" }),
    /Production requires PERSISTENCE_BACKEND=postgres/u,
  );
  assert.equal(
    resolvePersistenceBackend({ NODE_ENV: "production", PERSISTENCE_BACKEND: "postgres" }),
    "postgres",
  );
  assert.equal(resolvePersistenceBackend({ NODE_ENV: "development", PERSISTENCE_BACKEND: "local" }), "local");
});

test("postgres composition closes the pool when startup readiness fails", async () => {
  const database = new ReadinessDatabase();
  database.failPing = true;
  await assert.rejects(
    createPostgresApiRuntime(config, { database, migrations: [] }),
    /secret database connection detail/u,
  );
  assert.equal(database.closeCount, 1);
});

test("postgres composition injects one database coordinator into every asset mutation runtime", async () => {
  const database = new ReadinessDatabase();
  const runtime = await createPostgresApiRuntime(config, { database, migrations: [] });
  const coordinator = runtime.assetCoordinator;
  assert.ok(coordinator instanceof PostgresProjectAssetCoordinator);
  assert.equal(
    (runtime.projectAssets as unknown as { coordinator: unknown }).coordinator,
    coordinator,
  );
  assert.equal(
    (runtime.temporaryAssets as unknown as { coordinator: unknown }).coordinator,
    coordinator,
  );
  assert.equal(
    (runtime.agentActionCommands as unknown as { assetCoordinator: unknown }).assetCoordinator,
    coordinator,
  );
  assert.ok(runtime.accountRunLocks);
  assert.ok(runtime.videoTaskStages);
  assert.ok(runtime.projectLibrary);
  assert.ok(runtime.taskContexts);
  assert.equal(typeof runtime.resolveWorkStatus, "function");
  assert.equal(typeof runtime.resolveVehicleService, "function");
  await runtime.close();
});

test("postgres project asset coordinator holds same-project operations exclusively", async () => {
  const tails = new Map<string, Promise<void>>();
  const database = {
    async query<Row>(): Promise<{ rows: Row[]; rowCount: number }> {
      return { rows: [], rowCount: 0 };
    },
    async transaction<Result>(
      operation: (transaction: { query<Row>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }> }) => Promise<Result>,
    ): Promise<Result> {
      let release = (): void => undefined;
      let tail: Promise<void> | undefined;
      const transaction = {
        async query<Row>(_sql: string, values: readonly unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
          const key = String(values[0]);
          const previous = tails.get(key) ?? Promise.resolve();
          let resolveTail = (): void => undefined;
          tail = new Promise<void>((resolve) => {
            resolveTail = resolve;
          });
          tails.set(key, tail);
          release = resolveTail;
          await previous;
          return { rows: [], rowCount: 0 };
        },
      };
      try {
        return await operation(transaction);
      } finally {
        release();
        if (tail !== undefined && [...tails.values()].includes(tail)) {
          for (const [key, value] of tails) if (value === tail) tails.delete(key);
        }
      }
    },
  };
  const coordinator = new PostgresProjectAssetCoordinator(database);
  const order: string[] = [];
  let releaseFirst = (): void => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = coordinator.runExclusive("project_one", async () => {
    order.push("first-enter");
    await firstGate;
    order.push("first-exit");
  });
  const second = coordinator.runExclusive("project_one", () => {
    order.push("second-enter");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-enter"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
});

test("postgres project asset coordination allows independent projects to progress concurrently", async () => {
  let activeTransactions = 0;
  let maximumActiveTransactions = 0;
  const queryable: PostgresQueryable = {
    async query<Row>(): Promise<{ rows: Row[]; rowCount: number }> {
      return { rows: [], rowCount: 0 };
    },
  };
  const database: PostgresTransactionProvider = {
    query: queryable.query,
    async transaction<Result>(
      operation: (transaction: PostgresQueryable) => Promise<Result>,
    ): Promise<Result> {
      activeTransactions += 1;
      maximumActiveTransactions = Math.max(maximumActiveTransactions, activeTransactions);
      try {
        return await operation(queryable);
      } finally {
        activeTransactions -= 1;
      }
    },
  };
  const firstCoordinator = new PostgresProjectAssetCoordinator(database);
  const secondCoordinator = new PostgresProjectAssetCoordinator(database);
  let releaseFirst = (): void => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const entered: string[] = [];

  const first = firstCoordinator.runExclusive("project_one", async () => {
    entered.push("project_one");
    await firstGate;
  });
  const second = secondCoordinator.runExclusive("project_two", () => {
    entered.push("project_two");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, ["project_one", "project_two"]);
  assert.equal(maximumActiveTransactions, 2);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(entered, ["project_one", "project_two"]);
  assert.equal(maximumActiveTransactions, 2);
});

test("postgres project asset coordination releases the process gate after failure", async () => {
  let transactionCount = 0;
  const queryable: PostgresQueryable = {
    async query<Row>(): Promise<{ rows: Row[]; rowCount: number }> {
      return { rows: [], rowCount: 0 };
    },
  };
  const database: PostgresTransactionProvider = {
    query: queryable.query,
    async transaction<Result>(
      operation: (transaction: PostgresQueryable) => Promise<Result>,
    ): Promise<Result> {
      transactionCount += 1;
      return operation(queryable);
    },
  };
  const coordinator = new PostgresProjectAssetCoordinator(database);
  await assert.rejects(
    coordinator.runExclusive("project_failure", () => {
      throw new Error("asset mutation failed");
    }),
    /asset mutation failed/u,
  );
  const result = await coordinator.runExclusive("project_after_failure", () => "continued");
  assert.equal(result, "continued");
  assert.equal(transactionCount, 2);
});

test("configured postgres is V2-only, readiness is fail-closed, and close drains the pool", async () => {
  const database = new ReadinessDatabase();
  const postgres = await createPostgresApiRuntime(config, { database, migrations: [] });
  const business = new TrackingLocalBusinessRuntime();
  const server = await startConfiguredApiServer(0, "127.0.0.1", {
    environment: {
      NODE_ENV: "production",
      PERSISTENCE_BACKEND: "postgres",
      DATABASE_URL: config.connectionString,
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_POOL_MAX: "2",
      AGENT_PROVIDER: "mock",
      LOCAL_AGENT_PERSIST_SESSIONS: "false",
      WORKSPACE_MIGRATION_DATA_DIRECTORY: ".data/test-postgres-configured-readiness-migrations",
    },
    createPostgresRuntime: async () => postgres,
    registerSignalHandlers: false,
    business,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
  assert.equal(
    (await fetch(`${baseUrl}/v1/auth/development-accounts`)).status,
    404,
  );
  database.failPing = true;
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  const unavailable = await fetch(`${baseUrl}/ready`);
  assert.equal(unavailable.status, 503);
  const body = await unavailable.text();
  assert.match(body, /"status":"unavailable"/u);
  assert.doesNotMatch(body, /secret|connection|database/iu);

  const authenticatedAgent = await fetch(`${baseUrl}/v1/sessions?videoTaskId=task_missing`, {
    headers: { authorization: "Bearer authenticated-workspace-session" },
  });
  assert.equal(authenticatedAgent.status, 401);
  assert.equal(
    ((await authenticatedAgent.json()) as { code: string }).code,
    "AIC-AUTH-SESSION_INVALID",
  );
  assert.equal((await fetch(`${baseUrl}/v1/works`)).status, 404);
  assert.equal(
    (await fetch(`${baseUrl}/v1/workspace/me/production-status`)).status,
    401,
  );
  assert.equal(business.getWorkCount, 0);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(database.closeCount, 1);
});

test("configured postgres keeps development accounts available only on a local non-production host", async (context) => {
  const database = new ReadinessDatabase();
  const postgres = await createPostgresApiRuntime(config, { database, migrations: [] });
  const server = await startConfiguredApiServer(0, "127.0.0.1", {
    environment: {
      NODE_ENV: "development",
      PERSISTENCE_BACKEND: "postgres",
      DATABASE_URL: config.connectionString,
      DATABASE_SSL_MODE: "disable",
      DATABASE_POOL_MAX: "2",
      AGENT_PROVIDER: "mock",
      LOCAL_AGENT_PERSIST_SESSIONS: "false",
      WORKSPACE_MIGRATION_DATA_DIRECTORY: ".data/test-postgres-configured-development-migrations",
    },
    createPostgresRuntime: async () => postgres,
    registerSignalHandlers: false,
  });
  context.after(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/auth/development-accounts`,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { accounts: readonly { accountId: string }[] };
  assert.deepEqual(
    body.accounts.map(({ accountId }) => accountId),
    ["account_admin", "account_creator_a", "account_creator_b"],
  );
});

test("configured server closes postgres when Agent configuration fails", async () => {
  const database = new ReadinessDatabase();
  const postgres = await createPostgresApiRuntime(config, { database, migrations: [] });
  await assert.rejects(
    startConfiguredApiServer(0, "127.0.0.1", {
      environment: {
        NODE_ENV: "development",
        PERSISTENCE_BACKEND: "postgres",
        DATABASE_URL: config.connectionString,
        DATABASE_SSL_MODE: "disable",
        DATABASE_POOL_MAX: "2",
        AGENT_PROVIDER: "invalid",
        WORKSPACE_MIGRATION_DATA_DIRECTORY: ".data/test-postgres-agent-config-failure-migrations",
      },
      createPostgresRuntime: async () => postgres,
      registerSignalHandlers: false,
    }),
    /AGENT_PROVIDER/u,
  );
  assert.equal(database.closeCount, 1);
});

test("configured server closes postgres when listen fails", async (context) => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => blocker.close());
  const address = blocker.address();
  assert.ok(address && typeof address === "object");

  const database = new ReadinessDatabase();
  const postgres = await createPostgresApiRuntime(config, { database, migrations: [] });
  await assert.rejects(
    startConfiguredApiServer(address.port, "127.0.0.1", {
      environment: {
        NODE_ENV: "production",
        PERSISTENCE_BACKEND: "postgres",
        DATABASE_URL: config.connectionString,
        DATABASE_SSL_MODE: "verify-full",
        DATABASE_POOL_MAX: "2",
        AGENT_PROVIDER: "mock",
        LOCAL_AGENT_PERSIST_SESSIONS: "false",
        WORKSPACE_MIGRATION_DATA_DIRECTORY: ".data/test-postgres-listen-failure-migrations",
      },
      createPostgresRuntime: async () => postgres,
      registerSignalHandlers: false,
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EADDRINUSE",
  );
  assert.equal(database.closeCount, 1);
});
