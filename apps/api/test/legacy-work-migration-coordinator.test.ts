import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import {
  LocalSessionStore,
  type PersistedLocalSessionV1,
} from "@firefly/agent";
import type { WorkspaceSessionScope } from "@firefly/domain";
import type {
  Claim,
  Strategy,
  VehicleSnapshot,
} from "@firefly/schemas";

import { LocalBatchProjectStore } from "../src/batch-project-store.ts";
import { LocalWorkStore, type LocalWorkRecord } from "../src/business-store.ts";
import {
  LegacyWorkspaceMigrationCoordinator,
  type LegacyWorkspaceMigrationConfig,
  type LegacyWorkspaceMigrationCoordinatorOptions,
  type LegacyWorkspaceMigrationDirectories,
  type LegacyWorkspaceMigrationStep,
} from "../src/legacy-work-migration-coordinator.ts";
import { migrateLegacyWorkRecords } from "../src/legacy-work-migration.ts";
import { VideoTaskStageRuntime } from "../src/video-task-stage-runtime.ts";
import { LocalVideoTaskProductionStore } from "../src/video-task-store.ts";
import {
  DEFAULT_ADMIN_BRANDS,
  DEFAULT_ADMIN_VEHICLES,
  DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
} from "../src/workspace-admin-runtime.ts";
import { LocalWorkspaceAdminStore } from "../src/workspace-admin-store.ts";
import { DEVELOPMENT_ACCESS_GRANTS } from "../src/workspace-session-runtime.ts";

const tenantId = "tenant_firefly";
const brandId = "brand_firefly_demo";
const vehicleId = "vehicle_firefly_e5_2026_long_range";
const ownerAccountId = "account_creator_a";
const migrationActorAccountId = "account_admin";
const migrationId = "migration_ws307_coordinator";
const projectId = "batch_project_ws307_coordinator";
const workId = "work_ws307_coordinator";
const sessionId = "session_ws307_coordinator";
const vehicleSnapshotId = "snapshot_ws307_coordinator";
const timestamp = "2026-08-19T18:00:00.000Z";

