import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  AssetReference,
  Strategy,
  StrategyApproval,
  VehicleSnapshot,
  WorkStatus,
} from "@firefly/schemas";

import type { LocalWorkRecord } from "../src/business-store.ts";
import {
  legacyWorkStatusMigration,
  migrateLegacyWorkRecords,
  type LegacyStrategyGeneration,
  type LegacyWorkMigrationConfig,
} from "../src/legacy-work-migration.ts";
import { LocalVideoTaskProductionStore } from "../src/video-task-store.ts";

const vehicleId = "vehicle_firefly_e5_2026_long_range";
const snapshotId = "snapshot_legacy_e5_v1";
const timestamp = "2026-08-18T08:00:00.000Z";

const assets: AssetReference[] = [
  {
    assetId: "asset_style_firefly_demo_clean",
    version: 1,
    source: "company_catalog",
    sourceProvider: "mock_company_assets",
    category: "visual_style",
  },
  {
    assetId: "asset_firefly_demo_e5_hero",
    version: 1,
    source: "company_catalog",
    sourceProvider: "mock_company_assets",
    category: "vehicle",
    vehicleId,
  },
];

function config(overrides: Partial<LegacyWorkMigrationConfig> = {}): LegacyWorkMigrationConfig {
  return {
    migrationId: "migration_ws307_v1",
    migrationOccurredAt: "2026-08-19T12:00:00.000Z",
    migrationActorAccountId: "account_migration",
    tenantId: "tenant_firefly",
    brandId: "brand_firefly_demo",
    brandName: "萤火汽车",
    vehicleId,
    vehicleVersion: 1,
    batchProjectId: "project_local",
    assetPoolId: "asset_pool_legacy_e5",
    batchName: "历史作品迁移",
    aspectRatio: "9:16",
    visualStylePresetId: "asset_style_firefly_demo_clean",
    projectAssets: assets,
    taskOwnerAccountId: "account_creator_a",
    taskCreatedByAccountId: "account_creator_a",
    taskNamePrefix: "历史广告作品",
    defaultAudience: "历史受众未知",
    defaultTheme: "历史主题未知",
    defaultDurationSeconds: 30,
    defaultPlatformTags: ["douyin", "legacy"],
    ...overrides,
  };
}

function snapshot(overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    id: snapshotId,
    projectId: "project_local",
    vehicleId,
    vehicleVersion: 1,
    brandId: "brand_firefly_demo",
    brand: "萤火示例汽车",
    series: "萤火 E5",
    modelYear: 2026,
    trim: "长续航示例版",
    color: "萤火绿",
    parameters: { seats: 5, energyType: "纯电" },
    fixedClaims: [{
      id: "claim_range_550",
      kind: "fixed",
      name: "CLTC 续航",
      statement: "CLTC 续航 550 公里",
      value: 550,
      unit: "公里",
      evidence: {
        sourceName: "历史车型配置表",
        sourceReference: "legacy-e5-v1#range",
        effectiveFrom: "2026-08-01",
      },
      requiredInVoiceover: true,
      requiredInSubtitle: true,
      mayRephrase: false,
      riskNotes: [],
    }],
    optionalClaims: [],
    prohibitedClaims: ["自动驾驶"],
    referenceAssetIds: ["asset_vehicle_front_001", "asset_vehicle_side_001"],
    createdAt: timestamp,
    createdBy: "creator_local",
    ...overrides,
  };
}

function strategy(
  workId: string,
  version = 1,
  overrides: Partial<Strategy> = {},
): Strategy {
  return {
    id: `strategy_${version}_${workId}`,
    workId,
    vehicleSnapshotId: snapshotId,
    version,
    status: "draft",
    audience: `家庭用户 ${version}`,
    theme: `周末出行 ${version}`,
    items: [{
      id: `strategy_item_${version}_${workId}`,
      claimId: "claim_range_550",
      kind: "fixed",
      title: "长续航",
      statement: "CLTC 续航 550 公里",
      rationale: "来自历史车型事实",
      order: 1,
      locked: version === 2,
      evidence: {
        sourceName: "历史车型配置表",
        sourceReference: "legacy-e5-v1#range",
        effectiveFrom: "2026-08-01",
      },
    }],
    model: version === 1 ? "legacy-model" : "human-edit",
    templateVersion: "legacy-template-v3",
    createdAt: `2026-08-18T0${version}:00:00.000Z`,
    createdBy: "creator_local",
    updatedAt: `2026-08-18T0${version}:30:00.000Z`,
    ...overrides,
  };
}

