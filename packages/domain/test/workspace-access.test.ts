import assert from "node:assert/strict";
import test from "node:test";

import type {
  BatchProject,
  Brand,
  Vehicle,
  VideoTask,
  WorkspaceAccessGrant,
} from "@firefly/schemas";

import {
  WorkspaceAccessDeniedError,
  assertCanCreateBatchProject,
  assertCanManageBrand,
  assertCanOperateVideoTask,
  assertCanTakeOverVideoTask,
  assertCanViewBatchProject,
  assertCanViewBrand,
  assertCanViewVideoTask,
  canViewBatchProject,
  canViewBrand,
  canViewVideoTask,
  type WorkspaceSessionScope,
} from "../src/index.ts";

const audit = {
  createdAt: "2026-08-19T00:00:00.000Z",
  createdBy: "account_admin",
  updatedAt: "2026-08-19T00:00:00.000Z",
  updatedBy: "account_admin",
} as const;

const brand: Brand = {
  id: "brand_firefly",
  tenantId: "tenant_firefly",
  name: "萤火汽车",
  status: "active",
  revision: 1,
  defaultVisualStylePresetId: "style_default",
  ...audit,
};

const vehicle: Vehicle = {
  id: "vehicle_e5",
  tenantId: brand.tenantId,
  brandId: brand.id,
  version: 1,
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

const project: BatchProject = {
  id: "project_e5_launch",
  tenantId: brand.tenantId,
  brandId: brand.id,
  vehicleId: vehicle.id,
  name: "萤火汽车 E5 9:16 上市",
  batchName: "上市",
  aspectRatio: "9:16",
  visualStylePresetId: "style_default",
  assetPoolId: "asset_pool_e5",
  status: "active",
  revision: 1,
  ...audit,
};

const task: VideoTask = {
  id: "task_family",
  tenantId: brand.tenantId,
  batchProjectId: project.id,
  name: "家庭出行",
  ownerAccountId: "account_owner",
  status: "active",
  currentStage: "strategy",
  stageStatus: "in_progress",
  revision: 1,
  audience: "年轻家庭",
  theme: "周末出行",
  durationSeconds: 30,
  platformTags: ["douyin"],
  ...audit,
};

function grant(
  accountId: string,
  access: WorkspaceAccessGrant["access"],
  status: WorkspaceAccessGrant["status"] = "active",
): WorkspaceAccessGrant {
  return {
    id: `grant_${accountId}_${access.brandId}_${access.kind}`,
    tenantId: "tenant_firefly",
    accountId,
    access,
    status,
    revision: 1,
    ...audit,
  };
}

const projectAccess = {
  kind: "vehicle_project",
  brandId: brand.id,
  vehicleId: vehicle.id,
} as const;

function scope(
  actorAccountId: string,
  role: WorkspaceSessionScope["role"] = "creator",
  accessGrants: WorkspaceAccessGrant[] = [grant(actorAccountId, projectAccess)],
): WorkspaceSessionScope {
  return { actorAccountId, tenantId: "tenant_firefly", role, accessGrants };
}

function deniedCode(action: () => void): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof WorkspaceAccessDeniedError);
    return error.code;
  }
}

test("brand visibility and management require the authenticated tenant, grant, and admin role", () => {
  const administrator = scope(
    "account_admin",
    "content_admin",
    [grant("account_admin", { kind: "brand", brandId: brand.id })],
  );
  assert.equal(canViewBrand(administrator, brand), true);
  assert.doesNotThrow(() => assertCanViewBrand(administrator, brand));
  assert.doesNotThrow(() => assertCanManageBrand(administrator, brand));

  const creator = scope("account_creator");
  assert.equal(canViewBrand(creator, brand), true);
  assert.equal(deniedCode(() => assertCanManageBrand(creator, brand)), "AIC-AUTH-ROLE_DENIED");
  const otherBrand = { ...brand, id: "brand_other" };
  assert.equal(canViewBrand(creator, otherBrand), false);
  assert.equal(
    deniedCode(() => assertCanViewBrand(creator, otherBrand)),
    "AIC-AUTH-BRAND_SCOPE_DENIED",
  );
  const otherTenant = { ...brand, tenantId: "tenant_other" };
  assert.equal(
    deniedCode(() => assertCanViewBrand(creator, otherTenant)),
    "AIC-AUTH-TENANT_SCOPE_DENIED",
  );
  assert.equal(
    deniedCode(() => assertCanManageBrand(administrator, otherBrand)),
    "AIC-AUTH-BRAND_SCOPE_DENIED",
  );
});

