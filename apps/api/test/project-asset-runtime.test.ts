import assert from "node:assert/strict";
import test from "node:test";

import type { BatchProject, WorkspaceAccessGrant } from "@firefly/schemas";
import type {
  CompanyAssetCatalogItem,
  CompanyAssetCatalogPage,
  CompanyAssetCatalogQuery,
  CompanyAssetProvider,
  CompanyAssetProviderScope,
  CompanyAssetReference,
  CompanyAssetResolveResult,
} from "@firefly/tools";

import { LocalProjectAssetPoolStore } from "../src/project-asset-pool-store.ts";
import { ProjectAssetRuntime, ProjectAssetRuntimeError } from "../src/project-asset-runtime.ts";

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

const grant: WorkspaceAccessGrant = {
  id: "grant_owner_e5",
  tenantId: project.tenantId,
  accountId: "account_owner",
  access: {
    kind: "vehicle_project",
    brandId: project.brandId,
    vehicleId: project.vehicleId,
  },
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
  accessGrants: [grant],
};

function vehicleReference(version: number): CompanyAssetReference {
  return {
    assetId: "asset_e5_hero",
    version,
    category: "vehicle",
    source: "company_catalog",
    sourceProvider: "mutable_catalog",
    vehicleId: project.vehicleId,
  };
}

function sceneReference(version: number): CompanyAssetReference {
  return {
    assetId: "asset_scene_city",
    version,
    category: "scene",
    source: "company_catalog",
    sourceProvider: "mutable_catalog",
  };
}

function visualStyleReference(version: number): CompanyAssetReference {
  return {
    assetId: project.visualStylePresetId,
    version,
    category: "visual_style",
    source: "company_catalog",
    sourceProvider: "mutable_catalog",
  };
}

function catalogItem(reference: CompanyAssetReference): CompanyAssetCatalogItem {
  return {
    reference: structuredClone(reference),
    displayName: reference.assetId,
    brandIds: [project.brandId],
    tags: [],
    preview: { mediaType: "image/webp", width: 1920, height: 1080 },
    updatedAt: `2026-08-${String(10 + reference.version).padStart(2, "0")}T00:00:00.000Z`,
  };
}

class MutableCompanyAssetProvider implements CompanyAssetProvider {
  readonly providerId = "mutable_catalog";
  version = 1;
  sceneVisible = true;
  readonly scopes: CompanyAssetProviderScope[] = [];

  async searchAssets(
    _query: Readonly<CompanyAssetCatalogQuery>,
    scope: Readonly<CompanyAssetProviderScope>,
  ): Promise<CompanyAssetCatalogPage> {
    this.scopes.push(structuredClone(scope));
    return {
      items: [
        catalogItem(vehicleReference(this.version)),
        catalogItem(visualStyleReference(this.version)),
        ...(this.sceneVisible ? [catalogItem(sceneReference(this.version))] : []),
      ],
    };
  }

  async resolveAssets(
    references: readonly CompanyAssetReference[],
    _scope: Readonly<CompanyAssetProviderScope>,
  ): Promise<CompanyAssetResolveResult> {
    const known = [
      ...Array.from({ length: this.version }, (_, index) => vehicleReference(index + 1)),
      ...Array.from({ length: this.version }, (_, index) => visualStyleReference(index + 1)),
      ...Array.from({ length: this.version }, (_, index) => sceneReference(index + 1)),
    ];
    const key = (reference: Readonly<CompanyAssetReference>) =>
      JSON.stringify(reference, Object.keys(reference).sort());
    const knownKeys = new Set(known.map(key));
    return {
      items: references.filter((reference) => knownKeys.has(key(reference))).map(catalogItem),
      missingReferences: references
        .filter((reference) => !knownKeys.has(key(reference)))
        .map((reference) => structuredClone(reference)),
    };
  }
}

function runtimeFixture() {
  const provider = new MutableCompanyAssetProvider();
  const poolStore = new LocalProjectAssetPoolStore(".data/test-project-assets", false);
  const runtime = new ProjectAssetRuntime(
    provider,
    poolStore,
    () => "2026-08-19T08:00:00.000Z",
  );
  return { provider, poolStore, runtime };
}

