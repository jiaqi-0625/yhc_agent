import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VideoTaskProductionRecord } from "@firefly/domain";

import {
  LocalVideoTaskProductionStore,
  type VideoTaskCreationMetadata,
} from "../src/video-task-store.ts";

function record(
  id = "task_launch_hero",
  name = "首发主片",
  tenantId = "tenant_firefly",
  batchProjectId = "project_e5_launch",
): VideoTaskProductionRecord {
  return {
    schemaVersion: 5,
    videoTask: {
      id,
      tenantId,
      batchProjectId,
      name,
      ownerAccountId: "account_creator",
      status: "active",
      currentStage: "strategy",
      stageStatus: "in_progress",
      revision: 1,
      audience: "城市家庭用户",
      theme: "夏季上市",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-19T08:00:00.000Z",
      createdBy: "account_creator",
      updatedAt: "2026-08-19T08:00:00.000Z",
      updatedBy: "account_creator",
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskAssetSnapshots: [],
    taskVehicleSnapshots: [],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
  };
}

function metadata(
  requestId = "request_create_task",
  payloadHash = "payload_hash_v1",
): VideoTaskCreationMetadata {
  return { requestId, actorAccountId: "account_creator", payloadHash };
}

function recordWithCommandState(): VideoTaskProductionRecord {
  const value = record();
  value.videoTask = {
    ...value.videoTask,
    vehicleSnapshotId: "vehicle_snapshot_e5_v1",
    stageStatus: "awaiting_confirmation",
    revision: 3,
  };
  value.taskVehicleSnapshots = [{
    id: "vehicle_snapshot_e5_v1",
    projectId: value.videoTask.batchProjectId,
    vehicleId: "vehicle_e5",
    vehicleVersion: 1,
    brandId: "brand_firefly",
    brand: "萤火汽车",
    series: "E5",
    modelYear: 2026,
    trim: "长续航版",
    parameters: { rangeKm: 520 },
    fixedClaims: [],
    optionalClaims: [],
    prohibitedClaims: [],
    referenceAssetIds: [],
    createdAt: "2026-08-19T08:00:00.000Z",
    createdBy: "account_creator",
  }];
  value.strategyDrafts = [{
    schemaVersion: 1,
    id: "strategy_draft_1",
    tenantId: value.videoTask.tenantId,
    batchProjectId: value.videoTask.batchProjectId,
    videoTaskId: value.videoTask.id,
    vehicleSnapshotId: "vehicle_snapshot_e5_v1",
    version: 1,
    status: "awaiting_confirmation",
    audience: "城市家庭用户",
    theme: "夏季上市",
    items: [{
      id: "strategy_item_1",
      claimId: "claim_range",
      kind: "fixed",
      title: "长续航",
      statement: "CLTC 续航 520 公里",
      rationale: "覆盖家庭出行需求",
      order: 1,
      locked: false,
    }],
    validation: {
      valid: true,
      issues: [{
        code: "AIC-STRATEGY-TONE_REVIEW",
        severity: "warning",
        message: "建议人工复核表达语气。",
      }],
    },
    generation: { kind: "vehicle_fact_projection", templateVersion: "v1" },
    createdAt: "2026-08-19T08:01:00.000Z",
    createdBy: "account_creator",
    updatedAt: "2026-08-19T08:02:00.000Z",
    updatedBy: "account_creator",
  }];
  value.activeStrategyDraftId = "strategy_draft_1";
  value.stageConfirmationRequests = [{
    schemaVersion: 1,
    id: "confirmation_request_1",
    tenantId: value.videoTask.tenantId,
    batchProjectId: value.videoTask.batchProjectId,
    videoTaskId: value.videoTask.id,
    stage: "strategy",
    strategyDraftId: "strategy_draft_1",
    expectedTaskRevision: 2,
    source: "human_action",
    actorAccountId: "account_creator",
    occurredAt: "2026-08-19T08:02:00.000Z",
  }];
  value.commandReceipts = [
    {
      schemaVersion: 1,
      id: "command_receipt_generate_1",
      tenantId: value.videoTask.tenantId,
      batchProjectId: value.videoTask.batchProjectId,
      videoTaskId: value.videoTask.id,
      actorAccountId: "account_creator",
      requestId: "request_generate_1",
      payloadHash: "a".repeat(64),
      action: "generate_strategy",
      expectedTaskRevision: 1,
      resultingTaskRevision: 2,
      cost: { kind: "free", amountMinor: 0, charged: false },
      result: { kind: "strategy_generated", strategyDraftId: "strategy_draft_1" },
      occurredAt: "2026-08-19T08:01:00.000Z",
    },
    {
      schemaVersion: 1,
      id: "command_receipt_confirmation_1",
      tenantId: value.videoTask.tenantId,
      batchProjectId: value.videoTask.batchProjectId,
      videoTaskId: value.videoTask.id,
      actorAccountId: "account_creator",
      requestId: "request_confirmation_1",
      payloadHash: "b".repeat(64),
      action: "request_strategy_approval",
      expectedTaskRevision: 2,
      resultingTaskRevision: 3,
      cost: { kind: "free", amountMinor: 0, charged: false },
      result: {
        kind: "strategy_confirmation_requested",
        strategyDraftId: "strategy_draft_1",
        stageConfirmationRequestId: "confirmation_request_1",
      },
      occurredAt: "2026-08-19T08:02:00.000Z",
    },
  ];
  return value;
}

function recordWithArtifactGraph(): VideoTaskProductionRecord {
  const value = record();
  value.videoTask = {
    ...value.videoTask,
    revision: 12,
    vehicleSnapshotId: "vehicle_snapshot_e5_v1",
    assetSnapshotId: "asset_snapshot_1",
  };
  value.taskVehicleSnapshots = [structuredClone(recordWithCommandState().taskVehicleSnapshots[0]!)];
  value.taskAssetSnapshots = [{
    id: "asset_snapshot_1",
    tenantId: value.videoTask.tenantId,
    batchProjectId: value.videoTask.batchProjectId,
    videoTaskId: value.videoTask.id,
    version: 1,
    sourceProjectAssetPoolRevision: 1,
    vehicleSnapshotId: "vehicle_snapshot_e5_v1",
    assets: [{
      assetId: "asset_vehicle_1",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId: "vehicle_e5",
    }],
    createdAt: "2026-08-19T08:00:30.000Z",
    createdBy: "account_creator",
  }];
  value.stageArtifactVersions = [
    {
      id: "artifact_strategy_v1",
      tenantId: value.videoTask.tenantId,
      batchProjectId: value.videoTask.batchProjectId,
      videoTaskId: value.videoTask.id,
      stage: "strategy",
      version: 1,
      content: {
        artifactId: "strategy_content_v1",
        schemaName: "marketing_strategy",
        schemaVersion: 1,
        contentHashSha256: "1".repeat(64),
      },
      dependencies: [{ kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_e5_v1" }],
      provenance: { kind: "human_confirmation", confirmationId: "confirmation_strategy_v1" },
      createdAt: "2026-08-19T08:01:00.000Z",
      createdBy: "account_creator",
    },
    {
      id: "artifact_strategy_v2",
      tenantId: value.videoTask.tenantId,
      batchProjectId: value.videoTask.batchProjectId,
      videoTaskId: value.videoTask.id,
      stage: "strategy",
      version: 2,
      content: {
        artifactId: "strategy_content_v2",
        schemaName: "marketing_strategy",
        schemaVersion: 1,
        contentHashSha256: "2".repeat(64),
      },
      dependencies: [{ kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_e5_v1" }],
      provenance: { kind: "human_confirmation", confirmationId: "confirmation_strategy_v2" },
      createdAt: "2026-08-19T08:02:00.000Z",
      createdBy: "account_creator",
    },
    {
      id: "artifact_script_v1",
      tenantId: value.videoTask.tenantId,
      batchProjectId: value.videoTask.batchProjectId,
      videoTaskId: value.videoTask.id,
      stage: "script",
      version: 1,
      content: {
        artifactId: "script_content_v1",
        schemaName: "shooting_script",
        schemaVersion: 1,
        contentHashSha256: "3".repeat(64),
      },
      dependencies: [
        { kind: "stage_artifact", stage: "strategy", artifactVersionId: "artifact_strategy_v2" },
        { kind: "asset_snapshot", assetSnapshotId: "asset_snapshot_1" },
      ],
      provenance: { kind: "human_confirmation", confirmationId: "confirmation_script_v1" },
      createdAt: "2026-08-19T08:03:00.000Z",
      createdBy: "account_creator",
    },
    {
      id: "artifact_storyboard_v1",
      tenantId: value.videoTask.tenantId,
      batchProjectId: value.videoTask.batchProjectId,
      videoTaskId: value.videoTask.id,
      stage: "storyboard",
      version: 1,
      content: {
        artifactId: "storyboard_content_v1",
        schemaName: "storyboard",
        schemaVersion: 1,
        contentHashSha256: "4".repeat(64),
      },
      dependencies: [{
        kind: "stage_artifact",
        stage: "script",
        artifactVersionId: "artifact_script_v1",
      }],
      provenance: { kind: "human_confirmation", confirmationId: "confirmation_storyboard_v1" },
      createdAt: "2026-08-19T08:04:00.000Z",
      createdBy: "account_creator",
    },
  ];
  value.stageConfirmations = value.stageArtifactVersions.map((artifact, index) => ({
    id: `confirmation_${artifact.stage}_v${artifact.version}`,
    tenantId: value.videoTask.tenantId,
    batchProjectId: value.videoTask.batchProjectId,
    videoTaskId: value.videoTask.id,
    stage: artifact.stage,
    artifactVersionId: artifact.id,
    decision: "confirmed",
    source: "human_action",
    expectedTaskRevision: index + 1,
    actorAccountId: "account_creator",
    occurredAt: artifact.createdAt,
  }));
  value.activeStageArtifactVersionIds = { strategy: "artifact_strategy_v1" };
  value.stageRollbacks = [{
    id: "rollback_strategy_1",
    tenantId: value.videoTask.tenantId,
    batchProjectId: value.videoTask.batchProjectId,
    videoTaskId: value.videoTask.id,
    stage: "strategy",
    fromArtifactVersionId: "artifact_strategy_v2",
    toArtifactVersionId: "artifact_strategy_v1",
    expectedTaskRevision: 11,
    reason: "恢复首版策略",
    requestedBy: "account_creator",
    invalidationIds: ["invalidation_script_1", "invalidation_storyboard_1"],
    occurredAt: "2026-08-19T08:05:00.000Z",
  }];
  value.stageArtifactInvalidations = [
    {
      id: "invalidation_script_1",
      tenantId: value.videoTask.tenantId,
      batchProjectId: value.videoTask.batchProjectId,
      videoTaskId: value.videoTask.id,
      stage: "script",
      artifactVersionId: "artifact_script_v1",
      reason: "上游策略已回退",
      invalidatedDependency: {
        kind: "stage_artifact",
        stage: "strategy",
        artifactVersionId: "artifact_strategy_v2",
      },
      cause: {
        kind: "rollback",
        reasonCode: "upstream_rollback",
        rollbackId: "rollback_strategy_1",
      },
      occurredAt: "2026-08-19T08:05:00.000Z",
    },
    {
      id: "invalidation_storyboard_1",
      tenantId: value.videoTask.tenantId,
      batchProjectId: value.videoTask.batchProjectId,
      videoTaskId: value.videoTask.id,
      stage: "storyboard",
      artifactVersionId: "artifact_storyboard_v1",
      reason: "上游脚本已失效",
      invalidatedDependency: {
        kind: "stage_artifact",
        stage: "script",
        artifactVersionId: "artifact_script_v1",
      },
      cause: {
        kind: "upstream_invalidation",
        reasonCode: "upstream_invalidation",
        invalidationId: "invalidation_script_1",
      },
      occurredAt: "2026-08-19T08:05:00.000Z",
    },
  ];
  return value;
}

function transactionLockDirectory(directory: string): string {
  const digest = createHash("sha256").update("task:task_launch_hero").digest("hex");
  return join(directory, ".locks", `${digest}.lock`);
}

test("video task store creates, scopes, sorts, and returns defensive copies", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-task-create", false);
  const first = await store.create(record(), metadata());
  const secondInput = record("task_launch_cut", "首发短片");
  await store.create(secondInput, metadata("request_create_cut"));
  await store.create(
    record("task_other_project", "其他项目", "tenant_firefly", "project_other"),
    metadata("request_other_project"),
  );
  await store.create(
    record("task_other_tenant", "其他租户", "tenant_other", "project_e5_launch"),
    metadata("request_other_tenant"),
  );

  first.videoTask.name = "attacker mutation";
  const listed = await store.list("tenant_firefly", "project_e5_launch");
  assert.deepEqual(
    listed.map(({ videoTask }) => videoTask.id),
    ["task_launch_cut", "task_launch_hero"],
  );
  listed[0]!.videoTask.name = "list mutation";
  assert.equal((await store.load("task_launch_cut"))?.videoTask.name, "首发短片");
  assert.equal((await store.list("tenant_firefly")).length, 3);
  assert.equal((await store.list("tenant_missing")).length, 0);
});

test("v5 command state accepts warnings and preserves its complete reference graph", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-v5-command-state-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new LocalVideoTaskProductionStore(directory);
  const input = recordWithCommandState();
  await store.create(input, metadata());
  assert.deepEqual(
    await new LocalVideoTaskProductionStore(directory).load(input.videoTask.id),
    input,
  );
});

test("v5 command state fails closed on invalid scope, pointers, revisions, and request identities", async () => {
  const cases: Array<[string, (candidate: VideoTaskProductionRecord) => void]> = [
    ["draft scope", (candidate) => { candidate.strategyDrafts[0]!.tenantId = "tenant_attacker"; }],
    ["vehicle scope", (candidate) => { candidate.taskVehicleSnapshots[0]!.projectId = "project_attacker"; }],
    ["active vehicle pointer", (candidate) => { candidate.videoTask.vehicleSnapshotId = "snapshot_missing"; }],
    ["active draft pointer", (candidate) => { candidate.activeStrategyDraftId = "strategy_missing"; }],
    ["active draft is not latest", (candidate) => {
      const firstDraft = candidate.strategyDrafts[0]!;
      candidate.videoTask.revision = 4;
      candidate.strategyDrafts.push({
        ...structuredClone(firstDraft),
        id: "strategy_draft_2",
        version: 2,
        createdAt: "2026-08-19T08:03:00.000Z",
        updatedAt: "2026-08-19T08:03:00.000Z",
      });
      candidate.commandReceipts.push({
        ...structuredClone(candidate.commandReceipts[0]!),
        id: "command_receipt_generate_2",
        requestId: "request_generate_2",
        expectedTaskRevision: 3,
        resultingTaskRevision: 4,
        result: { kind: "strategy_generated", strategyDraftId: "strategy_draft_2" },
        occurredAt: "2026-08-19T08:03:00.000Z",
      });
    }],
    ["draft version gap", (candidate) => { candidate.strategyDrafts[0]!.version = 2; }],
    ["draft vehicle pointer", (candidate) => { candidate.strategyDrafts[0]!.vehicleSnapshotId = "snapshot_missing"; }],
    ["confirmation pointer", (candidate) => { candidate.stageConfirmationRequests[0]!.strategyDraftId = "strategy_missing"; }],
    ["receipt revision", (candidate) => { candidate.commandReceipts[0]!.resultingTaskRevision = 3; }],
    ["receipt result", (candidate) => {
      candidate.commandReceipts[0]!.result = {
        kind: "strategy_generated",
        strategyDraftId: "strategy_missing",
      };
    }],
    ["receipt draft actor", (candidate) => { candidate.strategyDrafts[0]!.createdBy = "account_other"; }],
    ["receipt draft time", (candidate) => { candidate.strategyDrafts[0]!.createdAt = "2026-08-19T08:00:30.000Z"; }],
    ["multiple vehicle snapshots", (candidate) => {
      candidate.taskVehicleSnapshots.push({
        ...structuredClone(candidate.taskVehicleSnapshots[0]!),
        id: "vehicle_snapshot_e5_v2",
        vehicleVersion: 2,
      });
    }],
    ["asset snapshot pointer", (candidate) => {
      candidate.videoTask.assetSnapshotId = "asset_snapshot_missing";
      candidate.taskAssetSnapshots = [{
        id: "asset_snapshot_1",
        tenantId: candidate.videoTask.tenantId,
        batchProjectId: candidate.videoTask.batchProjectId,
        videoTaskId: candidate.videoTask.id,
        version: 1,
        sourceProjectAssetPoolRevision: 1,
        vehicleSnapshotId: candidate.taskVehicleSnapshots[0]!.id,
        assets: [{
          assetId: "asset_vehicle_1",
          version: 1,
          source: "company_catalog",
          sourceProvider: "mock_company_assets",
          category: "vehicle",
          vehicleId: "vehicle_e5",
        }],
        createdAt: "2026-08-19T08:01:00.000Z",
        createdBy: "account_creator",
      }];
    }],
    ["duplicate actor request", (candidate) => {
      candidate.commandReceipts[1]!.requestId = candidate.commandReceipts[0]!.requestId;
    }],
    ["unreferenced confirmation request", (candidate) => { candidate.commandReceipts.pop(); }],
    ["warning validity", (candidate) => { candidate.strategyDrafts[0]!.validation.valid = false; }],
    ["error validity", (candidate) => {
      candidate.strategyDrafts[0]!.validation.issues[0]!.severity = "error";
    }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = recordWithCommandState();
    mutate(candidate);
    await assert.rejects(
      new LocalVideoTaskProductionStore(`.data/test-video-task-v5-${label}`, false).save(candidate),
      /invalid|duplicate|unreferenced/u,
      label,
    );
  }
});

test("v5 artifact graph accepts a complete rollback invalidation closure", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-v5-artifact-graph-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const input = recordWithArtifactGraph();
  await new LocalVideoTaskProductionStore(directory).create(input, metadata());
  assert.deepEqual(
    await new LocalVideoTaskProductionStore(directory).load(input.videoTask.id),
    input,
  );
});

test("v5 artifact graph fails closed on invalid dependencies and provenance", async () => {
  const cases: Array<[string, (candidate: VideoTaskProductionRecord) => void]> = [
    ["missing dependency artifact", (candidate) => {
      candidate.stageArtifactVersions[2]!.dependencies[0] = {
        kind: "stage_artifact",
        stage: "strategy",
        artifactVersionId: "artifact_missing",
      };
    }],
    ["forged dependency stage", (candidate) => {
      candidate.stageArtifactVersions[2]!.dependencies[0] = {
        kind: "stage_artifact",
        stage: "asset_matching",
        artifactVersionId: "artifact_strategy_v2",
      };
    }],
    ["same stage dependency", (candidate) => {
      candidate.stageArtifactVersions[2]!.dependencies[0] = {
        kind: "stage_artifact",
        stage: "script",
        artifactVersionId: "artifact_script_v1",
      };
    }],
    ["missing vehicle snapshot", (candidate) => {
      candidate.stageArtifactVersions[0]!.dependencies[0] = {
        kind: "vehicle_snapshot",
        vehicleSnapshotId: "vehicle_snapshot_missing",
      };
    }],
    ["missing asset snapshot", (candidate) => {
      candidate.stageArtifactVersions[2]!.dependencies[1] = {
        kind: "asset_snapshot",
        assetSnapshotId: "asset_snapshot_missing",
      };
    }],
    ["duplicate dependency", (candidate) => {
      candidate.stageArtifactVersions[2]!.dependencies.push(
        structuredClone(candidate.stageArtifactVersions[2]!.dependencies[0]!),
      );
    }],
    ["missing provenance confirmation", (candidate) => {
      candidate.stageArtifactVersions[0]!.provenance = {
        kind: "human_confirmation",
        confirmationId: "confirmation_missing",
      };
    }],
    ["confirmation artifact mismatch", (candidate) => {
      candidate.stageConfirmations[0]!.artifactVersionId = "artifact_strategy_v2";
    }],
    ["confirmation stage mismatch", (candidate) => {
      candidate.stageConfirmations[2]!.stage = "storyboard";
    }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = recordWithArtifactGraph();
    mutate(candidate);
    await assert.rejects(
      new LocalVideoTaskProductionStore(`.data/test-video-task-v5-artifact-${label}`, false)
        .save(candidate),
      /invalid|duplicate|unreferenced/u,
      label,
    );
  }
});

test("v5 artifact graph fails closed on invalid rollback and invalidation closure", async () => {
  const cases: Array<[string, (candidate: VideoTaskProductionRecord) => void]> = [
    ["missing rollback source", (candidate) => {
      candidate.stageRollbacks[0]!.fromArtifactVersionId = "artifact_missing";
    }],
    ["cross stage rollback target", (candidate) => {
      candidate.stageRollbacks[0]!.toArtifactVersionId = "artifact_script_v1";
    }],
    ["same rollback endpoints", (candidate) => {
      candidate.stageRollbacks[0]!.toArtifactVersionId = "artifact_strategy_v2";
    }],
    ["future rollback revision", (candidate) => {
      candidate.stageRollbacks[0]!.expectedTaskRevision = 13;
    }],
    ["missing invalidated artifact", (candidate) => {
      candidate.stageArtifactInvalidations[0]!.artifactVersionId = "artifact_missing";
    }],
    ["invalidation stage mismatch", (candidate) => {
      candidate.stageArtifactInvalidations[0]!.stage = "storyboard";
    }],
    ["dependency not owned by invalidated artifact", (candidate) => {
      candidate.stageArtifactInvalidations[0]!.invalidatedDependency = {
        kind: "stage_artifact",
        stage: "strategy",
        artifactVersionId: "artifact_strategy_v1",
      };
    }],
    ["missing rollback cause", (candidate) => {
      const cause = candidate.stageArtifactInvalidations[0]!.cause;
      if (cause.kind === "rollback") cause.rollbackId = "rollback_missing";
    }],
    ["missing upstream invalidation cause", (candidate) => {
      const cause = candidate.stageArtifactInvalidations[1]!.cause;
      if (cause.kind === "upstream_invalidation") cause.invalidationId = "invalidation_missing";
    }],
    ["cyclic invalidation cause", (candidate) => {
      candidate.stageArtifactInvalidations[0]!.cause = {
        kind: "upstream_invalidation",
        reasonCode: "upstream_invalidation",
        invalidationId: "invalidation_storyboard_1",
      };
    }],
    ["rollback invalidation omission", (candidate) => {
      candidate.stageRollbacks[0]!.invalidationIds.pop();
    }],
    ["rollback invalidation extra", (candidate) => {
      candidate.stageRollbacks[0]!.invalidationIds.push("invalidation_missing");
    }],
    ["duplicate invalidated artifact", (candidate) => {
      candidate.stageArtifactInvalidations[1]!.artifactVersionId = "artifact_script_v1";
      candidate.stageArtifactInvalidations[1]!.stage = "script";
    }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = recordWithArtifactGraph();
    mutate(candidate);
    await assert.rejects(
      new LocalVideoTaskProductionStore(`.data/test-video-task-v5-rollback-${label}`, false)
        .save(candidate),
      /invalid|duplicate|unreferenced|cycle/u,
      label,
    );
  }
});

test("persisted v1 through v4 aggregates upgrade to empty v5 command state", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-v5-upgrade-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  for (const version of [1, 2, 3, 4] as const) {
    const current = record(`task_legacy_v${version}`);
    current.stageArtifactVersions = [{
      id: `artifact_legacy_v${version}`,
      tenantId: current.videoTask.tenantId,
      batchProjectId: current.videoTask.batchProjectId,
      videoTaskId: current.videoTask.id,
      stage: "strategy",
      version: 1,
      content: {
        artifactId: `content_legacy_v${version}`,
        schemaName: "marketing_strategy",
        schemaVersion: 1,
        contentHashSha256: version.toString().repeat(64),
      },
      dependencies: [{
        kind: "vehicle_snapshot",
        vehicleSnapshotId: `external_vehicle_snapshot_v${version}`,
      }],
      provenance: {
        kind: "human_confirmation",
        confirmationId: `legacy_confirmation_v${version}`,
      },
      createdAt: "2026-08-19T08:00:00.000Z",
      createdBy: "account_creator",
    }];
    current.activeStageArtifactVersionIds = { strategy: `artifact_legacy_v${version}` };
    const {
      taskVehicleSnapshots: _taskVehicleSnapshots,
      strategyDrafts: _strategyDrafts,
      activeStrategyDraftId: _activeStrategyDraftId,
      stageConfirmationRequests: _stageConfirmationRequests,
      commandReceipts: _commandReceipts,
      ...withoutV5
    } = current;
    const { taskAssetSnapshots: _taskAssetSnapshots, ...withoutV4 } = withoutV5;
    const { ownershipTransfers: _ownershipTransfers, ...withoutV3 } = withoutV4;
    const persisted = version === 4
      ? { ...withoutV5, schemaVersion: 4 }
      : version === 3
        ? { ...withoutV4, schemaVersion: 3 }
        : version === 2
          ? { ...withoutV3, schemaVersion: 2 }
          : {
              schemaVersion: 1,
              videoTask: current.videoTask,
              stageArtifactVersions: current.stageArtifactVersions,
              stageConfirmations: current.stageConfirmations,
            };
    await writeFile(
      join(directory, `${current.videoTask.id}.json`),
      `${JSON.stringify(persisted)}\n`,
      "utf8",
    );
    const upgraded = await new LocalVideoTaskProductionStore(directory).load(current.videoTask.id);
    assert.equal(upgraded?.schemaVersion, 5);
    assert.deepEqual(upgraded?.taskVehicleSnapshots, []);
    assert.deepEqual(upgraded?.strategyDrafts, []);
    assert.equal(upgraded?.activeStrategyDraftId, undefined);
    assert.deepEqual(upgraded?.stageConfirmationRequests, []);
    assert.deepEqual(upgraded?.commandReceipts, []);
    assert.deepEqual(upgraded?.stageArtifactVersions[0]?.provenance, {
      kind: "migrated_confirmation",
      legacyApprovalId: `legacy_confirmation_v${version}`,
    });
  }
});

test("creation metadata makes concurrent requests replay-safe and rejects conflicts", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-task-idempotency", false);
  const firstCandidate = record("task_generated_first");
  const replayCandidate = record("task_generated_replay", "重试生成的不同名称");
  const creation = metadata("request_idempotent", "payload_hash_original");
  const [first, replay] = await Promise.all([
    store.create(firstCandidate, creation),
    store.create(replayCandidate, creation),
  ]);

  assert.deepEqual(replay, first);
  assert.equal((await store.list("tenant_firefly", "project_e5_launch")).length, 1);
  await assert.rejects(
    store.create(record("task_conflict"), metadata("request_idempotent", "different_hash")),
    /conflicts with a different payload/u,
  );
});

test("task IDs and normalized names cannot overwrite an existing aggregate", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-task-duplicates", false);
  await store.create(record(), metadata());
  await assert.rejects(
    store.create(
      record("task_launch_hero", "其他租户同 ID", "tenant_other"),
      metadata("request_cross_tenant"),
    ),
    /same ID already exists/u,
  );
  await assert.rejects(
    store.create(
      record("task_duplicate_name", "  首发主片  "),
      metadata("request_duplicate_name"),
    ),
    /same name already exists/u,
  );
  await assert.doesNotReject(
    store.create(
      record("task_same_name_other_project", "首发主片", "tenant_firefly", "project_other"),
      metadata("request_same_name_other_project"),
    ),
  );
});

test("creation idempotency and internal metadata survive restart and later transactions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-create-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const input = record();
  const creation = metadata("request_restart", "payload_hash_restart");
  await new LocalVideoTaskProductionStore(directory).create(input, creation);

  const raw = JSON.parse(await readFile(join(directory, `${input.videoTask.id}.json`), "utf8")) as {
    _creation?: VideoTaskCreationMetadata;
  };
  assert.deepEqual(raw._creation, creation);
  const restarted = new LocalVideoTaskProductionStore(directory);
  assert.deepEqual(
    await restarted.create(record("task_retry_after_restart"), creation),
    input,
  );
  await restarted.transact(input.videoTask.id, (current) => {
    assert.ok(current);
    return {
      ...current,
      videoTask: { ...current.videoTask, revision: 2 },
    };
  });
  const afterTransaction = JSON.parse(
    await readFile(join(directory, `${input.videoTask.id}.json`), "utf8"),
  ) as { _creation?: VideoTaskCreationMetadata };
  assert.deepEqual(afterTransaction._creation, creation);
  assert.equal((await restarted.load(input.videoTask.id))?.videoTask.revision, 2);
  assert.equal("_creation" in (await restarted.load(input.videoTask.id))!, false);
});

test("independent store instances atomically allow only one create for the same task ID", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-exclusive-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const attempts = await Promise.allSettled([
    new LocalVideoTaskProductionStore(directory).create(record(), metadata("request_first")),
    new LocalVideoTaskProductionStore(directory).create(record(), metadata("request_second")),
  ]);

  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(
    (await new LocalVideoTaskProductionStore(directory).list("tenant_firefly")).length,
    1,
  );
});

