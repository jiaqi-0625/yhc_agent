import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  AgentActionCardSchema,
  AgentStreamEventSchema,
  AssetReferenceSchema,
  BatchProjectSchema,
  BrandSchema,
  ClaimSchema,
  ProjectAssetPoolSchema,
  RollbackStageRequestSchema,
  StageArtifactInvalidationSchema,
  StageArtifactVersionSchema,
  StageConfirmationSchema,
  StageRollbackRecordSchema,
  StrategyActionProposalSchema,
  TaskContextSchema,
  TaskAssetSnapshotSchema,
  TemporaryAssetSchema,
  VehicleSchema,
  VehicleSnapshotSchema,
  VideoTaskSchema,
  WorkSchema,
  type BatchProject,
  type Brand,
  type Claim,
  type CompanyReusableAssetReference,
  type CompanyVehicleAssetReference,
  type ProjectAssetPool,
  type RollbackStageRequest,
  type StageArtifactInvalidation,
  type StageArtifactVersion,
  type StageConfirmation,
  type StageRollbackRecord,
  type TaskAssetSnapshot,
  type TemporaryAsset,
  type TemporaryAssetReference,
  type Vehicle,
  type VideoTask,
} from "../src/index.ts";
import { agentActionCardFixtures, taskContextFixture } from "./fixtures/workspace-v2.ts";

const fixedClaim = {
  id: "claim_range",
  kind: "fixed",
  name: "续航",
  statement: "CLTC 续航 550 公里",
  value: 550,
  unit: "km",
  evidence: {
    sourceName: "官方配置表",
    sourceReference: "vehicle-spec-v1",
    effectiveFrom: "2026-08-01",
  },
  requiredInVoiceover: true,
  requiredInSubtitle: true,
  mayRephrase: false,
  riskNotes: ["必须保留 CLTC 测试条件"],
} satisfies Claim;

const auditFields = {
  createdAt: "2026-08-18T00:00:00.000Z",
  createdBy: "account_admin",
  updatedAt: "2026-08-18T00:00:00.000Z",
  updatedBy: "account_admin",
} as const;

const brand = {
  id: "brand_firefly",
  tenantId: "tenant_001",
  name: "萤火汽车",
  status: "active",
  revision: 1,
  defaultVisualStylePresetId: "style_firefly_default",
  ...auditFields,
} satisfies Brand;

const vehicle = {
  id: "vehicle_e5_long_range",
  tenantId: brand.tenantId,
  brandId: brand.id,
  version: 1,
  status: "active",
  series: "萤火 E5",
  modelYear: 2026,
  trim: "长续航版",
  parameters: { seats: 5, energyType: "纯电" },
  fixedClaims: [fixedClaim],
  optionalClaims: [],
  prohibitedClaims: ["全国最低价"],
  ...auditFields,
} satisfies Vehicle;

const batchProject = {
  id: "batch_project_e5_vertical_launch",
  tenantId: brand.tenantId,
  brandId: brand.id,
  vehicleId: vehicle.id,
  vehicleVersion: vehicle.version,
  name: "萤火汽车 萤火 E5 9:16 夏季上新",
  batchName: "夏季上新",
  aspectRatio: "9:16",
  visualStylePresetId: brand.defaultVisualStylePresetId,
  customStylePrompt: "清爽夏日公路氛围",
  assetPoolId: "asset_pool_e5_vertical_launch",
  status: "active",
  revision: 1,
  ...auditFields,
} satisfies BatchProject;

const videoTask = {
  id: "video_task_family_weekend",
  tenantId: brand.tenantId,
  batchProjectId: batchProject.id,
  name: "家庭周末出行",
  ownerAccountId: "account_creator_001",
  status: "active",
  currentStage: "strategy",
  stageStatus: "in_progress",
  revision: 1,
  audience: "有孩家庭",
  theme: "周末郊游",
  durationSeconds: 30,
  scriptInput: "突出可信续航和家庭空间体验。",
  platformTags: ["douyin", "xiaohongshu"],
  ...auditFields,
} satisfies VideoTask;

const checksumSha256 = "a".repeat(64);

const vehicleAsset = {
  assetId: "asset_vehicle_front",
  version: 3,
  category: "vehicle",
  source: "company_catalog",
  sourceProvider: "company_asset_service",
  vehicleId: vehicle.id,
} satisfies CompanyVehicleAssetReference;

