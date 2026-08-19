import assert from "node:assert/strict";
import test from "node:test";

import type {
  AssetReference,
  BatchProject,
  CompanyReusableAssetReference,
  CompanyVehicleAssetReference,
  ProjectAssetPool,
  TemporaryAssetReference,
} from "@firefly/schemas";

import {
  AssetPoolError,
  createProjectAssetPool,
  lockVideoTaskAssetSnapshot,
  refreshProjectAssetPool,
  RevisionConflictError,
  type AssetPoolErrorCode,
  type AssetPoolMutationContext,
  type VideoTaskProductionRecord,
} from "../src/index.ts";

const project: BatchProject = {
  id: "project_launch",
  tenantId: "tenant_firefly",
  brandId: "brand_firefly",
  vehicleId: "vehicle_e5",
  vehicleVersion: 1,
  name: "萤火 E5 9:16 上市",
  batchName: "上市",
  aspectRatio: "9:16",
  visualStylePresetId: "style_default",
  assetPoolId: "asset_pool_e5",
  status: "active",
  revision: 1,
  createdAt: "2026-08-18T08:00:00.000Z",
  createdBy: "account_owner",
  updatedAt: "2026-08-18T08:00:00.000Z",
  updatedBy: "account_owner",
};

function vehicleAsset(
  version = 1,
  overrides: Partial<CompanyVehicleAssetReference> = {},
): CompanyVehicleAssetReference {
  return {
    assetId: "asset_vehicle_e5",
    version,
    source: "company_catalog",
    sourceProvider: "mock_company_assets",
    category: "vehicle",
    vehicleId: "vehicle_e5",
    ...overrides,
  };
}

function reusableAsset(
  version = 1,
  overrides: Partial<CompanyReusableAssetReference> = {},
): CompanyReusableAssetReference {
  return {
    assetId: "asset_person_1",
    version,
    source: "company_catalog",
    sourceProvider: "mock_company_assets",
    category: "person",
    ...overrides,
  };
}

function temporaryAsset(
  overrides: Partial<TemporaryAssetReference> = {},
): TemporaryAssetReference {
  return {
    assetId: "asset_upload_1",
    version: 1,
    source: "local_upload",
    batchProjectId: project.id,
    category: "scene",
    checksumSha256: "a".repeat(64),
    ...overrides,
  };
}

function context(
  overrides: Partial<AssetPoolMutationContext> = {},
): AssetPoolMutationContext {
  return {
    tenantId: project.tenantId,
    actorAccountId: "account_owner",
    occurredAt: "2026-08-19T06:00:00.000Z",
    createId: (kind) =>
      kind === "project_asset_pool" ? "asset_pool_created" : "asset_snapshot_created",
    ...overrides,
  };
}

function pool(overrides: Partial<ProjectAssetPool> = {}): ProjectAssetPool {
  return {
    id: "asset_pool_created",
    tenantId: project.tenantId,
    batchProjectId: project.id,
    vehicleId: project.vehicleId,
    revision: 2,
    assets: [vehicleAsset(), reusableAsset(), temporaryAsset()],
    createdAt: "2026-08-18T08:00:00.000Z",
    createdBy: "account_owner",
    updatedAt: "2026-08-18T09:00:00.000Z",
    updatedBy: "account_owner",
    ...overrides,
  };
}

function record(): VideoTaskProductionRecord {
  return {
    schemaVersion: 6,
    videoTask: {
      id: "task_asset_lock",
      tenantId: project.tenantId,
      batchProjectId: project.id,
      name: "资产锁定测试任务",
      ownerAccountId: "account_owner",
      status: "active",
      currentStage: "strategy",
      stageStatus: "in_progress",
      revision: 5,
      vehicleSnapshotId: "vehicle_snapshot_1",
      audience: "家庭用户",
      theme: "城市通勤",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-18T08:00:00.000Z",
      createdBy: "account_owner",
      updatedAt: "2026-08-18T09:00:00.000Z",
      updatedBy: "account_owner",
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskVehicleSnapshots: [],
    taskAssetSnapshots: [],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
    stageMutationReceipts: [],
  };
}

function assetPoolError(code: AssetPoolErrorCode): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof AssetPoolError);
    assert.equal(error.code, code);
    return true;
  };
}

