import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";
import { MockCompanyAssetProvider } from "@firefly/tools";

import { LocalBatchProjectStore } from "../src/batch-project-store.ts";
import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { ProjectCreationRuntime } from "../src/project-creation-runtime.ts";
import { startApiServer } from "../src/server.ts";
import {
  DEFAULT_ADMIN_BRANDS,
  DEFAULT_ADMIN_VEHICLES,
  DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
} from "../src/workspace-admin-runtime.ts";
import { LocalWorkspaceAdminStore } from "../src/workspace-admin-store.ts";
import {
  DEVELOPMENT_ACCESS_GRANTS,
  WorkspaceSessionRuntime,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const agentConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-project-creation-http-agent",
};

async function fixture() {
  const administration = new LocalWorkspaceAdminStore(".data/test-project-creation-http-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES,
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-project-creation-http-sessions", false),
    administration,
  );
  let sequence = 0;
  const projectCreation = new ProjectCreationRuntime(
    administration,
    new LocalBatchProjectStore(".data/test-project-creation-http-projects", false),
    new MockCompanyAssetProvider(),
    () => "2026-08-19T11:00:00.000Z",
    (kind) => `${kind}_${++sequence}`,
  );
  const server = await startApiServer(
    0,
    "127.0.0.1",
    new LocalAgentRuntime(agentConfig),
    new LocalBusinessRuntime(),
    undefined,
    sessions,
    true,
    false,
    undefined,
    projectCreation,
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    administration,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function token(baseUrl: string, accountId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { session: { token: string } }).session.token;
}

function headers(sessionToken: string) {
  return { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" };
}

test("three-step project creation HTTP API validates scope, payload, and idempotency", async (context) => {
  const { administration, server, baseUrl } = await fixture();
  context.after(() => server.close());
  const vehicleId = "vehicle_firefly_e5_2026_long_range";

  assert.equal((await fetch(`${baseUrl}/v1/workspace/project-creation/options`)).status, 401);
  const administratorToken = await token(baseUrl, "account_admin");
  assert.equal((await fetch(`${baseUrl}/v1/workspace/project-creation/options`, {
    headers: headers(administratorToken),
  })).status, 403);

  const creatorToken = await token(baseUrl, "account_creator_a");
  const options = await fetch(`${baseUrl}/v1/workspace/project-creation/options`, {
    headers: headers(creatorToken),
  });
  assert.equal(options.status, 200);
  assert.match(await options.text(), new RegExp(vehicleId, "u"));

  const assetPackage = await fetch(
    `${baseUrl}/v1/workspace/project-creation/vehicles/${vehicleId}/asset-package`,
    { headers: headers(creatorToken) },
  );
  assert.equal(assetPackage.status, 200);
  const packageBody = (await assetPackage.json()) as {
    recommendedAssets: Array<{ reference: Record<string, unknown> }>;
  };
  const vehicleReference = packageBody.recommendedAssets[0]?.reference;
  assert.ok(vehicleReference);

  const configuration = await fetch(
    `${baseUrl}/v1/workspace/project-creation/vehicles/${vehicleId}/configuration`,
    { headers: headers(creatorToken) },
  );
  assert.equal(configuration.status, 200);
  assert.match(await configuration.text(), /asset_style_firefly_demo_clean/u);

  const forbiddenReplacement = await fetch(
    `${baseUrl}/v1/workspace/project-creation/vehicles/${vehicleId}/company-assets?category=vehicle`,
    { headers: headers(creatorToken) },
  );
  assert.equal(forbiddenReplacement.status, 400);

  const baseRequest = {
    requestId: "request_http_project",
    vehicleId,
    expectedBrandRevision: 1,
    expectedVehicleVersion: 1,
    expectedAssetAssociationRevision: 1,
    selectedAssets: [vehicleReference],
    aspectRatio: "9:16",
    batchName: "HTTP 创建批次",
    customStylePrompt: "清透产品光线",
  };
  const forged = await fetch(`${baseUrl}/v1/workspace/batch-projects`, {
    method: "POST",
    headers: headers(creatorToken),
    body: JSON.stringify({ ...baseRequest, tenantId: "tenant_attacker", brandId: "brand_other" }),
  });
  assert.equal(forged.status, 400);
  assert.equal(((await forged.json()) as { code: string }).code, "AIC-API-SCHEMA_INVALID");

  const created = await fetch(`${baseUrl}/v1/workspace/batch-projects`, {
    method: "POST",
    headers: headers(creatorToken),
    body: JSON.stringify(baseRequest),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    project: { id: string; name: string; createdBy: string };
    assetPool: { batchProjectId: string };
    replayed: boolean;
    payloadHash?: unknown;
  };
  assert.equal(createdBody.project.createdBy, "account_creator_a");
  assert.equal(createdBody.assetPool.batchProjectId, createdBody.project.id);
  assert.equal(createdBody.replayed, false);
  assert.equal("payloadHash" in createdBody, false);

  const replay = await fetch(`${baseUrl}/v1/workspace/batch-projects`, {
    method: "POST",
    headers: headers(creatorToken),
    body: JSON.stringify(baseRequest),
  });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { project: { id: string } }).project.id, createdBody.project.id);

  const conflict = await fetch(`${baseUrl}/v1/workspace/batch-projects`, {
    method: "POST",
    headers: headers(creatorToken),
    body: JSON.stringify({ ...baseRequest, batchName: "冲突批次" }),
  });
  assert.equal(conflict.status, 409);

  await administration.transact("tenant_firefly", (state) => ({
    ...state,
    accessGrants: state.accessGrants.map((grant) =>
      grant.accountId === "account_creator_a"
        ? { ...grant, status: "revoked", revision: grant.revision + 1 }
        : grant),
  }));
  const revokedReplay = await fetch(`${baseUrl}/v1/workspace/batch-projects`, {
    method: "POST",
    headers: headers(creatorToken),
    body: JSON.stringify(baseRequest),
  });
  assert.equal(revokedReplay.status, 403);
});