const fixedClaim: Claim = {
  id: "claim_ws307_range",
  kind: "fixed",
  name: "CLTC 续航",
  statement: "CLTC 续航 550 公里",
  value: 550,
  unit: "公里",
  evidence: {
    sourceName: "历史车型配置表",
    sourceReference: "legacy-ws307#range",
    effectiveFrom: "2026-08-01",
  },
  requiredInVoiceover: true,
  requiredInSubtitle: true,
  mayRephrase: false,
  riskNotes: [],
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function vehicleSnapshot(): VehicleSnapshot {
  return {
    id: vehicleSnapshotId,
    projectId: "legacy_project_ws307",
    vehicleId,
    vehicleVersion: 1,
    brandId,
    brand: "萤火汽车",
    series: "萤火 E5",
    modelYear: 2026,
    trim: "长续航版",
    color: "萤火绿",
    parameters: { seats: 5, energyType: "纯电" },
    fixedClaims: [structuredClone(fixedClaim)],
    optionalClaims: [],
    prohibitedClaims: ["自动驾驶"],
    referenceAssetIds: ["asset_firefly_demo_e5_hero"],
    createdAt: "2026-08-18T08:00:00.000Z",
    createdBy: ownerAccountId,
  };
}

function legacyStrategy(): Strategy {
  return {
    id: "strategy_ws307_coordinator_v1",
    workId,
    vehicleSnapshotId,
    version: 1,
    status: "awaiting_approval",
    audience: "城市家庭",
    theme: "周末出行",
    items: [{
      id: "strategy_item_ws307_range",
      claimId: fixedClaim.id,
      kind: "fixed",
      title: "长续航",
      statement: fixedClaim.statement,
      rationale: "保留历史车型事实。",
      order: 1,
      locked: true,
      ...(fixedClaim.evidence === undefined
        ? {}
        : { evidence: structuredClone(fixedClaim.evidence) }),
    }],
    model: "legacy-model",
    templateVersion: "legacy-template-v1",
    createdAt: "2026-08-18T08:05:00.000Z",
    createdBy: ownerAccountId,
    updatedAt: "2026-08-18T08:10:00.000Z",
  };
}

function legacyWork(): LocalWorkRecord {
  return {
    schemaVersion: 1,
    work: {
      id: workId,
      projectId: "legacy_project_ws307",
      status: "awaiting_strategy_approval",
      revision: 3,
      vehicleSnapshotId,
      createdAt: "2026-08-18T08:00:00.000Z",
      updatedAt: "2026-08-18T08:10:00.000Z",
    },
    vehicleSnapshot: vehicleSnapshot(),
    strategyVersions: [legacyStrategy()],
    approvals: [],
  };
}

function legacySession(): PersistedLocalSessionV1 {
  return {
    schemaVersion: 1,
    id: sessionId,
    workId,
    createdAt: "2026-08-18T08:00:00.000Z",
    updatedAt: "2026-08-18T08:11:00.000Z",
    provider: "legacy-provider",
    modelId: "legacy-model",
    messages: [],
  };
}

function administration() {
  const vehicle = DEFAULT_ADMIN_VEHICLES[0];
  assert.ok(vehicle);
  return {
    brands: structuredClone(DEFAULT_ADMIN_BRANDS),
    vehicleVersions: [{
      ...structuredClone(vehicle),
      series: "萤火 E5",
      modelYear: 2026,
      trim: "长续航版",
      parameters: { seats: 5, energyType: "纯电" },
      fixedClaims: [structuredClone(fixedClaim)],
      optionalClaims: [],
      prohibitedClaims: ["自动驾驶"],
    }],
    vehicleAssetAssociations: structuredClone(DEFAULT_VEHICLE_ASSET_ASSOCIATIONS),
    accessGrants: structuredClone(
      DEVELOPMENT_ACCESS_GRANTS.filter(
        (grant) =>
          grant.accountId === ownerAccountId ||
          grant.accountId === migrationActorAccountId,
      ),
    ),
  };
}

interface CoordinatorFixture {
  root: string;
  directories: LegacyWorkspaceMigrationDirectories;
  config: LegacyWorkspaceMigrationConfig;
  coordinator: LegacyWorkspaceMigrationCoordinator;
  sourceWork: LocalWorkRecord;
  sourceSession: PersistedLocalSessionV1;
  workPath: string;
  sessionPath: string;
  adminPath: string;
  projectPath: string;
  taskPath: string;
  originalWorkBytes: Buffer;
  originalSessionBytes: Buffer;
  originalAdminBytes: Buffer;
}

async function coordinatorFixture(
  context: TestContext,
  options: Readonly<LegacyWorkspaceMigrationCoordinatorOptions> = {},
): Promise<CoordinatorFixture> {
  const root = await mkdtemp(join(tmpdir(), "firefly-ws307-coordinator-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const directories: LegacyWorkspaceMigrationDirectories = {
    works: join(root, "legacy-works"),
    sessions: join(root, "agent-sessions"),
    workspaceAdmin: join(root, "workspace-admin"),
    batchProjects: join(root, "batch-projects"),
    videoTasks: join(root, "video-tasks"),
    migrations: join(root, "workspace-migrations"),
  };
  const sourceWork = legacyWork();
  const sourceSession = legacySession();
  await new LocalWorkStore(directories.works).save(sourceWork);
  await mkdir(directories.sessions, { recursive: true });
  const sessionPath = join(directories.sessions, `${sessionId}.json`);
  await writeFile(sessionPath, `${JSON.stringify(sourceSession, null, 2)}\n`, "utf8");

  // Persist a valid empty administration preimage so apply/restore must back
  // up and recover an existing target, not only create new files.
  const emptyAdministration = new LocalWorkspaceAdminStore(directories.workspaceAdmin);
  await emptyAdministration.transact(tenantId, (current) => current);

  const association = DEFAULT_VEHICLE_ASSET_ASSOCIATIONS[0];
  assert.ok(association);
  const config: LegacyWorkspaceMigrationConfig = {
    schemaVersion: 1,
    migration: {
      migrationId,
      migrationOccurredAt: timestamp,
      migrationActorAccountId,
      tenantId,
      brandId,
      brandName: "萤火汽车",
      vehicleId,
      vehicleVersion: 1,
      batchProjectId: projectId,
      assetPoolId: "asset_pool_ws307_coordinator",
      batchName: "WS307 历史迁移",
      aspectRatio: "9:16",
      visualStylePresetId: "asset_style_firefly_demo_clean",
      projectAssets: structuredClone(association.assets),
      taskOwnerAccountId: ownerAccountId,
      taskCreatedByAccountId: ownerAccountId,
      taskNamePrefix: "历史作品",
      defaultAudience: "历史受众未知",
      defaultTheme: "历史主题未知",
      defaultDurationSeconds: 30,
      defaultPlatformTags: ["legacy"],
    },
    legacySessionOwnerAccountId: ownerAccountId,
    taskOwnerDisplayName: "制作账号 A",
    legacyV3SessionScopeMappings: [],
    administration: administration(),
    directories,
  };
  const workPath = join(directories.works, `${workId}.json`);
  const adminPath = join(directories.workspaceAdmin, `${tenantId}.json`);
  return {
    root,
    directories,
    config,
    coordinator: new LegacyWorkspaceMigrationCoordinator(config, options),
    sourceWork,
    sourceSession,
    workPath,
    sessionPath,
    adminPath,
    projectPath: join(directories.batchProjects, tenantId, `${projectId}.json`),
    taskPath: join(directories.videoTasks, `${workId}.json`),
    originalWorkBytes: await readFile(workPath),
    originalSessionBytes: await readFile(sessionPath),
    originalAdminBytes: await readFile(adminPath),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fileSnapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result[relative(root, path).replaceAll("\\", "/")] = sha256(await readFile(path));
    }
  }
  await visit(root);
  return result;
}

function backupPath(value: CoordinatorFixture, relativePath: string): string {
  return join(
    value.directories.migrations,
    migrationId,
    "backup",
    ...relativePath.split("/"),
  );
}

test("plan is read-only and stable, and a wrong hash produces no migration writes", async (context) => {
  const value = await coordinatorFixture(context);
  const before = await fileSnapshot(value.root);

  const first = await value.coordinator.plan();
  const second = await value.coordinator.plan();

  assert.deepEqual(second, first);
  assert.match(first.planHashSha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.summary.targetWriteCount, 4);
  assert.deepEqual(await fileSnapshot(value.root), before);
  assert.equal(await value.coordinator.loadManifest(), undefined);

  await assert.rejects(
    value.coordinator.apply("0".repeat(64)),
    /migration plan changed/u,
  );
  assert.equal(await value.coordinator.loadManifest(), undefined);
  assert.equal(await exists(backupPath(value, "source-works")), false);
  assert.equal(await exists(value.projectPath), false);
  assert.equal(await exists(value.taskPath), false);
  assert.deepEqual(await readFile(value.workPath), value.originalWorkBytes);
  assert.deepEqual(await readFile(value.sessionPath), value.originalSessionBytes);
  assert.deepEqual(await readFile(value.adminPath), value.originalAdminBytes);
});

test("plan rejects administration facts that differ from legacy snapshots without writes", async (context) => {
  const value = await coordinatorFixture(context);
  const before = await fileSnapshot(value.root);
  const config = structuredClone(value.config);
  config.administration.vehicleVersions[0]!.trim = "不一致车型";

  await assert.rejects(
    new LegacyWorkspaceMigrationCoordinator(config).plan(),
    /vehicle facts do not match/u,
  );
  assert.deepEqual(await fileSnapshot(value.root), before);
});

test("configuration rejects a migration audit actor without explicit project access", async (context) => {
  const value = await coordinatorFixture(context);
  const config = structuredClone(value.config);
  config.migration.migrationActorAccountId = "account_unmapped_migration_auditor";

  assert.throws(
    () => new LegacyWorkspaceMigrationCoordinator(config),
    /account_unmapped_migration_auditor.*lacks explicit project access/u,
  );
});

test("apply backs up first, creates loadable targets, and exact replay is a no-op", async (context) => {
  const value = await coordinatorFixture(context);
  const steps: Array<[LegacyWorkspaceMigrationStep, string]> = [];
  const coordinator = new LegacyWorkspaceMigrationCoordinator(value.config, {
    now: () => timestamp,
    async afterStep(step, id) {
      steps.push([step, id]);
      if (step !== "manifest_written") return;
      assert.deepEqual(
        await readFile(backupPath(value, `source-works/${workId}.json`)),
        value.originalWorkBytes,
      );
      assert.deepEqual(
        await readFile(backupPath(value, `source-sessions/${sessionId}.json`)),
        value.originalSessionBytes,
      );
      assert.deepEqual(
        await readFile(backupPath(value, `target-preimages/workspace-admin/${tenantId}.json`)),
        value.originalAdminBytes,
      );
      assert.equal(await exists(value.projectPath), false);
      assert.equal(await exists(value.taskPath), false);
      assert.deepEqual(await readFile(value.sessionPath), value.originalSessionBytes);
      assert.deepEqual(await readFile(value.adminPath), value.originalAdminBytes);
    },
  });
  const plan = await coordinator.plan();

  const applied = await coordinator.apply(plan.planHashSha256);

  assert.equal(applied.replayed, false);
  assert.equal(applied.manifest.status, "completed");
  assert.deepEqual(steps, [
    ["manifest_written", migrationId],
    ["workspace_admin_written", tenantId],
    ["batch_project_written", projectId],
    ["video_task_written", workId],
    ["agent_session_written", sessionId],
    ["verified", migrationId],
  ]);
  assert.ok(applied.manifest.plan.targets.every(
    (target) => !target.writeRequired || target.appliedSha256 === target.expectedPostimageSha256,
  ));
  assert.deepEqual(await readFile(value.workPath), value.originalWorkBytes);

  const admin = await new LocalWorkspaceAdminStore(value.directories.workspaceAdmin).load(tenantId);
  assert.deepEqual(admin.brands.map(({ id }) => id), [brandId]);
  assert.deepEqual(admin.vehicleVersions.map(({ id }) => id), [vehicleId]);
  assert.deepEqual(admin.accessGrants.map(({ accountId }) => accountId), [
    migrationActorAccountId,
    ownerAccountId,
  ]);
  const project = await new LocalBatchProjectStore(value.directories.batchProjects).load(
    tenantId,
    projectId,
  );
  assert.equal(project?.project.id, projectId);
  assert.equal(project?.assetPool.batchProjectId, projectId);
  const task = await new LocalVideoTaskProductionStore(value.directories.videoTasks).load(workId);
  assert.equal(task?.videoTask.id, workId);
  assert.equal(task?.videoTask.stageStatus, "awaiting_confirmation");
  const session = await new LocalSessionStore(value.directories.sessions).load(sessionId);
  assert.equal(session?.schemaVersion, 3);
  assert.equal(session?.taskContext?.videoTask.id, workId);
  assert.deepEqual(session?.scope, {
    actorId: ownerAccountId,
    tenantId,
    projectId,
    videoTaskId: workId,
  });

  const beforeReplay = await fileSnapshot(value.root);
  const replay = await coordinator.apply(plan.planHashSha256);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.manifest, applied.manifest);
  assert.deepEqual(await fileSnapshot(value.root), beforeReplay);
});

