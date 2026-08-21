import type {
  CompanyAssetReference,
  ProjectAssetPool,
  Role,
  TaskContext,
  TemporaryAsset,
  TemporaryAssetReference,
} from "@firefly/schemas";
import {
  StageSuggestionContextAccessError,
  type AssetMatchingCandidateReader,
  type AssetMatchingCandidateSet,
  type CompanyAssetCatalogItem,
  type CompanyAssetProvider,
  type CompanyAssetProviderScope,
} from "@firefly/tools";

import type { BatchProjectStore } from "./batch-project-store.ts";
import type { ProjectAssetRuntime } from "./project-asset-runtime.ts";
import type { TemporaryAssetStore } from "./temporary-asset-store.ts";
import type { WorkspaceAdminStore } from "./workspace-admin-store.ts";

export interface CurrentProjectAssetPoolReader {
  readonly batchProjectId: string;
  read(signal?: AbortSignal): Promise<ProjectAssetPool>;
}

export interface CreateCurrentProjectAssetPoolReaderOptions {
  readonly taskContext: TaskContext;
  readonly administration: Pick<WorkspaceAdminStore, "withSnapshot">;
  readonly projects: Pick<BatchProjectStore, "load">;
  readonly projectAssets: Pick<ProjectAssetRuntime, "getCurrentPool">;
  readonly actor: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly role: Role | undefined;
  };
}

export interface CreateAgentAssetMatchingCandidateReaderOptions {
  readonly taskContext: TaskContext;
  readonly currentProjectAssetPool: CurrentProjectAssetPoolReader;
  readonly temporaryAssets: TemporaryAssetStore;
  readonly companyAssets: CompanyAssetProvider;
  readonly companyAssetScope: CompanyAssetProviderScope;
  readonly now?: () => string;
}

function companyIdentity(reference: Readonly<CompanyAssetReference>): string {
  return `${reference.sourceProvider}:${reference.assetId}:${reference.version}:${reference.category}:` +
    `${reference.category === "vehicle" ? reference.vehicleId : "reusable"}`;
}

function temporaryIdentity(reference: Readonly<TemporaryAssetReference>): string {
  return `${reference.batchProjectId}:${reference.assetId}:${reference.version}:${reference.category}:` +
    reference.checksumSha256.toLowerCase();
}

function temporaryAssetIdentity(asset: Readonly<TemporaryAsset>): string {
  return `${asset.batchProjectId}:${asset.id}:${asset.version}:${asset.category}:` +
    asset.checksumSha256.toLowerCase();
}

function unavailable(message: string): StageSuggestionContextAccessError {
  return new StageSuggestionContextAccessError(message);
}

function isExpired(expiresAt: string | undefined, now: string): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(now);
}

export function createCurrentProjectAssetPoolReader(
  options: Readonly<CreateCurrentProjectAssetPoolReaderOptions>,
): CurrentProjectAssetPoolReader {
  const batchProjectId = options.taskContext.batchProject.id;
  const actorRole = options.actor.role;
  if (
    options.actor.tenantId.length === 0 ||
    options.actor.accountId.length === 0 ||
    actorRole === undefined
  ) {
    throw unavailable("The authenticated Agent project scope is unavailable.");
  }
  return {
    batchProjectId,
    async read(signal?: AbortSignal): Promise<ProjectAssetPool> {
      signal?.throwIfAborted();
      return options.administration.withSnapshot(options.actor.tenantId, async (state) => {
        signal?.throwIfAborted();
        const aggregate = await options.projects.load(options.actor.tenantId, batchProjectId);
        if (
          aggregate === undefined ||
          aggregate.project.tenantId !== options.actor.tenantId ||
          aggregate.project.brandId !== options.taskContext.brand.id ||
          aggregate.project.vehicleId !== options.taskContext.vehicle.id ||
          aggregate.project.vehicleVersion !== options.taskContext.vehicle.version ||
          aggregate.project.aspectRatio !== options.taskContext.batchProject.aspectRatio
        ) {
          throw unavailable("The current Agent project no longer matches its authenticated task scope.");
        }
        const pool = await options.projectAssets.getCurrentPool(aggregate.project, {
          tenantId: options.actor.tenantId,
          actorAccountId: options.actor.accountId,
          role: actorRole,
          accessGrants: state.accessGrants.filter(
            (grant) => grant.accountId === options.actor.accountId,
          ),
        });
        signal?.throwIfAborted();
        return pool;
      });
    },
  };
}

