import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type { PostgresTransactionProvider } from "./postgres-contract.ts";

export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}
export interface DatabaseSchemaVersion {
  readonly currentVersion: number;
  readonly expectedVersion: number;
}

interface AppliedMigrationRow {
  version: number | string;
  name: string;
  checksum: string;
}

interface RequiredTableRow {
  table_name: string;
  present: boolean;
}

interface RequiredConstraintRow {
  table_name: string;
  constraint_name: string;
  present: boolean;
}

interface RequiredIndexRow {
  table_name: string;
  index_name: string;
  present: boolean;
}

interface WorkspaceV2ConstraintRequirement {
  readonly tableName: string;
  readonly constraintName: string;
  readonly constraintType: "p" | "u" | "f";
  readonly columns: readonly string[];
  readonly referencedTableName: string | null;
  readonly referencedColumns: readonly string[] | null;
}

interface WorkspaceV2IndexRequirement {
  readonly tableName: string;
  readonly indexName: string;
  readonly columns: readonly string[];
  readonly normalizedPredicate: string;
}

const migrationFilename = /^(?<version>[0-9]{4})_(?<name>[a-z][a-z0-9_]*).sql$/;
const migrationLockId = 2_046_604_093;
const workspaceV2MigrationName = "workspace_v2";
const workspaceV2RequiredTables = Object.freeze([
  "workspace_admin_states",
  "workspace_sessions",
  "account_budget_states",
  "batch_project_aggregates",
  "video_task_aggregates",
  "temporary_asset_project_states",
  "account_run_lock_states",
]);
const workspaceV2RequiredConstraints: readonly WorkspaceV2ConstraintRequirement[] = Object.freeze(([
  { tableName: "workspace_admin_states", constraintName: "workspace_admin_states_pkey", constraintType: "p", columns: ["tenant_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "workspace_sessions", constraintName: "workspace_sessions_pkey", constraintType: "p", columns: ["session_id_hash"], referencedTableName: null, referencedColumns: null },
  { tableName: "account_budget_states", constraintName: "account_budget_states_pkey", constraintType: "p", columns: ["tenant_id", "account_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "batch_project_aggregates", constraintName: "batch_project_aggregates_pkey", constraintType: "p", columns: ["tenant_id", "project_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "batch_project_aggregates", constraintName: "batch_project_aggregates_tenant_normalized_name_key", constraintType: "u", columns: ["tenant_id", "normalized_name"], referencedTableName: null, referencedColumns: null },
  { tableName: "batch_project_aggregates", constraintName: "batch_project_aggregates_creation_request_key", constraintType: "u", columns: ["tenant_id", "creation_actor_account_id", "creation_request_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "batch_project_aggregates", constraintName: "batch_project_aggregates_project_id_key", constraintType: "u", columns: ["project_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "video_task_aggregates", constraintName: "video_task_aggregates_pkey", constraintType: "p", columns: ["tenant_id", "project_id", "task_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "video_task_aggregates", constraintName: "video_task_aggregates_task_id_key", constraintType: "u", columns: ["task_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "video_task_aggregates", constraintName: "video_task_aggregates_project_fkey", constraintType: "f", columns: ["tenant_id", "project_id"], referencedTableName: "batch_project_aggregates", referencedColumns: ["tenant_id", "project_id"] },
  { tableName: "video_task_aggregates", constraintName: "video_task_aggregates_project_normalized_name_key", constraintType: "u", columns: ["tenant_id", "project_id", "normalized_name"], referencedTableName: null, referencedColumns: null },
  { tableName: "temporary_asset_project_states", constraintName: "temporary_asset_project_states_pkey", constraintType: "p", columns: ["batch_project_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "temporary_asset_project_states", constraintName: "temporary_asset_project_states_project_fkey", constraintType: "f", columns: ["tenant_id", "batch_project_id"], referencedTableName: "batch_project_aggregates", referencedColumns: ["tenant_id", "project_id"] },
  { tableName: "account_run_lock_states", constraintName: "account_run_lock_states_pkey", constraintType: "p", columns: ["tenant_id", "account_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "account_run_lock_states", constraintName: "account_run_lock_states_lock_id_key", constraintType: "u", columns: ["lock_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "account_run_lock_states", constraintName: "account_run_lock_states_task_fkey", constraintType: "f", columns: ["tenant_id", "batch_project_id", "video_task_id"], referencedTableName: "video_task_aggregates", referencedColumns: ["tenant_id", "project_id", "task_id"] },
] satisfies readonly WorkspaceV2ConstraintRequirement[]).map((requirement) => Object.freeze({
  ...requirement,
  columns: Object.freeze(requirement.columns),
  referencedColumns: requirement.referencedColumns === null
    ? null
    : Object.freeze(requirement.referencedColumns),
})));
const workspaceV2RequiredIndexes: readonly WorkspaceV2IndexRequirement[] = Object.freeze([
  Object.freeze({
    tableName: "video_task_aggregates",
    indexName: "video_task_aggregates_creation_request_key",
    columns: Object.freeze([
      "tenant_id",
      "project_id",
      "creation_actor_account_id",
      "creation_request_id",
    ]),
    normalizedPredicate: "creation_request_idisnotnull",
  }),
]);

export class DatabaseMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseMigrationError";
  }
}

function normalizeMigrationSql(sql: string): string {
  const withoutBom = sql.startsWith("\uFEFF") ? sql.slice(1) : sql;
  return withoutBom.replace(/\r\n?/g, "\n");
}

export function computeMigrationChecksum(sql: string): string {
  return createHash("sha256").update(normalizeMigrationSql(sql), "utf8").digest("hex");
}

export function defineDatabaseMigration(
  version: number,
  name: string,
  sql: string,
): DatabaseMigration {
  const normalizedSql = normalizeMigrationSql(sql);
  return Object.freeze({
    version,
    name,
    sql: normalizedSql,
    checksum: computeMigrationChecksum(normalizedSql),
  });
}

export async function loadDatabaseMigrations(
  directory: URL = new URL("../migrations/", import.meta.url),
): Promise<readonly DatabaseMigration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const migrations: DatabaseMigration[] = [];

  for (const filename of filenames) {
    const match = migrationFilename.exec(filename);
    if (match?.groups === undefined) {
      throw new DatabaseMigrationError(`Invalid migration filename: ${filename}`);
    }
    const sql = await readFile(new URL(filename, directory), "utf8");
    migrations.push(
      defineDatabaseMigration(Number(match.groups.version), match.groups.name ?? "", sql),
    );
  }

  validateMigrationPlan(migrations);
  return Object.freeze(migrations);
}

function validateMigrationPlan(migrations: readonly DatabaseMigration[]): void {
  let expectedVersion = 1;
  for (const migration of migrations) {
    if (migration.version !== expectedVersion) {
      throw new DatabaseMigrationError(
        `Migration versions must be contiguous from 0001; expected ${expectedVersion}.`,
      );
    }
    if (!/^[a-z][a-z0-9_]*$/.test(migration.name)) {
      throw new DatabaseMigrationError(`Migration ${migration.version} has an invalid name.`);
    }
    if (migration.sql.trim().length === 0) {
      throw new DatabaseMigrationError(`Migration ${migration.version} is empty.`);
    }
    if (computeMigrationChecksum(migration.sql) !== migration.checksum) {
      throw new DatabaseMigrationError(`Migration ${migration.version} has an invalid checksum.`);
    }
    expectedVersion += 1;
  }
}

function versionNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new DatabaseMigrationError("The migration ledger contains an invalid version.");
  }
  return parsed;
}

function verifyAppliedMigrations(
  appliedRows: readonly AppliedMigrationRow[],
  migrations: readonly DatabaseMigration[],
): void {
  const applied = new Map<number, AppliedMigrationRow>();
  for (const row of appliedRows) {
    const version = versionNumber(row.version);
    if (applied.has(version)) {
      throw new DatabaseMigrationError(`Migration ${version} is recorded more than once.`);
    }
    applied.set(version, row);
  }

  for (const [version, row] of applied) {
    const expected = migrations[version - 1];
    if (expected === undefined) {
      throw new DatabaseMigrationError(`Database migration ${version} is newer than this build.`);
    }
    if (row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new DatabaseMigrationError(`Database migration ${version} checksum does not match.`);
    }
  }

  for (let version = 1; version <= applied.size; version += 1) {
    if (!applied.has(version)) {
      throw new DatabaseMigrationError(`Database migration ${version} is missing.`);
    }
  }
}

const createMigrationLedgerSql = `
CREATE TABLE IF NOT EXISTS public.firefly_schema_migrations (
  version integer PRIMARY KEY CHECK (version >= 1),
  name text NOT NULL,
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const selectMigrationsSql = `
SELECT version, name, checksum
FROM public.firefly_schema_migrations
ORDER BY version`;

async function queryWorkspaceV2Catalog<Row>(
  database: PostgresTransactionProvider,
  sql: string,
  parameters: readonly unknown[],
): Promise<readonly Row[]> {
  try {
    return (await database.query<Row>(sql, parameters)).rows;
  } catch {
    throw new DatabaseMigrationError("Workspace V2 schema object verification failed.");
  }
}

async function verifyWorkspaceV2SchemaObjects(
  database: PostgresTransactionProvider,
): Promise<void> {
  const tableRows = await queryWorkspaceV2Catalog<RequiredTableRow>(
    database,
    `/* workspace_v2_required_tables */
     SELECT required.table_name, relation.oid IS NOT NULL AS present
     FROM unnest($1::text[]) AS required(table_name)
     LEFT JOIN pg_catalog.pg_namespace AS namespace
       ON namespace.nspname = $2
     LEFT JOIN pg_catalog.pg_class AS relation
       ON relation.relnamespace = namespace.oid
      AND relation.relname = required.table_name
      AND relation.relkind IN ('r', 'p')
     ORDER BY required.table_name`,
    [workspaceV2RequiredTables, "public"],
  );

  const presentTables = new Map(
    tableRows.map((row) => [row.table_name, row.present] as const),
  );
  for (const tableName of workspaceV2RequiredTables) {
    if (presentTables.get(tableName) !== true) {
      throw new DatabaseMigrationError(
        `Workspace V2 schema is missing required table ${tableName}.`,
      );
    }
  }

  const constraintRows = await queryWorkspaceV2Catalog<RequiredConstraintRow>(
    database,
    `/* workspace_v2_required_constraints */
     SELECT required.table_name,
            required.constraint_name,
            constraint_record.oid IS NOT NULL
              AND constraint_record.convalidated
              AND constraint_record.contype = required.constraint_type::"char"
              AND (
                SELECT string_agg(attribute.attname, ',' ORDER BY key.ordinality)
                FROM unnest(constraint_record.conkey) WITH ORDINALITY
                  AS key(attribute_number, ordinality)
                JOIN pg_catalog.pg_attribute AS attribute
                  ON attribute.attrelid = relation.oid
                 AND attribute.attnum = key.attribute_number
              ) = required.column_names
              AND (
                required.referenced_table_name IS NULL
                OR (
                  referenced_namespace.nspname = $8
                  AND referenced_relation.relname = required.referenced_table_name
                  AND (
                    SELECT string_agg(attribute.attname, ',' ORDER BY key.ordinality)
                    FROM unnest(constraint_record.confkey) WITH ORDINALITY
                      AS key(attribute_number, ordinality)
                    JOIN pg_catalog.pg_attribute AS attribute
                      ON attribute.attrelid = referenced_relation.oid
                     AND attribute.attnum = key.attribute_number
                  ) = required.referenced_column_names
                )
              ) AS present
     FROM unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]
     ) AS required(
       table_name,
       constraint_name,
       constraint_type,
       column_names,
       referenced_table_name,
       referenced_column_names
     )
     LEFT JOIN pg_catalog.pg_namespace AS namespace
       ON namespace.nspname = $7
     LEFT JOIN pg_catalog.pg_class AS relation
       ON relation.relnamespace = namespace.oid
      AND relation.relname = required.table_name
     LEFT JOIN pg_catalog.pg_constraint AS constraint_record
       ON constraint_record.conrelid = relation.oid
      AND constraint_record.conname = required.constraint_name
     LEFT JOIN pg_catalog.pg_class AS referenced_relation
       ON referenced_relation.oid = constraint_record.confrelid
     LEFT JOIN pg_catalog.pg_namespace AS referenced_namespace
       ON referenced_namespace.oid = referenced_relation.relnamespace
     ORDER BY required.table_name, required.constraint_name`,
    [
      workspaceV2RequiredConstraints.map(({ tableName }) => tableName),
      workspaceV2RequiredConstraints.map(({ constraintName }) => constraintName),
      workspaceV2RequiredConstraints.map(({ constraintType }) => constraintType),
      workspaceV2RequiredConstraints.map(({ columns }) => columns.join(",")),
      workspaceV2RequiredConstraints.map(({ referencedTableName }) => referencedTableName),
      workspaceV2RequiredConstraints.map(({ referencedColumns }) =>
        referencedColumns?.join(",") ?? null),
      "public",
      "public",
    ],
  );

  const presentConstraints = new Map(
    constraintRows.map((row) => [
      `${row.table_name}\u0000${row.constraint_name}`,
      row.present,
    ] as const),
  );
  for (const { tableName, constraintName } of workspaceV2RequiredConstraints) {
    if (presentConstraints.get(`${tableName}\u0000${constraintName}`) !== true) {
      throw new DatabaseMigrationError(
        `Workspace V2 schema has a missing or invalid required constraint ${constraintName} on table ${tableName}.`,
      );
    }
  }

  const indexRows = await queryWorkspaceV2Catalog<RequiredIndexRow>(
    database,
    `/* workspace_v2_required_indexes */
     SELECT required.table_name,
            required.index_name,
            index_record.indexrelid IS NOT NULL
              AND index_record.indisunique
              AND index_record.indisvalid
              AND index_record.indisready
              AND index_record.indnkeyatts = required.column_count
              AND (
                SELECT string_agg(attribute.attname, ',' ORDER BY key.ordinality)
                FROM unnest(index_record.indkey::smallint[]) WITH ORDINALITY
                  AS key(attribute_number, ordinality)
                JOIN pg_catalog.pg_attribute AS attribute
                  ON attribute.attrelid = table_relation.oid
                 AND attribute.attnum = key.attribute_number
                WHERE key.ordinality <= index_record.indnkeyatts
              ) = required.column_names
              AND lower(regexp_replace(
                pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid),
                '[[:space:]()]',
                '',
                'g'
              )) = required.normalized_predicate AS present
     FROM unnest($1::text[], $2::text[], $3::text[], $4::integer[], $5::text[])
       AS required(table_name, index_name, column_names, column_count, normalized_predicate)
     LEFT JOIN pg_catalog.pg_namespace AS namespace
       ON namespace.nspname = $6
     LEFT JOIN pg_catalog.pg_class AS table_relation
       ON table_relation.relnamespace = namespace.oid
      AND table_relation.relname = required.table_name
     LEFT JOIN pg_catalog.pg_class AS index_relation
       ON index_relation.relnamespace = namespace.oid
      AND index_relation.relname = required.index_name
     LEFT JOIN pg_catalog.pg_index AS index_record
       ON index_record.indrelid = table_relation.oid
      AND index_record.indexrelid = index_relation.oid
     ORDER BY required.table_name, required.index_name`,
    [
      workspaceV2RequiredIndexes.map(({ tableName }) => tableName),
      workspaceV2RequiredIndexes.map(({ indexName }) => indexName),
      workspaceV2RequiredIndexes.map(({ columns }) => columns.join(",")),
      workspaceV2RequiredIndexes.map(({ columns }) => columns.length),
      workspaceV2RequiredIndexes.map(({ normalizedPredicate }) => normalizedPredicate),
      "public",
    ],
  );

  const presentIndexes = new Map(
    indexRows.map((row) => [`${row.table_name}\u0000${row.index_name}`, row.present] as const),
  );
  for (const { tableName, indexName } of workspaceV2RequiredIndexes) {
    if (presentIndexes.get(`${tableName}\u0000${indexName}`) !== true) {
      throw new DatabaseMigrationError(
        `Workspace V2 schema has a missing or invalid required index ${indexName} on table ${tableName}.`,
      );
    }
  }
}

export async function applyDatabaseMigrations(
  database: PostgresTransactionProvider,
  migrations: readonly DatabaseMigration[],
): Promise<DatabaseSchemaVersion> {
  validateMigrationPlan(migrations);
  return database.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock($1)", [migrationLockId]);
    await transaction.query(createMigrationLedgerSql, []);
    const result = await transaction.query<AppliedMigrationRow>(selectMigrationsSql, []);
    verifyAppliedMigrations(result.rows, migrations);
    const appliedVersions = new Set(result.rows.map((row) => versionNumber(row.version)));

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      await transaction.query(migration.sql, []);
      await transaction.query(
        `INSERT INTO public.firefly_schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
    }

    return Object.freeze({
      currentVersion: migrations.length,
      expectedVersion: migrations.length,
    });
  });
}

export async function verifyDatabaseSchema(
  database: PostgresTransactionProvider,
  migrations: readonly DatabaseMigration[],
): Promise<DatabaseSchemaVersion> {
  validateMigrationPlan(migrations);
  const relation = await database.query<{ relation: string | null }>(
    "SELECT to_regclass($1) AS relation",
    ["public.firefly_schema_migrations"],
  );
  if (relation.rows[0]?.relation === null || relation.rows[0] === undefined) {
    throw new DatabaseMigrationError("Database schema is not initialized; run the migration command.");
  }

  const result = await database.query<AppliedMigrationRow>(selectMigrationsSql, []);
  verifyAppliedMigrations(result.rows, migrations);
  if (result.rows.length !== migrations.length) {
    throw new DatabaseMigrationError(
      `Database schema is at version ${result.rows.length}; expected ${migrations.length}.`,
    );
  }
  if (migrations.some(({ name }) => name === workspaceV2MigrationName)) {
    await verifyWorkspaceV2SchemaObjects(database);
  }
  return Object.freeze({
    currentVersion: result.rows.length,
    expectedVersion: migrations.length,
  });
}