test("an injected partial write stays in-progress, blocks API leases, rejects config drift, and resumes", async (context) => {
  const value = await coordinatorFixture(context);
  const plan = await value.coordinator.plan();
  const failing = new LegacyWorkspaceMigrationCoordinator(value.config, {
    async afterStep(step) {
      if (step === "video_task_written") throw new Error("injected coordinator failure");
    },
  });

  await assert.rejects(
    failing.apply(plan.planHashSha256),
    /injected coordinator failure/u,
  );
  const interrupted = await failing.loadManifest();
  assert.equal(interrupted?.status, "in_progress");
  assert.equal(await exists(value.taskPath), true);
  assert.deepEqual(await readFile(value.sessionPath), value.originalSessionBytes);
  await assert.rejects(
    failing.state.acquireApiLease(),
    /migration is incomplete/u,
  );

  const changedConfig = structuredClone(value.config);
  changedConfig.migration.defaultDurationSeconds += 1;
  const changedCoordinator = new LegacyWorkspaceMigrationCoordinator(changedConfig);
  const beforeConflict = await fileSnapshot(value.root);
  await assert.rejects(
    changedCoordinator.resume(plan.planHashSha256),
    /config conflicts with the in-progress manifest/u,
  );
  assert.deepEqual(await fileSnapshot(value.root), beforeConflict);

  const resumed = await value.coordinator.resume(plan.planHashSha256);
  assert.equal(resumed.replayed, false);
  assert.equal(resumed.manifest.status, "completed");
  assert.equal((await new LocalSessionStore(value.directories.sessions).load(sessionId))?.schemaVersion, 3);
  assert.deepEqual(await readFile(value.workPath), value.originalWorkBytes);
});

