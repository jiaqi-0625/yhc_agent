import type { IncomingMessage, ServerResponse } from "node:http";

import { LocalAgentCredentialsError, type LocalAgentRuntime } from "@firefly/agent";

import type { LocalBusinessRuntime } from "./business-runtime.ts";
import { resolveLocalTaskContext } from "./task-context.ts";

const maximumBodyBytes = 64 * 1024;

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function startEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  response.flushHeaders();
}

function sendEvent(response: ServerResponse, event: string, data: unknown, id?: string): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBodyBytes) throw new Error("Request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function sessionRoute(pathname: string): { sessionId: string; action?: string } | undefined {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/([^/]+))?$/u);
  if (!match?.[1]) return undefined;
  return {
    sessionId: decodeURIComponent(match[1]),
    ...(match[2] === undefined ? {} : { action: match[2] }),
  };
}

export async function handleAgentRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: LocalAgentRuntime,
  business: LocalBusinessRuntime,
): Promise<boolean> {
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
    startEventStream(response);
    let completed = false;
    const abort = () => {
      if (!completed) void runtime.abortSession(route.sessionId);
    };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      const result = await runtime.prompt(route.sessionId, body.message, (event) => {
        sendEvent(response, "agent", event, event.eventId);
      });
      completed = true;
      const { events: _events, ...completion } = result;
      sendEvent(response, "complete", completion);
    } catch (error) {
      completed = true;
      const normalized = error instanceof Error ? error : new Error("Unknown Agent stream error.");
      sendEvent(response, "error", {
        code: normalized instanceof LocalAgentCredentialsError ? normalized.code : "AIC-AGENT-STREAM_FAILED",
        message: normalized.message,
        retryable: false,
        charged: false,
      });
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
      if (!response.writableEnded) response.end();
    }
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
