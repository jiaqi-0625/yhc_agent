import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { setWorkspaceSessionToken } from "../public/api-client.js";
// @ts-expect-error The browser module is intentionally plain JavaScript.
import { managementApi } from "../public/management-api.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: unknown;
}

function captureRequests(context: test.TestContext): CapturedRequest[] {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
    setWorkspaceSessionToken(null);
  });
  setWorkspaceSessionToken("session_management_api");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return requests;
}

test("management API reads all five administration areas with Bearer scope and encoded whitelist queries", async (context) => {
  const requests = captureRequests(context);

  await managementApi.getOverview();
  await managementApi.listBrands();
  await managementApi.listVehicles("brand_firefly-demo");
  await managementApi.listVehicleVersions("vehicle_e5-2026");
  await managementApi.searchCompanyAssets({
    categories: ["vehicle", "scene"],
    brandId: "brand_firefly-demo",
    vehicleId: "vehicle_e5-2026",
    searchText: "城市 SUV & 家庭",
    tags: ["night", "family trip"],
    cursor: "cursor_A-1",
    limit: 25,
    tenantId: "tenant_attacker",
    role: "content_admin",
  });
  await managementApi.getVehicleAssetAssociations("vehicle_e5-2026");
  await managementApi.listAccounts();
  await managementApi.listAccessGrants({
    accountId: "account_creator-a",
    brandId: "brand_firefly-demo",
    tenantId: "tenant_attacker",
  });
  await managementApi.getAccountBudget("account_creator-a");

  assert.deepEqual(requests.map((request) => request.url), [
    "/v1/admin/overview",
    "/v1/admin/brands",
    "/v1/admin/brands/brand_firefly-demo/vehicles",
    "/v1/admin/vehicles/vehicle_e5-2026/versions",
    "/v1/admin/company-assets?category=vehicle&category=scene&brandId=brand_firefly-demo&vehicleId=vehicle_e5-2026&searchText=%E5%9F%8E%E5%B8%82+SUV+%26+%E5%AE%B6%E5%BA%AD&tag=night&tag=family+trip&cursor=cursor_A-1&limit=25",
    "/v1/admin/vehicles/vehicle_e5-2026/asset-associations",
    "/v1/admin/accounts",
    "/v1/admin/access-grants?accountId=account_creator-a&brandId=brand_firefly-demo",
    "/v1/admin/accounts/account_creator-a/budget",
  ]);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.ok(requests.every(
    (request) => request.headers.get("authorization") === "Bearer session_management_api",
  ));
  assert.ok(requests.every((request) => !request.url.includes("tenant_attacker")));
});

