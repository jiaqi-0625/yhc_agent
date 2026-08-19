import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import {
  WorkspaceAccessGrantSchema,
  type WorkspaceAccessGrant,
} from "../src/index.ts";

const audit = {
  createdAt: "2026-08-19T00:00:00.000Z",
  createdBy: "account_admin",
  updatedAt: "2026-08-19T00:00:00.000Z",
  updatedBy: "account_admin",
} as const;

const brandGrant = {
  id: "grant_admin_firefly",
  tenantId: "tenant_firefly",
  accountId: "account_admin",
  access: { kind: "brand", brandId: "brand_firefly" },
  status: "active",
  revision: 1,
  ...audit,
} satisfies WorkspaceAccessGrant;

const vehicleProjectGrant = {
  id: "grant_creator_e5",
  tenantId: "tenant_firefly",
  accountId: "account_creator",
  access: {
    kind: "vehicle_project",
    brandId: "brand_firefly",
    vehicleId: "vehicle_e5",
  },
  status: "active",
  revision: 1,
  ...audit,
} satisfies WorkspaceAccessGrant;

test("workspace grants distinguish brand management from vehicle-project membership", () => {
  assert.equal(Value.Check(WorkspaceAccessGrantSchema, brandGrant), true);
  assert.equal(Value.Check(WorkspaceAccessGrantSchema, vehicleProjectGrant), true);
  assert.equal(
    Value.Check(WorkspaceAccessGrantSchema, {
      ...brandGrant,
      access: { ...brandGrant.access, vehicleId: "vehicle_forged" },
    }),
    false,
  );
  assert.equal(
    Value.Check(WorkspaceAccessGrantSchema, {
      ...vehicleProjectGrant,
      access: { kind: "vehicle_project", brandId: "brand_firefly" },
    }),
    false,
  );
});

test("workspace grants reject untrusted roles, project ids, and invalid lifecycle data", () => {
  assert.equal(Value.Check(WorkspaceAccessGrantSchema, { ...brandGrant, role: "content_admin" }), false);
  assert.equal(Value.Check(WorkspaceAccessGrantSchema, { ...brandGrant, batchProjectId: "project_1" }), false);
  assert.equal(Value.Check(WorkspaceAccessGrantSchema, { ...brandGrant, status: "deleted" }), false);
  assert.equal(Value.Check(WorkspaceAccessGrantSchema, { ...brandGrant, revision: 0 }), false);
  assert.equal(Value.Check(WorkspaceAccessGrantSchema, { ...brandGrant, accountId: "../account" }), false);
  assert.equal(Value.Check(WorkspaceAccessGrantSchema, { ...brandGrant, status: "revoked" }), true);
});
