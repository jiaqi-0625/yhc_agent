import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VideoTaskProductionRecord } from "@firefly/domain";
import type {
  AccountBudget,
  AccountHighCostTaskRunLock,
  BatchProject,
  ProjectAssetPool,
  TemporaryAsset,
} from "@firefly/schemas";

import { parsePostgresDatabaseConfig } from "../src/database-config.ts";
import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import {
  applyDatabaseMigrations,
  loadDatabaseMigrations,
  verifyDatabaseSchema,
} from "../src/database-migrations.ts";
import { PostgresBatchProjectStore } from "../src/postgres-batch-project-store.ts";
import {
  createPostgresDatabase,
  PostgresPersistenceError,
  type PostgresDatabase,
} from "../src/postgres-database.ts";
import { PostgresAccountBudgetStore } from "../src/postgres-account-budget-store.ts";
import { PostgresAccountRunLockStore } from "../src/postgres-account-run-lock-store.ts";
import {
  createPostgresApiRuntime,
  PostgresProjectAssetCoordinator,
} from "../src/postgres-api-runtime.ts";
import { PostgresTemporaryAssetStore } from "../src/postgres-temporary-asset-store.ts";
import { PostgresVideoTaskProductionStore } from "../src/postgres-video-task-store.ts";
import { PostgresWorkspaceAdminStore } from "../src/postgres-workspace-admin-store.ts";
import { PostgresWorkspaceSessionStore } from "../src/postgres-workspace-session-store.ts";
import { startConfiguredApiServer } from "../src/server.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const allowSchemaReset = process.env.POSTGRES_TEST_ALLOW_SCHEMA_RESET;

function assertDisposableTestDatabaseUrl(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid URL for a disposable test database.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!databaseName.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL must identify a disposable database whose name ends in _test.");
  }
}

function database(connectionString: string): PostgresDatabase {
  return createPostgresDatabase(
    parsePostgresDatabaseConfig({
      DATABASE_URL: connectionString,
      DATABASE_SSL_MODE: "disable",
      DATABASE_POOL_MAX: "4",
      DATABASE_STATEMENT_TIMEOUT_MS: "30000",
      NODE_ENV: "test",
    }),
  );
}

function hasPostgresSqlState(expected: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof PostgresPersistenceError && error.sqlState === expected;
}

function project(
  id = "project_integration",
  name = "集成测试项目",
  tenantId = "tenant_integration",
): BatchProject {
  return {
    id,
    tenantId,
    brandId: "brand_firefly",
    vehicleId: "vehicle_firefly_e5",
    vehicleVersion: 7,
    name,
    batchName: "数据库集成",
    aspectRatio: "9:16",
    visualStylePresetId: "style_clean",
    assetPoolId: `pool_${id}`,
    status: "active",
    revision: 1,
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_creator",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_creator",
  };
}

function assetPool(value: BatchProject): ProjectAssetPool {
  return {
    id: value.assetPoolId,
    tenantId: value.tenantId,
    batchProjectId: value.id,
    vehicleId: value.vehicleId,
    revision: 1,
    assets: [
      {
        assetId: "asset_firefly_e5_hero",
        version: 1,
        category: "vehicle",
        source: "company_catalog",
        sourceProvider: "integration_catalog",
        vehicleId: value.vehicleId,
      },
    ],
    createdAt: value.createdAt,
    createdBy: value.createdBy,
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy,
  };
}

