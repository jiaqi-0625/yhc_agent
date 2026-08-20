import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseConfigError,
  parsePostgresDatabaseConfig,
} from "../src/database-config.ts";

const databaseUrl = "postgresql://firefly:super-secret@db.internal:5432/firefly";

test("database configuration parses bounded pool, timeout, and verified SSL settings", () => {
  const config = parsePostgresDatabaseConfig({
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: "24",
    DATABASE_CONNECTION_TIMEOUT_MS: "6000",
    DATABASE_IDLE_TIMEOUT_MS: "45000",
    DATABASE_STATEMENT_TIMEOUT_MS: "20000",
    DATABASE_SSL_MODE: "verify-full",
  });

  assert.equal(config.connectionString, databaseUrl);
  assert.equal(config.max, 24);
  assert.equal(config.connectionTimeoutMillis, 6000);
  assert.equal(config.idleTimeoutMillis, 45000);
  assert.equal(config.statementTimeoutMillis, 20000);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.ok(Object.isFrozen(config));
});
test("database configuration defaults production SSL to certificate verification", () => {
  const config = parsePostgresDatabaseConfig({
    DATABASE_URL: "postgres://localhost/firefly",
    NODE_ENV: "production",
  });

  assert.equal(config.sslMode, "verify-full");
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});

test("database configuration rejects production TLS downgrades", () => {
  for (const mode of ["disable", "require"] as const) {
    assert.throws(
      () => parsePostgresDatabaseConfig({
        DATABASE_URL: "postgres://localhost/firefly",
        DATABASE_SSL_MODE: mode,
        NODE_ENV: "production",
      }),
      /must use DATABASE_SSL_MODE=verify-full/u,
    );
  }
});

test("database configuration rejects connection URL TLS overrides", () => {
  for (const parameter of [
    "ssl",
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "sslnegotiation",
    "uselibpqcompat",
    "SSLMODE",
  ]) {
    assert.throws(
      () => parsePostgresDatabaseConfig({
        DATABASE_URL: `postgres://localhost/firefly?${parameter}=disable`,
      }),
      /must not override/u,
    );
  }
});

test("database configuration fails closed without a valid URL and never echoes credentials", () => {
  assert.throws(
    () => parsePostgresDatabaseConfig({}),
    (error: unknown) => error instanceof DatabaseConfigError
      && error.message === "DATABASE_URL is required.",
  );

  const secretUrl = "mysql://firefly:do-not-print@example.test/firefly";
  assert.throws(
    () => parsePostgresDatabaseConfig({ DATABASE_URL: secretUrl }),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseConfigError);
      assert.equal(error.message.includes(secretUrl), false);
      assert.equal(error.message.includes("do-not-print"), false);
      return true;
    },
  );
});

test("database configuration rejects malformed numeric and SSL values", () => {
  for (const environment of [
    { DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: "0" },
    { DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: "1" },
    { DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: "10.5" },
    { DATABASE_URL: databaseUrl, DATABASE_CONNECTION_TIMEOUT_MS: " 5000" },
    { DATABASE_URL: databaseUrl, DATABASE_IDLE_TIMEOUT_MS: "3600001" },
    { DATABASE_URL: databaseUrl, DATABASE_STATEMENT_TIMEOUT_MS: "0" },
    { DATABASE_URL: databaseUrl, DATABASE_SSL_MODE: "prefer" },
  ]) {
    assert.throws(() => parsePostgresDatabaseConfig(environment), DatabaseConfigError);
  }
});
