import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { agentApi } from "../public/agent-api.js";
// @ts-expect-error The browser module is intentionally plain JavaScript.
import { setWorkspaceSessionToken } from "../public/api-client.js";

function sseAgent(event: { eventId: string; sequence: number; sessionId: string; runId: string; type: string }): string {
  return `id: ${event.eventId}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseComplete(runId: string): string {
  return `event: complete\ndata: ${JSON.stringify({ runId, assistantText: "完成", session: { id: "session_web_replay" } })}\n\n`;
}

test("browser Agent API authenticates run start, SSE reconnects, and cancellation without replaying events", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
    setWorkspaceSessionToken(null);
  });
  setWorkspaceSessionToken("workspace_session_web_replay");
  const runId = "run_web_replay";
  const first = {
    schemaVersion: 1,
    eventId: `event_${runId}_1`,
    sequence: 1,
    sessionId: "session_web_replay",
    runId,
    type: "run_started",
    occurredAt: "2026-08-19T00:00:00.000Z",
  };
  const second = {
    ...first,
    eventId: `event_${runId}_2`,
    sequence: 2,
    type: "run_completed",
  };
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  let eventConnections = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (new URL(url, "http://local").pathname.endsWith("/runs") && init?.method === "POST") {
      return Response.json({ run: { runId, requestId: "request_web_replay", sessionId: "session_web_replay" } }, { status: 202 });
    }
    if (new URL(url, "http://local").pathname.endsWith("/abort") && init?.method === "POST") {
      return Response.json({ run: { runId, state: "cancelled" } });
    }
    eventConnections += 1;
    if (eventConnections === 1) {
      return new Response(sseAgent(first), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(sseAgent(first) + sseAgent(second) + sseComplete(runId), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const sequences: number[] = [];
  const result = await agentApi.streamMessage("session_web_replay", "续传测试", {
    requestId: "request_web_replay",
    videoTaskId: "video_task_web_replay",
    maximumReconnects: 2,
    onEvent: (event: { sequence: number }) => sequences.push(event.sequence),
  });

  assert.equal(result.runId, runId);
  assert.deepEqual(sequences, [1, 2]);
  assert.equal(eventConnections, 2);
  assert.equal(requests[2]?.headers["last-event-id"], first.eventId);
  await agentApi.abortRun("session_web_replay", runId, "video_task_web_replay");
  assert.equal(requests[3]?.method, "POST");
  assert.ok(requests[3]?.url.endsWith("/abort?videoTaskId=video_task_web_replay"));
  assert.ok(requests.every((request) => request.headers.authorization === "Bearer workspace_session_web_replay"));
  assert.ok(requests.every((request) => request.url.includes("videoTaskId=video_task_web_replay")));
  const startBody = JSON.parse(requests[0]?.body ?? "{}") as { requestId?: string };
  assert.equal(startBody.requestId, "request_web_replay");
});

test("browser Agent API rejects a replay sequence gap", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const runId = "run_web_gap";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url, "http://local").pathname.endsWith("/runs") && init?.method === "POST") {
      return Response.json({ run: { runId } }, { status: 202 });
    }
    return new Response(sseAgent({
      eventId: `event_${runId}_2`,
      sequence: 2,
      sessionId: "session_web_gap",
      runId,
      type: "run_completed",
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  await assert.rejects(
    () => agentApi.streamMessage("session_web_gap", "缺口测试", {
      requestId: "request_web_gap",
      videoTaskId: "video_task_web_gap",
      maximumReconnects: 0,
    }),
    /事件流出现缺口/u,
  );
});

test("browser Agent API stops start retries when the request is cancelled", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError("offline");
  }) as typeof fetch;
  const controller = new AbortController();

  await assert.rejects(
    () => agentApi.startRun("session_cancel_retry", "取消重试", "request_cancel_retry", {
      videoTaskId: "video_task_cancel_retry",
      signal: controller.signal,
      onConnectionState: (state: string) => {
        if (state === "reconnecting") controller.abort();
      },
    }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(calls, 1);
});

test("browser Agent API sends authenticated workspace commands without changing the body", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
    setWorkspaceSessionToken(null);
  });
  setWorkspaceSessionToken("session_agent_command");
  const body = {
    requestId: "request_agent_command",
    card: {
      schemaVersion: 1,
      kind: "agent_action_card",
      videoTaskId: "video_task_agent_command",
      action: "generate_strategy",
      label: "生成卖点策略草稿",
      summary: "保持请求体原样发送。",
      expectedRevision: 3,
      cost: { kind: "free" },
      payload: { schemaVersion: 1, audience: "家庭用户", theme: "周末出行" },
    },
  };
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json({ replayed: false });
  }) as typeof fetch;

  assert.deepEqual(
    await agentApi.executeCommand("batch_project-agent_1", "video_task_agent_command", body),
    { replayed: false },
  );
  assert.equal(
    capturedUrl,
    "/v1/workspace/batch-projects/batch_project-agent_1/video-tasks/video_task_agent_command/commands",
  );
  assert.equal(capturedInit?.method, "POST");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer session_agent_command");
  assert.equal(capturedInit?.body, JSON.stringify(body));
});

test("browser Agent API rejects invalid workspace command identifiers before fetch", (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({});
  }) as typeof fetch;

  assert.throws(
    () => agentApi.executeCommand("../project_other", "video_task_agent_command", {}),
    /项目 ID.*标识符/u,
  );
  assert.throws(
    () => agentApi.executeCommand("batch_project_agent_command", "video/task_other", {}),
    /视频任务 ID.*标识符/u,
  );
  assert.equal(calls, 0);
});

test("browser Agent API loads only the current session budget view", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let requestUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestUrl = String(input);
    return Response.json({ budget: undefined });
  }) as typeof fetch;

  assert.deepEqual(await agentApi.getOwnBudget(), {});
  assert.equal(requestUrl, "/v1/workspace/me/budget");
});