test("createProjectAssetPool creates a scoped revision-one pool and defensively copies assets", () => {
  const assets: AssetReference[] = [vehicleAsset(), reusableAsset(), temporaryAsset()];
  const result = createProjectAssetPool(project, assets, context());

  assert.deepEqual(result, {
    id: "asset_pool_created",
    tenantId: project.tenantId,
    batchProjectId: project.id,
    vehicleId: project.vehicleId,
    revision: 1,
    assets,
    createdAt: "2026-08-19T06:00:00.000Z",
    createdBy: "account_owner",
    updatedAt: "2026-08-19T06:00:00.000Z",
    updatedBy: "account_owner",
  });
  assert.notStrictEqual(result.assets, assets);
  assets[0] = vehicleAsset(9);
  assert.equal(result.assets[0]?.version, 1);
});

test("createProjectAssetPool accepts the 500-asset limit when a matching vehicle asset remains", () => {
  const assets: AssetReference[] = [vehicleAsset()];
  for (let index = 1; index < 500; index += 1) {
    assets.push(reusableAsset(1, { assetId: `asset_scene_${index}`, category: "scene" }));
  }

  assert.equal(createProjectAssetPool(project, assets, context()).assets.length, 500);
});

test("createProjectAssetPool rejects invalid tenant, empty and oversized pools", () => {
  assert.throws(
    () => createProjectAssetPool(project, [vehicleAsset()], context({ tenantId: "tenant_other" })),
    assetPoolError("AIC-ASSET-POOL_SCOPE_INVALID"),
  );
  assert.throws(
    () => createProjectAssetPool(project, [], context()),
    assetPoolError("AIC-ASSET-POOL_VEHICLE_REQUIRED"),
  );
  const oversized: AssetReference[] = [vehicleAsset()];
  for (let index = 1; index <= 500; index += 1) {
    oversized.push(reusableAsset(1, { assetId: `asset_scene_${index}`, category: "scene" }));
  }
  assert.throws(
    () => createProjectAssetPool(project, oversized, context()),
    assetPoolError("AIC-ASSET-POOL_VEHICLE_REQUIRED"),
  );
});

test("createProjectAssetPool rejects duplicate identities regardless of their versions", () => {
  assert.throws(
    () => createProjectAssetPool(project, [vehicleAsset(1), vehicleAsset(2)], context()),
    assetPoolError("AIC-ASSET-POOL_DUPLICATE_REFERENCE"),
  );
  assert.throws(
    () =>
      createProjectAssetPool(
        project,
        [vehicleAsset(), temporaryAsset(), temporaryAsset({ version: 2 })],
        context(),
      ),
    assetPoolError("AIC-ASSET-POOL_DUPLICATE_REFERENCE"),
  );
});

test("createProjectAssetPool rejects foreign temporary assets, cross-vehicle assets, and pools without a company vehicle", () => {
  assert.throws(
    () =>
      createProjectAssetPool(
        project,
        [vehicleAsset(), temporaryAsset({ batchProjectId: "project_other" })],
        context(),
      ),
    assetPoolError("AIC-ASSET-POOL_SCOPE_INVALID"),
  );
  assert.throws(
    () => createProjectAssetPool(project, [vehicleAsset(1, { vehicleId: "vehicle_other" })], context()),
    assetPoolError("AIC-ASSET-POOL_VEHICLE_MISMATCH"),
  );
  assert.throws(
    () => createProjectAssetPool(project, [reusableAsset(), temporaryAsset()], context()),
    assetPoolError("AIC-ASSET-POOL_VEHICLE_REQUIRED"),
  );
});

test("refreshProjectAssetPool promotes matching catalog identities and preserves local uploads", () => {
  const current = pool();
  const result = refreshProjectAssetPool(
    current,
    project,
    [vehicleAsset(3), reusableAsset(2)],
    context({ occurredAt: "2026-08-19T07:00:00.000Z", actorAccountId: "account_refresher" }),
  );

  assert.equal(result.revision, 3);
  assert.deepEqual(result.assets, [vehicleAsset(3), reusableAsset(2), temporaryAsset()]);
  assert.equal(result.createdAt, current.createdAt);
  assert.equal(result.createdBy, current.createdBy);
  assert.equal(result.updatedAt, "2026-08-19T07:00:00.000Z");
  assert.equal(result.updatedBy, "account_refresher");
  assert.equal(current.revision, 2);
  assert.equal(current.assets[0]?.version, 1);
  assert.notStrictEqual(result.assets, current.assets);
});

