import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentActionCommandError,
  RevisionConflictError,
  WorkspaceAccessDeniedError,
  type VideoTaskProductionRecord,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  AgentActionCard,
  BatchProject,
  ProjectAssetPool,
} from "@firefly/schemas";

import { AgentActionCommandRuntime } from "../src/agent-action-command-runtime.ts";
import { LocalBatchProjectStore } from "../src/batch-project-store.ts";
import { BusinessRuntimeError } from "../src/business-runtime.ts";
import { VideoTaskRuntime } from "../src/video-task-runtime.ts";
import { LocalVideoTaskProductionStore } from "../src/video-task-store.ts";
import { LocalTemporaryAssetStore } from "../src/temporary-asset-store.ts";
import {
  DEFAULT_ADMIN_BRANDS,
  DEFAULT_ADMIN_VEHICLES,
  DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
} from "../src/workspace-admin-runtime.ts";
import { LocalWorkspaceAdminStore } from "../src/workspace-admin-store.ts";
import {
  DEVELOPMENT_ACCESS_GRANTS,
  DEVELOPMENT_ACCOUNTS,
} from "../src/workspace-session-runtime.ts";

const tenantId = "tenant_firefly";
const projectId = "batch_project_ws305";
const vehicleId = "vehicle_firefly_e5_2026_long_range";

const project: BatchProject = {
  id: projectId,
  tenantId,
  brandId: "brand_firefly_demo",
  vehicleId,
  vehicleVersion: 1,
  name: "萤火汽车 萤火 E5 长续航版 9:16 WS305",
  batchName: "WS305",
  aspectRatio: "9:16",
  visualStylePresetId: "asset_style_firefly_demo_clean",
  assetPoolId: "project_asset_pool_ws305",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T14:00:00.000Z",
  createdBy: "account_creator_a",
  updatedAt: "2026-08-19T14:00:00.000Z",
  updatedBy: "account_creator_a",
};

const assetPool: ProjectAssetPool = {
  id: project.assetPoolId,
  tenantId,
  batchProjectId: project.id,
  vehicleId,
  revision: 1,
  assets: [{
    assetId: "asset_firefly_demo_e5_hero",
    version: 1,
    source: "company_catalog",
    sourceProvider: "mock_company_assets",
    category: "vehicle",
    vehicleId,
  }],
  createdAt: project.createdAt,
  createdBy: project.createdBy,
  updatedAt: project.updatedAt,
  updatedBy: project.updatedBy,
};

async function fixture() {
  const administration = new LocalWorkspaceAdminStore(".data/test-ws305-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES.map((vehicle) => ({
      ...vehicle,
      fixedClaims: [{
        id: "claim_family_space",
        kind: "fixed" as const,
        name: "五座空间",
        statement: "提供五座乘坐空间。",
        evidence: {
          sourceName: "车型配置表",
          sourceReference: "vehicle-facts-v1",
          effectiveFrom: "2026-08-01",
        },
        requiredInVoiceover: true,
        requiredInSubtitle: true,
        mayRephrase: true,
        riskNotes: [],
      }],
    })),
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const projects = new LocalBatchProjectStore(".data/test-ws305-projects", false);
  await projects.create(project, assetPool, {
    requestId: "request_ws305_project",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_ws305_project",
  });
  const tasks = new LocalVideoTaskProductionStore(".data/test-ws305-tasks", false);
  let sequence = 0;
  const commandRuntime = new AgentActionCommandRuntime(
    administration,
    projects,
    tasks,
    () => "2026-08-19T14:30:00.000Z",
    (kind) => `${kind}_${++sequence}`,
  );
  const videoTasks = new VideoTaskRuntime(
    administration,
    projects,
    tasks,
    () => DEVELOPMENT_ACCOUNTS,
    () => "2026-08-19T14:15:00.000Z",
  );
  const creator = await scope(administration);
  const created = await videoTasks.create(project.id, {
    requestId: "request_ws305_task",
    name: "WS305 策略任务",
    audience: "城市家庭",
    theme: "智能通勤",
    durationSeconds: 30,
    platformTags: ["douyin"],
  }, creator);
  return {
    administration,
    commandRuntime,
    creator,
    projects,
    taskId: created.record.videoTask.id,
    tasks,
  };
}

