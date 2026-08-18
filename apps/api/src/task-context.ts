import type { TaskContext, VideoTaskStage, VideoTaskStatus, WorkStatus } from "@firefly/schemas";

import { LocalBusinessRuntime } from "./business-runtime.ts";

function stageForLegacyStatus(status: WorkStatus): VideoTaskStage {
  if (status === "strategy_approved") return "asset_matching";
  if (
    status === "script_draft" ||
    status === "awaiting_script_approval" ||
    status === "script_approved" ||
    status === "prompt_draft" ||
    status === "awaiting_prompt_approval"
  ) return "script";
  if (
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

export async function resolveLocalTaskContext(
  business: LocalBusinessRuntime,
  videoTaskId: string,
): Promise<TaskContext> {
  const view = await business.getWork(videoTaskId);
  const snapshot = view.vehicleSnapshot;
  const strategy = view.strategy;
  return {
    schemaVersion: 1,
    videoTaskId: view.work.id,
    batchProjectId: view.work.projectId,
    brandId: snapshot.brandId,
    vehicleId: snapshot.vehicleId,
    taskStatus: taskStatusForLegacyStatus(view.work.status),
    currentStage: stageForLegacyStatus(view.work.status),
    taskRevision: view.work.revision,
    ...(view.work.vehicleSnapshotId === undefined
      ? {}
      : { vehicleSnapshotId: view.work.vehicleSnapshotId }),
    display: {
      brandName: snapshot.brand,
      vehicleName: `${snapshot.series} ${snapshot.trim}`,
      batchProjectName: `${snapshot.brand} ${snapshot.series} 历史作品兼容项目`,
      videoTaskName: `${snapshot.series} ${snapshot.trim} 广告任务`,
    },
    brief: {
      audience: strategy?.audience ?? "待补充受众",
      theme: strategy?.theme ?? "待补充主题",
      durationSeconds: 30,
      platformTags: [],
      hasScriptInput: false,
    },
  };
}
