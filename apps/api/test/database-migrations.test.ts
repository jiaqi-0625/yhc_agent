import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseMigrationError,
  applyDatabaseMigrations,
  computeMigrationChecksum,
  defineDatabaseMigration,
  loadDatabaseMigrations,
  verifyDatabaseSchema,
  type DatabaseMigration,
} from "../src/database-migrations.ts";
import type {
  PostgresQueryable,
  PostgresQueryResult,
  PostgresTransactionProvider,
} from "../src/postgres-contract.ts";

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

interface QueryCall {
  sql: string;
  parameters: readonly unknown[] | undefined;
}

class MigrationDatabase implements PostgresTransactionProvider {
  readonly calls: QueryCall[] = [];
  readonly applied: AppliedRow[] = [];
  readonly executedMigrationSql: string[] = [];
  ledgerExists = true;
  missingWorkspaceTable: string | undefined;
  invalidWorkspaceColumn: string | undefined;
  missingWorkspaceConstraint: string | undefined;
  invalidWorkspaceConstraint: string | undefined;
  missingWorkspaceCheck: string | undefined;
  invalidWorkspaceCheck: string | undefined;
  invalidWorkspaceIndex: string | undefined;
  catalogFailureMessage: string | undefined;
  transactionCount = 0;

  async query<Row>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    if (sql.includes("to_regclass")) {
      return this.result<Row>([{ relation: this.ledgerExists ? "firefly_schema_migrations" : null }]);
    }
    if (sql.includes("FROM public.firefly_schema_migrations")) {
      return this.result<Row>(this.applied.map((row) => ({ ...row })));
    }
    if (sql.includes("INSERT INTO public.firefly_schema_migrations")) {
      const [version, name, checksum] = parameters ?? [];
      this.applied.push({ version: Number(version), name: String(name), checksum: String(checksum) });
      return this.result<Row>([]);
    }
    if (sql.includes("workspace_v2_required_") && this.catalogFailureMessage !== undefined) {
      throw new Error(this.catalogFailureMessage);
    }
    if (sql.includes("workspace_v2_required_tables")) {
      const tableNames = (parameters?.[0] ?? []) as readonly string[];
      return this.result<Row>(tableNames.map((tableName) => ({
        table_name: tableName,
        present: tableName !== this.missingWorkspaceTable,
      })));
    }
    if (sql.includes("workspace_v2_required_columns")) {
      const tableNames = (parameters?.[0] ?? []) as readonly string[];
      const columnNames = (parameters?.[1] ?? []) as readonly string[];
      return this.result<Row>(tableNames.map((tableName, index) => ({
        table_name: tableName,
        column_name: columnNames[index],
        present: `${tableName}.${columnNames[index]}` !== this.invalidWorkspaceColumn,
      })));
    }
    if (sql.includes("workspace_v2_required_constraints")) {
      const tableNames = (parameters?.[0] ?? []) as readonly string[];
      const constraintNames = (parameters?.[1] ?? []) as readonly string[];
      return this.result<Row>(tableNames.map((tableName, index) => ({
        table_name: tableName,
        constraint_name: constraintNames[index],
        present: constraintNames[index] !== this.missingWorkspaceConstraint
          && constraintNames[index] !== this.invalidWorkspaceConstraint,
      })));
    }
    if (sql.includes("workspace_v2_required_checks")) {
      const tableNames = (parameters?.[0] ?? []) as readonly string[];
      const constraintNames = (parameters?.[1] ?? []) as readonly string[];
      return this.result<Row>(tableNames.map((tableName, index) => ({
        table_name: tableName,
        constraint_name: constraintNames[index],
        present: constraintNames[index] !== this.missingWorkspaceCheck
          && constraintNames[index] !== this.invalidWorkspaceCheck,
      })));
    }
    if (sql.includes("workspace_v2_required_indexes")) {
      const tableNames = (parameters?.[0] ?? []) as readonly string[];
      const indexNames = (parameters?.[1] ?? []) as readonly string[];
      return this.result<Row>(tableNames.map((tableName, index) => ({
        table_name: tableName,
        index_name: indexNames[index],
        present: indexNames[index] !== this.invalidWorkspaceIndex,
      })));
    }
    if (
      !sql.includes("pg_advisory_xact_lock")
      && !sql.includes("CREATE TABLE IF NOT EXISTS public.firefly_schema_migrations")
    ) {
      this.executedMigrationSql.push(sql);
    }
    return this.result<Row>([]);
  }

  async transaction<Result>(
    operation: (transaction: PostgresQueryable) => Promise<Result>,
  ): Promise<Result> {
    this.transactionCount += 1;
    return operation(this);
  }

  private result<Row>(rows: readonly unknown[]): PostgresQueryResult<Row> {
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

const migrations = [
  defineDatabaseMigration(1, "foundation", "CREATE TABLE foundation (id text PRIMARY KEY);"),
  defineDatabaseMigration(2, "records", "CREATE TABLE records (id text PRIMARY KEY);"),
] as const;

const workspaceV2Migration = defineDatabaseMigration(1, "workspace_v2", "SELECT 1;");
const varchar128 = "character varying(128)";
const timestamptz = "timestamp with time zone";
const workspaceV2ColumnExpectations = [
  ["workspace_admin_states", "tenant_id", varchar128, true],
  ["workspace_admin_states", "revision", "bigint", true],
  ["workspace_admin_states", "state", "jsonb", true],
  ["workspace_admin_states", "updated_at", timestamptz, true],

  ["workspace_sessions", "session_id_hash", "character(64)", true],
  ["workspace_sessions", "account_id", varchar128, true],
  ["workspace_sessions", "created_at", timestamptz, true],
  ["workspace_sessions", "expires_at", timestamptz, true],
  ["workspace_sessions", "signed_out_at", timestamptz, false],
  ["workspace_sessions", "state", "jsonb", true],
  ["workspace_sessions", "revision", "bigint", true],
  ["workspace_sessions", "updated_at", timestamptz, true],

  ["account_budget_states", "tenant_id", varchar128, true],
  ["account_budget_states", "account_id", varchar128, true],
  ["account_budget_states", "revision", "bigint", true],
  ["account_budget_states", "state", "jsonb", true],
  ["account_budget_states", "updated_at", timestamptz, true],

  ["batch_project_aggregates", "tenant_id", varchar128, true],
  ["batch_project_aggregates", "project_id", varchar128, true],
  ["batch_project_aggregates", "revision", "bigint", true],
  ["batch_project_aggregates", "normalized_name", "character varying(240)", true],
  ["batch_project_aggregates", "creation_actor_account_id", varchar128, true],
  ["batch_project_aggregates", "creation_request_id", varchar128, true],
  ["batch_project_aggregates", "creation_payload_hash", varchar128, true],
  ["batch_project_aggregates", "aggregate", "jsonb", true],
  ["batch_project_aggregates", "created_at", timestamptz, true],
  ["batch_project_aggregates", "updated_at", timestamptz, true],

  ["video_task_aggregates", "task_id", varchar128, true],
  ["video_task_aggregates", "tenant_id", varchar128, true],
  ["video_task_aggregates", "project_id", varchar128, true],
  ["video_task_aggregates", "revision", "bigint", true],
  ["video_task_aggregates", "normalized_name", "character varying(160)", true],
  ["video_task_aggregates", "creation_actor_account_id", varchar128, false],
  ["video_task_aggregates", "creation_request_id", varchar128, false],
  ["video_task_aggregates", "creation_payload_hash", varchar128, false],
  ["video_task_aggregates", "aggregate", "jsonb", true],
  ["video_task_aggregates", "created_at", timestamptz, true],
  ["video_task_aggregates", "updated_at", timestamptz, true],

  ["temporary_asset_project_states", "tenant_id", varchar128, true],
  ["temporary_asset_project_states", "batch_project_id", varchar128, true],
  ["temporary_asset_project_states", "revision", "bigint", true],
  ["temporary_asset_project_states", "envelope", "jsonb", true],
  ["temporary_asset_project_states", "updated_at", timestamptz, true],

  ["account_run_lock_states", "tenant_id", varchar128, true],
  ["account_run_lock_states", "account_id", varchar128, true],
  ["account_run_lock_states", "lock_id", varchar128, true],
  ["account_run_lock_states", "batch_project_id", varchar128, true],
  ["account_run_lock_states", "video_task_id", varchar128, true],
  ["account_run_lock_states", "operation", "character varying(32)", true],
  ["account_run_lock_states", "acquired_at", timestamptz, true],
  ["account_run_lock_states", "revision", "bigint", true],
  ["account_run_lock_states", "envelope", "jsonb", true],
  ["account_run_lock_states", "updated_at", timestamptz, true],

  ["media_artifacts", "artifact_id", varchar128, true],
  ["media_artifacts", "tenant_id", varchar128, true],
  ["media_artifacts", "batch_project_id", varchar128, true],
  ["media_artifacts", "video_task_id", varchar128, true],
  ["media_artifacts", "stage", "character varying(32)", true],
  ["media_artifacts", "role", "character varying(32)", true],
  ["media_artifacts", "artifact_version", "bigint", true],
  ["media_artifacts", "media_type", varchar128, true],
  ["media_artifacts", "byte_size", "bigint", true],
  ["media_artifacts", "checksum_sha256", "character(64)", true],
  ["media_artifacts", "width", "integer", true],
  ["media_artifacts", "height", "integer", true],
  ["media_artifacts", "duration_ms", "bigint", true],
  ["media_artifacts", "created_at", timestamptz, true],
  ["media_artifacts", "created_by", varchar128, true],
  ["media_artifacts", "storage_provider_id", varchar128, true],
  ["media_artifacts", "storage_bucket_name", "character varying(255)", true],
  ["media_artifacts", "storage_object_key", "character varying(1024)", true],
  ["media_artifacts", "storage_object_version", "character varying(1024)", false],
  ["media_artifacts", "creation_actor_account_id", varchar128, true],
  ["media_artifacts", "creation_request_id", varchar128, true],
  ["media_artifacts", "creation_payload_hash", "character(64)", true],
  ["media_artifacts", "artifact", "jsonb", true],
] as const;
const workspaceV2ConstraintExpectations = [
  ["workspace_admin_states_pkey", "p", "tenant_id", null, null],
  ["workspace_sessions_pkey", "p", "session_id_hash", null, null],
  ["account_budget_states_pkey", "p", "tenant_id,account_id", null, null],
  ["batch_project_aggregates_pkey", "p", "tenant_id,project_id", null, null],
  ["batch_project_aggregates_tenant_normalized_name_key", "u", "tenant_id,normalized_name", null, null],
  ["batch_project_aggregates_creation_request_key", "u", "tenant_id,creation_actor_account_id,creation_request_id", null, null],
  ["batch_project_aggregates_project_id_key", "u", "project_id", null, null],
  ["video_task_aggregates_pkey", "p", "tenant_id,project_id,task_id", null, null],
  ["video_task_aggregates_task_id_key", "u", "task_id", null, null],
  ["video_task_aggregates_project_fkey", "f", "tenant_id,project_id", "batch_project_aggregates", "tenant_id,project_id"],
  ["video_task_aggregates_project_normalized_name_key", "u", "tenant_id,project_id,normalized_name", null, null],
  ["temporary_asset_project_states_pkey", "p", "batch_project_id", null, null],
  ["temporary_asset_project_states_project_fkey", "f", "tenant_id,batch_project_id", "batch_project_aggregates", "tenant_id,project_id"],
  ["account_run_lock_states_pkey", "p", "tenant_id,account_id", null, null],
  ["account_run_lock_states_lock_id_key", "u", "lock_id", null, null],
  ["account_run_lock_states_task_fkey", "f", "tenant_id,batch_project_id,video_task_id", "video_task_aggregates", "tenant_id,project_id,task_id"],
  ["media_artifacts_pkey", "p", "artifact_id", null, null],
  ["media_artifacts_task_stage_role_version_key", "u", "tenant_id,batch_project_id,video_task_id,stage,role,artifact_version", null, null],
  ["media_artifacts_creation_request_key", "u", "tenant_id,batch_project_id,video_task_id,creation_actor_account_id,creation_request_id", null, null],
  ["media_artifacts_object_locator_key", "u", "storage_provider_id,storage_bucket_name,storage_object_key", null, null],
  ["media_artifacts_task_fkey", "f", "tenant_id,batch_project_id,video_task_id", "video_task_aggregates", "tenant_id,project_id,task_id"],
] as const;

function recordAppliedMigrations(
  database: MigrationDatabase,
  plan: readonly DatabaseMigration[],
): void {
  database.applied.push(
    ...plan.map(({ version, name, checksum }) => ({ version, name, checksum })),
  );
}

test("migration loader reads the append-only Workspace V2 schemas with stable checksums", async () => {
  const loaded = await loadDatabaseMigrations();

  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]?.version, 1);
  assert.equal(loaded[0]?.name, "workspace_v2");
  assert.match(loaded[0]?.sql ?? "", /CREATE TABLE workspace_admin_states/);
  assert.match(loaded[0]?.sql ?? "", /CREATE TABLE video_task_aggregates/);
  assert.match(loaded[0]?.sql ?? "", /CREATE TABLE temporary_asset_project_states/);
  assert.match(loaded[0]?.sql ?? "", /CREATE TABLE account_run_lock_states/);
  assert.match(loaded[0]?.sql ?? "", /jsonb_typeof\(aggregate\) = 'object'\) IS TRUE/u);
  assert.match(loaded[0]?.sql ?? "", /FOREIGN KEY \(tenant_id, project_id\)/u);
  assert.equal(loaded[0]?.checksum, computeMigrationChecksum(loaded[0]?.sql ?? ""));
  assert.equal(loaded[1]?.version, 2);
  assert.equal(loaded[1]?.name, "media_artifacts");
  assert.match(loaded[1]?.sql ?? "", /CREATE TABLE media_artifacts/u);
  assert.match(loaded[1]?.sql ?? "", /CONSTRAINT media_artifacts_task_fkey/u);
  assert.match(loaded[1]?.sql ?? "", /CONSTRAINT media_artifacts_object_key_check/u);
  assert.equal(loaded[1]?.checksum, computeMigrationChecksum(loaded[1]?.sql ?? ""));
});
test("migration runner serializes, applies, records, and idempotently skips migrations", async () => {
  const database = new MigrationDatabase();

  const first = await applyDatabaseMigrations(database, migrations);
  const second = await applyDatabaseMigrations(database, migrations);

  assert.deepEqual(first, { currentVersion: 2, expectedVersion: 2 });
  assert.deepEqual(second, first);
  assert.equal(database.transactionCount, 2);
  assert.deepEqual(database.executedMigrationSql, migrations.map((migration) => migration.sql));
  assert.deepEqual(database.applied, migrations.map(({ version, name, checksum }) => ({ version, name, checksum })));
  assert.equal(
    database.calls.filter((call) => call.sql.includes("pg_advisory_xact_lock($1)")).length,
    2,
  );
  const lockCall = database.calls.find((call) => call.sql.includes("pg_advisory_xact_lock"));
  assert.equal(lockCall?.parameters?.length, 1);
});

