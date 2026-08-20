import {
  assertCanViewBatchProject,
  assertCanViewVideoTask,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  AssetReference,
  BatchProject,
  TemporaryAsset,
  VideoTask,
} from "@firefly/schemas";
import type {
  CompanyAssetCatalogItem,
  CompanyAssetProvider,
  CompanyAssetProviderScope,
} from "@firefly/tools";

import type { BatchProjectAggregate, BatchProjectStore } from "./batch-project-store.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import type { ProjectAssetRuntime } from "./project-asset-runtime.ts";
import type {
  TemporaryAssetDeclaration,
  TemporaryAssetRuntime,
  TrustedTemporaryAssetInspection,
} from "./temporary-asset-runtime.ts";
import type { VideoTaskProductionStore } from "./video-task-store.ts";
import type { WorkspaceAdminState, WorkspaceAdminStore } from "./workspace-admin-store.ts";

export interface AssetMatchingView {
  project: Pick<BatchProject, "id" | "brandId" | "vehicleId" | "name" | "aspectRatio">;
  videoTask: Pick<
    VideoTask,
    "id" | "name" | "status" | "currentStage" | "stageStatus" | "revision" | "assetSnapshotId"
  >;
  matchingReady: boolean;
  matchingLocked: boolean;
  gateMessage: string;
  poolRevision: number;
  companyAssets: Array<CompanyAssetCatalogItem & {
    selected: boolean;
    recommended: boolean;
    replacementAllowed: boolean;
    recommendationReason?: string;
  }>;
  temporaryAssets: Array<TemporaryAsset & { selected: boolean; recommended: boolean }>;
  selectedAssets: AssetReference[];
}

function runtimeError(code: string, message: string, statusCode: number): BusinessRuntimeError {
  return new BusinessRuntimeError(code, message, statusCode);
}

function exactIdentity(reference: Readonly<AssetReference>): string {
  return reference.source === "company_catalog"
    ? `${reference.source}:${reference.sourceProvider}:${reference.assetId}:${reference.version}:${reference.category}`
    : `${reference.source}:${reference.batchProjectId}:${reference.assetId}:${reference.version}:${reference.category}`;
}

function currentScope(
  session: Readonly<WorkspaceSessionScope>,
  state: Readonly<WorkspaceAdminState>,
): WorkspaceSessionScope {
  return {
    actorAccountId: session.actorAccountId,
    tenantId: session.tenantId,
    role: session.role,
    accessGrants: state.accessGrants.filter((grant) => grant.accountId === session.actorAccountId),
  };
}

