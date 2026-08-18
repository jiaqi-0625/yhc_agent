import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  BatchProjectSchema,
  BrandSchema,
  ClaimSchema,
  StrategyActionProposalSchema,
  VehicleSchema,
  VehicleSnapshotSchema,
  VideoTaskSchema,
  WorkSchema,
  type BatchProject,
  type Brand,
  type Claim,
  type Vehicle,
  type VideoTask,
} from "../src/index.ts";

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
  name: "萤火汽车 萤火 E5 9:16 夏季上新",
  batchName: "夏季上新",
  aspectRatio: "9:16",
  visualStylePresetId: brand.defaultVisualStylePresetId,
  customStylePrompt: "清爽夏日公路氛围",
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
  revision: 1,
  audience: "有孩家庭",
  theme: "周末郊游",
  durationSeconds: 30,
  scriptInput: "突出可信续航和家庭空间体验。",
  platformTags: ["douyin", "xiaohongshu"],
  ...auditFields,
} satisfies VideoTask;

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
  assert.equal(Value.Check(BatchProjectSchema, { ...batchProject, aspectRatio: "vertical" }), false);
  assert.equal(Value.Check(BatchProjectSchema, { ...batchProject, customStylePrompt: "" }), false);
  assert.equal(Value.Check(BatchProjectSchema, { ...batchProject, platformTags: ["douyin"] }), false);
});

test("workspace v2 video task owns its operator and task-level production inputs", () => {
  assert.equal(Value.Check(VideoTaskSchema, videoTask), true);
  assert.equal(Value.Check(VideoTaskSchema, { ...videoTask, vehicleSnapshotId: "snapshot_001" }), true);
  assert.equal(Value.Check(VideoTaskSchema, { ...videoTask, durationSeconds: 0 }), false);
  assert.equal(Value.Check(VideoTaskSchema, { ...videoTask, platformTags: ["douyin", "douyin"] }), false);
  assert.equal(Value.Check(VideoTaskSchema, { ...videoTask, aspectRatio: "9:16" }), false);
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
