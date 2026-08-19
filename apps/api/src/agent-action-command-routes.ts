import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ExecuteAgentActionRequestSchema,
  type ExecuteAgentActionRequest,
} from "@firefly/schemas";

import type { AgentActionCommandRuntime } from "./agent-action-command-runtime.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

const IdentifierPath = "([A-Za-z0-9_-]{1,128})";
const CommandPath = new RegExp(
  `^/v1/workspace/batch-projects/${IdentifierPath}/video-tasks/${IdentifierPath}/commands$`,
  "u",
);

export function matchAgentActionCommandPath(
  pathname: string,
): { projectId: string; videoTaskId: string } | undefined {
  const match = CommandPath.exec(pathname);
  if (!match?.[1] || !match[2]) return undefined;
  return { projectId: match[1], videoTaskId: match[2] };
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

export async function handleAgentActionCommandRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: AgentActionCommandRuntime,
  sessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  const scope = matchAgentActionCommandPath(url.pathname);
  if (!scope) return false;
  assertNoQuery(url);
  if (request.method !== "POST") return false;

  const session = await resolveWorkspaceSession(request, sessions);
  const input = validateBody<ExecuteAgentActionRequest>(
    ExecuteAgentActionRequestSchema,
    await readJson(request),
  );
  const result = await runtime.execute(
    scope.projectId,
    scope.videoTaskId,
    input,
    session.scope,
  );
  sendJson(response, 200, result);
  return true;
}
