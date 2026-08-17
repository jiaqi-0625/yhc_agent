import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";

import { startApiServer } from "../src/server.ts";

const testConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-sessions",
};

test("health and metadata endpoints expose the current bounded vertical slice", async (context) => {
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(testConfig));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    status: "ok",
    service: "firefly-ad-agent-api",
    version: "0.1.0",
  });

  const metaResponse = await fetch(`${baseUrl}/v1/meta`);
  assert.equal(metaResponse.status, 200);
  const meta = (await metaResponse.json()) as {
    maturity: string;
    capabilities: string[];
    domainTools: string[];
    boundaries: { publishesAds: boolean; modelCanApprove: boolean; genericToolsEnabled: boolean };
  };
  assert.equal(meta.maturity, "strategy-vertical-slice");
  assert.deepEqual(meta.capabilities, [
    "local_chat",
    "session_persistence",
    "lifecycle_events",
    "request_cancellation",
    "vehicle_snapshot",
    "strategy_draft",
    "human_strategy_approval",
  ]);
  assert.deepEqual(meta.domainTools, [
    "get_vehicle_snapshot",
    "validate_vehicle_claims",
    "generate_strategy",
    "validate_strategy",
    "request_strategy_approval",
  ]);
  assert.deepEqual(meta.boundaries, {
    publishesAds: false,
    modelCanApprove: false,
    genericToolsEnabled: false,
  });
});

test("root serves the local acceptance web UI with locked-down browser assets", async (context) => {
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(testConfig));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const pageResponse = await fetch(`${baseUrl}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type") ?? "", /^text\/html/u);
  assert.match(pageResponse.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  const page = await pageResponse.text();
  assert.match(page, /萤火虫广告 Agent/u);
  assert.match(page, /作品列表/u);
  assert.match(page, /新建广告作品/u);
  assert.match(page, /基于此车型新建作品/u);

  const [styleResponse, scriptResponse] = await Promise.all([
    fetch(`${baseUrl}/app.css`),
    fetch(`${baseUrl}/app.js`),
  ]);
  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get("content-type") ?? "", /^text\/css/u);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type") ?? "", /^text\/javascript/u);
  assert.match(await scriptResponse.text(), /firefly\.workId/u);
});

test("unknown endpoints return a stable business error", async (context) => {
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(testConfig));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/generate`);
  assert.equal(response.status, 404);
  const body = (await response.json()) as { code: string; charged: boolean };
  assert.equal(body.code, "AIC-API-NOT_FOUND");
  assert.equal(body.charged, false);
});

test("local API creates a session, prompts the mock Pi agent, and restores transcript", async (context) => {
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(testConfig));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const createResponse = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "session_api_test" }),
  });
  assert.equal(createResponse.status, 201);

  const promptResponse = await fetch(`${baseUrl}/v1/sessions/session_api_test/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "你好" }),
  });
  assert.equal(promptResponse.status, 200);
  const prompt = (await promptResponse.json()) as {
    assistantText: string;
    events: Array<{ type: string }>;
    session: { messageCount: number };
  };
  assert.match(prompt.assistantText, /本地 Mock Agent 已收到：你好/);
  assert.equal(prompt.session.messageCount, 2);
  assert.ok(prompt.events.some((event) => event.type === "text_delta"));

  const transcriptResponse = await fetch(`${baseUrl}/v1/sessions/session_api_test/transcript`);
  assert.equal(transcriptResponse.status, 200);
  const transcript = (await transcriptResponse.json()) as { messages: unknown[] };
  assert.equal(transcript.messages.length, 2);
});
