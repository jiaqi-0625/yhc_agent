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
import { handleAgentRoute } from "./agent-routes.ts";

const version = "0.1.0";
const maximumBodyBytes = 64 * 1024;
const webAssets = new Map<string, { path: string; type: string }>([
  ["/", { path: fileURLToPath(new URL("../../web/public/index.html", import.meta.url)), type: "text/html; charset=utf-8" }],
  ["/app.css", { path: fileURLToPath(new URL("../../web/public/app.css", import.meta.url)), type: "text/css; charset=utf-8" }],
  ["/agent-panel.css", { path: fileURLToPath(new URL("../../web/public/agent-panel.css", import.meta.url)), type: "text/css; charset=utf-8" }],
  ["/app.js", { path: fileURLToPath(new URL("../../web/public/app.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
  ["/agent-panel.js", { path: fileURLToPath(new URL("../../web/public/agent-panel.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
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
        "task_context_v1",
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

  if (await handleAgentRoute(request, response, url, runtime, business)) return;

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
