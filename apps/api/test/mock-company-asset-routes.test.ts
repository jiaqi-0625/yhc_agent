import assert from "node:assert/strict";
import { request as requestHttp, type Server } from "node:http";
import test, { type TestContext } from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";
import type { WorkspaceAccessGrant } from "@firefly/schemas";
import {
  LEAPMOTOR_C10_MOCK_ASSET_BINDING,
  findMockCompanyAssetMedia,
} from "@firefly/tools";

import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import {
  type DevelopmentCompanyAssetMediaReader,
} from "../src/development-company-asset-media.ts";
import {
  createDevelopmentCompanyAssetMediaStore,
  startApiServer,
} from "../src/server.ts";
import {
  InMemoryWorkspaceAccessGrantProvider,
  WorkspaceSessionRuntime,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const agentConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-mock-company-asset-route-agent-sessions",
};

const creatorGrant: WorkspaceAccessGrant = {
  id: "grant_creator_c10_media_test",
  tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
  accountId: "account_creator_a",
  access: {
    kind: "vehicle_project",
    brandId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId,
    vehicleId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.vehicleId,
  },
  status: "active",
  revision: 1,
  createdAt: "2026-08-20T00:00:00.000Z",
  createdBy: "account_admin",
  updatedAt: "2026-08-20T00:00:00.000Z",
  updatedBy: "account_admin",
};

const adminGrant: WorkspaceAccessGrant = {
  id: "grant_admin_c10_media_test",
  tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
  accountId: "account_admin",
  access: {
    kind: "brand",
    brandId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId,
  },
  status: "active",
  revision: 1,
  createdAt: "2026-08-20T00:00:00.000Z",
  createdBy: "account_admin",
  updatedAt: "2026-08-20T00:00:00.000Z",
  updatedBy: "account_admin",
};

const content = Buffer.from("mock-c10-image");
const etag = '"sha256-test-c10-media"';
function routeTestAsset() {
  const candidate = findMockCompanyAssetMedia("asset_leapmotor_c10_0005", 1);
  if (candidate === undefined) {
    throw new Error("The C10 route test asset is missing from the manifest.");
  }
  return candidate;
}
const asset = routeTestAsset();
const mediaPath = `/v1/mock-company-assets/${asset.assetId}/versions/${asset.version}/thumbnail`;

interface Fixture {
  readonly server: Server;
  readonly baseUrl: string;
  readonly creatorToken: string;
  readonly adminToken: string;
  readonly grants: InMemoryWorkspaceAccessGrantProvider;
  readonly reads: () => number;
  failReads(value: boolean): void;
  suspendNextReadUntilAbort(): {
    readonly started: Promise<void>;
    readonly aborted: Promise<void>;
  };
}

