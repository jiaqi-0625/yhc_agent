import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import type {
  VideoTaskProductionRecord,
  WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  BatchProject,
  ConfirmVideoTaskStageRequest,
  ProjectAssetPool,
  RollbackVideoTaskStageRequest,
  VideoTaskStage,
} from "@firefly/schemas";
import { MockCompanyAssetProvider } from "@firefly/tools";

import {
  BatchProjectAssetPoolStoreAdapter,
  LocalBatchProjectStore,
} from "../src/batch-project-store.ts";
import { sendJson, sendRequestError } from "../src/http-boundary.ts";
import { ProjectAssetRuntime } from "../src/project-asset-runtime.ts";
import {
  handleVideoTaskStageRoute,
  matchVideoTaskStagePath,
} from "../src/video-task-stage-routes.ts";
import { VideoTaskStageRuntime } from "../src/video-task-stage-runtime.ts";
import { LocalVideoTaskProductionStore } from "../src/video-task-store.ts";
import {
  DEFAULT_ADMIN_BRANDS,
  DEFAULT_ADMIN_VEHICLES,
  DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
} from "../src/workspace-admin-runtime.ts";
import { LocalWorkspaceAdminStore } from "../src/workspace-admin-store.ts";
import {
  DEVELOPMENT_ACCESS_GRANTS,
  WorkspaceSessionRuntime,
  type WorkspaceAccessGrantProvider,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const projectId = "project_stage_routes";
const videoTaskId = "task_stage_routes";
const basePath =
  `/v1/workspace/batch-projects/${projectId}/video-tasks/${videoTaskId}`;
const stages = [
  "strategy",
  "script",
  "asset_matching",
  "storyboard",
  "video_preview",
  "delivery",
] as const satisfies readonly VideoTaskStage[];

type RuntimeCall =
  | {
      operation: "versions";
      projectId: string;
      videoTaskId: string;
      stage: VideoTaskStage;
      scope: WorkspaceSessionScope;
    }
  | {
      operation: "audit";
      projectId: string;
      videoTaskId: string;
      scope: WorkspaceSessionScope;
    }
  | {
      operation: "confirm";
      projectId: string;
      videoTaskId: string;
      stage: VideoTaskStage;
      input: ConfirmVideoTaskStageRequest;
      scope: WorkspaceSessionScope;
    }
  | {
      operation: "rollback";
      projectId: string;
      videoTaskId: string;
      stage: VideoTaskStage;
      input: RollbackVideoTaskStageRequest;
      scope: WorkspaceSessionScope;
    };

interface RouteFixture {
  server: Server;
  baseUrl: string;
  token: string;
  calls: RuntimeCall[];
}

async function routeFixture(): Promise<RouteFixture> {
  const grants: WorkspaceAccessGrantProvider = {
    async listForAccount() {
      return [];
    },
  };
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-video-task-stage-route-sessions", false),
    grants,
  );
  const session = await sessions.createSession("account_creator_a");
  const calls: RuntimeCall[] = [];
  const runtime = {
    async getStageVersions(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      stage: VideoTaskStage,
      scope: WorkspaceSessionScope,
    ) {
      calls.push({
        operation: "versions",
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        stage,
        scope: structuredClone(scope),
      });
      return { operation: "versions", stage };
    },
    async getStageAudit(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      scope: WorkspaceSessionScope,
    ) {
      calls.push({
        operation: "audit",
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        scope: structuredClone(scope),
      });
      return { operation: "audit" };
    },
    async confirmStage(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      stage: VideoTaskStage,
      input: ConfirmVideoTaskStageRequest,
      scope: WorkspaceSessionScope,
    ) {
      calls.push({
        operation: "confirm",
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        stage,
        input: structuredClone(input),
        scope: structuredClone(scope),
      });
      return { operation: "confirm", stage, requestId: input.requestId };
    },
    async rollbackStage(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      stage: VideoTaskStage,
      input: RollbackVideoTaskStageRequest,
      scope: WorkspaceSessionScope,
    ) {
      calls.push({
        operation: "rollback",
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        stage,
        input: structuredClone(input),
        scope: structuredClone(scope),
      });
      return { operation: "rollback", stage, requestId: input.requestId };
    },
  } as unknown as Parameters<typeof handleVideoTaskStageRoute>[3];

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (await handleVideoTaskStageRoute(request, response, url, runtime, sessions)) return;
        sendJson(response, 404, {
          code: "AIC-API-NOT_FOUND",
          message: "Endpoint not found.",
          retryable: false,
          charged: false,
        });
      } catch (error: unknown) {
        sendRequestError(response, error);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: session.sessionId,
    calls,
  };
}

