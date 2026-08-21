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

function agentEvents(stream: string): Array<{ eventId: string; sequence: number; runId: string; type: string }> {
  return stream.split("\n\n").flatMap((frame) => {
    const eventName = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (eventName !== "agent" || !data) return [];
    return [JSON.parse(data) as { eventId: string; sequence: number; runId: string; type: string }];
  });
}

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
    "task_context_v1",
    "project_library_v1",
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
  assert.equal(
    (await fetch(`${baseUrl}/v1/workspace/me/production-status`)).status,
    401,
  );
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
  assert.match(page, /萤火虫 · 汽车广告工作区/u);
  assert.doesNotMatch(page, /platform-sidebar/u);
  assert.match(page, /<select id="brand-navigation" aria-label="切换品牌"/u);
  assert.match(page, /切换当前账号/u);
  assert.match(page, /viewport-notice/u);
  assert.match(page, /新建广告作品/u);
  assert.match(page, /基于此车型新建作品/u);
  assert.match(page, /agent-mount-ag504-v1/u);
  assert.match(page, /type="module"/u);

  const [
    styleResponse,
    workspaceFrameStyleResponse,
    workspaceStagesStyleResponse,
    agentStyleResponse,
    scriptResponse,
    authApiResponse,
    agentApiResponse,
    agentPanelResponse,
    workspaceApiResponse,
    workspaceShellResponse,
    workspaceFrameResponse,
    workspaceAgentContextResponse,
    workspaceStagesResponse,
    projectLibraryResponse,
    projectWizardResponse,
  ] = await Promise.all([
    fetch(`${baseUrl}/app.css`),
    fetch(`${baseUrl}/workspace-frame.css`),
    fetch(`${baseUrl}/workspace-stages.css`),
    fetch(`${baseUrl}/agent-panel.css`),
    fetch(`${baseUrl}/app.js`),
    fetch(`${baseUrl}/auth-api.js`),
    fetch(`${baseUrl}/agent-api.js`),
    fetch(`${baseUrl}/agent-panel.js`),
    fetch(`${baseUrl}/workspace-api.js`),
    fetch(`${baseUrl}/workspace-shell.js`),
    fetch(`${baseUrl}/workspace-frame.js`),
    fetch(`${baseUrl}/workspace-agent-context.js`),
    fetch(`${baseUrl}/workspace-stages.js`),
    fetch(`${baseUrl}/project-library.js`),
    fetch(`${baseUrl}/project-creation-wizard.js`),
  ]);
  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get("content-type") ?? "", /^text\/css/u);
  assert.equal(workspaceFrameStyleResponse.status, 200);
  assert.match(await workspaceFrameStyleResponse.text(), /\.project-workspace-page/u);
  assert.equal(workspaceStagesStyleResponse.status, 200);
  assert.match(await workspaceStagesStyleResponse.text(), /\.production-stage-shell/u);
  assert.equal(agentStyleResponse.status, 200);
  assert.match(await agentStyleResponse.text(), /\.agent-action-card/u);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type") ?? "", /^text\/javascript/u);
  assert.equal(authApiResponse.status, 200);
  assert.equal(agentApiResponse.status, 200);
  assert.equal(agentPanelResponse.status, 200);
  assert.equal(workspaceApiResponse.status, 200);
  assert.equal(workspaceShellResponse.status, 200);
  assert.equal(workspaceFrameResponse.status, 200);
  assert.equal(workspaceAgentContextResponse.status, 200);
  assert.equal(workspaceStagesResponse.status, 200);
  assert.equal(projectLibraryResponse.status, 200);
  assert.equal(projectWizardResponse.status, 200);
  const script = await scriptResponse.text();
  const agentApiScript = await agentApiResponse.text();
  const agentPanelScript = await agentPanelResponse.text();
  const workspaceApiScript = await workspaceApiResponse.text();
  assert.match(script, /selectedVideoTaskStorageKey/u);
  assert.doesNotMatch(script, /firefly\.workId/u);
  assert.match(script, /\.\/agent-api\.js\?build=ws501-v1/u);
  assert.match(script, /\.\/agent-panel\.js\?build=ws502-v1-ag504-recovery-v1/u);
  assert.match(script, /\.\/workspace-api\.js\?build=workspace-cost-ws408-v2/u);
  assert.match(script, /\.\/project-library\.js/u);
  assert.match(script, /\.\/project-creation-wizard\.js/u);
  assert.match(script, /\.\/workspace-frame\.js\?build=workspace-cost-ws408-v2-ws501-v1-ag504-recovery-v1/u);
  assert.match(script, /\.\/workspace-agent-context\.js\?build=ws501-v1/u);
  assert.match(script, /\.\/workspace-stages\.js\?build=workspace-cost-ws408-v2/u);
  assert.match(script, /workspaceStagesPanel\?\.isBusy\(\)/u);
  assert.match(agentApiScript, /\/runs/u);
  assert.match(agentApiScript, /listSessions/u);
  assert.match(agentApiScript, /last-event-id/u);
  assert.match(agentApiScript, /seenEventIds/u);
  assert.match(agentPanelScript, /bindAgentPanel/u);
  assert.match(agentPanelScript, /abortRun/u);
  assert.match(agentPanelScript, /createAgentPanelLayoutController/u);
  assert.match(agentPanelScript, /Alt\+Shift\+A/u);
  assert.match(workspaceApiScript, /generateStrategy/u);
  assert.match(workspaceApiScript, /listAdminBrands/u);
  assert.match(workspaceApiScript, /getProjectCreationOptions/u);
  assert.match(workspaceApiScript, /createBatchProject/u);
  assert.match(workspaceApiScript, /getOwnBudget/u);
  assert.match(workspaceApiScript, /getProductionStatus/u);
  assert.match(await projectWizardResponse.text(), /createProjectRequest/u);
  const workspaceShellScript = await workspaceShellResponse.text();
  assert.match(workspaceShellScript, /bindWorkspaceShell/u);
  assert.match(workspaceShellScript, /normalizeNavigationBrands/u);
  assert.match(await workspaceFrameResponse.text(), /resolveWorkspaceSelection/u);
  assert.match(script, /读取车型事实快照/u);
  assert.match(script, /function friendlyToolInput/u);
  assert.match(script, /function friendlyToolResult/u);
  assert.match(script, /当前策略已经进入人工审核，无需重复生成/u);
  assert.doesNotMatch(script, /inputLabel\.textContent = "IN"/u);
  assert.doesNotMatch(script, /outputLabel\.textContent = "OUT"/u);
  assert.doesNotMatch(script, /绑定当前任务 · revision/u);
  assert.match(script, /function renderMarkdown/u);
  assert.match(script, /markdown-table-wrap/u);
  assert.match(script, /function restoreTranscriptTimeline/u);
  assert.match(script, /思考完成 · 历史记录/u);
  assert.match(script, /function executeActionProposal/u);
  assert.match(script, /确认生成策略/u);
  assert.match(script, /videoTaskId/u);
  assert.match(script, /cancel-generation/u);
  assert.match(page, /id="agent-resizer"/u);
  assert.match(page, /id="collapse-agent"/u);
  assert.match(page, /id="agent-session-select"/u);
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
  assert.match(stream, /id: event_[^\n]+\nevent: agent\ndata: \{[^\n]+"sequence":1,[^\n]+"type":"run_started"/u);
  assert.match(stream, /"type":"text_delta"/u);
  assert.match(stream, /"type":"message_completed"/u);
  assert.match(stream, /"type":"run_completed"/u);
  assert.match(stream, /event: complete/u);
  assert.match(stream, /"assistantText":"本地 Mock Agent 已收到：流式测试/u);
  assert.doesNotMatch(stream, /"events":/u);
});

