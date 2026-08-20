import assert from "node:assert/strict";
import test from "node:test";

import {
  TemporaryAssetError,
  WorkspaceAccessDeniedError,
  type VideoTaskProductionRecord,
} from "@firefly/domain";
import type { BatchProject, ProjectAssetPool, WorkspaceAccessGrant } from "@firefly/schemas";
import { MockCompanyAssetProvider } from "@firefly/tools";

import { LocalProjectAssetCoordinator } from "../src/project-asset-coordinator.ts";
import { LocalProjectAssetPoolStore } from "../src/project-asset-pool-store.ts";
import type { ProjectAssetPoolStore } from "../src/project-asset-pool-store.ts";
import { ProjectAssetRuntime, ProjectAssetRuntimeError } from "../src/project-asset-runtime.ts";
import { TemporaryAssetRuntime } from "../src/temporary-asset-runtime.ts";
import { LocalTemporaryAssetStore } from "../src/temporary-asset-store.ts";
import { LocalVideoTaskProductionStore } from "../src/video-task-store.ts";

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
  assetPoolId: "pool_project_launch",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T00:00:00.000Z",
  createdBy: "account_owner",
  updatedAt: "2026-08-19T00:00:00.000Z",
  updatedBy: "account_owner",
};

const projectGrant: WorkspaceAccessGrant = {
  id: "grant_owner_e5",
  tenantId: project.tenantId,
  accountId: "account_owner",
  access: { kind: "vehicle_project", brandId: project.brandId, vehicleId: project.vehicleId },
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T00:00:00.000Z",
  createdBy: "account_admin",
  updatedAt: "2026-08-19T00:00:00.000Z",
  updatedBy: "account_admin",
};

const session = {
  tenantId: project.tenantId,
  actorAccountId: "account_owner",
  role: "creator" as const,
  accessGrants: [projectGrant],
};

function pool(): ProjectAssetPool {
  return {
    id: project.assetPoolId,
    tenantId: project.tenantId,
    batchProjectId: project.id,
    vehicleId: project.vehicleId,
    revision: 1,
    assets: [
      {
        assetId: "asset_e5_hero",
        version: 2,
        category: "vehicle",
        source: "company_catalog",
        sourceProvider: "mock_company_assets",
        vehicleId: project.vehicleId,
      },
    ],
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: session.actorAccountId,
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: session.actorAccountId,
  };
}