const personAsset = {
  assetId: "asset_person_family",
  version: 2,
  category: "person",
  source: "company_catalog",
  sourceProvider: "company_asset_service",
} satisfies CompanyReusableAssetReference;

const sceneAsset = {
  assetId: "asset_scene_campground",
  version: 4,
  category: "scene",
  source: "company_catalog",
  sourceProvider: "company_asset_service",
} satisfies CompanyReusableAssetReference;

const visualStyleAsset = {
  assetId: "style_firefly_default",
  version: 5,
  category: "visual_style",
  source: "company_catalog",
  sourceProvider: "company_asset_service",
} satisfies CompanyReusableAssetReference;

const temporaryAssetReference = {
  assetId: "temporary_asset_camping_gear",
  version: 1,
  category: "scene",
  source: "local_upload",
  batchProjectId: batchProject.id,
  checksumSha256,
} satisfies TemporaryAssetReference;

const projectAssetPool = {
  id: batchProject.assetPoolId,
  tenantId: brand.tenantId,
  batchProjectId: batchProject.id,
  vehicleId: vehicle.id,
  revision: 2,
  assets: [vehicleAsset, personAsset, sceneAsset, visualStyleAsset, temporaryAssetReference],
  createdAt: auditFields.createdAt,
  createdBy: auditFields.createdBy,
  updatedAt: auditFields.updatedAt,
  updatedBy: "account_creator_001",
} satisfies ProjectAssetPool;

const taskAssetSnapshot = {
  id: "asset_snapshot_family_weekend_v1",
  tenantId: brand.tenantId,
  batchProjectId: batchProject.id,
  videoTaskId: videoTask.id,
  version: 1,
  sourceProjectAssetPoolRevision: projectAssetPool.revision,
  vehicleSnapshotId: "vehicle_snapshot_e5_v1",
  assets: projectAssetPool.assets,
  createdAt: auditFields.createdAt,
  createdBy: videoTask.ownerAccountId,
} satisfies TaskAssetSnapshot;

const temporaryAsset = {
  id: temporaryAssetReference.assetId,
  tenantId: brand.tenantId,
  batchProjectId: batchProject.id,
  vehicleId: vehicle.id,
  version: temporaryAssetReference.version,
  revision: 1,
  category: temporaryAssetReference.category,
  fileName: "露营装备.png",
  mediaType: "image/png",
  byteSize: 2048000,
  width: 1920,
  height: 1080,
  checksumSha256,
  sourceDescription: "项目成员拍摄并上传的露营装备素材",
  rightsDeclaration: "上传者确认拥有本项目广告制作所需的使用授权",
  rightsConfirmed: true,
  validationStatus: "valid",
  validationIssues: [],
  ...auditFields,
} satisfies TemporaryAsset;

const strategyArtifactVersion = {
  id: "stage_artifact_strategy_v1",
  tenantId: brand.tenantId,
  batchProjectId: batchProject.id,
  videoTaskId: videoTask.id,
  stage: "strategy",
  version: 1,
  content: {
    artifactId: "strategy_family_weekend_v1",
    schemaName: "strategy",
    schemaVersion: 1,
    contentHashSha256: checksumSha256,
  },
  dependencies: [
    { kind: "vehicle_snapshot", vehicleSnapshotId: taskAssetSnapshot.vehicleSnapshotId },
    { kind: "asset_snapshot", assetSnapshotId: taskAssetSnapshot.id },
  ],
  provenance: { kind: "human_confirmation", confirmationId: "confirmation_strategy_v1" },
  createdAt: auditFields.createdAt,
  createdBy: videoTask.ownerAccountId,
} satisfies StageArtifactVersion;

const strategyConfirmation = {
  id: strategyArtifactVersion.provenance.confirmationId,
  tenantId: brand.tenantId,
  batchProjectId: batchProject.id,
  videoTaskId: videoTask.id,
  stage: strategyArtifactVersion.stage,
  artifactVersionId: strategyArtifactVersion.id,
  decision: "confirmed",
  source: "human_action",
  expectedTaskRevision: 4,
  actorAccountId: videoTask.ownerAccountId,
  comment: "策略事实与人工锁定项验收通过。",
  occurredAt: auditFields.createdAt,
} satisfies StageConfirmation;

