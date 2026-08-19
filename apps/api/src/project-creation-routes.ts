import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CreateBatchProjectRequestSchema,
  type AssetCategory,
  type CreateBatchProjectRequest,
} from "@firefly/schemas";

import { BusinessRuntimeError } from "./business-runtime.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";
import type { ProjectCreationRuntime } from "./project-creation-runtime.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

const IdentifierPath = "([A-Za-z0-9_-]{1,128})";

function matchPath(pathname: string, pattern: string): RegExpExecArray | null {
  return new RegExp(`^${pattern}$`, "u").exec(pathname);
}

function assertQueryKeys(url: URL, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key)) {
      throw new BusinessRuntimeError(
        "AIC-API-QUERY_INVALID",
        `Unsupported query parameter '${key}'.`,
        400,
      );
    }
  }
}

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^[0-9]+$/u.test(value)) return Number.NaN;
  return Number.parseInt(value, 10);
}

export async function handleProjectCreationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: ProjectCreationRuntime,
  sessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  const isCreationQuery = url.pathname.startsWith("/v1/workspace/project-creation/");
  const isCreationCommand = url.pathname === "/v1/workspace/batch-projects";
  if (!isCreationQuery && !isCreationCommand) return false;
  const session = await resolveWorkspaceSession(request, sessions);

  if (request.method === "GET" && url.pathname === "/v1/workspace/project-creation/options") {
    assertQueryKeys(url, []);
    sendJson(response, 200, await runtime.getOptions(session.scope));
    return true;
  }

  const assetPackage = matchPath(
    url.pathname,
    `/v1/workspace/project-creation/vehicles/${IdentifierPath}/asset-package`,
  );
  if (request.method === "GET" && assetPackage?.[1]) {
    assertQueryKeys(url, []);
    sendJson(response, 200, await runtime.getAssetPackage(assetPackage[1], session.scope));
    return true;
  }

  const configuration = matchPath(
    url.pathname,
    `/v1/workspace/project-creation/vehicles/${IdentifierPath}/configuration`,
  );
  if (request.method === "GET" && configuration?.[1]) {
    assertQueryKeys(url, []);
    sendJson(response, 200, await runtime.getConfiguration(configuration[1], session.scope));
    return true;
  }

  const companyAssets = matchPath(
    url.pathname,
    `/v1/workspace/project-creation/vehicles/${IdentifierPath}/company-assets`,
  );
  if (request.method === "GET" && companyAssets?.[1]) {
    assertQueryKeys(url, ["category", "searchText", "tag", "cursor", "limit"]);
    const categories = url.searchParams.getAll("category") as AssetCategory[];
    const tags = url.searchParams.getAll("tag");
    const searchText = url.searchParams.get("searchText") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    sendJson(response, 200, await runtime.searchReplacementAssets(
      companyAssets[1],
      {
        ...(categories.length === 0 ? {} : { categories }),
        ...(searchText === undefined ? {} : { searchText }),
        ...(tags.length === 0 ? {} : { tags }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: parseLimit(url.searchParams.get("limit")),
      },
      session.scope,
    ));
    return true;
  }

  if (request.method === "POST" && isCreationCommand) {
    assertQueryKeys(url, []);
    const input = validateBody<CreateBatchProjectRequest>(
      CreateBatchProjectRequestSchema,
      await readJson(request),
    );
    const result = await runtime.create(input, session.scope);
    sendJson(response, result.replayed ? 200 : 201, {
      project: result.project,
      assetPool: result.assetPool,
      vehicleFactSource: result.vehicleFactSource,
      replayed: result.replayed,
    });
    return true;
  }

  return false;
}
