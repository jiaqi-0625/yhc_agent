import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

import type {
  PostgresQueryable,
  PostgresQueryResult,
  PostgresTransactionProvider,
} from "./postgres-contract.ts";
import type { PostgresDatabaseConfig } from "./database-config.ts";

export interface PostgresPoolClient extends PostgresQueryable {
  release(discard?: boolean): void;
}
export interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresPoolClient>;
  end(): Promise<void>;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

interface PgPoolConstructor {
  new (options: Readonly<Record<string, unknown>>): PostgresPool;
}

interface PgModule {
  Pool: PgPoolConstructor;
}

export type PostgresPoolFactory = (config: PostgresDatabaseConfig) => PostgresPool;

interface PostgresTransactionContext {
  readonly client: PostgresPoolClient;
  readonly queryable: PostgresQueryable;
  active: boolean;
  rollbackOnly: boolean;
  rollbackReason: unknown;
}

export class PostgresDatabaseClosedError extends Error {
  constructor() {
    super("The PostgreSQL pool is closed.");
    this.name = "PostgresDatabaseClosedError";
  }
}

export class PostgresTransactionContextClosedError extends Error {
  constructor() {
    super("The PostgreSQL transaction context is no longer active.");
    this.name = "PostgresTransactionContextClosedError";
  }
}

function sqlStateFrom(error: unknown): string | undefined {
  if (error instanceof PostgresPersistenceError) {
    return error.sqlState;
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export class PostgresPersistenceError extends Error {
  readonly operation: string;
  readonly sqlState: string | undefined;

  constructor(operation: string, cause: unknown, sqlState = sqlStateFrom(cause)) {
    super(`PostgreSQL persistence ${operation} failed.`, { cause });
    this.name = "PostgresPersistenceError";
    this.operation = operation;
    this.sqlState = sqlState;
  }
}

function persistenceError(operation: string, cause: unknown): PostgresPersistenceError {
  return cause instanceof PostgresPersistenceError
    ? cause
    : new PostgresPersistenceError(operation, cause);
}

function combinedPersistenceError(
  operation: string,
  primary: unknown,
  secondary: PostgresPersistenceError,
): PostgresPersistenceError {
  return new PostgresPersistenceError(
    operation,
    new AggregateError([primary, secondary], `PostgreSQL persistence ${operation} had multiple failures.`),
    sqlStateFrom(primary) ?? secondary.sqlState,
  );
}

function defaultPoolFactory(config: PostgresDatabaseConfig): PostgresPool {
  // Keep the adapter testable without loading a native connection during module import.
  const require = createRequire(import.meta.url);
  const pg = require("pg") as PgModule;
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    ssl: config.ssl,
    application_name: "firefly-workspace-api",
    options: "-c search_path=public",
  });
  // node-postgres emits idle-client failures on the Pool. Installing a
  // listener prevents EventEmitter's unhandled-error process termination;
  // readiness still performs an active query before traffic is accepted.
  pool.on?.("error", () => {
    process.stderr.write("PostgreSQL pool reported an idle connection failure.\n");
  });
  return pool;
}

function parameterList(parameters: readonly unknown[] | undefined): unknown[] {
  return parameters === undefined ? [] : Array.from(parameters);
}

function markRollbackOnly(context: PostgresTransactionContext, reason: unknown): void {
  if (!context.rollbackOnly) {
    context.rollbackOnly = true;
    context.rollbackReason = reason;
  }
}

