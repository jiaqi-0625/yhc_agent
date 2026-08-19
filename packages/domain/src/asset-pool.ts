import type {
  AssetReference,
  BatchProject,
  CompanyReusableAssetReference,
  CompanyVehicleAssetReference,
  ProjectAssetPool,
  TaskAssetSnapshot,
} from "@firefly/schemas";

import type { VideoTaskProductionRecord } from "./stage-confirmation.ts";
import { assertRevision } from "./workflow.ts";

export interface AssetPoolMutationContext {
  tenantId: string;
  actorAccountId: string;
  occurredAt: string;
  createId: (kind: "project_asset_pool" | "task_asset_snapshot") => string;
}

export type AssetPoolErrorCode =
  | "AIC-ASSET-POOL_SCOPE_INVALID"
  | "AIC-ASSET-POOL_DUPLICATE_REFERENCE"
  | "AIC-ASSET-POOL_VEHICLE_REQUIRED"
  | "AIC-ASSET-POOL_VEHICLE_MISMATCH"
  | "AIC-ASSET-SNAPSHOT_ALREADY_LOCKED"
  | "AIC-ASSET-SNAPSHOT_STAGE_INVALID"
  | "AIC-ASSET-SNAPSHOT_VEHICLE_REQUIRED";

export class AssetPoolError extends Error {
  constructor(
    readonly code: AssetPoolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AssetPoolError";
  }
}

type CompanyAssetReference = CompanyVehicleAssetReference | CompanyReusableAssetReference;

function referenceIdentity(reference: Readonly<AssetReference>): string {
  if (reference.source === "company_catalog") {
    return `${reference.source}:${reference.sourceProvider}:${reference.assetId}`;
  }
  return `${reference.source}:${reference.batchProjectId}:${reference.assetId}`;
}

function assertPoolAssets(
  project: Readonly<BatchProject>,
  assets: readonly AssetReference[],
): void {
  if (assets.length < 1 || assets.length > 500) {
    throw new AssetPoolError(
      "AIC-ASSET-POOL_VEHICLE_REQUIRED",
      "A project asset pool must contain 1 to 500 assets.",
    );
  }
  const identities = new Set<string>();
  for (const asset of assets) {
    const identity = referenceIdentity(asset);
    if (identities.has(identity)) {
      throw new AssetPoolError(
        "AIC-ASSET-POOL_DUPLICATE_REFERENCE",
        "A project asset pool cannot contain duplicate asset identities.",
      );
    }
    identities.add(identity);
    if (asset.source === "local_upload" && asset.batchProjectId !== project.id) {
      throw new AssetPoolError(
        "AIC-ASSET-POOL_SCOPE_INVALID",
        "A temporary asset belongs to a different batch project.",
      );
    }
    if (
      asset.source === "company_catalog" &&
      asset.category === "vehicle" &&
      asset.vehicleId !== project.vehicleId
    ) {
      throw new AssetPoolError(
        "AIC-ASSET-POOL_VEHICLE_MISMATCH",
        "Vehicle assets cannot be used across vehicles.",
      );
    }
  }
  const vehicleAssets = assets.filter(
    (asset): asset is CompanyVehicleAssetReference =>
      asset.source === "company_catalog" && asset.category === "vehicle",
  );
  if (vehicleAssets.length === 0) {
    throw new AssetPoolError(
      "AIC-ASSET-POOL_VEHICLE_REQUIRED",
      "A project asset pool must keep at least one company vehicle asset.",
    );
  }
}

