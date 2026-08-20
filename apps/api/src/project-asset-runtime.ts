import { randomUUID } from "node:crypto";

import {
  assertCanOperateVideoTask,
  assertCanManageBatchProjectAssets,
  assertProjectAssetPoolAssets,
  assertCanViewBatchProject,
  createProjectAssetPool,
  lockVideoTaskAssetSnapshot,
  refreshProjectAssetPool,
  type AssetPoolMutationContext,
  type VideoTaskProductionRecord,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type { AssetReference, BatchProject, ProjectAssetPool } from "@firefly/schemas";
import type {
  CompanyAssetProvider,
  CompanyAssetProviderScope,
  CompanyAssetReference,
} from "@firefly/tools";

import {
  defaultProjectAssetCoordinator,
  type ProjectAssetCoordinator,
} from "./project-asset-coordinator.ts";
import type { ProjectAssetPoolStore } from "./project-asset-pool-store.ts";
import type { TemporaryAssetStore } from "./temporary-asset-store.ts";
import type { VideoTaskProductionStore } from "./video-task-store.ts";

export type ProjectAssetRuntimeErrorCode =
  | "AIC-ASSET-POOL-ALREADY-EXISTS"
  | "AIC-ASSET-POOL-NOT-FOUND"
  | "AIC-ASSET-POOL-PROJECT-LINK-INVALID"
  | "AIC-ASSET-POOL-CATALOG-REFERENCE-UNAVAILABLE"
  | "AIC-ASSET-TEMPORARY-REFERENCE-UNUSABLE"
  | "AIC-VIDEO-TASK-NOT-FOUND";

export class ProjectAssetRuntimeError extends Error {
  constructor(
    readonly code: ProjectAssetRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectAssetRuntimeError";
  }
}

const idPrefixes = {
  task_asset_snapshot: "tas",
} as const;

function referenceIdentity(reference: Readonly<CompanyAssetReference>): string {
  return `${reference.sourceProvider}:${reference.assetId}`;
}

function exactReferenceIdentity(reference: Readonly<CompanyAssetReference>): string {
  return `${referenceIdentity(reference)}:${reference.version}:${reference.category}:${
    reference.category === "vehicle" ? reference.vehicleId : "reusable"
  }`;
}

export class ProjectAssetRuntime {
  constructor(
    private readonly provider: CompanyAssetProvider,
    private readonly poolStore: ProjectAssetPoolStore,
    private readonly videoTaskStore: VideoTaskProductionStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: (kind: "task_asset_snapshot") => string = (kind) =>
      `${idPrefixes[kind]}_${randomUUID()}`,
    private readonly temporaryAssetStore?: TemporaryAssetStore,
    private readonly coordinator: ProjectAssetCoordinator = defaultProjectAssetCoordinator,
  ) {}

  #providerScope(
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): CompanyAssetProviderScope {
    assertCanViewBatchProject(session, project);
    return {
      tenantId: session.tenantId,
      actorAccountId: session.actorAccountId,
      allowedBrandIds: [project.brandId],
      allowedVehicleIds: [project.vehicleId],
    };
  }

  async #loadLatestCatalogReferences(
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<CompanyAssetReference[]> {
    const scope = this.#providerScope(project, session);
    const references: CompanyAssetReference[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.provider.searchAssets(
        {
          brandId: project.brandId,
          vehicleId: project.vehicleId,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
        scope,
      );
      references.push(...page.items.map((item) => structuredClone(item.reference)));
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-POOL-CATALOG-REFERENCE-UNAVAILABLE",
            "The company asset catalog returned a repeated pagination cursor.",
          );
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    return references;
  }

  async #normalizeSelectedReferences(
    selectedReferences: readonly CompanyAssetReference[],
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<CompanyAssetReference[]> {
    const scope = this.#providerScope(project, session);
    if (selectedReferences.some((reference) => reference.sourceProvider !== this.provider.providerId)) {
      throw new ProjectAssetRuntimeError(
        "AIC-ASSET-POOL-CATALOG-REFERENCE-UNAVAILABLE",
        "A selected company asset belongs to a different provider.",
      );
    }
    const resolved = await this.provider.resolveAssets(selectedReferences, scope);
    const exactResolvedReferences = new Set(
      resolved.items.map((item) => exactReferenceIdentity(item.reference)),
    );
    if (
      resolved.missingReferences.length > 0 ||
      selectedReferences.some(
        (reference) => !exactResolvedReferences.has(exactReferenceIdentity(reference)),
      )
    ) {
      throw new ProjectAssetRuntimeError(
        "AIC-ASSET-POOL-CATALOG-REFERENCE-UNAVAILABLE",
        "A selected company asset version is unavailable in the server-resolved project scope.",
      );
    }
    const latestReferences = await this.#loadLatestCatalogReferences(project, session);
    const latestByIdentity = new Map(
      latestReferences.map((reference) => [referenceIdentity(reference), reference] as const),
    );
    return selectedReferences.map((selected) => {
      const latest = latestByIdentity.get(referenceIdentity(selected));
      if (
        latest === undefined ||
        latest.category !== selected.category ||
        (selected.category === "vehicle" &&
          (latest.category !== "vehicle" || latest.vehicleId !== selected.vehicleId))
      ) {
        throw new ProjectAssetRuntimeError(
          "AIC-ASSET-POOL-CATALOG-REFERENCE-UNAVAILABLE",
          "A selected company asset is unavailable in the server-resolved project scope.",
        );
      }
      return structuredClone(latest);
    });
  }

  #mutationContext(
    session: Readonly<WorkspaceSessionScope>,
    occurredAt: string,
    projectAssetPoolId?: string,
  ): AssetPoolMutationContext {
    return {
      tenantId: session.tenantId,
      actorAccountId: session.actorAccountId,
      occurredAt,
      createId: (kind) => {
        if (kind === "project_asset_pool") {
          if (projectAssetPoolId === undefined) {
            throw new Error("A project asset pool ID was not supplied by the project aggregate.");
          }
          return projectAssetPoolId;
        }
        return this.createId(kind);
      },
    };
  }

  async createPool(
    project: Readonly<BatchProject>,
    selectedReferences: readonly CompanyAssetReference[],
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ProjectAssetPool> {
    return this.coordinator.runExclusive(project.id, async () => {
      const normalized = await this.#normalizeSelectedReferences(
        selectedReferences,
        project,
        session,
      );
      const occurredAt = this.now();
      return this.poolStore.transact(project.id, (current) => {
        if (current !== undefined) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-POOL-ALREADY-EXISTS",
            `Batch project '${project.id}' already has an asset pool.`,
          );
        }
        return createProjectAssetPool(
          project,
          normalized,
          this.#mutationContext(session, occurredAt, project.assetPoolId),
        );
      });
    });
  }

  async #getCurrentPoolUncoordinated(
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ProjectAssetPool> {
    this.#providerScope(project, session);
    return this.poolStore.transact(project.id, async (current) => {
      if (current === undefined) {
        throw new ProjectAssetRuntimeError(
          "AIC-ASSET-POOL-NOT-FOUND",
          `Batch project '${project.id}' does not have an asset pool.`,
        );
      }
      if (current.id !== project.assetPoolId) {
        throw new ProjectAssetRuntimeError(
          "AIC-ASSET-POOL-PROJECT-LINK-INVALID",
          "The persisted asset pool does not match the batch project's asset pool pointer.",
        );
      }
      const latestReferences = await this.#loadLatestCatalogReferences(project, session);
      return refreshProjectAssetPool(
        current,
        project,
        latestReferences,
        this.#mutationContext(session, this.now()),
      );
    });
  }

  async getCurrentPool(
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ProjectAssetPool> {
    return this.coordinator.runExclusive(project.id, () =>
      this.#getCurrentPoolUncoordinated(project, session),
    );
  }

  async addCatalogAssets(
    project: Readonly<BatchProject>,
    selectedReferences: readonly CompanyAssetReference[],
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ProjectAssetPool> {
    return this.coordinator.runExclusive(project.id, async () => {
      assertCanManageBatchProjectAssets(session, project);
      const normalized = await this.#normalizeSelectedReferences(
        selectedReferences,
        project,
        session,
      );
      return this.poolStore.transact(project.id, (current) => {
        if (current === undefined || current.id !== project.assetPoolId) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-POOL-NOT-FOUND",
            `Batch project '${project.id}' does not have its linked asset pool.`,
          );
        }
        const existing = new Set(current.assets.map((asset) =>
          asset.source === "company_catalog"
            ? referenceIdentity(asset)
            : `${asset.source}:${asset.batchProjectId}:${asset.assetId}`
        ));
        const additions = normalized.filter((asset) => !existing.has(referenceIdentity(asset)));
        if (additions.length === 0) return structuredClone(current);
        const assets = [...structuredClone(current.assets), ...structuredClone(additions)];
        assertProjectAssetPoolAssets(project, assets);
        const occurredAt = this.now();
        return {
          ...structuredClone(current),
          revision: current.revision + 1,
          assets,
          updatedAt: occurredAt,
          updatedBy: session.actorAccountId,
        };
      });
    });
  }

  async #assertTemporaryReferencesUsable(
    pool: Readonly<ProjectAssetPool>,
    project: Readonly<BatchProject>,
    occurredAt: string,
  ): Promise<void> {
    const references = pool.assets.filter((asset) => asset.source === "local_upload");
    if (references.length === 0) return;
    if (this.temporaryAssetStore === undefined) {
      throw new ProjectAssetRuntimeError(
        "AIC-ASSET-TEMPORARY-REFERENCE-UNUSABLE",
        "Temporary asset metadata is unavailable for snapshot validation.",
      );
    }
    const assets = await this.temporaryAssetStore.loadProject(project.id);
    const occurredAtTimestamp = Date.parse(occurredAt);
    for (const reference of references) {
      const asset = assets.find((candidate) => candidate.id === reference.assetId);
      const expiresAtTimestamp =
        asset?.expiresAt === undefined ? undefined : Date.parse(asset.expiresAt);
      if (
        asset === undefined ||
        !Number.isFinite(occurredAtTimestamp) ||
        asset.tenantId !== project.tenantId ||
        asset.batchProjectId !== project.id ||
        asset.vehicleId !== project.vehicleId ||
        asset.version !== reference.version ||
        asset.category !== reference.category ||
        asset.checksumSha256.toLowerCase() !== reference.checksumSha256.toLowerCase() ||
        asset.validationStatus !== "valid" ||
        !asset.rightsConfirmed ||
        asset.validationIssues.length > 0 ||
        (expiresAtTimestamp !== undefined &&
          (!Number.isFinite(expiresAtTimestamp) || expiresAtTimestamp <= occurredAtTimestamp))
      ) {
        throw new ProjectAssetRuntimeError(
          "AIC-ASSET-TEMPORARY-REFERENCE-UNUSABLE",
          "A project-local asset is invalid, expired, or no longer matches its pool reference.",
        );
      }
    }
  }

  async lockTaskSnapshot(
    videoTaskId: string,
    expectedTaskRevision: number,
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
    selectedAssets?: readonly AssetReference[],
  ): Promise<VideoTaskProductionRecord> {
    return this.coordinator.runExclusive(project.id, async () => {
      const pool = await this.#getCurrentPoolUncoordinated(project, session);
      const occurredAt = this.now();
      await this.#assertTemporaryReferencesUsable(pool, project, occurredAt);
      return this.videoTaskStore.transact(videoTaskId, (current) => {
        if (current === undefined) {
          throw new ProjectAssetRuntimeError(
            "AIC-VIDEO-TASK-NOT-FOUND",
            `Video task '${videoTaskId}' was not found.`,
          );
        }
        assertCanOperateVideoTask(session, project, current.videoTask);
        return lockVideoTaskAssetSnapshot(
          current,
          project,
          pool,
          expectedTaskRevision,
          this.#mutationContext(session, occurredAt),
          selectedAssets,
        );
      });
    });
  }
}
