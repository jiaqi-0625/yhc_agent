import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmationAvailability,
  createWorkspaceStagesPanel,
  rollbackImpact,
  workspaceStageTaskStateKey,
  stagePosition,
  workspaceBudgetPresentation,
  workspaceProductionErrorText,
  workspaceRunLockPresentation,
} from "../public/workspace-stages.js";

test("workspace stage context changes when an Agent command advances task state", () => {
  const before = workspaceStageTaskStateKey({
    id: "task_sync",
    revision: 2,
    status: "active",
    currentStage: "strategy",
    stageStatus: "in_progress",
  });
  const after = workspaceStageTaskStateKey({
    id: "task_sync",
    revision: 3,
    status: "active",
    currentStage: "strategy",
    stageStatus: "awaiting_confirmation",
  });
  assert.notEqual(after, before);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function fakeRoot() {
  let confirmListener: (() => Promise<void>) | null = null;
  let simulateListener: (() => Promise<void>) | null = null;
  return {
    innerHTML: "",
    querySelector(selector: string) {
      if (selector === "[data-stage-simulate]") {
        return {
          addEventListener(_event: string, listener: () => Promise<void>) {
            simulateListener = listener;
          },
        };
      }
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
    clickSimulate() {
      assert.ok(simulateListener, "simulation listener must be rendered");
      return simulateListener();
    },
  };
}

test("script simulation remains visible when its task revision synchronizes back into the panel", async (context) => {
  const browserGlobal = globalThis as typeof globalThis & { document?: unknown };
  const originalDocument = browserGlobal.document;
  browserGlobal.document = {
    createElement() {
      return {
        className: "", innerHTML: "", open: false,
        setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        showModal() { this.open = true; }, close() { this.open = false; },
      };
    },
    body: { append() {} },
  };
  context.after(() => {
    if (originalDocument === undefined) delete browserGlobal.document;
    else browserGlobal.document = originalDocument;
  });
  const roots = {
    planning: fakeRoot(), storyboard: fakeRoot(), production: fakeRoot(), delivery: fakeRoot(),
  };
  let currentTask = {
    id: "task_script", batchProjectId: "project_1", status: "active",
    currentStage: "script", stageStatus: "in_progress", revision: 8,
    ownedByCurrentAccount: true, theme: "智能通勤", audience: "城市家庭",
    durationSeconds: 15, platformTags: ["信息流"],
  };
  let panel: ReturnType<typeof createWorkspaceStagesPanel>;
  panel = createWorkspaceStagesPanel({
    roots,
    api: {
      getStageVersions: async () => ({
        videoTask: currentTask, activeArtifactVersionId: undefined, versions: [], invalidations: [],
      }),
      simulateStage: async () => {
        currentTask = { ...currentTask, revision: 9, stageStatus: "awaiting_confirmation" };
        return {
          videoTask: currentTask,
          artifact: {
            artifactId: "development_script_1", schemaName: "development_simulated_script",
            schemaVersion: 1, contentHashSha256: "a".repeat(64),
          },
        };
      },
    },
    getCurrentAccountId: () => "account_creator_b",
    onTaskUpdated: (updatedTask: typeof currentTask) => {
      panel.setContext("project_1", { project: { id: "project_1" } }, updatedTask as never, "planning");
    },
  } as never);
  panel.setContext("project_1", { project: { id: "project_1" } }, currentTask as never, "planning");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(roots.planning.innerHTML, /策略确认后由 Agent 生成脚本/u);
  await roots.planning.clickSimulate();
  assert.match(roots.planning.innerHTML, /开场：以智能通勤建立画面/u);
  assert.match(roots.planning.innerHTML, /产物待负责人确认/u);
});

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

  const simulated = confirmationAvailability(task as never, "storyboard", {
    activeArtifactVersionId: undefined,
    versions: [],
    simulatedArtifact: artifact,
  } as never);
  assert.equal(simulated.enabled, true);
  assert.deepEqual(simulated.artifact, artifact);
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
  let stageVersionCalls = 0;
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
      stageVersionCalls += 1;
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
  const callsBeforeTaskUpdate = stageVersionCalls;
  panel.setContext(
    "project_1",
    { project: { id: "project_1" } },
    { ...videoTask, revision: videoTask.revision + 1, stageStatus: "confirmed" } as never,
    "delivery",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stageVersionCalls, callsBeforeTaskUpdate + 6);

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