const realTenantId = "tenant_firefly";
const realVehicleId = "vehicle_firefly_e5_2026_long_range";
const realProject: BatchProject = {
  id: projectId,
  tenantId: realTenantId,
  brandId: "brand_firefly_demo",
  vehicleId: realVehicleId,
  vehicleVersion: 1,
  name: "萤火 E5 阶段路由集成验收",
  batchName: "Stage Route Integration",
  aspectRatio: "9:16",
  visualStylePresetId: "asset_style_firefly_demo_clean",
  assetPoolId: "project_asset_pool_stage_routes",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T16:00:00.000Z",
  createdBy: "account_creator_a",
  updatedAt: "2026-08-19T16:00:00.000Z",
  updatedBy: "account_creator_a",
};

const realAssetPool: ProjectAssetPool = {
  id: realProject.assetPoolId,
  tenantId: realTenantId,
  batchProjectId: realProject.id,
  vehicleId: realVehicleId,
  revision: 1,
  assets: [
    {
      assetId: "asset_firefly_demo_e5_hero",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId: realVehicleId,
    },
    {
      assetId: "asset_style_firefly_demo_clean",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "visual_style",
    },
    {
      assetId: "asset_scene_city_night",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "scene",
    },
  ],
  createdAt: realProject.createdAt,
  createdBy: realProject.createdBy,
  updatedAt: realProject.updatedAt,
  updatedBy: realProject.updatedBy,
};

function assetMatchingConfirmationRecord(): VideoTaskProductionRecord {
  const vehicleSnapshotId = "vehicle_snapshot_stage_routes";
  const strategyArtifactId = "artifact_strategy_stage_routes";
  const scriptArtifactId = "artifact_script_stage_routes";
  return {
    schemaVersion: 7,
    videoTask: {
      id: videoTaskId,
      tenantId: realTenantId,
      batchProjectId: realProject.id,
      name: "资产匹配 HTTP 确认任务",
      ownerAccountId: "account_creator_a",
      status: "active",
      currentStage: "asset_matching",
      stageStatus: "awaiting_confirmation",
      revision: 5,
      vehicleSnapshotId,
      audience: "城市家庭",
      theme: "智能通勤",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-19T16:00:00.000Z",
      createdBy: "account_creator_a",
      updatedAt: "2026-08-19T16:05:00.000Z",
      updatedBy: "account_creator_a",
    },
    stageArtifactVersions: [
      {
        id: strategyArtifactId,
        tenantId: realTenantId,
        batchProjectId: realProject.id,
        videoTaskId,
        stage: "strategy",
        version: 1,
        content: {
          artifactId: "strategy_content_stage_routes",
          schemaName: "marketing_strategy",
          schemaVersion: 1,
          contentHashSha256: "a".repeat(64),
        },
        dependencies: [{ kind: "vehicle_snapshot", vehicleSnapshotId }],
        provenance: {
          kind: "human_confirmation",
          confirmationId: "confirmation_strategy_stage_routes",
        },
        createdAt: "2026-08-19T16:02:00.000Z",
        createdBy: "account_creator_a",
      },
      {
        id: scriptArtifactId,
        tenantId: realTenantId,
        batchProjectId: realProject.id,
        videoTaskId,
        stage: "script",
        version: 1,
        content: {
          artifactId: "script_content_stage_routes",
          schemaName: "video_task_script_draft",
          schemaVersion: 1,
          contentHashSha256: "b".repeat(64),
        },
        dependencies: [
          { kind: "vehicle_snapshot", vehicleSnapshotId },
          {
            kind: "stage_artifact",
            stage: "strategy",
            artifactVersionId: strategyArtifactId,
          },
        ],
        provenance: {
          kind: "human_confirmation",
          confirmationId: "confirmation_script_stage_routes",
        },
        createdAt: "2026-08-19T16:04:00.000Z",
        createdBy: "account_creator_a",
      },
    ],
    stageConfirmations: [
      {
        id: "confirmation_strategy_stage_routes",
        tenantId: realTenantId,
        batchProjectId: realProject.id,
        videoTaskId,
        stage: "strategy",
        artifactVersionId: strategyArtifactId,
        decision: "confirmed",
        source: "human_action",
        expectedTaskRevision: 3,
        actorAccountId: "account_creator_a",
        occurredAt: "2026-08-19T16:02:00.000Z",
      },
      {
        id: "confirmation_script_stage_routes",
        tenantId: realTenantId,
        batchProjectId: realProject.id,
        videoTaskId,
        stage: "script",
        artifactVersionId: scriptArtifactId,
        decision: "confirmed",
        source: "human_action",
        expectedTaskRevision: 4,
        actorAccountId: "account_creator_a",
        occurredAt: "2026-08-19T16:04:00.000Z",
      },
    ],
    activeStageArtifactVersionIds: {
      strategy: strategyArtifactId,
      script: scriptArtifactId,
    },
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskVehicleSnapshots: [{
      id: vehicleSnapshotId,
      projectId: realProject.id,
      vehicleId: realVehicleId,
      vehicleVersion: 1,
      brandId: realProject.brandId,
      brand: "萤火汽车",
      series: "E5",
      modelYear: 2026,
      trim: "长续航版",
      parameters: {},
      fixedClaims: [],
      optionalClaims: [],
      prohibitedClaims: [],
      referenceAssetIds: ["asset_firefly_demo_e5_hero"],
      createdAt: "2026-08-19T16:01:00.000Z",
      createdBy: "account_creator_a",
    }],
    taskAssetSnapshots: [],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
    stageMutationReceipts: [],
  };
}