test("management API writes exact administration contracts without forwarding forged identity fields", async (context) => {
  const requests = captureRequests(context);
  const forged = {
    tenantId: "tenant_attacker",
    actorAccountId: "account_attacker",
    role: "content_admin",
    createdBy: "account_attacker",
    updatedBy: "account_attacker",
  };
  const facts = {
    status: "active",
    series: "萤火 E6",
    modelYear: 2027,
    trim: "旗舰版",
    parameters: { seats: 5 },
    fixedClaims: [{
      id: "claim_range",
      kind: "fixed",
      name: "续航",
      statement: "官方续航信息",
      requiredInVoiceover: false,
      requiredInSubtitle: true,
      mayRephrase: false,
      riskNotes: [],
      evidence: {
        sourceName: "官方配置表",
        sourceReference: "spec-2027",
        effectiveFrom: "2026-08-20",
        tenantId: "tenant_attacker",
      },
      ...forged,
    }],
    optionalClaims: [],
    prohibitedClaims: ["禁止无依据排名"],
    ...forged,
  };

  await managementApi.createBrand({
    name: "萤火汽车",
    defaultVisualStylePresetId: "asset_style_clean",
    revision: 99,
    ...forged,
  });
  await managementApi.updateBrand("brand_firefly", {
    expectedRevision: 3,
    name: "萤火汽车新名",
    status: "active",
    revision: 99,
    ...forged,
  });
  await managementApi.createVehicle("brand_firefly", facts);
  await managementApi.createVehicleFactVersion("vehicle_e6", {
    expectedVersion: 4,
    version: 99,
    ...facts,
  });
  await managementApi.replaceVehicleAssetAssociations("vehicle_e6", {
    expectedRevision: 2,
    assets: [{
      assetId: "asset_e6_hero",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId: "vehicle_e6",
      ...forged,
    }],
    revision: 99,
    ...forged,
  });
  await managementApi.createAccessGrant({
    accountId: "account_creator_a",
    access: {
      kind: "vehicle_project",
      brandId: "brand_firefly",
      vehicleId: "vehicle_e6",
      ...forged,
    },
    status: "revoked",
    ...forged,
  });
  await managementApi.updateAccessGrant("grant_creator_e6", {
    expectedRevision: 7,
    status: "revoked",
    revision: 99,
    ...forged,
  });
  await managementApi.createAccountBudget("account_creator_a", {
    currency: "CNY",
    limitAmountMinor: 50_000,
    revision: 99,
    ...forged,
  });
  await managementApi.updateAccountBudget("account_creator_a", {
    expectedRevision: 8,
    limitAmountMinor: 60_000,
    revision: 99,
    ...forged,
  });

  assert.deepEqual(requests.map(({ url, method, body }) => ({ url, method, body })), [
    {
      url: "/v1/admin/brands",
      method: "POST",
      body: { name: "萤火汽车", defaultVisualStylePresetId: "asset_style_clean" },
    },
    {
      url: "/v1/admin/brands/brand_firefly",
      method: "PATCH",
      body: { expectedRevision: 3, name: "萤火汽车新名", status: "active" },
    },
    {
      url: "/v1/admin/brands/brand_firefly/vehicles",
      method: "POST",
      body: {
        status: "active",
        series: "萤火 E6",
        modelYear: 2027,
        trim: "旗舰版",
        parameters: { seats: 5 },
        fixedClaims: [{
          id: "claim_range",
          kind: "fixed",
          name: "续航",
          statement: "官方续航信息",
          requiredInVoiceover: false,
          requiredInSubtitle: true,
          mayRephrase: false,
          riskNotes: [],
          evidence: {
            sourceName: "官方配置表",
            sourceReference: "spec-2027",
            effectiveFrom: "2026-08-20",
          },
        }],
        optionalClaims: [],
        prohibitedClaims: ["禁止无依据排名"],
      },
    },
    {
      url: "/v1/admin/vehicles/vehicle_e6/versions",
      method: "POST",
      body: {
        expectedVersion: 4,
        status: "active",
        series: "萤火 E6",
        modelYear: 2027,
        trim: "旗舰版",
        parameters: { seats: 5 },
        fixedClaims: [{
          id: "claim_range",
          kind: "fixed",
          name: "续航",
          statement: "官方续航信息",
          requiredInVoiceover: false,
          requiredInSubtitle: true,
          mayRephrase: false,
          riskNotes: [],
          evidence: {
            sourceName: "官方配置表",
            sourceReference: "spec-2027",
            effectiveFrom: "2026-08-20",
          },
        }],
        optionalClaims: [],
        prohibitedClaims: ["禁止无依据排名"],
      },
    },
    {
      url: "/v1/admin/vehicles/vehicle_e6/asset-associations",
      method: "PUT",
      body: {
        expectedRevision: 2,
        assets: [{
          assetId: "asset_e6_hero",
          version: 1,
          source: "company_catalog",
          sourceProvider: "mock_company_assets",
          category: "vehicle",
          vehicleId: "vehicle_e6",
        }],
      },
    },
    {
      url: "/v1/admin/access-grants",
      method: "POST",
      body: {
        accountId: "account_creator_a",
        access: {
          kind: "vehicle_project",
          brandId: "brand_firefly",
          vehicleId: "vehicle_e6",
        },
      },
    },
    {
      url: "/v1/admin/access-grants/grant_creator_e6",
      method: "PATCH",
      body: { expectedRevision: 7, status: "revoked" },
    },
    {
      url: "/v1/admin/accounts/account_creator_a/budget",
      method: "POST",
      body: { currency: "CNY", limitAmountMinor: 50_000 },
    },
    {
      url: "/v1/admin/accounts/account_creator_a/budget",
      method: "PATCH",
      body: { expectedRevision: 8, limitAmountMinor: 60_000 },
    },
  ]);
  assert.ok(requests.every(
    (request) => request.headers.get("authorization") === "Bearer session_management_api",
  ));
  assert.ok(requests.every(
    (request) => request.headers.get("content-type") === "application/json",
  ));
});

test("management API rejects every invalid path identifier before fetch", (context) => {
  const requests = captureRequests(context);

  const invalidCalls = [
    () => managementApi.updateBrand("../brand", { expectedRevision: 1, status: "archived" }),
    () => managementApi.listVehicles("brand/other"),
    () => managementApi.createVehicle("", {}),
    () => managementApi.listVehicleVersions("vehicle?other"),
    () => managementApi.createVehicleFactVersion("vehicle#other", {}),
    () => managementApi.getVehicleAssetAssociations("vehicle other"),
    () => managementApi.replaceVehicleAssetAssociations("vehicle%2Fother", {}),
    () => managementApi.updateAccessGrant("grant/other", {}),
    () => managementApi.getAccountBudget("account.other"),
    () => managementApi.createAccountBudget("account/other", {}),
    () => managementApi.updateAccountBudget("a".repeat(129), {}),
  ];

  for (const call of invalidCalls) assert.throws(call, /必须是有效的标识符/u);
  assert.equal(requests.length, 0);
});
