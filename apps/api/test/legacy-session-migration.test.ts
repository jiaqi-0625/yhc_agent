import assert from "node:assert/strict";
import test from "node:test";

import type {
  LoadedLocalSession,
  PersistedLocalSession,
  PersistedLocalSessionV1,
  PersistedLocalSessionV2,
} from "@firefly/agent";
import type { VideoTaskProductionRecord } from "@firefly/domain";
import type { BatchProject, TaskContext, VehicleSnapshot } from "@firefly/schemas";

import {
  migrateLegacyAgentSessions,
  type LegacyV3ScopeMapping,
} from "../src/legacy-session-migration.ts";

const timestamp = "2026-08-18T08:00:00.000Z";
const taskId = "work_session_migration_001";
const legacyProjectId = "project_local";
const targetProjectId = "batch_project_migrated";
const ownerAccountId = "account_creator_a";

const project: BatchProject = {
  id: targetProjectId,
  tenantId: "tenant_firefly",
  brandId: "brand_firefly_demo",
  vehicleId: "vehicle_firefly_e5_2026_long_range",
  vehicleVersion: 1,
  name: "萤火汽车 萤火 E5 9:16 历史作品迁移",
  batchName: "历史作品迁移",
  aspectRatio: "9:16",
  visualStylePresetId: "asset_style_firefly_demo_clean",
  assetPoolId: "asset_pool_migrated",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T12:00:00.000Z",
  createdBy: "account_migration",
  updatedAt: "2026-08-19T12:00:00.000Z",
  updatedBy: "account_migration",
};

function snapshot(): VehicleSnapshot {
  return {
    id: "snapshot_session_migration",
    projectId: targetProjectId,
    vehicleId: project.vehicleId,
    vehicleVersion: project.vehicleVersion,
    brandId: project.brandId,
    brand: "萤火示例汽车",
    series: "萤火 E5",
    modelYear: 2026,
    trim: "长续航示例版",
    color: "萤火绿",
    parameters: { seats: 5, energyType: "纯电" },
    fixedClaims: [],
    optionalClaims: [],
    prohibitedClaims: ["自动驾驶"],
    referenceAssetIds: ["asset_vehicle_front_001"],
    createdAt: timestamp,
    createdBy: "creator_local",
  };
}

