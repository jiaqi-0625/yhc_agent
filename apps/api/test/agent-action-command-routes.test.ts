import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";
import type { AgentActionCard, BatchProject, ProjectAssetPool } from "@firefly/schemas";

import { AgentActionCommandRuntime } from "../src/agent-action-command-runtime.ts";
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
  dataDirectory: ".data/test-agent-command-http-agent",
};

const project: BatchProject = {
  id: "batch_project_http_ws305",
  tenantId: "tenant_firefly",
  brandId: "brand_firefly_demo",
  vehicleId: "vehicle_firefly_e5_2026_long_range",
  vehicleVersion: 1,
  name: "萤火汽车 萤火 E5 长续航版 9:16 HTTP WS305",
  batchName: "HTTP WS305",
  aspectRatio: "9:16",
  visualStylePresetId: "asset_style_firefly_demo_clean",
  assetPoolId: "project_asset_pool_http_ws305",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T15:00:00.000Z",
  createdBy: "account_creator_a",
  updatedAt: "2026-08-19T15:00:00.000Z",
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

function vehicleFacts() {
  return DEFAULT_ADMIN_VEHICLES.map((vehicle) => ({
    ...vehicle,
    fixedClaims: [{
      id: "claim_http_space",
      kind: "fixed" as const,
      name: "五座空间",
      statement: "提供五座乘坐空间。",
      evidence: {
        sourceName: "车型配置表",
        sourceReference: "vehicle-http-v1",
        effectiveFrom: "2026-08-01",
      },
      requiredInVoiceover: true,
      requiredInSubtitle: true,
      mayRephrase: false,
      riskNotes: [],
    }],
  }));
}

async function fixture() {
  const administration = new LocalWorkspaceAdminStore(".data/test-agent-command-http-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: vehicleFacts(),
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-agent-command-http-sessions", false),
    administration,
  );
  const projects = new LocalBatchProjectStore(".data/test-agent-command-http-projects", false);
  await projects.create(project, pool, {
    requestId: "request_http_ws305_project",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_http_ws305_project",
  });
  const tasks = new LocalVideoTaskProductionStore(".data/test-agent-command-http-tasks", false);
  const videoTasks = new VideoTaskRuntime(
    administration,
    projects,
    tasks,
    () => DEVELOPMENT_ACCOUNTS,
    () => "2026-08-19T15:10:00.000Z",
  );
  const creatorAccount = DEVELOPMENT_ACCOUNTS.find(
    (account) => account.accountId === "account_creator_a",
  )!;
  const creatorScope = {
    actorAccountId: creatorAccount.accountId,
    tenantId: creatorAccount.tenantId,
    role: creatorAccount.role,
    accessGrants: await administration.listForAccount(
      creatorAccount.tenantId,
      creatorAccount.accountId,
    ),
  };
  const created = await videoTasks.create(project.id, {
    requestId: "request_http_ws305_task",
    name: "HTTP WS305 策略任务",
    audience: "城市家庭",
    theme: "智能通勤",
    durationSeconds: 30,
    platformTags: ["douyin"],
  }, creatorScope);
  let sequence = 0;
  const commands = new AgentActionCommandRuntime(
    administration,
    projects,
    tasks,
    () => "2026-08-19T15:20:00.000Z",
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
    commands,
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    sessions,
    taskId: created.record.videoTask.id,
  };
}

async function bearer(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "account_creator_a" }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { session: { token: string } }).session.token;
}

function card(taskId: string): Extract<AgentActionCard, { action: "generate_strategy" }> {
  return {
    schemaVersion: 1,
    kind: "agent_action_card",
    videoTaskId: taskId,
    action: "generate_strategy",
    label: "生成卖点策略草稿",
    summary: "通过明确按钮生成策略。",
    expectedRevision: 1,
    cost: { kind: "estimated", amount: 9999, currency: "CNY" },
    payload: { schemaVersion: 1, audience: "城市家庭", theme: "智能通勤" },
  };
}

test("command HTTP route authenticates, validates strict scope, and returns server-authoritative cost", async (context) => {
  const { baseUrl, server, taskId } = await fixture();
  context.after(() => server.close());
  const url = `${baseUrl}/v1/workspace/batch-projects/${project.id}/video-tasks/${taskId}/commands`;
  const input = { requestId: "command_http_generate", card: card(taskId) };

  assert.equal((await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })).status, 401);

  const token = await bearer(baseUrl);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  for (const forged of [
    { ...input, actorAccountId: "account_attacker" },
    { ...input, tenantId: "tenant_attacker" },
    { ...input, budgetAuthorized: true },
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(forged),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, "AIC-API-SCHEMA_INVALID");
  }

  const wrongTask = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...input, card: card("task_attacker") }),
  });
  assert.equal(wrongTask.status, 409);
  assert.equal(
    ((await wrongTask.json()) as { code: string }).code,
    "AIC-AGENT-COMMAND-SCOPE_INVALID",
  );

  const executed = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(executed.status, 200);
  const result = (await executed.json()) as {
    replayed: boolean;
    receipt: { cost: { kind: string; amountMinor: number; charged: boolean } };
    videoTask: { revision: number };
  };
  assert.equal(result.replayed, false);
  assert.deepEqual(result.receipt.cost, { kind: "free", amountMinor: 0, charged: false });
  assert.equal(result.videoTask.revision, 2);

  const replayed = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...input,
      card: { ...card(taskId), summary: "不同展示文案", cost: { kind: "free" } },
    }),
  });
  assert.equal(replayed.status, 200);
  assert.equal(((await replayed.json()) as { replayed: boolean }).replayed, true);
});

test("custom sessions without a paired command runtime fail closed", async (context) => {
  const administration = new LocalWorkspaceAdminStore(".data/test-agent-command-unpaired-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES,
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-agent-command-unpaired-sessions", false),
    administration,
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
  );
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = await bearer(baseUrl);
  const response = await fetch(
    `${baseUrl}/v1/workspace/batch-projects/${project.id}/video-tasks/task_missing/commands`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: "command_unpaired", card: card("task_missing") }),
    },
  );
  assert.equal(response.status, 503);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "AIC-AGENT-COMMAND-RUNTIME_NOT_CONFIGURED",
  );
});
