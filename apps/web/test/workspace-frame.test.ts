import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createWorkspaceContextDetail,
  readWorkspaceUrlState,
  resolveWorkspaceSelection,
  summarizeWorkspaceProject,
  workspaceModuleForStage,
  workspaceOwnerLabel,
  workspaceUrlForState,
} from "../public/workspace-frame.js";

const project = {
  project: {
    id: "project_e5",
    name: "萤火 E5 情景演绎",
    batchName: "情景演绎 · 15秒",
    aspectRatio: "16:9",
    status: "active",
  },
  brand: { name: "萤火汽车" },
  vehicle: { displayName: "萤火 E5 2026 长续航版", version: 1 },
  tasks: [
    {
      id: "task_done",
      name: "已完成任务",
      status: "completed",
      currentStage: "delivery",
      stageStatus: "confirmed",
      revision: 8,
      ownedByCurrentAccount: false,
      updatedAt: "2026-08-20T08:00:00.000Z",
    },
    {
      id: "task_active",
      name: "当前任务",
      status: "active",
      currentStage: "script",
      stageStatus: "awaiting_confirmation",
      revision: 3,
      ownedByCurrentAccount: true,
      updatedAt: "2026-08-20T09:00:00.000Z",
    },
  ],
  latestActivityAt: "2026-08-20T09:00:00.000Z",
};

test("workspace frame resolves an explicit task and falls back to the active task", () => {
  assert.equal(resolveWorkspaceSelection([project], "project_e5", "task_done")?.task?.id, "task_done");
  assert.equal(resolveWorkspaceSelection([project], "project_e5", "missing")?.task?.id, "task_active");
  assert.equal(resolveWorkspaceSelection([project], "missing", "task_active"), null);
  assert.equal(resolveWorkspaceSelection(null, "project_e5", "task_active"), null);
});

test("workspace stages map to the five stable top-level modules", () => {
  assert.equal(workspaceModuleForStage("strategy"), "planning");
  assert.equal(workspaceModuleForStage("script"), "planning");
  assert.equal(workspaceModuleForStage("asset_matching"), "assets");
  assert.equal(workspaceModuleForStage("storyboard"), "storyboard");
  assert.equal(workspaceModuleForStage("video_preview"), "production");
  assert.equal(workspaceModuleForStage("delivery"), "delivery");
});

test("workspace URL state is scoped, encoded, and clears only workspace parameters", () => {
  const href = "http://127.0.0.1:43101/?preview=1#top";
  const next = workspaceUrlForState(href, {
    projectId: "project_e5",
    videoTaskId: "task_active",
    module: "planning",
  });
  assert.equal(
    next,
    "/?preview=1&projectId=project_e5&videoTaskId=task_active&workspaceModule=planning#top",
  );
  assert.deepEqual(readWorkspaceUrlState("http://127.0.0.1:43101" + next), {
    projectId: "project_e5",
    videoTaskId: "task_active",
    module: "planning",
  });
  assert.equal(workspaceUrlForState("http://127.0.0.1:43101" + next, null), "/?preview=1#top");
  assert.equal(readWorkspaceUrlState("http://127.0.0.1:43101/?projectId=../other"), null);
});

test("project overview counts task states without exposing owner identities", () => {
  assert.deepEqual(summarizeWorkspaceProject(project), {
    total: 2,
    active: 1,
    pending: 1,
    mine: 1,
  });
  assert.equal(workspaceOwnerLabel(project.tasks[1]), "当前账号");
  assert.equal(workspaceOwnerLabel(project.tasks[0]), "其他制作成员");
});

test("workspace context event detail switches task state without carrying account IDs", () => {
  const detail = createWorkspaceContextDetail(project, project.tasks[1]!);
  assert.deepEqual(detail?.videoTask, {
    id: "task_active",
    name: "当前任务",
    status: "active",
    currentStage: "script",
    stageStatus: "awaiting_confirmation",
    revision: 3,
    ownership: "owned_by_current_account",
  });
  assert.equal(JSON.stringify(detail).includes("account_creator"), false);
  assert.equal(createWorkspaceContextDetail(project, null)?.videoTask, null);
});

test("workspace frame blocks task and overview switches while Agent interaction is busy", async () => {
  const source = await readFile(new URL("../public/workspace-frame.js", import.meta.url), "utf8");
  assert.match(source, /function selectionLocked\(\)/u);
  assert.match(source, /selectionLocked\(\) && taskId !== selection\.task\?\.id/u);
  assert.match(source, /button\.disabled = locked && button\.dataset\.videoTaskId !== selection\?\.task\?\.id/u);
  assert.match(source, /if \(selectionLocked\(\) && selection\.task !== null\) return;/u);
  assert.match(source, /refreshSelectionControls/u);
});
