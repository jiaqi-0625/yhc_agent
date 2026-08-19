import assert from "node:assert/strict";
import test from "node:test";

import {
  CreateBatchProjectRequestSchema,
  CreateBrandRequestSchema,
  CreateVehicleFactVersionRequestSchema,
  CreateWorkspaceAccessGrantRequestSchema,
  ReplaceVehicleAssetAssociationsRequestSchema,
  UpdateAccountBudgetRequestSchema,
} from "../src/index.ts";
import { Value } from "typebox/value";

test("workspace administration request contracts reject client-supplied identity and audit scope", () => {
  assert.equal(Value.Check(CreateBrandRequestSchema, {
    name: "萤火汽车",
    defaultVisualStylePresetId: "style_clean",
  }), true);
  for (const injected of ["id", "tenantId", "createdBy", "updatedBy", "revision"]) {
    assert.equal(Value.Check(CreateBrandRequestSchema, {
      name: "萤火汽车",
      defaultVisualStylePresetId: "style_clean",
      [injected]: "attacker",
    }), false);
  }
  assert.equal(Value.Check(CreateWorkspaceAccessGrantRequestSchema, {
    accountId: "account_creator",
    access: { kind: "vehicle_project", brandId: "brand_firefly", vehicleId: "vehicle_e5" },
    status: "active",
  }), false);
});

test("vehicle fact versions and asset association replacements require optimistic versions", () => {
  const facts = {
    expectedVersion: 1,
    status: "active",
    series: "E5",
    modelYear: 2026,
    trim: "长续航",
    parameters: {},
    fixedClaims: [],
    optionalClaims: [],
    prohibitedClaims: [],
  };
  assert.equal(Value.Check(CreateVehicleFactVersionRequestSchema, facts), true);
  assert.equal(Value.Check(CreateVehicleFactVersionRequestSchema, {
    ...facts,
    expectedVersion: 0,
  }), false);

  const association = {
    expectedRevision: 0,
    assets: [{
      assetId: "asset_e5",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId: "vehicle_e5",
    }],
  };
  assert.equal(Value.Check(ReplaceVehicleAssetAssociationsRequestSchema, association), true);
  assert.equal(Value.Check(ReplaceVehicleAssetAssociationsRequestSchema, {
    ...association,
    tenantId: "tenant_attacker",
  }), false);
  assert.equal(Value.Check(UpdateAccountBudgetRequestSchema, {
    expectedRevision: 1,
    limitAmountMinor: 0,
  }), true);
});

test("project creation accepts only wizard inputs and a supported aspect ratio", () => {
  const request = {
    requestId: "request_project_1",
    vehicleId: "vehicle_e5",
    expectedBrandRevision: 1,
    expectedVehicleVersion: 2,
    expectedAssetAssociationRevision: 3,
    selectedAssets: [{
      assetId: "asset_e5",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId: "vehicle_e5",
    }],
    aspectRatio: "9:16",
    batchName: "夏季上新",
  };
  assert.equal(Value.Check(CreateBatchProjectRequestSchema, request), true);
  for (const injected of ["tenantId", "actorAccountId", "brandId", "name", "assetPoolId", "visualStylePresetId"]) {
    assert.equal(Value.Check(CreateBatchProjectRequestSchema, { ...request, [injected]: "forged" }), false);
  }
  assert.equal(Value.Check(CreateBatchProjectRequestSchema, { ...request, aspectRatio: "999:1" }), false);
  assert.equal(Value.Check(CreateBatchProjectRequestSchema, { ...request, requestId: "../escape" }), false);
  assert.equal(Value.Check(CreateBatchProjectRequestSchema, {
    ...request,
    selectedAssets: Array.from({ length: 499 }, () => request.selectedAssets[0]),
  }), true);
  assert.equal(Value.Check(CreateBatchProjectRequestSchema, {
    ...request,
    selectedAssets: Array.from({ length: 500 }, () => request.selectedAssets[0]),
  }), false);
});