async function scope(
  administration: LocalWorkspaceAdminStore,
  accountId = "account_creator_a",
): Promise<WorkspaceSessionScope> {
  const account = DEVELOPMENT_ACCOUNTS.find((candidate) => candidate.accountId === accountId);
  assert.ok(account);
  return {
    actorAccountId: account.accountId,
    tenantId: account.tenantId,
    role: account.role,
    accessGrants: await administration.listForAccount(account.tenantId, account.accountId),
  };
}

function generateCard(
  videoTaskId: string,
  expectedRevision = 1,
): Extract<AgentActionCard, { action: "generate_strategy" }> {
  return {
    schemaVersion: 1,
    kind: "agent_action_card",
    videoTaskId,
    action: "generate_strategy",
    label: "生成卖点策略草稿",
    summary: "使用锁定车型事实生成策略。",
    expectedRevision,
    cost: { kind: "estimated", amount: 999, currency: "CNY" },
    payload: { schemaVersion: 1, audience: "城市家庭", theme: "智能通勤" },
  };
}

test("unified commands generate and request approval atomically with server-free receipts", async () => {
  const { commandRuntime, creator, taskId, tasks } = await fixture();
  const generated = await commandRuntime.execute(project.id, taskId, {
    requestId: "command_generate_strategy",
    card: generateCard(taskId),
  }, creator);

  assert.equal(generated.replayed, false);
  assert.equal(generated.videoTask.revision, 2);
  assert.deepEqual(generated.receipt.cost, { kind: "free", amountMinor: 0, charged: false });
  assert.equal(generated.receipt.result.kind, "strategy_generated");
  const aggregate = await tasks.load(taskId);
  assert.equal(aggregate?.taskVehicleSnapshots.length, 1);
  assert.equal(aggregate?.taskAssetSnapshots.length, 1);
  assert.equal(aggregate?.strategyDrafts.length, 1);
  assert.equal(aggregate?.commandReceipts.length, 1);
  assert.equal(aggregate?.taskAssetSnapshots[0]?.assets[0]?.assetId, assetPool.assets[0]?.assetId);

  const replay = await commandRuntime.execute(project.id, taskId, {
    requestId: "command_generate_strategy",
    card: {
      ...generateCard(taskId),
      summary: "展示文案变更不会改变执行命令。",
      cost: { kind: "free" },
    },
  }, creator);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, generated.receipt);
  assert.equal((await tasks.load(taskId))?.commandReceipts.length, 1);

  await assert.rejects(
    commandRuntime.execute(project.id, taskId, {
      requestId: "command_generate_strategy",
      card: {
        ...generateCard(taskId),
        payload: {
          ...generateCard(taskId).payload,
          theme: "重用 requestId 伪造不同业务输入",
        },
      },
    }, creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-AGENT-COMMAND-IDEMPOTENCY_CONFLICT",
  );

  const approval = await commandRuntime.execute(project.id, taskId, {
    requestId: "command_request_approval",
    card: {
      schemaVersion: 1,
      kind: "agent_action_card",
      videoTaskId: taskId,
      action: "request_strategy_approval",
      label: "提交卖点策略人工审批",
      summary: "由当前负责人提交人工确认。",
      expectedRevision: 2,
      cost: { kind: "estimated", amount: 88, currency: "USD" },
      payload: { schemaVersion: 1 },
    },
  }, creator);
  assert.equal(approval.videoTask.revision, 3);
  assert.equal(approval.videoTask.stageStatus, "awaiting_confirmation");
  assert.deepEqual(approval.receipt.cost, { kind: "free", amountMinor: 0, charged: false });
  assert.equal(approval.receipt.result.kind, "strategy_confirmation_requested");
});

