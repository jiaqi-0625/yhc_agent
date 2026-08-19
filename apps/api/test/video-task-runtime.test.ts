import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceAccessDeniedError, type WorkspaceSessionScope } from "@firefly/domain";
import type {
  BatchProject,
  CreateVideoTaskRequest,
  ProjectAssetPool,
} from "@firefly/schemas";

import { LocalBatchProjectStore } from "../src/batch-project-store.ts";
import { BusinessRuntimeError } from "../src/business-runtime.ts";
import { VideoTaskRuntime } from "../src/video-task-runtime.ts";
import { LocalVideoTaskProductionStore } from "../src/video-task-store.ts";
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
const projectId = "batch_project_ws304";
const vehicleId = "vehicle_firefly_e5_2026_long_range";

const project: BatchProject = {
  id: projectId,
  tenantId,
  brandId: "brand_firefly_demo",
  vehicleId,
  name: "萤火汽车 萤火 E5 长续航版 9:16 WS304",
  batchName: "WS304",
  aspectRatio: "9:16",
  visualStylePresetId: "asset_style_firefly_demo_clean",
  assetPoolId: "project_asset_pool_ws304",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T12:00:00.000Z",
  createdBy: "account_creator_a",
  updatedAt: "2026-08-19T12:00:00.000Z",
  updatedBy: "account_creator_a",
};

const assetPool: ProjectAssetPool = {
  id: project.assetPoolId,
  tenantId,
  batchProjectId: project.id,
  vehicleId,
  revision: 1,
  assets: [
    {
      assetId: "asset_firefly_demo_e5_hero",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId,
    },
  ],
  createdAt: project.createdAt,
  createdBy: project.createdBy,
  updatedAt: project.updatedAt,
  updatedBy: project.updatedBy,
};

async function fixture() {
  const administration = new LocalWorkspaceAdminStore(".data/test-ws304-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES,
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const projects = new LocalBatchProjectStore(".data/test-ws304-projects", false);
  await projects.create(project, assetPool, {
    requestId: "request_ws304_project",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_ws304_project",
  });
  const tasks = new LocalVideoTaskProductionStore(".data/test-ws304-tasks", false);
  let sequence = 0;
  const runtime = new VideoTaskRuntime(
    administration,
    projects,
    tasks,
    () => DEVELOPMENT_ACCOUNTS,
    () => `2026-08-19T12:00:0${sequence}.000Z`,
    (kind) => `${kind}_${++sequence}`,
  );
  return { administration, projects, runtime, tasks };
}

async function session(
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

function request(overrides: Partial<CreateVideoTaskRequest> = {}): CreateVideoTaskRequest {
  return {
    requestId: "request_ws304_task",
    name: "春季城市通勤视频",
    audience: "关注智能出行的城市家庭",
    theme: "轻松高效的日常通勤",
    durationSeconds: 30,
    platformTags: ["douyin", "xiaohongshu"],
    scriptInput: "突出空间与智能座舱体验。",
    ...overrides,
  };
}

test("video task creation is server-scoped, idempotent, and supports multiple tasks per project", async () => {
  const { administration, runtime } = await fixture();
  const creator = await session(administration);
  const first = await runtime.create(projectId, request(), creator);
  assert.equal(first.replayed, false);
  assert.equal(first.record.videoTask.ownerAccountId, creator.actorAccountId);
  assert.equal(first.record.videoTask.currentStage, "strategy");
  assert.equal(first.record.videoTask.stageStatus, "in_progress");
  assert.equal(first.record.videoTask.revision, 1);
  assert.equal(first.record.videoTask.createdBy, creator.actorAccountId);

  const replay = await runtime.create(projectId, request(), creator);
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.videoTask.id, first.record.videoTask.id);
  await assert.rejects(
    runtime.create(projectId, request({ name: "冲突任务名" }), creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-VIDEO-TASK-IDEMPOTENCY_CONFLICT",
  );

  const second = await runtime.create(
    projectId,
    request({
      requestId: "request_ws304_task_2",
      name: "周末郊游视频",
      ownerAccountId: "account_creator_b",
    }),
    creator,
  );
  assert.equal(second.record.videoTask.ownerAccountId, "account_creator_b");
  const listed = await runtime.list(projectId, creator);
  assert.deepEqual(
    new Set(listed.map((record) => record.videoTask.id)),
    new Set([first.record.videoTask.id, second.record.videoTask.id]),
  );
});

test("only the current owner assigns an eligible project member", async () => {
  const { administration, runtime } = await fixture();
  const creatorA = await session(administration);
  const creatorB = await session(administration, "account_creator_b");
  const created = await runtime.create(projectId, request(), creatorA);

  const assigned = await runtime.assign(
    projectId,
    created.record.videoTask.id,
    {
      expectedTaskRevision: 1,
      targetOwnerAccountId: "account_creator_b",
      reason: "由 B 负责该平台版本",
    },
    creatorA,
  );
  assert.equal(assigned.videoTask.ownerAccountId, "account_creator_b");
  assert.equal(assigned.videoTask.revision, 2);
  assert.equal(assigned.ownershipTransfers[0]?.actorAccountId, "account_creator_a");

  await assert.rejects(
    runtime.assign(
      projectId,
      created.record.videoTask.id,
      {
        expectedTaskRevision: 2,
        targetOwnerAccountId: "account_creator_a",
        reason: "原负责人尝试绕过独占规则",
      },
      creatorA,
    ),
    WorkspaceAccessDeniedError,
  );
  await assert.rejects(
    runtime.assign(
      projectId,
      created.record.videoTask.id,
      {
        expectedTaskRevision: 2,
        targetOwnerAccountId: "account_admin",
        reason: "管理员不是制作负责人",
      },
      creatorB,
    ),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-VIDEO-TASK-OWNER_INELIGIBLE",
  );
});

test("an authorized non-owner takes over with optimistic locking and an immutable audit", async () => {
  const { administration, runtime } = await fixture();
  const creatorA = await session(administration);
  const creatorB = await session(administration, "account_creator_b");
  const created = await runtime.create(projectId, request(), creatorA);
  const taken = await runtime.takeOver(
    projectId,
    created.record.videoTask.id,
    { expectedTaskRevision: 1, reason: "A 暂停排期，由 B 接管" },
    creatorB,
  );
  assert.equal(taken.videoTask.ownerAccountId, "account_creator_b");
  assert.equal(taken.videoTask.revision, 2);
  assert.equal(taken.ownershipTransfers[0]?.actorAccountId, "account_creator_b");

  await assert.rejects(
    runtime.takeOver(
      projectId,
      created.record.videoTask.id,
      { expectedTaskRevision: 1, reason: "重复旧请求" },
      creatorA,
    ),
  );
});

test("revocation is reloaded from administration for lists, creation replays, and ownership commands", async () => {
  const { administration, runtime } = await fixture();
  const staleCreator = await session(administration);
  await runtime.create(projectId, request(), staleCreator);
  await administration.transact(tenantId, (state) => ({
    ...state,
    accessGrants: state.accessGrants.map((grant) =>
      grant.accountId === staleCreator.actorAccountId
        ? {
            ...grant,
            status: "revoked" as const,
            revision: grant.revision + 1,
            updatedAt: "2026-08-19T12:10:00.000Z",
            updatedBy: "account_admin",
          }
        : grant),
  }));

  await assert.rejects(runtime.list(projectId, staleCreator), WorkspaceAccessDeniedError);
  await assert.rejects(runtime.create(projectId, request(), staleCreator), WorkspaceAccessDeniedError);
});
