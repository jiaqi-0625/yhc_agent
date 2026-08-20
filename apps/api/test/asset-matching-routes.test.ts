import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";

import type { WorkspaceSessionScope } from "@firefly/domain";
import type {
  AssetReference,
  ConfirmVideoTaskStageRequest,
  VideoTaskStage,
} from "@firefly/schemas";

import {
  AssetMatchingRuntime,
  type AssetMatchingView,
} from "../src/asset-matching-runtime.ts";
import { BusinessRuntimeError } from "../src/business-runtime.ts";
import {
  handleAssetMatchingRoute,
  inspectTemporaryImage,
} from "../src/asset-matching-routes.ts";
import { sendJson, sendRequestError } from "../src/http-boundary.ts";
import {
  WorkspaceSessionRuntime,
  type WorkspaceAccessGrantProvider,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const projectId = "project_asset_matching_route";
const videoTaskId = "task_asset_matching_route";
const matchingPath =
  `/v1/workspace/batch-projects/${projectId}/video-tasks/${videoTaskId}/asset-matching`;

interface LockCall {
  projectId: string;
  videoTaskId: string;
  requestId: string;
  expectedTaskRevision: number;
  expectedProjectAssetPoolRevision: number;
  selectedAssets: AssetReference[];
  scope: WorkspaceSessionScope;
}

interface RouteFixture {
  server: Server;
  baseUrl: string;
  token: string;
  calls: LockCall[];
}

async function routeFixture(): Promise<RouteFixture> {
  const grants: WorkspaceAccessGrantProvider = {
    async listForAccount() {
      return [];
    },
  };
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-asset-matching-route-sessions", false),
    grants,
  );
  const session = await sessions.createSession("account_creator_a");
  const calls: LockCall[] = [];
  const runtime = {
    async lockSelection(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      requestId: string,
      expectedTaskRevision: number,
      expectedProjectAssetPoolRevision: number,
      selectedAssets: readonly AssetReference[],
      scope: WorkspaceSessionScope,
    ) {
      calls.push({
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        requestId,
        expectedTaskRevision,
        expectedProjectAssetPoolRevision,
        selectedAssets: structuredClone([...selectedAssets]),
        scope: structuredClone(scope),
      });
      return { locked: true, requestId };
    },
  } as unknown as AssetMatchingRuntime;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (await handleAssetMatchingRoute(request, response, url, runtime, sessions)) return;
        sendJson(response, 404, {
          code: "AIC-API-NOT_FOUND",
          message: "Endpoint not found.",
          retryable: false,
          charged: false,
        });
      } catch (error: unknown) {
        sendRequestError(response, error);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: session.sessionId,
    calls,
  };
}

function jsonAuthorization(token: string): {
  authorization: string;
  "content-type": string;
} {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("temporary upload inspection derives file facts from image bytes", () => {
  const bytes = png(1920, 1080);
  const result = inspectTemporaryImage("scene.png", bytes.toString("base64"));
  assert.deepEqual(result, {
    fileName: "scene.png",
    mediaType: "image/png",
    byteSize: bytes.length,
    width: 1920,
    height: 1080,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  });
});

test("temporary upload inspection rejects non-image bytes and malformed encoding", () => {
  for (const value of ["not base64", Buffer.from("forged").toString("base64")]) {
    assert.throws(
      () => inspectTemporaryImage("scene.png", value),
      BusinessRuntimeError,
    );
  }
});

test("asset-matching POST requires the canonical revisions and forwards only the authenticated scope", async (context) => {
  const fixture = await routeFixture();
  context.after(() => fixture.server.close());
  const selectedAssets = [
    {
      assetId: "asset_person_driver",
      version: 2,
      category: "person",
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
    },
    {
      assetId: "temporary_scene_city",
      version: 1,
      category: "scene",
      source: "local_upload",
      batchProjectId: projectId,
      checksumSha256: "a".repeat(64),
    },
  ] satisfies AssetReference[];
  const input = {
    requestId: "asset_confirmation_request_1",
    expectedTaskRevision: 11,
    expectedProjectAssetPoolRevision: 7,
    selectedAssets,
  };
  const url = `${fixture.baseUrl}${matchingPath}`;

  const response = await fetch(url, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    locked: true,
    requestId: input.requestId,
  });
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0], {
    projectId,
    videoTaskId,
    requestId: input.requestId,
    expectedTaskRevision: input.expectedTaskRevision,
    expectedProjectAssetPoolRevision: input.expectedProjectAssetPoolRevision,
    selectedAssets,
    scope: {
      actorAccountId: "account_creator_a",
      tenantId: "tenant_firefly",
      role: "creator",
      accessGrants: [],
    },
  });

  for (const required of [
    "requestId",
    "expectedTaskRevision",
    "expectedProjectAssetPoolRevision",
  ] as const) {
    const invalid: Record<string, unknown> = { ...input };
    delete invalid[required];
    const rejected = await fetch(url, {
      method: "POST",
      headers: jsonAuthorization(fixture.token),
      body: JSON.stringify(invalid),
    });
    assert.equal(rejected.status, 400, `missing ${required}`);
    assert.equal(
      ((await rejected.json()) as { code: string }).code,
      "AIC-API-SCHEMA_INVALID",
    );
  }
  const legacyNestedRevision = await fetch(url, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify({
      requestId: input.requestId,
      expectedTaskRevision: input.expectedTaskRevision,
      assetSelection: {
        expectedProjectAssetPoolRevision: input.expectedProjectAssetPoolRevision,
        selectedAssets,
      },
    }),
  });
  assert.equal(legacyNestedRevision.status, 400);
  assert.equal(fixture.calls.length, 1);
});

