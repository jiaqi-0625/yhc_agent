import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmationAvailability,
  createWorkspaceStagesPanel,
  expectedVideoShotCount,
  latestVideoGenerationForShot,
  remainingVideoShotIndices,
  rollbackImpact,
  simulatedStageActionCard,
  stagePosition,
  workspaceBudgetPresentation,
  workspaceProductionErrorText,
  workspaceRunLockPresentation,
} from "../public/workspace-stages.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function fakeRoot() {
  let confirmListener: (() => Promise<void>) | null = null;
  return {
    innerHTML: "",
    querySelector(selector: string) {
      if (selector !== "[data-stage-confirm]") return null;
      return {
        addEventListener(_event: string, listener: () => Promise<void>) {
          confirmListener = listener;
        },
      };
    },
    querySelectorAll() { return []; },
    clickConfirm() {
      assert.ok(confirmListener, "confirmation listener must be rendered");
      return confirmListener();
    },
  };
}

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

  const generated = confirmationAvailability(task as never, "storyboard", {
    generatedArtifact: {
      artifactId: "ws503_storyboard_1",
      schemaName: "ws503_simulated_storyboard",
      schemaVersion: 1,
      contentHashSha256: "b".repeat(64),
    },
  } as never);
  assert.deepEqual(generated, { enabled: true, label: "确认方案并进入真实视频" });

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

test("real video progress uses the supported multi-shot plan", () => {
  assert.equal(expectedVideoShotCount(10), 3);
  assert.equal(expectedVideoShotCount(15), 5);
  assert.equal(expectedVideoShotCount(30), 6);
  assert.equal(expectedVideoShotCount(20), 0);
  assert.deepEqual(remainingVideoShotIndices(3, [
    { shotIndex: 0, status: "succeeded", output: { artifactId: "shot_1" } },
    { shotIndex: 1, status: "failed" },
  ]), [1, 2]);
  assert.deepEqual(latestVideoGenerationForShot([
    { id: "old", shotIndex: 0, status: "failed" },
    { id: "new", shotIndex: 0, status: "succeeded" },
    { id: "other", shotIndex: 1, status: "succeeded" },
  ], 0), { id: "new", shotIndex: 0, status: "succeeded" });
});

test("simulated storyboard generation uses the frozen Agent action-card label", () => {
  const card = simulatedStageActionCard("task_1", "storyboard", 10);
  assert.equal(card.action, "generate_simulated_stage_artifact");
  assert.equal(card.label, "生成当前阶段模拟产物");
  assert.deepEqual(card.payload, { schemaVersion: 1, stage: "storyboard" });
});