test("migration runner fails closed when an applied checksum differs", async () => {
  const database = new MigrationDatabase();
  database.applied.push({
    version: 1,
    name: migrations[0].name,
    checksum: "0".repeat(64),
  });

  await assert.rejects(
    applyDatabaseMigrations(database, migrations),
    (error: unknown) => error instanceof DatabaseMigrationError
      && error.message === "Database migration 1 checksum does not match.",
  );
  assert.deepEqual(database.executedMigrationSql, []);
});

test("migration plan checksum is verified before any database query", async () => {
  const database = new MigrationDatabase();
  const invalid: DatabaseMigration = {
    ...migrations[0],
    checksum: "f".repeat(64),
  };

  await assert.rejects(applyDatabaseMigrations(database, [invalid]), /invalid checksum/);
  assert.deepEqual(database.calls, []);
});

test("schema verification is read-only and requires the exact current version", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, migrations);

  const version = await verifyDatabaseSchema(database, migrations);

  assert.deepEqual(version, { currentVersion: 2, expectedVersion: 2 });
  assert.equal(database.calls.some((call) => /CREATE|INSERT/.test(call.sql)), false);
  assert.equal(
    database.calls.some((call) => call.sql.includes("workspace_v2_required_")),
    false,
  );

  database.ledgerExists = false;
  await assert.rejects(
    verifyDatabaseSchema(database, migrations),
    /schema is not initialized/,
  );
});

