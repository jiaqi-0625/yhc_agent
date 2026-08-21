import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ConfirmVideoTaskStageRequestSchema,
  RollbackVideoTaskStageRequestSchema,
  type ConfirmVideoTaskStageRequest,
  type RollbackVideoTaskStageRequest,
  type VideoTaskStage,
} from "@firefly/schemas";

import { BusinessRuntimeError } from "./business-runtime.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";
import type { VideoTaskStageRuntime } from "./video-task-stage-runtime.ts";
import type { StartVideoProductionInput, VideoProductionRuntime } from "./video-production-runtime.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";
import { Type } from "typebox";

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
const StageSimulationsPath = new RegExp(
  `^${StageRouteBase}/stages/${StagePath}/development-simulation$`,
  "u",
);
const VideoProductionPath = new RegExp(`^${StageRouteBase}/video-production$`, "u");
const VideoProductionEstimatePath = new RegExp(
  `^${StageRouteBase}/video-production/estimate$`,
  "u",
);

const StartVideoProductionInputSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
  expectedTaskRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

interface StageScopedRoute {
  projectId: string;
  videoTaskId: string;
  stage: VideoTaskStage;
}

export type VideoTaskStageRouteMatch =
  | ({ kind: "versions" } & StageScopedRoute)
  | ({ kind: "audit" } & Omit<StageScopedRoute, "stage">)
  | ({ kind: "confirmations" } & StageScopedRoute)
  | ({ kind: "development_simulation" } & StageScopedRoute)
  | ({ kind: "video_production" | "video_production_estimate" } & Omit<StageScopedRoute, "stage">)
  | ({ kind: "rollbacks" } & StageScopedRoute);

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
  const productionEstimate = VideoProductionEstimatePath.exec(pathname);
  if (productionEstimate?.[1] && productionEstimate[2]) {
    return { kind: "video_production_estimate", projectId: productionEstimate[1], videoTaskId: productionEstimate[2] };
  }
  const production = VideoProductionPath.exec(pathname);
  if (production?.[1] && production[2]) {
    return { kind: "video_production", projectId: production[1], videoTaskId: production[2] };
  }
  const versions = scopedMatch(pathname, StageVersionsPath);
  if (versions) return { kind: "versions", ...versions };

  const audit = StageAuditPath.exec(pathname);
  if (audit?.[1] && audit[2]) {
    return { kind: "audit", projectId: audit[1], videoTaskId: audit[2] };
  }

  const confirmations = scopedMatch(pathname, StageConfirmationsPath);
  if (confirmations) return { kind: "confirmations", ...confirmations };

  const simulation = scopedMatch(pathname, StageSimulationsPath);
  if (simulation) return { kind: "development_simulation", ...simulation };

  const rollbacks = scopedMatch(pathname, StageRollbacksPath);
  if (rollbacks) return { kind: "rollbacks", ...rollbacks };
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
  developmentSimulationEnabled = false,
  videoProduction?: VideoProductionRuntime,
): Promise<boolean> {
  const route = matchVideoTaskStagePath(url.pathname);
  if (!route) return false;
  assertNoQuery(url);
  const session = await resolveWorkspaceSession(request, sessions);

  if (request.method === "GET" && route.kind === "video_production_estimate") {
    if (videoProduction === undefined) return false;
    sendJson(response, 200, await videoProduction.estimate(route.projectId, route.videoTaskId, session.scope));
    return true;
  }

  if (request.method === "GET" && route.kind === "video_production") {
    if (videoProduction === undefined) return false;
    sendJson(response, 200, await videoProduction.status(route.projectId, route.videoTaskId, session.scope));
    return true;
  }

  if (request.method === "POST" && route.kind === "video_production") {
    if (videoProduction === undefined) return false;
    const input = validateBody<StartVideoProductionInput>(
      StartVideoProductionInputSchema,
      await readJson(request),
    );
    sendJson(response, 200, await videoProduction.start(
      route.projectId,
      route.videoTaskId,
      input,
      session.scope,
    ));
    return true;
  }

  if (request.method === "POST" && route.kind === "development_simulation") {
    if (!developmentSimulationEnabled) return false;
    sendJson(
      response,
      200,
      await runtime.prepareDevelopmentSimulation(
        route.projectId,
        route.videoTaskId,
        route.stage,
        session.scope,
      ),
    );
    return true;
  }

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

  return false;
}
