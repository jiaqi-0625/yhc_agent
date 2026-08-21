import type { IncomingMessage, ServerResponse } from "node:http";

import type { WorkspaceSessionScope } from "@firefly/domain";
import {
  findMockCompanyAssetMedia,
  type MockCompanyAssetMediaManifestEntry,
} from "@firefly/tools";

import {
  type DevelopmentCompanyAssetMedia,
  type DevelopmentCompanyAssetMediaReader,
} from "./development-company-asset-media.ts";
import { sendJson } from "./http-boundary.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

const mediaPath = /^\/v1\/mock-company-assets\/([A-Za-z0-9_-]{1,128})\/versions\/([1-9][0-9]{0,8})\/thumbnail$/u;

function activeGrants(scope: Readonly<WorkspaceSessionScope>) {
  return scope.accessGrants.filter(
    (grant) =>
      grant.status === "active" &&
      grant.tenantId === scope.tenantId &&
      grant.accountId === scope.actorAccountId,
  );
}

function canReadMedia(
  scope: Readonly<WorkspaceSessionScope>,
  entry: Readonly<MockCompanyAssetMediaManifestEntry>,
): boolean {
  if (scope.tenantId !== entry.tenantId) return false;
  if (scope.role === "content_admin") {
    return activeGrants(scope).some(
      (grant) => grant.access.kind === "brand" && grant.access.brandId === entry.brandId,
    );
  }
  if (scope.role === "creator") {
    return activeGrants(scope).some(
      (grant) =>
        grant.access.kind === "vehicle_project" &&
        grant.access.brandId === entry.brandId &&
        grant.access.vehicleId === entry.vehicleId,
    );
  }
  return false;
}

function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, {
    code: "AIC-API-NOT_FOUND",
    message: "Endpoint not found.",
    retryable: false,
    charged: false,
  });
}

function sendUnavailable(response: ServerResponse): void {
  sendJson(response, 503, {
    code: "AIC-MOCK-ASSET-MEDIA_UNAVAILABLE",
    message: "The development company asset media is unavailable.",
    retryable: true,
    charged: false,
  });
}

function responseHeaders(media: {
  readonly mediaType: string;
  readonly byteSize: number;
  readonly etag: string;
}): Record<string, string | number> {
  return {
    "content-type": media.mediaType,
    "content-length": media.byteSize,
    "cache-control": "private, no-cache",
    "cross-origin-resource-policy": "same-origin",
    etag: media.etag,
    vary: "Authorization",
    "x-content-type-options": "nosniff",
  };
}

export async function handleMockCompanyAssetMediaRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  mediaStore: DevelopmentCompanyAssetMediaReader,
  workspaceSessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  const match = mediaPath.exec(url.pathname);
  if (match === null || url.search.length > 0 || request.url !== url.pathname) return false;
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const close = (): void => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abort);
  response.once("close", close);
  try {
    if (request.aborted || response.destroyed) {
      controller.abort();
      return true;
    }
    const session = await resolveWorkspaceSession(request, workspaceSessions);
    if (controller.signal.aborted || request.aborted || response.destroyed) return true;

    const assetId = match[1]!;
    const version = Number.parseInt(match[2]!, 10);
    const entry = findMockCompanyAssetMedia(assetId, version);
    if (entry === undefined || !canReadMedia(session.scope, entry)) {
      sendNotFound(response);
      return true;
    }

    let media: DevelopmentCompanyAssetMedia;
    try {
      media = await mediaStore.read(entry, controller.signal);
    } catch {
      if (controller.signal.aborted || request.aborted || response.destroyed) return true;
      sendUnavailable(response);
      return true;
    }
    if (response.destroyed || response.writableEnded) return true;
    if (request.headers["if-none-match"] === media.etag) {
      response.writeHead(304, {
        "cache-control": "private, no-cache",
        "cross-origin-resource-policy": "same-origin",
        etag: media.etag,
        vary: "Authorization",
        "x-content-type-options": "nosniff",
      });
      response.end();
      return true;
    }
    response.writeHead(200, responseHeaders(media));
    response.end(request.method === "HEAD" ? undefined : media.content);
    return true;
  } finally {
    request.off("aborted", abort);
    response.off("close", close);
  }
}