function approval(
  workId: string,
  strategyId: string,
  decision: "approved" | "rejected",
  sequence: number,
): StrategyApproval {
  return {
    id: `approval_${sequence}_${workId}`,
    workId,
    strategyId,
    decision,
    comment: decision === "approved" ? "人工审批通过" : "请保留锁定项后重试",
    actorId: "reviewer_local",
    occurredAt: `2026-08-18T0${sequence + 2}:00:00.000Z`,
  };
}

function record(
  workId: string,
  status: WorkStatus = "created",
  strategyVersions: Strategy[] = [],
  approvals: StrategyApproval[] = [],
  overrides: Partial<LocalWorkRecord> = {},
): LocalWorkRecord {
  return {
    schemaVersion: 1,
    work: {
      id: workId,
      projectId: "project_local",
      status,
      revision: Math.max(1, strategyVersions.length + approvals.length + 1),
      vehicleSnapshotId: snapshotId,
      createdAt: timestamp,
      updatedAt: "2026-08-18T10:00:00.000Z",
    },
    vehicleSnapshot: snapshot(),
    strategyVersions,
    approvals,
    ...overrides,
  };
}

function generationOf(value: unknown): LegacyStrategyGeneration {
  const generation = value as LegacyStrategyGeneration;
  assert.equal(generation.kind, "legacy_migration");
  return generation;
}

