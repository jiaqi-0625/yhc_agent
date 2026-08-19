import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AssignVideoTaskOwnerRequestSchema,
  CreateVideoTaskRequestSchema,
  TakeOverVideoTaskRequestSchema,
  type AssignVideoTaskOwnerRequest,
  type CreateVideoTaskRequest,
  type TakeOverVideoTaskRequest,
} from "@firefly/schemas";

import { BusinessRuntimeError } from "./business-runtime.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";
import type { VideoTaskRuntime } from "./video-task-runtime.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

const IdentifierPath = "([A-Za-z0-9_-]{1,128})";

function matchPath(pathname: string, pattern: string): RegExpExecArray | null {
  return new RegExp(`^${pattern}$`, "u").exec(pathname);
}

function assertNoQuery(url: URL): void {
  const first = url.searchParams.keys().next();
  if (!first.done) {
    throw new BusinessRuntimeError(
      "AIC-API-QUERY_INVALID",
      `Unsupported query parameter '${first.value}'.`,
      400,
    );
  }
}

export async function handleVideoTaskRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: VideoTaskRuntime,
  sessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  const collection = matchPath(
    url.pathname,
    `/v1/workspace/batch-projects/${IdentifierPath}/video-tasks`,
  );
  const assignment = matchPath(
    url.pathname,
    `/v1/workspace/batch-projects/${IdentifierPath}/video-tasks/${IdentifierPath}/assignment`,
  );
  const takeover = matchPath(
    url.pathname,
    `/v1/workspace/batch-projects/${IdentifierPath}/video-tasks/${IdentifierPath}/takeover`,
  );
  if (!collection && !assignment && !takeover) return false;
  assertNoQuery(url);
  const session = await resolveWorkspaceSession(request, sessions);

  if (request.method === "GET" && collection?.[1]) {
    const records = await runtime.list(collection[1], session.scope);
    sendJson(response, 200, { tasks: records.map((record) => record.videoTask) });
    return true;
  }

  if (request.method === "POST" && collection?.[1]) {
    const input = validateBody<CreateVideoTaskRequest>(
      CreateVideoTaskRequestSchema,
      await readJson(request),
    );
    const result = await runtime.create(collection[1], input, session.scope);
    sendJson(response, result.replayed ? 200 : 201, {
      task: result.record.videoTask,
      replayed: result.replayed,
    });
    return true;
  }

  if (request.method === "POST" && assignment?.[1] && assignment[2]) {
    const input = validateBody<AssignVideoTaskOwnerRequest>(
      AssignVideoTaskOwnerRequestSchema,
      await readJson(request),
    );
    const result = await runtime.assign(assignment[1], assignment[2], input, session.scope);
    sendJson(response, 200, {
      task: result.videoTask,
      ownershipTransfer: result.ownershipTransfers.at(-1),
    });
    return true;
  }

  if (request.method === "POST" && takeover?.[1] && takeover[2]) {
    const input = validateBody<TakeOverVideoTaskRequest>(
      TakeOverVideoTaskRequestSchema,
      await readJson(request),
    );
    const result = await runtime.takeOver(takeover[1], takeover[2], input, session.scope);
    sendJson(response, 200, {
      task: result.videoTask,
      ownershipTransfer: result.ownershipTransfers.at(-1),
    });
    return true;
  }

  return false;
}
