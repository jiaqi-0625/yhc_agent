import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceAccessDeniedError,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  BatchProject,
  ProjectAssetPool,
  TaskContext,
  VehicleSnapshot,
  VideoTaskStrategyDraft,
} from "@firefly/schemas";
import {
  createVehicleTools,
  SnapshotNotFoundError,
  VehicleAccessError,
  VehicleNotFoundError,
} from "@firefly/tools";

import { LocalBatchProjectStore } from "../src/batch-project-store.ts";
import { createBusinessAgentRuntime } from "../src/business-agent-runtime.ts";
import { BusinessRuntimeError, LocalBusinessRuntime } from "../src/business-runtime.ts";
import { LocalWorkStore } from "../src/business-store.ts";
import { createApiServer } from "../src/server.ts";
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
  WorkspaceSessionRuntime,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";
import {
  createWorkspaceStrategyDraftReader,
  createWorkspaceTaskVehicleService,
  readWorkspaceTaskPolicyStatus,
  WorkspaceTaskContextResolver,
} from "../src/workspace-task-context.ts";

const tenantId = "tenant_firefly";
const projectId = "batch_project_ws307_context";
const vehicleId = "vehicle_firefly_e5_2026_long_range";
const occurredAt = "2026-08-19T18:00:00.000Z";

const project: BatchProject = {
  id: projectId,
  tenantId,
  brandId: "brand_firefly_demo",
  vehicleId,
  vehicleVersion: 1,
  name: "萤火汽车 E5 9:16 历史迁移项目",
  batchName: "历史迁移项目",
  aspectRatio: "9:16",
  visualStylePresetId: "asset_style_firefly_demo_clean",
  assetPoolId: "project_asset_pool_ws307_context",
  status: "active",
  revision: 1,
  createdAt: occurredAt,
  createdBy: "account_creator_a",
  updatedAt: occurredAt,
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
  createdAt: occurredAt,
  createdBy: "account_creator_a",
  updatedAt: occurredAt,
  updatedBy: "account_creator_a",
};