test("only a creator with an exact active vehicle-project grant can create or view a project", () => {
  const creator = scope("account_creator");
  assert.doesNotThrow(() => assertCanCreateBatchProject(creator, brand, vehicle));
  assert.doesNotThrow(() => assertCanViewBatchProject(creator, project));
  assert.equal(canViewBatchProject(creator, project), true);

  const wrongVehicle = scope("account_creator", "creator", [
    grant("account_creator", { ...projectAccess, vehicleId: "vehicle_other" }),
  ]);
  assert.equal(
    deniedCode(() => assertCanCreateBatchProject(wrongVehicle, brand, vehicle)),
    "AIC-AUTH-PROJECT_SCOPE_DENIED",
  );
  assert.equal(canViewBatchProject(wrongVehicle, project), false);
  const crossBrandProject = { ...project, brandId: "brand_other" };
  assert.equal(canViewBatchProject(creator, crossBrandProject), false);
  assert.equal(
    deniedCode(() => assertCanViewBatchProject(creator, crossBrandProject)),
    "AIC-AUTH-PROJECT_SCOPE_DENIED",
  );

  const revoked = scope("account_creator", "creator", [
    grant("account_creator", projectAccess, "revoked"),
  ]);
  assert.equal(
    deniedCode(() => assertCanViewBatchProject(revoked, project)),
    "AIC-AUTH-PROJECT_SCOPE_DENIED",
  );
  const reviewer = scope("account_reviewer", "reviewer");
  assert.equal(
    deniedCode(() => assertCanCreateBatchProject(reviewer, brand, vehicle)),
    "AIC-AUTH-ROLE_DENIED",
  );
});

test("grants for another account or tenant never expand the authenticated scope", () => {
  const forged = scope("account_creator", "creator", [
    grant("account_other", projectAccess),
    { ...grant("account_creator", projectAccess), tenantId: "tenant_other" },
  ]);
  assert.equal(canViewBrand(forged, brand), false);
  assert.equal(canViewBatchProject(forged, project), false);
  assert.equal(
    deniedCode(() => assertCanViewBatchProject(forged, project)),
    "AIC-AUTH-PROJECT_SCOPE_DENIED",
  );
});

test("project members can view tasks but only the current owner can mutate them", () => {
  const owner = scope("account_owner");
  const member = scope("account_member");
  assert.doesNotThrow(() => assertCanViewVideoTask(owner, project, task));
  assert.doesNotThrow(() => assertCanViewVideoTask(member, project, task));
  assert.equal(canViewVideoTask(member, project, task), true);
  assert.doesNotThrow(() => assertCanOperateVideoTask(owner, project, task));
  assert.equal(
    deniedCode(() => assertCanOperateVideoTask(member, project, task)),
    "AIC-AUTH-TASK_OWNER_REQUIRED",
  );

  const wrongProject = { ...project, id: "project_other" };
  assert.equal(canViewVideoTask(member, wrongProject, task), false);
  assert.equal(
    deniedCode(() => assertCanViewVideoTask(member, wrongProject, task)),
    "AIC-AUTH-TASK_SCOPE_DENIED",
  );
  const crossTenantTask = { ...task, tenantId: "tenant_other" };
  assert.equal(
    deniedCode(() => assertCanOperateVideoTask(owner, project, crossTenantTask)),
    "AIC-AUTH-TENANT_SCOPE_DENIED",
  );
});

test("takeover eligibility requires vehicle-project membership and a different current owner", () => {
  const member = scope("account_member");
  assert.doesNotThrow(() => assertCanTakeOverVideoTask(member, project, task));
  assert.equal(
    deniedCode(() => assertCanTakeOverVideoTask(scope("account_owner"), project, task)),
    "AIC-AUTH-TASK_ALREADY_OWNED",
  );

  const brandAdministrator = scope(
    "account_admin",
    "content_admin",
    [grant("account_admin", { kind: "brand", brandId: brand.id })],
  );
  assert.doesNotThrow(() => assertCanViewVideoTask(brandAdministrator, project, task));
  assert.equal(
    deniedCode(() => assertCanTakeOverVideoTask(brandAdministrator, project, task)),
    "AIC-AUTH-PROJECT_SCOPE_DENIED",
  );
});
