import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialVideoTaskRequest,
  createProjectRequest,
  normalizeProjectAssetPackage,
  normalizeProjectConfiguration,
  normalizeProjectCreationOptions,
  projectBatchName,
  projectCreativeTypes,
  projectDurationOptions,
} from "../public/project-creation-wizard.js";
import type { ProjectAssetReference, ProjectCreationAsset } from "../public/project-creation-wizard.js";

const vehicleReference: ProjectAssetReference = {
  assetId: "asset_vehicle",
  version: 2,
  source: "company_catalog",
  sourceProvider: "company_assets",
  category: "vehicle",
  vehicleId: "vehicle_e5",
};

const visualStyleReference: ProjectAssetReference = {
  assetId: "style",
  version: 2,
  source: "company_catalog",
  sourceProvider: "company_assets",
  category: "visual_style",
};

function asset(reference: ProjectAssetReference, displayName: string): ProjectCreationAsset {
  return {
    reference,
    displayName,
    description: "资产库描述词",
    preview: { mediaType: "image/webp", width: 1920, height: 1080 },
  };
}

test("project creation page exposes only the approved durations and creative types", () => {
  assert.deepEqual(projectDurationOptions, [10, 15, 30]);
  assert.deepEqual(projectCreativeTypes, [
    { id: "creative_effects", label: "创意特效型" },
    { id: "scenario", label: "情景演绎" },
    { id: "voiceover", label: "常规口播" },
  ]);
});

test("project creation options keep only versioned authorized brand and vehicle records", () => {
  assert.deepEqual(normalizeProjectCreationOptions({
    brands: [{
      id: "brand_firefly",
      name: "萤火汽车",
      revision: 3,
      vehicles: [{
        id: "vehicle_e5",
        brandId: "brand_firefly",
        version: 2,
        series: "E5",
        modelYear: 2026,
        trim: "长续航",
        displayName: "E5 2026 长续航",
      }, { id: "forged", brandId: "other" }],
    }],
    aspectRatios: ["9:16", "9:16", "unsupported"],
  }), {
    brands: [{
      id: "brand_firefly",
      name: "萤火汽车",
      revision: 3,
      vehicles: [{
        id: "vehicle_e5",
        brandId: "brand_firefly",
        version: 2,
        series: "E5",
        modelYear: 2026,
        trim: "长续航",
        displayName: "E5 2026 长续航",
      }],
    }],
    aspectRatios: ["9:16"],
  });
});

test("automatic project configuration requires a locked vehicle asset and 9:16 support", () => {
  const packageView = normalizeProjectAssetPackage({
    brand: { id: "brand_firefly", name: "萤火汽车" },
    vehicle: { id: "vehicle_e5" },
    associationRevision: 4,
    recommendedAssets: [asset(vehicleReference, "E5 英雄图")],
  }, "vehicle_e5");
  assert.equal(packageView?.associationRevision, 4);
  assert.equal(packageView?.assets[0]?.description, "资产库描述词");

  const configuration = normalizeProjectConfiguration({
    brandRevision: 3,
    vehicleVersion: 2,
    associationRevision: 4,
    defaultVisualStyle: asset(visualStyleReference, "清透科技风"),
    aspectRatios: ["9:16", "16:9"],
  });
  assert.equal(configuration?.defaultVisualStyle.reference.category, "visual_style");
  assert.equal(normalizeProjectConfiguration({ ...configuration, aspectRatios: ["16:9"] }), null);
});

test("project request uses automatic assets and a fixed information-feed aspect ratio", () => {
  assert.deepEqual(createProjectRequest({
    requestId: "request_ws403",
    vehicleId: "vehicle_e5",
    expectedBrandRevision: 3,
    expectedVehicleVersion: 2,
    expectedAssetAssociationRevision: 4,
    selectedAssets: [asset(vehicleReference, "E5 英雄图")],
    aspectRatio: "9:16",
    batchName: "情景演绎 0820-103000",
    forgedTenantId: "tenant_attacker",
  }), {
    requestId: "request_ws403",
    vehicleId: "vehicle_e5",
    expectedBrandRevision: 3,
    expectedVehicleVersion: 2,
    expectedAssetAssociationRevision: 4,
    selectedAssets: [vehicleReference],
    aspectRatio: "9:16",
    batchName: "情景演绎 0820-103000",
  });
});

test("duration and creative type become the initial Agent task brief", () => {
  assert.deepEqual(createInitialVideoTaskRequest({
    requestId: "request_task_ws403",
    creativeTypeId: "creative_effects",
    durationSeconds: 10,
  }), {
    requestId: "request_task_ws403",
    name: "创意特效型 · 10秒",
    audience: "由 Agent 基于品牌、车型与资产描述确定",
    theme: "创意特效型",
    durationSeconds: 10,
    platformTags: [],
  });
  assert.equal(createInitialVideoTaskRequest({
    requestId: "request_invalid",
    creativeTypeId: "unknown",
    durationSeconds: 20,
  }), null);
  assert.equal(projectBatchName("scenario", new Date(2026, 7, 20, 10, 30, 40)), "情景演绎 0820-103040");
});
