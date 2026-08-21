import assert from "node:assert/strict";
import test from "node:test";

import { MockCompanyAssetProvider } from "@firefly/tools";

import { matchAssetsToConfirmedScript } from "../src/asset-script-matcher.ts";

const scope = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_creator_a",
  allowedBrandIds: ["brand_leapmotor_demo"],
  allowedVehicleIds: ["vehicle_leapmotor_c10_demo"],
};

test("confirmed script selects a bounded C10 vehicle subset for its actual shot needs", async () => {
  const provider = new MockCompanyAssetProvider();
  const catalog = await provider.searchAssets({
    categories: ["vehicle"],
    vehicleId: "vehicle_leapmotor_c10_demo",
    limit: 100,
  }, scope);
  assert.equal(catalog.items.length, 55);

  const matches = matchAssetsToConfirmedScript(catalog.items, `
    一家三口带着露营装备打开后备箱，后排座椅放倒后装入大件行李。
    家人落座后排，镜头特写腿部空间和环保面料座椅。
    仪表盘显示续航里程，车辆在郊外公路行驶并驶向远方。
  `);
  const vehicleIds = matches
    .filter((match) => match.reference.category === "vehicle")
    .map((match) => match.reference.assetId);

  assert.deepEqual(vehicleIds, [
    "asset_leapmotor_c10_0034",
    "asset_leapmotor_c10_0030",
    "asset_leapmotor_c10_0033",
    "asset_leapmotor_c10_0040",
    "asset_leapmotor_c10_0007",
  ]);
  assert.ok(vehicleIds.length < catalog.items.length);
  assert.ok(matches.every((match) => match.reason.includes("脚本")));
});

test("vehicle matching keeps at least one establishing shot when the script is sparse", async () => {
  const provider = new MockCompanyAssetProvider();
  const catalog = await provider.searchAssets({
    categories: ["vehicle"],
    vehicleId: "vehicle_leapmotor_c10_demo",
    limit: 100,
  }, scope);
  const matches = matchAssetsToConfirmedScript(catalog.items, "品牌氛围短片", {
    maximumVehicleAssets: 3,
  });
  assert.equal(matches.filter((match) => match.reference.category === "vehicle").length, 1);
});

test("person and scene matches prefer the C10 family departure material over unrelated global assets", async () => {
  const provider = new MockCompanyAssetProvider();
  const catalog = await provider.searchAssets({
    categories: ["person", "scene"],
    brandId: "brand_leapmotor_demo",
    vehicleId: "vehicle_leapmotor_c10_demo",
    limit: 100,
  }, scope);
  const matches = matchAssetsToConfirmedScript(
    catalog.items,
    "清晨，一家三口整理露营装备和行李，准备开始家庭出行。",
  );
  assert.deepEqual(
    matches.map((match) => [match.reference.category, match.reference.assetId]),
    [
      ["person", "asset_leapmotor_c10_family_group"],
      ["scene", "asset_leapmotor_c10_family_departure_scene"],
    ],
  );
});

test("person narration scripts prefer a matching validated local presenter candidate", () => {
  const matches = matchAssetsToConfirmedScript([
    {
      reference: {
        source: "local_upload",
        batchProjectId: "batch_project_presenter",
        assetId: "temporary_presenter",
        version: 1,
        category: "person",
        checksumSha256: "a".repeat(64),
      },
      displayName: "模拟主播.png",
      description: "专业汽车人物口播主播，正面出镜讲解",
      tags: ["主播", "口播"],
    },
  ], "人物口播：主播正面出镜讲解车型卖点。", { maximumVehicleAssets: 1 });

  assert.deepEqual(matches.map((match) => [match.reference.category, match.reference.assetId]), [
    ["person", "temporary_presenter"],
  ]);
});

test("scripts without an explicit presenter or scene do not force reusable assets", () => {
  const matches = matchAssetsToConfirmedScript([
    {
      reference: {
        source: "company_catalog",
        sourceProvider: "mock_company_assets",
        assetId: "presenter",
        version: 1,
        category: "person",
      },
      displayName: "汽车主播",
      description: "人物口播",
      tags: ["主播"],
    },
  ], "整车定格，展示车型名称。", { maximumVehicleAssets: 1 });
  assert.equal(matches.length, 0);
});