async function scope(
  administration: LocalWorkspaceAdminStore,
  accountId: string,
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

async function fixture() {
  const administration = new LocalWorkspaceAdminStore(".data/test-ws307-context-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES,
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const projects = new LocalBatchProjectStore(".data/test-ws307-context-projects", false);
  await projects.create(project, assetPool, {
    requestId: "request_ws307_context_project",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_ws307_context_project",
  });
  const tasks = new LocalVideoTaskProductionStore(".data/test-ws307-context-tasks", false);
  const runtime = new VideoTaskRuntime(
    administration,
    projects,
    tasks,
    () => DEVELOPMENT_ACCOUNTS,
    () => occurredAt,
  );
  const creator = await scope(administration, "account_creator_a");
  const created = await runtime.create(project.id, {
    requestId: "request_ws307_context_task",
    name: "迁移后的历史广告任务",
    audience: "关注家庭出行的用户",
    theme: "可靠的长续航体验",
    durationSeconds: 30,
    platformTags: ["douyin"],
  }, creator);
  const vehicle = DEFAULT_ADMIN_VEHICLES.find(
    (candidate) => candidate.id === vehicleId && candidate.version === 1,
  );
  assert.ok(vehicle);
  const snapshot: VehicleSnapshot = {
    id: "snapshot_ws307_context",
    projectId: project.id,
    vehicleId,
    vehicleVersion: 1,
    brandId: project.brandId,
    brand: "萤火汽车",
    series: "迁移快照 E5",
    modelYear: vehicle.modelYear,
    trim: "历史长续航版",
    parameters: structuredClone(vehicle.parameters),
    fixedClaims: structuredClone(vehicle.fixedClaims),
    optionalClaims: structuredClone(vehicle.optionalClaims),
    prohibitedClaims: structuredClone(vehicle.prohibitedClaims),
    referenceAssetIds: ["asset_firefly_demo_e5_hero"],
    createdAt: occurredAt,
    createdBy: "account_creator_a",
  };
  const locked = structuredClone(created.record);
  locked.videoTask.vehicleSnapshotId = snapshot.id;
  locked.videoTask.revision = 2;
  locked.taskVehicleSnapshots = [snapshot];
  await tasks.save(locked);
  const resolver = new WorkspaceTaskContextResolver(
    administration,
    projects,
    tasks,
    (targetTenantId, accountId) => DEVELOPMENT_ACCOUNTS.find(
      (account) => account.tenantId === targetTenantId && account.accountId === accountId,
    )?.displayName,
  );
  return { administration, creator, locked, resolver, tasks };
}

test("V2 Agent context reads the locked task aggregate and current ownership", async () => {
  const { creator, locked, resolver, tasks } = await fixture();
  const context = await resolver.resolve(locked.videoTask.id, creator);
  assert.equal(context.batchProject.id, project.id);
  assert.equal(context.vehicle.displayName, "迁移快照 E5 历史长续航版");
  assert.equal(context.videoTask.revision, 2);
  assert.equal(context.videoTask.vehicleSnapshotId, "snapshot_ws307_context");
  assert.deepEqual(context.videoTask.ownership, { state: "owned_by_current_account" });
  assert.deepEqual(context.productionBrief.platformTags, ["douyin"]);
  assert.equal(
    await readWorkspaceTaskPolicyStatus(tasks, context, creator.tenantId),
    "strategy_draft",
  );

  const completed = structuredClone(locked);
  completed.videoTask.status = "completed";
  completed.videoTask.currentStage = "delivery";
  completed.videoTask.stageStatus = "confirmed";
  completed.videoTask.revision = 3;
  await tasks.save(completed);
  assert.equal(
    await readWorkspaceTaskPolicyStatus(tasks, context, creator.tenantId),
    "exported",
  );
});

test("V2 Agent vehicle tools return and validate only the task's exact locked snapshot", async () => {
  const { creator, locked, resolver } = await fixture();
  const context = await resolver.resolve(locked.videoTask.id, creator);
  let current = structuredClone(locked);
  let reads = 0;
  const service = createWorkspaceTaskVehicleService(
    {
      async load(videoTaskId) {
        reads += 1;
        return videoTaskId === current.videoTask.id ? structuredClone(current) : undefined;
      },
    },
    context,
    {
      actorId: creator.actorAccountId,
      tenantId: creator.tenantId,
      projectId: project.id,
      videoTaskId: locked.videoTask.id,
    },
  );
  const toolScope = {
    actorId: creator.actorAccountId,
    tenantId: creator.tenantId,
    projectId: project.id,
    allowedBrandIds: [project.brandId],
  };
  const vehicleTools = createVehicleTools(service, toolScope);
  const getSnapshot = vehicleTools.find((tool) => tool.name === "get_vehicle_snapshot");
  const validateClaims = vehicleTools.find((tool) => tool.name === "validate_vehicle_claims");
  assert.ok(getSnapshot);
  assert.ok(validateClaims);

  const snapshotResult = await getSnapshot.execute("call_ws307_snapshot", {
    vehicleId,
    campaignDate: "2026-08-19",
  });
  assert.deepEqual(snapshotResult.details, locked.taskVehicleSnapshots[0]);
  assert.equal((snapshotResult.details as VehicleSnapshot).id, "snapshot_ws307_context");
  assert.equal((snapshotResult.details as VehicleSnapshot).createdAt, occurredAt);

  const prohibitedExpression = locked.taskVehicleSnapshots[0]?.prohibitedClaims[0];
  assert.ok(prohibitedExpression);
  const validationResult = await validateClaims.execute("call_ws307_claim", {
    snapshotId: "snapshot_ws307_context",
    statements: [`支持${prohibitedExpression}`],
  });
  assert.equal(
    (validationResult.details as { results: Array<{ status: string }> }).results[0]?.status,
    "prohibited",
  );
  assert.equal(reads, 2);

  await assert.rejects(
    async () => service.createSnapshot(
      { vehicleId: "vehicle_other", campaignDate: "2026-08-19" },
      toolScope,
    ),
    VehicleNotFoundError,
  );
  await assert.rejects(
    async () => service.validateClaims(
      { snapshotId: "snapshot_other", statements: [prohibitedExpression] },
      toolScope,
    ),
    SnapshotNotFoundError,
  );
  await assert.rejects(
    async () => service.createSnapshot(
      { vehicleId, campaignDate: "2026-08-19" },
      { ...toolScope, projectId: "batch_project_other" },
    ),
    VehicleAccessError,
  );

  current.videoTask.vehicleSnapshotId = "snapshot_replaced";
  await assert.rejects(
    async () => service.createSnapshot(
      { vehicleId, campaignDate: "2026-08-19" },
      toolScope,
    ),
    VehicleAccessError,
  );
  assert.equal(reads, 4);
});

test("V2 Agent reads only the active persisted strategy draft bound to its task snapshot", async () => {
  const { creator, locked, resolver } = await fixture();
  const context = await resolver.resolve(locked.videoTask.id, creator);
  const draft: VideoTaskStrategyDraft = {
    schemaVersion: 1,
    id: "strategy_draft_ws503_postgres",
    tenantId,
    batchProjectId: project.id,
    videoTaskId: locked.videoTask.id,
    vehicleSnapshotId: locked.videoTask.vehicleSnapshotId!,
    version: 1,
    status: "draft",
    audience: "城市家庭",
    theme: "可靠通勤",
    items: [{
      id: "strategy_item_ws503_postgres",
      claimId: "claim_family_space",
      kind: "fixed",
      title: "家庭空间",
      statement: "提供五座乘坐空间。",
      rationale: "匹配家庭出行。",
      order: 1,
      locked: false,
    }],
    validation: { valid: true, issues: [] },
    generation: { kind: "vehicle_fact_projection", templateVersion: "v1" },
    createdAt: occurredAt,
    createdBy: creator.actorAccountId,
    updatedAt: occurredAt,
    updatedBy: creator.actorAccountId,
  };
  const withDraft = structuredClone(locked);
  withDraft.strategyDrafts = [draft];
  withDraft.activeStrategyDraftId = draft.id;
  const reader = createWorkspaceStrategyDraftReader(
    { async load() { return structuredClone(withDraft); } },
    context,
    {
      actorId: creator.actorAccountId,
      tenantId: creator.tenantId,
      projectId: project.id,
      videoTaskId: locked.videoTask.id,
    },
  );

  const result = await reader.read();
  assert.equal(result.taskRevision, locked.videoTask.revision);
  assert.equal(result.vehicleSnapshotId, locked.videoTask.vehicleSnapshotId);
  assert.deepEqual(result.draft.items, draft.items);
  assert.equal("tenantId" in result.draft, false);
  assert.equal("createdBy" in result.draft, false);
  assert.equal("generation" in result.draft, false);
  assert.equal("createdAt" in result.draft, false);

  withDraft.videoTask.revision += 1;
  await assert.rejects(() => reader.read(), /no longer matches/u);
});

test("migration-mode Agent runtime refuses implicit V1 status or vehicle readers", () => {
  const business = new LocalBusinessRuntime(
    new LocalWorkStore(".data/test-ws307-no-v1-fallback-works", false),
  );
  assert.throws(
    () => createBusinessAgentRuntime(business, {
      provider: "mock",
      modelId: "mock-local",
      baseUrl: "local://mock",
      thinkingLevel: "off",
      persistSessions: false,
      dataDirectory: ".data/test-ws307-no-v1-fallback-sessions",
    }, { disableLegacyStrategyTools: true }),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-AGENT-TASK_CONTEXT_RUNTIME_NOT_CONFIGURED" &&
      error.statusCode === 503,
  );
});

test("completed migration refuses a custom Agent runtime with unverified V1 dependencies", () => {
  const business = new LocalBusinessRuntime(
    new LocalWorkStore(".data/test-ws307-unsafe-custom-runtime-works", false),
  );
  const unsafe = createBusinessAgentRuntime(business, {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: false,
    dataDirectory: ".data/test-ws307-unsafe-custom-runtime-sessions",
  });
  assert.throws(
    () => createApiServer(
      unsafe,
      business,
      undefined,
      undefined,
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-AGENT-TASK_CONTEXT_RUNTIME_NOT_CONFIGURED" &&
      error.statusCode === 503,
  );
});

test("V2 Agent context recalculates grants and reports another current owner", async () => {
  const { administration, locked, resolver } = await fixture();
  const viewer = await scope(administration, "account_creator_b");
  const context = await resolver.resolve(locked.videoTask.id, viewer);
  assert.deepEqual(context.videoTask.ownership, {
    state: "owned_by_other_account",
    ownerDisplayName: "制作账号 A",
  });

  await administration.transact(tenantId, (current) => ({
    ...current,
    accessGrants: current.accessGrants.map((grant) =>
      grant.accountId !== viewer.actorAccountId
        ? grant
        : {
            ...grant,
            status: "revoked" as const,
            revision: grant.revision + 1,
            updatedAt: "2026-08-19T18:01:00.000Z",
            updatedBy: "account_admin",
          }),
  }));
  await assert.rejects(
    resolver.resolve(locked.videoTask.id, viewer),
    WorkspaceAccessDeniedError,
  );
});

test("V2 Agent context hides missing and cross-tenant task identities", async () => {
  const { creator, locked, resolver } = await fixture();
  await assert.rejects(
    resolver.resolve("video_task_missing", creator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-AGENT-VIDEO-TASK_NOT_FOUND" &&
      error.statusCode === 404,
  );
  await assert.rejects(
    resolver.resolve(locked.videoTask.id, { ...creator, tenantId: "tenant_other" }),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-AGENT-VIDEO-TASK_NOT_FOUND",
  );
});

test("completed migration routes use V2 context strategy proposals without V1 strategy tools", async (context) => {
  const { administration, locked, resolver, tasks } = await fixture();
  const workspaceSessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-ws307-context-sessions", false),
    administration,
  );
  const authenticated = await workspaceSessions.createSession("account_creator_a");
  const business = new LocalBusinessRuntime(
    new LocalWorkStore(".data/test-ws307-context-works", false),
  );
  const agent = createBusinessAgentRuntime(business, {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: false,
    dataDirectory: ".data/test-ws307-context-agent-sessions",
  }, {
    disableLegacyStrategyTools: true,
    resolveWorkStatus: (taskContext, sessionScope) =>
      readWorkspaceTaskPolicyStatus(tasks, taskContext, sessionScope.tenantId),
    resolveVehicleService: (taskContext, sessionScope) =>
      createWorkspaceTaskVehicleService(tasks, taskContext, sessionScope),
  });
  let resolutions = 0;
  const server = createApiServer(
    agent,
    business,
    undefined,
    workspaceSessions,
    false,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    async (_request, videoTaskId) => {
      resolutions += 1;
      return resolver.resolve(videoTaskId, authenticated.scope);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authenticated.sessionId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ videoTaskId: locked.videoTask.id }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    session: { id: string; taskContext: TaskContext; toolNames: string[] };
  };
  assert.equal(resolutions, 1);
  assert.equal(body.session.taskContext.videoTask.revision, 2);
  assert.deepEqual(body.session.toolNames, [
    "get_vehicle_snapshot",
    "validate_vehicle_claims",
    "propose_strategy_generation",
    "propose_strategy_approval",
  ]);
  assert.equal(body.session.toolNames.includes("validate_strategy"), false);
  assert.doesNotMatch(
    body.session.toolNames.join(","),
    /approve_strategy|generate_strategy|request_strategy_approval/u,
  );

  const advanced = structuredClone(locked);
  advanced.videoTask.revision = 3;
  advanced.videoTask.currentStage = "script";
  await tasks.save(advanced);
  const detailResponse = await fetch(
    `http://127.0.0.1:${address.port}/v1/sessions/${body.session.id}` +
      `?videoTaskId=${locked.videoTask.id}`,
    { headers: { authorization: `Bearer ${authenticated.sessionId}` } },
  );
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()) as {
    session: { taskContext: TaskContext; messageCount: number };
  };
  assert.equal(detail.session.taskContext.videoTask.revision, 3);
  assert.equal(detail.session.taskContext.videoTask.currentStage, "script");
  assert.equal(detail.session.messageCount, 0);
  assert.equal(resolutions, 2);

  const latest = structuredClone(advanced);
  latest.videoTask.revision = 4;
  latest.videoTask.currentStage = "storyboard";
  await tasks.save(latest);
  const listResponse = await fetch(
    `http://127.0.0.1:${address.port}/v1/sessions?videoTaskId=${locked.videoTask.id}`,
    { headers: { authorization: `Bearer ${authenticated.sessionId}` } },
  );
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()) as {
    sessions: Array<{ id: string; taskContext: TaskContext }>;
  };
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0]?.id, body.session.id);
  assert.equal(listed.sessions[0]?.taskContext.videoTask.revision, 4);
  assert.equal(listed.sessions[0]?.taskContext.videoTask.currentStage, "storyboard");
  assert.equal(resolutions, 3);
});
