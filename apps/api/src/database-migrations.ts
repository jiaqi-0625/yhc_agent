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

interface RequiredColumnRow {
  table_name: string;
  column_name: string;
  present: boolean;
}

interface RequiredConstraintRow {
  table_name: string;
  constraint_name: string;
  present: boolean;
}

interface RequiredCheckRow {
  table_name: string;
  constraint_name: string;
  present: boolean;
}

interface RequiredIndexRow {
  table_name: string;
  index_name: string;
  present: boolean;
}

interface WorkspaceV2ColumnRequirement {
  readonly tableName: string;
  readonly columnName: string;
  readonly formattedType: string;
  readonly notNull: boolean;
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
  "media_artifacts",
  "vehicle_models",
  "vehicle_variants",
  "vehicle_fact_versions",
  "video_task_vehicle_snapshots",
]);

function requiredWorkspaceV2Column(
  tableName: string,
  columnName: string,
  formattedType: string,
  notNull = true,
): WorkspaceV2ColumnRequirement {
  return Object.freeze({ tableName, columnName, formattedType, notNull });
}

interface WorkspaceV2CheckRequirement {
  readonly tableName: string;
  readonly constraintName: string;
  readonly definition: string;
}

const varchar128 = "character varying(128)";
const timestamptz = "timestamp with time zone";
const workspaceV2RequiredColumns: readonly WorkspaceV2ColumnRequirement[] = Object.freeze([
  requiredWorkspaceV2Column("workspace_admin_states", "tenant_id", varchar128),
  requiredWorkspaceV2Column("workspace_admin_states", "revision", "bigint"),
  requiredWorkspaceV2Column("workspace_admin_states", "state", "jsonb"),
  requiredWorkspaceV2Column("workspace_admin_states", "updated_at", timestamptz),

  requiredWorkspaceV2Column("workspace_sessions", "session_id_hash", "character(64)"),
  requiredWorkspaceV2Column("workspace_sessions", "account_id", varchar128),
  requiredWorkspaceV2Column("workspace_sessions", "created_at", timestamptz),
  requiredWorkspaceV2Column("workspace_sessions", "expires_at", timestamptz),
  requiredWorkspaceV2Column("workspace_sessions", "signed_out_at", timestamptz, false),
  requiredWorkspaceV2Column("workspace_sessions", "state", "jsonb"),
  requiredWorkspaceV2Column("workspace_sessions", "revision", "bigint"),
  requiredWorkspaceV2Column("workspace_sessions", "updated_at", timestamptz),

  requiredWorkspaceV2Column("account_budget_states", "tenant_id", varchar128),
  requiredWorkspaceV2Column("account_budget_states", "account_id", varchar128),
  requiredWorkspaceV2Column("account_budget_states", "revision", "bigint"),
  requiredWorkspaceV2Column("account_budget_states", "state", "jsonb"),
  requiredWorkspaceV2Column("account_budget_states", "updated_at", timestamptz),

  requiredWorkspaceV2Column("batch_project_aggregates", "tenant_id", varchar128),
  requiredWorkspaceV2Column("batch_project_aggregates", "project_id", varchar128),
  requiredWorkspaceV2Column("batch_project_aggregates", "revision", "bigint"),
  requiredWorkspaceV2Column(
    "batch_project_aggregates",
    "normalized_name",
    "character varying(240)",
  ),
  requiredWorkspaceV2Column("batch_project_aggregates", "creation_actor_account_id", varchar128),
  requiredWorkspaceV2Column("batch_project_aggregates", "creation_request_id", varchar128),
  requiredWorkspaceV2Column("batch_project_aggregates", "creation_payload_hash", varchar128),
  requiredWorkspaceV2Column("batch_project_aggregates", "aggregate", "jsonb"),
  requiredWorkspaceV2Column("batch_project_aggregates", "created_at", timestamptz),
  requiredWorkspaceV2Column("batch_project_aggregates", "updated_at", timestamptz),

  requiredWorkspaceV2Column("video_task_aggregates", "task_id", varchar128),
  requiredWorkspaceV2Column("video_task_aggregates", "tenant_id", varchar128),
  requiredWorkspaceV2Column("video_task_aggregates", "project_id", varchar128),
  requiredWorkspaceV2Column("video_task_aggregates", "revision", "bigint"),
  requiredWorkspaceV2Column(
    "video_task_aggregates",
    "normalized_name",
    "character varying(160)",
  ),
  requiredWorkspaceV2Column(
    "video_task_aggregates",
    "creation_actor_account_id",
    varchar128,
    false,
  ),
  requiredWorkspaceV2Column(
    "video_task_aggregates",
    "creation_request_id",
    varchar128,
    false,
  ),
  requiredWorkspaceV2Column(
    "video_task_aggregates",
    "creation_payload_hash",
    varchar128,
    false,
  ),
  requiredWorkspaceV2Column("video_task_aggregates", "aggregate", "jsonb"),
  requiredWorkspaceV2Column("video_task_aggregates", "created_at", timestamptz),
  requiredWorkspaceV2Column("video_task_aggregates", "updated_at", timestamptz),

  requiredWorkspaceV2Column("temporary_asset_project_states", "tenant_id", varchar128),
  requiredWorkspaceV2Column("temporary_asset_project_states", "batch_project_id", varchar128),
  requiredWorkspaceV2Column("temporary_asset_project_states", "revision", "bigint"),
  requiredWorkspaceV2Column("temporary_asset_project_states", "envelope", "jsonb"),
  requiredWorkspaceV2Column("temporary_asset_project_states", "updated_at", timestamptz),

  requiredWorkspaceV2Column("account_run_lock_states", "tenant_id", varchar128),
  requiredWorkspaceV2Column("account_run_lock_states", "account_id", varchar128),
  requiredWorkspaceV2Column("account_run_lock_states", "lock_id", varchar128),
  requiredWorkspaceV2Column("account_run_lock_states", "batch_project_id", varchar128),
  requiredWorkspaceV2Column("account_run_lock_states", "video_task_id", varchar128),
  requiredWorkspaceV2Column(
    "account_run_lock_states",
    "operation",
    "character varying(32)",
  ),
  requiredWorkspaceV2Column("account_run_lock_states", "acquired_at", timestamptz),
  requiredWorkspaceV2Column("account_run_lock_states", "revision", "bigint"),
  requiredWorkspaceV2Column("account_run_lock_states", "envelope", "jsonb"),
  requiredWorkspaceV2Column("account_run_lock_states", "updated_at", timestamptz),

  requiredWorkspaceV2Column("media_artifacts", "artifact_id", varchar128),
  requiredWorkspaceV2Column("media_artifacts", "tenant_id", varchar128),
  requiredWorkspaceV2Column("media_artifacts", "batch_project_id", varchar128),
  requiredWorkspaceV2Column("media_artifacts", "video_task_id", varchar128),
  requiredWorkspaceV2Column("media_artifacts", "stage", "character varying(32)"),
  requiredWorkspaceV2Column("media_artifacts", "role", "character varying(32)"),
  requiredWorkspaceV2Column("media_artifacts", "artifact_version", "bigint"),
  requiredWorkspaceV2Column("media_artifacts", "media_type", varchar128),
  requiredWorkspaceV2Column("media_artifacts", "byte_size", "bigint"),
  requiredWorkspaceV2Column("media_artifacts", "checksum_sha256", "character(64)"),
  requiredWorkspaceV2Column("media_artifacts", "width", "integer"),
  requiredWorkspaceV2Column("media_artifacts", "height", "integer"),
  requiredWorkspaceV2Column("media_artifacts", "duration_ms", "bigint"),
  requiredWorkspaceV2Column("media_artifacts", "created_at", timestamptz),
  requiredWorkspaceV2Column("media_artifacts", "created_by", varchar128),
  requiredWorkspaceV2Column("media_artifacts", "storage_provider_id", varchar128),
  requiredWorkspaceV2Column("media_artifacts", "storage_bucket_name", "character varying(255)"),
  requiredWorkspaceV2Column("media_artifacts", "storage_object_key", "character varying(1024)"),
  requiredWorkspaceV2Column("media_artifacts", "storage_object_version", "character varying(1024)", false),
  requiredWorkspaceV2Column("media_artifacts", "creation_actor_account_id", varchar128),
  requiredWorkspaceV2Column("media_artifacts", "creation_request_id", varchar128),
  requiredWorkspaceV2Column("media_artifacts", "creation_payload_hash", "character(64)"),
  requiredWorkspaceV2Column("media_artifacts", "artifact", "jsonb"),

  requiredWorkspaceV2Column("vehicle_models", "tenant_id", varchar128),
  requiredWorkspaceV2Column("vehicle_models", "model_id", varchar128),
  requiredWorkspaceV2Column("vehicle_models", "brand_id", varchar128),
  requiredWorkspaceV2Column("vehicle_models", "series_name", "character varying(120)"),
  requiredWorkspaceV2Column("vehicle_models", "model_year", "integer"),
  requiredWorkspaceV2Column("vehicle_models", "status", "character varying(16)"),
  requiredWorkspaceV2Column("vehicle_models", "created_at", timestamptz),
  requiredWorkspaceV2Column("vehicle_models", "created_by", varchar128),
  requiredWorkspaceV2Column("vehicle_models", "updated_at", timestamptz),
  requiredWorkspaceV2Column("vehicle_models", "updated_by", varchar128),

  requiredWorkspaceV2Column("vehicle_variants", "tenant_id", varchar128),
  requiredWorkspaceV2Column("vehicle_variants", "variant_id", varchar128),
  requiredWorkspaceV2Column("vehicle_variants", "model_id", varchar128),
  requiredWorkspaceV2Column("vehicle_variants", "variant_name", "character varying(120)"),
  requiredWorkspaceV2Column("vehicle_variants", "status", "character varying(16)"),
  requiredWorkspaceV2Column("vehicle_variants", "current_fact_version", "bigint"),
  requiredWorkspaceV2Column("vehicle_variants", "created_at", timestamptz),
  requiredWorkspaceV2Column("vehicle_variants", "created_by", varchar128),
  requiredWorkspaceV2Column("vehicle_variants", "updated_at", timestamptz),
  requiredWorkspaceV2Column("vehicle_variants", "updated_by", varchar128),

  requiredWorkspaceV2Column("vehicle_fact_versions", "tenant_id", varchar128),
  requiredWorkspaceV2Column("vehicle_fact_versions", "variant_id", varchar128),
  requiredWorkspaceV2Column("vehicle_fact_versions", "fact_version", "bigint"),
  requiredWorkspaceV2Column("vehicle_fact_versions", "facts_text", "text"),
  requiredWorkspaceV2Column("vehicle_fact_versions", "facts_sha256", "character(64)"),
  requiredWorkspaceV2Column("vehicle_fact_versions", "validation_index", "jsonb"),
  requiredWorkspaceV2Column("vehicle_fact_versions", "source_name", "text"),
  requiredWorkspaceV2Column("vehicle_fact_versions", "source_reference", "text"),
  requiredWorkspaceV2Column("vehicle_fact_versions", "effective_from", "date"),
  requiredWorkspaceV2Column("vehicle_fact_versions", "effective_until", "date", false),
  requiredWorkspaceV2Column("vehicle_fact_versions", "created_at", timestamptz),
  requiredWorkspaceV2Column("vehicle_fact_versions", "created_by", varchar128),

  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "snapshot_id", varchar128),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "tenant_id", varchar128),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "batch_project_id", varchar128),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "video_task_id", varchar128),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "variant_id", varchar128),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "fact_version", "bigint"),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "facts_text", "text"),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "facts_sha256", "character(64)"),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "validation_index", "jsonb"),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "locked_at", timestamptz),
  requiredWorkspaceV2Column("video_task_vehicle_snapshots", "locked_by", varchar128),
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
  { tableName: "media_artifacts", constraintName: "media_artifacts_pkey", constraintType: "p", columns: ["artifact_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "media_artifacts", constraintName: "media_artifacts_task_stage_role_version_key", constraintType: "u", columns: ["tenant_id", "batch_project_id", "video_task_id", "stage", "role", "artifact_version"], referencedTableName: null, referencedColumns: null },
  { tableName: "media_artifacts", constraintName: "media_artifacts_creation_request_key", constraintType: "u", columns: ["tenant_id", "batch_project_id", "video_task_id", "creation_actor_account_id", "creation_request_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "media_artifacts", constraintName: "media_artifacts_object_locator_key", constraintType: "u", columns: ["storage_provider_id", "storage_bucket_name", "storage_object_key"], referencedTableName: null, referencedColumns: null },
  { tableName: "media_artifacts", constraintName: "media_artifacts_task_fkey", constraintType: "f", columns: ["tenant_id", "batch_project_id", "video_task_id"], referencedTableName: "video_task_aggregates", referencedColumns: ["tenant_id", "project_id", "task_id"] },
  { tableName: "vehicle_models", constraintName: "vehicle_models_pkey", constraintType: "p", columns: ["tenant_id", "model_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "vehicle_models", constraintName: "vehicle_models_model_id_key", constraintType: "u", columns: ["model_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "vehicle_models", constraintName: "vehicle_models_identity_key", constraintType: "u", columns: ["tenant_id", "brand_id", "series_name", "model_year"], referencedTableName: null, referencedColumns: null },
  { tableName: "vehicle_variants", constraintName: "vehicle_variants_pkey", constraintType: "p", columns: ["tenant_id", "variant_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "vehicle_variants", constraintName: "vehicle_variants_variant_id_key", constraintType: "u", columns: ["variant_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "vehicle_variants", constraintName: "vehicle_variants_model_name_key", constraintType: "u", columns: ["tenant_id", "model_id", "variant_name"], referencedTableName: null, referencedColumns: null },
  { tableName: "vehicle_variants", constraintName: "vehicle_variants_model_fkey", constraintType: "f", columns: ["tenant_id", "model_id"], referencedTableName: "vehicle_models", referencedColumns: ["tenant_id", "model_id"] },
  { tableName: "vehicle_variants", constraintName: "vehicle_variants_current_fact_fkey", constraintType: "f", columns: ["tenant_id", "variant_id", "current_fact_version"], referencedTableName: "vehicle_fact_versions", referencedColumns: ["tenant_id", "variant_id", "fact_version"] },
  { tableName: "vehicle_fact_versions", constraintName: "vehicle_fact_versions_pkey", constraintType: "p", columns: ["tenant_id", "variant_id", "fact_version"], referencedTableName: null, referencedColumns: null },
  { tableName: "vehicle_fact_versions", constraintName: "vehicle_fact_versions_variant_fkey", constraintType: "f", columns: ["tenant_id", "variant_id"], referencedTableName: "vehicle_variants", referencedColumns: ["tenant_id", "variant_id"] },
  { tableName: "video_task_vehicle_snapshots", constraintName: "video_task_vehicle_snapshots_pkey", constraintType: "p", columns: ["tenant_id", "batch_project_id", "video_task_id"], referencedTableName: null, referencedColumns: null },
  { tableName: "video_task_vehicle_snapshots", constraintName: "video_task_vehicle_snapshots_task_fkey", constraintType: "f", columns: ["tenant_id", "batch_project_id", "video_task_id"], referencedTableName: "video_task_aggregates", referencedColumns: ["tenant_id", "project_id", "task_id"] },
  { tableName: "video_task_vehicle_snapshots", constraintName: "video_task_vehicle_snapshots_fact_fkey", constraintType: "f", columns: ["tenant_id", "variant_id", "fact_version"], referencedTableName: "vehicle_fact_versions", referencedColumns: ["tenant_id", "variant_id", "fact_version"] },
] satisfies readonly WorkspaceV2ConstraintRequirement[]).map((requirement) => Object.freeze({
  ...requirement,
  columns: Object.freeze(requirement.columns),
  referencedColumns: requirement.referencedColumns === null
    ? null
    : Object.freeze(requirement.referencedColumns),
})));

function requiredWorkspaceV2Check(
  tableName: string,
  constraintName: string,
  definition: string,
): WorkspaceV2CheckRequirement {
  return Object.freeze({
    tableName,
    constraintName,
    definition,
  });
}

function checkDefinition(...expressionParts: readonly string[]): string {
  return "CHECK (" + expressionParts.join(" ") + ")";
}

const identifierCheckDefinition = (columnName: string): string =>
  checkDefinition(columnName + "::text ~ '^[A-Za-z0-9_-]{1,128}$'::text");
const revisionCheckDefinition = checkDefinition("revision >= 1");
const workspaceV2RequiredChecks: readonly WorkspaceV2CheckRequirement[] = Object.freeze([
  requiredWorkspaceV2Check("workspace_admin_states", "workspace_admin_states_tenant_id_check", identifierCheckDefinition("tenant_id")),
  requiredWorkspaceV2Check("workspace_admin_states", "workspace_admin_states_revision_check", revisionCheckDefinition),
  requiredWorkspaceV2Check(
    "workspace_admin_states",
    "workspace_admin_states_check",
    checkDefinition(
      "(jsonb_typeof(state) = 'object'::text) IS TRUE",
      "AND ((state ->> 'tenantId'::text) = tenant_id::text) IS TRUE",
    ),
  ),

  requiredWorkspaceV2Check("workspace_sessions", "workspace_sessions_session_id_hash_check", checkDefinition("session_id_hash ~ '^[0-9a-f]{64}$'::text")),
  requiredWorkspaceV2Check("workspace_sessions", "workspace_sessions_account_id_check", identifierCheckDefinition("account_id")),
  requiredWorkspaceV2Check("workspace_sessions", "workspace_sessions_check", checkDefinition("expires_at > created_at")),
  requiredWorkspaceV2Check("workspace_sessions", "workspace_sessions_check1", checkDefinition("signed_out_at IS NULL OR signed_out_at >= created_at")),
  requiredWorkspaceV2Check(
    "workspace_sessions",
    "workspace_sessions_check2",
    checkDefinition(
      "(jsonb_typeof(state) = 'object'::text) IS TRUE",
      "AND ((state ->> 'sessionIdHash'::text) = session_id_hash::text) IS TRUE",
      "AND ((state ->> 'accountId'::text) = account_id::text) IS TRUE",
      "AND (((state ->> 'createdAt'::text)::timestamp with time zone) = created_at) IS TRUE",
      "AND (((state ->> 'expiresAt'::text)::timestamp with time zone) = expires_at) IS TRUE",
      "AND (signed_out_at IS NULL AND NOT state ? 'signedOutAt'::text",
      "OR signed_out_at IS NOT NULL AND (((state ->> 'signedOutAt'::text)::timestamp with time zone) = signed_out_at) IS TRUE)",
    ),
  ),
  requiredWorkspaceV2Check("workspace_sessions", "workspace_sessions_revision_check", revisionCheckDefinition),

  requiredWorkspaceV2Check("account_budget_states", "account_budget_states_tenant_id_check", identifierCheckDefinition("tenant_id")),
  requiredWorkspaceV2Check("account_budget_states", "account_budget_states_account_id_check", identifierCheckDefinition("account_id")),
  requiredWorkspaceV2Check("account_budget_states", "account_budget_states_revision_check", revisionCheckDefinition),
  requiredWorkspaceV2Check(
    "account_budget_states",
    "account_budget_states_check",
    checkDefinition(
      "(jsonb_typeof(state) = 'object'::text) IS TRUE",
      "AND ((state ->> 'tenantId'::text) = tenant_id::text) IS TRUE",
      "AND ((state ->> 'accountId'::text) = account_id::text) IS TRUE",
    ),
  ),

  requiredWorkspaceV2Check("batch_project_aggregates", "batch_project_aggregates_tenant_id_check", identifierCheckDefinition("tenant_id")),
  requiredWorkspaceV2Check("batch_project_aggregates", "batch_project_aggregates_project_id_check", identifierCheckDefinition("project_id")),
  requiredWorkspaceV2Check("batch_project_aggregates", "batch_project_aggregates_revision_check", revisionCheckDefinition),
  requiredWorkspaceV2Check("batch_project_aggregates", "batch_project_aggregates_creation_actor_account_id_check", identifierCheckDefinition("creation_actor_account_id")),
  requiredWorkspaceV2Check("batch_project_aggregates", "batch_project_aggregates_creation_request_id_check", identifierCheckDefinition("creation_request_id")),
  requiredWorkspaceV2Check("batch_project_aggregates", "batch_project_aggregates_creation_payload_hash_check", checkDefinition("length(creation_payload_hash::text) >= 1")),
  requiredWorkspaceV2Check(
    "batch_project_aggregates",
    "batch_project_aggregates_check",
    checkDefinition(
      "(jsonb_typeof(aggregate) = 'object'::text) IS TRUE",
      "AND ((aggregate #>> '{project,tenantId}'::text[]) = tenant_id::text) IS TRUE",
      "AND ((aggregate #>> '{project,id}'::text[]) = project_id::text) IS TRUE",
      "AND ((aggregate ->> 'actorAccountId'::text) = creation_actor_account_id::text) IS TRUE",
      "AND ((aggregate ->> 'requestId'::text) = creation_request_id::text) IS TRUE",
      "AND ((aggregate ->> 'payloadHash'::text) = creation_payload_hash::text) IS TRUE",
    ),
  ),

  requiredWorkspaceV2Check("video_task_aggregates", "video_task_aggregates_task_id_check", identifierCheckDefinition("task_id")),
  requiredWorkspaceV2Check("video_task_aggregates", "video_task_aggregates_tenant_id_check", identifierCheckDefinition("tenant_id")),
  requiredWorkspaceV2Check("video_task_aggregates", "video_task_aggregates_project_id_check", identifierCheckDefinition("project_id")),
  requiredWorkspaceV2Check("video_task_aggregates", "video_task_aggregates_revision_check", revisionCheckDefinition),
  requiredWorkspaceV2Check("video_task_aggregates", "video_task_aggregates_creation_actor_account_id_check", checkDefinition("creation_actor_account_id IS NULL OR creation_actor_account_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text")),
  requiredWorkspaceV2Check("video_task_aggregates", "video_task_aggregates_creation_request_id_check", checkDefinition("creation_request_id IS NULL OR creation_request_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text")),
  requiredWorkspaceV2Check("video_task_aggregates", "video_task_aggregates_creation_payload_hash_check", checkDefinition("creation_payload_hash IS NULL OR length(creation_payload_hash::text) >= 1")),
  requiredWorkspaceV2Check(
    "video_task_aggregates",
    "video_task_aggregates_check",
    checkDefinition(
      "(jsonb_typeof(aggregate) = 'object'::text) IS TRUE",
      "AND ((aggregate #>> '{videoTask,id}'::text[]) = task_id::text) IS TRUE",
      "AND ((aggregate #>> '{videoTask,tenantId}'::text[]) = tenant_id::text) IS TRUE",
      "AND ((aggregate #>> '{videoTask,batchProjectId}'::text[]) = project_id::text) IS TRUE",
    ),
  ),
  requiredWorkspaceV2Check(
    "video_task_aggregates",
    "video_task_aggregates_check1",
    checkDefinition("creation_actor_account_id IS NULL AND creation_request_id IS NULL AND creation_payload_hash IS NULL OR creation_actor_account_id IS NOT NULL AND creation_request_id IS NOT NULL AND creation_payload_hash IS NOT NULL"),
  ),

  requiredWorkspaceV2Check("temporary_asset_project_states", "temporary_asset_project_states_tenant_id_check", identifierCheckDefinition("tenant_id")),
  requiredWorkspaceV2Check("temporary_asset_project_states", "temporary_asset_project_states_batch_project_id_check", identifierCheckDefinition("batch_project_id")),
  requiredWorkspaceV2Check("temporary_asset_project_states", "temporary_asset_project_states_revision_check", revisionCheckDefinition),
  requiredWorkspaceV2Check(
    "temporary_asset_project_states",
    "temporary_asset_project_states_check",
    checkDefinition(
      "(jsonb_typeof(envelope) = 'object'::text) IS TRUE",
      "AND ((envelope ->> 'batchProjectId'::text) = batch_project_id::text) IS TRUE",
      "AND (jsonb_typeof(envelope -> 'assets'::text) = 'array'::text) IS TRUE",
      `AND (jsonb_array_length(envelope -> 'assets'::text) = jsonb_array_length(jsonb_path_query_array(envelope, '$."assets"[*]?(@."tenantId" == $"tenantId" && @."batchProjectId" == $"batchProjectId")'::jsonpath, jsonb_build_object('tenantId', to_jsonb(tenant_id), 'batchProjectId', to_jsonb(batch_project_id))))) IS TRUE`,
    ),
  ),

  requiredWorkspaceV2Check("account_run_lock_states", "account_run_lock_states_tenant_id_check", identifierCheckDefinition("tenant_id")),
  requiredWorkspaceV2Check("account_run_lock_states", "account_run_lock_states_account_id_check", identifierCheckDefinition("account_id")),
  requiredWorkspaceV2Check("account_run_lock_states", "account_run_lock_states_lock_id_check", identifierCheckDefinition("lock_id")),
  requiredWorkspaceV2Check("account_run_lock_states", "account_run_lock_states_batch_project_id_check", identifierCheckDefinition("batch_project_id")),
  requiredWorkspaceV2Check("account_run_lock_states", "account_run_lock_states_video_task_id_check", identifierCheckDefinition("video_task_id")),
  requiredWorkspaceV2Check("account_run_lock_states", "account_run_lock_states_operation_check", checkDefinition("operation::text = ANY (ARRAY['video_generation'::character varying, 'automatic_editing'::character varying]::text[])")),
  requiredWorkspaceV2Check("account_run_lock_states", "account_run_lock_states_revision_check", revisionCheckDefinition),
  requiredWorkspaceV2Check(
    "account_run_lock_states",
    "account_run_lock_states_check",
    checkDefinition(
      "(jsonb_typeof(envelope) = 'object'::text) IS TRUE",
      "AND ((envelope ->> 'tenantId'::text) = tenant_id::text) IS TRUE",
      "AND ((envelope ->> 'accountId'::text) = account_id::text) IS TRUE",
      "AND ((envelope ->> 'id'::text) = lock_id::text) IS TRUE",
      "AND ((envelope ->> 'batchProjectId'::text) = batch_project_id::text) IS TRUE",
      "AND ((envelope ->> 'videoTaskId'::text) = video_task_id::text) IS TRUE",
      "AND ((envelope ->> 'operation'::text) = operation::text) IS TRUE",
      "AND (((envelope ->> 'acquiredAt'::text)::timestamp with time zone) = acquired_at) IS TRUE",
    ),
  ),

  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_bucket_check", checkDefinition("length(storage_bucket_name::text) >= 3 AND length(storage_bucket_name::text) <= 255 AND storage_bucket_name::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$'::text")),
  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_creation_actor_check", checkDefinition("created_by::text = creation_actor_account_id::text")),
  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_hash_check", checkDefinition("checksum_sha256 ~ '^[0-9a-f]{64}$'::text AND creation_payload_hash ~ '^[0-9a-f]{64}$'::text")),
  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_identifier_check", checkDefinition("artifact_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND tenant_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND batch_project_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND video_task_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND created_by::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND storage_provider_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND creation_actor_account_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND creation_request_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text")),
  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_media_type_check", checkDefinition("media_type::text = ANY (ARRAY['video/mp4'::character varying, 'video/webm'::character varying]::text[])")),
  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_object_key_check", checkDefinition("octet_length(storage_object_key::text) >= 1 AND octet_length(storage_object_key::text) <= 1024 AND storage_object_key::text ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'::text AND \"right\"(storage_object_key::text, 1) <> '/'::text AND storage_object_key::text !~~ '%//%'::text AND storage_object_key::text = concat('v1/tenants/', tenant_id, '/projects/', batch_project_id, '/tasks/', video_task_id, '/artifacts/', artifact_id, '/media') AND NOT string_to_array(storage_object_key::text, '/'::text) && ARRAY['.'::text, '..'::text]")),
  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_object_version_check", checkDefinition("storage_object_version IS NULL OR length(storage_object_version::text) >= 1 AND length(storage_object_version::text) <= 1024 AND storage_object_version::text ~ '^[A-Za-z0-9+_.=/~-]+$'::text")),
  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_stage_role_check", checkDefinition("stage::text = 'video_preview'::text AND role::text = 'preview'::text OR stage::text = 'delivery'::text AND role::text = 'delivery'::text")),
  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_version_size_check", checkDefinition("artifact_version >= 1 AND artifact_version <= '9007199254740991'::bigint AND byte_size >= 1 AND byte_size <= '9007199254740991'::bigint AND width >= 1 AND width <= 32768 AND height >= 1 AND height <= 32768 AND duration_ms >= 1 AND duration_ms <= '9007199254740991'::bigint")),
  requiredWorkspaceV2Check("media_artifacts", "media_artifacts_envelope_check", checkDefinition("(jsonb_typeof(artifact) = 'object'::text) IS TRUE AND artifact ?& ARRAY['schemaVersion'::text, 'id'::text, 'tenantId'::text, 'batchProjectId'::text, 'videoTaskId'::text, 'stage'::text, 'role'::text, 'version'::text, 'mediaType'::text, 'byteSize'::text, 'checksumSha256'::text, 'width'::text, 'height'::text, 'durationMs'::text, 'createdAt'::text, 'createdBy'::text] AND (artifact - ARRAY['schemaVersion'::text, 'id'::text, 'tenantId'::text, 'batchProjectId'::text, 'videoTaskId'::text, 'stage'::text, 'role'::text, 'version'::text, 'mediaType'::text, 'byteSize'::text, 'checksumSha256'::text, 'width'::text, 'height'::text, 'durationMs'::text, 'createdAt'::text, 'createdBy'::text]) = '{}'::jsonb AND ((artifact ->> 'schemaVersion'::text) = '1'::text) IS TRUE AND ((artifact ->> 'id'::text) = artifact_id::text) IS TRUE AND ((artifact ->> 'tenantId'::text) = tenant_id::text) IS TRUE AND ((artifact ->> 'batchProjectId'::text) = batch_project_id::text) IS TRUE AND ((artifact ->> 'videoTaskId'::text) = video_task_id::text) IS TRUE AND ((artifact ->> 'stage'::text) = stage::text) IS TRUE AND ((artifact ->> 'role'::text) = role::text) IS TRUE AND (((artifact ->> 'version'::text)::bigint) = artifact_version) IS TRUE AND ((artifact ->> 'mediaType'::text) = media_type::text) IS TRUE AND (((artifact ->> 'byteSize'::text)::bigint) = byte_size) IS TRUE AND ((artifact ->> 'checksumSha256'::text) = checksum_sha256::text) IS TRUE AND (((artifact ->> 'width'::text)::integer) = width) IS TRUE AND (((artifact ->> 'height'::text)::integer) = height) IS TRUE AND (((artifact ->> 'durationMs'::text)::bigint) = duration_ms) IS TRUE AND (((artifact ->> 'createdAt'::text)::timestamp with time zone) = created_at) IS TRUE AND ((artifact ->> 'createdBy'::text) = created_by::text) IS TRUE")),
  requiredWorkspaceV2Check("vehicle_models", "vehicle_models_identifier_check", checkDefinition("tenant_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND model_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND brand_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND created_by::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND updated_by::text ~ '^[A-Za-z0-9_-]{1,128}$'::text")),
  requiredWorkspaceV2Check("vehicle_models", "vehicle_models_values_check", checkDefinition("length(btrim(series_name::text)) >= 1 AND length(btrim(series_name::text)) <= 120 AND model_year >= 2000 AND model_year <= 2100 AND (status::text = ANY (ARRAY['active'::character varying, 'archived'::character varying]::text[])) AND updated_at >= created_at")),
  requiredWorkspaceV2Check("vehicle_variants", "vehicle_variants_identifier_check", checkDefinition("tenant_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND variant_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND model_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND created_by::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND updated_by::text ~ '^[A-Za-z0-9_-]{1,128}$'::text")),
  requiredWorkspaceV2Check("vehicle_variants", "vehicle_variants_values_check", checkDefinition("length(btrim(variant_name::text)) >= 1 AND length(btrim(variant_name::text)) <= 120 AND (status::text = ANY (ARRAY['active'::character varying, 'archived'::character varying]::text[])) AND current_fact_version >= 1 AND current_fact_version <= '9007199254740991'::bigint AND updated_at >= created_at")),
  requiredWorkspaceV2Check("vehicle_fact_versions", "vehicle_fact_versions_identifier_check", checkDefinition("tenant_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND variant_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND created_by::text ~ '^[A-Za-z0-9_-]{1,128}$'::text")),
  requiredWorkspaceV2Check("vehicle_fact_versions", "vehicle_fact_versions_values_check", checkDefinition("fact_version >= 1 AND fact_version <= '9007199254740991'::bigint AND length(btrim(facts_text)) >= 1 AND length(btrim(facts_text)) <= 100000 AND facts_sha256 ~ '^[0-9a-f]{64}$'::text AND length(btrim(source_name)) >= 1 AND length(btrim(source_name)) <= 1000 AND length(btrim(source_reference)) >= 1 AND length(btrim(source_reference)) <= 4000 AND (effective_until IS NULL OR effective_until >= effective_from)")),
  requiredWorkspaceV2Check("vehicle_fact_versions", "vehicle_fact_versions_validation_index_check", checkDefinition("(jsonb_typeof(validation_index) = 'object'::text) IS TRUE AND (jsonb_typeof(validation_index -> 'fixedClaims'::text) = 'array'::text) IS TRUE AND (jsonb_typeof(validation_index -> 'optionalClaims'::text) = 'array'::text) IS TRUE AND (jsonb_typeof(validation_index -> 'prohibitedClaims'::text) = 'array'::text) IS TRUE")),
  requiredWorkspaceV2Check("video_task_vehicle_snapshots", "video_task_vehicle_snapshots_identifier_check", checkDefinition("snapshot_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND tenant_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND batch_project_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND video_task_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND variant_id::text ~ '^[A-Za-z0-9_-]{1,128}$'::text AND locked_by::text ~ '^[A-Za-z0-9_-]{1,128}$'::text")),
  requiredWorkspaceV2Check("video_task_vehicle_snapshots", "video_task_vehicle_snapshots_values_check", checkDefinition("fact_version >= 1 AND fact_version <= '9007199254740991'::bigint AND length(btrim(facts_text)) >= 1 AND length(btrim(facts_text)) <= 100000 AND facts_sha256 ~ '^[0-9a-f]{64}$'::text")),
  requiredWorkspaceV2Check("video_task_vehicle_snapshots", "video_task_vehicle_snapshots_validation_index_check", checkDefinition("(jsonb_typeof(validation_index) = 'object'::text) IS TRUE AND (jsonb_typeof(validation_index -> 'fixedClaims'::text) = 'array'::text) IS TRUE AND (jsonb_typeof(validation_index -> 'optionalClaims'::text) = 'array'::text) IS TRUE AND (jsonb_typeof(validation_index -> 'prohibitedClaims'::text) = 'array'::text) IS TRUE")),
]);
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

  const columnRows = await queryWorkspaceV2Catalog<RequiredColumnRow>(
    database,
    `/* workspace_v2_required_columns */
     SELECT required.table_name,
            required.column_name,
            attribute.attnum IS NOT NULL
              AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                = required.formatted_type
              AND attribute.attnotnull = required.not_null AS present
     FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[])
       AS required(table_name, column_name, formatted_type, not_null)
     LEFT JOIN pg_catalog.pg_namespace AS namespace
       ON namespace.nspname = $5
     LEFT JOIN pg_catalog.pg_class AS relation
       ON relation.relnamespace = namespace.oid
      AND relation.relname = required.table_name
      AND relation.relkind IN ('r', 'p')
     LEFT JOIN pg_catalog.pg_attribute AS attribute
       ON attribute.attrelid = relation.oid
      AND attribute.attname = required.column_name
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
     ORDER BY required.table_name, required.column_name`,
    [
      workspaceV2RequiredColumns.map(({ tableName }) => tableName),
      workspaceV2RequiredColumns.map(({ columnName }) => columnName),
      workspaceV2RequiredColumns.map(({ formattedType }) => formattedType),
      workspaceV2RequiredColumns.map(({ notNull }) => notNull),
      "public",
    ],
  );

  const presentColumns = new Map(
    columnRows.map((row) => [
      `${row.table_name}\u0000${row.column_name}`,
      row.present,
    ] as const),
  );
  for (const { tableName, columnName } of workspaceV2RequiredColumns) {
    if (presentColumns.get(`${tableName}\u0000${columnName}`) !== true) {
      throw new DatabaseMigrationError(
        `Workspace V2 schema has a missing or invalid required column ${columnName} on table ${tableName}.`,
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

  const checkRows = await queryWorkspaceV2Catalog<RequiredCheckRow>(
    database,
    `/* workspace_v2_required_checks */
     SELECT required.table_name,
            required.constraint_name,
            constraint_record.oid IS NOT NULL
              AND constraint_record.convalidated
              AND constraint_record.contype = 'c'
              AND pg_catalog.pg_get_constraintdef(constraint_record.oid, true)
                = required.definition AS present
     FROM unnest($1::text[], $2::text[], $3::text[])
       AS required(table_name, constraint_name, definition)
     LEFT JOIN pg_catalog.pg_namespace AS namespace
       ON namespace.nspname = $4
     LEFT JOIN pg_catalog.pg_class AS relation
       ON relation.relnamespace = namespace.oid
      AND relation.relname = required.table_name
      AND relation.relkind IN ('r', 'p')
     LEFT JOIN pg_catalog.pg_constraint AS constraint_record
       ON constraint_record.conrelid = relation.oid
      AND constraint_record.conname = required.constraint_name
     ORDER BY required.table_name, required.constraint_name`,
    [
      workspaceV2RequiredChecks.map(({ tableName }) => tableName),
      workspaceV2RequiredChecks.map(({ constraintName }) => constraintName),
      workspaceV2RequiredChecks.map(({ definition }) => definition),
      "public",
    ],
  );

  const presentChecks = new Map(
    checkRows.map((row) => [
      `${row.table_name}\u0000${row.constraint_name}`,
      row.present,
    ] as const),
  );
  for (const { tableName, constraintName } of workspaceV2RequiredChecks) {
    if (presentChecks.get(`${tableName}\u0000${constraintName}`) !== true) {
      throw new DatabaseMigrationError(
        `Workspace V2 schema has a missing or invalid required check ${constraintName} on table ${tableName}.`,
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
