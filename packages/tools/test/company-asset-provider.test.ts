import assert from "node:assert/strict";
import test from "node:test";

import type {
  CompanyAssetCatalogItem,
  CompanyAssetCatalogPage,
  CompanyAssetCatalogQuery,
  CompanyAssetProvider,
  CompanyAssetProviderRequestOptions,
  CompanyAssetProviderScope,
  CompanyAssetReference,
  CompanyAssetResolveResult,
} from "../src/index.ts";

const vehicleItem: CompanyAssetCatalogItem = {
  reference: {
    assetId: "asset_vehicle_front",
    version: 3,
    source: "company_catalog",
    sourceProvider: "contract_test_provider",
    category: "vehicle",
    vehicleId: "vehicle_e5",
  },
  displayName: "E5 前侧静态图",
  description: "用于车型外观展示",
  brandIds: ["brand_firefly"],
  tags: ["front", "studio"],
  preview: {
    mediaType: "image/webp",
    width: 1920,
    height: 1080,
    thumbnailUrl: "/v1/company-assets/asset_vehicle_front/thumbnail",
  },
  updatedAt: "2026-08-19T07:00:00.000Z",
};

class ContractFixtureProvider implements CompanyAssetProvider {
  readonly providerId = "contract_test_provider";
  lastQuery: Readonly<CompanyAssetCatalogQuery> | undefined;
  lastScope: Readonly<CompanyAssetProviderScope> | undefined;

  async searchAssets(
    query: Readonly<CompanyAssetCatalogQuery>,
    scope: Readonly<CompanyAssetProviderScope>,
    _options?: Readonly<CompanyAssetProviderRequestOptions>,
  ): Promise<CompanyAssetCatalogPage> {
    this.lastQuery = query;
    this.lastScope = scope;
    return { items: [vehicleItem] };
  }

  async resolveAssets(
    references: readonly CompanyAssetReference[],
    _scope: Readonly<CompanyAssetProviderScope>,
    _options?: Readonly<CompanyAssetProviderRequestOptions>,
  ): Promise<CompanyAssetResolveResult> {
    const matched = references.filter(
      (reference) =>
        reference.assetId === vehicleItem.reference.assetId &&
        reference.version === vehicleItem.reference.version,
    );
    return {
      items: matched.length === 0 ? [] : [vehicleItem],
      missingReferences: references.filter((reference) => !matched.includes(reference)),
    };
  }
}

const scope: CompanyAssetProviderScope = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_creator",
  allowedBrandIds: ["brand_firefly"],
  allowedVehicleIds: ["vehicle_e5"],
};

test("company asset queries keep authenticated scope separate from filter input", async () => {
  const provider = new ContractFixtureProvider();
  const query: CompanyAssetCatalogQuery = {
    categories: ["vehicle"],
    brandId: "brand_firefly",
    vehicleId: "vehicle_e5",
    searchText: "前侧",
    tags: ["studio"],
    limit: 20,
  };
  const page = await provider.searchAssets(query, scope);
  assert.deepEqual(provider.lastQuery, query);
  assert.deepEqual(provider.lastScope, scope);
  assert.equal("tenantId" in query, false);
  assert.equal("actorAccountId" in query, false);
  assert.deepEqual(page.items, [vehicleItem]);
});

test("provider results expose shared asset references instead of adapter-private records", async () => {
  const provider = new ContractFixtureProvider();
  const missing: CompanyAssetReference = {
    assetId: "asset_person_missing",
    version: 1,
    source: "company_catalog",
    sourceProvider: provider.providerId,
    category: "person",
  };
  const result = await provider.resolveAssets([vehicleItem.reference, missing], scope);
  assert.deepEqual(result.items, [vehicleItem]);
  assert.deepEqual(result.missingReferences, [missing]);
  assert.equal(result.items[0]?.reference.source, "company_catalog");
  assert.equal(result.items[0]?.reference.sourceProvider, provider.providerId);
});