test("empty migration verification does not require Workspace V2 schema objects", async () => {
  const database = new MigrationDatabase();

  const version = await verifyDatabaseSchema(database, []);

  assert.deepEqual(version, { currentVersion: 0, expectedVersion: 0 });
  assert.equal(
    database.calls.some((call) => call.sql.includes("workspace_v2_required_")),
    false,
  );
});

test("Workspace V2 schema verification accepts all required tables, columns, constraints, and checks", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, [workspaceV2Migration]);

  const version = await verifyDatabaseSchema(database, [workspaceV2Migration]);

  assert.deepEqual(version, { currentVersion: 1, expectedVersion: 1 });
  const tableCall = database.calls.find((call) => call.sql.includes("workspace_v2_required_tables"));
  assert.deepEqual(tableCall?.parameters?.[0], [
    "workspace_admin_states",
    "workspace_sessions",
    "account_budget_states",
    "batch_project_aggregates",
    "video_task_aggregates",
    "temporary_asset_project_states",
    "account_run_lock_states",
    "media_artifacts",
  ]);
  const columnCall = database.calls.find(
    (call) => call.sql.includes("workspace_v2_required_columns"),
  );
  assert.deepEqual(
    columnCall?.parameters?.[0],
    workspaceV2ColumnExpectations.map(([tableName]) => tableName),
  );
  assert.deepEqual(
    columnCall?.parameters?.[1],
    workspaceV2ColumnExpectations.map(([, columnName]) => columnName),
  );
  assert.deepEqual(
    columnCall?.parameters?.[2],
    workspaceV2ColumnExpectations.map(([, , formattedType]) => formattedType),
  );
  assert.deepEqual(
    columnCall?.parameters?.[3],
    workspaceV2ColumnExpectations.map(([, , , notNull]) => notNull),
  );
  assert.match(columnCall?.sql ?? "", /pg_catalog\.format_type/u);
  assert.match(columnCall?.sql ?? "", /attribute\.attnotnull/u);
  assert.match(columnCall?.sql ?? "", /NOT attribute\.attisdropped/u);
  const constraintCall = database.calls.find(
    (call) => call.sql.includes("workspace_v2_required_constraints"),
  );
  assert.deepEqual(
    constraintCall?.parameters?.[1],
    workspaceV2ConstraintExpectations.map(([name]) => name),
  );
  assert.deepEqual(
    constraintCall?.parameters?.[2],
    workspaceV2ConstraintExpectations.map(([, type]) => type),
  );
  assert.deepEqual(
    constraintCall?.parameters?.[3],
    workspaceV2ConstraintExpectations.map(([, , columns]) => columns),
  );
  assert.deepEqual(
    constraintCall?.parameters?.[4],
    workspaceV2ConstraintExpectations.map(([, , , referencedTable]) => referencedTable),
  );
  assert.deepEqual(
    constraintCall?.parameters?.[5],
    workspaceV2ConstraintExpectations.map(([, , , , referencedColumns]) => referencedColumns),
  );
  assert.match(constraintCall?.sql ?? "", /constraint_record\.conkey/u);
  assert.match(constraintCall?.sql ?? "", /constraint_record\.confkey/u);
  assert.match(constraintCall?.sql ?? "", /constraint_record\.convalidated/u);

  const checkCall = database.calls.find(
    (call) => call.sql.includes("workspace_v2_required_checks"),
  );
  const requiredCheckNames = checkCall?.parameters?.[1] as readonly string[] | undefined;
  assert.ok(requiredCheckNames?.includes("workspace_admin_states_check"));
  assert.ok(requiredCheckNames?.includes("workspace_sessions_check2"));
  assert.ok(requiredCheckNames?.includes("media_artifacts_envelope_check"));
  assert.ok(requiredCheckNames?.includes("account_budget_states_check"));
  assert.ok(requiredCheckNames?.includes("batch_project_aggregates_check"));
  assert.ok(requiredCheckNames?.includes("video_task_aggregates_check"));
  assert.ok(requiredCheckNames?.includes("temporary_asset_project_states_check"));
  assert.ok(requiredCheckNames?.includes("account_run_lock_states_check"));
  assert.ok(requiredCheckNames?.includes("account_run_lock_states_operation_check"));
  assert.ok(requiredCheckNames?.includes("account_run_lock_states_revision_check"));
  const checkDefinitions = checkCall?.parameters?.[2] as readonly string[] | undefined;
  const adminStateCheckIndex = requiredCheckNames?.indexOf("workspace_admin_states_check") ?? -1;
  assert.equal(
    checkDefinitions?.[adminStateCheckIndex],
    "CHECK ((jsonb_typeof(state) = 'object'::text) IS TRUE AND ((state ->> 'tenantId'::text) = tenant_id::text) IS TRUE)",
  );
  const operationCheckIndex = requiredCheckNames?.indexOf(
    "account_run_lock_states_operation_check",
  ) ?? -1;
  assert.equal(
    checkDefinitions?.[operationCheckIndex],
    "CHECK (operation::text = ANY (ARRAY['video_generation'::character varying, 'automatic_editing'::character varying]::text[]))",
  );
  assert.match(checkCall?.sql ?? "", /constraint_record\.convalidated/u);
  assert.match(checkCall?.sql ?? "", /pg_catalog\.pg_get_constraintdef/u);
  assert.match(checkCall?.sql ?? "", /= required\.definition/u);
  assert.doesNotMatch(checkCall?.sql ?? "", /regexp_replace|strpos/u);

  const indexCall = database.calls.find(
    (call) => call.sql.includes("workspace_v2_required_indexes"),
  );
  assert.deepEqual(indexCall?.parameters?.slice(1, 5), [
    ["video_task_aggregates_creation_request_key"],
    ["tenant_id,project_id,creation_actor_account_id,creation_request_id"],
    [4],
    ["creation_request_idisnotnull"],
  ]);
  assert.match(indexCall?.sql ?? "", /index_record\.indkey/u);
  assert.match(indexCall?.sql ?? "", /index_record\.indpred/u);
});

