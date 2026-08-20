export type DatabaseSslMode = "disable" | "require" | "verify-full";

export interface PostgresDatabaseConfig {
  readonly connectionString: string;
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly statementTimeoutMillis: number;
  readonly sslMode: DatabaseSslMode;
  readonly ssl: false | Readonly<{ rejectUnauthorized: boolean }>;
}
export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;

const integerSettings = {
  // Nested Store transactions reuse their root client. Keep one additional
  // connection so readiness and independent requests are not forced behind a
  // long-running project transaction.
  DATABASE_POOL_MAX: { defaultValue: 10, minimum: 2, maximum: 100 },
  DATABASE_CONNECTION_TIMEOUT_MS: { defaultValue: 5_000, minimum: 1, maximum: 300_000 },
  DATABASE_IDLE_TIMEOUT_MS: { defaultValue: 30_000, minimum: 1, maximum: 3_600_000 },
  DATABASE_STATEMENT_TIMEOUT_MS: { defaultValue: 30_000, minimum: 1, maximum: 3_600_000 },
} as const;

function requiredDatabaseUrl(environment: DatabaseEnvironment): string {
  const value = environment.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new DatabaseConfigError("DATABASE_URL is required.");
  }
  if (value !== value.trim()) {
    throw new DatabaseConfigError("DATABASE_URL must not contain leading or trailing whitespace.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DatabaseConfigError("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseConfigError("DATABASE_URL must use the postgres or postgresql scheme.");
  }
  if (parsed.hostname.length === 0) {
    throw new DatabaseConfigError("DATABASE_URL must include a hostname.");
  }
  if (parsed.pathname.length <= 1) {
    throw new DatabaseConfigError("DATABASE_URL must identify a database.");
  }
  if (parsed.hash.length > 0) {
    throw new DatabaseConfigError("DATABASE_URL must not contain a fragment.");
  }
  const normalizedConnectionStringSettings = [...parsed.searchParams.keys()].map((parameter) =>
    parameter.toLowerCase());
  const hasConnectionStringTlsSetting = normalizedConnectionStringSettings.some((parameter) =>
    parameter === "uselibpqcompat" || parameter.startsWith("ssl"));
  if (hasConnectionStringTlsSetting) {
    throw new DatabaseConfigError(
      "DATABASE_URL must not override the separately configured database TLS settings.",
    );
  }
  if (normalizedConnectionStringSettings.length > 0) {
    throw new DatabaseConfigError(
      "DATABASE_URL query parameters are not allowed; use the separately validated database settings.",
    );
  }
  return value;
}

function boundedInteger(
  environment: DatabaseEnvironment,
  key: keyof typeof integerSettings,
): number {
  const setting = integerSettings[key];
  const rawValue = environment[key];
  if (rawValue === undefined) {
    return setting.defaultValue;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawValue)) {
    throw new DatabaseConfigError(`${key} must be a base-10 integer.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < setting.minimum || value > setting.maximum) {
    throw new DatabaseConfigError(
      `${key} must be between ${setting.minimum} and ${setting.maximum}.`,
    );
  }
  return value;
}

function sslMode(environment: DatabaseEnvironment): DatabaseSslMode {
  const configured = environment.DATABASE_SSL_MODE;
  const value = configured ?? (environment.NODE_ENV === "production" ? "verify-full" : "disable");
  if (value !== "disable" && value !== "require" && value !== "verify-full") {
    throw new DatabaseConfigError(
      "DATABASE_SSL_MODE must be one of disable, require, or verify-full.",
    );
  }
  return value;
}

export function parsePostgresDatabaseConfig(
  environment: DatabaseEnvironment = process.env,
): PostgresDatabaseConfig {
  const selectedSslMode = sslMode(environment);
  if (environment.NODE_ENV === "production" && selectedSslMode !== "verify-full") {
    throw new DatabaseConfigError(
      "Production PostgreSQL connections must use DATABASE_SSL_MODE=verify-full.",
    );
  }
  const ssl = selectedSslMode === "disable"
    ? false
    : Object.freeze({ rejectUnauthorized: selectedSslMode === "verify-full" });

  return Object.freeze({
    connectionString: requiredDatabaseUrl(environment),
    max: boundedInteger(environment, "DATABASE_POOL_MAX"),
    connectionTimeoutMillis: boundedInteger(environment, "DATABASE_CONNECTION_TIMEOUT_MS"),
    idleTimeoutMillis: boundedInteger(environment, "DATABASE_IDLE_TIMEOUT_MS"),
    statementTimeoutMillis: boundedInteger(environment, "DATABASE_STATEMENT_TIMEOUT_MS"),
    sslMode: selectedSslMode,
    ssl,
  });
}
