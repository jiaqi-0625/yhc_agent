import assert from "node:assert/strict";
import test from "node:test";

import type { VideoTaskProductionRecord } from "../src/index.ts";
import {
  AssetMatchingRevisionDeniedError,
  reopenAssetMatching,
} from "../src/index.ts";

function record(): VideoTaskProductionRecord {
  const artifacts = [
    { id: "strategy_v1", stage: "strategy", dependency: { kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" } },
    { id: "script_v1", stage: "script", dependency: { kind: "stage_artifact", stage: "strategy", artifactVersionId: "strategy_v1" } },
    { id: "asset_v1", stage: "asset_matching", dependency: { kind: "stage_artifact", stage: "script", artifactVersionId: "script_v1" } },
  ] as const;
  return {
    schemaVersion: 7,
    videoTask: {
      id: "task_presenter",
      tenantId: "tenant_firefly",
      batchProjectId: "project_presenter",
      name: "人物口播",
      ownerAccountId: "account_owner",
      status: "active",
      currentStage: "storyboard",
      stageStatus: "awaiting_confirmation",
      revision: 8,
      vehicleSnapshotId: "vehicle_snapshot_1",
      assetSnapshotId: "asset_snapshot_1",
      audience: "购车用户",
      theme: "人物口播",
      durationSeconds: 10,
      platformTags: ["douyin"],
      createdAt: "2026-08-21T01:00:00.000Z",
      createdBy: "account_owner",
      updatedAt: "2026-08-21T02:00:00.000Z",
      updatedBy: "account_owner",
    },
    stageArtifactVersions: artifacts.map((item, index) => ({
      id: item.id,
      tenantId: "tenant_firefly",
      batchProjectId: "project_presenter",
      videoTaskId: "task_presenter",
      stage: item.stage,
      version: 1,
      content: {
        artifactId: `${item.id}_content`,
        schemaName: `${item.stage}_artifact`,
        schemaVersion: 1,
        contentHashSha256: String(index + 1).repeat(64),
      },
      dependencies: [item.dependency],
      provenance: { kind: "human_confirmation", confirmationId: `${item.id}_confirmation` },
      createdAt: `2026-08-21T0${index + 1}:00:00.000Z`,
      createdBy: "account_owner",
    })),
    stageConfirmations: artifacts.map((item, index) => ({
      id: `${item.id}_confirmation`,
      tenantId: "tenant_firefly",
      batchProjectId: "project_presenter",
      videoTaskId: "task_presenter",
      stage: item.stage,
      artifactVersionId: item.id,
      decision: "confirmed",
      source: "human_action",
      expectedTaskRevision: index + 1,
      actorAccountId: "account_owner",
      occurredAt: `2026-08-21T0${index + 1}:00:00.000Z`,
    })),
    activeStageArtifactVersionIds: {
      strategy: "strategy_v1",
      script: "script_v1",
      asset_matching: "asset_v1",
    },
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskVehicleSnapshots: [],
    taskAssetSnapshots: [],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
    stageMutationReceipts: [],
  };
}

const request = {
  requestId: "asset_reopen_1",
  expectedTaskRevision: 8,
  reason: "更换人物口播主播",
};

test("reopening confirmed asset matching preserves history and returns to script-driven selection", () => {
  const result = reopenAssetMatching(record(), request, {
    tenantId: "tenant_firefly",
    batchProjectId: "project_presenter",
    actorAccountId: "account_owner",
    occurredAt: "2026-08-21T03:00:00.000Z",
    createInvalidationId: () => "invalidation_asset_v1",
  });

  assert.equal(result.videoTask.currentStage, "asset_matching");
  assert.equal(result.videoTask.stageStatus, "in_progress");
  assert.equal(result.videoTask.assetSnapshotId, undefined);
  assert.equal(result.videoTask.revision, 9);
  assert.equal(result.activeStageArtifactVersionIds.asset_matching, undefined);
  assert.equal(result.stageArtifactVersions.some(({ id }) => id === "asset_v1"), true);
  assert.deepEqual(result.stageArtifactInvalidations[0]?.cause, {
    kind: "manual_revision",
    reasonCode: "asset_selection_revision",
    requestId: "asset_reopen_1",
    requestedBy: "account_owner",
    expectedTaskRevision: 8,
  });
});

test("asset matching cannot be reopened after storyboard confirmation or by another account", () => {
  const confirmed = record();
  confirmed.videoTask.currentStage = "video_preview";
  assert.throws(
    () => reopenAssetMatching(confirmed, request, {
      tenantId: "tenant_firefly",
      batchProjectId: "project_presenter",
      actorAccountId: "account_owner",
      occurredAt: "2026-08-21T03:00:00.000Z",
      createInvalidationId: () => "invalidation_1",
    }),
    AssetMatchingRevisionDeniedError,
  );
  assert.throws(
    () => reopenAssetMatching(record(), request, {
      tenantId: "tenant_firefly",
      batchProjectId: "project_presenter",
      actorAccountId: "account_other",
      occurredAt: "2026-08-21T03:00:00.000Z",
      createInvalidationId: () => "invalidation_1",
    }),
    AssetMatchingRevisionDeniedError,
  );
});
