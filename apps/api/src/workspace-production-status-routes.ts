import type { IncomingMessage, ServerResponse } from "node:http";

import { BusinessRuntimeError } from "./business-runtime.ts";
import { sendJson } from "./http-boundary.ts";
import type { AccountRunLockRuntime } from "./account-run-lock-runtime.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

export const WorkspaceProductionStatusPath = "/v1/workspace/me/production-status";

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

export async function handleWorkspaceProductionStatusRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: AccountRunLockRuntime,
  sessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== WorkspaceProductionStatusPath) return false;
  assertNoQuery(url);
  const session = await resolveWorkspaceSession(request, sessions);
  const lock = await runtime.loadForAccount(
    session.scope.tenantId,
    session.scope.actorAccountId,
  );
  sendJson(response, 200, {
    runLock: lock === undefined
      ? null
      : {
          batchProjectId: lock.batchProjectId,
          videoTaskId: lock.videoTaskId,
          taskRevision: lock.taskRevision,
          operation: lock.operation,
          acquiredAt: lock.acquiredAt,
        },
  });
  return true;
}
