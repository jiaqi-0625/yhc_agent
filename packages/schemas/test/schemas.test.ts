import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { ClaimSchema, VehicleSnapshotSchema, WorkSchema } from "../src/index.ts";

const fixedClaim = {
  id: "claim_range",
  kind: "fixed",
  name: "续航",
  statement: "CLTC 续航 550 公里",
  value: 550,
  unit: "km",
  evidence: {
    sourceName: "官方配置表",
    sourceReference: "vehicle-spec-v1",
    effectiveFrom: "2026-08-01",
  },
  requiredInVoiceover: true,
  requiredInSubtitle: true,
  mayRephrase: false,
  riskNotes: ["必须保留 CLTC 测试条件"],
} as const;

test("fixed claim requires valid evidence shape", () => {
  assert.equal(Value.Check(ClaimSchema, fixedClaim), true);
  assert.equal(Value.Check(ClaimSchema, { ...fixedClaim, evidence: { sourceName: "" } }), false);
});
test("vehicle snapshot rejects unknown properties and invalid versions", () => {
  const snapshot = {
    id: "vs_001",
    projectId: "project_001",
    vehicleId: "vehicle_001",
    vehicleVersion: 1,
    brandId: "brand_001",
    brand: "示例汽车",
    series: "示例车系",
    modelYear: 2026,
    trim: "旗舰版",
    parameters: { seats: 5 },
    fixedClaims: [fixedClaim],
    optionalClaims: [],
    prohibitedClaims: ["全国最低价"],
    referenceAssetIds: ["asset_001"],
    createdAt: "2026-08-14T00:00:00.000Z",
    createdBy: "user_001",
  };
  assert.equal(Value.Check(VehicleSnapshotSchema, snapshot), true);
  assert.equal(Value.Check(VehicleSnapshotSchema, { ...snapshot, vehicleVersion: 0 }), false);
  assert.equal(Value.Check(VehicleSnapshotSchema, { ...snapshot, secret: "not-allowed" }), false);
});

test("work schema validates revisioned workflow state", () => {
  assert.equal(
    Value.Check(WorkSchema, {
      id: "work_001",
      projectId: "project_001",
      status: "created",
      revision: 1,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    }),
    true,
  );
  assert.equal(
    Value.Check(WorkSchema, {
      id: "work_001",
      projectId: "project_001",
      status: "published_to_media",
      revision: 1,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    }),
    false,
  );
});