test("a persisted generated script can be confirmed without a client artifact", () => {
  const scriptTask = {
    ...task,
    currentStage: "script",
    scriptInput: "00–05s｜画面：车辆驶出社区。\n旁白：周末，从从容出发。",
  } as const;
  assert.deepEqual(confirmationAvailability(scriptTask as never, "script", {
    activeArtifactVersionId: undefined,
    versions: [],
  } as never), {
    enabled: true,
    label: "确认脚本",
  });
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

test("account changes invalidate in-flight production status and reload the same task scope", async (context) => {
  const browserGlobal = globalThis as typeof globalThis & { document?: unknown };
  const originalDocument = browserGlobal.document;
  const dialog = {
    className: "",
    innerHTML: "",
    open: false,
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  browserGlobal.document = {
    createElement() { return dialog; },
    body: { append() {} },
  };
  context.after(() => {
    if (originalDocument === undefined) delete browserGlobal.document;
    else browserGlobal.document = originalDocument;
  });

  const roots = {
    planning: fakeRoot(),
    storyboard: fakeRoot(),
    production: fakeRoot(),
    delivery: fakeRoot(),
  };
  const oldBudget = deferred<unknown>();
  const oldRunLock = deferred<unknown>();
  let accountId = "account_creator_a";
  const videoTask = {
    ...task,
    currentStage: "delivery",
  };
  const otherVideoTask = { ...videoTask, id: "task_2", revision: 6 };
  const oldConfirmation = deferred<{ videoTask: { id: string; revision: number; [key: string]: unknown } }>();
  const sameTaskConfirmation = deferred<{ videoTask: { id: string; revision: number; [key: string]: unknown } }>();
  let deferSameTaskConfirmation = false;
  const confirmationCalls: string[] = [];
  const updatedTasks: string[] = [];
  const busyChanges: boolean[] = [];
  const budgetFor = (selectedAccountId: string, availableAmountMinor: number) => ({
    budget: {
      accountId: selectedAccountId,
      currency: "CNY",
      balance: {
        limitAmountMinor: availableAmountMinor,
        spentAmountMinor: 0,
        reservedAmountMinor: 0,
        availableAmountMinor,
        currency: "CNY",
      },
    },
  });
  const api = {
    getStageVersions: async (_projectId: string, videoTaskId: string) => {
      const selectedTask = videoTaskId === otherVideoTask.id ? otherVideoTask : videoTask;
      const versionId = videoTaskId + "_delivery_v1";
      return {
        videoTask: selectedTask,
        activeArtifactVersionId: versionId,
        versions: [{
          id: versionId,
          version: 1,
          createdAt: "2026-08-20T08:00:00.000Z",
          content: { artifactId: versionId },
        }],
        invalidations: [],
      };
    },
    getOwnBudget: () => accountId === "account_creator_a"
      ? oldBudget.promise
      : Promise.resolve(budgetFor(accountId, 22_200)),
    getProductionStatus: () => accountId === "account_creator_a"
      ? oldRunLock.promise
      : Promise.resolve({ runLock: null }),
    confirmStage: async (_projectId: string, videoTaskId: string) => {
      confirmationCalls.push(videoTaskId);
      if (videoTaskId === videoTask.id) return oldConfirmation.promise;
      if (deferSameTaskConfirmation) return sameTaskConfirmation.promise;
      return { videoTask: { ...otherVideoTask, revision: otherVideoTask.revision + 1 } };
    },
  };
  const panel = createWorkspaceStagesPanel({
    roots,
    api,
    getCurrentAccountId: () => accountId,
    onTaskUpdated: (updatedTask: { id: string }) => { updatedTasks.push(updatedTask.id); },
    onBusyChange: (busy: boolean) => { busyChanges.push(busy); },
  } as never);

  panel.setContext("project_1", { project: { id: "project_1" } }, videoTask as never, "delivery");
  accountId = "account_creator_b";
  panel.reset();
  panel.setContext("project_1", { project: { id: "project_1" } }, videoTask as never, "delivery");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(roots.delivery.innerHTML, /¥222\.00/u);
  assert.match(roots.delivery.innerHTML, /运行槽可用/u);

  oldBudget.resolve(budgetFor("account_creator_a", 11_100));
  oldRunLock.resolve({
    runLock: {
      batchProjectId: "project_1",
      videoTaskId: "task_other",
      taskRevision: 1,
      operation: "video_generation",
      acquiredAt: "2026-08-20T08:00:00.000Z",
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.doesNotMatch(roots.delivery.innerHTML, /¥111\.00|其他任务运行中/u);

  const staleConfirmation = roots.delivery.clickConfirm();
  assert.equal(panel.isBusy(), true);
  dialog.open = true;
  dialog.innerHTML = "stale task dialog";
  panel.setContext("project_2", { project: { id: "project_2" } }, otherVideoTask as never, "delivery");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(panel.isBusy(), false);
  assert.equal(dialog.open, false);
  assert.equal(dialog.innerHTML, "");

  oldConfirmation.resolve({ videoTask: { ...videoTask, revision: videoTask.revision + 1 } });
  await staleConfirmation;
  assert.deepEqual(updatedTasks, []);
  await roots.delivery.clickConfirm();
  assert.deepEqual(confirmationCalls, [videoTask.id, otherVideoTask.id]);
  assert.deepEqual(updatedTasks, [otherVideoTask.id]);
  assert.equal(panel.isBusy(), false);

  deferSameTaskConfirmation = true;
  const sameTaskMutation = roots.delivery.clickConfirm();
  assert.equal(panel.isBusy(), true);
  panel.setContext("project_2", { project: { id: "project_2" } }, otherVideoTask as never, "production");
  assert.equal(panel.isBusy(), true);
  sameTaskConfirmation.resolve({
    videoTask: { ...otherVideoTask, revision: otherVideoTask.revision + 1 },
  });
  await sameTaskMutation;
  assert.deepEqual(updatedTasks, [otherVideoTask.id, otherVideoTask.id]);
  assert.equal(panel.isBusy(), false);
  assert.deepEqual(busyChanges, [true, false, true, false, true, false]);

  panel.reset();
  assert.equal(roots.delivery.innerHTML, "");
});