test("Workspace V2 schema verification fails closed when a required table is missing", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, [workspaceV2Migration]);
  database.missingWorkspaceTable = "video_task_aggregates";

  await assert.rejects(
    verifyDatabaseSchema(database, [workspaceV2Migration]),
    (error: unknown) => error instanceof DatabaseMigrationError
      && error.message === "Workspace V2 schema is missing required table video_task_aggregates.",
  );
});

test("Workspace V2 schema verification rejects a missing or incompatible required column", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, [workspaceV2Migration]);
  database.invalidWorkspaceColumn = "video_task_aggregates.aggregate";

  await assert.rejects(
    verifyDatabaseSchema(database, [workspaceV2Migration]),
    (error: unknown) => error instanceof DatabaseMigrationError
      && error.message === "Workspace V2 schema has a missing or invalid required column aggregate on table video_task_aggregates.",
  );
});

test("Workspace V2 schema verification fails closed when a required constraint is missing", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, [workspaceV2Migration]);
  database.missingWorkspaceConstraint = "video_task_aggregates_project_fkey";

  await assert.rejects(
    verifyDatabaseSchema(database, [workspaceV2Migration]),
    (error: unknown) => error instanceof DatabaseMigrationError
      && error.message === "Workspace V2 schema has a missing or invalid required constraint video_task_aggregates_project_fkey on table video_task_aggregates.",
  );
});

