import assert from "node:assert/strict";
import test from "node:test";

import {
  RevisionConflictError,
  TaskTakeoverDeniedError,
  takeOverVideoTask,
  type VideoTaskProductionRecord,
} from "../src/index.ts";

function record(): VideoTaskProductionRecord {
  return {
    schemaVersion: 4,
    videoTask: {
      id: "task_takeover",
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      name: "接管测试任务",
      ownerAccountId: "account_owner",
      status: "active",
      currentStage: "script",
      stageStatus: "in_progress",
      revision: 7,
      audience: "家庭用户",
      theme: "周末出行",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-19T00:00:00.000Z",
      createdBy: "account_owner",
      updatedAt: "2026-08-19T01:00:00.000Z",
      updatedBy: "account_owner",
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskAssetSnapshots: [],
  };
}

const request = {
  expectedTaskRevision: 7,
  reason: "继续完成脚本制作",
};

function context(actorAccountId = "account_member") {
  return {
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    actorAccountId,
    occurredAt: "2026-08-19T04:00:00.000Z",
    createId: () => "ownership_transfer_1",
  };
}

test("takeover changes the sole owner, increments revision, and appends a human audit record", () => {
  const source = record();
  const result = takeOverVideoTask(source, request, context());

  assert.equal(result.videoTask.ownerAccountId, "account_member");
  assert.equal(result.videoTask.revision, 8);
  assert.equal(result.videoTask.updatedBy, "account_member");
  assert.deepEqual(result.ownershipTransfers, [
    {
      id: "ownership_transfer_1",
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      videoTaskId: "task_takeover",
      fromOwnerAccountId: "account_owner",
      toOwnerAccountId: "account_member",
      expectedTaskRevision: 7,
      reason: "继续完成脚本制作",
      source: "human_action",
      actorAccountId: "account_member",
      occurredAt: "2026-08-19T04:00:00.000Z",
    },
  ]);
  assert.equal(source.videoTask.ownerAccountId, "account_owner");
  assert.equal(source.videoTask.revision, 7);
  assert.deepEqual(source.ownershipTransfers, []);
});

test("takeover rejects stale revisions without producing a partial transfer", () => {
  const source = record();
  assert.throws(
    () => takeOverVideoTask(source, { ...request, expectedTaskRevision: 6 }, context()),
    RevisionConflictError,
  );
  assert.equal(source.videoTask.ownerAccountId, "account_owner");
  assert.deepEqual(source.ownershipTransfers, []);
});

test("takeover rejects the current owner, terminal tasks, wrong scope, and invalid reasons", () => {
  assert.throws(
    () => takeOverVideoTask(record(), request, context("account_owner")),
    TaskTakeoverDeniedError,
  );
  const completed = record();
  completed.videoTask.status = "completed";
  assert.throws(
    () => takeOverVideoTask(completed, request, context()),
    TaskTakeoverDeniedError,
  );
  assert.throws(
    () => takeOverVideoTask(record(), request, { ...context(), tenantId: "tenant_other" }),
    TaskTakeoverDeniedError,
  );
  assert.throws(
    () => takeOverVideoTask(record(), { ...request, reason: "   " }, context()),
    TaskTakeoverDeniedError,
  );
});
