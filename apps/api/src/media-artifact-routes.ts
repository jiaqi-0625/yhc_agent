import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CreateMediaArtifactAccessRequestSchema,
  type CreateMediaArtifactAccessRequest,
} from "@firefly/schemas";

import { BusinessRuntimeError } from "./business-runtime.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";
import type { MediaArtifactRuntime } from "./media-artifact-runtime.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

const IdentifierPath = "([A-Za-z0-9_-]{1,128})";
const MediaArtifactAccessPath = new RegExp(
  "^/v1/workspace/batch-projects/" +
    `${IdentifierPath}/video-tasks/${IdentifierPath}/media-artifacts/${IdentifierPath}/access$`,
  "u",
);

export interface MediaArtifactAccessRouteMatch {
  readonly projectId: string;
  readonly videoTaskId: string;
  readonly artifactId: string;
}

export function matchMediaArtifactAccessPath(
  pathname: string,
): MediaArtifactAccessRouteMatch | undefined {
  const match = MediaArtifactAccessPath.exec(pathname);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    projectId: match[1],
    videoTaskId: match[2],
    artifactId: match[3],
  };
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

export async function handleMediaArtifactRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: MediaArtifactRuntime,
  sessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  const route = matchMediaArtifactAccessPath(url.pathname);
  if (route === undefined) return false;
  assertNoQuery(url);
  const session = await resolveWorkspaceSession(request, sessions);
  if (request.method !== "POST") return false;
  const input = validateBody<CreateMediaArtifactAccessRequest>(
    CreateMediaArtifactAccessRequestSchema,
    await readJson(request),
  );
  sendJson(
    response,
    200,
    await runtime.createAccess(
      route.projectId,
      route.videoTaskId,
      route.artifactId,
      input.purpose,
      session.scope,
    ),
  );
  return true;
}
