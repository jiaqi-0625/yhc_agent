import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";
import { MockCompanyAssetProvider } from "@firefly/tools";

import { AccountBudgetRuntime } from "../src/account-budget-runtime.ts";
import { LocalAccountBudgetStore } from "../src/account-budget-store.ts";
import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { startApiServer } from "../src/server.ts";
import {
  DEFAULT_ADMIN_BRANDS,
  DEFAULT_ADMIN_VEHICLES,
  DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
  WorkspaceAdminRuntime,
} from "../src/workspace-admin-runtime.ts";
import { LocalWorkspaceAdminStore } from "../src/workspace-admin-store.ts";
import {
  DEVELOPMENT_ACCESS_GRANTS,
  DEVELOPMENT_ACCOUNTS,
  WorkspaceSessionRuntime,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const agentConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-workspace-admin-agent-sessions",
};

async function startFixture() {
  const store = new LocalWorkspaceAdminStore(".data/test-workspace-admin-http", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES,
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-workspace-admin-http-sessions", false),
    store,
  );
  let sequence = 0;
  const administration = new WorkspaceAdminRuntime(
    store,
    new AccountBudgetRuntime(
      new LocalAccountBudgetStore(".data/test-workspace-admin-http-budgets", false),
      { async estimate() { throw new Error("unused pricing"); } },
      () => "2026-08-19T09:00:00.000Z",
      (kind) => `${kind}_${++sequence}`,
    ),
    new MockCompanyAssetProvider(),
    () => DEVELOPMENT_ACCOUNTS,
    () => "2026-08-19T09:00:00.000Z",
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
    administration,
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function sessionToken(baseUrl: string, accountId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { session: { token: string } }).session.token;
}

function headers(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

test("management HTTP API completes brand, vehicle, asset, grant, and budget commands", async (context) => {
  const { server, baseUrl } = await startFixture();
  context.after(() => server.close());

  const unauthenticated = await fetch(`${baseUrl}/v1/admin/brands`);
  assert.equal(unauthenticated.status, 401);

  const creatorToken = await sessionToken(baseUrl, "account_creator_a");
  const creatorDenied = await fetch(`${baseUrl}/v1/admin/brands`, {
    headers: headers(creatorToken),
  });
  assert.equal(creatorDenied.status, 403);
  for (const targetAccountId of ["account_creator_b", "account_missing"]) {
    const createBudgetDenied = await fetch(
      `${baseUrl}/v1/admin/accounts/${targetAccountId}/budget`,
      {
        method: "POST",
        headers: headers(creatorToken),
        body: JSON.stringify({ currency: "CNY", limitAmountMinor: 10_000 }),
      },
    );
    assert.equal(createBudgetDenied.status, 403);
    const updateBudgetDenied = await fetch(
      `${baseUrl}/v1/admin/accounts/${targetAccountId}/budget`,
      {
        method: "PATCH",
        headers: headers(creatorToken),
        body: JSON.stringify({ expectedRevision: 1, limitAmountMinor: 10_000 }),
      },
    );
    assert.equal(updateBudgetDenied.status, 403);
  }

  const adminToken = await sessionToken(baseUrl, "account_admin");
  const catalog = await fetch(
    `${baseUrl}/v1/admin/company-assets?brandId=brand_firefly_demo&vehicleId=vehicle_firefly_e5_2026_long_range&limit=20`,
    { headers: headers(adminToken) },
  );
  assert.equal(catalog.status, 200);
  assert.match(await catalog.text(), /asset_firefly_demo_e5_hero/u);
  const invalidCatalog = await fetch(
    `${baseUrl}/v1/admin/company-assets?category=shell&limit=20`,
    { headers: headers(adminToken) },
  );
  assert.equal(invalidCatalog.status, 400);
  assert.equal(
    ((await invalidCatalog.json()) as { code: string }).code,
    "AIC-ASSET-CATALOG_QUERY_INVALID",
  );

  const forged = await fetch(`${baseUrl}/v1/admin/brands`, {
    method: "POST",
    headers: headers(adminToken),
    body: JSON.stringify({
      name: "越权品牌",
      defaultVisualStylePresetId: "style_bad",
      tenantId: "tenant_attacker",
    }),
  });
  assert.equal(forged.status, 400);
  assert.equal(((await forged.json()) as { code: string }).code, "AIC-API-SCHEMA_INVALID");

  const brandResponse = await fetch(`${baseUrl}/v1/admin/brands`, {
    method: "POST",
    headers: headers(adminToken),
    body: JSON.stringify({
      name: "星河汽车",
      defaultVisualStylePresetId: "asset_style_global_clean",
    }),
  });
  assert.equal(brandResponse.status, 201);
  const brandId = ((await brandResponse.json()) as { brand: { id: string } }).brand.id;

  const vehicleResponse = await fetch(`${baseUrl}/v1/admin/brands/${brandId}/vehicles`, {
    method: "POST",
    headers: headers(adminToken),
    body: JSON.stringify({
      status: "active",
      series: "星河 X1",
      modelYear: 2027,
      trim: "旗舰版",
      parameters: { seats: 5 },
      fixedClaims: [{
        id: "claim_x1_seats",
        kind: "fixed",
        name: "五座布局",
        statement: "车型采用五座布局",
        requiredInVoiceover: false,
        requiredInSubtitle: false,
        mayRephrase: true,
        riskNotes: [],
      }],
      optionalClaims: [],
      prohibitedClaims: ["禁止无证据的第一表述"],
    }),
  });
  assert.equal(vehicleResponse.status, 201);
  const vehicleId = ((await vehicleResponse.json()) as { vehicle: { id: string } }).vehicle.id;

  const newVehicleCatalog = await fetch(
    `${baseUrl}/v1/admin/company-assets?brandId=${brandId}&vehicleId=${vehicleId}&category=vehicle&limit=20`,
    { headers: headers(adminToken) },
  );
  assert.equal(newVehicleCatalog.status, 200);
  const newVehicleReference = ((await newVehicleCatalog.json()) as {
    items: Array<{ reference: Record<string, unknown> }>;
  }).items[0]?.reference;
  assert.ok(newVehicleReference);
  const vehicleFreeAssociationResponse = await fetch(
    `${baseUrl}/v1/admin/vehicles/${vehicleId}/asset-associations`,
    {
      method: "PUT",
      headers: headers(adminToken),
      body: JSON.stringify({ expectedRevision: 0, assets: [] }),
    },
  );
  assert.equal(vehicleFreeAssociationResponse.status, 400);
  assert.equal(
    ((await vehicleFreeAssociationResponse.json()) as { code: string }).code,
    "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_REQUIRED",
  );
  const associationResponse = await fetch(
    `${baseUrl}/v1/admin/vehicles/${vehicleId}/asset-associations`,
    {
      method: "PUT",
      headers: headers(adminToken),
      body: JSON.stringify({ expectedRevision: 0, assets: [newVehicleReference] }),
    },
  );
  assert.equal(associationResponse.status, 200);
  const associatedPackage = await fetch(
    `${baseUrl}/v1/admin/vehicles/${vehicleId}/asset-associations`,
    { headers: headers(adminToken) },
  );
  assert.equal(associatedPackage.status, 200);
  assert.match(await associatedPackage.text(), /asset_mock_vehicle_/u);

  const grantResponse = await fetch(`${baseUrl}/v1/admin/access-grants`, {
    method: "POST",
    headers: headers(adminToken),
    body: JSON.stringify({
      accountId: "account_creator_b",
      access: { kind: "vehicle_project", brandId, vehicleId },
    }),
  });
  assert.equal(grantResponse.status, 201);

  const budgetResponse = await fetch(`${baseUrl}/v1/admin/accounts/account_creator_b/budget`, {
    method: "POST",
    headers: headers(adminToken),
    body: JSON.stringify({ currency: "CNY", limitAmountMinor: 50_000 }),
  });
  assert.equal(budgetResponse.status, 201);
  const budgetBody = (await budgetResponse.json()) as {
    budget: { balance: { availableAmountMinor: number }; entries?: unknown };
  };
  assert.equal(budgetBody.budget.balance.availableAmountMinor, 50_000);
  assert.equal("entries" in budgetBody.budget, false);

  const creatorBToken = await sessionToken(baseUrl, "account_creator_b");
  const ownBudget = await fetch(`${baseUrl}/v1/workspace/me/budget`, {
    headers: headers(creatorBToken),
  });
  assert.equal(ownBudget.status, 200);
  const ownBudgetBody = (await ownBudget.json()) as {
    budget: { accountId: string; balance: { availableAmountMinor: number } };
  };
  assert.equal(ownBudgetBody.budget.accountId, "account_creator_b");
  assert.equal(ownBudgetBody.budget.balance.availableAmountMinor, 50_000);

  const accounts = await fetch(`${baseUrl}/v1/admin/accounts`, {
    headers: headers(adminToken),
  });
  assert.equal(accounts.status, 200);
  const accountsText = await accounts.text();
  assert.match(accountsText, new RegExp(vehicleId, "u"));
  assert.doesNotMatch(accountsText, /"entries"/u);

  const overview = await fetch(`${baseUrl}/v1/admin/overview`, {
    headers: headers(adminToken),
  });
  assert.equal(overview.status, 200);
  const overviewBody = (await overview.json()) as {
    counts: { brands: number; configuredBudgets: number };
    taskOverview: { available: boolean };
  };
  assert.equal(overviewBody.counts.brands, 2);
  assert.equal(overviewBody.counts.configuredBudgets, 1);
  assert.equal(overviewBody.taskOverview.available, false);
});

test("management overview returns a stable 422 error when same-currency totals overflow", async (context) => {
  const { server, baseUrl } = await startFixture();
  context.after(() => server.close());
  const adminToken = await sessionToken(baseUrl, "account_admin");
  for (const accountId of ["account_creator_a", "account_creator_b"]) {
    const response = await fetch(`${baseUrl}/v1/admin/accounts/${accountId}/budget`, {
      method: "POST",
      headers: headers(adminToken),
      body: JSON.stringify({ currency: "CNY", limitAmountMinor: Number.MAX_SAFE_INTEGER }),
    });
    assert.equal(response.status, 201);
  }

  const overview = await fetch(`${baseUrl}/v1/admin/overview`, {
    headers: headers(adminToken),
  });
  assert.equal(overview.status, 422);
  assert.equal(
    ((await overview.json()) as { code?: string }).code,
    "AIC-COST-BUDGET_AGGREGATE_OVERFLOW",
  );
});
