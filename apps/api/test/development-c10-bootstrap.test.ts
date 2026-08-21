import assert from "node:assert/strict";
import test from "node:test";

import {
  c10ExtendedRangeVehicle,
  c10PureElectricVehicle,
} from "../src/development-c10-bootstrap.ts";

test("C10 development facts keep powertrain versions separate and store facts as strings", () => {
  assert.notEqual(c10PureElectricVehicle.id, c10ExtendedRangeVehicle.id);
  assert.equal(c10PureElectricVehicle.parameters && Object.keys(c10PureElectricVehicle.parameters).length, 0);
  assert.equal(c10ExtendedRangeVehicle.parameters && Object.keys(c10ExtendedRangeVehicle.parameters).length, 0);
  assert.equal(typeof c10PureElectricVehicle.factsText, "string");
  assert.equal(typeof c10ExtendedRangeVehicle.factsText, "string");

  const pureElectricFacts = [
    ...c10PureElectricVehicle.fixedClaims,
    ...c10PureElectricVehicle.optionalClaims,
  ];
  const extendedRangeFacts = [
    ...c10ExtendedRangeVehicle.fixedClaims,
    ...c10ExtendedRangeVehicle.optionalClaims,
  ];
  assert.ok(pureElectricFacts.length >= 1 && pureElectricFacts.length <= 20);
  assert.ok(extendedRangeFacts.length >= 1 && extendedRangeFacts.length <= 20);
  assert.ok(pureElectricFacts.every((claim) => typeof claim.statement === "string" && claim.statement.length > 0));
  assert.ok(extendedRangeFacts.every((claim) => typeof claim.statement === "string" && claim.statement.length > 0));

  const pureElectricText = pureElectricFacts.map((claim) => claim.statement).join("\n");
  const extendedRangeText = extendedRangeFacts.map((claim) => claim.statement).join("\n");
  assert.match(pureElectricText, /660km/u);
  assert.match(pureElectricText, /81\.9kWh/u);
  assert.doesNotMatch(pureElectricText, /综合续航为 1300km/u);
  assert.match(extendedRangeText, /纯电续航为 290km/u);
  assert.match(extendedRangeText, /综合续航为 1300km/u);
  assert.doesNotMatch(extendedRangeText, /电池容量为 81\.9kWh/u);
  assert.match(c10PureElectricVehicle.factsText!, /660km/u);
  assert.doesNotMatch(c10PureElectricVehicle.factsText!, /综合续航为 1300km/u);
  assert.match(c10ExtendedRangeVehicle.factsText!, /综合续航为 1300km/u);
});