test("unified commands reject forged scope, stale revision, non-owner, role confusion, and revocation", async () => {
  const { administration, commandRuntime, creator, taskId } = await fixture();
  await assert.rejects(
    commandRuntime.execute(project.id, taskId, {
      requestId: "command_wrong_task",
      card: generateCard("task_attacker"),
    }, creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError && error.code === "AIC-AGENT-COMMAND-SCOPE_INVALID",
  );

  const otherCreator = await scope(administration, "account_creator_b");
  await assert.rejects(
    commandRuntime.execute(project.id, taskId, {
      requestId: "command_non_owner",
      card: generateCard(taskId),
    }, otherCreator),
    WorkspaceAccessDeniedError,
  );
  const administrator = await scope(administration, "account_admin");
  await assert.rejects(
    commandRuntime.execute(project.id, taskId, {
      requestId: "command_admin",
      card: generateCard(taskId),
    }, administrator),
    (error: unknown) => error instanceof BusinessRuntimeError && error.code === "AIC-AUTH-ROLE_DENIED",
  );

  await commandRuntime.execute(project.id, taskId, {
    requestId: "command_first",
    card: generateCard(taskId),
  }, creator);
  await assert.rejects(
    commandRuntime.execute(project.id, taskId, {
      requestId: "command_stale_revision",
      card: generateCard(taskId),
    }, creator),
    RevisionConflictError,
  );

  await administration.transact(tenantId, (state) => ({
    ...state,
    accessGrants: state.accessGrants.map((grant) =>
      grant.accountId === creator.actorAccountId
        ? { ...grant, status: "revoked" as const, revision: grant.revision + 1 }
        : grant),
  }));
  await assert.rejects(
    commandRuntime.execute(project.id, taskId, {
      requestId: "command_after_revocation",
      card: generateCard(taskId, 2),
    }, creator),
    WorkspaceAccessDeniedError,
  );
});

test("rollback appends its audit and command receipt in one task transaction", async () => {
  const { commandRuntime, creator, taskId, tasks } = await fixture();
  const current = (await tasks.load(taskId))!;
  const rollbackRecord: VideoTaskProductionRecord = {
    ...current,
    videoTask: {
      ...current.videoTask,
      status: "active",
      currentStage: "asset_matching",
      stageStatus: "in_progress",
      revision: 5,
    },
    stageArtifactVersions: [1, 2].map((version) => ({
      id: `strategy_v${version}`,
      tenantId,
      batchProjectId: project.id,
      videoTaskId: taskId,
      stage: "strategy" as const,
      version,
      content: {
        artifactId: `strategy_content_v${version}`,
        schemaName: "marketing_strategy",
        schemaVersion: 1,
        contentHashSha256: version.toString(16).padStart(64, "0"),
      },
      dependencies: [{ kind: "vehicle_snapshot" as const, vehicleSnapshotId: "legacy_snapshot" }],
      provenance: {
        kind: "human_confirmation" as const,
        confirmationId: `confirmation_v${version}`,
      },
      createdAt: `2026-08-19T0${version}:00:00.000Z`,
      createdBy: creator.actorAccountId,
    })),
    stageConfirmations: [1, 2].map((version) => ({
      id: `confirmation_v${version}`,
      tenantId,
      batchProjectId: project.id,
      videoTaskId: taskId,
      stage: "strategy" as const,
      artifactVersionId: `strategy_v${version}`,
      decision: "confirmed" as const,
      source: "human_action" as const,
      expectedTaskRevision: version,
      actorAccountId: creator.actorAccountId,
      occurredAt: `2026-08-19T0${version}:00:00.000Z`,
    })),
    activeStageArtifactVersionIds: { strategy: "strategy_v2" },
  };
  await tasks.save(rollbackRecord);

  const result = await commandRuntime.execute(project.id, taskId, {
    requestId: "command_rollback_strategy",
    card: {
      schemaVersion: 1,
      kind: "agent_action_card",
      videoTaskId: taskId,
      action: "rollback_stage",
      label: "回退已确认阶段版本",
      summary: "恢复到第一版策略。",
      expectedRevision: 5,
      cost: { kind: "estimate_required" },
      payload: {
        schemaVersion: 1,
        stage: "strategy",
        targetArtifactVersionId: "strategy_v1",
        reason: "恢复事实审核通过的版本",
      },
    },
  }, creator);

  assert.equal(result.videoTask.revision, 6);
  assert.equal(result.receipt.result.kind, "stage_rolled_back");
  assert.deepEqual(result.receipt.cost, { kind: "free", amountMinor: 0, charged: false });
  const persisted = await tasks.load(taskId);
  assert.equal(persisted?.stageRollbacks.length, 1);
  assert.equal(persisted?.commandReceipts.length, 1);
  assert.equal(
    result.receipt.result.kind === "stage_rolled_back"
      ? result.receipt.result.stageRollbackId
      : undefined,
    persisted?.stageRollbacks[0]?.id,
  );
});

test("approval without a generated draft remains a state conflict", async () => {
  const { commandRuntime, creator, taskId } = await fixture();
  await assert.rejects(
    commandRuntime.execute(project.id, taskId, {
      requestId: "command_missing_draft",
      card: {
        schemaVersion: 1,
        kind: "agent_action_card",
        videoTaskId: taskId,
        action: "request_strategy_approval",
        label: "提交卖点策略人工审批",
        summary: "尚未生成策略时不得提交。",
        expectedRevision: 1,
        cost: { kind: "free" },
        payload: { schemaVersion: 1 },
      },
    }, creator),
    AgentActionCommandError,
  );
});

test("locked vehicle facts survive catalog archival and successful commands replay after owner changes", async () => {
  const { administration, commandRuntime, creator, taskId, tasks } = await fixture();
  const request = {
    requestId: "command_replay_after_change",
    card: generateCard(taskId),
  } as const;
  const generated = await commandRuntime.execute(project.id, taskId, request, creator);
  assert.equal(generated.videoTask.revision, 2);

  await administration.transact(tenantId, (current) => ({
    ...current,
    brands: current.brands.map((brand) =>
      brand.id === project.brandId
        ? { ...brand, status: "archived" as const, revision: brand.revision + 1 }
        : brand),
  }));
  const regenerated = await commandRuntime.execute(project.id, taskId, {
    requestId: "command_regenerate_after_archive",
    card: generateCard(taskId, 2),
  }, creator);
  assert.equal(regenerated.videoTask.revision, 3);

  await tasks.transact(taskId, (current) => {
    assert.ok(current);
    return {
      ...structuredClone(current),
      videoTask: {
        ...structuredClone(current.videoTask),
        ownerAccountId: "account_creator_b",
        revision: current.videoTask.revision + 1,
      },
    };
  });
  const replayed = await commandRuntime.execute(project.id, taskId, request, creator);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.receipt, generated.receipt);
  assert.equal(replayed.videoTask.ownerAccountId, "account_creator_b");
});