interface RealRouteFixture {
  server: Server;
  baseUrl: string;
  token: string;
  tasks: LocalVideoTaskProductionStore;
}

async function realRouteFixture(): Promise<RealRouteFixture> {
  const administration = new LocalWorkspaceAdminStore(
    ".data/test-video-task-stage-real-route-admin",
    {
      brands: DEFAULT_ADMIN_BRANDS,
      vehicleVersions: DEFAULT_ADMIN_VEHICLES,
      vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
      accessGrants: DEVELOPMENT_ACCESS_GRANTS,
    },
    false,
  );
  const projects = new LocalBatchProjectStore(
    ".data/test-video-task-stage-real-route-projects",
    false,
  );
  await projects.create(realProject, realAssetPool, {
    requestId: "request_stage_route_real_project",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_stage_route_real_project",
  });
  const tasks = new LocalVideoTaskProductionStore(
    ".data/test-video-task-stage-real-route-tasks",
    false,
  );
  await tasks.save(assetMatchingConfirmationRecord());
  const now = () => "2026-08-19T16:30:00.000Z";
  let sequence = 0;
  const projectAssets = new ProjectAssetRuntime(
    new MockCompanyAssetProvider(),
    new BatchProjectAssetPoolStoreAdapter(projects),
    now,
  );
  const runtime = new VideoTaskStageRuntime(
    administration,
    projects,
    tasks,
    now,
    (kind) => `${kind}_stage_route_${++sequence}`,
    projectAssets,
  );
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(
      ".data/test-video-task-stage-real-route-sessions",
      false,
    ),
    administration,
  );
  const session = await sessions.createSession("account_creator_a");
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (await handleVideoTaskStageRoute(request, response, url, runtime, sessions)) return;
        sendJson(response, 404, {
          code: "AIC-API-NOT_FOUND",
          message: "Endpoint not found.",
          retryable: false,
          charged: false,
        });
      } catch (error: unknown) {
        sendRequestError(response, error);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: session.sessionId,
    tasks,
  };
}

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function jsonAuthorization(token: string): {
  authorization: string;
  "content-type": string;
} {
  return { ...authorization(token), "content-type": "application/json" };
}

test("stage route matcher keeps the four production paths and the explicit development simulation path", () => {
  for (const stage of stages) {
    assert.deepEqual(
      matchVideoTaskStagePath(`${basePath}/stages/${stage}/versions`),
      { kind: "versions", projectId, videoTaskId, stage },
    );
    assert.deepEqual(
      matchVideoTaskStagePath(`${basePath}/stages/${stage}/confirmations`),
      { kind: "confirmations", projectId, videoTaskId, stage },
    );
    assert.deepEqual(
      matchVideoTaskStagePath(`${basePath}/stages/${stage}/rollbacks`),
      { kind: "rollbacks", projectId, videoTaskId, stage },
    );
    assert.deepEqual(
      matchVideoTaskStagePath(`${basePath}/stages/${stage}/development-simulation`),
      { kind: "development_simulation", projectId, videoTaskId, stage },
    );
  }
  assert.deepEqual(matchVideoTaskStagePath(`${basePath}/stage-invalidations`), {
    kind: "audit",
    projectId,
    videoTaskId,
  });

  for (const pathname of [
    `${basePath}/stages/prompt/versions`,
    `${basePath}/stages/Strategy/versions`,
    `${basePath}/stages/strategy/version`,
    `${basePath}/stage-invalidations/extra`,
    `${basePath}/stages/strategy/confirmations/`,
  ]) {
    assert.equal(matchVideoTaskStagePath(pathname), undefined);
  }
});

