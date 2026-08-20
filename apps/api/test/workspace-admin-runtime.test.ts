import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RevisionConflictError, type WorkspaceSessionScope } from "@firefly/domain";
import { MockCompanyAssetProvider } from "@firefly/tools";

import { AccountBudgetRuntime } from "../src/account-budget-runtime.ts";
import { LocalAccountBudgetStore } from "../src/account-budget-store.ts";
import { BusinessRuntimeError } from "../src/business-runtime.ts";
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
} from "../src/workspace-session-runtime.ts";

function fixture(store = new LocalWorkspaceAdminStore(".data/test-workspace-admin", {
  brands: DEFAULT_ADMIN_BRANDS,
  vehicleVersions: DEFAULT_ADMIN_VEHICLES,
  vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
  accessGrants: DEVELOPMENT_ACCESS_GRANTS,
}, false)) {
  let sequence = 0;
  const budgets = new AccountBudgetRuntime(
    new LocalAccountBudgetStore(".data/test-workspace-admin-budgets", false),
    { async estimate() { throw new Error("unused pricing"); } },
    () => "2026-08-19T08:00:00.000Z",
    (kind) => `${kind}_${++sequence}`,
  );
  const runtime = new WorkspaceAdminRuntime(
    store,
    budgets,
    new MockCompanyAssetProvider(),
    () => DEVELOPMENT_ACCOUNTS,
    () => "2026-08-19T08:00:00.000Z",
    (kind) => `${kind}_${++sequence}`,
  );
  return { store, runtime };
}

async function scope(
  store: LocalWorkspaceAdminStore,
  accountId = "account_admin",
): Promise<WorkspaceSessionScope> {
  const account = DEVELOPMENT_ACCOUNTS.find((candidate) => candidate.accountId === accountId);
  assert.ok(account);
  return {
    actorAccountId: account.accountId,
    tenantId: account.tenantId,
    role: account.role,
    accessGrants: await store.listForAccount(account.tenantId, account.accountId),
  };
}

const vehicleFacts = {
  status: "active" as const,
  series: "萤火 X1",
  modelYear: 2027,
  trim: "旗舰版",
  parameters: { seats: 5 },
  fixedClaims: [{
    id: "claim_x1_seats",
    kind: "fixed" as const,
    name: "五座布局",
    statement: "车型采用五座布局",
    requiredInVoiceover: false,
    requiredInSubtitle: false,
    mayRephrase: true,
    riskNotes: [],
  }],
  optionalClaims: [],
  prohibitedClaims: ["禁止无证据的第一表述"],
};

test("workspace administration persists a canonical seed and returns defensive copies", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-workspace-admin-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const seeded = new LocalWorkspaceAdminStore(directory, {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES,
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  });
  const first = await seeded.load("tenant_firefly");
  first.brands[0]!.name = "被客户端篡改";
  assert.equal((await seeded.load("tenant_firefly")).brands[0]!.name, "萤火汽车");
  await seeded.transact("tenant_firefly", (state) => ({
    ...state,
    brands: state.brands.map((brand) => ({ ...brand, name: "萤火汽车新名" })),
  }));
  const restored = new LocalWorkspaceAdminStore(directory);
  assert.equal((await restored.load("tenant_firefly")).brands[0]!.name, "萤火汽车新名");
});

test("workspace administration snapshots serialize authorization reads with updates", async () => {
  const { store } = fixture();
  const order: string[] = [];
  let releaseSnapshot = (): void => undefined;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let snapshotEntered = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    snapshotEntered = resolve;
  });
  const snapshot = store.withSnapshot("tenant_firefly", async (state) => {
    order.push("snapshot-enter");
    snapshotEntered();
    await snapshotGate;
    order.push("snapshot-exit");
    return state.accessGrants.length;
  });
  await entered;
  const update = store.transact("tenant_firefly", (state) => {
    order.push("transaction");
    return state;
  });
  releaseSnapshot();
  assert.ok(await snapshot > 0);
  await update;
  assert.deepEqual(order, ["snapshot-enter", "snapshot-exit", "transaction"]);
});