test("refreshProjectAssetPool ignores missing, older, category-changed, and replacement identities", () => {
  const current = pool();
  const result = refreshProjectAssetPool(
    current,
    project,
    [
      vehicleAsset(1),
      reusableAsset(9, { category: "scene" }),
      reusableAsset(9, { assetId: "asset_person_replacement" }),
    ],
    context(),
  );

  assert.deepEqual(result, current);
  assert.notStrictEqual(result, current);
  assert.notStrictEqual(result.assets, current.assets);
});

test("refreshProjectAssetPool rejects scope mismatches and cross-vehicle catalog revisions", () => {
  assert.throws(
    () => refreshProjectAssetPool(pool({ tenantId: "tenant_other" }), project, [], context()),
    assetPoolError("AIC-ASSET-POOL_SCOPE_INVALID"),
  );
  assert.throws(
    () => refreshProjectAssetPool(pool({ batchProjectId: "project_other" }), project, [], context()),
    assetPoolError("AIC-ASSET-POOL_SCOPE_INVALID"),
  );
  assert.throws(
    () => refreshProjectAssetPool(pool({ vehicleId: "vehicle_other" }), project, [], context()),
    assetPoolError("AIC-ASSET-POOL_SCOPE_INVALID"),
  );
  assert.throws(
    () =>
      refreshProjectAssetPool(
        pool(),
        project,
        [vehicleAsset(2, { vehicleId: "vehicle_other" })],
        context(),
      ),
    assetPoolError("AIC-ASSET-POOL_VEHICLE_MISMATCH"),
  );
});

test("lockVideoTaskAssetSnapshot atomically appends an immutable snapshot and advances the task pointer", () => {
  const source = record();
  const sourcePool = pool();
  const result = lockVideoTaskAssetSnapshot(source, project, sourcePool, 5, context());

  assert.equal(result.schemaVersion, 6);
  assert.equal(result.videoTask.assetSnapshotId, "asset_snapshot_created");
  assert.equal(result.videoTask.revision, 6);
  assert.equal(result.videoTask.updatedAt, "2026-08-19T06:00:00.000Z");
  assert.equal(result.videoTask.updatedBy, "account_owner");
  assert.deepEqual(result.taskAssetSnapshots, [
    {
      id: "asset_snapshot_created",
      tenantId: project.tenantId,
      batchProjectId: project.id,
      videoTaskId: "task_asset_lock",
      version: 1,
      sourceProjectAssetPoolRevision: 2,
      vehicleSnapshotId: "vehicle_snapshot_1",
      assets: sourcePool.assets,
      createdAt: "2026-08-19T06:00:00.000Z",
      createdBy: "account_owner",
    },
  ]);
  assert.equal(source.videoTask.assetSnapshotId, undefined);
  assert.equal(source.videoTask.revision, 5);
  assert.deepEqual(source.taskAssetSnapshots, []);
  sourcePool.assets[0] = vehicleAsset(9);
  assert.equal(result.taskAssetSnapshots[0]?.assets[0]?.version, 1);
});

test("lockVideoTaskAssetSnapshot increments snapshot versions from immutable history", () => {
  const source = record();
  source.taskAssetSnapshots.push({
    id: "asset_snapshot_historical",
    tenantId: project.tenantId,
    batchProjectId: project.id,
    videoTaskId: source.videoTask.id,
    version: 4,
    sourceProjectAssetPoolRevision: 1,
    vehicleSnapshotId: "vehicle_snapshot_1",
    assets: [vehicleAsset()],
    createdAt: "2026-08-18T10:00:00.000Z",
    createdBy: "account_owner",
  });

  const result = lockVideoTaskAssetSnapshot(source, project, pool(), 5, context());
  assert.equal(result.taskAssetSnapshots[1]?.version, 5);
  assert.deepEqual(result.taskAssetSnapshots[0], source.taskAssetSnapshots[0]);
  assert.notStrictEqual(result.taskAssetSnapshots[0], source.taskAssetSnapshots[0]);
});