export function createProjectAssetPool(
  project: Readonly<BatchProject>,
  assets: readonly AssetReference[],
  context: Readonly<AssetPoolMutationContext>,
): ProjectAssetPool {
  if (project.tenantId !== context.tenantId) {
    throw new AssetPoolError(
      "AIC-ASSET-POOL_SCOPE_INVALID",
      "The project is outside the authenticated tenant scope.",
    );
  }
  assertPoolAssets(project, assets);
  return {
    id: context.createId("project_asset_pool"),
    tenantId: project.tenantId,
    batchProjectId: project.id,
    vehicleId: project.vehicleId,
    revision: 1,
    assets: structuredClone([...assets]),
    createdAt: context.occurredAt,
    createdBy: context.actorAccountId,
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}

export function refreshProjectAssetPool(
  current: Readonly<ProjectAssetPool>,
  project: Readonly<BatchProject>,
  latestCompanyAssets: readonly CompanyAssetReference[],
  context: Readonly<AssetPoolMutationContext>,
): ProjectAssetPool {
  if (
    current.tenantId !== context.tenantId ||
    current.tenantId !== project.tenantId ||
    current.batchProjectId !== project.id ||
    current.vehicleId !== project.vehicleId
  ) {
    throw new AssetPoolError(
      "AIC-ASSET-POOL_SCOPE_INVALID",
      "The project asset pool is outside the project or tenant scope.",
    );
  }
  const latestByIdentity = new Map(
    latestCompanyAssets.map((asset) => [referenceIdentity(asset), asset] as const),
  );
  let changed = false;
  const assets = current.assets.map((asset) => {
    if (asset.source !== "company_catalog") return structuredClone(asset);
    const latest = latestByIdentity.get(referenceIdentity(asset));
    if (!latest || latest.category !== asset.category || latest.version <= asset.version) {
      return structuredClone(asset);
    }
    if (
      asset.category === "vehicle" &&
      (latest.category !== "vehicle" || latest.vehicleId !== asset.vehicleId)
    ) {
      throw new AssetPoolError(
        "AIC-ASSET-POOL_VEHICLE_MISMATCH",
        "A catalog refresh cannot replace a project's vehicle asset identity.",
      );
    }
    changed = true;
    return structuredClone(latest);
  });
  assertPoolAssets(project, assets);
  if (!changed) return structuredClone(current);
  return {
    ...structuredClone(current),
    revision: current.revision + 1,
    assets,
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}

export function lockVideoTaskAssetSnapshot(
  record: Readonly<VideoTaskProductionRecord>,
  project: Readonly<BatchProject>,
  pool: Readonly<ProjectAssetPool>,
  expectedTaskRevision: number,
  context: Readonly<AssetPoolMutationContext>,
): VideoTaskProductionRecord {
  assertRevision(expectedTaskRevision, record.videoTask.revision);
  const task = record.videoTask;
  if (
    task.tenantId !== context.tenantId ||
    task.tenantId !== project.tenantId ||
    task.batchProjectId !== project.id ||
    pool.tenantId !== project.tenantId ||
    pool.batchProjectId !== project.id ||
    pool.vehicleId !== project.vehicleId
  ) {
    throw new AssetPoolError(
      "AIC-ASSET-POOL_SCOPE_INVALID",
      "The task, project, and asset pool do not share one scope.",
    );
  }
  if (task.ownerAccountId !== context.actorAccountId) {
    throw new AssetPoolError(
      "AIC-ASSET-POOL_SCOPE_INVALID",
      "Only the current task owner can lock task assets.",
    );
  }
  if (task.assetSnapshotId !== undefined) {
    throw new AssetPoolError(
      "AIC-ASSET-SNAPSHOT_ALREADY_LOCKED",
      "The video task already has a locked asset snapshot.",
    );
  }
  if (
    task.status !== "active" ||
    task.currentStage !== "strategy" ||
    task.stageStatus !== "in_progress"
  ) {
    throw new AssetPoolError(
      "AIC-ASSET-SNAPSHOT_STAGE_INVALID",
      "Task assets must be locked when strategy work starts.",
    );
  }
  if (task.vehicleSnapshotId === undefined) {
    throw new AssetPoolError(
      "AIC-ASSET-SNAPSHOT_VEHICLE_REQUIRED",
      "A vehicle snapshot must be locked before task assets.",
    );
  }
  assertPoolAssets(project, pool.assets);
  const version =
    Math.max(0, ...record.taskAssetSnapshots.map((snapshot) => snapshot.version)) + 1;
  const snapshot: TaskAssetSnapshot = {
    id: context.createId("task_asset_snapshot"),
    tenantId: task.tenantId,
    batchProjectId: project.id,
    videoTaskId: task.id,
    version,
    sourceProjectAssetPoolRevision: pool.revision,
    vehicleSnapshotId: task.vehicleSnapshotId,
    assets: structuredClone(pool.assets),
    createdAt: context.occurredAt,
    createdBy: context.actorAccountId,
  };
  return {
    ...structuredClone(record),
    schemaVersion: 4,
    videoTask: {
      ...structuredClone(task),
      assetSnapshotId: snapshot.id,
      revision: task.revision + 1,
      updatedAt: context.occurredAt,
      updatedBy: context.actorAccountId,
    },
    taskAssetSnapshots: [...structuredClone(record.taskAssetSnapshots), snapshot],
  };
}
