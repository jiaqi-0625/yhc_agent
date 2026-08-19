import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  LocalAgentCredentialsError,
  LocalAgentRunError,
  LocalAgentRuntime,
  type LocalPromptRunObservation,
} from "@firefly/agent";

import { LocalBusinessRuntime } from "./business-runtime.ts";
import { readJson, sendEvent, sendJson, startEventStream } from "./http-boundary.ts";
import { resolveLocalTaskContext } from "./task-context.ts";

function sessionRoute(pathname: string): { sessionId: string; action?: string } | undefined {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/([^/]+))?$/u);
  if (!match?.[1]) return undefined;
  return {
    sessionId: decodeURIComponent(match[1]),
    ...(match[2] === undefined ? {} : { action: match[2] }),
  };
}

function runRoute(pathname: string): { sessionId: string; runId?: string; action?: string } | undefined {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)\/runs(?:\/([^/]+)(?:\/([^/]+))?)?$/u);
  if (!match?.[1]) return undefined;
  return {
    sessionId: decodeURIComponent(match[1]),
    ...(match[2] === undefined ? {} : { runId: decodeURIComponent(match[2]) }),
    ...(match[3] === undefined ? {} : { action: match[3] }),
  };
}

function replayCursor(request: IncomingMessage, url: URL): string | undefined {
  const queryCursor = url.searchParams.get("afterEventId") ?? undefined;
  const headerValue = request.headers["last-event-id"];
  const headerCursor = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (queryCursor !== undefined && headerCursor !== undefined && queryCursor !== headerCursor) {
    throw new LocalAgentRunError(
      "AIC-AGENT-REPLAY_CURSOR_CONFLICT",
      "Last-Event-ID and afterEventId must identify the same Agent event.",
      400,
    );
  }
  return headerCursor ?? queryCursor;
}

async function streamRunObservation(response: ServerResponse, observation: LocalPromptRunObservation): Promise<void> {
  let unsubscribe = observation.release;
  let completed = false;
  const close = () => unsubscribe();
  try {
    startEventStream(response);
    unsubscribe = observation.activate((event) => {
      sendEvent(response, "agent", event, event.eventId);
    });
    response.once("close", close);
    const outcome = await observation.outcome;
    completed = true;
    if (outcome.status === "completed") {
      const { events: _events, ...completion } = outcome.result;
      sendEvent(response, "complete", completion);
    } else {
      sendEvent(response, "error", outcome.error);
    }
  } finally {
    unsubscribe();
    response.off("close", close);
    if (!completed) observation.release();
    if (!response.writableEnded) response.end();
  }
}

export async function handleAgentRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: LocalAgentRuntime,
  business: LocalBusinessRuntime,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/v1/sessions") {
    const videoTaskId = url.searchParams.get("videoTaskId");
    if (!videoTaskId) throw new Error("Video task id is required when listing Agent sessions.");
    await resolveLocalTaskContext(business, videoTaskId);
    sendJson(response, 200, { sessions: await runtime.listSessions(videoTaskId) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    const body = await readJson(request);
    if (body.id !== undefined && typeof body.id !== "string") throw new Error("Session id must be a string.");
    if (body.videoTaskId !== undefined && typeof body.videoTaskId !== "string") {
      throw new Error("Video task id must be a string.");
    }
    if (body.workId !== undefined && typeof body.workId !== "string") throw new Error("Work id must be a string.");
    if (body.videoTaskId !== undefined && body.workId !== undefined) {
      throw new Error("Provide videoTaskId or legacy workId, not both.");
    }
    const videoTaskId = (body.videoTaskId ?? body.workId) as string | undefined;
    const taskContext = videoTaskId === undefined
      ? undefined
      : await resolveLocalTaskContext(business, videoTaskId);
    const session = await runtime.createSession(
      body.id as string | undefined,
      taskContext === undefined ? {} : { taskContext },
    );
    sendJson(response, 201, { session });
    return true;
  }

  const matchedRun = runRoute(url.pathname);
  if (matchedRun) {
    if (request.method === "POST" && matchedRun.runId === undefined) {
      const body = await readJson(request);
      if (typeof body.message !== "string") throw new Error("Message must be a string.");
      if (typeof body.requestId !== "string") throw new Error("Run request ID must be a string.");
      const run = await runtime.startPromptRun(matchedRun.sessionId, body.message, body.requestId);
      sendJson(response, 202, { run });
      return true;
    }
    if (request.method === "GET" && matchedRun.runId !== undefined && matchedRun.action === "events") {
      const observation = runtime.observePromptRun(
        matchedRun.sessionId,
        matchedRun.runId,
        replayCursor(request, url),
      );
      await streamRunObservation(response, observation);
      return true;
    }
    if (request.method === "POST" && matchedRun.runId !== undefined && matchedRun.action === "abort") {
      sendJson(response, 202, {
        aborted: await runtime.abortPromptRun(matchedRun.sessionId, matchedRun.runId),
      });
      return true;
    }
    return false;
  }

  const route = sessionRoute(url.pathname);
  if (!route) return false;
  if (request.method === "GET" && route.action === undefined) {
    const session = await runtime.getSession(route.sessionId);
    if (!session) throw new Error(`Session '${route.sessionId}' was not found.`);
    sendJson(response, 200, { session });
    return true;
  }
  if (request.method === "GET" && route.action === "transcript") {
    const messages = await runtime.getTranscript(route.sessionId);
    if (!messages) throw new Error(`Session '${route.sessionId}' was not found.`);
    sendJson(response, 200, { messages });
    return true;
  }
  if (request.method === "POST" && route.action === "messages") {
    const body = await readJson(request);
    if (typeof body.message !== "string") throw new Error("Message must be a string.");
    request.once("aborted", () => void runtime.abortSession(route.sessionId));
    sendJson(response, 200, await runtime.prompt(route.sessionId, body.message));
    return true;
  }
  if (request.method === "POST" && route.action === "messages-stream") {
    const body = await readJson(request);
    if (typeof body.message !== "string") throw new Error("Message must be a string.");
    if (body.requestId !== undefined && typeof body.requestId !== "string") {
      throw new Error("Run request ID must be a string.");
    }
    const requestId = (body.requestId as string | undefined) ?? `legacy_${randomUUID()}`;
    const run = await runtime.startPromptRun(route.sessionId, body.message, requestId);
    const observation = runtime.observePromptRun(route.sessionId, run.runId, replayCursor(request, url));
    await streamRunObservation(response, observation);
    return true;
  }
  if (request.method === "POST" && route.action === "reset") {
    sendJson(response, 200, { session: await runtime.resetSession(route.sessionId) });
    return true;
  }
  if (request.method === "POST" && route.action === "abort") {
    sendJson(response, 202, { aborted: await runtime.abortSession(route.sessionId) });
    return true;
  }
  if (request.method === "DELETE" && route.action === undefined) {
    await runtime.deleteSession(route.sessionId);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return true;
  }
  return false;
}