test("lockVideoTaskAssetSnapshot rejects a stale task revision before mutation", () => {
  const source = record();
  assert.throws(
    () => lockVideoTaskAssetSnapshot(source, project, pool(), 4, context()),
    RevisionConflictError,
  );
  assert.equal(source.videoTask.assetSnapshotId, undefined);
  assert.deepEqual(source.taskAssetSnapshots, []);
});

test("lockVideoTaskAssetSnapshot rejects task, project, pool, tenant, and owner scope mismatches", () => {
  const cases: Array<{
    name: string;
    source: VideoTaskProductionRecord;
    targetProject: BatchProject;
    targetPool: ProjectAssetPool;
    targetContext: AssetPoolMutationContext;
  }> = [];
  const wrongTaskTenant = record();
  wrongTaskTenant.videoTask.tenantId = "tenant_other";
  cases.push({ name: "task tenant", source: wrongTaskTenant, targetProject: project, targetPool: pool(), targetContext: context() });
  const wrongTaskProject = record();
  wrongTaskProject.videoTask.batchProjectId = "project_other";
  cases.push({ name: "task project", source: wrongTaskProject, targetProject: project, targetPool: pool(), targetContext: context() });
  cases.push({ name: "pool tenant", source: record(), targetProject: project, targetPool: pool({ tenantId: "tenant_other" }), targetContext: context() });
  cases.push({ name: "pool project", source: record(), targetProject: project, targetPool: pool({ batchProjectId: "project_other" }), targetContext: context() });
  cases.push({ name: "pool vehicle", source: record(), targetProject: project, targetPool: pool({ vehicleId: "vehicle_other" }), targetContext: context() });
  cases.push({ name: "session tenant", source: record(), targetProject: project, targetPool: pool(), targetContext: context({ tenantId: "tenant_other" }) });
  cases.push({ name: "non-owner", source: record(), targetProject: project, targetPool: pool(), targetContext: context({ actorAccountId: "account_other" }) });

  for (const item of cases) {
    assert.throws(
      () => lockVideoTaskAssetSnapshot(item.source, item.targetProject, item.targetPool, 5, item.targetContext),
      assetPoolError("AIC-ASSET-POOL_SCOPE_INVALID"),
      item.name,
    );
  }
});

test("lockVideoTaskAssetSnapshot rejects already locked, invalid workflow, and missing vehicle snapshots", () => {
  const alreadyLocked = record();
  alreadyLocked.videoTask.assetSnapshotId = "asset_snapshot_existing";
  assert.throws(
    () => lockVideoTaskAssetSnapshot(alreadyLocked, project, pool(), 5, context()),
    assetPoolError("AIC-ASSET-SNAPSHOT_ALREADY_LOCKED"),
  );

  const invalidWorkflowRecords = [record(), record(), record()];
  invalidWorkflowRecords[0]!.videoTask.status = "completed";
  invalidWorkflowRecords[1]!.videoTask.currentStage = "asset_matching";
  invalidWorkflowRecords[2]!.videoTask.stageStatus = "awaiting_confirmation";
  for (const invalid of invalidWorkflowRecords) {
    assert.throws(
      () => lockVideoTaskAssetSnapshot(invalid, project, pool(), 5, context()),
      assetPoolError("AIC-ASSET-SNAPSHOT_STAGE_INVALID"),
    );
  }

  const missingVehicleSnapshot = record();
  delete missingVehicleSnapshot.videoTask.vehicleSnapshotId;
  assert.throws(
    () => lockVideoTaskAssetSnapshot(missingVehicleSnapshot, project, pool(), 5, context()),
    assetPoolError("AIC-ASSET-SNAPSHOT_VEHICLE_REQUIRED"),
  );
});

test("lockVideoTaskAssetSnapshot revalidates pool contents before locking", () => {
  assert.throws(
    () => lockVideoTaskAssetSnapshot(record(), project, pool({ assets: [reusableAsset()] }), 5, context()),
    assetPoolError("AIC-ASSET-POOL_VEHICLE_REQUIRED"),
  );
  assert.throws(
    () =>
      lockVideoTaskAssetSnapshot(
        record(),
        project,
        pool({ assets: [vehicleAsset(1, { vehicleId: "vehicle_other" })] }),
        5,
        context(),
      ),
    assetPoolError("AIC-ASSET-POOL_VEHICLE_MISMATCH"),
  );
});
