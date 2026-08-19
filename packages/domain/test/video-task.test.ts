import assert from "node:assert/strict";
import test from "node:test";

import type { BatchProject } from "@firefly/schemas";

import {
  RevisionConflictError,
  VideoTaskAssignmentDeniedError,
  VideoTaskCreationError,
  assignVideoTaskOwner,
  createVideoTask,
  type VideoTaskProductionRecord,
} from "../src/index.ts";

const project: BatchProject = {
  id: "project_launch",
  tenantId: "tenant_firefly",
  brandId: "brand_firefly",
  vehicleId: "vehicle_suv",
  vehicleVersion: 1,
  name: "萤火虫 SUV 旗舰版 9:16 首发",
  batchName: "首发",
  aspectRatio: "9:16",
  visualStylePresetId: "style_modern",
  assetPoolId: "pool_launch",
  status: "active",
  revision: 2,
  createdAt: "2026-08-19T02:00:00.000Z",
  createdBy: "account_creator",
  updatedAt: "2026-08-19T02:00:00.000Z",
  updatedBy: "account_creator",
};

const creationInput = {
  name: "  家庭  周末出行  ",
  audience: " 有孩家庭 ",
  theme: " 周末出游 ",
  durationSeconds: 30,
  scriptInput: "\n现有脚本\n",
  platformTags: ["douyin", "xiaohongshu"],
};

const creationContext = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_creator",
  ownerAccountId: "account_target",
  occurredAt: "2026-08-19T04:00:00.000Z",
  taskId: "task_family",
};

test("createVideoTask derives a clean schema-v6 aggregate from active project and server scope", () => {
  const record = createVideoTask(project, creationInput, creationContext);

  assert.equal(record.schemaVersion, 6);
  assert.deepEqual(record.videoTask, {
    id: "task_family",
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    name: "家庭 周末出行",
    ownerAccountId: "account_target",
    status: "active",
    currentStage: "strategy",
    stageStatus: "in_progress",
    revision: 1,
    audience: "有孩家庭",
    theme: "周末出游",
    durationSeconds: 30,
    scriptInput: "现有脚本",
    platformTags: ["douyin", "xiaohongshu"],
    createdAt: creationContext.occurredAt,
    createdBy: "account_creator",
    updatedAt: creationContext.occurredAt,
    updatedBy: "account_creator",
  });
  assert.deepEqual(record.stageArtifactVersions, []);
  assert.deepEqual(record.stageConfirmations, []);
  assert.deepEqual(record.activeStageArtifactVersionIds, {});
  assert.deepEqual(record.stageRollbacks, []);
  assert.deepEqual(record.stageArtifactInvalidations, []);
  assert.deepEqual(record.ownershipTransfers, []);
  assert.deepEqual(record.taskVehicleSnapshots, []);
  assert.deepEqual(record.taskAssetSnapshots, []);
  assert.deepEqual(record.strategyDrafts, []);
  assert.equal(record.activeStrategyDraftId, undefined);
  assert.deepEqual(record.stageConfirmationRequests, []);
  assert.deepEqual(record.commandReceipts, []);
  assert.deepEqual(record.stageMutationReceipts, []);
});

test("createVideoTask rejects archived/cross-tenant projects and malformed direct domain input", () => {
  assert.throws(
    () => createVideoTask({ ...project, status: "archived" }, creationInput, creationContext),
    (error: unknown) =>
      error instanceof VideoTaskCreationError &&
      error.code === "AIC-VIDEO-TASK-CREATION-PROJECT_INACTIVE",
  );
  assert.throws(
    () => createVideoTask(project, creationInput, { ...creationContext, tenantId: "tenant_other" }),
    (error: unknown) =>
      error instanceof VideoTaskCreationError &&
      error.code === "AIC-VIDEO-TASK-CREATION-SCOPE_INVALID",
  );
  assert.throws(
    () => createVideoTask(project, { ...creationInput, name: "   " }, creationContext),
    VideoTaskCreationError,
  );
  assert.throws(
    () => createVideoTask(project, { ...creationInput, platformTags: ["douyin", "douyin"] }, creationContext),
    VideoTaskCreationError,
  );
  assert.throws(
    () => createVideoTask(project, { ...creationInput, durationSeconds: 0 }, creationContext),
    VideoTaskCreationError,
  );
});

function assignmentRecord(): VideoTaskProductionRecord {
  const record = createVideoTask(project, creationInput, {
    ...creationContext,
    ownerAccountId: "account_owner",
  });
  record.videoTask.revision = 3;
  return record;
}

const assignmentRequest = {
  expectedTaskRevision: 3,
  targetOwnerAccountId: "account_target",
  reason: "  原负责人  工作交接  ",
};

const assignmentContext = {
  tenantId: "tenant_firefly",
  batchProjectId: "project_launch",
  actorAccountId: "account_assigner",
  occurredAt: "2026-08-19T05:00:00.000Z",
  createId: () => "ownership_transfer_1",
};

test("assignVideoTaskOwner atomically changes the owner and appends an attributable immutable audit", () => {
  const source = assignmentRecord();
  const result = assignVideoTaskOwner(source, assignmentRequest, assignmentContext);

  assert.equal(result.videoTask.ownerAccountId, "account_target");
  assert.equal(result.videoTask.revision, 4);
  assert.equal(result.videoTask.updatedBy, "account_assigner");
  assert.deepEqual(result.ownershipTransfers, [
    {
      id: "ownership_transfer_1",
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      videoTaskId: "task_family",
      fromOwnerAccountId: "account_owner",
      toOwnerAccountId: "account_target",
      expectedTaskRevision: 3,
      reason: "原负责人 工作交接",
      source: "human_action",
      actorAccountId: "account_assigner",
      occurredAt: assignmentContext.occurredAt,
    },
  ]);
  assert.equal(source.videoTask.ownerAccountId, "account_owner");
  assert.equal(source.videoTask.revision, 3);
  assert.deepEqual(source.ownershipTransfers, []);
});

test("assignVideoTaskOwner rejects stale, terminal, same-owner, wrong-scope, and blank-reason changes", () => {
  assert.throws(
    () => assignVideoTaskOwner(
      assignmentRecord(),
      { ...assignmentRequest, expectedTaskRevision: 2 },
      assignmentContext,
    ),
    RevisionConflictError,
  );
  const completed = assignmentRecord();
  completed.videoTask.status = "completed";
  assert.throws(
    () => assignVideoTaskOwner(completed, assignmentRequest, assignmentContext),
    VideoTaskAssignmentDeniedError,
  );
  assert.throws(
    () => assignVideoTaskOwner(
      assignmentRecord(),
      { ...assignmentRequest, targetOwnerAccountId: "account_owner" },
      assignmentContext,
    ),
    VideoTaskAssignmentDeniedError,
  );
  assert.throws(
    () => assignVideoTaskOwner(
      assignmentRecord(),
      assignmentRequest,
      { ...assignmentContext, tenantId: "tenant_other" },
    ),
    VideoTaskAssignmentDeniedError,
  );
  assert.throws(
    () => assignVideoTaskOwner(
      assignmentRecord(),
      { ...assignmentRequest, reason: "   " },
      assignmentContext,
    ),
    VideoTaskAssignmentDeniedError,
  );
});