test("coordinated task selections use exact current pool versions and keep prior reads immutable", async () => {
  const { provider, poolStore, runtime } = runtimeFixture();
  const created = await runtime.createPool(
    project,
    [vehicleReference(1), visualStyleReference(1), sceneReference(1)],
    session,
  );
  assert.equal(created.id, project.assetPoolId);
  assert.equal(created.assets[0]?.version, 1);
  const firstSelection = await runtime.withTaskAssetSelection(
    project,
    1,
    [sceneReference(1)],
    session,
    (resolveSelection) => resolveSelection(),
  );
  assert.deepEqual(firstSelection.assets.map((asset) => asset.version), [1, 1, 1]);

  provider.version = 2;
  const refreshed = await runtime.getCurrentPool(project, session);
  assert.equal(refreshed.revision, 2);
  assert.deepEqual(refreshed.assets.map((asset) => asset.version), [2, 2, 2]);
  const secondSelection = await runtime.withTaskAssetSelection(
    project,
    2,
    [sceneReference(2)],
    session,
    (resolveSelection) => resolveSelection(),
  );
  assert.deepEqual(secondSelection.assets.map((asset) => asset.version), [2, 2, 2]);
  assert.deepEqual(firstSelection.assets.map((asset) => asset.version), [1, 1, 1]);
  assert.deepEqual(await poolStore.load(project.id), refreshed);
  assert.ok(provider.scopes.length >= 3);
  assert.ok(
    provider.scopes.every(
      (scope) =>
        scope.tenantId === session.tenantId &&
        scope.actorAccountId === session.actorAccountId &&
        scope.allowedBrandIds[0] === project.brandId &&
        scope.allowedVehicleIds[0] === project.vehicleId,
    ),
  );
});

test("pool creation normalizes selected historical references and rejects unavailable scope", async () => {
  const { provider, runtime } = runtimeFixture();
  provider.version = 2;
  const created = await runtime.createPool(
    project,
    [vehicleReference(1), sceneReference(1)],
    session,
  );
  assert.deepEqual(created.assets.map((asset) => asset.version), [2, 2]);

  const unavailableRuntime = runtimeFixture().runtime;
  const otherVehicleReference: CompanyAssetReference = {
    assetId: "asset_other_vehicle",
    version: 1,
    category: "vehicle",
    source: "company_catalog",
    sourceProvider: "mutable_catalog",
    vehicleId: "vehicle_e6",
  };
  await assert.rejects(
    unavailableRuntime.createPool(
      project,
      [otherVehicleReference],
      session,
    ),
    (error: unknown) =>
      error instanceof ProjectAssetRuntimeError &&
      error.code === "AIC-ASSET-POOL-CATALOG-REFERENCE-UNAVAILABLE",
  );

  const forged = runtimeFixture();
  await assert.rejects(
    forged.runtime.createPool(
      project,
      [vehicleReference(999)],
      session,
    ),
    (error: unknown) =>
      error instanceof ProjectAssetRuntimeError &&
      error.code === "AIC-ASSET-POOL-CATALOG-REFERENCE-UNAVAILABLE",
  );
  assert.equal(await forged.poolStore.load(project.id), undefined);
});

test("task selection rejects stale pool revisions and stale exact references", async () => {
  const { provider, runtime } = runtimeFixture();
  await runtime.createPool(
    project,
    [vehicleReference(1), visualStyleReference(1), sceneReference(1)],
    session,
  );
  provider.version = 2;

  await assert.rejects(
    runtime.withTaskAssetSelection(
      project,
      1,
      [sceneReference(1)],
      session,
      (resolveSelection) => resolveSelection(),
    ),
    (error: unknown) =>
      error instanceof ProjectAssetRuntimeError &&
      error.code === "AIC-ASSET-SELECTION-REVISION-CONFLICT",
  );
  await assert.rejects(
    runtime.withTaskAssetSelection(
      project,
      2,
      [sceneReference(1)],
      session,
      (resolveSelection) => resolveSelection(),
    ),
    (error: unknown) =>
      error instanceof ProjectAssetRuntimeError &&
      error.code === "AIC-ASSET-SELECTION-INVALID",
  );
});

test("task selection rejects a catalog asset removed from the latest searchable scope", async () => {
  const { provider, runtime } = runtimeFixture();
  await runtime.createPool(
    project,
    [vehicleReference(1), visualStyleReference(1), sceneReference(1)],
    session,
  );
  provider.sceneVisible = false;

  await assert.rejects(
    runtime.withTaskAssetSelection(
      project,
      1,
      [sceneReference(1)],
      session,
      (resolveSelection) => resolveSelection(),
    ),
    (error: unknown) =>
      error instanceof ProjectAssetRuntimeError &&
      error.code === "AIC-ASSET-SELECTION-INVALID",
  );
});
