import assert from "node:assert/strict";
import test from "node:test";

import {
  CompanyAssetCatalogAccessError,
  CompanyAssetCatalogQueryError,
  CompanyAssetProviderAbortedError,
  MockCompanyAssetProvider,
  type CompanyAssetCatalogItem,
  type CompanyAssetProviderScope,
  type CompanyAssetReference,
} from "../src/index.ts";

const e5Scope: CompanyAssetProviderScope = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_creator",
  allowedBrandIds: ["brand_firefly"],
  allowedVehicleIds: ["vehicle_e5"],
};

test("mock catalog exposes all four public asset categories within server scope", async () => {
  const provider = new MockCompanyAssetProvider();
  const page = await provider.searchAssets({ limit: 100 }, e5Scope);
  assert.equal(page.items.length, 8);
  assert.deepEqual(
    [...new Set(page.items.map((item) => item.reference.category))].sort(),
    ["person", "scene", "vehicle", "visual_style"],
  );
  assert.equal(page.nextCursor, undefined);
  assert.ok(
    page.items.every(
      (item) =>
        item.reference.source === "company_catalog" &&
        item.reference.sourceProvider === provider.providerId,
    ),
  );
  assert.equal(page.items.some((item) => "tenantId" in item), false);
  assert.equal(page.items.some((item) => "internalSortWeight" in item), false);
});

test("category, vehicle, and brand filters cover vehicle, people, scenes, and visual styles", async () => {
  const provider = new MockCompanyAssetProvider();
  const vehicles = await provider.searchAssets(
    { categories: ["vehicle"], vehicleId: "vehicle_e5", limit: 20 },
    e5Scope,
  );
  assert.deepEqual(
    vehicles.items.map((item) => item.reference.assetId),
    ["asset_e5_hero", "asset_e5_interior"],
  );
  assert.ok(
    vehicles.items.every(
      (item) => item.reference.category === "vehicle" && item.reference.vehicleId === "vehicle_e5",
    ),
  );

  const people = await provider.searchAssets({ categories: ["person"], limit: 20 }, e5Scope);
  const scenes = await provider.searchAssets({ categories: ["scene"], limit: 20 }, e5Scope);
  const styles = await provider.searchAssets(
    { categories: ["visual_style"], brandId: "brand_firefly", limit: 20 },
    e5Scope,
  );
  assert.equal(people.items.length, 2);
  assert.equal(scenes.items.length, 2);
  assert.deepEqual(styles.items.map((item) => item.reference.assetId), [
    "asset_style_firefly_clean",
    "asset_style_global_clean",
  ]);
});

test("search and tag filters are normalized and combined", async () => {
  const provider = new MockCompanyAssetProvider();
  const search = await provider.searchAssets(
    { categories: ["scene"], searchText: "  湖边露营  ", tags: ["CAMPING"], limit: 20 },
    e5Scope,
  );
  assert.deepEqual(search.items.map((item) => item.reference.assetId), ["asset_scene_camping"]);
  const noMatch = await provider.searchAssets(
    { categories: ["scene"], tags: ["camping", "night"], limit: 20 },
    e5Scope,
  );
  assert.deepEqual(noMatch.items, []);
});

test("catalog returns only the latest version while exact historical versions remain resolvable", async () => {
  const provider = new MockCompanyAssetProvider();
  const page = await provider.searchAssets(
    { categories: ["vehicle"], searchText: "英雄", limit: 20 },
    e5Scope,
  );
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.reference.version, 2);

  const historical: CompanyAssetReference = {
    assetId: "asset_e5_hero",
    version: 1,
    source: "company_catalog",
    sourceProvider: provider.providerId,
    category: "vehicle",
    vehicleId: "vehicle_e5",
  };
  const resolved = await provider.resolveAssets([historical], e5Scope);
  assert.equal(resolved.items[0]?.reference.version, 1);
  assert.deepEqual(resolved.missingReferences, []);
});

test("cursor pagination is stable and rejects reuse with different filters", async () => {
  const provider = new MockCompanyAssetProvider();
  const first = await provider.searchAssets({ limit: 2 }, e5Scope);
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await provider.searchAssets({ limit: 2, cursor: first.nextCursor }, e5Scope);
  assert.equal(second.items.length, 2);
  assert.deepEqual(
    new Set([...first.items, ...second.items].map((item) => item.reference.assetId)).size,
    4,
  );
  await assert.rejects(
    provider.searchAssets(
      { categories: ["scene"], limit: 2, cursor: first.nextCursor },
      e5Scope,
    ),
    CompanyAssetCatalogQueryError,
  );
});

test("server scope prevents cross-tenant, cross-brand, and cross-vehicle catalog access", async () => {
  const provider = new MockCompanyAssetProvider();
  await assert.rejects(
    provider.searchAssets({ brandId: "brand_other", limit: 20 }, e5Scope),
    CompanyAssetCatalogAccessError,
  );
  await assert.rejects(
    provider.searchAssets({ vehicleId: "vehicle_e6", limit: 20 }, e5Scope),
    CompanyAssetCatalogAccessError,
  );
  const page = await provider.searchAssets({ limit: 100 }, e5Scope);
  assert.equal(page.items.some((item) => item.reference.assetId === "asset_other_tenant_scene"), false);
  assert.equal(page.items.some((item) => item.reference.assetId === "asset_style_other_luxury"), false);
  assert.equal(page.items.some((item) => item.reference.assetId === "asset_e6_hero"), false);
  const noBrandAccess = await provider.searchAssets(
    { limit: 100 },
    { ...e5Scope, allowedBrandIds: [] },
  );
  assert.deepEqual(noBrandAccess.items, []);
});

test("batch resolution reports missing, mismatched-provider, and unauthorized references", async () => {
  const provider = new MockCompanyAssetProvider();
  const valid: CompanyAssetReference = {
    assetId: "asset_scene_camping",
    version: 3,
    source: "company_catalog",
    sourceProvider: provider.providerId,
    category: "scene",
  };
  const wrongProvider = { ...valid, sourceProvider: "other_provider" };
  const unauthorized: CompanyAssetReference = {
    assetId: "asset_e6_hero",
    version: 1,
    source: "company_catalog",
    sourceProvider: provider.providerId,
    category: "vehicle",
    vehicleId: "vehicle_e6",
  };
  const result = await provider.resolveAssets([valid, wrongProvider, unauthorized], e5Scope);
  assert.deepEqual(result.items.map((item) => item.reference), [valid]);
  assert.deepEqual(result.missingReferences, [wrongProvider, unauthorized]);
});

test("mock provider returns defensive public copies", async () => {
  const provider = new MockCompanyAssetProvider();
  const first = await provider.searchAssets({ categories: ["scene"], limit: 20 }, e5Scope);
  const mutable = first.items[0] as CompanyAssetCatalogItem & {
    displayName: string;
    tags: string[];
  };
  mutable.displayName = "被调用方修改";
  mutable.tags.push("mutated");
  const second = await provider.searchAssets({ categories: ["scene"], limit: 20 }, e5Scope);
  assert.notEqual(second.items[0]?.displayName, "被调用方修改");
  assert.equal(second.items[0]?.tags.includes("mutated"), false);
});

test("invalid and cancelled queries fail with stable provider errors", async () => {
  const provider = new MockCompanyAssetProvider();
  await assert.rejects(
    provider.searchAssets({ limit: 0 }, e5Scope),
    CompanyAssetCatalogQueryError,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.searchAssets({ limit: 20 }, e5Scope, { signal: controller.signal }),
    CompanyAssetProviderAbortedError,
  );
});