test("source and target changes after planning are rejected before a manifest is committed", async (context) => {
  const changedSource = await coordinatorFixture(context);
  const sourcePlan = await changedSource.coordinator.plan();
  const updatedSource = structuredClone(changedSource.sourceWork);
  updatedSource.work.updatedAt = "2026-08-18T08:12:00.000Z";
  await new LocalWorkStore(changedSource.directories.works).save(updatedSource);

  await assert.rejects(
    changedSource.coordinator.apply(sourcePlan.planHashSha256),
    /migration plan changed/u,
  );
  assert.equal(await changedSource.coordinator.loadManifest(), undefined);
  assert.equal(await exists(changedSource.projectPath), false);
  assert.equal(await exists(changedSource.taskPath), false);
  assert.deepEqual(await readFile(changedSource.sessionPath), changedSource.originalSessionBytes);
  assert.deepEqual(await readFile(changedSource.adminPath), changedSource.originalAdminBytes);

  const changedTarget = await coordinatorFixture(context);
  const targetPlan = await changedTarget.coordinator.plan();
  const mapped = migrateLegacyWorkRecords(
    [changedTarget.sourceWork],
    changedTarget.config.migration,
  );
  await new LocalBatchProjectStore(changedTarget.directories.batchProjects).create(
    { ...mapped.project, name: `${mapped.project.name} 冲突` },
    mapped.assetPool,
    {
      requestId: "request_conflicting_project",
      actorAccountId: ownerAccountId,
      payloadHash: "conflicting-project",
    },
  );

  await assert.rejects(
    changedTarget.coordinator.apply(targetPlan.planHashSha256),
    /already exists with different data/u,
  );
  assert.equal(await changedTarget.coordinator.loadManifest(), undefined);
  assert.equal(await exists(changedTarget.taskPath), false);
  assert.deepEqual(await readFile(changedTarget.sessionPath), changedTarget.originalSessionBytes);
  assert.deepEqual(await readFile(changedTarget.adminPath), changedTarget.originalAdminBytes);
});

