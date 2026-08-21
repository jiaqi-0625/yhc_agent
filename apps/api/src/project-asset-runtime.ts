import {
  assertCanViewBatchProject,
  assertProjectAssetPoolAssets,
  createProjectAssetPool,
  refreshProjectAssetPool,
  type AssetPoolMutationContext,
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

export type ProjectAssetRuntimeErrorCode =
  | "AIC-ASSET-POOL-ALREADY-EXISTS"
  | "AIC-ASSET-POOL-NOT-FOUND"
  | "AIC-ASSET-POOL-PROJECT-LINK-INVALID"
  | "AIC-ASSET-POOL-CATALOG-REFERENCE-UNAVAILABLE"
  | "AIC-ASSET-SELECTION-INVALID"
  | "AIC-ASSET-SELECTION-REVISION-CONFLICT"
  | "AIC-ASSET-TEMPORARY-REFERENCE-UNUSABLE";

export class ProjectAssetRuntimeError extends Error {
  constructor(
    readonly code: ProjectAssetRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectAssetRuntimeError";
  }
}

function referenceIdentity(reference: Readonly<CompanyAssetReference>): string {
  return `${reference.sourceProvider}:${reference.assetId}`;
}

function exactReferenceIdentity(reference: Readonly<CompanyAssetReference>): string {
  return `${referenceIdentity(reference)}:${reference.version}:${reference.category}:${
    reference.category === "vehicle" ? reference.vehicleId : "reusable"
  }`;
}

function exactAssetReferenceIdentity(reference: Readonly<AssetReference>): string {
  if (reference.source === "company_catalog") return exactReferenceIdentity(reference);
  return `${reference.source}:${reference.batchProjectId}:${reference.assetId}:${reference.version}:` +
    `${reference.category}:${reference.checksumSha256.toLowerCase()}`;
}

export type TaskAssetSelectionResolver = () => Promise<ProjectAssetPool>;
export type TaskAssetSelectionResolverFactory = (
  project: Readonly<BatchProject>,
  expectedProjectAssetPoolRevision: number,
  selectedAssets: readonly AssetReference[],
  session: Readonly<WorkspaceSessionScope>,
) => TaskAssetSelectionResolver;

export class ProjectAssetRuntime {
  constructor(
    private readonly provider: CompanyAssetProvider,
    private readonly poolStore: ProjectAssetPoolStore,
    private readonly now: () => string = () => new Date().toISOString(),
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
        throw new Error(`Asset pool mutation cannot create '${kind}' in this runtime.`);
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
  ): Promise<{
    pool: ProjectAssetPool;
    latestCatalogReferences: CompanyAssetReference[];
  }> {
    this.#providerScope(project, session);
    let latestCatalogReferences: CompanyAssetReference[] | undefined;
    const pool = await this.poolStore.transact(project.id, async (current) => {
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
      latestCatalogReferences = latestReferences;
      return refreshProjectAssetPool(
        current,
        project,
        latestReferences,
        this.#mutationContext(session, this.now()),
      );
    });
    if (latestCatalogReferences === undefined) {
      throw new Error("The project asset catalog refresh did not resolve current references.");
    }
    return { pool, latestCatalogReferences };
  }

  async getCurrentPool(
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ProjectAssetPool> {
    return this.coordinator.runExclusive(project.id, async () =>
      (await this.#getCurrentPoolUncoordinated(project, session)).pool,
    );
  }

  async #includeCurrentCatalogSelections(
    project: Readonly<BatchProject>,
    pool: Readonly<ProjectAssetPool>,
    selectedAssets: readonly AssetReference[],
    latestCatalogReferences: readonly CompanyAssetReference[],
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ProjectAssetPool> {
    const poolIdentities = new Set(pool.assets.map(exactAssetReferenceIdentity));
    const additions = selectedAssets.filter(
      (asset): asset is CompanyAssetReference =>
        !poolIdentities.has(exactAssetReferenceIdentity(asset)) &&
        asset.source === "company_catalog",
    );
    const hasMissingLocalSelection = selectedAssets.some(
      (asset) =>
        !poolIdentities.has(exactAssetReferenceIdentity(asset)) &&
        asset.source === "local_upload",
    );
    const latestCatalogIdentities = new Set(
      latestCatalogReferences.map(exactReferenceIdentity),
    );
    if (
      hasMissingLocalSelection ||
      additions.some((asset) => !latestCatalogIdentities.has(exactReferenceIdentity(asset)))
    ) {
      throw new ProjectAssetRuntimeError(
        "AIC-ASSET-SELECTION-INVALID",
        "Every selected asset must exactly match the current project pool or current visible company catalog.",
      );
    }
    if (additions.length === 0) return structuredClone(pool);

    return this.poolStore.transact(project.id, (current) => {
      if (current === undefined || current.id !== project.assetPoolId) {
        throw new ProjectAssetRuntimeError(
          "AIC-ASSET-POOL-NOT-FOUND",
          `Batch project '${project.id}' does not have its linked asset pool.`,
        );
      }
      if (current.revision !== pool.revision) {
        throw new ProjectAssetRuntimeError(
          "AIC-ASSET-SELECTION-REVISION-CONFLICT",
          "The project asset pool changed while the task selection was being confirmed.",
        );
      }
      const assets = [...structuredClone(current.assets), ...structuredClone(additions)];
      try {
        assertProjectAssetPoolAssets(project, assets);
      } catch (error: unknown) {
        throw new ProjectAssetRuntimeError(
          "AIC-ASSET-SELECTION-INVALID",
          error instanceof Error ? error.message : "The selected task assets are invalid.",
        );
      }
      const occurredAt = this.now();
      return {
        ...structuredClone(current),
        revision: current.revision + 1,
        assets,
        updatedAt: occurredAt,
        updatedBy: session.actorAccountId,
      };
    });
  }

  #createTaskAssetSelectionResolver(
    project: Readonly<BatchProject>,
    expectedProjectAssetPoolRevision: number,
    selectedAssets: readonly AssetReference[],
    session: Readonly<WorkspaceSessionScope>,
  ): TaskAssetSelectionResolver {
    let resolved: ProjectAssetPool | undefined;
    return async (): Promise<ProjectAssetPool> => {
        if (resolved !== undefined) return structuredClone(resolved);
        const { pool, latestCatalogReferences } =
          await this.#getCurrentPoolUncoordinated(project, session);
        if (pool.revision !== expectedProjectAssetPoolRevision) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-SELECTION-REVISION-CONFLICT",
            "The project asset pool changed after this task selection was prepared.",
          );
        }
        if (
          selectedAssets.some(
            (asset) =>
              asset.category !== "vehicle" &&
              asset.category !== "person" &&
              asset.category !== "scene",
          )
        ) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-SELECTION-INVALID",
            "Task selection may only contain the server-recommended vehicle assets and the human-selected person or scene assets; visual style is server-locked.",
          );
        }
        const selectedIdentities = selectedAssets.map(exactAssetReferenceIdentity).sort((left, right) =>
          left.localeCompare(right, "en")
        );
        if (new Set(selectedIdentities).size !== selectedIdentities.length) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-SELECTION-INVALID",
            "Task selection cannot contain duplicate exact asset references.",
          );
        }
        const selectionPool = await this.#includeCurrentCatalogSelections(
          project,
          pool,
          selectedAssets,
          latestCatalogReferences,
          session,
        );
        const currentByIdentity = new Map(
          selectionPool.assets.map((asset) => [exactAssetReferenceIdentity(asset), asset] as const),
        );
        const hasExplicitVehicleSelection = selectedAssets.some(
          (asset) => asset.category === "vehicle",
        );
        const fixedAssets = selectionPool.assets
          .filter(
            (asset) =>
              (asset.category === "visual_style" && asset.assetId === project.visualStylePresetId) ||
              (!hasExplicitVehicleSelection && asset.category === "vehicle"),
          )
          .sort((left, right) => exactAssetReferenceIdentity(left).localeCompare(
            exactAssetReferenceIdentity(right),
            "en",
          ));
        if (!fixedAssets.some(
          (asset) =>
            asset.category === "visual_style" &&
            asset.assetId === project.visualStylePresetId,
        )) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-SELECTION-INVALID",
            "The current project visual style is unavailable for the task snapshot.",
          );
        }
        const assets = [
          ...fixedAssets.map((asset) => structuredClone(asset)),
          ...selectedIdentities.map((identity) => structuredClone(currentByIdentity.get(identity)!)),
        ];
        const latestCatalogIdentities = new Set(
          latestCatalogReferences.map(exactReferenceIdentity),
        );
        if (assets.some(
          (asset) =>
            asset.source === "company_catalog" &&
            !latestCatalogIdentities.has(exactReferenceIdentity(asset)),
        )) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-SELECTION-INVALID",
            "Every company asset in the task snapshot must remain available at its exact current catalog version.",
          );
        }
        const selection: ProjectAssetPool = {
          ...structuredClone(selectionPool),
          assets,
        };
        try {
          assertProjectAssetPoolAssets(project, selection.assets);
        } catch (error: unknown) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-SELECTION-INVALID",
            error instanceof Error ? error.message : "The selected task assets are invalid.",
          );
        }
        await this.#assertTemporaryReferencesUsable(selection, project);
        resolved = selection;
        return structuredClone(selection);
    };
  }

  /**
   * Acquires the project coordinator before the caller enters any other
   * aggregate lock. The supplied factory keeps selection resolution lazy so an
   * idempotent task replay can return without consulting a newer pool.
   */
  async coordinateTaskAssetSelection<Result>(
    batchProjectId: string,
    operation: (
      createResolver: TaskAssetSelectionResolverFactory,
    ) => Result | Promise<Result>,
  ): Promise<Result> {
    return this.coordinator.runExclusive(batchProjectId, () =>
      operation((project, expectedRevision, selectedAssets, session) => {
        if (project.id !== batchProjectId) {
          throw new ProjectAssetRuntimeError(
            "AIC-ASSET-SELECTION-INVALID",
            "The coordinated task selection belongs to a different batch project.",
          );
        }
        return this.#createTaskAssetSelectionResolver(
          project,
          expectedRevision,
          selectedAssets,
          session,
        );
      }),
    );
  }

  async withTaskAssetSelection<Result>(
    project: Readonly<BatchProject>,
    expectedProjectAssetPoolRevision: number,
    selectedAssets: readonly AssetReference[],
    session: Readonly<WorkspaceSessionScope>,
    operation: (resolveSelection: TaskAssetSelectionResolver) => Result | Promise<Result>,
  ): Promise<Result> {
    return this.coordinateTaskAssetSelection(project.id, (createResolver) =>
      operation(createResolver(
        project,
        expectedProjectAssetPoolRevision,
        selectedAssets,
        session,
      )),
    );
  }

  async #assertTemporaryReferencesUsable(
    pool: Readonly<ProjectAssetPool>,
    project: Readonly<BatchProject>,
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
    const validationTimestamp = Date.parse(this.now());
    for (const reference of references) {
      const asset = assets.find((candidate) => candidate.id === reference.assetId);
      const expiresAtTimestamp =
        asset?.expiresAt === undefined ? undefined : Date.parse(asset.expiresAt);
      if (
        asset === undefined ||
        !Number.isFinite(validationTimestamp) ||
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
          (!Number.isFinite(expiresAtTimestamp) || expiresAtTimestamp <= validationTimestamp))
      ) {
        throw new ProjectAssetRuntimeError(
          "AIC-ASSET-TEMPORARY-REFERENCE-UNUSABLE",
          "A project-local asset is invalid, expired, or no longer matches its pool reference.",
        );
      }
    }
  }

}
