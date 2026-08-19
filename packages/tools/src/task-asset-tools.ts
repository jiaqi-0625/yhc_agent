import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { VideoTaskProductionRecord } from "@firefly/domain";
import type { TaskContext, TemporaryAssetReference } from "@firefly/schemas";
import { Type } from "typebox";

import type {
  CompanyAssetCatalogItem,
  CompanyAssetProvider,
  CompanyAssetProviderScope,
  CompanyAssetReference,
} from "./company-asset-provider.ts";

const GetTaskAssetSnapshotRequestSchema = Type.Object({}, { additionalProperties: false });

export interface ReadonlyTaskAssetSnapshotView {
  readonly schemaVersion: 1;
  readonly kind: "task_asset_snapshot_view";
  readonly videoTaskId: string;
  readonly snapshot: {
    readonly id: string;
    readonly version: number;
    readonly vehicleSnapshotId: string;
    readonly sourceProjectAssetPoolRevision: number;
    readonly createdAt: string;
  };
  readonly companyAssets: readonly CompanyAssetCatalogItem[];
  readonly localAssets: readonly TemporaryAssetReference[];
  readonly sourceRiskSummary: {
    readonly requiresAttention: boolean;
    readonly warningCount: number;
  };
  readonly sourceAssessments: readonly TaskAssetSourceAssessment[];
}

export interface TaskAssetSourceAssessment {
  readonly assetId: string;
  readonly version: number;
  readonly category: CompanyAssetReference["category"] | TemporaryAssetReference["category"];
  readonly source: CompanyAssetReference["source"] | TemporaryAssetReference["source"];
  readonly status: "verified" | "requires_manual_review";
  readonly riskLevel: "none" | "warning";
  readonly summary: string;
}

export interface TaskAssetSnapshotReader {
  readonly videoTaskId: string;
  readonly assetSnapshotId: string;
  read(signal?: AbortSignal): Promise<ReadonlyTaskAssetSnapshotView>;
}

export interface TaskAssetSnapshotStore {
  load(videoTaskId: string): Promise<VideoTaskProductionRecord | undefined>;
}

export interface CreateScopedTaskAssetSnapshotReaderOptions {
  readonly taskContext: TaskContext;
  readonly store: TaskAssetSnapshotStore;
  readonly provider: CompanyAssetProvider;
  readonly providerScope: CompanyAssetProviderScope;
}

export class TaskAssetSnapshotAccessError extends Error {
  readonly code = "AIC-ASSET-TASK_SNAPSHOT_ACCESS_DENIED";

  constructor(message = "The task asset snapshot is unavailable in the server-resolved scope.") {
    super(message);
    this.name = "TaskAssetSnapshotAccessError";
  }
}

function exactReferenceIdentity(reference: Readonly<CompanyAssetReference>): string {
  return `${reference.sourceProvider}:${reference.assetId}:${reference.version}:${reference.category}:${
    reference.category === "vehicle" ? reference.vehicleId : "reusable"
  }`;
}

function assertReaderScope(options: Readonly<CreateScopedTaskAssetSnapshotReaderOptions>): string {
  const snapshotId = options.taskContext.videoTask.assetSnapshotId;
  if (
    snapshotId === undefined ||
    !options.providerScope.allowedBrandIds.includes(options.taskContext.brand.id) ||
    !options.providerScope.allowedVehicleIds.includes(options.taskContext.vehicle.id)
  ) {
    throw new TaskAssetSnapshotAccessError();
  }
  return snapshotId;
}

