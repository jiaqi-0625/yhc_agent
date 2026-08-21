import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Type } from "typebox";

import { BusinessRuntimeError } from "./business-runtime.ts";
import type { GeneratedVideoArtifactImporter } from "./generated-video-artifact-importer.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";
import type { ComposeVideoGenerationInput, StartVideoGenerationInput, VideoGenerationRuntime } from "./video-generation-runtime.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

const Identifier = "([A-Za-z0-9_-]{1,128})";
const Base = `/v1/workspace/batch-projects/${Identifier}/video-tasks/${Identifier}/video-generations`;
const CollectionPath = new RegExp(`^${Base}$`, "u");
const EstimatePath = new RegExp(`^${Base}/estimate$`, "u");
const CompositionPath = new RegExp(`^${Base}/composition$`, "u");
const JobPath = new RegExp(`^${Base}/${Identifier}$`, "u");
const MediaPath = new RegExp(`^/v1/workspace/video-generations/${Identifier}/media$`, "u");
const CompositeMediaPath = new RegExp(`^/v1/workspace/video-generations/${Identifier}/composite-media$`, "u");

const StartVideoGenerationSchema = Type.Object({
  requestId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
  expectedTaskRevision: Type.Integer({ minimum: 1 }),
  shotIndex: Type.Integer({ minimum: 0, maximum: 20 }),
}, { additionalProperties: false });

const ComposeVideoGenerationSchema = Type.Object({
  requestId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
  expectedTaskRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

function assertNoQuery(url: URL): void {
  if (!url.searchParams.keys().next().done) {
    throw new BusinessRuntimeError("AIC-API-QUERY_INVALID", "Video generation routes do not accept query parameters.", 400);
  }
}

export function matchesVideoGenerationRoute(pathname: string): boolean {
  return CollectionPath.test(pathname) || EstimatePath.test(pathname) || CompositionPath.test(pathname)
    || JobPath.test(pathname) || MediaPath.test(pathname) || CompositeMediaPath.test(pathname);
}

export async function handleVideoGenerationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: VideoGenerationRuntime,
  sessions: WorkspaceSessionRuntime,
  artifacts: GeneratedVideoArtifactImporter,
): Promise<boolean> {
  const compositeMedia = CompositeMediaPath.exec(url.pathname);
  if (compositeMedia?.[1]) {
    if (request.method !== "GET") return false;
    assertNoQuery(url);
    const session = await resolveWorkspaceSession(request, sessions);
    const record = await runtime.compositeMedia(compositeMedia[1], session.scope);
    const path = artifacts.resolveStoragePath(record.compositeOutput!.storageKey);
    const file = await stat(path);
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": String(file.size),
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${record.id}-complete.mp4"`,
      "x-content-type-options": "nosniff",
    });
    createReadStream(path).pipe(response);
    return true;
  }
  const media = MediaPath.exec(url.pathname);
  if (media?.[1]) {
    if (request.method !== "GET") return false;
    assertNoQuery(url);
    const session = await resolveWorkspaceSession(request, sessions);
    const record = await runtime.media(media[1], session.scope);
    const path = artifacts.resolveStoragePath(record.output!.storageKey);
    const file = await stat(path);
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": String(file.size),
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${record.id}.mp4"`,
      "x-content-type-options": "nosniff",
    });
    createReadStream(path).pipe(response);
    return true;
  }

  const estimate = EstimatePath.exec(url.pathname);
  const composition = CompositionPath.exec(url.pathname);
  const collection = CollectionPath.exec(url.pathname);
  const job = JobPath.exec(url.pathname);
  if (!estimate && !composition && !collection && !job) return false;
  assertNoQuery(url);
  const session = await resolveWorkspaceSession(request, sessions);

  if (request.method === "GET" && estimate?.[1] && estimate[2]) {
    sendJson(response, 200, await runtime.estimate(estimate[1], estimate[2], session.scope));
    return true;
  }
  if (request.method === "POST" && composition?.[1] && composition[2]) {
    const input = validateBody<ComposeVideoGenerationInput>(ComposeVideoGenerationSchema, await readJson(request));
    sendJson(response, 200, await runtime.compose(composition[1], composition[2], input, session.scope));
    return true;
  }
  if (request.method === "POST" && collection?.[1] && collection[2]) {
    const input = validateBody<StartVideoGenerationInput>(StartVideoGenerationSchema, await readJson(request));
    sendJson(response, 202, await runtime.start(collection[1], collection[2], input, session.scope));
    return true;
  }
  if (request.method === "GET" && collection?.[1] && collection[2]) {
    sendJson(response, 200, await runtime.latest(collection[1], collection[2], session.scope));
    return true;
  }
  if (request.method === "GET" && job?.[1] && job[2] && job[3]) {
    sendJson(response, 200, await runtime.get(job[1], job[2], job[3], session.scope));
    return true;
  }
  return false;
}
