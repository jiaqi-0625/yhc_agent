import assert from "node:assert/strict";
import test from "node:test";

import {
  assetReferenceIdentity,
  selectionWithManualPriority,
} from "../public/asset-matching.js";

const vehicle = {
  assetId: "asset_vehicle",
  version: 2,
  category: "vehicle",
  source: "company_catalog",
  sourceProvider: "mock_company_assets",
  vehicleId: "vehicle_e5",
} as const;
const person = {
  assetId: "asset_person",
  version: 1,
  category: "person",
  source: "company_catalog",
  sourceProvider: "mock_company_assets",
} as const;

test("asset reference identity includes source and exact version", () => {
  assert.notEqual(
    assetReferenceIdentity(vehicle),
    assetReferenceIdentity({ ...vehicle, version: 3 }),
  );
  assert.notEqual(assetReferenceIdentity(vehicle), assetReferenceIdentity(person));
});

test("manual asset selection always takes priority over a later Agent recommendation", () => {
  const recommended = selectionWithManualPriority([vehicle, person], null);
  const manual = new Set([assetReferenceIdentity(vehicle)]);
  const afterRecommendationRefresh = selectionWithManualPriority(
    [{ ...person, version: 2 }],
    manual,
  );
  assert.deepEqual(afterRecommendationRefresh, manual);
  assert.equal(afterRecommendationRefresh.has(assetReferenceIdentity(person)), false);
  assert.equal(recommended.has(assetReferenceIdentity(person)), true);
});
