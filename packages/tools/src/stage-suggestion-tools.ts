import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { VideoTaskProductionRecord } from "@firefly/domain";
import type {
  StageArtifactVersion,
  TaskContext,
  VideoTaskStage,
} from "@firefly/schemas";
import { Type } from "typebox";

import type {
  CompanyAssetCatalogItem,
  CompanyAssetProvider,
  CompanyAssetProviderScope,
} from "./company-asset-provider.ts";

const GetCurrentStageSuggestionContextRequestSchema = Type.Object({}, { additionalProperties: false });

const supportedStages = ["script", "asset_matching", "storyboard", "delivery"] as const;
type SupportedSuggestionStage = (typeof supportedStages)[number];

const requiredUpstreamStages: Readonly<Record<SupportedSuggestionStage, readonly VideoTaskStage[]>> = {
  script: ["strategy"],
  asset_matching: ["strategy", "script"],
  storyboard: ["strategy", "script", "asset_matching"],
  delivery: ["strategy", "script", "asset_matching", "storyboard", "video_preview"],
};

export interface StageSuggestionContextView {
  readonly schemaVersion: 1;
  readonly kind: "stage_suggestion_context";
  readonly videoTaskId: string;
  readonly taskRevision: number;
  readonly stage: SupportedSuggestionStage;
  readonly stageStatus: "in_progress" | "awaiting_confirmation";
  readonly productionBrief: TaskContext["productionBrief"];
  readonly confirmedUpstreamArtifacts: readonly StageArtifactVersion[];
  readonly assetMatchingContext?: {
    readonly companyCandidates: readonly CompanyAssetCatalogItem[];
    readonly selectionPolicy: {
      readonly vehicleAssetsLocked: true;
      readonly personSceneHumanReplaceable: true;
      readonly humanSelectionHasPriority: true;
      readonly preserveExactAssetVersions: true;
    };
  };
  readonly suggestionBoundary: {
    readonly suggestionOnly: true;
    readonly mayPersistArtifact: false;
    readonly mayConfirmStage: false;
    readonly mustPreserveConfirmedUpstream: true;
    readonly platformTagsAreMetadataOnly: true;
    readonly deliveryDoesNotPublishAds: true;
  };
  readonly stageGuidance: readonly string[];
}

export interface StageSuggestionContextReader {
  readonly videoTaskId: string;
  read(signal?: AbortSignal): Promise<StageSuggestionContextView>;
}

export interface StageSuggestionRecordStore {
  load(videoTaskId: string): Promise<VideoTaskProductionRecord | undefined>;
}

export interface CreateScopedStageSuggestionContextReaderOptions {
  readonly taskContext: TaskContext;
  readonly tenantId: string;
  readonly store: StageSuggestionRecordStore;
  readonly companyAssetProvider: CompanyAssetProvider;
  readonly companyAssetScope: CompanyAssetProviderScope;
}

export class StageSuggestionContextAccessError extends Error {
  readonly code = "AIC-STAGE-SUGGESTION-CONTEXT_UNAVAILABLE";

  constructor(message = "Stage suggestions are unavailable for the current server-resolved task state.") {
    super(message);
    this.name = "StageSuggestionContextAccessError";
  }
}

function isSupportedStage(stage: VideoTaskStage): stage is SupportedSuggestionStage {
  return supportedStages.some((candidate) => candidate === stage);
}

function guidanceFor(stage: SupportedSuggestionStage): readonly string[] {
  if (stage === "script") {
    return [
      "脚本建议必须沿用已确认的营销策略，并适配任务受众、主题和时长。",
      "脚本阶段只使用锁定车型事实，不提前选取人物或场景素材。",
    ];
  }
  if (stage === "asset_matching") {
    return [
      "仅基于已确认的营销策略、脚本和项目资产描述词推荐素材。",
      "车型素材不可替换；人物和场景可由人工调整，人工结果不得被后续推荐静默覆盖。",
    ];
  }
  if (stage === "storyboard") {
    return [
      "分镜建议必须逐镜承接已确认脚本，不得改写已确认卖点、事实或素材选择。",
      "每个镜头应说明画面目的、脚本对应关系、素材引用和时长安排，但不得自行确认分镜。",
    ];
  }
  return [
    "交付建议只能核对已确认上游产物并整理成片、字幕、最终脚本、分镜、素材版本清单和可编辑剪辑草稿清单。",
    "平台选择仅作为元数据标签，不得改变生成规则；交付建议不等于导出完成，也不得发布广告。",
  ];
}

function confirmedActiveArtifact(
  record: Readonly<VideoTaskProductionRecord>,
  stage: VideoTaskStage,
): StageArtifactVersion {
  const artifactVersionId = record.activeStageArtifactVersionIds[stage];
  const artifact = record.stageArtifactVersions.find(
    (candidate) => candidate.id === artifactVersionId && candidate.stage === stage,
  );
  const confirmed = artifact !== undefined && record.stageConfirmations.some(
    (confirmation) =>
      confirmation.tenantId === record.videoTask.tenantId &&
      confirmation.batchProjectId === record.videoTask.batchProjectId &&
      confirmation.videoTaskId === record.videoTask.id &&
      confirmation.stage === stage &&
      confirmation.artifactVersionId === artifact.id &&
      confirmation.decision === "confirmed" &&
      confirmation.source === "human_action",
  );
  const invalidated = artifact !== undefined && record.stageArtifactInvalidations.some(
    (invalidation) => invalidation.artifactVersionId === artifact.id,
  );
  const artifactInScope = artifact !== undefined &&
    artifact.tenantId === record.videoTask.tenantId &&
    artifact.batchProjectId === record.videoTask.batchProjectId &&
    artifact.videoTaskId === record.videoTask.id;
  if (artifact === undefined || !artifactInScope || !confirmed || invalidated) {
    throw new StageSuggestionContextAccessError(
      `A confirmed active '${stage}' artifact is required before suggesting the current stage.`,
    );
  }
  return structuredClone(artifact);
}

