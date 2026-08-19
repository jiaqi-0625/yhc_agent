import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";
import type { BatchProject, ProjectAssetPool } from "@firefly/schemas";

import { LocalBatchProjectStore } from "../src/batch-project-store.ts";
import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { startApiServer } from "../src/server.ts";
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

const agentConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-video-task-http-agent",
};

const project: BatchProject = {
  id: "batch_project_http_ws304",
  tenantId: "tenant_firefly",
  brandId: "brand_firefly_demo",
  vehicleId: "vehicle_firefly_e5_2026_long_range",
  name: "萤火汽车 萤火 E5 长续航版 16:9 HTTP WS304",
  batchName: "HTTP WS304",
  aspectRatio: "16:9",
  visualStylePresetId: "asset_style_firefly_demo_clean",
  assetPoolId: "project_asset_pool_http_ws304",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T13:00:00.000Z",
  createdBy: "account_creator_a",
  updatedAt: "2026-08-19T13:00:00.000Z",
  updatedBy: "account_creator_a",
};

const pool: ProjectAssetPool = {
  id: project.assetPoolId,
  tenantId: project.tenantId,
  batchProjectId: project.id,
  vehicleId: project.vehicleId,
  revision: 1,
  assets: [{
    assetId: "asset_firefly_demo_e5_hero",
    version: 1,
    source: "company_catalog",
    sourceProvider: "mock_company_assets",
    category: "vehicle",
    vehicleId: project.vehicleId,
  }],
  createdAt: project.createdAt,
  createdBy: project.createdBy,
  updatedAt: project.updatedAt,
  updatedBy: project.updatedBy,
};

