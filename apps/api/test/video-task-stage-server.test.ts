import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";
import { StageConfirmationDeniedError } from "@firefly/domain";

import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { startApiServer } from "../src/server.ts";
import type { VideoTaskStageRuntime } from "../src/video-task-stage-runtime.ts";
import {
  WorkspaceSessionRuntime,
  type WorkspaceAccessGrantProvider,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const projectId = "project_stage_server";
const videoTaskId = "task_stage_server";
const basePath =
  `/v1/workspace/batch-projects/${projectId}/video-tasks/${videoTaskId}`;

function agentRuntime(suffix: string): LocalAgentRuntime {
  const config: LocalAgentConfig = {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: false,
    dataDirectory: `.data/test-stage-server-agent-${suffix}`,
  };
  return new LocalAgentRuntime(config);
}

function baseUrl(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function customSessions(suffix: string): Promise<{
  runtime: WorkspaceSessionRuntime;
  token: string;
}> {
  const grants: WorkspaceAccessGrantProvider = {
    async listForAccount() {
      return [];
    },
  };
  const runtime = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(`.data/test-stage-server-sessions-${suffix}`, false),
    grants,
  );
  const session = await runtime.createSession("account_creator_a");
  return { runtime, token: session.sessionId };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function jsonBearer(token: string): {
  authorization: string;
  "content-type": string;
} {
  return { ...bearer(token), "content-type": "application/json" };
}

test("default workspace composition owns stage paths behind the full authentication chain", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-stage-server-default-"));
  const directoryEnvironment = {
    WORKSPACE_ADMIN_DATA_DIRECTORY: join(directory, "workspace-admin"),
    WORKSPACE_SESSION_DATA_DIRECTORY: join(directory, "workspace-sessions"),
    BATCH_PROJECT_DATA_DIRECTORY: join(directory, "batch-projects"),
    VIDEO_TASK_DATA_DIRECTORY: join(directory, "video-tasks"),
    TEMPORARY_ASSET_DATA_DIRECTORY: join(directory, "temporary-assets"),
    ACCOUNT_BUDGET_DATA_DIRECTORY: join(directory, "account-budgets"),
  } as const;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(directoryEnvironment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  const server = await startApiServer(
    0,
    "127.0.0.1",
    agentRuntime("default"),
    new LocalBusinessRuntime(),
  );
  context.after(async () => {
    await closeServer(server);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const url = baseUrl(server);
  const createdSession = await fetch(`${url}/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "account_creator_a" }),
  });
  assert.equal(createdSession.status, 201);
  const token = ((await createdSession.json()) as { session: { token: string } }).session.token;

  const response = await fetch(`${url}${basePath}/stages/strategy/versions`, {
    headers: bearer(token),
  });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "AIC-STAGE-PROJECT_NOT_FOUND");
  assert.notEqual(body.code, "AIC-VIDEO-TASK-RUNTIME_NOT_CONFIGURED");
  assert.notEqual(body.code, "AIC-API-NOT_FOUND");
});

test("custom sessions without a paired stage runtime fail closed on exactly the four stage routes", async (context) => {
  const sessions = await customSessions("unpaired");
  const server = await startApiServer(
    0,
    "127.0.0.1",
    agentRuntime("unpaired"),
    new LocalBusinessRuntime(),
    undefined,
    sessions.runtime,
    true,
    false,
  );
  context.after(() => closeServer(server));
  const url = baseUrl(server);
  const routes = [
    {
      path: `${basePath}/stages/strategy/versions`,
      init: { headers: bearer(sessions.token) },
    },
    {
      path: `${basePath}/stage-invalidations`,
      init: { headers: bearer(sessions.token) },
    },
    {
      path: `${basePath}/stages/strategy/confirmations`,
      init: {
        method: "POST",
        headers: jsonBearer(sessions.token),
        body: JSON.stringify({
          requestId: "request_unpaired_confirm",
          expectedTaskRevision: 1,
        }),
      },
    },
    {
      path: `${basePath}/stages/strategy/rollbacks`,
      init: {
        method: "POST",
        headers: jsonBearer(sessions.token),
        body: JSON.stringify({
          requestId: "request_unpaired_rollback",
          expectedTaskRevision: 1,
          targetArtifactVersionId: "artifact_strategy_v1",
          reason: "验证组合层 fail closed。",
        }),
      },
    },
  ] satisfies Array<{ path: string; init: RequestInit }>;

  for (const route of routes) {
    const response = await fetch(`${url}${route.path}`, route.init);
    assert.equal(response.status, 503);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "AIC-VIDEO-TASK-STAGE-RUNTIME_NOT_CONFIGURED",
    );
  }

  const neighboringRoutes = [
    {
      path: `${basePath}/commands`,
      expectedCode: "AIC-AGENT-COMMAND-RUNTIME_NOT_CONFIGURED",
    },
    {
      path: `${basePath}/assignment`,
      expectedCode: "AIC-VIDEO-TASK-RUNTIME_NOT_CONFIGURED",
    },
    {
      path: `${basePath}/takeover`,
      expectedCode: "AIC-VIDEO-TASK-RUNTIME_NOT_CONFIGURED",
    },
  ];
  for (const route of neighboringRoutes) {
    const response = await fetch(`${url}${route.path}`, {
      method: "POST",
      headers: jsonBearer(sessions.token),
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, route.expectedCode);
  }
});

test("stage confirmation denial remains a coded HTTP 409 through server composition", async (context) => {
  const sessions = await customSessions("confirmation-denied");
  const stageRuntime = {
    async confirmStage() {
      throw new StageConfirmationDeniedError("Only an awaiting stage can be confirmed.");
    },
  } as unknown as VideoTaskStageRuntime;
  const server = await startApiServer(
    0,
    "127.0.0.1",
    agentRuntime("confirmation-denied"),
    new LocalBusinessRuntime(),
    undefined,
    sessions.runtime,
    true,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    stageRuntime,
  );
  context.after(() => closeServer(server));

  const response = await fetch(
    `${baseUrl(server)}${basePath}/stages/strategy/confirmations`,
    {
      method: "POST",
      headers: jsonBearer(sessions.token),
      body: JSON.stringify({
        requestId: "request_confirmation_denied",
        expectedTaskRevision: 3,
      }),
    },
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as {
    code: string;
    retryable: boolean;
    charged: boolean;
  };
  assert.equal(body.code, "AIC-STAGE-CONFIRMATION-DENIED");
  assert.equal(body.retryable, false);
  assert.equal(body.charged, false);
});
