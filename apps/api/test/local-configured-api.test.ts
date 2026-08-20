import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import {
  resolvePersistenceBackend,
  startConfiguredApiServer,
} from "../src/server.ts";

class TrackingLocalBusinessRuntime extends LocalBusinessRuntime {
  getWorkCount = 0;

  override getWork(workId: string): ReturnType<LocalBusinessRuntime["getWork"]> {
    this.getWorkCount += 1;
    return super.getWork(workId);
  }
}

function baseUrl(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test("configured development defaults to local persistence while production remains explicit", () => {
  assert.equal(resolvePersistenceBackend({ NODE_ENV: "development" }), "local");
  assert.equal(
    resolvePersistenceBackend({ NODE_ENV: "development", PERSISTENCE_BACKEND: "postgres" }),
    "postgres",
  );
  assert.throws(
    () => resolvePersistenceBackend({ NODE_ENV: "production" }),
    /Production requires PERSISTENCE_BACKEND=postgres/u,
  );
});

test("configured local server resolves authenticated V2 Agent tasks without legacy Work fallback", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "firefly-local-configured-"));
  let server: Server | undefined;
  const environment = {
    NODE_ENV: "development",
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
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  context.after(async () => {
    await closeServer(server);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const business = new TrackingLocalBusinessRuntime();
  server = await startConfiguredApiServer(0, "127.0.0.1", {
    environment,
    business,
    registerSignalHandlers: false,
  });
  const url = baseUrl(server);
  const accountResponse = await fetch(`${url}/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "account_creator_a" }),
  });
  assert.equal(accountResponse.status, 201);
  const workspaceToken = ((await accountResponse.json()) as {
    session: { token: string };
  }).session.token;
  const headers = {
    authorization: `Bearer ${workspaceToken}`,
    "content-type": "application/json",
  };

  const vehicleId = "vehicle_firefly_e5_2026_long_range";
  const assetPackageResponse = await fetch(
    `${url}/v1/workspace/project-creation/vehicles/${vehicleId}/asset-package`,
    { headers },
  );
  assert.equal(assetPackageResponse.status, 200);
  const vehicleReference = ((await assetPackageResponse.json()) as {
    recommendedAssets: Array<{ reference: Record<string, unknown> }>;
  }).recommendedAssets[0]?.reference;
  assert.ok(vehicleReference);

  const projectResponse = await fetch(`${url}/v1/workspace/batch-projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: "request_local_configured_project",
      vehicleId,
      expectedBrandRevision: 1,
      expectedVehicleVersion: 1,
      expectedAssetAssociationRevision: 1,
      selectedAssets: [vehicleReference],
      aspectRatio: "9:16",
      batchName: "本地 Agent 数据源一致性",
      customStylePrompt: "清透产品光线",
    }),
  });
  assert.equal(projectResponse.status, 201);
  const projectId = ((await projectResponse.json()) as {
    project: { id: string };
  }).project.id;

  const taskResponse = await fetch(
    `${url}/v1/workspace/batch-projects/${projectId}/video-tasks`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "request_local_configured_task",
        name: "本地 Agent 主片",
        audience: "城市家庭",
        theme: "智能通勤",
        durationSeconds: 30,
        platformTags: ["douyin"],
        ownerAccountId: "account_creator_a",
      }),
    },
  );
  assert.equal(taskResponse.status, 201);
  const videoTaskId = ((await taskResponse.json()) as {
    task: { id: string };
  }).task.id;

  const missingTaskResponse = await fetch(
    `${url}/v1/sessions?videoTaskId=${encodeURIComponent("video_task_missing")}`,
    { headers },
  );
  assert.equal(missingTaskResponse.status, 404);
  assert.equal(
    ((await missingTaskResponse.json()) as { code: string }).code,
    "AIC-AGENT-VIDEO-TASK_NOT_FOUND",
  );
  assert.equal(business.getWorkCount, 0);

  const taskQuery = `?videoTaskId=${encodeURIComponent(videoTaskId)}`;
  const sessionsResponse = await fetch(`${url}/v1/sessions${taskQuery}`, { headers });
  assert.equal(sessionsResponse.status, 200);
  assert.deepEqual((await sessionsResponse.json()) as { sessions: unknown[] }, { sessions: [] });

  const createSessionResponse = await fetch(`${url}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ videoTaskId }),
  });
  assert.equal(createSessionResponse.status, 201);
  const createdSession = (await createSessionResponse.json()) as {
    session: { videoTaskId: string; taskContext: { videoTask: { id: string } } };
  };
  assert.equal(createdSession.session.videoTaskId, videoTaskId);
  assert.equal(createdSession.session.taskContext.videoTask.id, videoTaskId);
  assert.equal(business.getWorkCount, 0);
});