const scriptArtifactVersion = {
  id: "stage_artifact_script_v1",
  tenantId: brand.tenantId,
  batchProjectId: batchProject.id,
  videoTaskId: videoTask.id,
  stage: "script",
  version: 1,
  content: {
    artifactId: "script_family_weekend_v1",
    schemaName: "script",
    schemaVersion: 1,
    contentHashSha256: "b".repeat(64),
  },
  dependencies: [
    { kind: "stage_artifact", stage: "strategy", artifactVersionId: "stage_artifact_strategy_v2" },
  ],
  provenance: { kind: "human_confirmation", confirmationId: "confirmation_script_v1" },
  createdAt: auditFields.createdAt,
  createdBy: videoTask.ownerAccountId,
} satisfies StageArtifactVersion;

const rollbackStageRequest = {
  expectedTaskRevision: 9,
  stage: "strategy",
  targetArtifactVersionId: strategyArtifactVersion.id,
  reason: "恢复到事实审核通过的策略版本。",
} satisfies RollbackStageRequest;

const stageRollbackRecord = {
  id: "rollback_strategy_v2_to_v1",
  tenantId: brand.tenantId,
  batchProjectId: batchProject.id,
  videoTaskId: videoTask.id,
  stage: rollbackStageRequest.stage,
  fromArtifactVersionId: "stage_artifact_strategy_v2",
  toArtifactVersionId: rollbackStageRequest.targetArtifactVersionId,
  expectedTaskRevision: rollbackStageRequest.expectedTaskRevision,
  reason: rollbackStageRequest.reason,
  requestedBy: videoTask.ownerAccountId,
  invalidationIds: ["invalidation_script_v1"],
  occurredAt: auditFields.updatedAt,
} satisfies StageRollbackRecord;

const scriptInvalidation = {
  id: "invalidation_script_v1",
  tenantId: brand.tenantId,
  batchProjectId: batchProject.id,
  videoTaskId: videoTask.id,
  stage: scriptArtifactVersion.stage,
  artifactVersionId: scriptArtifactVersion.id,
  reason: "脚本依赖的策略 v2 已回退到 v1。",
  invalidatedDependency: {
    kind: "stage_artifact",
    stage: "strategy",
    artifactVersionId: stageRollbackRecord.fromArtifactVersionId,
  },
  cause: {
    kind: "rollback",
    reasonCode: "upstream_rollback",
    rollbackId: stageRollbackRecord.id,
  },
  occurredAt: auditFields.updatedAt,
} satisfies StageArtifactInvalidation;

test("fixed claim requires valid evidence shape", () => {
  assert.equal(Value.Check(ClaimSchema, fixedClaim), true);
  assert.equal(Value.Check(ClaimSchema, { ...fixedClaim, evidence: { sourceName: "" } }), false);
});

test("workspace v2 brand schema requires tenant scope, revision, and a default visual style", () => {
  assert.equal(Value.Check(BrandSchema, brand), true);
  const { defaultVisualStylePresetId: _style, ...withoutDefaultStyle } = brand;
  assert.equal(Value.Check(BrandSchema, withoutDefaultStyle), false);
  assert.equal(Value.Check(BrandSchema, { ...brand, revision: 0 }), false);
  assert.equal(Value.Check(BrandSchema, { ...brand, clientManagedScope: true }), false);
});

test("workspace v2 vehicle schema carries versioned official facts without asset-private fields", () => {
  assert.equal(Value.Check(VehicleSchema, vehicle), true);
  assert.equal(Value.Check(VehicleSchema, { ...vehicle, version: 0 }), false);
  assert.equal(Value.Check(VehicleSchema, { ...vehicle, modelYear: 1999 }), false);
  assert.equal(Value.Check(VehicleSchema, { ...vehicle, referenceAssetIds: ["asset_private_001"] }), false);
});

test("workspace v2 batch project locks vehicle, visual style, and aspect ratio at project level", () => {
  assert.equal(Value.Check(BatchProjectSchema, batchProject), true);
  assert.equal(Value.Check(BatchProjectSchema, { ...batchProject, vehicleVersion: 0 }), false);
  const { vehicleVersion: _vehicleVersion, ...withoutVehicleVersion } = batchProject;
  assert.equal(Value.Check(BatchProjectSchema, withoutVehicleVersion), false);
  assert.equal(Value.Check(BatchProjectSchema, { ...batchProject, aspectRatio: "vertical" }), false);
  assert.equal(Value.Check(BatchProjectSchema, { ...batchProject, customStylePrompt: "" }), false);
  assert.equal(Value.Check(BatchProjectSchema, { ...batchProject, platformTags: ["douyin"] }), false);
});

