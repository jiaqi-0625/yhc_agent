import assert from "node:assert/strict";
import test from "node:test";

import type { VideoTaskProductionRecord } from "@firefly/domain";
import type { TaskContext } from "@firefly/schemas";

import {
  createScopedTaskAssetSnapshotReader,
  createTaskAssetTools,
  TaskAssetSnapshotAccessError,
  type CompanyAssetCatalogItem,
  type CompanyAssetProvider,
  type CompanyAssetProviderScope,
  type CompanyAssetReference,
} from "../src/index.ts";

const occurredAt = "2026-08-19T08:00:00.000Z";
const companyReference = {
  assetId: "asset_vehicle_locked",
  version: 2,
  source: "company_catalog",
  sourceProvider: "catalog_test",
  category: "vehicle",
  vehicleId: "vehicle_1",
} as const satisfies CompanyAssetReference;
const localReference = {
  assetId: "temporary_scene_locked",
  version: 1,
  source: "local_upload",
  category: "scene",
  batchProjectId: "project_1",
  checksumSha256: "a".repeat(64),
} as const;

const taskContext = {
  schemaVersion: 1,
  kind: "task_context",
  brand: { id: "brand_1", name: "品牌一" },
  vehicle: { id: "vehicle_1", displayName: "车型一", version: 1 },
  batchProject: { id: "project_1", name: "项目一", aspectRatio: "9:16" },
  videoTask: {
    id: "task_1",
    name: "任务一",
    status: "active",
    currentStage: "strategy",
    stageStatus: "in_progress",
    revision: 2,
    vehicleSnapshotId: "vehicle_snapshot_1",
    assetSnapshotId: "asset_snapshot_1",
    ownership: { state: "owned_by_current_account" },
  },
  productionBrief: {
    audience: "家庭用户",
    theme: "周末出行",
    durationSeconds: 30,
    platformTags: [],
  },
} as const satisfies TaskContext;

function productionRecord(): VideoTaskProductionRecord {
  return {
    schemaVersion: 4,
    videoTask: {
      id: "task_1",
      tenantId: "tenant_1",
      batchProjectId: "project_1",
      name: "任务一",
      ownerAccountId: "account_1",
      status: "active",
      currentStage: "strategy",
      stageStatus: "in_progress",
      revision: 2,
      vehicleSnapshotId: "vehicle_snapshot_1",
      assetSnapshotId: "asset_snapshot_1",
      audience: "家庭用户",
      theme: "周末出行",
      durationSeconds: 30,
      platformTags: [],
      createdAt: occurredAt,
      createdBy: "account_1",
      updatedAt: occurredAt,
      updatedBy: "account_1",
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskAssetSnapshots: [{
      id: "asset_snapshot_1",
      tenantId: "tenant_1",
      batchProjectId: "project_1",
      videoTaskId: "task_1",
      version: 1,
      sourceProjectAssetPoolRevision: 3,
      vehicleSnapshotId: "vehicle_snapshot_1",
      assets: [companyReference, localReference],
      createdAt: occurredAt,
      createdBy: "account_1",
    }],
  };
}

const providerScope: CompanyAssetProviderScope = {
  tenantId: "tenant_1",
  actorAccountId: "account_1",
  allowedBrandIds: ["brand_1"],
  allowedVehicleIds: ["vehicle_1"],
};

function catalogItem(reference: CompanyAssetReference = companyReference): CompanyAssetCatalogItem {
  return {
    reference,
    displayName: "锁定车型素材",
    brandIds: ["brand_1"],
    tags: ["exterior"],
    preview: { mediaType: "image/jpeg", width: 1920, height: 1080 },
    updatedAt: occurredAt,
  };
}

function provider(resolve: (references: readonly CompanyAssetReference[]) => readonly CompanyAssetCatalogItem[]): CompanyAssetProvider {
  return {
    providerId: "catalog_test",
    async searchAssets() {
      throw new Error("task snapshot reads must not search the latest project catalog");
    },
    async resolveAssets(references, scope) {
      assert.deepEqual(scope, providerScope);
      return { items: resolve(references), missingReferences: [] };
    },
  };
}

test("task asset tool reads only the server-bound immutable snapshot", async () => {
  const loadedIds: string[] = [];
  const reader = createScopedTaskAssetSnapshotReader({
    taskContext,
    store: {
      async load(videoTaskId) {
        loadedIds.push(videoTaskId);
        return productionRecord();
      },
    },
    provider: provider((references) => references.map((reference) => catalogItem(reference))),
    providerScope,
  });
  const [tool] = createTaskAssetTools(reader);
  assert.ok(tool);
  assert.deepEqual(
    Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
    [],
  );
  const result = await tool.execute("call_1", {});
  assert.deepEqual(loadedIds, ["task_1"]);
  assert.equal(result.details.videoTaskId, "task_1");
  assert.equal(result.details.snapshot.id, "asset_snapshot_1");
  assert.deepEqual(result.details.companyAssets.map((item: CompanyAssetCatalogItem) => item.reference), [companyReference]);
  assert.deepEqual(result.details.localAssets, [localReference]);
  assert.equal("tenantId" in result.details.snapshot, false);
  assert.equal("createdBy" in result.details.snapshot, false);
});

test("task asset reader rejects cross-scope and stale snapshot data", async () => {
  assert.throws(
    () => createScopedTaskAssetSnapshotReader({
      taskContext,
      store: { async load() { return productionRecord(); } },
      provider: provider(() => []),
      providerScope: { ...providerScope, allowedVehicleIds: ["vehicle_other"] },
    }),
    TaskAssetSnapshotAccessError,
  );

  const stale = productionRecord();
  stale.videoTask.assetSnapshotId = "asset_snapshot_other";
  const reader = createScopedTaskAssetSnapshotReader({
    taskContext,
    store: { async load() { return stale; } },
    provider: provider(() => []),
    providerScope,
  });
  await assert.rejects(() => reader.read(), TaskAssetSnapshotAccessError);
});

test("task asset reader rejects cross-task, cross-project, and cross-tenant records", async () => {
  for (const scopedContext of [
    { ...taskContext, videoTask: { ...taskContext.videoTask, id: "task_other" } },
    { ...taskContext, batchProject: { ...taskContext.batchProject, id: "project_other" } },
  ] satisfies TaskContext[]) {
    const reader = createScopedTaskAssetSnapshotReader({
      taskContext: scopedContext,
      store: { async load() { return productionRecord(); } },
      provider: provider(() => []),
      providerScope,
    });
    await assert.rejects(() => reader.read(), TaskAssetSnapshotAccessError);
  }

  const tenantReader = createScopedTaskAssetSnapshotReader({
    taskContext,
    store: { async load() { return productionRecord(); } },
    provider: provider(() => []),
    providerScope: { ...providerScope, tenantId: "tenant_other" },
  });
  await assert.rejects(() => tenantReader.read(), TaskAssetSnapshotAccessError);
});

test("task asset reader rejects unresolved or substituted company references", async () => {
  const reader = createScopedTaskAssetSnapshotReader({
    taskContext,
    store: { async load() { return productionRecord(); } },
    provider: provider(() => [catalogItem({
      assetId: companyReference.assetId,
      version: 3,
      source: "company_catalog",
      sourceProvider: companyReference.sourceProvider,
      category: "vehicle",
      vehicleId: companyReference.vehicleId,
    })]),
    providerScope,
  });
  await assert.rejects(() => reader.read(), TaskAssetSnapshotAccessError);
});
