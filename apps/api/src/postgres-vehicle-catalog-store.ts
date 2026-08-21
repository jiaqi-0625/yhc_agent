import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Claim, Vehicle, VehicleSnapshot } from "@firefly/schemas";

import type { PostgresQueryable } from "./postgres-contract.ts";

interface PersistedFactIdentityRow {
  variant_id: string;
  fact_version: number | string;
  facts_sha256: string;
  validation_index: unknown;
}

function modelId(vehicle: Readonly<Vehicle>): string {
  return `model_${createHash("md5").update([
    vehicle.tenantId,
    vehicle.brandId,
    vehicle.series,
    String(vehicle.modelYear),
  ].join("|")).digest("hex")}`;
}

function claimText(claims: readonly Readonly<Claim>[]): string {
  return claims.map((claim) => claim.statement.trim()).filter(Boolean).join("\n");
}

export function renderVehicleFactsText(vehicle: Readonly<Vehicle>): string {
  if (vehicle.factsText !== undefined) return vehicle.factsText.trim();
  return [
    `车型：${vehicle.series} ${vehicle.modelYear} ${vehicle.trim}`,
    claimText([...vehicle.fixedClaims, ...vehicle.optionalClaims]),
  ].filter(Boolean).join("\n");
}

export function renderVehicleSnapshotFactsText(snapshot: Readonly<VehicleSnapshot>): string {
  if (snapshot.factsText !== undefined) return snapshot.factsText.trim();
  return [
    `车型：${snapshot.brand} ${snapshot.series} ${snapshot.modelYear} ${snapshot.trim}`,
    claimText([...snapshot.fixedClaims, ...snapshot.optionalClaims]),
  ].filter(Boolean).join("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validationIndex(value: Readonly<{
  fixedClaims: readonly Claim[];
  optionalClaims: readonly Claim[];
  prohibitedClaims: readonly string[];
}>): string {
  return JSON.stringify({
    fixedClaims: structuredClone(value.fixedClaims),
    optionalClaims: structuredClone(value.optionalClaims),
    prohibitedClaims: structuredClone(value.prohibitedClaims),
  });
}

function source(vehicle: Readonly<Vehicle>): {
  sourceName: string;
  sourceReference: string;
  effectiveFrom: string;
  effectiveUntil?: string;
} {
  const evidence = [...vehicle.fixedClaims, ...vehicle.optionalClaims]
    .find((claim) => claim.evidence !== undefined)?.evidence;
  return evidence === undefined
    ? {
        sourceName: "工作区车型事实",
        sourceReference: vehicle.id,
        effectiveFrom: vehicle.createdAt.slice(0, 10),
      }
    : {
        sourceName: evidence.sourceName,
        sourceReference: evidence.sourceReference,
        effectiveFrom: evidence.effectiveFrom,
        ...(evidence.effectiveUntil === undefined ? {} : { effectiveUntil: evidence.effectiveUntil }),
      };
}

export async function synchronizePostgresVehicleCatalog(
  transaction: PostgresQueryable,
  tenantId: string,
  vehicles: readonly Readonly<Vehicle>[],
): Promise<void> {
  const ordered = [...vehicles].sort((left, right) =>
    left.id.localeCompare(right.id) || left.version - right.version);
  const latestVariants = new Map<string, Readonly<Vehicle>>();
  for (const vehicle of ordered) {
    if (vehicle.tenantId !== tenantId) {
      throw new Error("Vehicle catalog synchronization rejected a cross-tenant vehicle.");
    }
    const latest = latestVariants.get(vehicle.id);
    if (latest === undefined || vehicle.version > latest.version) latestVariants.set(vehicle.id, vehicle);
  }
  const groupedModels = new Map<string, Readonly<Vehicle>[]>();
  for (const vehicle of latestVariants.values()) {
    const key = modelId(vehicle);
    groupedModels.set(key, [...(groupedModels.get(key) ?? []), vehicle]);
  }
  for (const [currentModelId, modelVariants] of groupedModels) {
    const representative = modelVariants[0]!;
    const created = [...modelVariants].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]!;
    const updated = [...modelVariants].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!;
    await transaction.query(
      `INSERT INTO vehicle_models (
         tenant_id, model_id, brand_id, series_name, model_year, status,
         created_at, created_by, updated_at, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::timestamptz, $10)
       ON CONFLICT (tenant_id, model_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by`,
      [
        tenantId,
        currentModelId,
        representative.brandId,
        representative.series,
        representative.modelYear,
        modelVariants.some((vehicle) => vehicle.status === "active") ? "active" : "archived",
        created.createdAt,
        created.createdBy,
        updated.updatedAt,
        updated.updatedBy,
      ],
    );
  }
  for (const vehicle of ordered) {
    const currentModelId = modelId(vehicle);
    await transaction.query(
      `INSERT INTO vehicle_variants (
         tenant_id, variant_id, model_id, variant_name, status, current_fact_version,
         created_at, created_by, updated_at, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::timestamptz, $10)
       ON CONFLICT (tenant_id, variant_id) DO UPDATE SET
         model_id = EXCLUDED.model_id,
         variant_name = EXCLUDED.variant_name,
         status = EXCLUDED.status,
         current_fact_version = GREATEST(vehicle_variants.current_fact_version, EXCLUDED.current_fact_version),
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by`,
      [
        tenantId,
        vehicle.id,
        currentModelId,
        vehicle.trim,
        vehicle.status,
        vehicle.version,
        vehicle.createdAt,
        vehicle.createdBy,
        vehicle.updatedAt,
        vehicle.updatedBy,
      ],
    );
    const factsText = renderVehicleFactsText(vehicle);
    const evidence = source(vehicle);
    const inserted = await transaction.query(
      `INSERT INTO vehicle_fact_versions (
         tenant_id, variant_id, fact_version, facts_text, facts_sha256,
         validation_index, source_name, source_reference, effective_from, effective_until,
         created_at, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::date, $10::date,
         $11::timestamptz, $12
       ) ON CONFLICT (tenant_id, variant_id, fact_version) DO NOTHING`,
      [
        tenantId,
        vehicle.id,
        vehicle.version,
        factsText,
        sha256(factsText),
        validationIndex(vehicle),
        evidence.sourceName,
        evidence.sourceReference,
        evidence.effectiveFrom,
        evidence.effectiveUntil ?? null,
        vehicle.createdAt,
        vehicle.createdBy,
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await transaction.query<PersistedFactIdentityRow>(
        `SELECT variant_id, fact_version, facts_sha256, validation_index
           FROM vehicle_fact_versions
          WHERE tenant_id = $1 AND variant_id = $2 AND fact_version = $3`,
        [tenantId, vehicle.id, vehicle.version],
      );
      if (
        existing.rows[0]?.facts_sha256 !== sha256(factsText)
        || !isDeepStrictEqual(existing.rows[0]?.validation_index, JSON.parse(validationIndex(vehicle)))
      ) {
        throw new Error("Persisted vehicle fact history differs from the workspace administration aggregate.");
      }
    }
  }
}