export class PostgresDatabase implements PostgresTransactionProvider {
  readonly #pool: PostgresPool;
  readonly #transactionContext = new AsyncLocalStorage<PostgresTransactionContext>();
  #closed = false;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async query<Row>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.#assertOpen();
    const context = this.#transactionContext.getStore();
    if (context !== undefined) {
      if (!context.active) {
        throw new PostgresTransactionContextClosedError();
      }
      return context.queryable.query<Row>(sql, parameters);
    }
    try {
      return await this.#pool.query<Row>(sql, parameterList(parameters));
    } catch (error) {
      throw persistenceError("query", error);
    }
  }

  async transaction<Result>(
    operation: (transaction: PostgresQueryable) => Promise<Result>,
  ): Promise<Result> {
    this.#assertOpen();
    const existingContext = this.#transactionContext.getStore();
    if (existingContext !== undefined) {
      if (!existingContext.active) {
        throw new PostgresTransactionContextClosedError();
      }
      try {
        return await operation(existingContext.queryable);
      } catch (error) {
        markRollbackOnly(existingContext, error);
        throw error;
      }
    }

    let client: PostgresPoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw persistenceError("connect", error);
    }
    let context: PostgresTransactionContext;
    const transaction: PostgresQueryable = Object.freeze({
      query: async <Row>(
        sql: string,
        parameters?: readonly unknown[],
      ): Promise<PostgresQueryResult<Row>> => {
        if (!context.active) {
          throw new PostgresTransactionContextClosedError();
        }
        try {
          return await client.query<Row>(sql, parameterList(parameters));
        } catch (error) {
          const wrappedError = persistenceError("transaction query", error);
          markRollbackOnly(context, wrappedError);
          throw wrappedError;
        }
      },
    });
    context = {
      client,
      queryable: transaction,
      active: true,
      rollbackOnly: false,
      rollbackReason: undefined,
    };

    let rootResult: Result | undefined;
    let rootFailed = false;
    let rootError: unknown;
    let discardClient = false;
    try {
      try {
        await client.query("BEGIN", []);
      } catch (error) {
        discardClient = true;
        throw persistenceError("begin", error);
      }
      let result: Result | undefined;
      let operationFailed = false;
      let operationError: unknown;
      try {
        result = await this.#transactionContext.run(context, () => operation(transaction));
      } catch (error) {
        operationFailed = true;
        operationError = error;
      }

      if (operationFailed || context.rollbackOnly) {
        const failure = context.rollbackOnly ? context.rollbackReason : operationError;
        try {
          await client.query("ROLLBACK", []);
        } catch (rollbackError) {
          discardClient = true;
          throw combinedPersistenceError(
            "rollback",
            failure,
            persistenceError("rollback", rollbackError),
          );
        }
        throw failure;
      }

      try {
        await client.query("COMMIT", []);
      } catch (commitError) {
        discardClient = true;
        const wrappedCommitError = persistenceError("commit", commitError);
        try {
          await client.query("ROLLBACK", []);
        } catch (rollbackError) {
          throw combinedPersistenceError(
            "commit and rollback",
            wrappedCommitError,
            persistenceError("rollback", rollbackError),
          );
        }
        throw wrappedCommitError;
      }
      rootResult = result as Result;
    } catch (error) {
      rootFailed = true;
      rootError = error;
    }

    context.active = false;
    try {
      if (discardClient) client.release(true);
      else client.release();
    } catch (releaseError) {
      const wrappedReleaseError = persistenceError("release", releaseError);
      if (rootFailed) {
        throw combinedPersistenceError("transaction and release", rootError, wrappedReleaseError);
      }
      throw wrappedReleaseError;
    }
    if (rootFailed) {
      throw rootError;
    }
    return rootResult as Result;
  }

  async ping(): Promise<void> {
    const result = await this.query<{ ok: number }>("SELECT 1 AS ok", []);
    if (result.rows[0]?.ok !== 1) {
      throw new Error("PostgreSQL health check returned an unexpected result.");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#pool.end();
    } catch (error) {
      throw persistenceError("close", error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new PostgresDatabaseClosedError();
    }
  }
}

export function createPostgresDatabase(
  config: PostgresDatabaseConfig,
  poolFactory: PostgresPoolFactory = defaultPoolFactory,
): PostgresDatabase {
  try {
    return new PostgresDatabase(poolFactory(config));
  } catch (error) {
    throw persistenceError("pool creation", error);
  }
}