function forbiddenDependency(label: string): never {
  return new Proxy({}, {
    get() {
      throw new Error(`${label} must not be touched by the compatibility proxy`);
    },
  }) as never;
}

test("asset-matching runtime is a thin proxy over canonical stage confirmation", async () => {
  const stageCalls: Array<{
    projectId: string;
    videoTaskId: string;
    stage: VideoTaskStage;
    input: ConfirmVideoTaskStageRequest;
    scope: WorkspaceSessionScope;
  }> = [];
  const stages = {
    async confirmStage(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      stage: VideoTaskStage,
      input: ConfirmVideoTaskStageRequest,
      scope: WorkspaceSessionScope,
    ) {
      stageCalls.push({
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        stage,
        input: structuredClone(input),
        scope: structuredClone(scope),
      });
      return { canonical: true };
    },
  };
  const runtime = new AssetMatchingRuntime(
    forbiddenDependency("administration"),
    forbiddenDependency("projects"),
    forbiddenDependency("tasks"),
    forbiddenDependency("company assets"),
    forbiddenDependency("project assets"),
    forbiddenDependency("temporary assets"),
    stages as never,
  );
  const scope: WorkspaceSessionScope = {
    actorAccountId: "account_creator_a",
    tenantId: "tenant_firefly",
    role: "creator",
    accessGrants: [],
  };
  const selectedAssets: AssetReference[] = [{
    assetId: "asset_scene_city",
    version: 1,
    category: "scene",
    source: "company_catalog",
    sourceProvider: "mock_company_assets",
  }];
  const canonicalView = { matchingLocked: true } as AssetMatchingView;
  const viewCalls: Array<{ projectId: string; videoTaskId: string }> = [];
  runtime.getView = async (requestedProjectId, requestedVideoTaskId) => {
    viewCalls.push({
      projectId: requestedProjectId,
      videoTaskId: requestedVideoTaskId,
    });
    return canonicalView;
  };

  const result = await runtime.lockSelection(
    projectId,
    videoTaskId,
    "asset_confirmation_proxy_1",
    11,
    7,
    selectedAssets,
    scope,
  );

  assert.equal(result, canonicalView);
  assert.deepEqual(stageCalls, [{
    projectId,
    videoTaskId,
    stage: "asset_matching",
    input: {
      requestId: "asset_confirmation_proxy_1",
      expectedTaskRevision: 11,
      assetSelection: {
        expectedProjectAssetPoolRevision: 7,
        selectedAssets,
      },
    },
    scope,
  }]);
  assert.deepEqual(viewCalls, [{ projectId, videoTaskId }]);
});

test("asset-matching proxy cannot pre-lock when canonical confirmation is not ready", async () => {
  const notReady = new BusinessRuntimeError(
    "AIC-STAGE-CONFIRMATION_NOT_READY",
    "素材选材尚未进入待确认状态。",
    409,
  );
  let viewCalls = 0;
  const runtime = new AssetMatchingRuntime(
    forbiddenDependency("administration"),
    forbiddenDependency("projects"),
    forbiddenDependency("tasks"),
    forbiddenDependency("company assets"),
    forbiddenDependency("project assets"),
    forbiddenDependency("temporary assets"),
    {
      async confirmStage() {
        throw notReady;
      },
    } as never,
  );
  runtime.getView = async () => {
    viewCalls += 1;
    return {} as AssetMatchingView;
  };

  await assert.rejects(
    runtime.lockSelection(
      projectId,
      videoTaskId,
      "asset_confirmation_not_ready",
      10,
      7,
      [],
      {
        actorAccountId: "account_creator_a",
        tenantId: "tenant_firefly",
        role: "creator",
        accessGrants: [],
      },
    ),
    (error: unknown) => error === notReady,
  );
  assert.equal(viewCalls, 0);
});