function taskRecord(overrides: Partial<VideoTaskProductionRecord["videoTask"]> = {}): VideoTaskProductionRecord {
  return {
    schemaVersion: 7,
    videoTask: {
      id: taskId,
      tenantId: project.tenantId,
      batchProjectId: project.id,
      name: "历史广告作品 001",
      ownerAccountId,
      status: "active",
      currentStage: "asset_matching",
      stageStatus: "in_progress",
      revision: 7,
      vehicleSnapshotId: snapshot().id,
      audience: "家庭用户",
      theme: "周末出行",
      durationSeconds: 30,
      platformTags: ["douyin", "legacy"],
      createdAt: timestamp,
      createdBy: ownerAccountId,
      updatedAt: "2026-08-18T10:00:00.000Z",
      updatedBy: "account_migration",
      ...overrides,
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskVehicleSnapshots: [snapshot()],
    taskAssetSnapshots: [],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
    stageMutationReceipts: [],
  };
}

function taskContext(projectId = legacyProjectId): TaskContext {
  return {
    schemaVersion: 1,
    kind: "task_context",
    brand: { id: project.brandId, name: "迁移前品牌名" },
    vehicle: { id: project.vehicleId, displayName: "迁移前车型名", version: 1 },
    batchProject: { id: projectId, name: "迁移前兼容项目", aspectRatio: "9:16" },
    videoTask: {
      id: taskId,
      name: "迁移前作品",
      status: "active",
      currentStage: "strategy",
      stageStatus: "in_progress",
      revision: 2,
      vehicleSnapshotId: snapshot().id,
      ownership: { state: "owned_by_current_account" },
    },
    productionBrief: {
      audience: "旧受众",
      theme: "旧主题",
      durationSeconds: 15,
      platformTags: [],
    },
  };
}

const history = [{
  role: "assistant",
  content: [{ type: "text", text: "必须保留的历史消息" }],
}] as unknown as PersistedLocalSessionV1["messages"];

function v1(id: string, workId: string | null = taskId): PersistedLocalSessionV1 {
  return {
    schemaVersion: 1,
    id,
    ...(workId === null ? {} : { workId }),
    createdAt: timestamp,
    updatedAt: "2026-08-18T09:00:00.000Z",
    provider: "legacy-provider",
    modelId: "legacy-model",
    messages: structuredClone(history),
  };
}

function v2(id: string, context: TaskContext | null = taskContext()): PersistedLocalSessionV2 {
  return {
    schemaVersion: 2,
    id,
    ...(context === null ? {} : { taskContext: context }),
    createdAt: timestamp,
    updatedAt: "2026-08-18T09:00:00.000Z",
    provider: "legacy-provider",
    modelId: "legacy-model",
    messages: structuredClone(history),
  };
}

function v3(id: string, context: TaskContext | null = taskContext()): PersistedLocalSession {
  return {
    schemaVersion: 3,
    id,
    ...(context === null
      ? {}
      : {
          taskContext: context,
          scope: {
            actorId: "account_admin",
            tenantId: "tenant_firefly",
            projectId: context.batchProject.id,
            videoTaskId: context.videoTask.id,
          },
        }),
    createdAt: timestamp,
    updatedAt: "2026-08-18T09:00:00.000Z",
    provider: "legacy-provider",
    modelId: "legacy-model",
    messages: structuredClone(history),
  };
}

const adminScopeMapping: LegacyV3ScopeMapping = {
  sourceActorId: "account_admin",
  sourceTenantId: project.tenantId,
  targetAccountId: ownerAccountId,
};

function migrate(
  sessions: readonly LoadedLocalSession[],
  records = [taskRecord()],
  legacyV3ScopeMappings: readonly LegacyV3ScopeMapping[] = [adminScopeMapping],
) {
  return migrateLegacyAgentSessions({
    sessions,
    project,
    taskRecords: records,
    brandName: "  萤火汽车  ",
    legacySessionOwnerAccountId: ownerAccountId,
    taskOwnerDisplayName: "制作账号 A",
    legacyV3ScopeMappings,
  });
}

test("legacy v1, v2, and old-project v3 sessions become task-scoped v3 without transcript loss", () => {
  const sources = [v1("session_v1_bound"), v2("session_v2_bound"), v3("session_v3_old_project")];
  const result = migrate(sources);

  assert.deepEqual(result.summary, {
    sessionCount: 3,
    convertedSessionCount: 3,
    unchangedSessionCount: 0,
    boundSessionCount: 3,
    unboundSessionCount: 0,
  });
  for (const [index, session] of result.sessions.entries()) {
    assert.equal(session.schemaVersion, 3);
    assert.equal(session.id, sources[index]?.id);
    assert.equal(session.createdAt, sources[index]?.createdAt);
    assert.equal(session.updatedAt, sources[index]?.updatedAt);
    assert.equal(session.provider, "legacy-provider");
    assert.equal(session.modelId, "legacy-model");
    assert.deepEqual(session.messages, history);
    assert.equal("workId" in session, false);
    assert.deepEqual(session.scope, {
      actorId: ownerAccountId,
      tenantId: project.tenantId,
      projectId: project.id,
      videoTaskId: taskId,
    });
    assert.deepEqual(session.taskContext, {
      schemaVersion: 1,
      kind: "task_context",
      brand: { id: project.brandId, name: "萤火汽车" },
      vehicle: {
        id: project.vehicleId,
        displayName: "萤火 E5 长续航示例版",
        version: project.vehicleVersion,
      },
      batchProject: {
        id: project.id,
        name: project.name,
        aspectRatio: project.aspectRatio,
      },
      videoTask: {
        id: taskId,
        name: "历史广告作品 001",
        status: "active",
        currentStage: "asset_matching",
        stageStatus: "in_progress",
        revision: 7,
        vehicleSnapshotId: snapshot().id,
        ownership: { state: "owned_by_current_account" },
      },
      productionBrief: {
        audience: "家庭用户",
        theme: "周末出行",
        durationSeconds: 30,
        platformTags: ["douyin", "legacy"],
      },
    });
  }
});

test("unbound sessions stay unbound and an already migrated v3 session is a no-op", () => {
  const unboundV1 = v1("session_v1_unbound", null);
  const unboundV2 = v2("session_v2_unbound", null);
  const unboundV3 = v3("session_v3_unbound", null);
  const unbound = migrate([unboundV1, unboundV2, unboundV3]);
  assert.deepEqual(unbound.summary, {
    sessionCount: 3,
    convertedSessionCount: 2,
    unchangedSessionCount: 1,
    boundSessionCount: 0,
    unboundSessionCount: 3,
  });
  assert.ok(unbound.sessions.every((session) => session.taskContext === undefined && session.scope === undefined));
  assert.deepEqual(unbound.sessions[2], unboundV3);

  const first = migrate([v1("session_idempotent")]);
  const replay = migrate(first.sessions);
  assert.deepEqual(replay.sessions, first.sessions);
  assert.deepEqual(replay.summary, {
    sessionCount: 1,
    convertedSessionCount: 0,
    unchangedSessionCount: 1,
    boundSessionCount: 1,
    unboundSessionCount: 0,
  });
});

test("session migration rewrites stale target-shaped v3 bindings and fails closed for invalid references", () => {
  assert.throws(
    () => migrate([v1("session_orphan", "work_missing")]),
    /orphan video task 'work_missing'/u,
  );

  const inconsistent = v3("session_inconsistent") as PersistedLocalSession & {
    scope: NonNullable<PersistedLocalSession["scope"]>;
  };
  inconsistent.scope.videoTaskId = "work_other";
  assert.throws(
    () => migrate([inconsistent]),
    /inconsistent V3 scope and task context/u,
  );

  const partial = v3("session_partial", taskContext(project.id)) as PersistedLocalSession & {
    scope: NonNullable<PersistedLocalSession["scope"]>;
  };
  partial.scope.tenantId = "tenant_legacy";
  const corrected = migrate([partial], [taskRecord()], [{
    sourceActorId: "account_admin",
    sourceTenantId: "tenant_legacy",
    targetAccountId: ownerAccountId,
  }]);
  assert.equal(corrected.summary.convertedSessionCount, 1);
  assert.equal(corrected.sessions[0]?.scope?.tenantId, project.tenantId);
  assert.equal(corrected.sessions[0]?.scope?.actorId, ownerAccountId);

  const reusedProject = { ...project, id: legacyProjectId };
  const reusedTask = taskRecord({ batchProjectId: legacyProjectId });
  reusedTask.taskVehicleSnapshots[0] = {
    ...reusedTask.taskVehicleSnapshots[0]!,
    projectId: legacyProjectId,
  };
  const reused = migrateLegacyAgentSessions({
    sessions: [v3("session_reused_project_id")],
    project: reusedProject,
    taskRecords: [reusedTask],
    brandName: "萤火汽车",
    legacySessionOwnerAccountId: ownerAccountId,
    taskOwnerDisplayName: "制作账号 A",
    legacyV3ScopeMappings: [adminScopeMapping],
  });
  assert.equal(reused.summary.convertedSessionCount, 1);
  assert.equal(reused.sessions[0]?.scope?.actorId, ownerAccountId);
  assert.equal(reused.sessions[0]?.taskContext?.batchProject.name, reusedProject.name);
  assert.equal(reused.sessions[0]?.taskContext?.videoTask.revision, 7);

  const crossAccount = v3("session_cross_account");
  crossAccount.scope!.actorId = "account_attacker";
  assert.throws(
    () => migrate([crossAccount]),
    /does not have an explicit V3 scope migration mapping/u,
  );
  const crossTenant = v3("session_cross_tenant");
  crossTenant.scope!.tenantId = "tenant_other";
  assert.throws(
    () => migrate([crossTenant]),
    /does not have an explicit V3 scope migration mapping/u,
  );
  const retainedAdmin = migrate([v3("session_retained_admin")], [taskRecord()], [{
    ...adminScopeMapping,
    targetAccountId: "account_admin",
  }]);
  assert.equal(retainedAdmin.sessions[0]?.scope?.actorId, "account_admin");
  assert.deepEqual(retainedAdmin.sessions[0]?.taskContext?.videoTask.ownership, {
    state: "owned_by_other_account",
    ownerDisplayName: "制作账号 A",
  });

  assert.throws(
    () => migrate([v1("session_wrong_owner")], [taskRecord({ ownerAccountId: "account_creator_b" })]),
    /does not own migrated video task/u,
  );
  assert.throws(
    () => migrate([v1("session_duplicate"), v1("session_duplicate")]),
    /duplicate session/u,
  );
  assert.throws(
    () => migrate([v1("session_duplicate_task")], [taskRecord(), taskRecord()]),
    /duplicate video task/u,
  );
});
