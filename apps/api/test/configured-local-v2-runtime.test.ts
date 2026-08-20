import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { startConfiguredApiServer } from "../src/server.ts";

class TrackingLocalBusinessRuntime extends LocalBusinessRuntime {
  legacyReadCount = 0;

  override async listWorks(): ReturnType<LocalBusinessRuntime["listWorks"]> {
    this.legacyReadCount += 1;
    return super.listWorks();
  }

  override async getWork(workId: string): ReturnType<LocalBusinessRuntime["getWork"]> {
    this.legacyReadCount += 1;
    return super.getWork(workId);
  }
}

function baseUrl(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test("configured local backend resolves newly-created V2 tasks without V1 fallback", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "firefly-configured-local-v2-"));
  const business = new TrackingLocalBusinessRuntime();
  const environment = {
    NODE_ENV: "development",
    PERSISTENCE_BACKEND: "local",
    AGENT_PROVIDER: "mock",
    LOCAL_AGENT_PERSIST_SESSIONS: "false",
    LOCAL_AGENT_DATA_DIR: join(root, "agent-sessions"),
    WORKSPACE_ADMIN_DATA_DIRECTORY: join(root, "workspace-admin"),
    WORKSPACE_SESSION_DATA_DIRECTORY: join(root, "workspace-sessions"),
    BATCH_PROJECT_DATA_DIRECTORY: join(root, "batch-projects"),
    VIDEO_TASK_DATA_DIRECTORY: join(root, "video-tasks"),
    TEMPORARY_ASSET_DATA_DIRECTORY: join(root, "temporary-assets"),
    ACCOUNT_BUDGET_DATA_DIRECTORY: join(root, "account-budgets"),
    ACCOUNT_RUN_LOCK_DATA_DIRECTORY: join(root, "account-run-locks"),
    WORKSPACE_MIGRATION_DATA_DIRECTORY: join(root, "workspace-migrations"),
  } as const;
  const server = await startConfiguredApiServer(0, "127.0.0.1", {
    environment,
    business,
    registerSignalHandlers: false,
  });
  context.after(async () => {
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  });
  const url = baseUrl(server);

  const authResponse = await fetch(`${url}/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "account_creator_a" }),
  });
  assert.equal(authResponse.status, 201);
  const token = ((await authResponse.json()) as { session: { token: string } }).session.token;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  const vehicleId = "vehicle_firefly_e5_2026_long_range";
  const assetPackageResponse = await fetch(
    `${url}/v1/workspace/project-creation/vehicles/${vehicleId}/asset-package`,
    { headers },
  );
  assert.equal(assetPackageResponse.status, 200);
  const assetReference = ((await assetPackageResponse.json()) as {
    recommendedAssets: Array<{ reference: Record<string, unknown> }>;
  }).recommendedAssets[0]?.reference;
  assert.ok(assetReference);

  const projectResponse = await fetch(`${url}/v1/workspace/batch-projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: "request_ws503_local_project",
      vehicleId,
      expectedBrandRevision: 1,
      expectedVehicleVersion: 1,
      expectedAssetAssociationRevision: 1,
      selectedAssets: [assetReference],
      aspectRatio: "9:16",
      batchName: "WS-503 本地闭环",
      customStylePrompt: "清透产品光线",
    }),
  });
  assert.equal(projectResponse.status, 201);
  const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id;

  const taskResponse = await fetch(
    `${url}/v1/workspace/batch-projects/${projectId}/video-tasks`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "request_ws503_local_task",
        name: "WS-503 主片",
        audience: "城市家庭",
        theme: "智能通勤",
        durationSeconds: 30,
        platformTags: ["douyin"],
        ownerAccountId: "account_creator_a",
      }),
    },
  );
  assert.equal(taskResponse.status, 201);
  const videoTaskId = ((await taskResponse.json()) as { task: { id: string } }).task.id;

  const agentSessionResponse = await fetch(`${url}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ videoTaskId }),
  });
  assert.equal(agentSessionResponse.status, 201);
  const agentSession = (await agentSessionResponse.json()) as {
    session: { taskContext: { videoTask: { id: string } } };
  };
  assert.equal(agentSession.session.taskContext.videoTask.id, videoTaskId);

  assert.equal(business.legacyReadCount, 0);
});
