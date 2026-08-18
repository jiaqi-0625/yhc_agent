import type { TaskContext } from "@firefly/schemas";

export const MOCK_TASK_CONTEXT = {
  schemaVersion: 1,
  videoTaskId: "work_fixture_001",
  batchProjectId: "project_local",
  brandId: "brand_firefly_demo",
  vehicleId: "vehicle_firefly_e5_2026_long_range",
  taskStatus: "active",
  currentStage: "strategy",
  taskRevision: 1,
  vehicleSnapshotId: "vehicle_snapshot_fixture_001",
  assetSnapshotId: "asset_snapshot_fixture_001",
  display: {
    brandName: "萤火汽车",
    vehicleName: "萤火 E5 长续航示例版",
    batchProjectName: "萤火汽车 萤火 E5 9:16 黄金样例",
    videoTaskName: "家庭周末出行",
  },
  brief: {
    audience: "有孩家庭用户",
    theme: "周末家庭出行",
    durationSeconds: 30,
    platformTags: ["douyin", "xiaohongshu"],
    hasScriptInput: false,
  },
} satisfies TaskContext;