function videoTask(
  id = "task_integration",
  name = "集成测试主片",
  tenantId = "tenant_integration",
  batchProjectId = "project_integration",
): VideoTaskProductionRecord {
  return {
    schemaVersion: 7,
    videoTask: {
      id,
      tenantId,
      batchProjectId,
      name,
      ownerAccountId: "account_creator",
      status: "active",
      currentStage: "strategy",
      stageStatus: "in_progress",
      revision: 1,
      audience: "城市家庭",
      theme: "夏季上市",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-19T08:00:00.000Z",
      createdBy: "account_creator",
      updatedAt: "2026-08-19T08:00:00.000Z",
      updatedBy: "account_creator",
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskAssetSnapshots: [],
    taskVehicleSnapshots: [],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
    stageMutationReceipts: [],
  };
}

class TrackingLocalBusinessRuntime extends LocalBusinessRuntime {
  legacyReadCount = 0;

  override async listWorks(): ReturnType<LocalBusinessRuntime["listWorks"]> {
    this.legacyReadCount += 1;
    return super.listWorks();
  }

  override async getWork(workId: string): ReturnType<LocalBusinessRuntime["getWork"]> {
    this.legacyReadCount += 1;
    return super.getWork(workId);
  }
}

function accountBudget(): AccountBudget {
  return {
    schemaVersion: 1,
    id: "budget_integration",
    tenantId: "tenant_integration",
    accountId: "account_creator",
    currency: "CNY",
    limitAmountMinor: 100_000,
    revision: 1,
    entries: [],
    createdAt: "2026-08-19T08:00:00.000Z",
    createdBy: "account_admin",
    updatedAt: "2026-08-19T08:00:00.000Z",
    updatedBy: "account_admin",
  };
}

function temporaryAsset(id = "temporary_asset_integration"): TemporaryAsset {
  return {
    id,
    tenantId: "tenant_integration",
    batchProjectId: "project_integration",
    vehicleId: "vehicle_firefly_e5",
    version: 1,
    revision: 1,
    category: "vehicle",
    fileName: `${id}.png`,
    mediaType: "image/png",
    byteSize: 1024,
    width: 1920,
    height: 1080,
    checksumSha256: "a".repeat(64),
    sourceDescription: "PostgreSQL integration upload.",
    rightsDeclaration: "Project usage rights confirmed.",
    rightsConfirmed: true,
    validationStatus: "valid",
    validationIssues: [],
    createdAt: "2026-08-19T08:00:00.000Z",
    createdBy: "account_creator",
    updatedAt: "2026-08-19T08:00:00.000Z",
    updatedBy: "account_creator",
  };
}

function accountRunLock(id: string): AccountHighCostTaskRunLock {
  return {
    id,
    tenantId: "tenant_integration",
    accountId: "account_creator",
    batchProjectId: "project_integration",
    videoTaskId: "task_integration",
    taskRevision: 1,
    operation: "video_generation",
    acquiredAt: "2026-08-19T09:00:00.000Z",
  };
}

async function resetPublicSchema(database: PostgresDatabase): Promise<void> {
  await database.query("DROP SCHEMA IF EXISTS public CASCADE", []);
  await database.query("CREATE SCHEMA public", []);
}

test(
  "real PostgreSQL migrations and aggregate stores preserve concurrency invariants",
  {
    skip: testDatabaseUrl === undefined
      ? "TEST_DATABASE_URL is not configured; real PostgreSQL integration test skipped."
      : false,
    timeout: 120_000,
  },
  async (context) => {
    assert.ok(testDatabaseUrl);
    assertDisposableTestDatabaseUrl(testDatabaseUrl);
    if (allowSchemaReset !== "true") {
      throw new Error(
        "POSTGRES_TEST_ALLOW_SCHEMA_RESET=true is required before resetting the test schema.",
      );
    }
    const firstDatabase = database(testDatabaseUrl);
    const secondDatabase = database(testDatabaseUrl);
    context.after(async () => {
      await resetPublicSchema(firstDatabase).catch(() => undefined);
      await Promise.all([firstDatabase.close(), secondDatabase.close()]);
    });

    await resetPublicSchema(firstDatabase);
    const migrations = await loadDatabaseMigrations();

    await context.test("an empty database migrates, remigrates idempotently, and verifies", async () => {
      await assert.rejects(
        verifyDatabaseSchema(firstDatabase, migrations),
        /schema is not initialized/u,
      );
      const applied = await applyDatabaseMigrations(firstDatabase, migrations);
      const reapplied = await applyDatabaseMigrations(secondDatabase, migrations);
      const verified = await verifyDatabaseSchema(firstDatabase, migrations);
      assert.deepEqual(applied, { currentVersion: migrations.length, expectedVersion: migrations.length });
      assert.deepEqual(reapplied, applied);
      assert.deepEqual(verified, applied);

      await firstDatabase.query(
        "UPDATE firefly_schema_migrations SET checksum = $1 WHERE version = $2",
        ["0".repeat(64), migrations[0]!.version],
      );
      try {
        await assert.rejects(
          verifyDatabaseSchema(firstDatabase, migrations),
          /checksum does not match/u,
        );
      } finally {
        await firstDatabase.query(
          "UPDATE firefly_schema_migrations SET checksum = $1 WHERE version = $2",
          [migrations[0]!.checksum, migrations[0]!.version],
        );
      }
    });

    await context.test("readiness rejects drift in a critical constraint or partial index", async () => {
      await firstDatabase.query(
        `ALTER TABLE video_task_aggregates
           DROP CONSTRAINT video_task_aggregates_task_id_key`,
        [],
      );
      try {
        await assert.rejects(
          verifyDatabaseSchema(firstDatabase, migrations),
          /video_task_aggregates_task_id_key/u,
        );
      } finally {
        await firstDatabase.query(
          `ALTER TABLE video_task_aggregates
             ADD CONSTRAINT video_task_aggregates_task_id_key UNIQUE (task_id)`,
          [],
        );
      }

      await firstDatabase.query(
        "DROP INDEX video_task_aggregates_creation_request_key",
        [],
      );
      try {
        await assert.rejects(
          verifyDatabaseSchema(firstDatabase, migrations),
          /video_task_aggregates_creation_request_key/u,
        );
      } finally {
        await firstDatabase.query(
          `CREATE UNIQUE INDEX video_task_aggregates_creation_request_key
             ON video_task_aggregates (
               tenant_id,
               project_id,
               creation_actor_account_id,
               creation_request_id
             )
             WHERE creation_request_id IS NOT NULL`,
          [],
        );
      }
      await verifyDatabaseSchema(firstDatabase, migrations);
    });

    const firstProjects = new PostgresBatchProjectStore(firstDatabase);
    const secondProjects = new PostgresBatchProjectStore(secondDatabase);
    const firstTasks = new PostgresVideoTaskProductionStore(firstDatabase);
    const secondTasks = new PostgresVideoTaskProductionStore(secondDatabase);

    await context.test("projects and tasks support reads, writes, replay, conflicts, and tenant isolation", async () => {
      const mainProject = project();
      const projectMetadata = {
        requestId: "request_project_integration",
        actorAccountId: "account_creator",
        payloadHash: "project_payload_v1",
      };
      const createdProject = await firstProjects.create(
        mainProject,
        assetPool(mainProject),
        projectMetadata,
      );
      assert.deepEqual(
        await secondProjects.create(mainProject, assetPool(mainProject), projectMetadata),
        createdProject,
      );
      await assert.rejects(
        secondProjects.create(
          mainProject,
          assetPool(mainProject),
          { ...projectMetadata, payloadHash: "project_payload_v2" },
        ),
        /conflicts with a different payload/u,
      );
      assert.equal(
        (await secondProjects.load("tenant_integration", "project_integration"))?.project.name,
        "集成测试项目",
      );

      const otherTenantProject = project(
        "project_other_tenant",
        "集成测试项目",
        "tenant_other",
      );
      await firstProjects.create(
        otherTenantProject,
        assetPool(otherTenantProject),
        {
          requestId: "request_other_tenant",
          actorAccountId: "account_creator",
          payloadHash: "other_tenant_payload",
        },
      );
      assert.deepEqual(
        (await firstProjects.list("tenant_integration")).map(({ project: value }) => value.id),
        ["project_integration"],
      );
      assert.deepEqual(
        (await firstProjects.list("tenant_other")).map(({ project: value }) => value.id),
        ["project_other_tenant"],
      );

      const mainTask = videoTask();
      const taskMetadata = {
        requestId: "request_task_integration",
        actorAccountId: "account_creator",
        payloadHash: "task_payload_v1",
      };
      assert.equal((await firstTasks.createWithResult(mainTask, taskMetadata)).replayed, false);
      assert.equal((await secondTasks.createWithResult(mainTask, taskMetadata)).replayed, true);
      await assert.rejects(
        secondTasks.create(mainTask, { ...taskMetadata, payloadHash: "task_payload_v2" }),
        /conflicts with a different payload/u,
      );
      assert.equal((await secondTasks.load("task_integration"))?.videoTask.name, "集成测试主片");

      const otherTenantTask = videoTask(
        "task_other_tenant",
        "集成测试主片",
        "tenant_other",
        "project_other_tenant",
      );
      await firstTasks.create(otherTenantTask, {
        requestId: "request_task_other_tenant",
        actorAccountId: "account_creator",
        payloadHash: "task_other_tenant_payload",
      });
      assert.deepEqual(
        (await firstTasks.list("tenant_integration", "project_integration"))
          .map(({ videoTask: value }) => value.id),
        ["task_integration"],
      );
      assert.deepEqual(
        (await firstTasks.list("tenant_other", "project_other_tenant"))
          .map(({ videoTask: value }) => value.id),
        ["task_other_tenant"],
      );

      await assert.rejects(
        firstTasks.create(
          videoTask(
            "task_cross_tenant_project",
            "跨租户项目",
            "tenant_other",
            "project_integration",
          ),
          {
            requestId: "request_cross_tenant_project",
            actorAccountId: "account_creator",
            payloadHash: "cross_tenant_project_payload",
          },
        ),
        hasPostgresSqlState("23503"),
      );
    });

    await context.test("independent stores serialize a unique-name race in PostgreSQL", async () => {
      const left = project("project_race_left", "并发唯一名称");
      const right = project("project_race_right", "并发唯一名称");
      const attempts = await Promise.allSettled([
        firstProjects.create(left, assetPool(left), {
          requestId: "request_race_left",
          actorAccountId: "account_creator",
          payloadHash: "race_left",
        }),
        secondProjects.create(right, assetPool(right), {
          requestId: "request_race_right",
          actorAccountId: "account_creator",
          payloadHash: "race_right",
        }),
      ]);
      assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
      const rejected = attempts.find(({ status }) => status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.match(String(rejected.reason), /same name already exists/u);
    });

    await context.test("row locks and revision CAS prevent lost project and task updates", async () => {
      await Promise.all([
        firstProjects.transactAssetPool("tenant_integration", "project_integration", (current) => ({
          ...current,
          revision: current.revision + 1,
        })),
        secondProjects.transactAssetPool("tenant_integration", "project_integration", (current) => ({
          ...current,
          revision: current.revision + 1,
        })),
      ]);
      const persistedProject = await firstProjects.load("tenant_integration", "project_integration");
      assert.equal(persistedProject?.assetPool.revision, 3);
      const projectStorageRevision = await firstDatabase.query<{ revision: string }>(
        `SELECT revision FROM batch_project_aggregates
          WHERE tenant_id = $1 AND project_id = $2`,
        ["tenant_integration", "project_integration"],
      );
      assert.equal(Number(projectStorageRevision.rows[0]?.revision), 3);
      const staleProjectCas = await secondDatabase.query(
        `UPDATE batch_project_aggregates
            SET revision = revision + 1
          WHERE tenant_id = $1 AND project_id = $2 AND revision = $3`,
        ["tenant_integration", "project_integration", 1],
      );
      assert.equal(staleProjectCas.rowCount, 0);

      await Promise.all([
        firstTasks.transact("task_integration", (current) => ({
          ...current!,
          videoTask: { ...current!.videoTask, revision: current!.videoTask.revision + 1 },
        })),
        secondTasks.transact("task_integration", (current) => ({
          ...current!,
          videoTask: { ...current!.videoTask, revision: current!.videoTask.revision + 1 },
        })),
      ]);
      assert.equal((await firstTasks.load("task_integration"))?.videoTask.revision, 3);
      const taskStorageRevision = await firstDatabase.query<{ revision: string }>(
        "SELECT revision FROM video_task_aggregates WHERE task_id = $1",
        ["task_integration"],
      );
      assert.equal(Number(taskStorageRevision.rows[0]?.revision), 3);
      const staleTaskCas = await secondDatabase.query(
        `UPDATE video_task_aggregates
            SET revision = revision + 1
          WHERE task_id = $1 AND revision = $2`,
        ["task_integration", 1],
      );
      assert.equal(staleTaskCas.rowCount, 0);
    });

    await context.test("project asset coordination rolls back writes across stores as one transaction", async () => {
      const coordinator = new PostgresProjectAssetCoordinator(firstDatabase);
      const assets = new PostgresTemporaryAssetStore(firstDatabase);
      const beforeProject = await firstProjects.load("tenant_integration", "project_integration");
      assert.ok(beforeProject);
      assert.deepEqual(await assets.loadProject("project_integration"), []);

      await assert.rejects(
        coordinator.runExclusive("project_integration", async () => {
          await firstProjects.transactAssetPool(
            "tenant_integration",
            "project_integration",
            (current) => ({ ...current, revision: current.revision + 1 }),
          );
          await assets.transactProject("project_integration", () => [
            temporaryAsset("temporary_asset_rollback_probe"),
          ]);
          throw new Error("force coordinated rollback");
        }),
        /force coordinated rollback/u,
      );

      const afterProject = await secondProjects.load("tenant_integration", "project_integration");
      assert.equal(afterProject?.assetPool.revision, beforeProject.assetPool.revision);
      assert.deepEqual(await new PostgresTemporaryAssetStore(secondDatabase)
        .loadProject("project_integration"), []);
    });

    await context.test("administration, sessions, and budgets persist across store instances", async () => {
      const firstAdmin = new PostgresWorkspaceAdminStore(firstDatabase);
      const secondAdmin = new PostgresWorkspaceAdminStore(secondDatabase);
      await firstAdmin.transact("tenant_integration", (current) => current);
      assert.deepEqual(await secondAdmin.load("tenant_integration"), {
        schemaVersion: 1,
        tenantId: "tenant_integration",
        brands: [],
        vehicleVersions: [],
        vehicleAssetAssociations: [],
        accessGrants: [],
      });
      await Promise.all([
        firstAdmin.transact("tenant_integration", (current) => current),
        secondAdmin.transact("tenant_integration", (current) => current),
      ]);
      const adminRevision = await firstDatabase.query<{ revision: string }>(
        "SELECT revision FROM workspace_admin_states WHERE tenant_id = $1",
        ["tenant_integration"],
      );
      assert.equal(Number(adminRevision.rows[0]?.revision), 3);
      const staleAdminCas = await firstDatabase.query(
        `UPDATE workspace_admin_states
            SET revision = revision + 1
          WHERE tenant_id = $1 AND revision = $2`,
        ["tenant_integration", 1],
      );
      assert.equal(staleAdminCas.rowCount, 0);

      const sessionToken = "session_postgres_integration_secret";
      const firstSessions = new PostgresWorkspaceSessionStore(
        firstDatabase,
        () => "2026-08-19T08:00:00.000Z",
        () => sessionToken,
      );
      const secondSessions = new PostgresWorkspaceSessionStore(
        secondDatabase,
        () => "2026-08-19T09:00:00.000Z",
      );
      const createdSession = await firstSessions.create(
        "account_creator",
        "2026-08-20T08:00:00.000Z",
      );
      assert.deepEqual(await secondSessions.load(sessionToken), createdSession);
      assert.equal((await secondSessions.signOut(sessionToken))?.signedOutAt, "2026-08-19T09:00:00.000Z");
      assert.equal(await firstSessions.loadActive(sessionToken, "2026-08-19T10:00:00.000Z"), undefined);
      const persistedSession = await firstDatabase.query<{ state: string }>(
        "SELECT state::text AS state FROM workspace_sessions",
        [],
      );
      assert.doesNotMatch(persistedSession.rows[0]!.state, new RegExp(sessionToken, "u"));

      const firstBudgets = new PostgresAccountBudgetStore(firstDatabase);
      const secondBudgets = new PostgresAccountBudgetStore(secondDatabase);
      await firstBudgets.transact("tenant_integration", "account_creator", () => accountBudget());
      assert.deepEqual(
        await secondBudgets.load("tenant_integration", "account_creator"),
        accountBudget(),
      );
      await Promise.all([
        firstBudgets.transact("tenant_integration", "account_creator", (current) => ({
          ...current!,
          revision: current!.revision + 1,
        })),
        secondBudgets.transact("tenant_integration", "account_creator", (current) => ({
          ...current!,
          revision: current!.revision + 1,
        })),
      ]);
      assert.equal(
        (await firstBudgets.load("tenant_integration", "account_creator"))?.revision,
        3,
      );

      await assert.rejects(
        firstDatabase.query(
          `INSERT INTO workspace_admin_states (tenant_id, revision, state)
           VALUES ($1, 1, $2::jsonb)`,
          [
            "tenant_scope_probe",
            JSON.stringify({
              schemaVersion: 1,
              tenantId: "tenant_other",
              brands: [],
              vehicleVersions: [],
              vehicleAssetAssociations: [],
              accessGrants: [],
            }),
          ],
        ),
        hasPostgresSqlState("23514"),
      );
    });

    await context.test("temporary assets and run locks preserve scoped relational contracts", async () => {
      const firstAssets = new PostgresTemporaryAssetStore(firstDatabase);
      const secondAssets = new PostgresTemporaryAssetStore(secondDatabase);
      await firstAssets.transactProject("project_integration", () => [temporaryAsset()]);
      assert.deepEqual(
        await secondAssets.loadProject("project_integration"),
        [temporaryAsset()],
      );
      await secondAssets.transactProject("project_integration", (current) => [
        ...current,
        temporaryAsset("temporary_asset_integration_2"),
      ]);
      assert.deepEqual(
        (await new PostgresTemporaryAssetStore(firstDatabase)
          .loadProject("project_integration")).map(({ id }) => id),
        ["temporary_asset_integration", "temporary_asset_integration_2"],
      );
      await assert.rejects(
        firstDatabase.query(
          `UPDATE temporary_asset_project_states
              SET envelope = jsonb_set(envelope, '{batchProjectId}', '"project_other"'::jsonb)
            WHERE batch_project_id = $1`,
          ["project_integration"],
        ),
        hasPostgresSqlState("23514"),
      );
      await assert.rejects(
        firstDatabase.query(
          `UPDATE temporary_asset_project_states
              SET envelope = jsonb_set(envelope, '{assets,0,tenantId}', '"tenant_other"'::jsonb)
            WHERE batch_project_id = $1`,
          ["project_integration"],
        ),
        hasPostgresSqlState("23514"),
      );
      await assert.rejects(
        firstDatabase.query(
          `UPDATE temporary_asset_project_states
              SET envelope = jsonb_set(envelope, '{assets,0,batchProjectId}', '"project_other"'::jsonb)
            WHERE batch_project_id = $1`,
          ["project_integration"],
        ),
        hasPostgresSqlState("23514"),
      );

      const firstLocks = new PostgresAccountRunLockStore(firstDatabase);
      const secondLocks = new PostgresAccountRunLockStore(secondDatabase);
      const attempts = await Promise.allSettled([
        firstLocks.transact("tenant_integration", "account_creator", (current) => {
          if (current !== undefined) throw new Error("account slot is occupied");
          return accountRunLock("run_lock_integration_first");
        }),
        secondLocks.transact("tenant_integration", "account_creator", (current) => {
          if (current !== undefined) throw new Error("account slot is occupied");
          return accountRunLock("run_lock_integration_second");
        }),
      ]);
      assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
      const activeLock = await new PostgresAccountRunLockStore(firstDatabase).load(
        "tenant_integration",
        "account_creator",
      );
      assert.ok(activeLock);
      await assert.rejects(
        firstDatabase.query(
          `UPDATE account_run_lock_states
              SET envelope = jsonb_set(envelope, '{accountId}', '"account_other"'::jsonb)
            WHERE tenant_id = $1 AND account_id = $2`,
          ["tenant_integration", "account_creator"],
        ),
        hasPostgresSqlState("23514"),
      );
      await assert.rejects(
        firstDatabase.query(
          `UPDATE account_run_lock_states
              SET envelope = jsonb_set(envelope, '{acquiredAt}', '"2026-08-19T10:00:00.000Z"'::jsonb)
            WHERE tenant_id = $1 AND account_id = $2`,
          ["tenant_integration", "account_creator"],
        ),
        hasPostgresSqlState("23514"),
      );
      await secondLocks.transact("tenant_integration", "account_creator", (current) => {
        assert.equal(current?.id, activeLock.id);
        return undefined;
      });
      assert.equal(
        await firstLocks.load("tenant_integration", "account_creator"),
        undefined,
      );
    });

    await context.test(
      "configured API completes the authenticated V2 task Agent flow without local Work fallback",
      async () => {
        const temporaryRoot = await mkdtemp(join(tmpdir(), "firefly-pg-api-"));
        const apiDatabase = database(testDatabaseUrl);
        const postgres = await createPostgresApiRuntime(
          parsePostgresDatabaseConfig({
            DATABASE_URL: testDatabaseUrl,
            DATABASE_SSL_MODE: "disable",
            DATABASE_POOL_MAX: "4",
            NODE_ENV: "test",
          }),
          { database: apiDatabase, migrations },
        );
        const business = new TrackingLocalBusinessRuntime();
        let server: Awaited<ReturnType<typeof startConfiguredApiServer>> | undefined;
        try {
          server = await startConfiguredApiServer(0, "127.0.0.1", {
            environment: {
              NODE_ENV: "development",
              PERSISTENCE_BACKEND: "postgres",
              DATABASE_URL: testDatabaseUrl,
              DATABASE_SSL_MODE: "disable",
              DATABASE_POOL_MAX: "4",
              AGENT_PROVIDER: "mock",
              LOCAL_AGENT_PERSIST_SESSIONS: "false",
              LOCAL_AGENT_DATA_DIR: join(temporaryRoot, "agent-sessions"),
              WORKSPACE_MIGRATION_DATA_DIRECTORY: join(temporaryRoot, "migrations"),
            },
            business,
            createPostgresRuntime: async () => postgres,
            registerSignalHandlers: false,
          });
          const address = server.address();
          assert.ok(address && typeof address === "object");
          const baseUrl = `http://127.0.0.1:${address.port}`;

          const accountResponse = await fetch(`${baseUrl}/v1/auth/session`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ accountId: "account_creator_a" }),
          });
          assert.equal(accountResponse.status, 201);
          const workspaceToken = ((await accountResponse.json()) as {
            session: { token: string };
          }).session.token;
          const authenticatedHeaders = {
            authorization: `Bearer ${workspaceToken}`,
            "content-type": "application/json",
          };

          const vehicleId = "vehicle_firefly_e5_2026_long_range";
          const assetPackageResponse = await fetch(
            `${baseUrl}/v1/workspace/project-creation/vehicles/${vehicleId}/asset-package`,
            { headers: authenticatedHeaders },
          );
          assert.equal(assetPackageResponse.status, 200);
          const assetReference = ((await assetPackageResponse.json()) as {
            recommendedAssets: Array<{ reference: Record<string, unknown> }>;
          }).recommendedAssets[0]?.reference;
          assert.ok(assetReference);

          const projectResponse = await fetch(`${baseUrl}/v1/workspace/batch-projects`, {
            method: "POST",
            headers: authenticatedHeaders,
            body: JSON.stringify({
              requestId: "request_pg_api_project",
              vehicleId,
              expectedBrandRevision: 1,
              expectedVehicleVersion: 1,
              expectedAssetAssociationRevision: 1,
              selectedAssets: [assetReference],
              aspectRatio: "9:16",
              batchName: "PG Agent 串行闭环",
              customStylePrompt: "清透产品光线",
            }),
          });
          assert.equal(projectResponse.status, 201);
          const projectId = ((await projectResponse.json()) as {
            project: { id: string };
          }).project.id;

          const taskResponse = await fetch(
            `${baseUrl}/v1/workspace/batch-projects/${projectId}/video-tasks`,
            {
              method: "POST",
              headers: authenticatedHeaders,
              body: JSON.stringify({
                requestId: "request_pg_api_task",
                name: "PG Agent 主片",
                audience: "城市家庭",
                theme: "智能通勤",
                durationSeconds: 30,
                platformTags: ["douyin"],
                ownerAccountId: "account_creator_a",
              }),
            },
          );
          assert.equal(taskResponse.status, 201);
          const videoTaskId = ((await taskResponse.json()) as {
            task: { id: string };
          }).task.id;

          const libraryResponse = await fetch(`${baseUrl}/v1/workspace/project-library`, {
            headers: authenticatedHeaders,
          });
          assert.equal(libraryResponse.status, 200);
          assert.match(await libraryResponse.text(), new RegExp(videoTaskId, "u"));

          const sessionResponse = await fetch(`${baseUrl}/v1/sessions`, {
            method: "POST",
            headers: authenticatedHeaders,
            body: JSON.stringify({ videoTaskId }),
          });
          assert.equal(sessionResponse.status, 201);
          const agentSessionId = ((await sessionResponse.json()) as {
            session: { id: string; taskContext: { videoTask: { id: string } } };
          }).session.id;

          const taskQuery = `?videoTaskId=${encodeURIComponent(videoTaskId)}`;
          const runResponse = await fetch(
            `${baseUrl}/v1/sessions/${encodeURIComponent(agentSessionId)}/runs${taskQuery}`,
            {
              method: "POST",
              headers: authenticatedHeaders,
              body: JSON.stringify({
                message: "请确认 PostgreSQL V2 任务上下文已接通。",
                requestId: "request_pg_api_agent_run",
              }),
            },
          );
          assert.equal(runResponse.status, 202);
          const runId = ((await runResponse.json()) as { run: { runId: string } }).run.runId;

          const eventsResponse = await fetch(
            `${baseUrl}/v1/sessions/${encodeURIComponent(agentSessionId)}` +
              `/runs/${encodeURIComponent(runId)}/events${taskQuery}`,
            { headers: { authorization: `Bearer ${workspaceToken}` } },
          );
          assert.equal(eventsResponse.status, 200);
          const events = await eventsResponse.text();
          assert.match(events, /"type":"run_completed"/u);
          assert.match(events, /event: complete/u);

          const transcriptResponse = await fetch(
            `${baseUrl}/v1/sessions/${encodeURIComponent(agentSessionId)}/transcript${taskQuery}`,
            { headers: { authorization: `Bearer ${workspaceToken}` } },
          );
          assert.equal(transcriptResponse.status, 200);
          const transcript = (await transcriptResponse.json()) as { messages: unknown[] };
          assert.equal(transcript.messages.length, 2);

          const legacyWorks = await fetch(`${baseUrl}/v1/works`);
          assert.equal(legacyWorks.status, 404);
          assert.equal(business.legacyReadCount, 0);
        } finally {
          if (server?.listening) {
            await new Promise<void>((resolve, reject) => {
              server!.close((error) => error === undefined ? resolve() : reject(error));
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
          } else {
            await postgres.close().catch(() => undefined);
          }
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      },
    );
  },
);
