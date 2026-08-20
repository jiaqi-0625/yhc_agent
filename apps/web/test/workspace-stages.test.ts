import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmationAvailability,
  rollbackImpact,
  stagePosition,
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
