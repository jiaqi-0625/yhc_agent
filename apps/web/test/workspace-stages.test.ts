import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmationAvailability,
  rollbackImpact,
  stagePosition,
  workspaceBudgetPresentation,
  workspaceProductionErrorText,
  workspaceRunLockPresentation,
} from "../public/workspace-stages.js";

const task = {
  id: "task_1",
  status: "active",
  currentStage: "storyboard",
  stageStatus: "awaiting_confirmation",
  revision: 5,
  ownedByCurrentAccount: true,
} as const;

test("stage position follows the strategy-script-asset workflow order", () => {
  assert.equal(stagePosition(task as never, "strategy"), "complete");
  assert.equal(stagePosition(task as never, "script"), "complete");
  assert.equal(stagePosition(task as never, "asset_matching"), "complete");
  assert.equal(stagePosition(task as never, "storyboard"), "current");
  assert.equal(stagePosition(task as never, "video_preview"), "locked");
});

test("rollback impact names every downstream stage", () => {
  assert.deepEqual(rollbackImpact("script"), ["资产匹配", "分镜", "视频预览", "交付"]);
  assert.deepEqual(rollbackImpact("delivery"), []);
});

test("non-strategy confirmation only uses a server-returned persisted artifact", () => {
  const unavailable = confirmationAvailability(task as never, "storyboard", {
    activeArtifactVersionId: undefined,
    versions: [],
  } as never);
  assert.deepEqual(unavailable, { enabled: false, label: "等待产物入库" });

  const artifact = {
    artifactId: "storyboard_draft_1",
    schemaName: "storyboard_draft",
    schemaVersion: 1,
    contentHashSha256: "a".repeat(64),
  };
  const available = confirmationAvailability(task as never, "storyboard", {
    activeArtifactVersionId: "storyboard_v1",
    versions: [{ id: "storyboard_v1", content: artifact }],
  } as never);
  assert.equal(available.enabled, true);
  assert.deepEqual(available.artifact, artifact);
});

test("strategy confirmation requires the persisted confirmation request", () => {
  const strategyTask = { ...task, currentStage: "strategy" } as const;
  assert.equal(confirmationAvailability(strategyTask as never, "strategy", {
    activeStrategyDraft: { id: "draft_1" },
  } as never).enabled, false);
  assert.equal(confirmationAvailability(strategyTask as never, "strategy", {
    activeStrategyDraft: { id: "draft_1" },
    confirmationRequest: { id: "request_1" },
  } as never).enabled, true);
});

test("production budget validates account scope and the balance identity", () => {
  const budget = {
    accountId: "account_creator_a",
    currency: "CNY",
    balance: {
      limitAmountMinor: 50_000,
      spentAmountMinor: 12_000,
      reservedAmountMinor: 3_000,
      availableAmountMinor: 35_000,
      currency: "CNY",
    },
  };
  assert.deepEqual(workspaceBudgetPresentation(budget, "account_creator_a"), {
    tone: "success",
    value: "¥350.00",
    detail: "已预留 ¥30.00",
  });
  assert.deepEqual(workspaceBudgetPresentation(null, "account_creator_a"), {
    tone: "warning",
    value: "未配置",
    detail: "联系管理员配置制作额度",
  });
  assert.throws(
    () => workspaceBudgetPresentation({
      ...budget,
      balance: { ...budget.balance, availableAmountMinor: 34_999 },
    }, "account_creator_a"),
    /当前账号不一致/u,
  );
  assert.throws(
    () => workspaceBudgetPresentation(budget, "account_creator_b"),
    /当前账号不一致/u,
  );
});

test("production run lock distinguishes this task from another task", () => {
  const lock = {
    batchProjectId: "project_1",
    videoTaskId: "task_1",
    taskRevision: 8,
    operation: "video_generation",
    acquiredAt: "2026-08-20T08:00:00.000Z",
  };
  assert.deepEqual(workspaceRunLockPresentation({ runLock: null }, "task_1"), {
    tone: "success",
    value: "运行槽可用",
    detail: "可开始高消耗任务",
  });
  assert.deepEqual(workspaceRunLockPresentation({ runLock: lock }, "task_1"), {
    tone: "pending",
    value: "本任务运行中",
    detail: "正在生成视频",
  });
  assert.deepEqual(workspaceRunLockPresentation({ runLock: lock }, "task_2"), {
    tone: "danger",
    value: "其他任务运行中",
    detail: "当前账号已有高消耗任务",
  });
  assert.throws(
    () => workspaceRunLockPresentation({ runLock: { ...lock, operation: "unknown" } }, "task_1"),
    /运行状态数据无效/u,
  );
});

test("production rejection codes use the same concise Chinese messages as the workspace", () => {
  assert.equal(workspaceProductionErrorText({ code: "AIC-COST-BUDGET_EXCEEDED" }), "当前账号可用额度不足");
  assert.equal(workspaceProductionErrorText({ code: "AIC-COST-BUDGET_NOT_CONFIGURED" }), "当前账号未配置制作额度");
  assert.equal(workspaceProductionErrorText({ code: "AIC-CONCURRENCY-ACCOUNT_HIGH_COST_TASK_RUNNING" }), "当前账号已有高消耗任务在运行");
  assert.equal(workspaceProductionErrorText({ code: "AIC-CONCURRENCY-RUN_LOCK_DENIED" }), "当前账号已有高消耗任务在运行");
  assert.equal(workspaceProductionErrorText({ code: "AIC-WORKFLOW-REVISION_CONFLICT" }), "任务已更新，请刷新后重试");
});
