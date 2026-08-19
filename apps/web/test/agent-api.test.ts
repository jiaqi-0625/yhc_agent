import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { agentApi } from "../public/agent-api.js";

function sseAgent(event: { eventId: string; sequence: number; sessionId: string; runId: string; type: string }): string {
  return `id: ${event.eventId}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseComplete(runId: string): string {
  return `event: complete\ndata: ${JSON.stringify({ runId, assistantText: "完成", session: { id: "session_web_replay" } })}\n\n`;
}

test("browser Agent API reconnects with the last event ID and suppresses replay duplicates", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
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
