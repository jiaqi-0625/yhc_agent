import assert from "node:assert/strict";
import test from "node:test";

import type { Brand, Vehicle } from "@firefly/schemas";

import {
  BatchProjectCreationError,
  createBatchProject,
} from "../src/batch-project.ts";

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
  revision: 3,
  defaultVisualStylePresetId: "asset_style_clean",
  ...audit,
};

const vehicle: Vehicle = {
  id: "vehicle_e5",
  tenantId: brand.tenantId,
  brandId: brand.id,
  version: 2,
  status: "active",
  series: "萤火 E5",
  modelYear: 2026,
  trim: "长续航版",
  parameters: {},
  fixedClaims: [],
  optionalClaims: [],
  prohibitedClaims: [],
  ...audit,
};

const context = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_creator",
  occurredAt: "2026-08-19T08:00:00.000Z",
  projectId: "project_e5_summer",
  assetPoolId: "asset_pool_e5_summer",
};

test("batch project creation derives identity, style, name, and audit fields on the server", () => {
  const project = createBatchProject(
    brand,
    vehicle,
    {
      batchName: "  夏季  上新  ",
      aspectRatio: "9:16",
      customStylePrompt: "  清透   夏日光线  ",
    },
    context,
  );
  assert.equal(project.name, "萤火汽车 萤火 E5 长续航版 9:16 夏季 上新");
  assert.equal(project.batchName, "夏季 上新");
  assert.equal(project.customStylePrompt, "清透 夏日光线");
  assert.equal(project.visualStylePresetId, brand.defaultVisualStylePresetId);
  assert.equal(project.createdBy, context.actorAccountId);
  assert.equal(project.revision, 1);
});

test("batch project creation rejects cross-scope and archived catalog records", () => {
  for (const [candidateBrand, candidateVehicle, code] of [
    [{ ...brand, tenantId: "tenant_other" }, vehicle, "AIC-PROJECT-CREATION-SCOPE_INVALID"],
    [brand, { ...vehicle, brandId: "brand_other" }, "AIC-PROJECT-CREATION-SCOPE_INVALID"],
    [{ ...brand, status: "archived" }, vehicle, "AIC-PROJECT-CREATION-RESOURCE_ARCHIVED"],
    [brand, { ...vehicle, status: "archived" }, "AIC-PROJECT-CREATION-RESOURCE_ARCHIVED"],
  ] as const) {
    assert.throws(
      () => createBatchProject(
        candidateBrand,
        candidateVehicle,
        { batchName: "上新", aspectRatio: "9:16" },
        context,
      ),
      (error: unknown) => error instanceof BatchProjectCreationError && error.code === code,
    );
  }
});

test("batch project creation rejects blank text and generated names over the project limit", () => {
  assert.throws(
    () => createBatchProject(
      brand,
      vehicle,
      { batchName: "   ", aspectRatio: "9:16" },
      context,
    ),
    (error: unknown) =>
      error instanceof BatchProjectCreationError && error.code === "AIC-PROJECT-CREATION-NAME_INVALID",
  );
  assert.throws(
    () => createBatchProject(
      { ...brand, name: "品".repeat(120) },
      { ...vehicle, series: "车".repeat(120), trim: "型".repeat(120) },
      { batchName: "批".repeat(120), aspectRatio: "9:16" },
      context,
    ),
    /exceeds 240/u,
  );
});
