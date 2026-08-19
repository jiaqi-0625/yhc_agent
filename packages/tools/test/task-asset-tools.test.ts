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
const globalSceneReference = {
  assetId: "asset_scene_global",
  version: 1,
  source: "company_catalog",
  sourceProvider: "catalog_test",
  category: "scene",
} as const satisfies CompanyAssetReference;

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
  assert.deepEqual(result.details.sourceRiskSummary, {
    requiresAttention: true,
    warningCount: 1,
  });
  assert.deepEqual(result.details.assetRecommendations, {
    schemaVersion: 1,
    usesLockedSnapshotOnly: true,
    vehicleAssetsReplaceable: false,
    lockedVehicleAssets: [{
      reference: companyReference,
      displayName: "锁定车型素材",
      replacementAllowed: false,
      summary: "车型素材已由当前任务快照锁定，只能用于推荐组合，不能被其他车型素材替换。",
    }],
    recommendations: [{
      category: "scene",
      reference: localReference,
      displayName: "项目临时素材 temporary_scene_locked",
      tags: [],
      sourceStatus: "requires_manual_review",
      recommendationReason: "可作为任务候选，但画面适配性、原始来源说明和使用权声明必须由人工复核。",
    }],
  });
  assert.deepEqual(result.details.sourceAssessments, [
    {
      assetId: "asset_vehicle_locked",
      version: 2,
      category: "vehicle",
      source: "company_catalog",
      status: "verified",
      riskLevel: "none",
      summary: "公司素材已在当前任务授权范围内按锁定版本精确解析。",
    },
    {
      assetId: "temporary_scene_locked",
      version: 1,
      category: "scene",
      source: "local_upload",
      status: "requires_manual_review",
      riskLevel: "warning",
      summary: "任务快照仅保留项目范围引用和校验和；制作前需人工复核原始来源说明与使用权声明。",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result.details.sourceAssessments), /rightsConfirmed|rightsDeclaration|sourceDescription/u);
  assert.equal("tenantId" in result.details.snapshot, false);
  assert.equal("createdBy" in result.details.snapshot, false);
});

test("task asset recommendations use only locked person and scene versions", async () => {
  const companyPersonReference = {
    assetId: "asset_person_locked",
    version: 4,
    source: "company_catalog",
    sourceProvider: "catalog_test",
    category: "person",
  } as const satisfies CompanyAssetReference;
  const companySceneReference = {
    assetId: "asset_scene_locked",
    version: 7,
    source: "company_catalog",
    sourceProvider: "catalog_test",
    category: "scene",
  } as const satisfies CompanyAssetReference;
  const visualStyleReference = {
    assetId: "asset_style_locked",
    version: 3,
    source: "company_catalog",
    sourceProvider: "catalog_test",
    category: "visual_style",
  } as const satisfies CompanyAssetReference;
  const record = productionRecord();
  record.taskAssetSnapshots[0]!.assets = [
    companyReference,
    companyPersonReference,
    companySceneReference,
    visualStyleReference,
    localReference,
  ];
  const reader = createScopedTaskAssetSnapshotReader({
    taskContext,
    store: { async load() { return record; } },
    provider: provider((references) => references.map((reference) => ({
      ...catalogItem(reference),
      displayName: `素材 ${reference.assetId}`,
      tags: reference.category === "person" ? ["family", "warm"] : ["city"],
    }))),
    providerScope,
  });

  const result = await reader.read();
  assert.deepEqual(
    result.assetRecommendations.recommendations.map(({ category, reference, sourceStatus }) => ({
      category,
      reference,
      sourceStatus,
    })),
    [
      { category: "person", reference: companyPersonReference, sourceStatus: "verified" },
      { category: "scene", reference: companySceneReference, sourceStatus: "verified" },
      { category: "scene", reference: localReference, sourceStatus: "requires_manual_review" },
    ],
  );
  assert.equal(
    result.assetRecommendations.recommendations.some(({ reference }) => reference.assetId === visualStyleReference.assetId),
    false,
  );
  assert.deepEqual(result.assetRecommendations.lockedVehicleAssets.map(({ reference }) => reference), [companyReference]);
  assert.match(result.assetRecommendations.recommendations[0]?.recommendationReason ?? "", /family、warm/u);
  assert.equal("tenantId" in result.assetRecommendations, false);
});

test("task asset source assessments report no warning when every locked asset is an exact company reference", async () => {
  const record = productionRecord();
  record.taskAssetSnapshots[0]!.assets = [companyReference, globalSceneReference];
  const reader = createScopedTaskAssetSnapshotReader({
    taskContext,
    store: { async load() { return record; } },
    provider: provider((references) => references.map((reference) => ({
      ...catalogItem(reference),
      ...(reference.assetId === globalSceneReference.assetId ? { brandIds: [] } : {}),
    }))),
    providerScope,
  });

  const result = await reader.read();
  assert.deepEqual(result.sourceRiskSummary, { requiresAttention: false, warningCount: 0 });
  assert.deepEqual(result.sourceAssessments.map(({ assetId, status, riskLevel }) => ({ assetId, status, riskLevel })), [
    {
      assetId: companyReference.assetId,
      status: "verified",
      riskLevel: "none",
    },
    {
      assetId: globalSceneReference.assetId,
      status: "verified",
      riskLevel: "none",
    },
  ]);
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

test("task asset reader rejects cross-vehicle, cross-brand, missing-vehicle, and cross-project sources", async () => {
  const invalidRecords: VideoTaskProductionRecord[] = [];
  const crossVehicle = productionRecord();
  crossVehicle.taskAssetSnapshots[0]!.assets = [{
    ...companyReference,
    vehicleId: "vehicle_other",
  }, localReference];
  invalidRecords.push(crossVehicle);
  const missingVehicle = productionRecord();
  missingVehicle.taskAssetSnapshots[0]!.assets = [localReference];
  invalidRecords.push(missingVehicle);
  const crossProjectLocal = productionRecord();
  crossProjectLocal.taskAssetSnapshots[0]!.assets = [companyReference, {
    ...localReference,
    batchProjectId: "project_other",
  }];
  invalidRecords.push(crossProjectLocal);

  for (const record of invalidRecords) {
    const reader = createScopedTaskAssetSnapshotReader({
      taskContext,
      store: { async load() { return record; } },
      provider: provider((references) => references.map((reference) => catalogItem(reference))),
      providerScope,
    });
    await assert.rejects(() => reader.read(), TaskAssetSnapshotAccessError);
  }

  const crossBrandReader = createScopedTaskAssetSnapshotReader({
    taskContext,
    store: { async load() { return productionRecord(); } },
    provider: provider((references) => references.map((reference) => ({
      ...catalogItem(reference),
      brandIds: ["brand_other"],
    }))),
    providerScope,
  });
  await assert.rejects(() => crossBrandReader.read(), TaskAssetSnapshotAccessError);
});