export function createScopedStageSuggestionContextReader(
  options: Readonly<CreateScopedStageSuggestionContextReaderOptions>,
): StageSuggestionContextReader {
  const videoTaskId = options.taskContext.videoTask.id;
  if (
    options.companyAssetScope.tenantId !== options.tenantId ||
    options.companyAssetScope.actorAccountId.length === 0 ||
    !options.companyAssetScope.allowedBrandIds.includes(options.taskContext.brand.id) ||
    !options.companyAssetScope.allowedVehicleIds.includes(options.taskContext.vehicle.id)
  ) {
    throw new StageSuggestionContextAccessError();
  }
  return {
    videoTaskId,
    async read(signal?: AbortSignal): Promise<StageSuggestionContextView> {
      signal?.throwIfAborted();
      const record = await options.store.load(videoTaskId);
      signal?.throwIfAborted();
      const contextTask = options.taskContext.videoTask;
      if (
        record === undefined ||
        record.videoTask.id !== videoTaskId ||
        record.videoTask.tenantId !== options.tenantId ||
        record.videoTask.batchProjectId !== options.taskContext.batchProject.id ||
        record.videoTask.status !== "active" ||
        record.videoTask.currentStage !== contextTask.currentStage ||
        record.videoTask.stageStatus !== contextTask.stageStatus ||
        record.videoTask.revision !== contextTask.revision ||
        !isSupportedStage(record.videoTask.currentStage) ||
        record.videoTask.stageStatus === "confirmed"
      ) {
        throw new StageSuggestionContextAccessError();
      }
      const stage = record.videoTask.currentStage;
      const confirmedUpstreamArtifacts = requiredUpstreamStages[stage].map((upstreamStage) =>
        confirmedActiveArtifact(record, upstreamStage)
      );
      for (let index = 1; index < confirmedUpstreamArtifacts.length; index += 1) {
        const previous = confirmedUpstreamArtifacts[index - 1]!;
        const current = confirmedUpstreamArtifacts[index]!;
        if (!current.dependencies.some(
          (dependency) =>
            dependency.kind === "stage_artifact" &&
            dependency.stage === previous.stage &&
            dependency.artifactVersionId === previous.id,
        )) {
          throw new StageSuggestionContextAccessError(
            `Confirmed '${current.stage}' does not depend on the active confirmed '${previous.stage}' version.`,
          );
        }
      }
      const assetMatchingContext = stage === "asset_matching"
        ? {
            companyCandidates: (await options.companyAssetProvider.searchAssets(
              {
                categories: ["person", "scene"],
                brandId: options.taskContext.brand.id,
                vehicleId: options.taskContext.vehicle.id,
                limit: 100,
              },
              options.companyAssetScope,
              signal === undefined ? undefined : { signal },
            )).items.map((item) => structuredClone(item)),
            selectionPolicy: {
              vehicleAssetsLocked: true as const,
              personSceneHumanReplaceable: true as const,
              humanSelectionHasPriority: true as const,
              preserveExactAssetVersions: true as const,
            },
          }
        : undefined;
      signal?.throwIfAborted();
      return {
        schemaVersion: 1,
        kind: "stage_suggestion_context",
        videoTaskId,
        taskRevision: record.videoTask.revision,
        stage,
        stageStatus: record.videoTask.stageStatus,
        productionBrief: {
          audience: record.videoTask.audience,
          theme: record.videoTask.theme,
          durationSeconds: record.videoTask.durationSeconds,
          platformTags: [...record.videoTask.platformTags],
        },
        confirmedUpstreamArtifacts,
        ...(assetMatchingContext === undefined ? {} : { assetMatchingContext }),
        suggestionBoundary: {
          suggestionOnly: true,
          mayPersistArtifact: false,
          mayConfirmStage: false,
          mustPreserveConfirmedUpstream: true,
          platformTagsAreMetadataOnly: true,
          deliveryDoesNotPublishAds: true,
        },
        stageGuidance: guidanceFor(stage),
      };
    },
  };
}

export function createStageSuggestionTools(reader: StageSuggestionContextReader): readonly AgentTool[] {
  const getCurrentStageSuggestionContext: AgentTool<typeof GetCurrentStageSuggestionContextRequestSchema> = {
    name: "get_current_stage_suggestion_context",
    label: "读取当前阶段建议依据",
    description: "读取当前阶段仍有效的已确认上游产物精确版本；资产匹配阶段同时返回带描述词的精确版本人物/场景候选。仅用于提出建议，不生成、不持久化、不确认阶段，也不发布广告。",
    parameters: GetCurrentStageSuggestionContextRequestSchema,
    async execute(_toolCallId, _params, signal) {
      const details = await reader.read(signal);
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
  return [getCurrentStageSuggestionContext];
}