test("migration deterministically preserves task, snapshot, strategy locks, and full approval history", () => {
  const workId = "work_preserved_001";
  const first = strategy(workId, 1, { status: "rejected" });
  const second = strategy(workId, 2, { status: "approved" });
  const rejected = approval(workId, first.id, "rejected", 1);
  const approved = approval(workId, second.id, "approved", 2);
  const source = record(workId, "script_approved", [first, second], [rejected, approved], {
    work: {
      id: workId,
      projectId: "project_local",
      status: "script_approved",
      revision: 17,
      vehicleSnapshotId: snapshotId,
      createdAt: "2026-08-17T01:00:00.000Z",
      updatedAt: "2026-08-18T09:00:00.000Z",
    },
  });

  const migrated = migrateLegacyWorkRecords([source], config());
  const task = migrated.taskRecords[0]!;
  assert.equal(migrated.project.id, "project_local");
  assert.equal(
    migrated.project.name,
    "萤火汽车 萤火 E5 长续航示例版 9:16 历史作品迁移",
  );
  assert.deepEqual(
    migrated.assetPool.assets.map((asset) => asset.category),
    ["vehicle", "visual_style"],
  );
  assert.equal(task.videoTask.id, workId);
  assert.equal(task.videoTask.revision, 17);
  assert.equal(task.videoTask.createdAt, "2026-08-17T01:00:00.000Z");
  assert.equal(task.videoTask.updatedAt, "2026-08-18T09:00:00.000Z");
  assert.equal(task.videoTask.audience, second.audience);
  assert.equal(task.videoTask.theme, second.theme);
  assert.deepEqual(task.videoTask.platformTags, ["douyin", "legacy"]);
  assert.equal(task.taskVehicleSnapshots[0]?.id, snapshotId);
  assert.equal(task.taskVehicleSnapshots[0]?.projectId, "project_local");
  assert.deepEqual(task.taskVehicleSnapshots[0]?.referenceAssetIds, snapshot().referenceAssetIds);
  assert.equal(task.taskAssetSnapshots[0]?.createdAt, "2026-08-19T12:00:00.000Z");
  assert.equal(task.taskAssetSnapshots[0]?.createdBy, "account_migration");
  assert.equal(task.strategyDrafts.length, 2);
  assert.equal(task.strategyDrafts[1]?.items[0]?.locked, true);
  assert.equal(task.strategyDrafts[1]?.id, second.id);
  const firstGeneration = generationOf(task.strategyDrafts[0]?.generation);
  const secondGeneration = generationOf(task.strategyDrafts[1]?.generation);
  assert.deepEqual(firstGeneration, {
    kind: "legacy_migration",
    migratedFromSchemaVersion: 1,
    migrationId: "migration_ws307_v1",
    legacyStrategyId: first.id,
    legacyStrategyStatus: "rejected",
    model: "legacy-model",
    templateVersion: "legacy-template-v3",
    approvals: [{
      legacyApprovalId: rejected.id,
      decision: "rejected",
      actorAccountId: "reviewer_local",
      comment: "请保留锁定项后重试",
      occurredAt: rejected.occurredAt,
    }],
  });
  assert.equal(secondGeneration.approvals[0]?.legacyApprovalId, approved.id);
  assert.equal(secondGeneration.approvals[0]?.comment, "人工审批通过");
  const strategyArtifact = task.stageArtifactVersions.find(
    (artifact) => artifact.stage === "strategy",
  );
  const scriptArtifact = task.stageArtifactVersions.find(
    (artifact) => artifact.stage === "script",
  );
  const assetArtifact = task.stageArtifactVersions.find(
    (artifact) => artifact.stage === "asset_matching",
  );
  assert.deepEqual(strategyArtifact?.provenance, {
    kind: "migrated_confirmation",
    legacyApprovalId: approved.id,
  });
  assert.equal(strategyArtifact?.content.artifactId, second.id);
  assert.equal(
    strategyArtifact?.content.contentHashSha256,
    createHash("sha256").update(JSON.stringify(task.strategyDrafts[1])).digest("hex"),
  );
  assert.equal(strategyArtifact?.createdBy, "reviewer_local");
  assert.equal(strategyArtifact?.createdAt, approved.occurredAt);
  assert.deepEqual(strategyArtifact?.dependencies, [
    { kind: "vehicle_snapshot", vehicleSnapshotId: snapshotId },
  ]);
  assert.equal(scriptArtifact?.provenance.kind, "legacy_inferred");
  assert.deepEqual(scriptArtifact?.dependencies, [
    { kind: "vehicle_snapshot", vehicleSnapshotId: snapshotId },
    {
      kind: "stage_artifact",
      stage: "strategy",
      artifactVersionId: strategyArtifact?.id,
    },
  ]);
  assert.equal(assetArtifact?.provenance.kind, "legacy_inferred");
  assert.equal(assetArtifact?.createdAt, "2026-08-19T12:00:00.000Z");
  assert.deepEqual(assetArtifact?.dependencies, [
    { kind: "vehicle_snapshot", vehicleSnapshotId: snapshotId },
    { kind: "asset_snapshot", assetSnapshotId: task.videoTask.assetSnapshotId },
    {
      kind: "stage_artifact",
      stage: "script",
      artifactVersionId: scriptArtifact?.id,
    },
  ]);
  assert.equal(task.activeStageArtifactVersionIds.strategy, strategyArtifact?.id);
  assert.equal(task.activeStageArtifactVersionIds.script, scriptArtifact?.id);
  assert.equal(task.activeStageArtifactVersionIds.asset_matching, assetArtifact?.id);
  assert.deepEqual(task.stageConfirmations, []);
  assert.deepEqual(task.stageConfirmationRequests, []);
  assert.deepEqual(task.commandReceipts, []);
  assert.deepEqual(task.stageMutationReceipts, []);
  assert.deepEqual(migrated.summary, {
    sourceSchemaVersion: 1,
    workCount: 1,
    vehicleSnapshotCount: 1,
    canonicalizedVehicleSnapshotTimestampCount: 0,
    strategyVersionCount: 2,
    approvalCount: 2,
    inferredArtifactCount: 2,
    sourceFingerprintSha256: migrated.summary.sourceFingerprintSha256,
    configurationFingerprintSha256: migrated.summary.configurationFingerprintSha256,
    migrationFingerprintSha256: migrated.summary.migrationFingerprintSha256,
  });

  assert.deepEqual(
    migrateLegacyWorkRecords([structuredClone(source)], config()),
    migrated,
  );
});

