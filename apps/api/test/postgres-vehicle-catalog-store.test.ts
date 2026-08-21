import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { VehicleSnapshot } from "@firefly/schemas";

import {
  c10ExtendedRangeVehicle,
  c10PureElectricVehicle,
} from "../src/development-c10-bootstrap.ts";
import type { PostgresQueryable, PostgresQueryResult } from "../src/postgres-contract.ts";
import {
  persistPostgresVehicleTaskSnapshot,
  renderVehicleFactsText,
  renderVehicleSnapshotFactsText,
  synchronizePostgresVehicleCatalog,
  verifyPostgresVehicleCatalogProjection,
} from "../src/postgres-vehicle-catalog-store.ts";

class CatalogPostgres implements PostgresQueryable {
  readonly calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  snapshotIdentity: {
    snapshot_id: string;
    variant_id: string;
    fact_version: number;
    facts_sha256: string;
    validation_index: unknown;
  } | undefined;
  projectionRows: Array<{
    variant_id: string;
    fact_version: number;
    facts_sha256: string;
    validation_index: unknown;
  }> = [];

  async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters: structuredClone(parameters) });
    if (/INSERT INTO video_task_vehicle_snapshots/u.test(sql)) {
      this.snapshotIdentity = {
        snapshot_id: String(parameters[0]),
        variant_id: String(parameters[4]),
        fact_version: Number(parameters[5]),
        facts_sha256: String(parameters[7]),
        validation_index: JSON.parse(String(parameters[8])),
      };
    }
    if (/SELECT snapshot_id, variant_id, fact_version, facts_sha256, validation_index/u.test(sql)) {
      return { rows: this.snapshotIdentity === undefined ? [] : [this.snapshotIdentity as Row], rowCount: 1 };
    }
    if (/SELECT variant_id, fact_version, facts_sha256, validation_index/u.test(sql)) {
      return { rows: structuredClone(this.projectionRows) as Row[], rowCount: this.projectionRows.length };
    }
    return { rows: [], rowCount: 1 };
  }
}

test("PostgreSQL vehicle catalog separates one model, variants, and immutable string fact revisions", async () => {
  const database = new CatalogPostgres();
  await synchronizePostgresVehicleCatalog(database, "tenant_firefly", [
    c10PureElectricVehicle,
    c10ExtendedRangeVehicle,
  ]);

  const modelWrites = database.calls.filter((call) => /INSERT INTO vehicle_models/u.test(call.sql));
  const variantWrites = database.calls.filter((call) => /INSERT INTO vehicle_variants/u.test(call.sql));
  const factWrites = database.calls.filter((call) => /INSERT INTO vehicle_fact_versions/u.test(call.sql));
  assert.equal(modelWrites.length, 1);
  assert.equal(variantWrites.length, 2);
  assert.notEqual(variantWrites[0]?.parameters[1], variantWrites[1]?.parameters[1]);
  assert.equal(factWrites.length, 2);
  const pureElectricWrite = factWrites.find(
    (call) => call.parameters[1] === c10PureElectricVehicle.id,
  );
  const extendedRangeWrite = factWrites.find(
    (call) => call.parameters[1] === c10ExtendedRangeVehicle.id,
  );
  assert.match(String(pureElectricWrite?.parameters[3]), /660km/u);
  assert.doesNotMatch(String(pureElectricWrite?.parameters[3]), /"parameters"/u);
  assert.match(String(extendedRangeWrite?.parameters[3]), /综合续航为 1300km/u);
});

test("catalog projection verification and task snapshot use the exact frozen string hash", async () => {
  const database = new CatalogPostgres();
  const factsText = renderVehicleFactsText(c10PureElectricVehicle);
  database.projectionRows = [{
    variant_id: c10PureElectricVehicle.id,
    fact_version: c10PureElectricVehicle.version,
    facts_sha256: createHash("sha256").update(factsText).digest("hex"),
    validation_index: {
      fixedClaims: structuredClone(c10PureElectricVehicle.fixedClaims),
      optionalClaims: structuredClone(c10PureElectricVehicle.optionalClaims),
      prohibitedClaims: structuredClone(c10PureElectricVehicle.prohibitedClaims),
    },
  }];
  await verifyPostgresVehicleCatalogProjection(
    database,
    c10PureElectricVehicle.tenantId,
    [c10PureElectricVehicle],
  );

  const snapshot: VehicleSnapshot = {
    id: "vehicle_snapshot_c10_string_test",
    projectId: "batch_project_c10_string_test",
    vehicleId: c10PureElectricVehicle.id,
    vehicleVersion: c10PureElectricVehicle.version,
    brandId: c10PureElectricVehicle.brandId,
    brand: "零跑汽车",
    series: c10PureElectricVehicle.series,
    modelYear: c10PureElectricVehicle.modelYear,
    trim: c10PureElectricVehicle.trim,
    ...(c10PureElectricVehicle.factsText === undefined
      ? {}
      : { factsText: c10PureElectricVehicle.factsText }),
    parameters: {},
    fixedClaims: structuredClone(c10PureElectricVehicle.fixedClaims),
    optionalClaims: structuredClone(c10PureElectricVehicle.optionalClaims),
    prohibitedClaims: structuredClone(c10PureElectricVehicle.prohibitedClaims),
    referenceAssetIds: [],
    createdAt: "2026-08-21T12:00:00.000Z",
    createdBy: "account_creator_a",
  };
  await persistPostgresVehicleTaskSnapshot(database, snapshot, {
    tenantId: c10PureElectricVehicle.tenantId,
    batchProjectId: snapshot.projectId,
    videoTaskId: "video_task_c10_string_test",
  });
  const snapshotWrite = database.calls.find((call) => /INSERT INTO video_task_vehicle_snapshots/u.test(call.sql));
  assert.equal(renderVehicleSnapshotFactsText(snapshot), c10PureElectricVehicle.factsText);
  assert.equal(snapshotWrite?.parameters[6], renderVehicleSnapshotFactsText(snapshot));
  assert.equal(snapshotWrite?.parameters[7], createHash("sha256")
    .update(renderVehicleSnapshotFactsText(snapshot)).digest("hex"));
});
