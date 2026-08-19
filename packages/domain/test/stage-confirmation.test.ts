import assert from "node:assert/strict";
import test from "node:test";

import type { VideoTaskStage } from "@firefly/schemas";

import {
  RevisionConflictError,
  StageConfirmationDeniedError,
  confirmVideoTaskStage,
  type ConfirmStageCommand,
  type VideoTaskProductionRecord,
} from "../src/index.ts";

const occurredAt = "2026-08-18T09:30:00.000Z";

function record(stage: VideoTaskStage = "strategy"): VideoTaskProductionRecord {
  return {
    schemaVersion: 3,
    videoTask: {
      id: "task_ws_102",
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      name: "新车上市视频",
      ownerAccountId: "account_owner",
      status: "active",
      currentStage: stage,
      stageStatus: "awaiting_confirmation",
      revision: 3,
      vehicleSnapshotId: "vehicle_snapshot_1",
      assetSnapshotId: "asset_snapshot_1",
      audience: "城市家庭",
      theme: "周末出行",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-18T08:00:00.000Z",
      createdBy: "account_owner",
      updatedAt: "2026-08-18T09:00:00.000Z",
      updatedBy: "account_owner",
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
  };
}

function command(stage: VideoTaskStage = "strategy"): ConfirmStageCommand {
  return {
    expectedTaskRevision: 3,
    stage,
    artifact: {
      artifactId: `artifact_${stage}`,
      schemaName: `${stage}_artifact`,
      schemaVersion: 1,
      contentHashSha256: "a".repeat(64),
    },
    dependencies: [{ kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" }],
    comment: "人工验收通过",
  };
}

function context(actorAccountId = "account_owner") {
  let sequence = 0;
  return {
    tenantId: "tenant_firefly",
    batchProjectId: "project_launch",
    actorAccountId,
    occurredAt,
    createId: (kind: "artifact_version" | "confirmation") => `${kind}_${++sequence}`,
  };
}

test("human confirmation atomically creates a linked immutable version and advances the task", () => {
  const source = record();
  const input = command();
  const result = confirmVideoTaskStage(source, input, context());

  assert.equal(result.videoTask.revision, 4);
  assert.equal(result.videoTask.currentStage, "asset_matching");
  assert.equal(result.videoTask.stageStatus, "in_progress");
  assert.equal(result.videoTask.updatedBy, "account_owner");
  assert.equal(result.stageArtifactVersions[0]?.version, 1);
  assert.equal(result.stageConfirmations[0]?.source, "human_action");
  assert.equal(result.stageConfirmations[0]?.artifactVersionId, result.stageArtifactVersions[0]?.id);
  assert.deepEqual(result.stageArtifactVersions[0]?.provenance, {
    kind: "human_confirmation",
    confirmationId: result.stageConfirmations[0]?.id,
  });

  input.artifact.artifactId = "mutated_draft";
  input.dependencies[0] = { kind: "asset_snapshot", assetSnapshotId: "mutated_snapshot" };
  assert.equal(result.stageArtifactVersions[0]?.content.artifactId, "artifact_strategy");
  assert.deepEqual(result.stageArtifactVersions[0]?.dependencies, [
    { kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" },
  ]);
  assert.equal(source.stageArtifactVersions.length, 0);
  assert.equal(source.stageConfirmations.length, 0);
  assert.equal(source.videoTask.revision, 3);
});

test("artifact version numbers are append-only within each stage", () => {
  const source = record();
  const first = confirmVideoTaskStage(source, command(), context());
  const historical = first.stageArtifactVersions[0];
  assert.ok(historical);
  const revisited = record();
  revisited.stageArtifactVersions = [historical];
  const second = confirmVideoTaskStage(revisited, command(), context());
  assert.deepEqual(
    second.stageArtifactVersions.map((item) => item.version),
    [1, 2],
  );
  assert.equal(second.stageArtifactVersions[0]?.content.artifactId, "artifact_strategy");
});

test("all six stages use the same human confirmation gate and delivery completes the task", () => {
  const stages: VideoTaskStage[] = [
    "strategy",
    "asset_matching",
    "script",
    "storyboard",
    "video_preview",
    "delivery",
  ];
  let current = record(stages[0]);
  let expectedRevision = current.videoTask.revision;

  for (const stage of stages) {
    current.videoTask.currentStage = stage;
    current.videoTask.stageStatus = "awaiting_confirmation";
    current.videoTask.revision = expectedRevision;
    const input = command(stage);
    input.expectedTaskRevision = expectedRevision;
    current = confirmVideoTaskStage(current, input, context());
    expectedRevision += 1;
  }

  assert.equal(current.stageConfirmations.length, 6);
  assert.equal(current.stageArtifactVersions.length, 6);
  assert.equal(current.videoTask.status, "completed");
  assert.equal(current.videoTask.currentStage, "delivery");
  assert.equal(current.videoTask.stageStatus, "confirmed");
});

test("stale revisions and non-owner or out-of-scope sessions cannot create audit records", () => {
  const source = record();
  const stale = command();
  stale.expectedTaskRevision = 2;
  assert.throws(() => confirmVideoTaskStage(source, stale, context()), RevisionConflictError);
  assert.throws(
    () => confirmVideoTaskStage(source, command(), context("account_agent")),
    StageConfirmationDeniedError,
  );
  assert.throws(
    () =>
      confirmVideoTaskStage(source, command(), {
        ...context(),
        tenantId: "tenant_other",
      }),
    StageConfirmationDeniedError,
  );
  assert.equal(source.stageArtifactVersions.length, 0);
  assert.equal(source.stageConfirmations.length, 0);
});

test("only the current active stage awaiting confirmation can be confirmed", () => {
  const wrongStage = command("script");
  assert.throws(
    () => confirmVideoTaskStage(record("strategy"), wrongStage, context()),
    StageConfirmationDeniedError,
  );
  const inProgress = record();
  inProgress.videoTask.stageStatus = "in_progress";
  assert.throws(
    () => confirmVideoTaskStage(inProgress, command(), context()),
    StageConfirmationDeniedError,
  );
  const cancelled = record();
  cancelled.videoTask.status = "cancelled";
  assert.throws(
    () => confirmVideoTaskStage(cancelled, command(), context()),
    StageConfirmationDeniedError,
  );
});