test("strategy-approved legacy work waits in script without locking or inferring task assets", () => {
  const workId = "work_strategy_approved_waiting_script";
  const sourceStrategy = strategy(workId, 1, { status: "approved" });
  const migrated = migrateLegacyWorkRecords(
    [record(
      workId,
      "strategy_approved",
      [sourceStrategy],
      [approval(workId, sourceStrategy.id, "approved", 1)],
    )],
    config(),
  );
  const task = migrated.taskRecords[0]!;

  assert.equal(task.videoTask.currentStage, "script");
  assert.equal(task.videoTask.stageStatus, "in_progress");
  assert.equal(task.videoTask.assetSnapshotId, undefined);
  assert.deepEqual(task.taskAssetSnapshots, []);
  assert.deepEqual(task.stageArtifactVersions.map((artifact) => artifact.stage), ["strategy"]);
  assert.deepEqual(task.stageArtifactVersions[0]?.dependencies, [
    { kind: "vehicle_snapshot", vehicleSnapshotId: snapshotId },
  ]);
  assert.equal(task.activeStageArtifactVersionIds.script, undefined);
  assert.equal(task.activeStageArtifactVersionIds.asset_matching, undefined);
});

test("input order cannot change IDs, hashes, ordering, or the migration fingerprint", () => {
  const firstId = "work_deterministic_a";
  const secondId = "work_deterministic_b";
  const firstStrategy = strategy(firstId, 1, { status: "approved" });
  const secondStrategy = strategy(secondId, 1, { status: "approved" });
  const first = record(
    firstId,
    "export_ready",
    [firstStrategy],
    [approval(firstId, firstStrategy.id, "approved", 1)],
  );
  const second = record(
    secondId,
    "script_draft",
    [secondStrategy],
    [approval(secondId, secondStrategy.id, "approved", 1)],
  );
  const forward = migrateLegacyWorkRecords([first, second], config());
  const reverse = migrateLegacyWorkRecords([second, first], config());
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.taskRecords.map((item) => item.videoTask.id), [firstId, secondId]);
  assert.equal(forward.vehicleSnapshots.length, 1);
  const reorderedAssets = migrateLegacyWorkRecords(
    [first, second],
    config({ projectAssets: [...assets].reverse() }),
  );
  assert.deepEqual(reorderedAssets, forward);
  const changedDefaults = migrateLegacyWorkRecords(
    [first, second],
    config({ defaultDurationSeconds: 31 }),
  );
  assert.notEqual(
    changedDefaults.summary.configurationFingerprintSha256,
    forward.summary.configurationFingerprintSha256,
  );
  assert.notEqual(
    changedDefaults.summary.migrationFingerprintSha256,
    forward.summary.migrationFingerprintSha256,
  );
});

test("duplicate legacy snapshot IDs canonicalize only unstable capture timestamps", () => {
  const earlier = record("work_snapshot_earlier");
  const later = record("work_snapshot_later", "created", [], [], {
    vehicleSnapshot: snapshot({ createdAt: "2026-08-18T09:00:00.000Z" }),
  });
  const migrated = migrateLegacyWorkRecords([later, earlier], config());

  assert.equal(migrated.vehicleSnapshots.length, 1);
  assert.equal(migrated.vehicleSnapshots[0]?.createdAt, timestamp);
  assert.deepEqual(
    migrated.taskRecords.map((item) => item.taskVehicleSnapshots[0]?.createdAt),
    [timestamp, timestamp],
  );
  assert.equal(migrated.summary.vehicleSnapshotCount, 1);
  assert.equal(migrated.summary.canonicalizedVehicleSnapshotTimestampCount, 1);
});

