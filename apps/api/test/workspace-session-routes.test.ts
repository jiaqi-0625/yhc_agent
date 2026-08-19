import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";

import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { startApiServer } from "../src/server.ts";
import {
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
  dataDirectory: ".data/test-workspace-auth-agent-sessions",
};

async function startFixture() {
  const workspaceSessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-workspace-http-sessions", false),
    new InMemoryWorkspaceAccessGrantProvider(),
  );
  const server = await startApiServer(
    0,
    "127.0.0.1",
    new LocalAgentRuntime(agentConfig),
    new LocalBusinessRuntime(),
    undefined,
    workspaceSessions,
    true,
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function createLegacyWork(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/works`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      vehicleId: "vehicle_firefly_e5_2026_long_range",
      color: "萤火绿",
      region: "中国大陆",
      campaignDate: "2026-08-19",
    }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { work: { id: string } };
  return body.work.id;
}

async function createWorkspaceSession(baseUrl: string, accountId: string, token?: string) {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ accountId }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as {
    session: {
      token: string;
      expiresAt: string;
      account: { accountId: string; displayName: string; role: string };
    };
  };
}

test("development account HTTP sessions reject identity forgery and revoke switched credentials", async (context) => {
  const { server, baseUrl } = await startFixture();
  context.after(() => server.close());

  const accountsResponse = await fetch(`${baseUrl}/v1/auth/development-accounts`);
  assert.equal(accountsResponse.status, 200);
  const accountsBody = (await accountsResponse.json()) as { accounts: Array<Record<string, unknown>> };
  assert.deepEqual(accountsBody.accounts.map((account) => account.accountId), [
    "account_admin",
    "account_creator_a",
    "account_creator_b",
  ]);
  assert.deepEqual(Object.keys(accountsBody.accounts[0]!).sort(), ["accountId", "displayName", "role"]);
  assert.doesNotMatch(JSON.stringify(accountsBody), /tenantId|accessGrants/u);

  for (const forged of [
    { accountId: "account_creator_a", tenantId: "tenant_attacker" },
    { accountId: "account_creator_a", role: "content_admin" },
    { accountId: "account_creator_a", accessGrants: [] },
    { accountId: "account_creator_a", actorAccountId: "account_admin" },
  ]) {
    const response = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forged),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, "AIC-API-SCHEMA_INVALID");
  }

  const first = await createWorkspaceSession(baseUrl, "account_creator_a");
  assert.match(first.session.token, /^session_[A-Za-z0-9_-]{40,}$/u);
  assert.equal(first.session.account.accountId, "account_creator_a");

  const missing = await fetch(`${baseUrl}/v1/auth/session`);
  assert.equal(missing.status, 401);
  assert.equal(((await missing.json()) as { code: string }).code, "AIC-AUTH-SESSION_REQUIRED");
  const duplicate = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { authorization: `Bearer ${first.session.token}, Bearer ${first.session.token}` },
  });
  assert.equal(duplicate.status, 401);
  assert.equal(((await duplicate.json()) as { code: string }).code, "AIC-AUTH-SESSION_HEADER_INVALID");

  const current = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { authorization: `Bearer ${first.session.token}` },
  });
  assert.equal(current.status, 200);
  const currentBody = await current.text();
  assert.doesNotMatch(currentBody, new RegExp(first.session.token, "u"));
  assert.doesNotMatch(currentBody, /accessGrants/u);

  const switched = await createWorkspaceSession(baseUrl, "account_creator_b", first.session.token);
  assert.notEqual(switched.session.token, first.session.token);
  const old = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { authorization: `Bearer ${first.session.token}` },
  });
  assert.equal(old.status, 401);
  assert.equal(((await old.json()) as { code: string }).code, "AIC-AUTH-SESSION_INVALID");

  const signedOut = await fetch(`${baseUrl}/v1/auth/session`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${switched.session.token}` },
  });
  assert.equal(signedOut.status, 204);
  const afterSignOut = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { authorization: `Bearer ${switched.session.token}` },
  });
  assert.equal(afterSignOut.status, 401);
});

