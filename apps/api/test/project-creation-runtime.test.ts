import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceAccessDeniedError, type WorkspaceSessionScope } from "@firefly/domain";
import type {
  Brand,
  CreateBatchProjectRequest,
  Vehicle,
  VehicleAssetAssociation,
  WorkspaceAccessGrant,
} from "@firefly/schemas";
import { MockCompanyAssetProvider } from "@firefly/tools";

import { LocalBatchProjectStore } from "../src/batch-project-store.ts";
import { BusinessRuntimeError } from "../src/business-runtime.ts";
import { ProjectCreationRuntime } from "../src/project-creation-runtime.ts";
import {
  DEFAULT_ADMIN_BRANDS,
  DEFAULT_ADMIN_VEHICLES,
  DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
} from "../src/workspace-admin-runtime.ts";
import { LocalWorkspaceAdminStore } from "../src/workspace-admin-store.ts";
import {
  DEVELOPMENT_ACCESS_GRANTS,
  DEVELOPMENT_ACCOUNTS,
} from "../src/workspace-session-runtime.ts";

function fixture() {
  const administration = new LocalWorkspaceAdminStore(".data/test-project-creation-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES,
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const projects = new LocalBatchProjectStore(".data/test-project-creation-projects", false);
  let sequence = 0;
  const runtime = new ProjectCreationRuntime(
    administration,
    projects,
    new MockCompanyAssetProvider(),
    () => "2026-08-19T10:00:00.000Z",
    (kind) => `${kind}_${++sequence}`,
  );
  return { administration, projects, runtime };
}

async function session(
  administration: LocalWorkspaceAdminStore,
  accountId = "account_creator_a",
): Promise<WorkspaceSessionScope> {
  const account = DEVELOPMENT_ACCOUNTS.find((candidate) => candidate.accountId === accountId);
  assert.ok(account);
  return {
    actorAccountId: account.accountId,
    tenantId: account.tenantId,
    role: account.role,
    accessGrants: await administration.listForAccount(account.tenantId, account.accountId),
  };
}

const vehicleId = "vehicle_firefly_e5_2026_long_range";
const vehicleReference = {
  assetId: "asset_firefly_demo_e5_hero",
  version: 1,
  source: "company_catalog" as const,
  sourceProvider: "mock_company_assets",
  category: "vehicle" as const,
  vehicleId,
};

function request(overrides: Partial<CreateBatchProjectRequest> = {}): CreateBatchProjectRequest {
  return {
    requestId: "request_project_e5_summer",
    vehicleId,
    expectedBrandRevision: 1,
    expectedVehicleVersion: 1,
    expectedAssetAssociationRevision: 1,
    selectedAssets: [vehicleReference],
    aspectRatio: "9:16",
    batchName: "夏季上新",
    customStylePrompt: "清透夏日公路氛围",
    ...overrides,
  };
}

test("project creation options and all three steps are scoped to active creator grants", async () => {
  const { administration, runtime } = fixture();
  const creator = await session(administration);
  const options = await runtime.getOptions(creator);
  assert.equal(options.brands.length, 1);
  assert.equal(options.brands[0]?.vehicles[0]?.id, vehicleId);
  assert.deepEqual(options.aspectRatios, ["9:16", "16:9", "1:1", "4:5"]);

  const packageView = await runtime.getAssetPackage(vehicleId, creator);
  assert.equal(packageView.associationRevision, 1);
  assert.deepEqual(
    packageView.recommendedAssets.map((item) => item.reference.category),
    ["vehicle"],
  );
  const configuration = await runtime.getConfiguration(vehicleId, creator);
  assert.equal(configuration.defaultVisualStyle.reference.assetId, "asset_style_firefly_demo_clean");
  const replacements = await runtime.searchReplacementAssets(
    vehicleId,
    { categories: ["person"], limit: 20 },
    creator,
  );
  assert.ok(replacements.items.every((item) => item.reference.category === "person"));

  await assert.rejects(
    runtime.getOptions(await session(administration, "account_admin")),
    (error: unknown) => error instanceof BusinessRuntimeError && error.statusCode === 403,
  );
  assert.equal(
    (await runtime.getAssetPackage(vehicleId, { ...creator, accessGrants: [] })).vehicle.id,
    vehicleId,
  );
  await assert.rejects(
    runtime.searchReplacementAssets(vehicleId, { categories: ["vehicle"], limit: 20 }, creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-PROJECT-CREATION-REPLACEMENT_CATEGORY_DENIED",
  );
});

test("asset package ignores historical associated styles and resolves the current brand default separately", async () => {
  const { administration, runtime } = fixture();
  await administration.transact("tenant_firefly", (state) => ({
    ...state,
    vehicleAssetAssociations: state.vehicleAssetAssociations.map((association) =>
      association.vehicleId === vehicleId
        ? {
            ...association,
            assets: [
              ...association.assets.filter((asset) => asset.category !== "visual_style"),
              {
                assetId: "asset_style_retired",
                version: 1,
                source: "company_catalog" as const,
                sourceProvider: "mock_company_assets",
                category: "visual_style" as const,
              },
            ],
          }
        : association),
  }));
  const packageView = await runtime.getAssetPackage(vehicleId, await session(administration));
  assert.deepEqual(
    packageView.recommendedAssets.map((item) => item.reference.category),
    ["vehicle"],
  );
  const configuration = await runtime.getConfiguration(vehicleId, await session(administration));
  assert.equal(configuration.defaultVisualStyle.reference.assetId, "asset_style_firefly_demo_clean");
});

test("project creation atomically persists the project and pool with server-derived fields", async () => {
  const { administration, projects, runtime } = fixture();
  const creator = await session(administration);
  const created = await runtime.create(request(), creator);
  assert.equal(created.replayed, false);
  assert.equal(created.project.name, "萤火汽车 萤火 E5 长续航版 9:16 夏季上新");
  assert.equal(created.project.visualStylePresetId, "asset_style_firefly_demo_clean");
  assert.equal(created.project.createdBy, "account_creator_a");
  assert.equal(created.assetPool.id, created.project.assetPoolId);
  assert.deepEqual(
    created.assetPool.assets.map((asset) => asset.category),
    ["vehicle", "visual_style"],
  );
  assert.deepEqual(created.vehicleFactSource, { vehicleId, vehicleVersion: 1 });
  const persisted = await projects.load("tenant_firefly", created.project.id);
  assert.deepEqual(persisted?.project, created.project);
  assert.deepEqual(persisted?.assetPool, created.assetPool);

  const replay = await runtime.create(request(), creator);
  assert.equal(replay.replayed, true);
  assert.equal(replay.project.id, created.project.id);
  await assert.rejects(
    runtime.create(request({ batchName: "不同批次" }), creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-PROJECT-CREATION-IDEMPOTENCY_CONFLICT",
  );
});

test("recommended vehicle assets are locked while person and scene replacements are accepted", async () => {
  const { administration, runtime } = fixture();
  const creator = await session(administration);
  const replacements = await runtime.searchReplacementAssets(
    vehicleId,
    { categories: ["person"], limit: 20 },
    creator,
  );
  const person = replacements.items[0]?.reference;
  assert.ok(person);
  const created = await runtime.create(
    request({ requestId: "request_with_person", selectedAssets: [vehicleReference, person] }),
    creator,
  );
  assert.ok(created.assetPool.assets.some((asset) => asset.category === "person"));

  await assert.rejects(
    runtime.create(request({ requestId: "request_without_vehicle", selectedAssets: [person] }), creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-PROJECT-CREATION-VEHICLE_ASSETS_LOCKED",
  );
  await assert.rejects(
    runtime.create(request({
      requestId: "request_style_forgery",
      selectedAssets: [{
        assetId: "asset_style_firefly_demo_clean",
        version: 1,
        source: "company_catalog",
        sourceProvider: "mock_company_assets",
        category: "visual_style",
      }],
    }), creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-PROJECT-CREATION-VISUAL_STYLE_LOCKED",
  );
});

test("stale wizard revisions and revoked replay access are rejected", async () => {
  const { administration, runtime } = fixture();
  const creator = await session(administration);
  await assert.rejects(
    runtime.create(request({ expectedVehicleVersion: 99 }), creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError && error.code === "AIC-PROJECT-CREATION-CATALOG_STALE",
  );
  const created = await runtime.create(request({ requestId: "request_before_revoke" }), creator);
  assert.ok(created.project.id);
  await administration.transact("tenant_firefly", (state) => ({
    ...state,
    accessGrants: state.accessGrants.map((grant) =>
      grant.accountId === creator.actorAccountId &&
        grant.access.kind === "vehicle_project" &&
        grant.access.vehicleId === vehicleId
        ? {
            ...grant,
            status: "revoked" as const,
            revision: grant.revision + 1,
            updatedAt: "2026-08-19T10:01:00.000Z",
            updatedBy: "account_admin",
          }
        : grant),
  }));
  await assert.rejects(
    runtime.create(request({ requestId: "request_before_revoke" }), creator),
    WorkspaceAccessDeniedError,
  );
});

test("concurrent project creation with one request ID persists exactly one aggregate", async () => {
  const { administration, projects, runtime } = fixture();
  const creator = await session(administration);
  const [first, second] = await Promise.all([
    runtime.create(request({ requestId: "request_concurrent" }), creator),
    runtime.create(request({ requestId: "request_concurrent" }), creator),
  ]);
  assert.equal(first.project.id, second.project.id);
  assert.equal([first.replayed, second.replayed].filter(Boolean).length, 1);
  assert.equal((await projects.list("tenant_firefly")).length, 1);
});

test("historical selected references normalize to latest catalog versions", async () => {
  const audit = {
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_admin",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_admin",
  };
  const brand: Brand = {
    id: "brand_firefly",
    tenantId: "tenant_firefly",
    name: "萤火汽车",
    status: "active",
    revision: 1,
    defaultVisualStylePresetId: "asset_style_firefly_clean",
    ...audit,
  };
  const vehicle: Vehicle = {
    id: "vehicle_e5",
    tenantId: brand.tenantId,
    brandId: brand.id,
    version: 1,
    status: "active",
    series: "E5",
    modelYear: 2026,
    trim: "长续航",
    parameters: {},
    fixedClaims: [],
    optionalClaims: [],
    prohibitedClaims: [],
    ...audit,
  };
  const association: VehicleAssetAssociation = {
    id: "association_e5",
    tenantId: brand.tenantId,
    brandId: brand.id,
    vehicleId: vehicle.id,
    revision: 1,
    assets: [{
      assetId: "asset_e5_hero",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId: vehicle.id,
    }],
    ...audit,
  };
  const grant: WorkspaceAccessGrant = {
    id: "grant_creator_e5",
    tenantId: brand.tenantId,
    accountId: "account_creator_a",
    access: { kind: "vehicle_project", brandId: brand.id, vehicleId: vehicle.id },
    status: "active",
    revision: 1,
    ...audit,
  };
  const administration = new LocalWorkspaceAdminStore(".data/test-project-latest-admin", {
    brands: [brand],
    vehicleVersions: [vehicle],
    vehicleAssetAssociations: [association],
    accessGrants: [grant],
  }, false);
  const runtime = new ProjectCreationRuntime(
    administration,
    new LocalBatchProjectStore(".data/test-project-latest-store", false),
    new MockCompanyAssetProvider(),
    () => "2026-08-19T10:00:00.000Z",
    (kind) => `${kind}_latest`,
  );
  const creator = await session(administration);
  const created = await runtime.create({
    requestId: "request_latest",
    vehicleId: vehicle.id,
    expectedBrandRevision: 1,
    expectedVehicleVersion: 1,
    expectedAssetAssociationRevision: 1,
    selectedAssets: association.assets,
    aspectRatio: "9:16",
    batchName: "历史版本规范化",
  }, creator);
  const vehicleAsset = created.assetPool.assets.find((asset) => asset.category === "vehicle");
  const styleAsset = created.assetPool.assets.find((asset) => asset.category === "visual_style");
  assert.equal(vehicleAsset?.version, 2);
  assert.equal(styleAsset?.version, 4);
});
