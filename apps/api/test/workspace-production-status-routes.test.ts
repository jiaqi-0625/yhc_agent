import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";

import { AccountRunLockRuntime } from "../src/account-run-lock-runtime.ts";
import { LocalAccountRunLockStore } from "../src/account-run-lock-store.ts";
import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { startApiServer } from "../src/server.ts";
import {
  DEVELOPMENT_ACCESS_GRANTS,
  InMemoryWorkspaceAccessGrantProvider,
  WorkspaceSessionRuntime,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const agentConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-production-status-agent-sessions",
};

async function sessionToken(baseUrl: string, accountId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { session: { token: string } }).session.token;
}

test("production status exposes only the authenticated account run slot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-production-status-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(join(directory, "sessions"), false),
    new InMemoryWorkspaceAccessGrantProvider(DEVELOPMENT_ACCESS_GRANTS),
  );
  const store = new LocalAccountRunLockStore(join(directory, "run-locks"), false);
  const runLocks = new AccountRunLockRuntime(store);
  await store.transact("tenant_firefly", "account_creator_a", () => ({
    id: "run_lock_private",
    tenantId: "tenant_firefly",
    accountId: "account_creator_a",
    batchProjectId: "project_launch",
    videoTaskId: "task_preview",
    taskRevision: 8,
    operation: "video_generation",
    acquiredAt: "2026-08-20T08:00:00.000Z",
  }));
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
    undefined,
    join(directory, "migrations"),
    undefined,
    undefined,
    runLocks,
  );
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const path = "/v1/workspace/me/production-status";

  assert.equal((await fetch(`${baseUrl}${path}`)).status, 401);
  const tokenA = await sessionToken(baseUrl, "account_creator_a");
  const invalidQuery = await fetch(`${baseUrl}${path}?accountId=account_creator_b`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(invalidQuery.status, 400);
  assert.equal(((await invalidQuery.json()) as { code: string }).code, "AIC-API-QUERY_INVALID");

  const own = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(own.status, 200);
  const ownBody = await own.json();
  assert.deepEqual(ownBody, {
    runLock: {
      batchProjectId: "project_launch",
      videoTaskId: "task_preview",
      taskRevision: 8,
      operation: "video_generation",
      acquiredAt: "2026-08-20T08:00:00.000Z",
    },
  });
  assert.doesNotMatch(JSON.stringify(ownBody), /run_lock_private|tenant_firefly|account_creator_a/u);

  const tokenB = await sessionToken(baseUrl, "account_creator_b");
  const empty = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { runLock: null });
});