export function createAgentAssetMatchingCandidateReader(
  options: Readonly<CreateAgentAssetMatchingCandidateReaderOptions>,
): AssetMatchingCandidateReader {
  const batchProjectId = options.taskContext.batchProject.id;
  if (
    options.currentProjectAssetPool.batchProjectId !== batchProjectId ||
    options.companyAssetScope.tenantId.length === 0 ||
    options.companyAssetScope.actorAccountId.length === 0 ||
    !options.companyAssetScope.allowedBrandIds.includes(options.taskContext.brand.id) ||
    !options.companyAssetScope.allowedVehicleIds.includes(options.taskContext.vehicle.id)
  ) {
    throw unavailable("The project asset candidates are outside the server-resolved Agent scope.");
  }

  return {
    batchProjectId,
    async read(signal?: AbortSignal): Promise<AssetMatchingCandidateSet> {
      signal?.throwIfAborted();
      const [pool, projectTemporaryAssets] = await Promise.all([
        options.currentProjectAssetPool.read(signal),
        options.temporaryAssets.loadProject(batchProjectId),
      ]);
      signal?.throwIfAborted();
      if (
        pool.tenantId !== options.companyAssetScope.tenantId ||
        pool.batchProjectId !== batchProjectId ||
        pool.vehicleId !== options.taskContext.vehicle.id
      ) {
        throw unavailable("The current project asset pool is unavailable for Agent matching.");
      }

      const companyReferences = pool.assets.filter(
        (reference): reference is CompanyAssetReference =>
          reference.source === "company_catalog" &&
          (reference.category === "vehicle" ||
            reference.category === "person" ||
            reference.category === "scene"),
      );
      if (companyReferences.some(
        (reference) => reference.sourceProvider !== options.companyAssets.providerId,
      )) {
        throw unavailable("A project asset candidate belongs to an unavailable company provider.");
      }
      const resolved = await options.companyAssets.resolveAssets(
        companyReferences,
        options.companyAssetScope,
        signal === undefined ? undefined : { signal },
      );
      signal?.throwIfAborted();
      const expectedCompanyIdentities = new Set(companyReferences.map(companyIdentity));
      const resolvedByIdentity = new Map<string, CompanyAssetCatalogItem>();
      for (const item of resolved.items) {
        const identity = companyIdentity(item.reference);
        if (
          !expectedCompanyIdentities.has(identity) ||
          resolvedByIdentity.has(identity) ||
          typeof item.description !== "string" ||
          item.description.trim().length === 0
        ) {
          throw unavailable("The company provider returned an unexpected project asset candidate.");
        }
        resolvedByIdentity.set(identity, structuredClone(item));
      }
      if (
        resolved.missingReferences.length > 0 ||
        resolvedByIdentity.size !== expectedCompanyIdentities.size
      ) {
        throw unavailable("A project company asset version can no longer be resolved exactly.");
      }

      const localReferences = pool.assets.filter(
        (reference): reference is TemporaryAssetReference =>
          reference.source === "local_upload" &&
          (reference.category === "person" || reference.category === "scene"),
      );
      const temporaryByIdentity = new Map(
        projectTemporaryAssets.map((asset) => [temporaryAssetIdentity(asset), asset] as const),
      );
      const now = (options.now ?? (() => new Date().toISOString()))();
      const localCandidates = localReferences.map((reference) => {
        const asset = temporaryByIdentity.get(temporaryIdentity(reference));
        if (
          asset === undefined ||
          asset.tenantId !== pool.tenantId ||
          asset.batchProjectId !== batchProjectId ||
          asset.vehicleId !== pool.vehicleId ||
          asset.validationStatus !== "valid" ||
          !asset.rightsConfirmed ||
          asset.validationIssues.length > 0 ||
          asset.sourceDescription.trim().length === 0 ||
          isExpired(asset.expiresAt, now)
        ) {
          throw unavailable("A project-local asset candidate is no longer valid for matching.");
        }
        return {
          reference: structuredClone(reference),
          displayName: asset.fileName,
          description: asset.sourceDescription,
          sourceStatus: "requires_manual_review" as const,
        };
      });

      return {
        projectAssetPoolRevision: pool.revision,
        companyCandidates: companyReferences.map((reference) =>
          structuredClone(resolvedByIdentity.get(companyIdentity(reference))!)
        ),
        localCandidates,
      };
    },
  };
}