test("all v1 statuses map explicitly and inferred artifacts form a direct upstream chain", () => {
  const statuses = Object.keys(legacyWorkStatusMigration) as WorkStatus[];
  const sources = statuses.map((status, index) => {
    const workId = `work_status_${index.toString().padStart(2, "0")}`;
    if (status === "created") return record(workId, status);
    const sourceStrategy = strategy(workId, 1, {
      status: status === "awaiting_strategy_approval"
        ? "awaiting_approval"
        : status === "strategy_draft"
          ? "draft"
          : "approved",
    });
    const advanced = [
      "strategy_approved",
      "script_draft",
      "awaiting_script_approval",
      "script_approved",
      "prompt_draft",
      "awaiting_prompt_approval",
      "prompt_approved",
      "storyboard_draft",
      "awaiting_storyboard_approval",
      "storyboard_approved",
      "rendering",
      "final_review",
      "export_ready",
      "exported",
    ].includes(status);
    return record(
      workId,
      status,
      [sourceStrategy],
      advanced ? [approval(workId, sourceStrategy.id, "approved", 1)] : [],
    );
  });
  const migrated = migrateLegacyWorkRecords(sources, config());
  for (const task of migrated.taskRecords) {
    const index = Number(task.videoTask.id.slice("work_status_".length));
    const status = statuses[index]!;
    assert.deepEqual(
      {
        taskStatus: task.videoTask.status,
        currentStage: task.videoTask.currentStage,
        stageStatus: task.videoTask.stageStatus,
      },
      legacyWorkStatusMigration[status],
    );
    const artifactsById = new Map(
      task.stageArtifactVersions.map((artifact) => [artifact.id, artifact] as const),
    );
    for (const artifact of task.stageArtifactVersions) {
      const upstream = artifact.dependencies.find((dependency) => dependency.kind === "stage_artifact");
      if (artifact.stage === "strategy") assert.equal(upstream, undefined);
      else {
        assert.ok(upstream?.kind === "stage_artifact");
        assert.ok(artifactsById.has(upstream.artifactVersionId));
      }
    }
    if (status === "awaiting_strategy_approval") {
      assert.equal(task.strategyDrafts[0]?.status, "awaiting_confirmation");
      assert.deepEqual(task.stageConfirmationRequests, []);
    }
    if (status === "awaiting_prompt_approval") {
      assert.equal(task.videoTask.currentStage, "storyboard");
      assert.equal(task.videoTask.stageStatus, "awaiting_confirmation");
      assert.equal(task.activeStageArtifactVersionIds.storyboard, undefined);
      assert.ok(task.activeStageArtifactVersionIds.script);
      assert.ok(task.activeStageArtifactVersionIds.asset_matching);
      assert.deepEqual(task.stageConfirmations, []);
    }
  }
  const strategyApproved = migrated.taskRecords.find(
    (task) => task.videoTask.id === `work_status_${statuses.indexOf("strategy_approved").toString().padStart(2, "0")}`,
  );
  assert.equal(strategyApproved?.videoTask.currentStage, "script");
  assert.equal(strategyApproved?.videoTask.assetSnapshotId, undefined);
  assert.deepEqual(strategyApproved?.taskAssetSnapshots, []);

  const scriptApproved = migrated.taskRecords.find(
    (task) => task.videoTask.id === `work_status_${statuses.indexOf("script_approved").toString().padStart(2, "0")}`,
  );
  assert.equal(scriptApproved?.videoTask.currentStage, "asset_matching");
  assert.ok(scriptApproved?.videoTask.assetSnapshotId);
  assert.equal(scriptApproved?.taskAssetSnapshots.length, 1);
  const exported = migrated.taskRecords.find(
    (task) => task.videoTask.id === `work_status_${(statuses.length - 1).toString().padStart(2, "0")}`,
  );
  assert.deepEqual(Object.keys(exported?.activeStageArtifactVersionIds ?? {}), [
    "strategy",
    "script",
    "asset_matching",
    "storyboard",
    "video_preview",
    "delivery",
  ]);
});