test("workspace v2 video task owns its operator and task-level production inputs", () => {
  assert.equal(Value.Check(VideoTaskSchema, videoTask), true);
  const { stageStatus: _stageStatus, ...withoutStageStatus } = videoTask;
  assert.equal(Value.Check(VideoTaskSchema, withoutStageStatus), false);
  assert.equal(Value.Check(VideoTaskSchema, { ...videoTask, vehicleSnapshotId: "snapshot_001" }), true);
  assert.equal(Value.Check(VideoTaskSchema, { ...videoTask, durationSeconds: 0 }), false);
  assert.equal(Value.Check(VideoTaskSchema, { ...videoTask, stageStatus: "approved" }), false);
  assert.equal(Value.Check(VideoTaskSchema, { ...videoTask, platformTags: ["douyin", "douyin"] }), false);
  assert.equal(Value.Check(VideoTaskSchema, { ...videoTask, aspectRatio: "9:16" }), false);
});

test("asset references distinguish vehicle-bound, reusable, and project-local sources", () => {
  for (const reference of projectAssetPool.assets) {
    assert.equal(Value.Check(AssetReferenceSchema, reference), true);
  }
  const { vehicleId: _vehicleId, ...unboundVehicleAsset } = vehicleAsset;
  assert.equal(Value.Check(AssetReferenceSchema, unboundVehicleAsset), false);
  assert.equal(Value.Check(AssetReferenceSchema, { ...personAsset, vehicleId: vehicle.id }), false);
  assert.equal(Value.Check(AssetReferenceSchema, { ...sceneAsset, version: 0 }), false);
  assert.equal(Value.Check(AssetReferenceSchema, { ...temporaryAssetReference, checksumSha256: "bad" }), false);
});

test("project asset pools track current catalog data while task snapshots lock exact versions", () => {
  assert.equal(Value.Check(ProjectAssetPoolSchema, projectAssetPool), true);
  assert.equal(Value.Check(TaskAssetSnapshotSchema, taskAssetSnapshot), true);
  assert.equal(
    Value.Check(TaskAssetSnapshotSchema, { ...taskAssetSnapshot, sourceProjectAssetPoolRevision: 0 }),
    false,
  );
  assert.equal(Value.Check(TaskAssetSnapshotSchema, { ...taskAssetSnapshot, downloadUrl: "https://invalid" }), false);
});

test("temporary asset metadata records validation, duplicate, source, and usage rights fields", () => {
  assert.equal(Value.Check(TemporaryAssetSchema, temporaryAsset), true);
  assert.equal(Value.Check(TemporaryAssetSchema, { ...temporaryAsset, fileName: "../escape.png" }), false);
  assert.equal(Value.Check(TemporaryAssetSchema, { ...temporaryAsset, mediaType: "application/octet-stream" }), false);
  assert.equal(Value.Check(TemporaryAssetSchema, { ...temporaryAsset, width: 0 }), false);
  assert.equal(Value.Check(TemporaryAssetSchema, { ...temporaryAsset, rightsDeclaration: "" }), false);
  assert.equal(
    Value.Check(TemporaryAssetSchema, {
      ...temporaryAsset,
      validationStatus: "needs_review",
      validationIssues: [{ code: "AIC-ASSET-DUPLICATE", message: "检测到重复素材。" }],
      duplicateOfAssetId: "temporary_asset_existing",
    }),
    true,
  );
});

test("confirmed stage versions are immutable references with explicit upstream dependencies", () => {
  assert.equal(Value.Check(StageArtifactVersionSchema, strategyArtifactVersion), true);
  assert.equal(Value.Check(StageArtifactVersionSchema, scriptArtifactVersion), true);
  assert.equal(Value.Check(StageArtifactVersionSchema, { ...strategyArtifactVersion, version: 0 }), false);
  assert.equal(Value.Check(StageArtifactVersionSchema, { ...strategyArtifactVersion, dependencies: [] }), false);
  assert.equal(
    Value.Check(StageArtifactVersionSchema, {
      ...strategyArtifactVersion,
      content: { ...strategyArtifactVersion.content, contentHashSha256: "invalid" },
    }),
    false,
  );
  assert.equal(Value.Check(StageArtifactVersionSchema, { ...strategyArtifactVersion, updatedAt: auditFields.updatedAt }), false);
  assert.equal(Value.Check(StageArtifactVersionSchema, { ...strategyArtifactVersion, rawModelPayload: {} }), false);
});

