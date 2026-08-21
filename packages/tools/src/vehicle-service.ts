import { createHash } from "node:crypto";

import type {
  Claim,
  ClaimEvidence,
  ClaimValidationRequest,
  VehicleSnapshot,
  VehicleSnapshotRequest,
} from "@firefly/schemas";

export interface ToolExecutionScope {
  actorId: string;
  tenantId: string;
  projectId: string;
  allowedBrandIds: readonly string[];
}

export interface VehicleCatalogEntry {
  tenantId: string;
  vehicleId: string;
  vehicleVersion: number;
  brandId: string;
  brand: string;
  series: string;
  modelYear: number;
  trim: string;
  factsText?: string;
  parameters: Readonly<Record<string, string | number | boolean>>;
  fixedClaims: readonly Claim[];
  optionalClaims: readonly Claim[];
  prohibitedClaims: readonly string[];
  referenceAssetIds: readonly string[];
}

export interface ClaimFactReference {
  claimId: string;
  claimName: string;
  approvedStatement: string;
  riskNotes: string[];
  evidence?: ClaimEvidence;
}

export type ClaimValidationItem =
  | {
      statement: string;
      status: "supported";
      reason: string;
      factReferences: ClaimFactReference[];
    }
  | {
      statement: string;
      status: "prohibited";
      reason: string;
      prohibitedExpressions: string[];
    }
  | {
      statement: string;
      status: "unverified";
      reason: string;
    };

export interface ClaimValidationResult {
  snapshotId: string;
  results: ClaimValidationItem[];
}

/**
 * Minimal server-side port used by the Agent vehicle tools. A persistent
 * reader may be asynchronous; the local V1 implementation remains a valid
 * synchronous implementation of the same contract.
 */
export interface VehicleServicePort {
  createSnapshot(
    request: VehicleSnapshotRequest,
    scope: ToolExecutionScope,
  ): VehicleSnapshot | Promise<VehicleSnapshot>;
  validateClaims(
    request: ClaimValidationRequest,
    scope: ToolExecutionScope,
  ): ClaimValidationResult | Promise<ClaimValidationResult>;
}

export class VehicleAccessError extends Error {
  readonly code = "AIC-AUTH-VEHICLE_SCOPE_DENIED";

  constructor(message = "Vehicle data is outside the authenticated project or brand scope.") {
    super(message);
    this.name = "VehicleAccessError";
  }
}

export class VehicleNotFoundError extends Error {
  readonly code = "AIC-DATA-VEHICLE_NOT_FOUND";

  constructor(vehicleId: string) {
    super(`Vehicle '${vehicleId}' was not found.`);
    this.name = "VehicleNotFoundError";
  }
}

export class SnapshotNotFoundError extends Error {
  readonly code = "AIC-DATA-SNAPSHOT_NOT_FOUND";

  constructor(snapshotId: string) {
    super(`Vehicle snapshot '${snapshotId}' was not found.`);
    this.name = "SnapshotNotFoundError";
  }
}

function cloneSnapshot(snapshot: VehicleSnapshot): VehicleSnapshot {
  return structuredClone(snapshot);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/[\s，。！？、；：,.!?;:]/gu, "").toLocaleLowerCase("zh-CN");
}

