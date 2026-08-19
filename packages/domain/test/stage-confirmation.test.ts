import assert from "node:assert/strict";
import test from "node:test";

import type { VideoTaskStage } from "@firefly/schemas";

import {
  RevisionConflictError,
  StageConfirmationDeniedError,
  confirmVideoTaskStage,
  deriveStageConfirmationDependencies,
  type ConfirmStageCommand,
  type VideoTaskProductionRecord,
} from "../src/index.ts";

const occurredAt = "2026-08-18T09:30:00.000Z";

function record(stage: VideoTaskStage = "strategy"): VideoTaskProductionRecord {
  return {
    schemaVersion: 6,
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
    taskVehicleSnapshots: [{
      id: "vehicle_snapshot_1",
      projectId: "project_launch",
      vehicleId: "vehicle_e5",
      vehicleVersion: 1,
      brandId: "brand_firefly",
      brand: "萤火汽车",
      series: "E5",
      modelYear: 2026,
      trim: "长续航版",
      parameters: {},
      fixedClaims: [],
      optionalClaims: [],
      prohibitedClaims: [],
      referenceAssetIds: [],
      createdAt: "2026-08-18T08:00:00.000Z",
      createdBy: "account_owner",
    }],
    taskAssetSnapshots: [{
      id: "asset_snapshot_1",
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      videoTaskId: "task_ws_102",
      version: 1,
      sourceProjectAssetPoolRevision: 1,
      vehicleSnapshotId: "vehicle_snapshot_1",
      assets: [{
        assetId: "asset_vehicle_1",
        version: 1,
        source: "company_catalog",
        sourceProvider: "mock_company_assets",
        category: "vehicle",
        vehicleId: "vehicle_e5",
      }],
      createdAt: "2026-08-18T08:01:00.000Z",
      createdBy: "account_owner",
    }],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
    stageMutationReceipts: [],
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
    dependencies: [
      { kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" },
      { kind: "asset_snapshot", assetSnapshotId: "asset_snapshot_1" },
    ],
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

function recordWithConfirmedDirectUpstream(
  stage: Exclude<VideoTaskStage, "strategy"> = "asset_matching",
): VideoTaskProductionRecord {
  const upstreamStages: Record<Exclude<VideoTaskStage, "strategy">, VideoTaskStage> = {
    asset_matching: "strategy",
    script: "asset_matching",
    storyboard: "script",
    video_preview: "storyboard",
    delivery: "video_preview",
  };
  const upstreamStage = upstreamStages[stage];
  const artifactVersionId = `${upstreamStage}_confirmed_v1`;
  const confirmationId = `${upstreamStage}_confirmation_1`;
  const source = record(stage);
  source.stageArtifactVersions.push({
    id: artifactVersionId,
    tenantId: source.videoTask.tenantId,
    batchProjectId: source.videoTask.batchProjectId,
    videoTaskId: source.videoTask.id,
    stage: upstreamStage,
    version: 1,
    content: {
      artifactId: `${upstreamStage}_content_1`,
      schemaName: `${upstreamStage}_artifact`,
      schemaVersion: 1,
      contentHashSha256: "b".repeat(64),
    },
    dependencies: [
      { kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" },
      { kind: "asset_snapshot", assetSnapshotId: "asset_snapshot_1" },
    ],
    provenance: { kind: "human_confirmation", confirmationId },
    createdAt: "2026-08-18T09:00:00.000Z",
    createdBy: "account_owner",
  });
  source.stageConfirmations.push({
    id: confirmationId,
    tenantId: source.videoTask.tenantId,
    batchProjectId: source.videoTask.batchProjectId,
    videoTaskId: source.videoTask.id,
    stage: upstreamStage,
    artifactVersionId,
    decision: "confirmed",
    source: "human_action",
    expectedTaskRevision: 2,
    actorAccountId: "account_owner",
    occurredAt: "2026-08-18T09:00:00.000Z",
  });
  source.activeStageArtifactVersionIds[upstreamStage] = artifactVersionId;
  return source;
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
    { kind: "asset_snapshot", assetSnapshotId: "asset_snapshot_1" },
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
    input.dependencies = deriveStageConfirmationDependencies(current, stage);
    current = confirmVideoTaskStage(current, input, context());
    expectedRevision += 1;
  }

  assert.equal(current.stageConfirmations.length, 6);
  assert.equal(current.stageArtifactVersions.length, 6);
  assert.equal(current.videoTask.status, "completed");
  assert.equal(current.videoTask.currentStage, "delivery");
  assert.equal(current.videoTask.stageStatus, "confirmed");
});

test("derived confirmation dependencies have a fixed snapshot-first order", () => {
  assert.deepEqual(deriveStageConfirmationDependencies(record("strategy"), "strategy"), [
    { kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" },
    { kind: "asset_snapshot", assetSnapshotId: "asset_snapshot_1" },
  ]);

  const nonStrategyStages: Exclude<VideoTaskStage, "strategy">[] = [
    "asset_matching",
    "script",
    "storyboard",
    "video_preview",
    "delivery",
  ];
  for (const stage of nonStrategyStages) {
    const source = recordWithConfirmedDirectUpstream(stage);
    const upstreamArtifact = source.stageArtifactVersions[0];
    assert.ok(upstreamArtifact);
    assert.deepEqual(deriveStageConfirmationDependencies(source, stage), [
      { kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" },
      { kind: "asset_snapshot", assetSnapshotId: "asset_snapshot_1" },
      {
        kind: "stage_artifact",
        stage: upstreamArtifact.stage,
        artifactVersionId: upstreamArtifact.id,
      },
    ]);
  }
});

test("derivation rejects missing locked vehicle or asset snapshots", () => {
  const missingVehicle = record();
  missingVehicle.taskVehicleSnapshots = [];
  assert.throws(
    () => deriveStageConfirmationDependencies(missingVehicle, "strategy"),
    StageConfirmationDeniedError,
  );

  const missingAsset = record();
  missingAsset.taskAssetSnapshots = [];
  assert.throws(
    () => deriveStageConfirmationDependencies(missingAsset, "strategy"),
    StageConfirmationDeniedError,
  );
});

test("non-strategy derivation requires the current valid direct upstream", () => {
  assert.throws(
    () => deriveStageConfirmationDependencies(record("asset_matching"), "asset_matching"),
    StageConfirmationDeniedError,
  );

  const migratedUpstream = recordWithConfirmedDirectUpstream();
  const migratedArtifact = migratedUpstream.stageArtifactVersions[0];
  assert.ok(migratedArtifact);
  migratedArtifact.provenance = {
    kind: "migrated_confirmation",
    legacyApprovalId: "legacy_approval_1",
  };
  migratedUpstream.stageConfirmations = [];
  assert.deepEqual(
    deriveStageConfirmationDependencies(migratedUpstream, "asset_matching"),
    [
      { kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" },
      { kind: "asset_snapshot", assetSnapshotId: "asset_snapshot_1" },
      {
        kind: "stage_artifact",
        stage: "strategy",
        artifactVersionId: migratedArtifact.id,
      },
    ],
  );

  const invalidatedUpstream = recordWithConfirmedDirectUpstream();
  const invalidatedArtifact = invalidatedUpstream.stageArtifactVersions[0];
  assert.ok(invalidatedArtifact);
  invalidatedUpstream.stageArtifactInvalidations.push({
    id: "invalidation_1",
    tenantId: invalidatedUpstream.videoTask.tenantId,
    batchProjectId: invalidatedUpstream.videoTask.batchProjectId,
    videoTaskId: invalidatedUpstream.videoTask.id,
    stage: invalidatedArtifact.stage,
    artifactVersionId: invalidatedArtifact.id,
    reason: "上游版本已回退",
    invalidatedDependency: {
      kind: "vehicle_snapshot",
      vehicleSnapshotId: "vehicle_snapshot_1",
    },
    cause: {
      kind: "rollback",
      reasonCode: "upstream_rollback",
      rollbackId: "rollback_1",
    },
    occurredAt,
  });
  assert.throws(
    () => deriveStageConfirmationDependencies(invalidatedUpstream, "asset_matching"),
    StageConfirmationDeniedError,
  );

  const danglingUpstream = recordWithConfirmedDirectUpstream();
  danglingUpstream.activeStageArtifactVersionIds.strategy = "strategy_missing";
  assert.throws(
    () => deriveStageConfirmationDependencies(danglingUpstream, "asset_matching"),
    StageConfirmationDeniedError,
  );
});

test("confirmation rejects omitted, extra, reordered, or replaced dependencies", () => {
  const source = recordWithConfirmedDirectUpstream();
  const expectedDependencies = deriveStageConfirmationDependencies(source, "asset_matching");
  const invalidDependencies = [
    expectedDependencies.slice(0, -1),
    [
      ...expectedDependencies,
      { kind: "stage_artifact" as const, stage: "strategy" as const, artifactVersionId: "extra_v1" },
    ],
    [expectedDependencies[1]!, expectedDependencies[0]!, expectedDependencies[2]!],
    [
      expectedDependencies[0]!,
      expectedDependencies[1]!,
      { kind: "stage_artifact" as const, stage: "strategy" as const, artifactVersionId: "replacement_v1" },
    ],
  ];

  for (const dependencies of invalidDependencies) {
    const input = command("asset_matching");
    input.dependencies = dependencies;
    assert.throws(
      () => confirmVideoTaskStage(source, input, context()),
      StageConfirmationDeniedError,
    );
  }
  assert.equal(source.stageArtifactVersions.length, 1);
  assert.equal(source.stageConfirmations.length, 1);
  assert.equal(source.videoTask.revision, 3);
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