test("stage version provenance distinguishes human confirmation from migrations and inference", () => {
  assert.equal(Value.Check(StageArtifactVersionSchema, strategyArtifactVersion), true);
  assert.equal(
    Value.Check(StageArtifactVersionSchema, {
      ...strategyArtifactVersion,
      provenance: { kind: "migrated_confirmation", legacyApprovalId: "legacy_approval_001" },
    }),
    true,
  );
  assert.equal(
    Value.Check(StageArtifactVersionSchema, {
      ...strategyArtifactVersion,
      provenance: { kind: "legacy_inferred", migrationId: "migration_v1", note: "旧流程没有资产确认点。" },
    }),
    true,
  );
  assert.equal(
    Value.Check(StageArtifactVersionSchema, {
      ...strategyArtifactVersion,
      provenance: { kind: "model_confirmation", confirmationId: "model_001" },
    }),
    false,
  );
});

test("stage confirmation records only explicit human confirmation actions", () => {
  assert.equal(Value.Check(StageConfirmationSchema, strategyConfirmation), true);
  assert.equal(Value.Check(StageConfirmationSchema, { ...strategyConfirmation, source: "agent" }), false);
  assert.equal(Value.Check(StageConfirmationSchema, { ...strategyConfirmation, decision: "rejected" }), false);
  assert.equal(Value.Check(StageConfirmationSchema, { ...strategyConfirmation, expectedTaskRevision: 0 }), false);
  assert.equal(Value.Check(StageConfirmationSchema, { ...strategyConfirmation, approvedByModel: true }), false);
});

test("rollback records name the restored version and all direct invalidations", () => {
  assert.equal(Value.Check(RollbackStageRequestSchema, rollbackStageRequest), true);
  assert.equal(Value.Check(StageRollbackRecordSchema, stageRollbackRecord), true);
  assert.equal(Value.Check(RollbackStageRequestSchema, { ...rollbackStageRequest, reason: "" }), false);
  assert.equal(
    Value.Check(StageRollbackRecordSchema, {
      ...stageRollbackRecord,
      invalidationIds: [scriptInvalidation.id, scriptInvalidation.id],
    }),
    false,
  );
});

test("downstream invalidations identify the broken dependency and propagation cause", () => {
  assert.equal(Value.Check(StageArtifactInvalidationSchema, scriptInvalidation), true);
  assert.equal(Value.Check(StageArtifactInvalidationSchema, { ...scriptInvalidation, reason: "" }), false);
  assert.equal(
    Value.Check(StageArtifactInvalidationSchema, {
      ...scriptInvalidation,
      cause: { ...scriptInvalidation.cause, reasonCode: "upstream_invalidation" },
    }),
    false,
  );
  assert.equal(Value.Check(StageArtifactInvalidationSchema, { ...scriptInvalidation, invalidatedDependency: {} }), false);
});

test("vehicle snapshot rejects unknown properties and invalid versions", () => {
  const snapshot = {
    id: "vs_001",
    projectId: "project_001",
    vehicleId: "vehicle_001",
    vehicleVersion: 1,
    brandId: "brand_001",
    brand: "示例汽车",
    series: "示例车系",
    modelYear: 2026,
    trim: "旗舰版",
    parameters: { seats: 5 },
    fixedClaims: [fixedClaim],
    optionalClaims: [],
    prohibitedClaims: ["全国最低价"],
    referenceAssetIds: ["asset_001"],
    createdAt: "2026-08-14T00:00:00.000Z",
    createdBy: "user_001",
  };
  assert.equal(Value.Check(VehicleSnapshotSchema, snapshot), true);
  assert.equal(Value.Check(VehicleSnapshotSchema, { ...snapshot, vehicleVersion: 0 }), false);
  assert.equal(Value.Check(VehicleSnapshotSchema, { ...snapshot, secret: "not-allowed" }), false);
});

test("work schema validates revisioned workflow state", () => {
  assert.equal(
    Value.Check(WorkSchema, {
      id: "work_001",
      projectId: "project_001",
      status: "created",
      revision: 1,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    }),
    true,
  );
  assert.equal(
    Value.Check(WorkSchema, {
      id: "work_001",
      projectId: "project_001",
      status: "published_to_media",
      revision: 1,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    }),
    false,
  );
});