test("independent store instances replay one deterministic task for the same creation request", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-cross-store-replay-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const creation = metadata("request_shared", "payload_hash_shared");
  const attempts = await Promise.all([
    new LocalVideoTaskProductionStore(directory).create(record(), creation),
    new LocalVideoTaskProductionStore(directory).create(record(), creation),
  ]);

  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(
    (await new LocalVideoTaskProductionStore(directory).list("tenant_firefly")).length,
    1,
  );
});

test("independent store instances reject a conflicting payload for the same request", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-cross-store-conflict-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const attempts = await Promise.allSettled([
    new LocalVideoTaskProductionStore(directory).create(
      record(),
      metadata("request_shared", "payload_hash_first"),
    ),
    new LocalVideoTaskProductionStore(directory).create(
      record(),
      metadata("request_shared", "payload_hash_second"),
    ),
  ]);

  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = attempts.find(({ status }) => status === "rejected");
  assert.equal(rejected?.status, "rejected");
  assert.match(String(rejected.reason), /conflicts with a different payload/u);
  assert.equal(
    (await new LocalVideoTaskProductionStore(directory).list("tenant_firefly")).length,
    1,
  );
});

test("independent store transactions serialize one revision and preserve its ownership audit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-cross-store-transaction-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await new LocalVideoTaskProductionStore(directory).create(record(), metadata());
  const firstStore = new LocalVideoTaskProductionStore(directory);
  const secondStore = new LocalVideoTaskProductionStore(directory);
  await Promise.all([
    firstStore.load("task_launch_hero"),
    secondStore.load("task_launch_hero"),
  ]);
  const updateOwner = (actor: string) => {
    const selectedStore = actor === "account_first" ? firstStore : secondStore;
    return selectedStore.transact(
      "task_launch_hero",
      (current) => {
        assert.ok(current);
        if (current.videoTask.revision !== 1) throw new Error("revision conflict");
        return {
          ...current,
          videoTask: {
            ...current.videoTask,
            ownerAccountId: actor,
            revision: 2,
            updatedBy: actor,
          },
          ownershipTransfers: [
            ...current.ownershipTransfers,
            {
              id: `transfer_${actor}`,
              tenantId: current.videoTask.tenantId,
              batchProjectId: current.videoTask.batchProjectId,
              videoTaskId: current.videoTask.id,
              fromOwnerAccountId: current.videoTask.ownerAccountId,
              toOwnerAccountId: actor,
              expectedTaskRevision: 1,
              reason: "concurrent assignment",
              source: "human_action" as const,
              actorAccountId: actor,
              occurredAt: "2026-08-19T09:00:00.000Z",
            },
          ],
        };
      },
    );
  };
  const attempts = await Promise.allSettled([
    updateOwner("account_first"),
    updateOwner("account_second"),
  ]);

  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const persisted = await new LocalVideoTaskProductionStore(directory).load("task_launch_hero");
  assert.equal(persisted?.videoTask.revision, 2);
  assert.equal(persisted?.ownershipTransfers.length, 1);
  assert.equal(persisted?.ownershipTransfers[0]?.toOwnerAccountId, persisted?.videoTask.ownerAccountId);
});