test("run endpoints start idempotently and replay strictly after Last-Event-ID", async (context) => {
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(testConfig));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "session_run_replay_test" }),
  });
  const start = () => fetch(`${baseUrl}/v1/sessions/session_run_replay_test/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "只运行一次并支持续传", requestId: "request_api_replay" }),
  });
  const firstStart = await start();
  assert.equal(firstStart.status, 202);
  const firstBody = (await firstStart.json()) as { run: { runId: string } };
  const duplicateStart = await start();
  assert.equal(duplicateStart.status, 202);
  const duplicateBody = (await duplicateStart.json()) as { run: { runId: string } };
  assert.equal(duplicateBody.run.runId, firstBody.run.runId);

  const initialResponse = await fetch(
    `${baseUrl}/v1/sessions/session_run_replay_test/runs/${encodeURIComponent(firstBody.run.runId)}/events`,
  );
  assert.equal(initialResponse.status, 200);
  const initialStream = await initialResponse.text();
  const initialEvents = agentEvents(initialStream);
  assert.ok(initialEvents.length > 4);
  assert.deepEqual(initialEvents.map((event) => event.sequence), initialEvents.map((_event, index) => index + 1));
  const cursor = initialEvents[1]?.eventId;
  assert.ok(cursor);

  const replayResponse = await fetch(
    `${baseUrl}/v1/sessions/session_run_replay_test/runs/${encodeURIComponent(firstBody.run.runId)}/events`,
    { headers: { "last-event-id": cursor } },
  );
  assert.equal(replayResponse.status, 200);
  const replayStream = await replayResponse.text();
  const replayed = agentEvents(replayStream);
  assert.deepEqual(
    replayed.map((event) => event.eventId),
    initialEvents.slice(2).map((event) => event.eventId),
  );
  assert.match(replayStream, /event: complete/u);

  const transcript = await fetch(`${baseUrl}/v1/sessions/session_run_replay_test/transcript`);
  const transcriptBody = (await transcript.json()) as { messages: unknown[] };
  assert.equal(transcriptBody.messages.length, 2);
});

test("run endpoints reject conflicting request IDs and invalid replay cursors without rerunning", async (context) => {
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(testConfig));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "session_run_invalid_test" }),
  });
  const startResponse = await fetch(`${baseUrl}/v1/sessions/session_run_invalid_test/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "原始消息", requestId: "request_api_conflict" }),
  });
  const startBody = (await startResponse.json()) as { run: { runId: string } };
  const conflict = await fetch(`${baseUrl}/v1/sessions/session_run_invalid_test/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "不同消息", requestId: "request_api_conflict" }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { code: string }).code, "AIC-AGENT-RUN_REQUEST_CONFLICT");

  const invalidCursor = await fetch(
    `${baseUrl}/v1/sessions/session_run_invalid_test/runs/${encodeURIComponent(startBody.run.runId)}/events`,
    { headers: { "last-event-id": "event_not_in_this_run" } },
  );
  assert.equal(invalidCursor.status, 409);
  assert.equal(((await invalidCursor.json()) as { code: string }).code, "AIC-AGENT-REPLAY_CURSOR_INVALID");
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