test("strategy action proposals are versioned and reject untrusted fields", () => {
  const proposal = {
    schemaVersion: 1,
    kind: "action_proposal",
    action: "generate_strategy",
    label: "生成卖点策略草稿",
    summary: "面向家庭用户生成周末出行策略",
    expectedRevision: 2,
    payload: { expectedRevision: 2, audience: "有孩家庭", theme: "周末出行" },
  };
  assert.equal(Value.Check(StrategyActionProposalSchema, proposal), true);
  assert.equal(Value.Check(StrategyActionProposalSchema, { ...proposal, approved: true }), false);
});

test("task context is a strict server-resolved read-only summary", () => {
  assert.equal(Value.Check(TaskContextSchema, taskContextFixture), true);
  assert.equal(
    Value.Check(TaskContextSchema, {
      ...taskContextFixture,
      videoTask: { ...taskContextFixture.videoTask, stageStatus: "approved" },
    }),
    false,
  );
  assert.equal(Value.Check(TaskContextSchema, { ...taskContextFixture, role: "creator" }), false);
  assert.equal(Value.Check(TaskContextSchema, { ...taskContextFixture, permissions: ["task:write"] }), false);
  assert.equal(Value.Check(TaskContextSchema, { ...taskContextFixture, allowedBrandIds: ["brand_firefly"] }), false);
  assert.equal(Value.Check(TaskContextSchema, { ...taskContextFixture, budgetAuthority: 100 }), false);
  assert.equal(
    Value.Check(TaskContextSchema, {
      ...taskContextFixture,
      videoTask: { ...taskContextFixture.videoTask, ownerAccountId: "account_creator" },
    }),
    false,
  );
});

test("agent action cards share one versioned proposal contract", () => {
  for (const card of agentActionCardFixtures) {
    assert.equal(Value.Check(AgentActionCardSchema, card), true);
  }

  const generationCard = agentActionCardFixtures[0];
  assert.ok(generationCard);
  const { videoTaskId: _taskId, ...withoutTaskId } = generationCard;
  assert.equal(Value.Check(AgentActionCardSchema, withoutTaskId), false);
  assert.equal(Value.Check(AgentActionCardSchema, { ...generationCard, expectedRevision: 0 }), false);
  assert.equal(Value.Check(AgentActionCardSchema, { ...generationCard, approved: true }), false);
  assert.equal(Value.Check(AgentActionCardSchema, { ...generationCard, actorId: "account_creator" }), false);
  assert.equal(Value.Check(AgentActionCardSchema, { ...generationCard, permission: "task:write" }), false);
  assert.equal(Value.Check(AgentActionCardSchema, { ...generationCard, apiRoute: "/v1/internal/execute" }), false);
  assert.equal(Value.Check(AgentActionCardSchema, { ...generationCard, charged: true }), false);
  assert.equal(
    Value.Check(AgentActionCardSchema, {
      ...generationCard,
      cost: { kind: "estimated", amount: -1, currency: "CNY" },
    }),
    false,
  );
});

test("agent action card payloads cannot be mixed or fabricate server rollback results", () => {
  const generationCard = agentActionCardFixtures[0];
  const rollbackCard = agentActionCardFixtures[2];
  assert.ok(generationCard);
  assert.ok(rollbackCard);
  assert.equal(Value.Check(AgentActionCardSchema, { ...generationCard, payload: rollbackCard.payload }), false);
  assert.equal(
    Value.Check(AgentActionCardSchema, {
      ...rollbackCard,
      payload: { ...rollbackCard.payload, invalidationIds: ["invalidation_script_v1"] },
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentActionCardSchema, {
      ...rollbackCard,
      payload: { ...rollbackCard.payload, confirmationId: "confirmation_strategy_v1" },
    }),
    false,
  );
});

test("agent stream events require stable ids, ordering, and task-bound action cards", () => {
  const card = agentActionCardFixtures[0];
  assert.ok(card);
  const event = {
    schemaVersion: 1,
    eventId: "event_stream_fixture_001",
    sequence: 1,
    sessionId: "session_stream_fixture_001",
    runId: "run_stream_fixture_001",
    videoTaskId: taskContextFixture.videoTask.id,
    occurredAt: "2026-08-18T00:00:00.000Z",
    type: "action_card",
    card,
  };
  assert.equal(Value.Check(AgentStreamEventSchema, event), true);
  assert.equal(Value.Check(AgentStreamEventSchema, { ...event, sequence: 0 }), false);
  assert.equal(Value.Check(AgentStreamEventSchema, { ...event, eventId: "" }), false);
});