test("concurrent stores safely recover empty, damaged, and expired-owner lock directories", async () => {
  const lockOptions = {
    timeoutMilliseconds: 2_000,
    leaseMilliseconds: 200,
    heartbeatMilliseconds: 50,
  };
  for (const staleKind of ["empty", "damaged", "expired_owner"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `firefly-video-task-${staleKind}-lock-`));
    try {
      await new LocalVideoTaskProductionStore(directory, true, lockOptions).create(
        record(),
        metadata(),
      );
      const lockDirectory = transactionLockDirectory(directory);
      await mkdir(lockDirectory, { recursive: true });
      if (staleKind === "damaged") {
        await writeFile(join(lockDirectory, "damaged.owner"), "broken", "utf8");
      }
      if (staleKind === "expired_owner") {
        const ownerPath = join(
          lockDirectory,
          `${process.pid}.00000000-0000-4000-8000-000000000001.owner`,
        );
        await writeFile(ownerPath, "", "utf8");
        const expired = new Date(Date.now() - 5_000);
        await utimes(ownerPath, expired, expired);
      }
      const stores = [
        new LocalVideoTaskProductionStore(directory, true, lockOptions),
        new LocalVideoTaskProductionStore(directory, true, lockOptions),
      ];
      const attempts = await Promise.allSettled(
        stores.map((store, index) =>
          store.transact("task_launch_hero", (current) => {
            assert.ok(current);
            if (current.videoTask.revision !== 1) throw new Error("revision conflict");
            return {
              ...current,
              videoTask: {
                ...current.videoTask,
                revision: 2,
                updatedBy: `account_${index}`,
              },
            };
          }),
        ),
      );
      assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
      assert.equal(
        (await new LocalVideoTaskProductionStore(directory).load("task_launch_hero"))?.videoTask
          .revision,
        2,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("an active owner heartbeat prevents lease theft during a long transaction", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-heartbeat-lock-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const lockOptions = {
    timeoutMilliseconds: 2_000,
    leaseMilliseconds: 200,
    heartbeatMilliseconds: 50,
  };
  await new LocalVideoTaskProductionStore(directory, true, lockOptions).create(
    record(),
    metadata(),
  );
  const firstStore = new LocalVideoTaskProductionStore(directory, true, lockOptions);
  const secondStore = new LocalVideoTaskProductionStore(directory, true, lockOptions);
  let releaseFirst = (): void => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let enteredFirst = (): void => undefined;
  const firstEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  const first = firstStore.transact("task_launch_hero", async (current) => {
    assert.ok(current);
    enteredFirst();
    await firstGate;
    return { ...current, videoTask: { ...current.videoTask, revision: 2 } };
  });
  await firstEntered;
  const lockDirectory = transactionLockDirectory(directory);
  const [ownerName] = await readdir(lockDirectory);
  assert.ok(ownerName);
  const ownerPath = join(lockDirectory, ownerName);
  const initialMtime = (await stat(ownerPath)).mtimeMs;
  let secondSettled = false;
  const second = secondStore
    .transact("task_launch_hero", (current) => {
      assert.ok(current);
      if (current.videoTask.revision !== 1) throw new Error("revision conflict");
      return { ...current, videoTask: { ...current.videoTask, revision: 2 } };
    })
    .finally(() => {
      secondSettled = true;
    });
  await new Promise<void>((resolve) => setTimeout(resolve, 320));
  assert.equal(secondSettled, false);
  assert.ok((await stat(ownerPath)).mtimeMs > initialMtime);
  releaseFirst();
  const attempts = await Promise.allSettled([first, second]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
});

test("a transaction that loses its owner token is fenced before persistence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-lost-lock-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const lockOptions = {
    timeoutMilliseconds: 2_000,
    leaseMilliseconds: 200,
    heartbeatMilliseconds: 50,
  };
  await new LocalVideoTaskProductionStore(directory, true, lockOptions).create(
    record(),
    metadata(),
  );
  const staleStore = new LocalVideoTaskProductionStore(directory, true, lockOptions);
  const winnerStore = new LocalVideoTaskProductionStore(directory, true, lockOptions);
  let releaseStale = (): void => undefined;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  let enteredStale = (): void => undefined;
  const staleEntered = new Promise<void>((resolve) => {
    enteredStale = resolve;
  });
  const stale = staleStore.transact("task_launch_hero", async (current) => {
    assert.ok(current);
    enteredStale();
    await staleGate;
    return {
      ...current,
      videoTask: { ...current.videoTask, revision: 2, updatedBy: "account_stale" },
    };
  });
  await staleEntered;

  // Simulate a reaper taking the expired lease while the original callback is paused.
  await rm(transactionLockDirectory(directory), { recursive: true, force: true });
  const winner = await winnerStore.transact("task_launch_hero", (current) => {
    assert.ok(current);
    return {
      ...current,
      videoTask: { ...current.videoTask, revision: 2, updatedBy: "account_winner" },
    };
  });
  assert.equal(winner.videoTask.updatedBy, "account_winner");

  releaseStale();
  await assert.rejects(stale, /transaction lock was lost/u);
  const persisted = await new LocalVideoTaskProductionStore(directory).load("task_launch_hero");
  assert.equal(persisted?.videoTask.revision, 2);
  assert.equal(persisted?.videoTask.updatedBy, "account_winner");
});

test("listing ignores temporary and non-JSON files but fails closed on invalid persisted scope", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-list-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new LocalVideoTaskProductionStore(directory);
  await store.create(record(), metadata());
  await writeFile(join(directory, "orphan.json.123.tmp"), "not json", "utf8");
  await writeFile(join(directory, "README.txt"), "not json", "utf8");
  assert.equal((await new LocalVideoTaskProductionStore(directory).list("tenant_firefly")).length, 1);

  const invalid = record("task_invalid_scope");
  invalid.stageArtifactVersions.push({
    id: "artifact_strategy_1",
    tenantId: "tenant_attacker",
    batchProjectId: invalid.videoTask.batchProjectId,
    videoTaskId: invalid.videoTask.id,
    stage: "strategy",
    version: 1,
    content: {
      artifactId: "strategy_content_1",
      schemaName: "marketing_strategy",
      schemaVersion: 1,
      contentHashSha256: "a".repeat(64),
    },
    dependencies: [{ kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" }],
    provenance: { kind: "legacy_inferred", migrationId: "migration_1", note: "fixture" },
    createdAt: "2026-08-19T08:00:00.000Z",
    createdBy: "account_creator",
  });
  await writeFile(
    join(directory, "task_invalid_scope.json"),
    `${JSON.stringify(invalid)}\n`,
    "utf8",
  );
  await assert.rejects(
    new LocalVideoTaskProductionStore(directory).list("tenant_firefly"),
    /invalid format or scope/u,
  );
});

test("save and transact preserve task identity and tenant/project scope", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-task-scope", false);
  await store.create(record(), metadata());
  await assert.rejects(
    store.save(record("task_launch_hero", "cross tenant", "tenant_attacker")),
    /cannot change the aggregate scope/u,
  );
  await assert.rejects(
    store.transact("task_launch_hero", (current) => ({
      ...current!,
      videoTask: { ...current!.videoTask, batchProjectId: "project_attacker" },
    })),
    /cannot change the aggregate scope/u,
  );
  await assert.rejects(
    store.transact("task_launch_hero", (current) => ({
      ...current!,
      videoTask: { ...current!.videoTask, id: "task_attacker" },
    })),
    /cannot change the aggregate identity/u,
  );
});