async function fixture() {
  const administration = new LocalWorkspaceAdminStore(".data/test-video-task-http-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES,
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-video-task-http-sessions", false),
    administration,
  );
  const projects = new LocalBatchProjectStore(".data/test-video-task-http-projects", false);
  await projects.create(project, pool, {
    requestId: "request_http_ws304_project",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_http_ws304_project",
  });
  const tasks = new LocalVideoTaskProductionStore(".data/test-video-task-http-tasks", false);
  let sequence = 0;
  const videoTasks = new VideoTaskRuntime(
    administration,
    projects,
    tasks,
    () => DEVELOPMENT_ACCOUNTS,
    () => "2026-08-19T13:00:00.000Z",
    (kind) => `${kind}_${++sequence}`,
  );
  const server = await startApiServer(
    0,
    "127.0.0.1",
    new LocalAgentRuntime(agentConfig),
    new LocalBusinessRuntime(),
    undefined,
    sessions,
    true,
    false,
    undefined,
    undefined,
    videoTasks,
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function token(baseUrl: string, accountId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { session: { token: string } }).session.token;
}

function headers(sessionToken: string) {
  return { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" };
}

test("video task HTTP APIs create, assign, take over, list, and reject forged scope", async (context) => {
  const { server, baseUrl } = await fixture();
  context.after(() => server.close());
  const collectionUrl = `${baseUrl}/v1/workspace/batch-projects/${project.id}/video-tasks`;
  assert.equal((await fetch(collectionUrl)).status, 401);
  const createRequest = {
    requestId: "request_http_ws304_task",
    name: "HTTP 城市通勤视频",
    audience: "城市家庭",
    theme: "智能通勤",
    durationSeconds: 30,
    platformTags: ["douyin"],
    ownerAccountId: "account_creator_b",
  };

  const adminToken = await token(baseUrl, "account_admin");
  assert.equal((await fetch(collectionUrl, { headers: headers(adminToken) })).status, 200);
  assert.equal((await fetch(collectionUrl, {
    method: "POST",
    headers: headers(adminToken),
    body: JSON.stringify(createRequest),
  })).status, 403);

  const creatorAToken = await token(baseUrl, "account_creator_a");
  const creatorBToken = await token(baseUrl, "account_creator_b");
  const forged = await fetch(collectionUrl, {
    method: "POST",
    headers: headers(creatorAToken),
    body: JSON.stringify({
      ...createRequest,
      tenantId: "tenant_attacker",
      createdBy: "account_attacker",
      revision: 99,
    }),
  });
  assert.equal(forged.status, 400);
  assert.equal(((await forged.json()) as { code: string }).code, "AIC-API-SCHEMA_INVALID");

  const created = await fetch(collectionUrl, {
    method: "POST",
    headers: headers(creatorAToken),
    body: JSON.stringify(createRequest),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    task: { id: string; ownerAccountId: string; revision: number; createdBy: string };
    replayed: boolean;
  };
  assert.equal(createdBody.task.ownerAccountId, "account_creator_b");
  assert.equal(createdBody.task.createdBy, "account_creator_a");
  assert.equal(createdBody.replayed, false);

  const replay = await fetch(collectionUrl, {
    method: "POST",
    headers: headers(creatorAToken),
    body: JSON.stringify(createRequest),
  });
  assert.equal(replay.status, 200);
  assert.equal(
    ((await replay.json()) as { task: { id: string } }).task.id,
    createdBody.task.id,
  );

  const listed = await fetch(collectionUrl, { headers: headers(creatorAToken) });
  assert.equal(listed.status, 200);
  assert.equal(((await listed.json()) as { tasks: unknown[] }).tasks.length, 1);
  assert.equal((await fetch(`${collectionUrl}?tenantId=tenant_attacker`, {
    headers: headers(creatorAToken),
  })).status, 400);

  const assignmentUrl = `${collectionUrl}/${createdBody.task.id}/assignment`;
  const sameOwnerAssignment = await fetch(assignmentUrl, {
    method: "POST",
    headers: headers(creatorBToken),
    body: JSON.stringify({
      expectedTaskRevision: 1,
      targetOwnerAccountId: "account_creator_b",
      reason: "重复分配给当前负责人",
    }),
  });
  assert.equal(sameOwnerAssignment.status, 409);
  assert.equal(
    ((await sameOwnerAssignment.json()) as { code: string }).code,
    "AIC-VIDEO-TASK-ASSIGNMENT-DENIED",
  );
  assert.equal((await fetch(assignmentUrl, {
    method: "POST",
    headers: headers(creatorAToken),
    body: JSON.stringify({
      expectedTaskRevision: 1,
      targetOwnerAccountId: "account_creator_a",
      reason: "非负责人不得分配",
    }),
  })).status, 403);
  const assigned = await fetch(assignmentUrl, {
    method: "POST",
    headers: headers(creatorBToken),
    body: JSON.stringify({
      expectedTaskRevision: 1,
      targetOwnerAccountId: "account_creator_a",
      reason: "A 负责后续脚本",
    }),
  });
  assert.equal(assigned.status, 200);
  const assignedBody = (await assigned.json()) as {
    task: { ownerAccountId: string; revision: number };
    ownershipTransfer: { actorAccountId: string };
  };
  assert.equal(assignedBody.task.ownerAccountId, "account_creator_a");
  assert.equal(assignedBody.task.revision, 2);
  assert.equal(assignedBody.ownershipTransfer.actorAccountId, "account_creator_b");

  const takeoverUrl = `${collectionUrl}/${createdBody.task.id}/takeover`;
  const taken = await fetch(takeoverUrl, {
    method: "POST",
    headers: headers(creatorBToken),
    body: JSON.stringify({ expectedTaskRevision: 2, reason: "B 接管制作" }),
  });
  assert.equal(taken.status, 200);
  const takenBody = (await taken.json()) as {
    task: { ownerAccountId: string; revision: number };
    ownershipTransfer: { actorAccountId: string };
  };
  assert.equal(takenBody.task.ownerAccountId, "account_creator_b");
  assert.equal(takenBody.task.revision, 3);
  assert.equal(takenBody.ownershipTransfer.actorAccountId, "account_creator_b");
  assert.equal((await fetch(takeoverUrl, {
    method: "POST",
    headers: headers(creatorAToken),
    body: JSON.stringify({ expectedTaskRevision: 2, reason: "陈旧 revision" }),
  })).status, 409);
});