async function fixture(context: TestContext): Promise<Fixture> {
  const grants = new InMemoryWorkspaceAccessGrantProvider([creatorGrant, adminGrant]);
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-mock-company-asset-route-sessions", false),
    grants,
  );
  const creatorToken = (await sessions.createSession("account_creator_a")).sessionId;
  const adminToken = (await sessions.createSession("account_admin")).sessionId;
  let readCount = 0;
  let unavailable = false;
  let abortProbe: {
    readonly started: () => void;
    readonly aborted: () => void;
  } | undefined;
  const reader: DevelopmentCompanyAssetMediaReader = {
    async read(entry, signal) {
      readCount += 1;
      assert.equal(entry.assetId, asset.assetId);
      assert.equal(entry.version, asset.version);
      if (signal?.aborted === true) {
        const error = new Error("Aborted");
        error.name = "AbortError";
        throw error;
      }
      if (unavailable) throw new Error("C:\\private\\mock-company-assets\\secret.jpg");
      const activeAbortProbe = abortProbe;
      if (activeAbortProbe !== undefined) {
        abortProbe = undefined;
        activeAbortProbe.started();
        return new Promise<never>((_, reject) => {
          const rejectAborted = (): void => {
            activeAbortProbe.aborted();
            const error = new Error("Aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted === true) rejectAborted();
          else signal?.addEventListener("abort", rejectAborted, { once: true });
        });
      }
      return {
        content,
        mediaType: entry.mediaType,
        byteSize: content.byteLength,
        etag,
      };
    },
  };
  const server = await startApiServer(
    0,
    "127.0.0.1",
    new LocalAgentRuntime(agentConfig),
    new LocalBusinessRuntime(),
    undefined,
    sessions,
    false,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ".data/test-mock-company-asset-route-migrations",
    undefined,
    async () => undefined,
    false,
    undefined,
    undefined,
    reader,
  );
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    creatorToken,
    adminToken,
    grants,
    reads: () => readCount,
    failReads(value) {
      unavailable = value;
    },
    suspendNextReadUntilAbort() {
      let signalStarted = (): void => undefined;
      let signalAborted = (): void => undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const aborted = new Promise<void>((resolve) => {
        signalAborted = resolve;
      });
      abortProbe = { started: signalStarted, aborted: signalAborted };
      return { started, aborted };
    },
  };
}

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function requestRawPath(baseUrl: string, path: string, token: string): Promise<number> {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = requestHttp({
      hostname: base.hostname,
      port: base.port,
      path,
      headers: authorization(token),
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

test("development company asset media serves exact versions to current scoped grants", async (context) => {
  const app = await fixture(context);
  const response = await fetch(`${app.baseUrl}${mediaPath}`, {
    headers: authorization(app.creatorToken),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  assert.equal(response.headers.get("content-type"), asset.mediaType);
  assert.equal(response.headers.get("content-length"), String(content.byteLength));
  assert.equal(response.headers.get("etag"), etag);
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  assert.equal(response.headers.get("vary"), "Authorization");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");

  const head = await fetch(`${app.baseUrl}${mediaPath}`, {
    method: "HEAD",
    headers: authorization(app.adminToken),
  });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get("content-length"), String(content.byteLength));

  const notModified = await fetch(`${app.baseUrl}${mediaPath}`, {
    headers: {
      ...authorization(app.creatorToken),
      "if-none-match": etag,
    },
  });
  assert.equal(notModified.status, 304);
  assert.equal(app.reads(), 3, "ETag revalidation must still authorize and verify the file");
});

test("development company asset media hides missing and cross-scope assets", async (context) => {
  const app = await fixture(context);
  const unauthenticated = await fetch(`${app.baseUrl}${mediaPath}`);
  assert.equal(unauthenticated.status, 401);

  const missingVersion = await fetch(
    `${app.baseUrl}/v1/mock-company-assets/${asset.assetId}/versions/2/thumbnail`,
    { headers: authorization(app.creatorToken) },
  );
  assert.equal(missingVersion.status, 404);

  app.grants.replace([adminGrant, {
    ...creatorGrant,
    id: "grant_creator_e5_media_test",
    access: {
      kind: "vehicle_project",
      brandId: "brand_firefly_demo",
      vehicleId: "vehicle_firefly_e5_2026_long_range",
    },
  }]);
  const wrongVehicle = await fetch(`${app.baseUrl}${mediaPath}`, {
    headers: authorization(app.creatorToken),
  });
  assert.equal(wrongVehicle.status, 404);
  assert.deepEqual(await wrongVehicle.json(), {
    code: "AIC-API-NOT_FOUND",
    message: "Endpoint not found.",
    retryable: false,
    charged: false,
  });

  const withQuery = await fetch(`${app.baseUrl}${mediaPath}?filename=secret.jpg`, {
    headers: authorization(app.adminToken),
  });
  assert.equal(withQuery.status, 404);

  assert.equal(
    await requestRawPath(app.baseUrl, `/ignored/..${mediaPath}`, app.adminToken),
    404,
  );
  assert.equal(
    await requestRawPath(app.baseUrl, `/%2e%2e${mediaPath}`, app.adminToken),
    404,
  );
  assert.equal(app.reads(), 0);
});

test("development company asset media returns a redacted retryable error", async (context) => {
  const app = await fixture(context);
  app.failReads(true);
  const response = await fetch(`${app.baseUrl}${mediaPath}`, {
    headers: authorization(app.creatorToken),
  });
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body, {
    code: "AIC-MOCK-ASSET-MEDIA_UNAVAILABLE",
    message: "The development company asset media is unavailable.",
    retryable: true,
    charged: false,
  });
  assert.doesNotMatch(JSON.stringify(body), /C:\\|mock-company-assets|relativePath/u);
});

test("development company asset media aborts an in-flight read after socket close", async (context) => {
  const app = await fixture(context);
  const probe = app.suspendNextReadUntilAbort();
  const base = new URL(app.baseUrl);
  const request = requestHttp({
    hostname: base.hostname,
    port: base.port,
    path: mediaPath,
    headers: authorization(app.creatorToken),
  });
  request.once("error", () => undefined);
  request.end();
  await probe.started;
  request.destroy();
  await probe.aborted;
  assert.equal(app.reads(), 1);
});

test("development media configuration is loopback-only and production-disabled", () => {
  assert.ok(createDevelopmentCompanyAssetMediaStore("127.0.0.1", {}));
  assert.equal(createDevelopmentCompanyAssetMediaStore("0.0.0.0", {}), undefined);
  assert.ok(createDevelopmentCompanyAssetMediaStore("0.0.0.0", {
    FIREFLY_ENABLE_DEVELOPMENT_ASSET_MEDIA: "true",
  }));
  assert.equal(createDevelopmentCompanyAssetMediaStore("127.0.0.1", {
    NODE_ENV: "production",
    FIREFLY_ENABLE_DEVELOPMENT_ASSET_MEDIA: "true",
    MOCK_COMPANY_ASSET_MEDIA_DIRECTORY: "C:/should-not-be-used",
  }), undefined);
});

