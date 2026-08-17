import assert from "node:assert/strict";
import test from "node:test";

import { VehicleSnapshotRequestSchema, type Claim } from "@firefly/schemas";

import { createVehicleTools, InMemoryVehicleService, VehicleAccessError } from "../src/index.ts";

const fixedClaim: Claim = {
  id: "claim_range",
  kind: "fixed",
  name: "CLTC续航",
  statement: "CLTC纯电续航600公里",
  value: 600,
  unit: "公里",
  requiredInVoiceover: false,
  requiredInSubtitle: false,
  mayRephrase: false,
  riskNotes: [],
};

function createService() {
  return new InMemoryVehicleService([
    {
      tenantId: "tenant_a",
      vehicleId: "vehicle_001",
      vehicleVersion: 3,
      brandId: "brand_a",
      brand: "示例汽车",
      series: "萤火系列",
      modelYear: 2026,
      trim: "长续航版",
      parameters: { seats: 5 },
      fixedClaims: [fixedClaim],
      optionalClaims: [],
      prohibitedClaims: ["自动驾驶"],
      referenceAssetIds: ["asset_001"],
    },
  ]);
}

const allowedScope = {
  actorId: "user_001",
  tenantId: "tenant_a",
  projectId: "project_001",
  allowedBrandIds: ["brand_a"],
};

test("vehicle snapshot tool derives project and brand scope from the server closure", async () => {
  const tools = createVehicleTools(createService(), allowedScope);
  const tool = tools.find((candidate) => candidate.name === "get_vehicle_snapshot");
  assert.ok(tool);
  assert.deepEqual(Object.keys((tool.parameters as typeof VehicleSnapshotRequestSchema).properties), [
    "vehicleId",
    "color",
    "region",
    "campaignDate",
  ]);

  const result = await tool.execute("call_1", {
    vehicleId: "vehicle_001",
    campaignDate: "2026-08-14",
  });
  assert.equal(result.details.projectId, "project_001");
  assert.equal(result.details.brandId, "brand_a");
});

test("vehicle access is denied when the authenticated scope excludes the brand", () => {
  const service = createService();
  assert.throws(
    () =>
      service.createSnapshot(
        { vehicleId: "vehicle_001", campaignDate: "2026-08-14" },
        { ...allowedScope, allowedBrandIds: ["brand_b"] },
      ),
    VehicleAccessError,
  );
});

test("snapshots are immutable copies and claims are validated against them", () => {
  const service = createService();
  const snapshot = service.createSnapshot(
    { vehicleId: "vehicle_001", campaignDate: "2026-08-14" },
    allowedScope,
  );
  snapshot.parameters.seats = 7;

  const stored = service.getSnapshot(snapshot.id, allowedScope);
  assert.equal(stored.parameters.seats, 5);

  const validation = service.validateClaims(
    {
      snapshotId: stored.id,
      statements: ["CLTC纯电续航600公里", "支持自动驾驶", "全国续航第一"],
    },
    allowedScope,
  );
  assert.deepEqual(
    validation.results.map((result) => result.status),
    ["supported", "prohibited", "unverified"],
  );
});