test("restore recovers untouched postimages but refuses a normally advanced video task", async (context) => {
  const restorable = await coordinatorFixture(context);
  const restorablePlan = await restorable.coordinator.plan();
  await restorable.coordinator.apply(restorablePlan.planHashSha256);

  const restored = await restorable.coordinator.restore();
  assert.equal(restored.status, "restored");
  assert.equal(await exists(restorable.projectPath), false);
  assert.equal(await exists(restorable.taskPath), false);
  assert.deepEqual(await readFile(restorable.workPath), restorable.originalWorkBytes);
  assert.deepEqual(await readFile(restorable.sessionPath), restorable.originalSessionBytes);
  assert.deepEqual(await readFile(restorable.adminPath), restorable.originalAdminBytes);
  assert.deepEqual(await restorable.coordinator.restore(), restored);

  const advanced = await coordinatorFixture(context);
  const advancedPlan = await advanced.coordinator.plan();
  await advanced.coordinator.apply(advancedPlan.planHashSha256);
  const admin = new LocalWorkspaceAdminStore(advanced.directories.workspaceAdmin);
  const projects = new LocalBatchProjectStore(advanced.directories.batchProjects);
  const tasks = new LocalVideoTaskProductionStore(advanced.directories.videoTasks);
  const task = await tasks.load(workId);
  assert.ok(task);
  const scope: WorkspaceSessionScope = {
    actorAccountId: ownerAccountId,
    tenantId,
    role: "creator",
    accessGrants: await admin.listForAccount(tenantId, ownerAccountId),
  };
  const stages = new VideoTaskStageRuntime(
    admin,
    projects,
    tasks,
    () => "2026-08-19T18:10:00.000Z",
    (kind) => `${kind}_advanced`,
  );
  await stages.confirmStage(projectId, workId, "strategy", {
    requestId: "request_advance_migrated_task",
    expectedTaskRevision: task.videoTask.revision,
    comment: "迁移后正常人工确认。",
  }, scope);
  const advancedTask = await tasks.load(workId);
  assert.equal(advancedTask?.videoTask.revision, task.videoTask.revision + 1);
  const beforeRefusal = await fileSnapshot(advanced.root);

  await assert.rejects(
    advanced.coordinator.restore(),
    /changed after migration; restore refused/u,
  );
  assert.deepEqual(await fileSnapshot(advanced.root), beforeRefusal);
  assert.equal((await advanced.coordinator.loadManifest())?.status, "completed");
});
