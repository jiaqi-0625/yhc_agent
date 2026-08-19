import type { IncomingMessage, ServerResponse } from "node:http";

import { BusinessRuntimeError } from "./business-runtime.ts";
import { sendJson } from "./http-boundary.ts";
import type { ProjectLibraryRuntime } from "./project-library-runtime.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

export const ProjectLibraryPath = "/v1/workspace/project-library";

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

export async function handleProjectLibraryRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: ProjectLibraryRuntime,
  sessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  if (url.pathname !== ProjectLibraryPath) return false;
  if (request.method !== "GET") return false;
  assertNoQuery(url);
  const session = await resolveWorkspaceSession(request, sessions);
  sendJson(response, 200, { projects: await runtime.list(session.scope) });
  return true;
}