/** Validate statements against one already-authorized immutable snapshot. */
export function validateClaimsAgainstSnapshot(
  request: Readonly<ClaimValidationRequest>,
  snapshot: Readonly<VehicleSnapshot>,
): ClaimValidationResult {
  if (request.snapshotId !== snapshot.id) throw new SnapshotNotFoundError(request.snapshotId);
  const claims = [...snapshot.fixedClaims, ...snapshot.optionalClaims];

  return {
    snapshotId: snapshot.id,
    results: request.statements.map((statement) => {
      const normalized = normalize(statement);
      const prohibitedExpressions = snapshot.prohibitedClaims.filter((term) =>
        normalized.includes(normalize(term)),
      );
      if (prohibitedExpressions.length > 0) {
        return {
          statement,
          status: "prohibited" as const,
          reason: `检测到禁用表达：${prohibitedExpressions.map((term) => `“${term}”`).join("、")}。`,
          prohibitedExpressions: [...prohibitedExpressions],
        };
      }

      const matches = claims.filter((claim) => {
        const approved = normalize(claim.statement);
        return normalized === approved || (claim.mayRephrase && normalized.includes(approved));
      });
      if (matches.length > 0) {
        return {
          statement,
          status: "supported" as const,
          reason: `该表述由车型事实${matches.map((claim) => `“${claim.name}”`).join("、")}支持。`,
          factReferences: matches.map((claim) => ({
            claimId: claim.id,
            claimName: claim.name,
            approvedStatement: claim.statement,
            riskNotes: [...claim.riskNotes],
            ...(claim.evidence === undefined ? {} : { evidence: structuredClone(claim.evidence) }),
          })),
        };
      }

      return {
        statement,
        status: "unverified" as const,
        reason: "当前车型快照中没有可支持该表述的官方事实。",
      };
    }),
  };
}

function snapshotIdentifier(scope: ToolExecutionScope, entry: VehicleCatalogEntry, request: VehicleSnapshotRequest): string {
  const source = JSON.stringify({
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    vehicleId: entry.vehicleId,
    vehicleVersion: entry.vehicleVersion,
    color: request.color ?? null,
    region: request.region ?? null,
    campaignDate: request.campaignDate,
  });
  return `vs_${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
}

export class InMemoryVehicleService implements VehicleServicePort {
  readonly #catalog = new Map<string, VehicleCatalogEntry>();
  readonly #snapshots = new Map<string, VehicleSnapshot>();

  constructor(entries: readonly VehicleCatalogEntry[]) {
    for (const entry of entries) {
      this.#catalog.set(`${entry.tenantId}:${entry.vehicleId}`, structuredClone(entry));
    }
  }

  createSnapshot(request: VehicleSnapshotRequest, scope: ToolExecutionScope): VehicleSnapshot {
    const entry = this.#catalog.get(`${scope.tenantId}:${request.vehicleId}`);
    if (!entry) throw new VehicleNotFoundError(request.vehicleId);
    if (!scope.allowedBrandIds.includes(entry.brandId)) throw new VehicleAccessError();

    const id = snapshotIdentifier(scope, entry, request);
    const existing = this.#snapshots.get(id);
    if (existing) return cloneSnapshot(existing);

    const snapshot: VehicleSnapshot = {
      id,
      projectId: scope.projectId,
      vehicleId: entry.vehicleId,
      vehicleVersion: entry.vehicleVersion,
      brandId: entry.brandId,
      brand: entry.brand,
      series: entry.series,
      modelYear: entry.modelYear,
      trim: entry.trim,
      ...(request.color === undefined ? {} : { color: request.color }),
      ...(entry.factsText === undefined ? {} : { factsText: entry.factsText }),
      parameters: structuredClone(entry.parameters),
      fixedClaims: [...structuredClone(entry.fixedClaims)],
      optionalClaims: [...structuredClone(entry.optionalClaims)],
      prohibitedClaims: [...entry.prohibitedClaims],
      referenceAssetIds: [...entry.referenceAssetIds],
      createdAt: new Date().toISOString(),
      createdBy: scope.actorId,
    };
    this.#snapshots.set(id, cloneSnapshot(snapshot));
    return cloneSnapshot(snapshot);
  }

  getSnapshot(snapshotId: string, scope: ToolExecutionScope): VehicleSnapshot {
    const snapshot = this.#snapshots.get(snapshotId);
    if (!snapshot) throw new SnapshotNotFoundError(snapshotId);
    if (snapshot.projectId !== scope.projectId || !scope.allowedBrandIds.includes(snapshot.brandId)) {
      throw new VehicleAccessError("Vehicle snapshot is outside the authenticated project or brand scope.");
    }
    return cloneSnapshot(snapshot);
  }

  validateClaims(request: ClaimValidationRequest, scope: ToolExecutionScope): ClaimValidationResult {
    const snapshot = this.getSnapshot(request.snapshotId, scope);
    return validateClaimsAgainstSnapshot(request, snapshot);
  }
}