export async function verifyPostgresVehicleCatalogProjection(
  queryable: PostgresQueryable,
  tenantId: string,
  vehicles: readonly Readonly<Vehicle>[],
): Promise<void> {
  if (vehicles.length === 0) return;
  const persisted = await queryable.query<PersistedFactIdentityRow>(
    `SELECT variant_id, fact_version, facts_sha256, validation_index
       FROM vehicle_fact_versions
      WHERE tenant_id = $1
      ORDER BY variant_id, fact_version`,
    [tenantId],
  );
  const index = new Map(persisted.rows.map((row) => [
    `${row.variant_id}:${Number(row.fact_version)}`,
    row,
  ]));
  for (const vehicle of vehicles) {
    const text = renderVehicleFactsText(vehicle);
    const row = index.get(`${vehicle.id}:${vehicle.version}`);
    if (
      row?.facts_sha256 !== sha256(text)
      || !isDeepStrictEqual(row.validation_index, JSON.parse(validationIndex(vehicle)))
    ) {
      throw new Error("PostgreSQL vehicle catalog projection is missing or inconsistent.");
    }
  }
}

export async function persistPostgresVehicleTaskSnapshot(
  transaction: PostgresQueryable,
  snapshot: Readonly<VehicleSnapshot>,
  scope: Readonly<{ tenantId: string; batchProjectId: string; videoTaskId: string }>,
): Promise<void> {
  const factsText = renderVehicleSnapshotFactsText(snapshot);
  await transaction.query(
    `INSERT INTO video_task_vehicle_snapshots (
       snapshot_id, tenant_id, batch_project_id, video_task_id, variant_id, fact_version,
       facts_text, facts_sha256, validation_index, locked_at, locked_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $11)
     ON CONFLICT (tenant_id, batch_project_id, video_task_id) DO NOTHING`,
    [
      snapshot.id,
      scope.tenantId,
      scope.batchProjectId,
      scope.videoTaskId,
      snapshot.vehicleId,
      snapshot.vehicleVersion,
      factsText,
      sha256(factsText),
      validationIndex(snapshot),
      snapshot.createdAt,
      snapshot.createdBy,
    ],
  );
  const verified = await transaction.query<{
    snapshot_id: string;
    variant_id: string;
    fact_version: number | string;
    facts_sha256: string;
    validation_index: unknown;
  }>(
    `SELECT snapshot_id, variant_id, fact_version, facts_sha256, validation_index
       FROM video_task_vehicle_snapshots
      WHERE tenant_id = $1 AND batch_project_id = $2 AND video_task_id = $3`,
    [scope.tenantId, scope.batchProjectId, scope.videoTaskId],
  );
  const row = verified.rows[0];
  if (
    row?.snapshot_id !== snapshot.id
    || row.variant_id !== snapshot.vehicleId
    || Number(row.fact_version) !== snapshot.vehicleVersion
    || row.facts_sha256 !== sha256(factsText)
    || !isDeepStrictEqual(row.validation_index, JSON.parse(validationIndex(snapshot)))
  ) {
    throw new Error("The task already has a different immutable vehicle snapshot.");
  }
}
