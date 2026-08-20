import assert from "node:assert/strict";
import test from "node:test";

import type { VideoTaskProductionRecord } from "@firefly/domain";
import type { StageArtifactVersion, TaskContext, VideoTaskStage } from "@firefly/schemas";

import {
  createScopedStageSuggestionContextReader,
  createStageSuggestionTools,
  StageSuggestionContextAccessError,
  type AssetMatchingCandidateReader,
} from "../src/index.ts";

const occurredAt = "2026-08-19T09:00:00.000Z";
const assetMatchingCandidateReader: AssetMatchingCandidateReader = {
  batchProjectId: "project_1",
  async read() {
    return {
      projectAssetPoolRevision: 7,
      companyCandidates: [{
        reference: {
          source: "company_catalog",
          sourceProvider: "mock-company-assets",
          assetId: "person_family",
          version: 3,
          category: "person",
        },
        displayName: "年轻家庭三人组",
        description: "适合家庭周末露营场景",
        brandIds: ["brand_1"],
        tags: ["家庭", "露营"],
        preview: { mediaType: "image/webp", width: 1440, height: 1920 },
        updatedAt: occurredAt,
      }],
      localCandidates: [{
        reference: {
          source: "local_upload",
          batchProjectId: "project_1",
          assetId: "local_camp",
          version: 2,
          category: "scene",
          checksumSha256: "b".repeat(64),
        },
        displayName: "露营地.webp",
        description: "湖畔草地露营场景",
        sourceStatus: "requires_manual_review",
      }],
    };
  },
};
const stageOrder: readonly VideoTaskStage[] = [
  "strategy",
  "script",
  "asset_matching",
  "storyboard",
  "video_preview",
  "delivery",
];
type SuggestionStage = "script" | "asset_matching" | "storyboard" | "delivery";

function taskContext(stage: SuggestionStage, revision = 8): TaskContext {
  return {
    schemaVersion: 1,
    kind: "task_context",
    brand: { id: "brand_1", name: "品牌一" },
    vehicle: { id: "vehicle_1", displayName: "车型一", version: 1 },
    batchProject: { id: "project_1", name: "项目一", aspectRatio: "9:16" },
    videoTask: {
      id: "task_1",
      name: "任务一",
      status: "active",
      currentStage: stage,
      stageStatus: "in_progress",
      revision,
      vehicleSnapshotId: "vehicle_snapshot_1",
      ...(stage === "script" || stage === "asset_matching"
        ? {}
        : { assetSnapshotId: "asset_snapshot_1" }),
      ownership: { state: "owned_by_current_account" },
    },
    productionBrief: {
      audience: "家庭用户",
      theme: "周末出行",
      durationSeconds: 30,
      platformTags: ["douyin", "xiaohongshu"],
    },
  };
}