test("admin creates brands and immutable vehicle fact versions with optimistic concurrency", async () => {
  const { store, runtime } = fixture();
  const administrator = await scope(store);
  await assert.rejects(
    runtime.createBrand(
      { name: "悬空样式品牌", defaultVisualStylePresetId: "style_missing" },
      administrator,
    ),
    (error: unknown) =>
      error instanceof BusinessRuntimeError && error.code === "AIC-ADMIN-VISUAL-STYLE_UNAVAILABLE",
  );
  const created = await runtime.createBrand(
    { name: "  星河汽车  ", defaultVisualStylePresetId: "asset_style_global_clean" },
    administrator,
  );
  assert.equal(created.brand.name, "星河汽车");
  assert.equal(created.administratorGrant.access.kind, "brand");

  const refreshedAdministrator = await scope(store);
  await assert.rejects(
    runtime.createVehicle(
      created.brand.id,
      { ...vehicleFacts, fixedClaims: [], optionalClaims: [] },
      refreshedAdministrator,
    ),
    (error: unknown) =>
      error instanceof BusinessRuntimeError && error.code === "AIC-ADMIN-VEHICLE_FACTS_INVALID",
  );
  await assert.rejects(
    runtime.createVehicle(
      created.brand.id,
      {
        ...vehicleFacts,
        optionalClaims: [{ ...vehicleFacts.fixedClaims[0]!, kind: "extended" as const }],
      },
      refreshedAdministrator,
    ),
    (error: unknown) =>
      error instanceof BusinessRuntimeError && error.code === "AIC-ADMIN-VEHICLE_FACTS_INVALID",
  );
  await assert.rejects(
    runtime.createVehicle(
      created.brand.id,
      {
        ...vehicleFacts,
        fixedClaims: Array.from({ length: 21 }, (_, index) => ({
          ...vehicleFacts.fixedClaims[0]!,
          id: `claim_${index}`,
        })),
      },
      refreshedAdministrator,
    ),
    (error: unknown) =>
      error instanceof BusinessRuntimeError && error.code === "AIC-ADMIN-VEHICLE_FACTS_INVALID",
  );
  await assert.rejects(
    runtime.createVehicle(
      created.brand.id,
      {
        ...vehicleFacts,
        fixedClaims: [{ ...vehicleFacts.fixedClaims[0]!, kind: "extended" as const }],
      },
      refreshedAdministrator,
    ),
    (error: unknown) =>
      error instanceof BusinessRuntimeError && error.code === "AIC-ADMIN-VEHICLE_FACTS_INVALID",
  );
  const vehicle = await runtime.createVehicle(created.brand.id, vehicleFacts, refreshedAdministrator);
  assert.equal(vehicle.version, 1);
  const outcomes = await Promise.allSettled([
    runtime.createVehicleFactVersion(
      vehicle.id,
      { expectedVersion: 1, ...vehicleFacts, trim: "旗舰版 A" },
      refreshedAdministrator,
    ),
    runtime.createVehicleFactVersion(
      vehicle.id,
      { expectedVersion: 1, ...vehicleFacts, trim: "旗舰版 B" },
      refreshedAdministrator,
    ),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof RevisionConflictError);
  const versions = await runtime.listVehicleVersions(vehicle.id, refreshedAdministrator);
  assert.deepEqual(versions.map((item) => item.version), [2, 1]);
  assert.equal(versions[1]!.trim, "旗舰版");

  await assert.rejects(
    runtime.updateBrand(created.brand.id, { expectedRevision: 99, status: "archived" }, refreshedAdministrator),
    RevisionConflictError,
  );
});

test("asset browsing and recommended associations use the same canonical brand and vehicle scope", async () => {
  const { store, runtime } = fixture();
  const administrator = await scope(store);
  const page = await runtime.searchCompanyAssets(
    {
      brandId: "brand_firefly_demo",
      vehicleId: "vehicle_firefly_e5_2026_long_range",
      limit: 50,
    },
    administrator,
  );
  assert.ok(page.items.some((item) => item.reference.assetId === "asset_firefly_demo_e5_hero"));
  const packageView = await runtime.getVehicleAssetPackage(
    "vehicle_firefly_e5_2026_long_range",
    administrator,
  );
  assert.equal(packageView.association?.revision, 1);
  assert.equal(packageView.assets.length, 2);
  assert.deepEqual(packageView.missingReferences, []);

  await assert.rejects(
    runtime.replaceVehicleAssetAssociations(
      "vehicle_firefly_e5_2026_long_range",
      {
        expectedRevision: 1,
        assets: [{
          assetId: "asset_e6_hero",
          version: 1,
          source: "company_catalog",
          sourceProvider: "mock_company_assets",
          category: "vehicle",
          vehicleId: "vehicle_e6",
        }],
      },
      administrator,
    ),
    (error: unknown) => error instanceof BusinessRuntimeError &&
      error.code === "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_MISMATCH",
  );

  await assert.rejects(
    runtime.replaceVehicleAssetAssociations(
      "vehicle_firefly_e5_2026_long_range",
      { expectedRevision: 1, assets: [] },
      administrator,
    ),
    (error: unknown) => error instanceof BusinessRuntimeError &&
      error.code === "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_REQUIRED",
  );

  const vehicleFreeAssets = packageView.association?.assets.filter(
    (reference) => reference.category !== "vehicle",
  ) ?? [];
  assert.ok(vehicleFreeAssets.length > 0);
  await assert.rejects(
    runtime.replaceVehicleAssetAssociations(
      "vehicle_firefly_e5_2026_long_range",
      { expectedRevision: 1, assets: vehicleFreeAssets },
      administrator,
    ),
    (error: unknown) => error instanceof BusinessRuntimeError &&
      error.code === "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_REQUIRED",
  );
});

test("grant and budget commands validate target accounts and become visible through the shared store", async () => {
  const { store, runtime } = fixture();
  const administrator = await scope(store);
  const grant = await runtime.createAccessGrant(
    "account_creator_a",
    { kind: "brand", brandId: "brand_firefly_demo" },
    administrator,
  );
  assert.ok((await store.listForAccount("tenant_firefly", "account_creator_a"))
    .some((candidate) => candidate.id === grant.id));
  await assert.rejects(
    runtime.createAccessGrant(
      "account_missing",
      { kind: "brand", brandId: "brand_firefly_demo" },
      administrator,
    ),
    (error: unknown) => error instanceof BusinessRuntimeError && error.statusCode === 404,
  );

  const budget = await runtime.createAccountBudget("account_creator_a", "CNY", 20_000, administrator);
  assert.equal(budget.revision, 1);
  await runtime.createAccountBudget("account_creator_b", "KWD", 30_000, administrator);
  const view = await runtime.getAccountBudget("account_creator_a", administrator);
  assert.equal(view?.balance.availableAmountMinor, 20_000);
  const overview = await runtime.getOverview(administrator);
  assert.equal(overview.counts.configuredBudgets, 2);
  assert.deepEqual(
    Object.fromEntries(overview.consumptionByCurrency.map((entry) => [entry.currency, entry.limitAmountMinor])),
    { CNY: 20_000, KWD: 30_000 },
  );

  const creator = await scope(store, "account_creator_a");
  await assert.rejects(
    runtime.listBrands(creator),
    (error: unknown) => error instanceof BusinessRuntimeError && error.statusCode === 403,
  );
});

test("budget overview rejects totals that cannot be represented exactly", async () => {
  const { store, runtime } = fixture();
  const administrator = await scope(store);
  await runtime.createAccountBudget(
    "account_creator_a",
    "CNY",
    Number.MAX_SAFE_INTEGER,
    administrator,
  );
  await runtime.createAccountBudget(
    "account_creator_b",
    "CNY",
    Number.MAX_SAFE_INTEGER,
    administrator,
  );
  await assert.rejects(
    runtime.getOverview(administrator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError &&
      error.code === "AIC-COST-BUDGET_AGGREGATE_OVERFLOW" &&
      error.statusCode === 422,
  );
});

test("archived resources and duplicate grants cannot be reactivated through update commands", async () => {
  const { store, runtime } = fixture();
  const administrator = await scope(store);
  const existingGrant = (await store.listForAccount("tenant_firefly", "account_creator_a"))
    .find((grant) => grant.access.kind === "vehicle_project");
  assert.ok(existingGrant);
  const revoked = await runtime.updateAccessGrant(
    existingGrant.id,
    existingGrant.revision,
    "revoked",
    administrator,
  );
  await runtime.createAccessGrant(
    "account_creator_a",
    existingGrant.access,
    administrator,
  );
  await assert.rejects(
    runtime.updateAccessGrant(revoked.id, revoked.revision, "active", administrator),
    (error: unknown) =>
      error instanceof BusinessRuntimeError && error.code === "AIC-ADMIN-GRANT_ALREADY_EXISTS",
  );

  const brand = (await runtime.createBrand(
    { name: "归档测试品牌", defaultVisualStylePresetId: "asset_style_global_clean" },
    administrator,
  )).brand;
  const refreshed = await scope(store);
  const vehicle = await runtime.createVehicle(brand.id, vehicleFacts, refreshed);
  await runtime.updateBrand(brand.id, { expectedRevision: 1, status: "archived" }, refreshed);
  await assert.rejects(
    runtime.createVehicleFactVersion(
      vehicle.id,
      { expectedVersion: 1, ...vehicleFacts, trim: "归档后激活" },
      refreshed,
    ),
    (error: unknown) =>
      error instanceof BusinessRuntimeError && error.code === "AIC-ADMIN-BRAND_ARCHIVED",
  );
});