function task(videoTaskId: string): VideoTaskProductionRecord {
  return {
    schemaVersion: 6,
    videoTask: {
      id: videoTaskId,
      tenantId: project.tenantId,
      batchProjectId: project.id,
      name: videoTaskId,
      ownerAccountId: session.actorAccountId,
      status: "active",
      currentStage: "asset_matching",
      stageStatus: "in_progress",
      revision: 1,
      vehicleSnapshotId: "vehicle_snapshot_e5_v1",
      audience: "城市家庭",
      theme: "通勤",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-19T00:00:00.000Z",
      createdBy: session.actorAccountId,
      updatedAt: "2026-08-19T00:00:00.000Z",
      updatedBy: session.actorAccountId,
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

function fixture() {
  const temporaryStore = new LocalTemporaryAssetStore(".data/test-temporary-runtime", false);
  const poolStore = new LocalProjectAssetPoolStore(".data/test-temporary-runtime-pools", false);
  const taskStore = new LocalVideoTaskProductionStore(".data/test-temporary-runtime-tasks", false);
  const coordinator = new LocalProjectAssetCoordinator();
  let currentTime = "2026-08-19T12:00:00.000Z";
  let temporarySequence = 0;
  let snapshotSequence = 0;
  const temporaryRuntime = new TemporaryAssetRuntime(
    temporaryStore,
    poolStore,
    () => currentTime,
    () => `temporary_${++temporarySequence}`,
    coordinator,
  );
  const projectRuntime = new ProjectAssetRuntime(
    new MockCompanyAssetProvider(),
    poolStore,
    taskStore,
    () => currentTime,
    () => `snapshot_${++snapshotSequence}`,
    temporaryStore,
    coordinator,
  );
  return {
    temporaryStore,
    poolStore,
    taskStore,
    temporaryRuntime,
    projectRuntime,
    setTime(value: string) {
      currentTime = value;
    },
  };
}

const inspection = {
  fileName: "camping.webp",
  mediaType: "image/webp",
  byteSize: 2_000_000,
  width: 1920,
  height: 1080,
  checksumSha256: "a".repeat(64),
};

const declaration = {
  category: "scene" as const,
  sourceDescription: "项目成员现场拍摄",
  rightsDeclaration: "上传者确认拥有本项目广告制作所需授权",
  rightsConfirmed: true,
};

test("a valid inspected upload enters the project pool and a task locks its exact reference", async () => {
  const state = fixture();
  await state.poolStore.transact(project.id, () => pool());
  const declarationWithForgedFileFacts = {
    ...declaration,
    mediaType: "image/gif",
    width: 1,
    checksumSha256: "f".repeat(64),
  };
  const registered = await state.temporaryRuntime.registerTemporaryAsset(
    project,
    inspection,
    declarationWithForgedFileFacts,
    session,
  );
  assert.equal(registered.validationStatus, "pending");
  assert.equal(registered.tenantId, session.tenantId);
  assert.equal(registered.batchProjectId, project.id);
  assert.equal(registered.createdBy, session.actorAccountId);
  assert.equal(registered.mediaType, inspection.mediaType);
  assert.equal(registered.width, inspection.width);
  assert.equal(registered.checksumSha256, inspection.checksumSha256);

  const validated = await state.temporaryRuntime.validateTemporaryAsset(
    project,
    registered.id,
    1,
    session,
  );
  assert.equal(validated.validationStatus, "valid");
  const updatedPool = await state.temporaryRuntime.addToProjectPool(
    project,
    registered.id,
    2,
    1,
    session,
  );
  assert.equal(updatedPool.revision, 2);
  assert.deepEqual(updatedPool.assets[1], {
    assetId: registered.id,
    version: 1,
    category: "scene",
    source: "local_upload",
    batchProjectId: project.id,
    checksumSha256: inspection.checksumSha256,
  });

  await state.taskStore.save(task("task_local_asset"));
  const locked = await state.projectRuntime.lockTaskSnapshot(
    "task_local_asset",
    1,
    project,
    session,
  );
  assert.equal(locked.taskAssetSnapshots[0]?.assets[1]?.source, "local_upload");
  assert.equal(locked.taskAssetSnapshots[0]?.assets[1]?.assetId, registered.id);
});

test("unconfirmed rights stay in review until a new explicit declaration is validated", async () => {
  const state = fixture();
  await state.poolStore.transact(project.id, () => pool());
  const registered = await state.temporaryRuntime.registerTemporaryAsset(
    project,
    inspection,
    { ...declaration, rightsConfirmed: false },
    session,
  );
  const reviewed = await state.temporaryRuntime.validateTemporaryAsset(
    project,
    registered.id,
    1,
    session,
  );
  assert.equal(reviewed.validationStatus, "needs_review");
  assert.equal(reviewed.validationIssues[0]?.code, "AIC-ASSET-RIGHTS_UNCONFIRMED");
  await assert.rejects(
    state.temporaryRuntime.addToProjectPool(project, registered.id, 2, 1, session),
    TemporaryAssetError,
  );
  assert.equal((await state.poolStore.load(project.id))?.revision, 1);

  const resubmitted = await state.temporaryRuntime.updateDeclaration(
    project,
    registered.id,
    declaration,
    2,
    session,
  );
  assert.equal(resubmitted.validationStatus, "pending");
  assert.equal(resubmitted.rightsConfirmed, true);
  const valid = await state.temporaryRuntime.validateTemporaryAsset(
    project,
    registered.id,
    3,
    session,
  );
  assert.equal(valid.validationStatus, "valid");
});

test("brand administrators may view but cannot mutate project temporary assets", async () => {
  const state = fixture();
  const administrator = {
    tenantId: project.tenantId,
    actorAccountId: "account_admin",
    role: "content_admin" as const,
    accessGrants: [
      {
        ...projectGrant,
        id: "grant_admin_brand",
        accountId: "account_admin",
        access: { kind: "brand" as const, brandId: project.brandId },
      },
    ],
  };
  assert.deepEqual(await state.temporaryRuntime.listTemporaryAssets(project, administrator), []);
  await assert.rejects(
    state.temporaryRuntime.registerTemporaryAsset(
      project,
      inspection,
      declaration,
      administrator,
    ),
    WorkspaceAccessDeniedError,
  );
  assert.deepEqual(await state.temporaryStore.loadProject(project.id), []);
});

test("a pool save failure keeps the validated temporary asset available for retry", async () => {
  const state = fixture();
  const registered = await state.temporaryRuntime.registerTemporaryAsset(
    project,
    inspection,
    declaration,
    session,
  );
  await state.temporaryRuntime.validateTemporaryAsset(project, registered.id, 1, session);
  const originalPool = pool();
  const failingPoolStore: ProjectAssetPoolStore = {
    async load() {
      return structuredClone(originalPool);
    },
    async transact(_batchProjectId, update) {
      await update(structuredClone(originalPool));
      throw new Error("simulated pool save failure");
    },
  };
  const failingRuntime = new TemporaryAssetRuntime(
    state.temporaryStore,
    failingPoolStore,
    () => "2026-08-19T12:00:00.000Z",
    () => "unused_id",
    new LocalProjectAssetCoordinator(),
  );

  await assert.rejects(
    failingRuntime.addToProjectPool(project, registered.id, 2, 1, session),
    /simulated pool save failure/u,
  );
  const persisted = (await state.temporaryStore.loadProject(project.id))[0];
  assert.equal(persisted?.validationStatus, "valid");
  assert.equal(persisted?.revision, 2);
  assert.equal(originalPool.revision, 1);
  assert.equal(originalPool.assets.length, 1);
});

test("expired local metadata blocks task snapshot locking without partial task writes", async () => {
  const state = fixture();
  await state.poolStore.transact(project.id, () => pool());
  const registered = await state.temporaryRuntime.registerTemporaryAsset(
    project,
    inspection,
    { ...declaration, expiresAt: "2026-08-19T12:30:00.000Z" },
    session,
  );
  await state.temporaryRuntime.validateTemporaryAsset(project, registered.id, 1, session);
  await state.temporaryRuntime.addToProjectPool(project, registered.id, 2, 1, session);
  await state.taskStore.save(task("task_expired_asset"));
  state.setTime("2026-08-19T13:00:00.000Z");

  await assert.rejects(
    state.projectRuntime.lockTaskSnapshot("task_expired_asset", 1, project, session),
    (error: unknown) =>
      error instanceof ProjectAssetRuntimeError &&
      error.code === "AIC-ASSET-TEMPORARY-REFERENCE-UNUSABLE",
  );
  const unchanged = await state.taskStore.load("task_expired_asset");
  assert.equal(unchanged?.videoTask.revision, 1);
  assert.equal(unchanged?.videoTask.assetSnapshotId, undefined);
  assert.deepEqual(unchanged?.taskAssetSnapshots, []);
});
