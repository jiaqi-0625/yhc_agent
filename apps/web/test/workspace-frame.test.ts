import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceSelection, workspaceModuleForStage } from "../public/workspace-frame.js";

const project = {
  project: { id: "project_e5", status: "active" },
  tasks: [
    { id: "task_done", status: "completed", currentStage: "delivery" },
    { id: "task_active", status: "active", currentStage: "script" },
  ],
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
