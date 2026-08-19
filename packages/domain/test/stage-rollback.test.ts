import assert from "node:assert/strict";
import test from "node:test";

import type {
  RollbackStageRequest,
  StageArtifactVersion,
  VideoTaskStage,
} from "@firefly/schemas";

import {
  RevisionConflictError,
  StageConfirmationDeniedError,
  StageRollbackDeniedError,
  confirmVideoTaskStage,
  rollbackVideoTaskStage,
  type ConfirmStageCommand,
  type VideoTaskProductionRecord,
} from "../src/index.ts";

const occurredAt = "2026-08-19T03:00:00.000Z";

function artifact(
  id: string,
  stage: VideoTaskStage,
  version: number,
  dependencyId?: string,
  dependencyStage?: VideoTaskStage,
): StageArtifactVersion {
  return {
    id,
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    videoTaskId: "task_rollback",
    stage,
    version,
    content: {
      artifactId: `${id}_content`,
      schemaName: `${stage}_artifact`,
      schemaVersion: 1,
      contentHashSha256: version.toString(16).padStart(64, "0"),
    },
    dependencies:
      dependencyId && dependencyStage
        ? [{ kind: "stage_artifact", stage: dependencyStage, artifactVersionId: dependencyId }]
        : [{ kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" }],
    provenance: { kind: "human_confirmation", confirmationId: `${id}_confirmation` },
    createdAt: `2026-08-19T0${Math.min(version, 9)}:00:00.000Z`,
    createdBy: "account_owner",
  };
}

function completedRecord(): VideoTaskProductionRecord {
  const versions = [
    artifact("strategy_v1", "strategy", 1),
    artifact("strategy_v2", "strategy", 2),
    artifact("asset_v1", "asset_matching", 1, "strategy_v2", "strategy"),
    artifact("script_v1", "script", 1, "asset_v1", "asset_matching"),
    artifact("storyboard_v1", "storyboard", 1, "script_v1", "script"),
    artifact("preview_v1", "video_preview", 1, "storyboard_v1", "storyboard"),
    artifact("delivery_v1", "delivery", 1, "preview_v1", "video_preview"),
    artifact("script_unrelated", "script", 2, "strategy_v1", "strategy"),
  ];
  return {
    schemaVersion: 2,
    videoTask: {
      id: "task_rollback",
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      name: "版本回退任务",
      ownerAccountId: "account_owner",
      status: "completed",
      currentStage: "delivery",
      stageStatus: "confirmed",
      revision: 12,
      vehicleSnapshotId: "vehicle_snapshot_1",
      audience: "年轻家庭",
      theme: "城市出行",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-18T08:00:00.000Z",
      createdBy: "account_owner",
      updatedAt: "2026-08-19T02:00:00.000Z",
      updatedBy: "account_owner",
    },
    stageArtifactVersions: versions,
    stageConfirmations: [],
    activeStageArtifactVersionIds: {
      strategy: "strategy_v2",
      asset_matching: "asset_v1",
      script: "script_v1",
      storyboard: "storyboard_v1",
      video_preview: "preview_v1",
      delivery: "delivery_v1",
    },
    stageRollbacks: [],
    stageArtifactInvalidations: [],
  };
}

function request(
  stage: VideoTaskStage = "strategy",
  targetArtifactVersionId = "strategy_v1",
): RollbackStageRequest {
  return {
    expectedTaskRevision: 12,
    stage,
    targetArtifactVersionId,
    reason: "恢复已审核的历史方案",
  };
}

function context(actorAccountId = "account_owner") {
  let sequence = 0;
  return {
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    actorAccountId,
    occurredAt,
    createId: (kind: "rollback" | "invalidation") => `${kind}_${++sequence}`,
  };
}

test("rollback selects the historical version and recursively invalidates every dependent artifact", () => {
  const source = completedRecord();
  const result = rollbackVideoTaskStage(source, request(), context());

  assert.equal(result.videoTask.revision, 13);
  assert.equal(result.videoTask.status, "active");
  assert.equal(result.videoTask.currentStage, "asset_matching");
  assert.equal(result.videoTask.stageStatus, "in_progress");
  assert.equal(result.activeStageArtifactVersionIds.strategy, "strategy_v1");
  assert.equal(result.activeStageArtifactVersionIds.asset_matching, undefined);
  assert.equal(result.activeStageArtifactVersionIds.script, undefined);
  assert.equal(result.activeStageArtifactVersionIds.storyboard, undefined);
  assert.equal(result.activeStageArtifactVersionIds.video_preview, undefined);
  assert.equal(result.activeStageArtifactVersionIds.delivery, undefined);
  assert.deepEqual(
    result.stageArtifactInvalidations.map((item) => item.artifactVersionId),
    ["asset_v1", "script_v1", "storyboard_v1", "preview_v1", "delivery_v1"],
  );
  assert.deepEqual(result.stageArtifactInvalidations[0]?.cause, {
    kind: "rollback",
    reasonCode: "upstream_rollback",
    rollbackId: "rollback_1",
  });
  assert.deepEqual(result.stageArtifactInvalidations[1]?.cause, {
    kind: "upstream_invalidation",
    reasonCode: "upstream_invalidation",
    invalidationId: "invalidation_2",
  });
  assert.equal(
    result.stageArtifactInvalidations.some((item) => item.artifactVersionId === "script_unrelated"),
    false,
  );
  assert.deepEqual(result.stageRollbacks[0], {
    id: "rollback_1",
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    videoTaskId: "task_rollback",
    stage: "strategy",
    fromArtifactVersionId: "strategy_v2",
    toArtifactVersionId: "strategy_v1",
    expectedTaskRevision: 12,
    reason: "恢复已审核的历史方案",
    requestedBy: "account_owner",
    invalidationIds: [
      "invalidation_2",
      "invalidation_3",
      "invalidation_4",
      "invalidation_5",
      "invalidation_6",
    ],
    occurredAt,
  });

  assert.equal(source.videoTask.revision, 12);
  assert.equal(source.stageRollbacks.length, 0);
  assert.equal(source.stageArtifactInvalidations.length, 0);
  assert.equal(source.activeStageArtifactVersionIds.strategy, "strategy_v2");
  assert.notEqual(result.stageArtifactVersions, source.stageArtifactVersions);
  assert.deepEqual(result.stageArtifactVersions, source.stageArtifactVersions);
});

test("rolling back delivery changes the selection without reopening a completed workflow", () => {
  const source = completedRecord();
  source.stageArtifactVersions.push(
    artifact("delivery_v2", "delivery", 2, "preview_v1", "video_preview"),
  );
  source.activeStageArtifactVersionIds.delivery = "delivery_v2";
  const result = rollbackVideoTaskStage(source, request("delivery", "delivery_v1"), context());

  assert.equal(result.videoTask.status, "completed");
  assert.equal(result.videoTask.currentStage, "delivery");
  assert.equal(result.videoTask.stageStatus, "confirmed");
  assert.equal(result.activeStageArtifactVersionIds.delivery, "delivery_v1");
  assert.equal(result.stageArtifactInvalidations.length, 0);
  assert.deepEqual(result.stageRollbacks[0]?.invalidationIds, []);
});

test("a later rollback can reselect any other valid confirmed version", () => {
  const rollbackContext = context();
  const first = rollbackVideoTaskStage(completedRecord(), request(), rollbackContext);
  const secondRequest = request("strategy", "strategy_v2");
  secondRequest.expectedTaskRevision = first.videoTask.revision;
  const second = rollbackVideoTaskStage(first, secondRequest, rollbackContext);

  assert.equal(second.activeStageArtifactVersionIds.strategy, "strategy_v2");
  assert.equal(second.videoTask.revision, 14);
  assert.equal(second.stageRollbacks.length, 2);
  assert.deepEqual(second.stageRollbacks[1]?.invalidationIds, ["invalidation_8"]);
  assert.equal(second.stageArtifactInvalidations.at(-1)?.artifactVersionId, "script_unrelated");
  assert.equal(second.stageArtifactInvalidations.length, 6);
});

test("rollback rejects stale revisions, non-owners, wrong stages, current versions, and invalid targets", () => {
  const source = completedRecord();
  const stale = request();
  stale.expectedTaskRevision = 11;
  assert.throws(() => rollbackVideoTaskStage(source, stale, context()), RevisionConflictError);
  assert.throws(
    () => rollbackVideoTaskStage(source, request(), context("account_agent")),
    StageRollbackDeniedError,
  );
  assert.throws(
    () => rollbackVideoTaskStage(source, request("script", "strategy_v1"), context()),
    StageRollbackDeniedError,
  );
  assert.throws(
    () => rollbackVideoTaskStage(source, request("strategy", "strategy_v2"), context()),
    StageRollbackDeniedError,
  );
  const invalidated = completedRecord();
  invalidated.stageArtifactInvalidations.push({
    id: "old_invalidation",
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    videoTaskId: "task_rollback",
    stage: "strategy",
    artifactVersionId: "strategy_v1",
    reason: "上游已变化",
    invalidatedDependency: {
      kind: "vehicle_snapshot",
      vehicleSnapshotId: "vehicle_snapshot_1",
    },
    cause: { kind: "rollback", reasonCode: "upstream_rollback", rollbackId: "old_rollback" },
    occurredAt,
  });
  assert.throws(
    () => rollbackVideoTaskStage(invalidated, request(), context()),
    StageRollbackDeniedError,
  );
  assert.equal(source.stageRollbacks.length, 0);
});

test("new confirmations cannot reuse an invalidated or unselected stage artifact", () => {
  const rolledBack = rollbackVideoTaskStage(completedRecord(), request(), context());
  rolledBack.videoTask.currentStage = "script";
  rolledBack.videoTask.stageStatus = "awaiting_confirmation";
  const confirmation: ConfirmStageCommand = {
    expectedTaskRevision: rolledBack.videoTask.revision,
    stage: "script" as const,
    artifact: {
      artifactId: "script_regenerated",
      schemaName: "script_artifact",
      schemaVersion: 1,
      contentHashSha256: "f".repeat(64),
    },
    dependencies: [
      {
        kind: "stage_artifact",
        stage: "asset_matching",
        artifactVersionId: "asset_v1",
      },
    ],
  };
  assert.throws(
    () =>
      confirmVideoTaskStage(rolledBack, confirmation, {
        tenantId: "tenant_firefly",
        batchProjectId: "project_launch",
        actorAccountId: "account_owner",
        occurredAt,
        createId: (kind) => `${kind}_new`,
      }),
    StageConfirmationDeniedError,
  );

  confirmation.dependencies[0] = {
    kind: "stage_artifact",
    stage: "strategy",
    artifactVersionId: "strategy_v2",
  };
  assert.throws(
    () =>
      confirmVideoTaskStage(rolledBack, confirmation, {
        tenantId: "tenant_firefly",
        batchProjectId: "project_launch",
        actorAccountId: "account_owner",
        occurredAt,
        createId: (kind) => `${kind}_new`,
      }),
    StageConfirmationDeniedError,
  );
});

test("regenerated downstream work can be confirmed only against the selected rollback target", () => {
  const rolledBack = rollbackVideoTaskStage(completedRecord(), request(), context());
  rolledBack.videoTask.stageStatus = "awaiting_confirmation";
  const result = confirmVideoTaskStage(
    rolledBack,
    {
      expectedTaskRevision: rolledBack.videoTask.revision,
      stage: "asset_matching",
      artifact: {
        artifactId: "asset_regenerated",
        schemaName: "asset_matching_artifact",
        schemaVersion: 1,
        contentHashSha256: "e".repeat(64),
      },
      dependencies: [
        {
          kind: "stage_artifact",
          stage: "strategy",
          artifactVersionId: "strategy_v1",
        },
      ],
    },
    {
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      actorAccountId: "account_owner",
      occurredAt,
      createId: (kind) => `${kind}_regenerated`,
    },
  );

  assert.equal(result.videoTask.currentStage, "script");
  assert.equal(result.activeStageArtifactVersionIds.asset_matching, "artifact_version_regenerated");
  assert.equal(result.stageArtifactVersions.at(-1)?.version, 2);
  assert.equal(result.stageRollbacks.length, 1);
  assert.equal(result.stageArtifactInvalidations.length, 5);
});
