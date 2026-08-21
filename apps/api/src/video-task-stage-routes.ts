import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ConfirmVideoTaskStageRequestSchema,
  ReopenAssetMatchingRequestSchema,
  RollbackVideoTaskStageRequestSchema,
  type ConfirmVideoTaskStageRequest,
  type ReopenAssetMatchingRequest,
  type RollbackVideoTaskStageRequest,
  type VideoTaskStage,
} from "@firefly/schemas";

import { BusinessRuntimeError } from "./business-runtime.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";
import type { VideoTaskStageRuntime } from "./video-task-stage-runtime.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

const IdentifierPath = "([A-Za-z0-9_-]{1,128})";
const StagePath = "(strategy|script|asset_matching|storyboard|video_preview|delivery)";
const StageRouteBase =
  `/v1/workspace/batch-projects/${IdentifierPath}/video-tasks/${IdentifierPath}`;

const StageVersionsPath = new RegExp(
  `^${StageRouteBase}/stages/${StagePath}/versions$`,
  "u",
);
const StageAuditPath = new RegExp(`^${StageRouteBase}/stage-invalidations$`, "u");
const StageConfirmationsPath = new RegExp(
  `^${StageRouteBase}/stages/${StagePath}/confirmations$`,
  "u",
);
const StageRollbacksPath = new RegExp(
  `^${StageRouteBase}/stages/${StagePath}/rollbacks$`,
  "u",
);
const AssetMatchingReopenPath = new RegExp(
  `^${StageRouteBase}/stages/(asset_matching)/reopen$`,
  "u",
);

interface StageScopedRoute {
  projectId: string;
  videoTaskId: string;
  stage: VideoTaskStage;
}

export type VideoTaskStageRouteMatch =
  | ({ kind: "versions" } & StageScopedRoute)
  | ({ kind: "audit" } & Omit<StageScopedRoute, "stage">)
  | ({ kind: "confirmations" } & StageScopedRoute)
  | ({ kind: "rollbacks" } & StageScopedRoute)
  | ({ kind: "reopen" } & StageScopedRoute);

function scopedMatch(
  pathname: string,
  pattern: RegExp,
): StageScopedRoute | undefined {
  const match = pattern.exec(pathname);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    projectId: match[1],
    videoTaskId: match[2],
    stage: match[3] as VideoTaskStage,
  };
}

export function matchVideoTaskStagePath(
  pathname: string,
): VideoTaskStageRouteMatch | undefined {
  const versions = scopedMatch(pathname, StageVersionsPath);
  if (versions) return { kind: "versions", ...versions };

  const audit = StageAuditPath.exec(pathname);
  if (audit?.[1] && audit[2]) {
    return { kind: "audit", projectId: audit[1], videoTaskId: audit[2] };
  }

  const confirmations = scopedMatch(pathname, StageConfirmationsPath);
  if (confirmations) return { kind: "confirmations", ...confirmations };

  const rollbacks = scopedMatch(pathname, StageRollbacksPath);
  if (rollbacks) return { kind: "rollbacks", ...rollbacks };
  const reopen = scopedMatch(pathname, AssetMatchingReopenPath);
  if (reopen) return { kind: "reopen", ...reopen };
  return undefined;
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

export async function handleVideoTaskStageRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: VideoTaskStageRuntime,
  sessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  const route = matchVideoTaskStagePath(url.pathname);
  if (!route) return false;
  assertNoQuery(url);
  const session = await resolveWorkspaceSession(request, sessions);

  if (request.method === "GET" && route.kind === "versions") {
    sendJson(
      response,
      200,
      await runtime.getStageVersions(
        route.projectId,
        route.videoTaskId,
        route.stage,
        session.scope,
      ),
    );
    return true;
  }

  if (request.method === "GET" && route.kind === "audit") {
    sendJson(
      response,
      200,
      await runtime.getStageAudit(route.projectId, route.videoTaskId, session.scope),
    );
    return true;
  }

  if (request.method === "POST" && route.kind === "confirmations") {
    const input = validateBody<ConfirmVideoTaskStageRequest>(
      ConfirmVideoTaskStageRequestSchema,
      await readJson(request),
    );
    sendJson(
      response,
      200,
      await runtime.confirmStage(
        route.projectId,
        route.videoTaskId,
        route.stage,
        input,
        session.scope,
      ),
    );
    return true;
  }

  if (request.method === "POST" && route.kind === "rollbacks") {
    const input = validateBody<RollbackVideoTaskStageRequest>(
      RollbackVideoTaskStageRequestSchema,
      await readJson(request),
    );
    sendJson(
      response,
      200,
      await runtime.rollbackStage(
        route.projectId,
        route.videoTaskId,
        route.stage,
        input,
        session.scope,
      ),
    );
    return true;
  }

  if (request.method === "POST" && route.kind === "reopen") {
    const input = validateBody<ReopenAssetMatchingRequest>(
      ReopenAssetMatchingRequestSchema,
      await readJson(request),
    );
    sendJson(
      response,
      200,
      await runtime.reopenAssetMatching(
        route.projectId,
        route.videoTaskId,
        input,
        session.scope,
      ),
    );
    return true;
  }

  return false;
}
