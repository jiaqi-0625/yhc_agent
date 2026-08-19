import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";
import { createVideoTask, type WorkspaceSessionScope } from "@firefly/domain";
import type { BatchProject, ProjectAssetPool } from "@firefly/schemas";

import { LocalBatchProjectStore } from "../src/batch-project-store.ts";
import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { ProjectLibraryRuntime } from "../src/project-library-runtime.ts";
import { startApiServer } from "../src/server.ts";
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
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const agentConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-project-library-agent",
};

function project(id: string, batchName: string, updatedAt: string): BatchProject {
  return {
    id,
    tenantId: "tenant_firefly",
    brandId: "brand_firefly_demo",
    vehicleId: "vehicle_firefly_e5_2026_long_range",
    vehicleVersion: 1,
    name: `萤火汽车 萤火 E5 长续航版 16:9 ${batchName}`,
    batchName,
    aspectRatio: "16:9",
    visualStylePresetId: "asset_style_firefly_demo_clean",
    assetPoolId: `pool_${id}`,
    status: "active",
    revision: 1,
    createdAt: updatedAt,
    createdBy: "account_creator_a",
    updatedAt,
    updatedBy: "account_creator_a",
  };
}

function assetPool(value: Readonly<BatchProject>, updatedAt = value.updatedAt): ProjectAssetPool {
  return {
    id: value.assetPoolId,
    tenantId: value.tenantId,
    batchProjectId: value.id,
    vehicleId: value.vehicleId,
    revision: 1,
    assets: [{
      assetId: "asset_firefly_demo_e5_hero",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId: value.vehicleId,
    }],
    createdAt: value.createdAt,
    createdBy: value.createdBy,
    updatedAt,
    updatedBy: value.updatedBy,
  };
}

function scope(accountId: string, role: WorkspaceSessionScope["role"]): WorkspaceSessionScope {
  return {
    actorAccountId: accountId,
    tenantId: "tenant_firefly",
    role,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS.filter((grant) => grant.accountId === accountId),
  };
}

async function fixture() {
  const administration = new LocalWorkspaceAdminStore(".data/test-project-library-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES,
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const projects = new LocalBatchProjectStore(".data/test-project-library-projects", false);
  const olderProject = project(
    "batch_project_library_older",
    "春季焕新",
    "2026-08-19T09:00:00.000Z",
  );
  const newerProject = project(
    "batch_project_library_newer",
    "家庭出行",
    "2026-08-19T11:00:00.000Z",
  );
  await projects.create(olderProject, assetPool(olderProject), {
    requestId: "request_library_project_older",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_library_project_older",
  });
  await projects.create(newerProject, assetPool(newerProject), {
    requestId: "request_library_project_newer",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_library_project_newer",
  });
  const tasks = new LocalVideoTaskProductionStore(".data/test-project-library-tasks", false);
  const taskOwnedByOther = createVideoTask(olderProject, {
    name: "由 A 创建但由 B 负责",
    audience: "家庭用户",
    theme: "周末出行",
    durationSeconds: 30,
    platformTags: ["douyin"],
  }, {
    tenantId: olderProject.tenantId,
    taskId: "video_task_library_owned_by_b",
    actorAccountId: "account_creator_a",
    ownerAccountId: "account_creator_b",
    occurredAt: "2026-08-19T23:00:00+08:00",
  });
  const taskOwnedByCurrent = createVideoTask(olderProject, {
    name: "当前账号进行中任务",
    audience: "城市家庭",
    theme: "日常通勤",
    durationSeconds: 20,
    platformTags: ["xiaohongshu"],
  }, {
    tenantId: olderProject.tenantId,
    taskId: "video_task_library_owned_by_a",
    actorAccountId: "account_creator_b",
    ownerAccountId: "account_creator_a",
    occurredAt: "2026-08-19T15:30:00.000Z",
  });
  await tasks.create(taskOwnedByOther, {
    requestId: "request_library_task_b",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_library_task_b",
  });
  await tasks.create(taskOwnedByCurrent, {
    requestId: "request_library_task_a",
    actorAccountId: "account_creator_b",
    payloadHash: "payload_library_task_a",
  });
  return {
    administration,
    projects,
    tasks,
    library: new ProjectLibraryRuntime(administration, projects, tasks),
  };
}

test("project library filters by current grants and derives activity and ownership", async () => {
  const { administration, library } = await fixture();
  const result = await library.list(scope("account_creator_a", "creator"));
  assert.deepEqual(result.map((summary) => summary.project.id), [
    "batch_project_library_older",
    "batch_project_library_newer",
  ]);
  assert.equal(result[0]?.latestActivityAt, "2026-08-19T15:30:00.000Z");
  assert.deepEqual(result[0]?.tasks.map((task) => [task.id, task.ownedByCurrentAccount]), [
    ["video_task_library_owned_by_a", true],
    ["video_task_library_owned_by_b", false],
  ]);
  assert.equal(result[0]?.vehicle.displayName, "萤火 E5 2026 长续航版");

  const adminResult = await library.list(scope("account_admin", "content_admin"));
  assert.equal(adminResult.length, 2);
  assert.ok(adminResult.every((summary) =>
    summary.tasks.every((task) => !task.ownedByCurrentAccount)));

  await administration.transact("tenant_firefly", (state) => ({
    ...state,
    accessGrants: state.accessGrants.map((grant) =>
      grant.accountId === "account_creator_a"
        ? {
            ...grant,
            status: "revoked" as const,
            revision: grant.revision + 1,
            updatedAt: "2026-08-19T16:00:00.000Z",
            updatedBy: "account_admin",
          }
        : grant),
  }));
  assert.deepEqual(await library.list(scope("account_creator_a", "creator")), []);
});

test("project library HTTP route requires a session and rejects query parameters", async (context) => {
  const { administration, library } = await fixture();
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-project-library-sessions", false),
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    library,
  );
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${baseUrl}/v1/workspace/project-library`)).status, 401);

  const sessionResponse = await fetch(`${baseUrl}/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "account_creator_a" }),
  });
  const session = (await sessionResponse.json()) as { session: { token: string } };
  const headers = { authorization: `Bearer ${session.session.token}` };
  const response = await fetch(`${baseUrl}/v1/workspace/project-library`, { headers });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { projects: unknown[] }).projects.length, 2);
  assert.equal((await fetch(`${baseUrl}/v1/workspace/project-library?accountId=forged`, {
    headers,
  })).status, 400);

  const serverWithoutLibrary = await startApiServer(
    0,
    "127.0.0.1",
    new LocalAgentRuntime(agentConfig),
    new LocalBusinessRuntime(),
    undefined,
    sessions,
    true,
    false,
  );
  context.after(() => serverWithoutLibrary.close());
  const unavailableAddress = serverWithoutLibrary.address();
  assert.ok(unavailableAddress && typeof unavailableAddress === "object");
  const unavailableBaseUrl = `http://127.0.0.1:${unavailableAddress.port}`;
  const meta = (await (await fetch(`${unavailableBaseUrl}/v1/meta`)).json()) as {
    capabilities: string[];
  };
  assert.equal(meta.capabilities.includes("project_library_v1"), false);
  assert.equal((await fetch(`${unavailableBaseUrl}/v1/workspace/project-library`, {
    headers,
  })).status, 503);
});
