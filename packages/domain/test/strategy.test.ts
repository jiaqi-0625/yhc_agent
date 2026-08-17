import assert from "node:assert/strict";
import test from "node:test";

import type { Strategy, VehicleSnapshot } from "@firefly/schemas";

import { preserveLockedStrategyItems, validateStrategy } from "../src/index.ts";

const evidence = { sourceName: "配置表", sourceReference: "spec-v1", effectiveFrom: "2026-08-01" };
const snapshot = {
  id: "vs_001",
  projectId: "project_001",
  vehicleId: "vehicle_001",
  vehicleVersion: 1,
  brandId: "brand_001",
  brand: "示例汽车",
  series: "E5",
  modelYear: 2026,
  trim: "长续航版",
  parameters: {},
  fixedClaims: [{
    id: "claim_range",
    kind: "fixed",
    name: "续航",
    statement: "CLTC 续航 550 公里",
    evidence,
    requiredInVoiceover: true,
    requiredInSubtitle: true,
    mayRephrase: false,
    riskNotes: [],
  }],
  optionalClaims: [],
  prohibitedClaims: ["全国最低价"],
  referenceAssetIds: [],
  createdAt: "2026-08-17T00:00:00.000Z",
  createdBy: "user_001",
} satisfies VehicleSnapshot;

function strategy(statement = "CLTC 续航 550 公里"): Strategy {
  return {
    id: "strategy_001",
    workId: "work_001",
    vehicleSnapshotId: snapshot.id,
    version: 1,
    status: "draft",
    audience: "家庭用户",
    theme: "周末出行",
    items: [{
      id: "item_001",
      claimId: "claim_range",
      kind: "fixed",
      title: "续航",
      statement,
      rationale: "核心事实",
      order: 1,
      locked: false,
      evidence,
    }],
    model: "mock",
    templateVersion: "v1",
    createdAt: "2026-08-17T00:00:00.000Z",
    createdBy: "user_001",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

test("strategy validation blocks changed fixed facts and prohibited expressions", () => {
  assert.equal(validateStrategy(strategy(), snapshot).valid, true);
  const changed = validateStrategy(strategy("全国最低价，CLTC 续航 600 公里"), snapshot);
  assert.equal(changed.valid, false);
  assert.deepEqual(changed.issues.map((item) => item.code).sort(), [
    "AIC-STRATEGY-FACT_CHANGED",
    "AIC-STRATEGY-PROHIBITED_EXPRESSION",
  ]);
});

test("model regeneration preserves human locked items", () => {
  const previous = strategy().items.map((item) => ({ ...item, statement: "人工确认表达", locked: true }));
  const generated = strategy().items.map((item) => ({ ...item, id: "item_new" }));
  const merged = preserveLockedStrategyItems(generated, previous);
  assert.equal(merged[0]?.id, "item_001");
  assert.equal(merged[0]?.statement, "人工确认表达");
  assert.equal(merged[0]?.locked, true);
});