export class AssetMatchingRuntime {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskProductionStore,
    private readonly companyAssets: CompanyAssetProvider,
    private readonly projectAssets: ProjectAssetRuntime,
    private readonly temporaryAssets: TemporaryAssetRuntime,
  ) {}

  async #scopeAndProject(
    projectId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<{ scope: WorkspaceSessionScope; aggregate: BatchProjectAggregate }> {
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = currentScope(session, state);
      const aggregate = await this.projects.load(scope.tenantId, projectId);
      if (!aggregate) {
        throw runtimeError("AIC-ASSET-MATCHING-PROJECT_NOT_FOUND", "项目不存在。", 404);
      }
      assertCanViewBatchProject(scope, aggregate.project);
      return { scope, aggregate };
    });
  }

  #providerScope(project: Readonly<BatchProject>, scope: Readonly<WorkspaceSessionScope>): CompanyAssetProviderScope {
    return {
      tenantId: scope.tenantId,
      actorAccountId: scope.actorAccountId,
      allowedBrandIds: [project.brandId],
      allowedVehicleIds: [project.vehicleId],
    };
  }

  async getView(
    projectId: string,
    videoTaskId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<AssetMatchingView> {
    const { scope, aggregate } = await this.#scopeAndProject(projectId, session);
    const record = await this.tasks.load(videoTaskId);
    if (!record || record.videoTask.batchProjectId !== projectId) {
      throw runtimeError("AIC-ASSET-MATCHING-TASK_NOT_FOUND", "视频任务不存在。", 404);
    }
    assertCanViewVideoTask(scope, aggregate.project, record.videoTask);
    const [pool, temporary, catalogCandidates] = await Promise.all([
      this.projectAssets.getCurrentPool(aggregate.project, scope),
      this.temporaryAssets.listTemporaryAssets(aggregate.project, scope),
      this.companyAssets.searchAssets(
        {
          categories: ["person", "scene"],
          brandId: aggregate.project.brandId,
          vehicleId: aggregate.project.vehicleId,
          limit: 100,
        },
        this.#providerScope(aggregate.project, scope),
      ),
    ]);
    const companyReferences = pool.assets.filter(
      (asset) => asset.source === "company_catalog",
    );
    const resolved = await this.companyAssets.resolveAssets(
      companyReferences,
      this.#providerScope(aggregate.project, scope),
    );
    if (resolved.missingReferences.length > 0 || resolved.items.length !== companyReferences.length) {
      throw runtimeError(
        "AIC-ASSET-MATCHING-CATALOG_UNAVAILABLE",
        "部分公司素材当前不可用，请刷新后重试。",
        409,
      );
    }
    const catalogItems = new Map(
      [...resolved.items, ...catalogCandidates.items].map((item) =>
        [exactIdentity(item.reference), structuredClone(item)] as const
      ),
    );
    const snapshot = record.videoTask.assetSnapshotId === undefined
      ? undefined
      : record.taskAssetSnapshots.find((item) => item.id === record.videoTask.assetSnapshotId);
    const matchingReady = record.videoTask.status === "active" &&
      record.videoTask.currentStage === "asset_matching" &&
      record.videoTask.stageStatus === "in_progress" &&
      record.videoTask.ownerAccountId === scope.actorAccountId;
    const agentRecommendations = matchingReady ? [
      ...pool.assets.filter((asset) => asset.category === "vehicle"),
      ...["person", "scene"].flatMap((category) =>
        [...catalogItems.values()]
          .filter((item) => item.reference.category === category)
          .slice(0, 1)
          .map((item) => item.reference)
      ),
    ] : [];
    const recommendedAssets = snapshot?.assets ?? agentRecommendations;
    const selectedAssets = snapshot?.assets ?? (matchingReady
      ? recommendedAssets
      : pool.assets.filter((asset) => asset.category === "vehicle"));
    const selected = new Set(selectedAssets.map(exactIdentity));
    const recommended = new Set(recommendedAssets.map(exactIdentity));
    const gateMessage = snapshot
      ? "素材版本已锁定，Agent 不会覆盖人工结果。"
      : matchingReady
        ? "已根据确认的策略、脚本和素材描述词生成推荐。"
        : record.videoTask.currentStage === "strategy" || record.videoTask.currentStage === "script"
          ? "确认策略和脚本后，Agent 才会开始选材。"
          : "当前任务不在资产匹配阶段。";

    return {
      project: {
        id: aggregate.project.id,
        brandId: aggregate.project.brandId,
        vehicleId: aggregate.project.vehicleId,
        name: aggregate.project.name,
        aspectRatio: aggregate.project.aspectRatio,
      },
      videoTask: {
        id: record.videoTask.id,
        name: record.videoTask.name,
        status: record.videoTask.status,
        currentStage: record.videoTask.currentStage,
        stageStatus: record.videoTask.stageStatus,
        revision: record.videoTask.revision,
        ...(record.videoTask.assetSnapshotId === undefined
          ? {}
          : { assetSnapshotId: record.videoTask.assetSnapshotId }),
      },
      matchingReady,
      matchingLocked: snapshot !== undefined,
      gateMessage,
      poolRevision: pool.revision,
      companyAssets: [...catalogItems.values()]
        .filter((item) => item.reference.category !== "visual_style")
        .map((item) => ({
        ...structuredClone(item),
        selected: selected.has(exactIdentity(item.reference)),
        recommended: recommended.has(exactIdentity(item.reference)),
        replacementAllowed: item.reference.category !== "vehicle",
        ...(recommended.has(exactIdentity(item.reference))
          ? {
              recommendationReason: item.description
                ? `匹配素材描述：${item.description}`
                : "匹配已确认脚本的画面需要。",
            }
          : {}),
        })),
      temporaryAssets: temporary.map((asset) => {
        const reference: AssetReference = {
          assetId: asset.id,
          version: asset.version,
          category: asset.category,
          source: "local_upload",
          batchProjectId: asset.batchProjectId,
          checksumSha256: asset.checksumSha256,
        };
        return {
          ...structuredClone(asset),
          selected: selected.has(exactIdentity(reference)),
          recommended: recommended.has(exactIdentity(reference)),
        };
      }),
      selectedAssets: structuredClone(selectedAssets),
    };
  }

  async lockSelection(
    projectId: string,
    videoTaskId: string,
    expectedTaskRevision: number,
    selectedAssets: readonly AssetReference[],
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<AssetMatchingView> {
    const { scope, aggregate } = await this.#scopeAndProject(projectId, session);
    const selectedCompanyAssets = selectedAssets.filter(
      (asset) => asset.source === "company_catalog",
    );
    await this.projectAssets.addCatalogAssets(
      aggregate.project,
      selectedCompanyAssets,
      scope,
    );
    await this.projectAssets.lockTaskSnapshot(
      videoTaskId,
      expectedTaskRevision,
      aggregate.project,
      scope,
      selectedAssets,
    );
    return this.getView(projectId, videoTaskId, session);
  }

  async uploadTemporary(
    projectId: string,
    inspection: Readonly<TrustedTemporaryAssetInspection>,
    declaration: Readonly<TemporaryAssetDeclaration>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<TemporaryAsset> {
    const { scope, aggregate } = await this.#scopeAndProject(projectId, session);
    const registered = await this.temporaryAssets.registerTemporaryAsset(
      aggregate.project,
      inspection,
      declaration,
      scope,
    );
    const validated = await this.temporaryAssets.validateTemporaryAsset(
      aggregate.project,
      registered.id,
      registered.revision,
      scope,
    );
    if (validated.validationStatus !== "valid") return validated;
    const pool = await this.projectAssets.getCurrentPool(aggregate.project, scope);
    await this.temporaryAssets.addToProjectPool(
      aggregate.project,
      validated.id,
      validated.revision,
      pool.revision,
      scope,
    );
    return validated;
  }
}