test("project authorization precedes task lookup and unusable temporary assets cannot be locked", async () => {
  const { administration, creator, projects, taskId, tasks } = await fixture();
  const temporaryAssets = new LocalTemporaryAssetStore(".data/test-ws305-temporary", false);
  const checksumSha256 = "c".repeat(64);
  await projects.transactAssetPool(tenantId, project.id, (current) => ({
    ...current,
    revision: current.revision + 1,
    assets: [...current.assets, {
      assetId: "temporary_expired",
      version: 1,
      category: "scene",
      source: "local_upload",
      batchProjectId: project.id,
      checksumSha256,
    }],
  }));
  await temporaryAssets.transactProject(project.id, () => [{
    id: "temporary_expired",
    tenantId,
    batchProjectId: project.id,
    vehicleId,
    version: 1,
    revision: 1,
    category: "scene",
    fileName: "scene.png",
    mediaType: "image/png",
    byteSize: 1024,
    width: 1280,
    height: 720,
    checksumSha256,
    sourceDescription: "项目现场拍摄",
    rightsDeclaration: "已取得本项目使用授权",
    rightsConfirmed: true,
    validationStatus: "valid",
    validationIssues: [],
    expiresAt: "2026-08-19T14:29:59.000Z",
    createdAt: "2026-08-19T14:00:00.000Z",
    createdBy: creator.actorAccountId,
    updatedAt: "2026-08-19T14:00:00.000Z",
    updatedBy: creator.actorAccountId,
  }]);
  const runtime = new AgentActionCommandRuntime(
    administration,
    projects,
    tasks,
    () => "2026-08-19T14:30:00.000Z",
    (kind) => `${kind}_temporary_test`,
    temporaryAssets,
  );

  await assert.rejects(
    runtime.execute(project.id, taskId, {
      requestId: "command_expired_asset",
      card: generateCard(taskId),
    }, creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-AGENT-COMMAND-ASSET_SNAPSHOT_INVALID",
  );
  await temporaryAssets.transactProject(project.id, (current) => current.map((asset) => ({
    ...asset,
    revision: asset.revision + 1,
    validationStatus: "needs_review" as const,
    validationIssues: [{
      code: "AIC-ASSET-RIGHTS_REVIEW_REQUIRED",
      message: "素材授权需要复核。",
    }],
    expiresAt: "2026-08-20T14:30:00.000Z",
  })));
  await assert.rejects(
    runtime.execute(project.id, taskId, {
      requestId: "command_review_asset",
      card: generateCard(taskId),
    }, creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-AGENT-COMMAND-ASSET_SNAPSHOT_INVALID",
  );
  await assert.rejects(
    runtime.execute(project.id, "task_guessed", {
      requestId: "command_guess_task",
      card: generateCard("task_guessed"),
    }, { ...creator, actorAccountId: "account_ungranted", accessGrants: [] }),
    WorkspaceAccessDeniedError,
  );
});

test("a locked task regenerates from its asset snapshot after the current pool asset expires", async () => {
  const { administration, commandRuntime, creator, projects, taskId, tasks } = await fixture();
  await commandRuntime.execute(project.id, taskId, {
    requestId: "command_lock_asset_snapshot",
    card: generateCard(taskId),
  }, creator);

  const temporaryAssets = new LocalTemporaryAssetStore(
    ".data/test-ws305-locked-temporary",
    false,
  );
  const checksumSha256 = "d".repeat(64);
  await projects.transactAssetPool(tenantId, project.id, (current) => ({
    ...current,
    revision: current.revision + 1,
    assets: [...current.assets, {
      assetId: "temporary_expired_after_lock",
      version: 1,
      category: "scene",
      source: "local_upload",
      batchProjectId: project.id,
      checksumSha256,
    }],
  }));
  await temporaryAssets.transactProject(project.id, () => [{
    id: "temporary_expired_after_lock",
    tenantId,
    batchProjectId: project.id,
    vehicleId,
    version: 1,
    revision: 1,
    category: "scene",
    fileName: "expired-after-lock.png",
    mediaType: "image/png",
    byteSize: 1024,
    width: 1280,
    height: 720,
    checksumSha256,
    sourceDescription: "项目现场拍摄",
    rightsDeclaration: "已取得本项目使用授权",
    rightsConfirmed: true,
    validationStatus: "valid",
    validationIssues: [],
    expiresAt: "2026-08-19T14:29:59.000Z",
    createdAt: "2026-08-19T14:00:00.000Z",
    createdBy: creator.actorAccountId,
    updatedAt: "2026-08-19T14:00:00.000Z",
    updatedBy: creator.actorAccountId,
  }]);
  const runtime = new AgentActionCommandRuntime(
    administration,
    projects,
    tasks,
    () => "2026-08-19T14:30:00.000Z",
    (kind) => `${kind}_locked_regeneration`,
    temporaryAssets,
  );

  const regenerated = await runtime.execute(project.id, taskId, {
    requestId: "command_regenerate_from_locked_snapshot",
    card: generateCard(taskId, 2),
  }, creator);

  assert.equal(regenerated.videoTask.revision, 3);
  assert.equal(regenerated.receipt.result.kind, "strategy_generated");
  const persisted = await tasks.load(taskId);
  assert.equal(persisted?.taskAssetSnapshots.length, 1);
  assert.equal(persisted?.taskAssetSnapshots[0]?.assets.length, 1);
  assert.equal(persisted?.strategyDrafts.length, 2);
});

test("legacy locked snapshot pointers fail with an explicit migration error", async () => {
  const { commandRuntime, creator, taskId, tasks } = await fixture();
  await tasks.transact(taskId, (current) => {
    assert.ok(current);
    return {
      ...structuredClone(current),
      videoTask: {
        ...structuredClone(current.videoTask),
        vehicleSnapshotId: "legacy_vehicle_snapshot",
      },
    };
  });
  await assert.rejects(
    commandRuntime.execute(project.id, taskId, {
      requestId: "command_legacy_snapshot",
      card: generateCard(taskId),
    }, creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-AGENT-COMMAND-SNAPSHOT_MIGRATION_REQUIRED",
  );
});
