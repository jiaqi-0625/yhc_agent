import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { LocalAgentCredentialsError, LocalAgentRuntime } from "@firefly/agent";
import { RevisionConflictError } from "@firefly/domain";
import {
  CopyWorkRequestSchema,
  CreateWorkRequestSchema,
  GenerateStrategyRequestSchema,
  StrategyApprovalRequestSchema,
  StrategyDecisionRequestSchema,
  UpdateStrategyRequestSchema,
} from "@firefly/schemas";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { BusinessRuntimeError, LocalBusinessRuntime } from "./business-runtime.ts";
import { createBusinessAgentRuntime } from "./business-agent-runtime.ts";

const version = "0.1.0";
const maximumBodyBytes = 64 * 1024;
const webAssets = new Map<string, { path: string; type: string }>([
  ["/", { path: fileURLToPath(new URL("../../web/public/index.html", import.meta.url)), type: "text/html; charset=utf-8" }],
  ["/app.css", { path: fileURLToPath(new URL("../../web/public/app.css", import.meta.url)), type: "text/css; charset=utf-8" }],
  ["/app.js", { path: fileURLToPath(new URL("../../web/public/app.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
]);

async function sendWebAsset(response: ServerResponse, pathname: string): Promise<boolean> {
  const asset = webAssets.get(pathname);
  if (!asset) return false;
  const content = await readFile(asset.path);
  response.writeHead(200, {
    "content-type": asset.type,
    "content-length": content.byteLength,
    "cache-control": pathname === "/" ? "no-store" : "public, max-age=300",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(content);
  return true;
}

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

function sendEvent(response: ServerResponse, event: string, data: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

function workRoute(pathname: string): { workId: string; action?: string } | undefined {
  const match = pathname.match(/^\/v1\/works\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/u);
  if (!match?.[1]) return undefined;
  const resource = match[2];
  const nestedAction = match[3];
  return {
    workId: decodeURIComponent(match[1]),
    ...(resource === undefined
      ? {}
      : { action: resource === "strategy" ? (nestedAction ?? "strategy") : resource }),
  };
}

function validateBody<T>(schema: TSchema, body: Record<string, unknown>): T {
  if (!Value.Check(schema, body)) {
    const first = [...Value.Errors(schema, body)][0];
    throw new BusinessRuntimeError(
      "AIC-API-SCHEMA_INVALID",
      first ? `请求数据不符合 Schema：${first.message}` : "请求数据不符合 Schema。",
      400,
    );
  }
  return body as T;
}

function errorStatus(error: Error): number {
  if (error instanceof BusinessRuntimeError) return error.statusCode;
  if (error instanceof LocalAgentCredentialsError) return 503;
  if (error instanceof RevisionConflictError) return 409;
  if (error.message.includes("was not found")) return 404;
  if (error.message.includes("already exists") || error.message.includes("already running")) return 409;
  return 400;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: LocalAgentRuntime,
  business: LocalBusinessRuntime,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && (await sendWebAsset(response, url.pathname))) return;
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "firefly-ad-agent-api", version });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/meta") {
    sendJson(response, 200, {
      service: "firefly-ad-agent-api",
      version,
      maturity: "strategy-vertical-slice",
      capabilities: [
        "local_chat",
        "streaming_chat",
        "session_persistence",
        "lifecycle_events",
        "request_cancellation",
        "vehicle_snapshot",
        "strategy_draft",
        "human_strategy_approval",
        "work_bound_agent",
      ],
      domainTools: [
        "get_vehicle_snapshot",
        "validate_vehicle_claims",
        "propose_strategy_generation",
        "validate_strategy",
        "propose_strategy_approval",
      ],
      agentDomainToolsLoaded: runtime.domainToolsAvailable,
      model: runtime.publicConfig(),
      boundaries: {
        publishesAds: false,
        modelCanApprove: false,
        genericToolsEnabled: false,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/works") {
    sendJson(response, 200, { works: await business.listWorks() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/works") {
    const body = validateBody<Parameters<LocalBusinessRuntime["createWork"]>[0]>(
      CreateWorkRequestSchema,
      await readJson(request),
    );
    sendJson(response, 201, await business.createWork(body));
    return;
  }

  const work = workRoute(url.pathname);
  if (work && request.method === "GET" && work.action === undefined) {
    sendJson(response, 200, await business.getWork(work.workId));
    return;
  }
  if (work && request.method === "POST" && work.action === "copy") {
    const body = validateBody<{ expectedRevision: number }>(CopyWorkRequestSchema, await readJson(request));
    sendJson(response, 201, await business.copyApprovedWork(work.workId, body.expectedRevision));
    return;
  }
  if (work && request.method === "POST" && work.action === "generate") {
    const body = validateBody<Parameters<LocalBusinessRuntime["generateStrategy"]>[1]>(
      GenerateStrategyRequestSchema,
      await readJson(request),
    );
    sendJson(response, 200, await business.generateStrategy(work.workId, body));
    return;
  }
  if (work && request.method === "PATCH" && work.action === "strategy") {
    const body = validateBody<Parameters<LocalBusinessRuntime["updateStrategy"]>[1]>(
      UpdateStrategyRequestSchema,
      await readJson(request),
    );
    sendJson(response, 200, await business.updateStrategy(work.workId, body));
    return;
  }
  if (work && request.method === "POST" && work.action === "approval-request") {
    const body = validateBody<{ expectedRevision: number }>(StrategyApprovalRequestSchema, await readJson(request));
    sendJson(response, 200, await business.requestStrategyApproval(work.workId, body.expectedRevision));
    return;
  }
  if (work && request.method === "POST" && work.action === "decision") {
    const body = validateBody<Parameters<LocalBusinessRuntime["decideStrategy"]>[1]>(
      StrategyDecisionRequestSchema,
      await readJson(request),
    );
    sendJson(response, 200, await business.decideStrategy(work.workId, body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    const body = await readJson(request);
    if (body.id !== undefined && typeof body.id !== "string") throw new Error("Session id must be a string.");
    if (body.workId !== undefined && typeof body.workId !== "string") throw new Error("Work id must be a string.");
    const workId = body.workId as string | undefined;
    if (workId !== undefined) await business.getWork(workId);
    const session = await runtime.createSession(
      body.id as string | undefined,
      workId === undefined ? {} : { workId },
    );
    sendJson(response, 201, { session });
    return;
  }

  const route = sessionRoute(url.pathname);
  if (route && request.method === "GET" && route.action === undefined) {
    const session = await runtime.getSession(route.sessionId);
    if (!session) throw new Error(`Session '${route.sessionId}' was not found.`);
    sendJson(response, 200, { session });
    return;
  }
  if (route && request.method === "GET" && route.action === "transcript") {
    const messages = await runtime.getTranscript(route.sessionId);
    if (!messages) throw new Error(`Session '${route.sessionId}' was not found.`);
    sendJson(response, 200, { messages });
    return;
  }
  if (route && request.method === "POST" && route.action === "messages") {
    const body = await readJson(request);
    if (typeof body.message !== "string") throw new Error("Message must be a string.");
    request.once("aborted", () => void runtime.abortSession(route.sessionId));
    const result = await runtime.prompt(route.sessionId, body.message);
    sendJson(response, 200, result);
    return;
  }
  if (route && request.method === "POST" && route.action === "messages-stream") {
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
        sendEvent(response, "runtime", event);
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
    return;
  }
  if (route && request.method === "POST" && route.action === "reset") {
    sendJson(response, 200, { session: await runtime.resetSession(route.sessionId) });
    return;
  }
  if (route && request.method === "POST" && route.action === "abort") {
    sendJson(response, 202, { aborted: await runtime.abortSession(route.sessionId) });
    return;
  }
  if (route && request.method === "DELETE" && route.action === undefined) {
    await runtime.deleteSession(route.sessionId);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }

  sendJson(response, 404, {
    code: "AIC-API-NOT_FOUND",
    message: "Endpoint not found.",
    retryable: false,
    charged: false,
  });
}

export function createApiServer(
  runtime: LocalAgentRuntime | undefined = undefined,
  business = new LocalBusinessRuntime(),
): Server {
  const activeRuntime = runtime ?? createBusinessAgentRuntime(business);
  return createServer((request, response) => {
    void handleRequest(request, response, activeRuntime, business).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error("Unknown request error.");
      sendJson(response, errorStatus(normalized), {
        code:
          normalized instanceof BusinessRuntimeError ||
          normalized instanceof RevisionConflictError ||
          normalized instanceof LocalAgentCredentialsError
            ? normalized.code
            : "AIC-API-INVALID_REQUEST",
        message: normalized.message,
        retryable: false,
        charged: false,
      });
    });
  });
}

export async function startApiServer(
  port = 3100,
  host = "127.0.0.1",
  runtime: LocalAgentRuntime | undefined = undefined,
  business = new LocalBusinessRuntime(),
): Promise<Server> {
  const server = createApiServer(runtime, business);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const configuredPort = Number.parseInt(process.env.PORT ?? "3100", 10);
  const configuredHost = process.env.HOST ?? "127.0.0.1";
  const business = new LocalBusinessRuntime();
  const runtime = createBusinessAgentRuntime(business);
  const server = await startApiServer(configuredPort, configuredHost, runtime, business);
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : configuredPort;
  console.log(
    `Firefly Local Agent API listening on http://${configuredHost}:${activePort} provider=${runtime.config.provider} model=${runtime.config.modelId}`,
  );
}