test("Workspace V2 schema verification rejects a named constraint with mismatched key columns", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, [workspaceV2Migration]);
  database.invalidWorkspaceConstraint = "video_task_aggregates_task_id_key";

  await assert.rejects(
    verifyDatabaseSchema(database, [workspaceV2Migration]),
    (error: unknown) => error instanceof DatabaseMigrationError
      && error.message === "Workspace V2 schema has a missing or invalid required constraint video_task_aggregates_task_id_key on table video_task_aggregates.",
  );
});

test("Workspace V2 schema verification fails closed when a required check is missing", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, [workspaceV2Migration]);
  database.missingWorkspaceCheck = "account_run_lock_states_operation_check";

  await assert.rejects(
    verifyDatabaseSchema(database, [workspaceV2Migration]),
    (error: unknown) => error instanceof DatabaseMigrationError
      && error.message === "Workspace V2 schema has a missing or invalid required check account_run_lock_states_operation_check on table account_run_lock_states.",
  );
});

test("Workspace V2 schema verification rejects a check with a mismatched definition", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, [workspaceV2Migration]);
  database.invalidWorkspaceCheck = "workspace_admin_states_check";

  await assert.rejects(
    verifyDatabaseSchema(database, [workspaceV2Migration]),
    (error: unknown) => error instanceof DatabaseMigrationError
      && error.message === "Workspace V2 schema has a missing or invalid required check workspace_admin_states_check on table workspace_admin_states.",
  );
});

test("Workspace V2 schema verification rejects an invalid creation-request partial unique index", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, [workspaceV2Migration]);
  database.invalidWorkspaceIndex = "video_task_aggregates_creation_request_key";

  await assert.rejects(
    verifyDatabaseSchema(database, [workspaceV2Migration]),
    (error: unknown) => error instanceof DatabaseMigrationError
      && error.message === "Workspace V2 schema has a missing or invalid required index video_task_aggregates_creation_request_key on table video_task_aggregates.",
  );
});

test("Workspace V2 schema verification sanitizes catalog query failures", async () => {
  const database = new MigrationDatabase();
  recordAppliedMigrations(database, [workspaceV2Migration]);
  database.catalogFailureMessage = "postgresql://db-user:secret-password@db.internal/workspace";

  await assert.rejects(
    verifyDatabaseSchema(database, [workspaceV2Migration]),
    (error: unknown) => error instanceof DatabaseMigrationError
      && error.message === "Workspace V2 schema object verification failed."
      && !error.message.includes("secret-password"),
  );
});