export function createScopedTaskAssetSnapshotReader(
  options: Readonly<CreateScopedTaskAssetSnapshotReaderOptions>,
): TaskAssetSnapshotReader {
  const videoTaskId = options.taskContext.videoTask.id;
  const assetSnapshotId = assertReaderScope(options);
  return {
    videoTaskId,
    assetSnapshotId,
    async read(signal?: AbortSignal): Promise<ReadonlyTaskAssetSnapshotView> {
      const record = await options.store.load(videoTaskId);
      if (
        record === undefined ||
        record.videoTask.id !== videoTaskId ||
        record.videoTask.tenantId !== options.providerScope.tenantId ||
        record.videoTask.batchProjectId !== options.taskContext.batchProject.id ||
        record.videoTask.assetSnapshotId !== assetSnapshotId
      ) {
        throw new TaskAssetSnapshotAccessError();
      }
      const snapshot = record.taskAssetSnapshots.find((candidate) => candidate.id === assetSnapshotId);
      if (
        snapshot === undefined ||
        snapshot.tenantId !== record.videoTask.tenantId ||
        snapshot.batchProjectId !== record.videoTask.batchProjectId ||
        snapshot.videoTaskId !== videoTaskId ||
        snapshot.vehicleSnapshotId !== record.videoTask.vehicleSnapshotId
      ) {
        throw new TaskAssetSnapshotAccessError();
      }

      const companyReferences = snapshot.assets.filter(
        (asset): asset is CompanyAssetReference => asset.source === "company_catalog",
      );
      if (
        companyReferences.some((reference) =>
          reference.sourceProvider !== options.provider.providerId ||
          (reference.category === "vehicle" && reference.vehicleId !== options.taskContext.vehicle.id)
        ) ||
        !companyReferences.some((reference) =>
          reference.category === "vehicle" && reference.vehicleId === options.taskContext.vehicle.id)
      ) {
        throw new TaskAssetSnapshotAccessError();
      }
      const resolved = await options.provider.resolveAssets(
        companyReferences,
        options.providerScope,
        signal === undefined ? undefined : { signal },
      );
      if (resolved.missingReferences.length > 0) throw new TaskAssetSnapshotAccessError();
      const resolvedByReference = new Map(
        resolved.items.map((item) => [exactReferenceIdentity(item.reference), item] as const),
      );
      const companyAssets = companyReferences.map((reference) => {
        const item = resolvedByReference.get(exactReferenceIdentity(reference));
        if (
          item === undefined ||
          (item.brandIds.length > 0 && !item.brandIds.includes(options.taskContext.brand.id))
        ) {
          throw new TaskAssetSnapshotAccessError();
        }
        return structuredClone(item);
      });
      const localAssets = snapshot.assets
        .filter((asset): asset is TemporaryAssetReference => asset.source === "local_upload")
        .map((asset) => {
          if (asset.batchProjectId !== options.taskContext.batchProject.id) {
            throw new TaskAssetSnapshotAccessError();
          }
          return structuredClone(asset);
        });
      const sourceAssessments: TaskAssetSourceAssessment[] = [
        ...companyAssets.map((item) => ({
          assetId: item.reference.assetId,
          version: item.reference.version,
          category: item.reference.category,
          source: item.reference.source,
          status: "verified" as const,
          riskLevel: "none" as const,
          summary: "公司素材已在当前任务授权范围内按锁定版本精确解析。",
        })),
        ...localAssets.map((reference) => ({
          assetId: reference.assetId,
          version: reference.version,
          category: reference.category,
          source: reference.source,
          status: "requires_manual_review" as const,
          riskLevel: "warning" as const,
          summary: "任务快照仅保留项目范围引用和校验和；制作前需人工复核原始来源说明与使用权声明。",
        })),
      ];
      const warningCount = sourceAssessments.filter((assessment) => assessment.riskLevel === "warning").length;

      return {
        schemaVersion: 1,
        kind: "task_asset_snapshot_view",
        videoTaskId,
        snapshot: {
          id: snapshot.id,
          version: snapshot.version,
          vehicleSnapshotId: snapshot.vehicleSnapshotId,
          sourceProjectAssetPoolRevision: snapshot.sourceProjectAssetPoolRevision,
          createdAt: snapshot.createdAt,
        },
        companyAssets,
        localAssets,
        sourceRiskSummary: {
          requiresAttention: warningCount > 0,
          warningCount,
        },
        sourceAssessments,
      };
    },
  };
}

export function createTaskAssetTools(reader: TaskAssetSnapshotReader): readonly AgentTool[] {
  const getTaskAssetSnapshot: AgentTool<typeof GetTaskAssetSnapshotRequestSchema> = {
    name: "get_task_asset_snapshot",
    label: "读取任务素材快照",
    description: "读取服务端绑定任务在策略开始时锁定的素材快照、精确版本公司素材与逐项来源风险；本地上传必须提示人工复核来源和使用权，不查询项目最新素材池。",
    parameters: GetTaskAssetSnapshotRequestSchema,
    async execute(_toolCallId, _params, signal) {
      const details = await reader.read(signal);
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
  return [getTaskAssetSnapshot];
}
