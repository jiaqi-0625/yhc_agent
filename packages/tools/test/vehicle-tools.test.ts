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
  evidence: {
    sourceName: "2026款产品参数表",
    sourceReference: "product-spec-2026-v3#range",
    effectiveFrom: "2026-01-01",
  },
  requiredInVoiceover: false,
  requiredInSubtitle: false,
  mayRephrase: false,
  riskNotes: ["必须保留 CLTC 测试条件"],
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
      prohibitedClaims: ["自动驾驶", "全国最低价"],
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

test("vehicle claim tool returns fact and exact prohibited-expression locations", async () => {
  const service = createService();
  const snapshot = service.createSnapshot(
    { vehicleId: "vehicle_001", campaignDate: "2026-08-14" },
    allowedScope,
  );
  const tool = createVehicleTools(service, allowedScope).find(
    (candidate) => candidate.name === "validate_vehicle_claims",
  );
  assert.ok(tool);

  const result = await tool.execute("call_validate", {
    snapshotId: snapshot.id,
    statements: ["CLTC纯电续航600公里", "支持自动驾驶"],
  });
  assert.equal(result.details.results[0]?.status, "supported");
  assert.deepEqual(result.details.results[1], {
    statement: "支持自动驾驶",
    status: "prohibited",
    reason: "检测到禁用表达：“自动驾驶”。",
    prohibitedExpressions: ["自动驾驶"],
  });
  const content = result.content[0];
  assert.ok(content && content.type === "text");
  assert.deepEqual(JSON.parse(content.text), result.details);
});

test("claim validation locates supporting facts, prohibited expressions, and unverified statements", () => {
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
      statements: ["CLTC纯电续航600公里", "支持自动驾驶且全国最低价", "全国续航第一"],
    },
    allowedScope,
  );
  assert.deepEqual(
    validation.results.map((result) => result.status),
    ["supported", "prohibited", "unverified"],
  );
  assert.deepEqual(validation.results[0], {
    statement: "CLTC纯电续航600公里",
    status: "supported",
    reason: "该表述由车型事实“CLTC续航”支持。",
    factReferences: [
      {
        claimId: "claim_range",
        claimName: "CLTC续航",
        approvedStatement: "CLTC纯电续航600公里",
        riskNotes: ["必须保留 CLTC 测试条件"],
        evidence: {
          sourceName: "2026款产品参数表",
          sourceReference: "product-spec-2026-v3#range",
          effectiveFrom: "2026-01-01",
        },
      },
    ],
  });
  assert.deepEqual(validation.results[1], {
    statement: "支持自动驾驶且全国最低价",
    status: "prohibited",
    reason: "检测到禁用表达：“自动驾驶”、“全国最低价”。",
    prohibitedExpressions: ["自动驾驶", "全国最低价"],
  });
  assert.deepEqual(validation.results[2], {
    statement: "全国续航第一",
    status: "unverified",
    reason: "当前车型快照中没有可支持该表述的官方事实。",
  });
});