test("explicit task defaults are used only when v1 has no strategy values", () => {
  const migrated = migrateLegacyWorkRecords(
    [record("work_without_strategy")],
    config({
      defaultAudience: "显式默认受众",
      defaultTheme: "显式默认主题",
      defaultDurationSeconds: 45,
      defaultPlatformTags: ["wechat_channels"],
    }),
  );
  assert.deepEqual(migrated.taskRecords[0]?.videoTask, {
    id: "work_without_strategy",
    tenantId: "tenant_firefly",
    batchProjectId: "project_local",
    name: "历史广告作品 work_without_strategy",
    ownerAccountId: "account_creator_a",
    status: "active",
    currentStage: "strategy",
    stageStatus: "in_progress",
    revision: 1,
    vehicleSnapshotId: snapshotId,
    audience: "显式默认受众",
    theme: "显式默认主题",
    durationSeconds: 45,
    platformTags: ["wechat_channels"],
    createdAt: timestamp,
    createdBy: "account_creator_a",
    updatedAt: "2026-08-18T10:00:00.000Z",
    updatedBy: "account_migration",
  });
});

test("mapped legacy drafts and provenance pass the strict V7 aggregate Store", async () => {
  const workId = "work_store_round_trip";
  const waitingWorkId = "work_store_waiting_confirmation";
  const legacyStrategy = strategy(workId, 1, { status: "approved" });
  const waitingStrategy = strategy(waitingWorkId, 1, { status: "awaiting_approval" });
  const source = record(
    workId,
    "exported",
    [legacyStrategy],
    [approval(workId, legacyStrategy.id, "approved", 1)],
  );
  const waitingSource = record(
    waitingWorkId,
    "awaiting_strategy_approval",
    [waitingStrategy],
  );
  const [task, waitingTask] = migrateLegacyWorkRecords(
    [source, waitingSource],
    config(),
  ).taskRecords;
  assert.ok(task);
  assert.ok(waitingTask);
  const store = new LocalVideoTaskProductionStore(".data/test-legacy-work-migration", false);
  await store.save(task);
  await store.save(waitingTask);
  assert.deepEqual(await store.load(workId), task);
  assert.deepEqual(await store.load(waitingWorkId), waitingTask);
  assert.equal(waitingTask.videoTask.stageStatus, "awaiting_confirmation");
  assert.equal(waitingTask.strategyDrafts[0]?.generation.kind, "legacy_migration");
  assert.deepEqual(waitingTask.stageConfirmationRequests, []);
});

test("migration rejects cross-target, corrupt, ambiguous, and silently defaulted inputs", () => {
  const valid = record("work_valid");
  assert.throws(
    () => migrateLegacyWorkRecords([], config()),
    /At least one legacy Work record/u,
  );
  assert.throws(
    () => migrateLegacyWorkRecords([valid, structuredClone(valid)], config()),
    /duplicate Work IDs/u,
  );
  assert.throws(
    () => migrateLegacyWorkRecords([record("work_cross_vehicle", "created", [], [], {
      vehicleSnapshot: snapshot({ vehicleId: "vehicle_other" }),
    })], config()),
    /outside the configured migration target/u,
  );
  const nonContiguousId = "work_non_contiguous";
  assert.throws(
    () => migrateLegacyWorkRecords([
      record(nonContiguousId, "strategy_draft", [strategy(nonContiguousId, 2)]),
    ], config()),
    /non-contiguous strategy history/u,
  );
  assert.throws(
    () => migrateLegacyWorkRecords([record("work_advanced_without_strategy", "exported")], config()),
    /no strategy history/u,
  );
  assert.throws(
    () => migrateLegacyWorkRecords([valid], config({
      projectAssets: assets.filter((asset) => asset.category !== "visual_style"),
    })),
    /include the target vehicle and visual style/u,
  );
  assert.throws(
    () => migrateLegacyWorkRecords([valid], config({ defaultAudience: " " })),
    /Default audience/u,
  );

  const conflicting = record("work_conflicting_snapshot", "created", [], [], {
    vehicleSnapshot: snapshot({ color: "不同颜色" }),
  });
  assert.throws(
    () => migrateLegacyWorkRecords([valid, conflicting], config()),
    /conflicting contents/u,
  );
});