function artifact(stage: VideoTaskStage): StageArtifactVersion {
  const index = stageOrder.indexOf(stage);
  return {
    id: `${stage}_artifact_v1`,
    tenantId: "tenant_1",
    batchProjectId: "project_1",
    videoTaskId: "task_1",
    stage,
    version: 1,
    content: {
      artifactId: `${stage}_content_v1`,
      schemaName: stage,
      schemaVersion: 1,
      contentHashSha256: String(index + 1).repeat(64),
    },
    dependencies: index === 0
      ? [{ kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" }]
      : [{ kind: "stage_artifact", stage: stageOrder[index - 1]!, artifactVersionId: `${stageOrder[index - 1]}_artifact_v1` }],
    provenance: { kind: "human_confirmation", confirmationId: `${stage}_confirmation_v1` },
    createdAt: occurredAt,
    createdBy: "account_1",
  };
}

function productionRecord(stage: SuggestionStage): VideoTaskProductionRecord {
  const currentIndex = stageOrder.indexOf(stage);
  const upstream = stageOrder.slice(0, currentIndex).map(artifact);
  return {
    schemaVersion: 7,
    videoTask: {
      id: "task_1",
      tenantId: "tenant_1",
      batchProjectId: "project_1",
      name: "任务一",
      ownerAccountId: "account_1",
      status: "active",
      currentStage: stage,
      stageStatus: "in_progress",
      revision: 8,
      vehicleSnapshotId: "vehicle_snapshot_1",
      ...(stage === "script" || stage === "asset_matching"
        ? {}
        : { assetSnapshotId: "asset_snapshot_1" }),
      audience: "家庭用户",
      theme: "周末出行",
      durationSeconds: 30,
      platformTags: ["douyin", "xiaohongshu"],
      createdAt: occurredAt,
      createdBy: "account_1",
      updatedAt: occurredAt,
      updatedBy: "account_1",
    },
    stageArtifactVersions: upstream,
    stageConfirmations: upstream.map((item) => ({
      id: `${item.stage}_confirmation_v1`,
      tenantId: "tenant_1",
      batchProjectId: "project_1",
      videoTaskId: "task_1",
      stage: item.stage,
      artifactVersionId: item.id,
      decision: "confirmed",
      source: "human_action",
      expectedTaskRevision: 1,
      actorAccountId: "account_1",
      occurredAt,
    })),
    activeStageArtifactVersionIds: Object.fromEntries(upstream.map((item) => [item.stage, item.id])),
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

function readerFor(
  stage: SuggestionStage,
  mutate?: (record: VideoTaskProductionRecord) => void,
) {
  const record = productionRecord(stage);
  mutate?.(record);
  return createScopedStageSuggestionContextReader({
    taskContext: taskContext(stage),
    tenantId: "tenant_1",
    store: { async load() { return record; } },
    assetMatchingCandidateReader,
  });
}

test("stage suggestion context exposes exact confirmed upstream versions for each allowed stage", async () => {
  for (const [stage, expectedStages] of [
    ["script", ["strategy"]],
    ["asset_matching", ["strategy", "script"]],
    ["storyboard", ["strategy", "script", "asset_matching"]],
    ["delivery", ["strategy", "script", "asset_matching", "storyboard", "video_preview"]],
  ] as const) {
    const result = await readerFor(stage).read();
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.kind, "stage_suggestion_context");
    assert.equal(result.stage, stage);
    assert.deepEqual(result.confirmedUpstreamArtifacts.map((item) => item.stage), expectedStages);
    assert.deepEqual(
      result.confirmedUpstreamArtifacts.map((item) => item.id),
      expectedStages.map((item) => `${item}_artifact_v1`),
    );
    assert.equal(result.suggestionBoundary.suggestionOnly, true);
    assert.equal(result.suggestionBoundary.mayPersistArtifact, false);
    assert.equal(result.suggestionBoundary.mayConfirmStage, false);
    if (stage === "asset_matching") {
      assert.equal(result.assetMatchingContext?.projectAssetPoolRevision, 7);
      assert.equal(result.assetMatchingContext?.companyCandidates[0]?.description, "适合家庭周末露营场景");
      assert.equal(result.assetMatchingContext?.companyCandidates[0]?.reference.version, 3);
      assert.equal(result.assetMatchingContext?.localCandidates[0]?.description, "湖畔草地露营场景");
      assert.equal(result.assetMatchingContext?.localCandidates[0]?.reference.version, 2);
      assert.equal(result.assetMatchingContext?.selectionPolicy.humanSelectionHasPriority, true);
    } else {
      assert.equal(result.assetMatchingContext, undefined);
    }
  }
});

test("asset matching suggestion context requires a project-bound candidate reader", () => {
  for (const candidateReader of [
    undefined,
    { ...assetMatchingCandidateReader, batchProjectId: "project_other" },
  ]) {
    assert.throws(
      () => createScopedStageSuggestionContextReader({
        taskContext: taskContext("asset_matching"),
        tenantId: "tenant_1",
        store: { async load() { return productionRecord("asset_matching"); } },
        ...(candidateReader === undefined
          ? {}
          : { assetMatchingCandidateReader: candidateReader }),
      }),
      StageSuggestionContextAccessError,
    );
  }
});

test("script and asset matching suggestion contexts do not require an asset snapshot", async () => {
  for (const stage of ["script", "asset_matching"] as const) {
    assert.equal(taskContext(stage).videoTask.assetSnapshotId, undefined);
    const result = await readerFor(stage).read();
    assert.equal(result.stage, stage);
  }
});

test("stage suggestion context rejects stale task state, missing confirmation, invalidation, and cross-tenant records", async () => {
  const cases = [
    readerFor("script", (record) => { record.videoTask.revision = 9; }),
    readerFor("script", (record) => { record.stageConfirmations = []; }),
    readerFor("asset_matching", (record) => { record.stageConfirmations = record.stageConfirmations.slice(0, 1); }),
    readerFor("storyboard", (record) => {
      record.stageArtifactInvalidations.push({
        id: "invalidation_script_v1",
        tenantId: "tenant_1",
        batchProjectId: "project_1",
        videoTaskId: "task_1",
        stage: "script",
        artifactVersionId: "script_artifact_v1",
        reason: "上游版本回退。",
        cause: { kind: "upstream_invalidation", reasonCode: "upstream_invalidation", invalidationId: "invalidation_upstream" },
        invalidatedDependency: { kind: "stage_artifact", stage: "strategy", artifactVersionId: "strategy_artifact_v1" },
        occurredAt,
      });
    }),
    readerFor("storyboard", (record) => {
      const matching = record.stageArtifactVersions.find((item) => item.stage === "asset_matching")!;
      matching.dependencies = [{ kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" }];
    }),
    readerFor("delivery", (record) => { record.videoTask.tenantId = "tenant_other"; }),
  ];
  for (const reader of cases) {
    await assert.rejects(() => reader.read(), StageSuggestionContextAccessError);
  }
});

test("stage suggestion tool accepts no model-proposed identity or artifact references", async () => {
  const [tool] = createStageSuggestionTools(readerFor("delivery"));
  assert.ok(tool);
  assert.deepEqual(Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}), []);
  const result = await tool.execute("call_1", {});
  assert.equal(result.details.stage, "delivery");
  assert.match(tool.description, /项目资产池 revision/u);
  assert.match(tool.description, /不生成、不持久化、不确认阶段/u);
});