test("stage queries require Bearer auth, reject query parameters, and forward exact scopes", async (context) => {
  const fixture = await routeFixture();
  context.after(() => fixture.server.close());
  const strategyVersions = `${fixture.baseUrl}${basePath}/stages/strategy/versions`;

  assert.equal((await fetch(strategyVersions)).status, 401);
  assert.equal(fixture.calls.length, 0);

  const queried = await fetch(`${strategyVersions}?tenantId=tenant_attacker`, {
    headers: authorization(fixture.token),
  });
  assert.equal(queried.status, 400);
  assert.equal(((await queried.json()) as { code: string }).code, "AIC-API-QUERY_INVALID");
  assert.equal(fixture.calls.length, 0);

  for (const stage of stages) {
    const response = await fetch(`${fixture.baseUrl}${basePath}/stages/${stage}/versions`, {
      headers: authorization(fixture.token),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { operation: "versions", stage });
  }
  const audit = await fetch(`${fixture.baseUrl}${basePath}/stage-invalidations`, {
    headers: authorization(fixture.token),
  });
  assert.equal(audit.status, 200);
  assert.deepEqual(await audit.json(), { operation: "audit" });

  assert.equal(fixture.calls.length, stages.length + 1);
  for (const [index, stage] of stages.entries()) {
    const call = fixture.calls[index];
    assert.ok(call && call.operation === "versions");
    assert.equal(call.projectId, projectId);
    assert.equal(call.videoTaskId, videoTaskId);
    assert.equal(call.stage, stage);
    assert.equal(call.scope.actorAccountId, "account_creator_a");
  }
  const auditCall = fixture.calls.at(-1);
  assert.ok(auditCall && auditCall.operation === "audit");
  assert.equal(auditCall.projectId, projectId);
  assert.equal(auditCall.videoTaskId, videoTaskId);
  assert.equal(auditCall.scope.actorAccountId, "account_creator_a");

  const invalidStage = await fetch(
    `${fixture.baseUrl}${basePath}/stages/prompt/versions`,
    { headers: authorization(fixture.token) },
  );
  assert.equal(invalidStage.status, 404);
  assert.equal(fixture.calls.length, stages.length + 1);
});

test("stage writes validate strict bodies and forward only path scope plus session identity", async (context) => {
  const fixture = await routeFixture();
  context.after(() => fixture.server.close());
  const confirmationUrl =
    `${fixture.baseUrl}${basePath}/stages/strategy/confirmations`;
  const assetConfirmationUrl =
    `${fixture.baseUrl}${basePath}/stages/asset_matching/confirmations`;
  const rollbackUrl = `${fixture.baseUrl}${basePath}/stages/strategy/rollbacks`;
  const confirmInput = {
    requestId: "request_confirm_strategy",
    expectedTaskRevision: 7,
    comment: "人工验收通过。",
  } satisfies ConfirmVideoTaskStageRequest;
  const rollbackInput = {
    requestId: "request_rollback_strategy",
    expectedTaskRevision: 8,
    targetArtifactVersionId: "artifact_strategy_v1",
    reason: "恢复已审核的策略版本。",
  } satisfies RollbackVideoTaskStageRequest;
  const assetConfirmInput = {
    requestId: "request_confirm_asset_matching",
    expectedTaskRevision: 9,
    assetSelection: {
      expectedProjectAssetPoolRevision: 3,
      selectedAssets: [{
        assetId: "asset_scene_city",
        version: 1,
        source: "company_catalog",
        sourceProvider: "mock_company_assets",
        category: "scene",
      }],
    },
  } satisfies ConfirmVideoTaskStageRequest;

  assert.equal((await fetch(confirmationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmInput),
  })).status, 401);
  assert.equal(fixture.calls.length, 0);

  const confirmed = await fetch(confirmationUrl, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify(confirmInput),
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), {
    operation: "confirm",
    stage: "strategy",
    requestId: confirmInput.requestId,
  });

  const assetConfirmed = await fetch(assetConfirmationUrl, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify(assetConfirmInput),
  });
  assert.equal(assetConfirmed.status, 200);
  assert.deepEqual(await assetConfirmed.json(), {
    operation: "confirm",
    stage: "asset_matching",
    requestId: assetConfirmInput.requestId,
  });

  const rolledBack = await fetch(rollbackUrl, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify(rollbackInput),
  });
  assert.equal(rolledBack.status, 200);
  assert.deepEqual(await rolledBack.json(), {
    operation: "rollback",
    stage: "strategy",
    requestId: rollbackInput.requestId,
  });

  assert.equal(fixture.calls.length, 3);
  const confirmCall = fixture.calls[0];
  assert.ok(confirmCall && confirmCall.operation === "confirm");
  assert.equal(confirmCall.projectId, projectId);
  assert.equal(confirmCall.videoTaskId, videoTaskId);
  assert.equal(confirmCall.stage, "strategy");
  assert.deepEqual(confirmCall.input, confirmInput);
  assert.equal(confirmCall.scope.actorAccountId, "account_creator_a");
  const assetConfirmCall = fixture.calls[1];
  assert.ok(assetConfirmCall && assetConfirmCall.operation === "confirm");
  assert.equal(assetConfirmCall.stage, "asset_matching");
  assert.deepEqual(assetConfirmCall.input, assetConfirmInput);
  const rollbackCall = fixture.calls[2];
  assert.ok(rollbackCall && rollbackCall.operation === "rollback");
  assert.equal(rollbackCall.projectId, projectId);
  assert.equal(rollbackCall.videoTaskId, videoTaskId);
  assert.equal(rollbackCall.stage, "strategy");
  assert.deepEqual(rollbackCall.input, rollbackInput);
  assert.equal(rollbackCall.scope.actorAccountId, "account_creator_a");

  const forgedConfirmationFields = [
    { actorAccountId: "account_attacker" },
    { tenantId: "tenant_attacker" },
    { stage: "strategy" },
    { dependencies: [{ kind: "vehicle_snapshot", vehicleSnapshotId: "snapshot_forged" }] },
    { invalidationIds: ["invalidation_forged"] },
  ];
  for (const forged of forgedConfirmationFields) {
    const response = await fetch(confirmationUrl, {
      method: "POST",
      headers: jsonAuthorization(fixture.token),
      body: JSON.stringify({ ...confirmInput, ...forged }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, "AIC-API-SCHEMA_INVALID");
  }

  const forgedRollbackFields = [
    { actorAccountId: "account_attacker" },
    { tenantId: "tenant_attacker" },
    { stage: "strategy" },
    { dependencies: [{ kind: "stage_artifact", artifactVersionId: "artifact_forged" }] },
    { invalidationIds: ["invalidation_forged"] },
  ];
  for (const forged of forgedRollbackFields) {
    const response = await fetch(rollbackUrl, {
      method: "POST",
      headers: jsonAuthorization(fixture.token),
      body: JSON.stringify({ ...rollbackInput, ...forged }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, "AIC-API-SCHEMA_INVALID");
  }
  assert.equal(fixture.calls.length, 3);

  assert.equal((await fetch(`${rollbackUrl}?stage=delivery`, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify(rollbackInput),
  })).status, 400);
  assert.equal(fixture.calls.length, 3);
});

test("real asset confirmation route maps stale pool and invalid exact selections without task writes", async (context) => {
  const fixture = await realRouteFixture();
  context.after(() => fixture.server.close());
  const confirmationUrl =
    `${fixture.baseUrl}${basePath}/stages/asset_matching/confirmations`;
  const before = await fixture.tasks.load(videoTaskId);
  assert.ok(before);

  const stalePool = await fetch(confirmationUrl, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify({
      requestId: "request_stage_route_stale_pool",
      expectedTaskRevision: 5,
      assetSelection: {
        expectedProjectAssetPoolRevision: 99,
        selectedAssets: [{
          assetId: "asset_scene_city_night",
          version: 1,
          source: "company_catalog",
          sourceProvider: "mock_company_assets",
          category: "scene",
        }],
      },
    } satisfies ConfirmVideoTaskStageRequest),
  });
  assert.equal(stalePool.status, 409);
  assert.equal(
    ((await stalePool.json()) as { code: string }).code,
    "AIC-ASSET-SELECTION-REVISION-CONFLICT",
  );
  assert.deepEqual(await fixture.tasks.load(videoTaskId), before);

  const invalidExactSelection = await fetch(confirmationUrl, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify({
      requestId: "request_stage_route_invalid_exact_selection",
      expectedTaskRevision: 5,
      assetSelection: {
        expectedProjectAssetPoolRevision: 1,
        selectedAssets: [{
          assetId: "asset_scene_city_night",
          version: 999,
          source: "company_catalog",
          sourceProvider: "mock_company_assets",
          category: "scene",
        }],
      },
    } satisfies ConfirmVideoTaskStageRequest),
  });
  assert.equal(invalidExactSelection.status, 400);
  assert.equal(
    ((await invalidExactSelection.json()) as { code: string }).code,
    "AIC-ASSET-SELECTION-INVALID",
  );
  assert.deepEqual(await fixture.tasks.load(videoTaskId), before);
});
