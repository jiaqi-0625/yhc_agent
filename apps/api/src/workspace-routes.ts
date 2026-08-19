import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CopyWorkRequestSchema,
  CreateWorkRequestSchema,
  GenerateStrategyRequestSchema,
  StrategyApprovalRequestSchema,
  StrategyDecisionRequestSchema,
  UpdateStrategyRequestSchema,
} from "@firefly/schemas";

import { LocalBusinessRuntime } from "./business-runtime.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";

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

export async function handleWorkspaceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  business: LocalBusinessRuntime,
  legacyLocalAccessEnabled: boolean,
): Promise<boolean> {
  if (url.pathname.startsWith("/v1/works") && !legacyLocalAccessEnabled) return false;
  if (request.method === "GET" && url.pathname === "/v1/works") {
    sendJson(response, 200, { works: await business.listWorks() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/v1/works") {
    const body = validateBody<Parameters<LocalBusinessRuntime["createWork"]>[0]>(
      CreateWorkRequestSchema,
      await readJson(request),
    );
    sendJson(response, 201, await business.createWork(body));
    return true;
  }

  const work = workRoute(url.pathname);
  if (!work) return false;

  if (request.method === "GET" && work.action === undefined) {
    sendJson(response, 200, await business.getWork(work.workId));
    return true;
  }
  if (request.method === "POST" && work.action === "copy") {
    const body = validateBody<{ expectedRevision: number }>(CopyWorkRequestSchema, await readJson(request));
    sendJson(response, 201, await business.copyApprovedWork(work.workId, body.expectedRevision));
    return true;
  }
  if (request.method === "POST" && work.action === "generate") {
    const body = validateBody<Parameters<LocalBusinessRuntime["generateStrategy"]>[1]>(
      GenerateStrategyRequestSchema,
      await readJson(request),
    );
    sendJson(response, 200, await business.generateStrategy(work.workId, body));
    return true;
  }
  if (request.method === "PATCH" && work.action === "strategy") {
    const body = validateBody<Parameters<LocalBusinessRuntime["updateStrategy"]>[1]>(
      UpdateStrategyRequestSchema,
      await readJson(request),
    );
    sendJson(response, 200, await business.updateStrategy(work.workId, body));
    return true;
  }
  if (request.method === "POST" && work.action === "approval-request") {
    const body = validateBody<{ expectedRevision: number }>(StrategyApprovalRequestSchema, await readJson(request));
    sendJson(response, 200, await business.requestStrategyApproval(work.workId, body.expectedRevision));
    return true;
  }
  if (request.method === "POST" && work.action === "decision") {
    const body = validateBody<Parameters<LocalBusinessRuntime["decideStrategy"]>[1]>(
      StrategyDecisionRequestSchema,
      await readJson(request),
    );
    sendJson(response, 200, await business.decideStrategy(work.workId, body));
    return true;
  }
  return false;
}
