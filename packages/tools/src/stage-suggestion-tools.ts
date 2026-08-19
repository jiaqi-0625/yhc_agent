import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { VideoTaskProductionRecord } from "@firefly/domain";
import type {
  StageArtifactVersion,
  TaskContext,
  VideoTaskStage,
} from "@firefly/schemas";
import { Type } from "typebox";

const GetCurrentStageSuggestionContextRequestSchema = Type.Object({}, { additionalProperties: false });

const supportedStages = ["script", "storyboard", "delivery"] as const;
type SupportedSuggestionStage = (typeof supportedStages)[number];

const requiredUpstreamStages: Readonly<Record<SupportedSuggestionStage, readonly VideoTaskStage[]>> = {
  script: ["strategy", "asset_matching"],
  storyboard: ["strategy", "asset_matching", "script"],
  delivery: ["strategy", "asset_matching", "script", "storyboard", "video_preview"],
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
      "脚本建议必须沿用已确认的营销策略与资产匹配结果，并适配任务受众、主题和时长。",
      "涉及车型事实时仍需基于锁定车型快照校验；涉及素材时仍需保留锁定版本和来源风险提示。",
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
    description: "只在当前脚本、分镜或交付阶段读取仍有效的已确认上游产物精确版本；仅用于提出建议，不生成、不持久化、不确认阶段，也不发布广告。",
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
