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
    "streaming_chat",
    "session_persistence",
    "lifecycle_events",
    "request_cancellation",
    "vehicle_snapshot",
    "strategy_draft",
    "human_strategy_approval",
    "work_bound_agent",
  ]);
  assert.deepEqual(meta.domainTools, [
    "get_vehicle_snapshot",
    "validate_vehicle_claims",
    "propose_strategy_generation",
    "validate_strategy",
    "propose_strategy_approval",
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
  assert.match(page, /workspace-agent-boundaries-v1/u);
  assert.match(page, /type="module"/u);

  const [
    styleResponse,
    agentStyleResponse,
    scriptResponse,
    agentApiResponse,
    agentPanelResponse,
    workspaceApiResponse,
    workspaceShellResponse,
  ] = await Promise.all([
    fetch(`${baseUrl}/app.css`),
    fetch(`${baseUrl}/agent-panel.css`),
    fetch(`${baseUrl}/app.js`),
    fetch(`${baseUrl}/agent-api.js`),
    fetch(`${baseUrl}/agent-panel.js`),
    fetch(`${baseUrl}/workspace-api.js`),
    fetch(`${baseUrl}/workspace-shell.js`),
  ]);
  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get("content-type") ?? "", /^text\/css/u);
  assert.equal(agentStyleResponse.status, 200);
  assert.match(await agentStyleResponse.text(), /\.agent-action-card/u);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type") ?? "", /^text\/javascript/u);
  assert.equal(agentApiResponse.status, 200);
  assert.equal(agentPanelResponse.status, 200);
  assert.equal(workspaceApiResponse.status, 200);
  assert.equal(workspaceShellResponse.status, 200);
  const script = await scriptResponse.text();
  const agentApiScript = await agentApiResponse.text();
  const workspaceApiScript = await workspaceApiResponse.text();
  assert.match(script, /firefly\.workId/u);
  assert.match(script, /\.\/agent-api\.js/u);
  assert.match(script, /\.\/workspace-api\.js/u);
  assert.match(agentApiScript, /messages-stream/u);
  assert.match(await agentPanelResponse.text(), /bindAgentPanel/u);
  assert.match(workspaceApiScript, /generateStrategy/u);
  assert.match(await workspaceShellResponse.text(), /bindWorkspaceShell/u);
  assert.match(script, /读取车型事实快照/u);
  assert.match(script, /function renderMarkdown/u);
  assert.match(script, /markdown-table-wrap/u);
  assert.match(script, /function restoreTranscriptTimeline/u);
  assert.match(script, /思考完成 · 历史记录/u);
  assert.match(script, /function executeActionProposal/u);
  assert.match(script, /确认生成策略/u);
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

test("streaming message endpoint emits lifecycle events and a completion payload", async (context) => {
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(testConfig));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "session_stream_test" }),
  });
  const response = await fetch(`${baseUrl}/v1/sessions/session_stream_test/messages-stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "流式测试" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/u);
  const stream = await response.text();
  assert.match(stream, /event: runtime\ndata: \{"type":"agent_start","occurredAt":"[^"]+"\}/u);
  assert.match(stream, /"type":"text_delta"/u);
  assert.match(stream, /event: complete/u);
  assert.match(stream, /"assistantText":"本地 Mock Agent 已收到：流式测试/u);
  assert.doesNotMatch(stream, /"events":/u);
});

test("DeepSeek stays selected while a missing server key blocks model calls with 503", async (context) => {
  const deepseekConfig: LocalAgentConfig = {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    thinkingLevel: "medium",
    persistSessions: false,
    dataDirectory: ".data/test-sessions",
  };
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(deepseekConfig));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const meta = (await (await fetch(`${baseUrl}/v1/meta`)).json()) as {
    model: { provider: string; modelId: string; credentialsConfigured: boolean };
  };
  assert.deepEqual(meta.model, {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    thinkingLevel: "medium",
    persistSessions: false,
    credentialsConfigured: false,
  });

  await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "session_missing_deepseek_key" }),
  });
  const response = await fetch(`${baseUrl}/v1/sessions/session_missing_deepseek_key/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "不要产生计费请求" }),
  });
  assert.equal(response.status, 503);
  const error = (await response.json()) as { code: string; charged: boolean; message: string };
  assert.equal(error.code, "AIC-AGENT-CREDENTIALS_MISSING");
  assert.equal(error.charged, false);
  assert.match(error.message, /DEEPSEEK_API_KEY/u);
});