test("authenticated Agent sessions are hidden from other accounts and anonymous callers", async (context) => {
  const { server, baseUrl } = await startFixture();
  context.after(() => server.close());
  const accountA = await createWorkspaceSession(baseUrl, "account_creator_a");
  const accountB = await createWorkspaceSession(baseUrl, "account_creator_b");
  const videoTaskId = await createLegacyWork(baseUrl);
  const taskQuery = `?videoTaskId=${encodeURIComponent(videoTaskId)}`;

  const forgedId = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accountA.session.token}`,
    },
    body: JSON.stringify({ id: "attacker_selected_id", videoTaskId }),
  });
  assert.equal(forgedId.status, 400);

  const createdResponse = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accountA.session.token}`,
    },
    body: JSON.stringify({ videoTaskId }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as { session: { id: string } };
  assert.match(created.session.id, /^session_[A-Za-z0-9_-]+$/u);

  const forbiddenRequests: Array<() => Promise<Response>> = [
    () => fetch(`${baseUrl}/v1/sessions/${created.session.id}${taskQuery}`, {
      headers: { authorization: `Bearer ${accountB.session.token}` },
    }),
    () => fetch(`${baseUrl}/v1/sessions/${created.session.id}/transcript${taskQuery}`, {
      headers: { authorization: `Bearer ${accountB.session.token}` },
    }),
    () => fetch(`${baseUrl}/v1/sessions/${created.session.id}/messages${taskQuery}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accountB.session.token}`,
      },
      body: JSON.stringify({ message: "越权" }),
    }),
    () => fetch(`${baseUrl}/v1/sessions/${created.session.id}/messages-stream${taskQuery}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accountB.session.token}`,
      },
      body: JSON.stringify({ message: "越权流" }),
    }),
    () => fetch(`${baseUrl}/v1/sessions/${created.session.id}/reset${taskQuery}`, {
      method: "POST",
      headers: { authorization: `Bearer ${accountB.session.token}` },
    }),
    () => fetch(`${baseUrl}/v1/sessions/${created.session.id}/abort${taskQuery}`, {
      method: "POST",
      headers: { authorization: `Bearer ${accountB.session.token}` },
    }),
    () => fetch(`${baseUrl}/v1/sessions/${created.session.id}${taskQuery}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accountB.session.token}` },
    }),
  ];
  for (const request of forbiddenRequests) {
    const response = await request();
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(((await response.json()) as { code: string }).code, "AIC-AUTH-SESSION_SCOPE_DENIED");
  }
  const missing = await fetch(`${baseUrl}/v1/sessions/session_does_not_exist${taskQuery}`, {
    headers: { authorization: `Bearer ${accountB.session.token}` },
  });
  assert.equal(missing.status, 403);
  assert.equal(((await missing.json()) as { code: string }).code, "AIC-AUTH-SESSION_SCOPE_DENIED");

  const anonymous = await fetch(`${baseUrl}/v1/sessions/${created.session.id}`);
  assert.equal(anonymous.status, 403);
  const owned = await fetch(`${baseUrl}/v1/sessions/${created.session.id}${taskQuery}`, {
    headers: { authorization: `Bearer ${accountA.session.token}` },
  });
  assert.equal(owned.status, 200);
});

test("legacy anonymous APIs fail closed when local compatibility is disabled", async (context) => {
  const workspaceSessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-workspace-closed-sessions", false),
    new InMemoryWorkspaceAccessGrantProvider(),
  );
  const business = new LocalBusinessRuntime();
  const work = await business.createWork({
    vehicleId: "vehicle_firefly_e5_2026_long_range",
    color: "萤火绿",
    region: "中国大陆",
    campaignDate: "2026-08-19",
  });
  const server = await startApiServer(
    0,
    "127.0.0.1",
    new LocalAgentRuntime(agentConfig),
    business,
    undefined,
    workspaceSessions,
    true,
    false,
  );
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const anonymousAgent = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(anonymousAgent.status, 401);
  assert.equal(((await anonymousAgent.json()) as { code: string }).code, "AIC-AUTH-SESSION_SCOPE_REQUIRED");

  const legacyWorks = await fetch(`${baseUrl}/v1/works`);
  assert.equal(legacyWorks.status, 404);
  assert.equal(((await legacyWorks.json()) as { code: string }).code, "AIC-API-NOT_FOUND");

  const account = await createWorkspaceSession(baseUrl, "account_creator_a");
  const authenticatedAgent = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${account.session.token}`,
    },
    body: JSON.stringify({ videoTaskId: work.work.id }),
  });
  assert.equal(authenticatedAgent.status, 201);
});
