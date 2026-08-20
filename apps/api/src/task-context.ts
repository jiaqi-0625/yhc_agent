import type {
  TaskContext,
  VideoTaskStage,
  VideoTaskStageStatus,
  VideoTaskStatus,
  WorkStatus,
} from "@firefly/schemas";

import { LocalBusinessRuntime } from "./business-runtime.ts";

function stageForLegacyStatus(status: WorkStatus): VideoTaskStage {
  if (
    status === "strategy_approved" ||
    status === "script_draft" ||
    status === "awaiting_script_approval"
  ) return "script";
  if (status === "script_approved") return "asset_matching";
  if (
    status === "prompt_draft" ||
    status === "awaiting_prompt_approval" ||
    status === "prompt_approved" ||
    status === "storyboard_draft" ||
    status === "awaiting_storyboard_approval"
  ) return "storyboard";
  if (status === "storyboard_approved" || status === "rendering" || status === "final_review") {
    return "video_preview";
  }
  if (status === "export_ready" || status === "exported") return "delivery";
  return "strategy";
}

function taskStatusForLegacyStatus(status: WorkStatus): VideoTaskStatus {
  return status === "exported" ? "completed" : "active";
}

function stageStatusForLegacyStatus(status: WorkStatus): VideoTaskStageStatus {
  if (status === "exported") return "confirmed";
  if (status.startsWith("awaiting_") || status === "final_review") return "awaiting_confirmation";
  return "in_progress";
}

export async function resolveLocalTaskContext(
  business: LocalBusinessRuntime,
  videoTaskId: string,
): Promise<TaskContext> {
  const view = await business.getWork(videoTaskId);
  const snapshot = view.vehicleSnapshot;
  const strategy = view.strategy;
  return {
    schemaVersion: 1,
    kind: "task_context",
    brand: { id: snapshot.brandId, name: snapshot.brand },
    vehicle: {
      id: snapshot.vehicleId,
      displayName: `${snapshot.series} ${snapshot.trim}`,
      version: 1,
    },
    batchProject: {
      id: view.work.projectId,
      name: `${snapshot.brand} ${snapshot.series} 历史作品兼容项目`,
      aspectRatio: "9:16",
    },
    videoTask: {
      id: view.work.id,
      name: `${snapshot.series} ${snapshot.trim} 广告任务`,
      status: taskStatusForLegacyStatus(view.work.status),
      currentStage: stageForLegacyStatus(view.work.status),
      stageStatus: stageStatusForLegacyStatus(view.work.status),
      revision: view.work.revision,
      ...(view.work.vehicleSnapshotId === undefined
        ? {}
        : { vehicleSnapshotId: view.work.vehicleSnapshotId }),
      ownership: { state: "owned_by_current_account" },
    },
    productionBrief: {
      audience: strategy?.audience ?? "待补充受众",
      theme: strategy?.theme ?? "待补充主题",
      durationSeconds: 30,
      platformTags: [],
    },
  };
}
