import { randomUUID } from "node:crypto";

import {
  RevisionConflictError,
  assertCanManageBrand,
  assertRevision,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  Brand,
  CompanyAssetReference,
  CreateBrandRequest,
  CreateVehicleFactVersionRequest,
  CreateVehicleRequest,
  ReplaceVehicleAssetAssociationsRequest,
  UpdateBrandRequest,
  Vehicle,
  VehicleAssetAssociation,
  WorkspaceAccessGrant,
  WorkspaceAccessScope,
} from "@firefly/schemas";
import type {
  CompanyAssetCatalogPage,
  CompanyAssetCatalogQuery,
  CompanyAssetProvider,
  CompanyAssetProviderScope,
} from "@firefly/tools";

import type { AccountBudgetRuntime } from "./account-budget-runtime.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import type {
  WorkspaceAdminState,
  WorkspaceAdminStore,
} from "./workspace-admin-store.ts";
import type { DevelopmentAccount } from "./workspace-session-runtime.ts";
import { hasUsableVehicleFacts } from "./vehicle-facts.ts";

type IdKind = "brand" | "vehicle" | "grant" | "vehicle_asset_association";

export const DEFAULT_ADMIN_BRANDS: readonly Brand[] = [
  {
    id: "brand_firefly_demo",
    tenantId: "tenant_firefly",
    name: "萤火汽车",
    status: "active",
    revision: 1,
    defaultVisualStylePresetId: "asset_style_firefly_demo_clean",
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_admin",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_admin",
  },
];

export const DEFAULT_ADMIN_VEHICLES: readonly Vehicle[] = [
  {
    id: "vehicle_firefly_e5_2026_long_range",
    tenantId: "tenant_firefly",
    brandId: "brand_firefly_demo",
    version: 1,
    status: "active",
    series: "萤火 E5",
    modelYear: 2026,
    trim: "长续航版",
    parameters: {
      bodyType: "纯电紧凑型 SUV",
      seats: 5,
    },
    fixedClaims: [{
      id: "claim_firefly_e5_five_seat_suv",
      kind: "fixed",
      name: "五座纯电 SUV",
      statement: "萤火 E5 长续航版为五座纯电紧凑型 SUV",
      evidence: {
        sourceName: "萤火汽车官方车型目录",
        sourceReference: "firefly-e5-2026-long-range#body-and-seats",
        effectiveFrom: "2026-01-01",
      },
      requiredInVoiceover: false,
      requiredInSubtitle: false,
      mayRephrase: true,
      riskNotes: ["不得扩展为未经官方证据支持的空间或安全排名"],
    }],
    optionalClaims: [],
    prohibitedClaims: ["未经官方证据支持的续航、能耗或安全排名"],
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_admin",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_admin",
  },
];

export const DEFAULT_VEHICLE_ASSET_ASSOCIATIONS: readonly VehicleAssetAssociation[] = [
  {
    id: "vehicle_asset_association_firefly_e5",
    tenantId: "tenant_firefly",
    brandId: "brand_firefly_demo",
    vehicleId: "vehicle_firefly_e5_2026_long_range",
    revision: 1,
    assets: [
      {
        assetId: "asset_firefly_demo_e5_hero",
        version: 1,
        source: "company_catalog",
        sourceProvider: "mock_company_assets",
        category: "vehicle",
        vehicleId: "vehicle_firefly_e5_2026_long_range",
      },
      {
        assetId: "asset_style_firefly_demo_clean",
        version: 1,
        source: "company_catalog",
        sourceProvider: "mock_company_assets",
        category: "visual_style",
      },
    ],
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_admin",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_admin",
  },
];

function normalizedName(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new BusinessRuntimeError("AIC-ADMIN-NAME_INVALID", `${label} cannot be blank.`, 400);
  }
  return normalized;
}

function notFound(kind: string, id: string): BusinessRuntimeError {
  return new BusinessRuntimeError(
    "AIC-ADMIN-RESOURCE_NOT_FOUND",
    `${kind} '${id}' was not found.`,
    404,
  );
}

function conflict(code: string, message: string): BusinessRuntimeError {
  return new BusinessRuntimeError(code, message, 409);
}

function assertAdministrator(session: Readonly<WorkspaceSessionScope>): void {
  if (session.role !== "content_admin") {
    throw new BusinessRuntimeError(
      "AIC-AUTH-ROLE_DENIED",
      "Only a content administrator can use workspace administration APIs.",
      403,
    );
  }
}

function assertUsableVehicleFacts(
  input: Readonly<Pick<CreateVehicleRequest, "fixedClaims" | "optionalClaims">>,
): void {
  if (!hasUsableVehicleFacts(input)) {
    throw new BusinessRuntimeError(
      "AIC-ADMIN-VEHICLE_FACTS_INVALID",
      "A vehicle requires 1 to 20 globally unique facts in their matching fixed or extended groups.",
      400,
    );
  }
}

function safeMinorTotal(left: number, right: number): number {
  const total = BigInt(left) + BigInt(right);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new BusinessRuntimeError(
      "AIC-COST-BUDGET_AGGREGATE_OVERFLOW",
      "The budget overview exceeds the safe integer range and cannot be represented exactly.",
      422,
    );
  }
  return Number(total);
}

function latestVehicles(versions: readonly Vehicle[]): Vehicle[] {
  const latest = new Map<string, Vehicle>();
  for (const vehicle of versions) {
    const current = latest.get(vehicle.id);
    if (!current || vehicle.version > current.version) latest.set(vehicle.id, vehicle);
  }
  return [...latest.values()];
}

function sameAccess(left: Readonly<WorkspaceAccessScope>, right: Readonly<WorkspaceAccessScope>): boolean {
  return left.kind === right.kind &&
    left.brandId === right.brandId &&
    (left.kind !== "vehicle_project" ||
      (right.kind === "vehicle_project" && left.vehicleId === right.vehicleId));
}

function referenceKey(reference: Readonly<CompanyAssetReference>): string {
  return `${reference.sourceProvider}:${reference.assetId}:${reference.version}:${reference.category}:` +
    (reference.category === "vehicle" ? reference.vehicleId : "");
}

export interface WorkspaceAdministrationAccountView {
  account: DevelopmentAccount;
  accessGrants: WorkspaceAccessGrant[];
  budget?: Awaited<ReturnType<AccountBudgetRuntime["loadForAdministration"]>>;
}

export class WorkspaceAdminRuntime {
  constructor(
    private readonly store: WorkspaceAdminStore,
    private readonly budgets: AccountBudgetRuntime,
    private readonly companyAssets: CompanyAssetProvider,
    private readonly listAccounts: () => readonly Readonly<DevelopmentAccount>[],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: (kind: IdKind) => string = (kind) =>
      `${kind}_${randomUUID()}`,
  ) {}

  #accountsForTenant(tenantId: string): DevelopmentAccount[] {
    return structuredClone(this.listAccounts().filter((account) => account.tenantId === tenantId));
  }

  #targetAccount(tenantId: string, accountId: string): DevelopmentAccount {
    const account = this.#accountsForTenant(tenantId).find((candidate) => candidate.accountId === accountId);
    if (!account) throw notFound("Account", accountId);
    return account;
  }

  #managedBrandIds(session: Readonly<WorkspaceSessionScope>): string[] {
    return [...new Set(session.accessGrants
      .filter(
        (grant) =>
          grant.tenantId === session.tenantId &&
          grant.accountId === session.actorAccountId &&
          grant.status === "active" &&
          grant.access.kind === "brand",
      )
      .map((grant) => grant.access.brandId))];
  }

  #brand(state: Readonly<WorkspaceAdminState>, brandId: string): Brand {
    const brand = state.brands.find((candidate) => candidate.id === brandId);
    if (!brand) throw notFound("Brand", brandId);
    return brand;
  }

  #managedBrand(
    state: Readonly<WorkspaceAdminState>,
    brandId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Brand {
    const brand = this.#brand(state, brandId);
    assertCanManageBrand(session, brand);
    return brand;
  }

  #latestVehicle(state: Readonly<WorkspaceAdminState>, vehicleId: string): Vehicle {
    const versions = state.vehicleVersions.filter((candidate) => candidate.id === vehicleId);
    const latest = versions.sort((left, right) => right.version - left.version)[0];
    if (!latest) throw notFound("Vehicle", vehicleId);
    return latest;
  }

  async #assertVisualStylePreset(
    assetId: string,
    brandId: string,
    state: Readonly<WorkspaceAdminState>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<void> {
    const baseScope = this.#companyAssetScope(state, session);
    const scope: CompanyAssetProviderScope = {
      ...baseScope,
      allowedBrandIds: [...new Set([...baseScope.allowedBrandIds, brandId])],
    };
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await this.companyAssets.searchAssets(
        {
          categories: ["visual_style"],
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
        scope,
      );
      const preset = page.items.find(
        (item) =>
          item.reference.category === "visual_style" &&
          item.reference.assetId === assetId &&
          (item.brandIds.length === 0 || item.brandIds.includes(brandId)),
      );
      if (preset) return;
      if (page.nextCursor === undefined) break;
      if (seenCursors.has(page.nextCursor)) break;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new BusinessRuntimeError(
      "AIC-ADMIN-VISUAL-STYLE_UNAVAILABLE",
      "The default visual style preset is unavailable for this brand scope.",
      400,
    );
  }

  async listBrands(session: Readonly<WorkspaceSessionScope>): Promise<Brand[]> {
    assertAdministrator(session);
    const managed = new Set(this.#managedBrandIds(session));
    return (await this.store.load(session.tenantId)).brands
      .filter((brand) => managed.has(brand.id))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async createBrand(
    input: Readonly<CreateBrandRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<{ brand: Brand; administratorGrant: WorkspaceAccessGrant }> {
    assertAdministrator(session);
    const occurredAt = this.now();
    const name = normalizedName(input.name, "Brand name");
    const brandId = this.createId("brand");
    const administratorGrantId = this.createId("grant");
    await this.#assertVisualStylePreset(
      input.defaultVisualStylePresetId,
      brandId,
      await this.store.load(session.tenantId),
      session,
    );
    let createdBrand: Brand | undefined;
    let administratorGrant: WorkspaceAccessGrant | undefined;
    await this.store.transact(session.tenantId, (state) => {
      if (state.brands.some((brand) => brand.name.normalize("NFKC").trim() === name)) {
        throw conflict("AIC-ADMIN-BRAND_ALREADY_EXISTS", "A brand with the same name already exists.");
      }
      createdBrand = {
        id: brandId,
        tenantId: session.tenantId,
        name,
        status: "active",
        revision: 1,
        defaultVisualStylePresetId: input.defaultVisualStylePresetId,
        createdAt: occurredAt,
        createdBy: session.actorAccountId,
        updatedAt: occurredAt,
        updatedBy: session.actorAccountId,
      };
      administratorGrant = {
        id: administratorGrantId,
        tenantId: session.tenantId,
        accountId: session.actorAccountId,
        access: { kind: "brand", brandId: createdBrand.id },
        status: "active",
        revision: 1,
        createdAt: occurredAt,
        createdBy: session.actorAccountId,
        updatedAt: occurredAt,
        updatedBy: session.actorAccountId,
      };
      return {
        ...state,
        brands: [...state.brands, createdBrand],
        accessGrants: [...state.accessGrants, administratorGrant],
      };
    });
    if (!createdBrand || !administratorGrant) throw new Error("Brand creation returned no record.");
    return { brand: structuredClone(createdBrand), administratorGrant: structuredClone(administratorGrant) };
  }

  async updateBrand(
    brandId: string,
    input: Readonly<UpdateBrandRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<Brand> {
    assertAdministrator(session);
    const before = await this.store.load(session.tenantId);
    this.#managedBrand(before, brandId, session);
    if (input.defaultVisualStylePresetId !== undefined) {
      await this.#assertVisualStylePreset(
        input.defaultVisualStylePresetId,
        brandId,
        before,
        session,
      );
    }
    let updated: Brand | undefined;
    await this.store.transact(session.tenantId, (state) => {
      const current = this.#managedBrand(state, brandId, session);
      assertRevision(input.expectedRevision, current.revision);
      const name = input.name === undefined ? current.name : normalizedName(input.name, "Brand name");
      if (
        state.brands.some(
          (brand) => brand.id !== brandId && brand.name.normalize("NFKC").trim() === name,
        )
      ) {
        throw conflict("AIC-ADMIN-BRAND_ALREADY_EXISTS", "A brand with the same name already exists.");
      }
      updated = {
        ...current,
        name,
        status: input.status ?? current.status,
        defaultVisualStylePresetId:
          input.defaultVisualStylePresetId ?? current.defaultVisualStylePresetId,
        revision: current.revision + 1,
        updatedAt: this.now(),
        updatedBy: session.actorAccountId,
      };
      return {
        ...state,
        brands: state.brands.map((brand) => brand.id === brandId ? updated! : brand),
      };
    });
    if (!updated) throw new Error("Brand update returned no record.");
    return structuredClone(updated);
  }

  async listVehicles(
    brandId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<Vehicle[]> {
    assertAdministrator(session);
    const state = await this.store.load(session.tenantId);
    this.#managedBrand(state, brandId, session);
    return latestVehicles(state.vehicleVersions)
      .filter((vehicle) => vehicle.brandId === brandId)
      .sort((left, right) => left.series.localeCompare(right.series, "zh-CN") ||
        right.modelYear - left.modelYear || left.trim.localeCompare(right.trim, "zh-CN"));
  }

  async listVehicleVersions(
    vehicleId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<Vehicle[]> {
    assertAdministrator(session);
    const state = await this.store.load(session.tenantId);
    const latest = this.#latestVehicle(state, vehicleId);
    this.#managedBrand(state, latest.brandId, session);
    return state.vehicleVersions
      .filter((vehicle) => vehicle.id === vehicleId)
      .sort((left, right) => right.version - left.version);
  }

  async createVehicle(
    brandId: string,
    input: Readonly<CreateVehicleRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<Vehicle> {
    assertAdministrator(session);
    assertUsableVehicleFacts(input);
    let created: Vehicle | undefined;
    await this.store.transact(session.tenantId, (state) => {
      const brand = this.#managedBrand(state, brandId, session);
      if (brand.status !== "active") {
        throw conflict("AIC-ADMIN-BRAND_ARCHIVED", "Vehicles cannot be added to an archived brand.");
      }
      const series = normalizedName(input.series, "Vehicle series");
      const trim = normalizedName(input.trim, "Vehicle trim");
      if (latestVehicles(state.vehicleVersions).some(
        (vehicle) => vehicle.brandId === brandId && vehicle.series === series &&
          vehicle.modelYear === input.modelYear && vehicle.trim === trim,
      )) {
        throw conflict("AIC-ADMIN-VEHICLE_ALREADY_EXISTS", "The vehicle model already exists.");
      }
      const occurredAt = this.now();
      created = {
        id: this.createId("vehicle"),
        tenantId: session.tenantId,
        brandId,
        version: 1,
        ...structuredClone(input),
        series,
        trim,
        createdAt: occurredAt,
        createdBy: session.actorAccountId,
        updatedAt: occurredAt,
        updatedBy: session.actorAccountId,
      };
      return { ...state, vehicleVersions: [...state.vehicleVersions, created] };
    });
    if (!created) throw new Error("Vehicle creation returned no record.");
    return structuredClone(created);
  }

  async createVehicleFactVersion(
    vehicleId: string,
    input: Readonly<CreateVehicleFactVersionRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<Vehicle> {
    assertAdministrator(session);
    assertUsableVehicleFacts(input);
    let created: Vehicle | undefined;
    await this.store.transact(session.tenantId, (state) => {
      const latest = this.#latestVehicle(state, vehicleId);
      const brand = this.#managedBrand(state, latest.brandId, session);
      if (brand.status !== "active") {
        throw conflict(
          "AIC-ADMIN-BRAND_ARCHIVED",
          "Vehicle facts cannot be versioned under an archived brand.",
        );
      }
      assertRevision(input.expectedVersion, latest.version);
      const { expectedVersion: _expectedVersion, ...facts } = input;
      const series = normalizedName(facts.series, "Vehicle series");
      const trim = normalizedName(facts.trim, "Vehicle trim");
      if (latestVehicles(state.vehicleVersions).some(
        (vehicle) =>
          vehicle.id !== vehicleId &&
          vehicle.brandId === latest.brandId &&
          vehicle.series === series &&
          vehicle.modelYear === facts.modelYear &&
          vehicle.trim === trim,
      )) {
        throw conflict(
          "AIC-ADMIN-VEHICLE_ALREADY_EXISTS",
          "The vehicle fact version conflicts with another vehicle model.",
        );
      }
      const occurredAt = this.now();
      created = {
        id: latest.id,
        tenantId: latest.tenantId,
        brandId: latest.brandId,
        version: latest.version + 1,
        ...structuredClone(facts),
        series,
        trim,
        createdAt: occurredAt,
        createdBy: session.actorAccountId,
        updatedAt: occurredAt,
        updatedBy: session.actorAccountId,
      };
      return { ...state, vehicleVersions: [...state.vehicleVersions, created] };
    });
    if (!created) throw new Error("Vehicle fact version creation returned no record.");
    return structuredClone(created);
  }

  async listAccessGrants(
    session: Readonly<WorkspaceSessionScope>,
    filters: Readonly<{ accountId?: string; brandId?: string }> = {},
  ): Promise<WorkspaceAccessGrant[]> {
    assertAdministrator(session);
    const managed = new Set(this.#managedBrandIds(session));
    if (filters.brandId !== undefined && !managed.has(filters.brandId)) {
      const state = await this.store.load(session.tenantId);
      this.#managedBrand(state, filters.brandId, session);
    }
    return (await this.store.load(session.tenantId)).accessGrants
      .filter((grant) => managed.has(grant.access.brandId))
      .filter((grant) => filters.accountId === undefined || grant.accountId === filters.accountId)
      .filter((grant) => filters.brandId === undefined || grant.access.brandId === filters.brandId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createAccessGrant(
    accountId: string,
    access: Readonly<WorkspaceAccessScope>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<WorkspaceAccessGrant> {
    assertAdministrator(session);
    const account = this.#targetAccount(session.tenantId, accountId);
    if (access.kind === "vehicle_project" && account.role !== "creator") {
      throw new BusinessRuntimeError(
        "AIC-ADMIN-GRANT_ROLE_INVALID",
        "Vehicle-project access can only be granted to a production account.",
        400,
      );
    }
    let created: WorkspaceAccessGrant | undefined;
    await this.store.transact(session.tenantId, (state) => {
      this.#managedBrand(state, access.brandId, session);
      const brand = this.#brand(state, access.brandId);
      if (brand.status !== "active") {
        throw conflict("AIC-ADMIN-GRANT_SCOPE_ARCHIVED", "Access cannot be granted for an archived brand.");
      }
      if (access.kind === "vehicle_project") {
        const vehicle = this.#latestVehicle(state, access.vehicleId);
        if (vehicle.brandId !== access.brandId) {
          throw new BusinessRuntimeError(
            "AIC-ADMIN-GRANT_SCOPE_INVALID",
            "The vehicle does not belong to the granted brand.",
            400,
          );
        }
        if (vehicle.status !== "active") {
          throw conflict("AIC-ADMIN-GRANT_SCOPE_ARCHIVED", "Access cannot be granted for an archived vehicle.");
        }
      }
      if (state.accessGrants.some(
        (grant) => grant.accountId === accountId && grant.status === "active" && sameAccess(grant.access, access),
      )) {
        throw conflict("AIC-ADMIN-GRANT_ALREADY_EXISTS", "An active grant already exists for this scope.");
      }
      const occurredAt = this.now();
      created = {
        id: this.createId("grant"),
        tenantId: session.tenantId,
        accountId,
        access: structuredClone(access),
        status: "active",
        revision: 1,
        createdAt: occurredAt,
        createdBy: session.actorAccountId,
        updatedAt: occurredAt,
        updatedBy: session.actorAccountId,
      };
      return { ...state, accessGrants: [...state.accessGrants, created] };
    });
    if (!created) throw new Error("Access grant creation returned no record.");
    return structuredClone(created);
  }

  async updateAccessGrant(
    grantId: string,
    expectedRevision: number,
    status: WorkspaceAccessGrant["status"],
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<WorkspaceAccessGrant> {
    assertAdministrator(session);
    let updated: WorkspaceAccessGrant | undefined;
    await this.store.transact(session.tenantId, (state) => {
      const current = state.accessGrants.find((grant) => grant.id === grantId);
      if (!current) throw notFound("Access grant", grantId);
      this.#managedBrand(state, current.access.brandId, session);
      const targetAccount = this.#targetAccount(session.tenantId, current.accountId);
      assertRevision(expectedRevision, current.revision);
      if (status === "active") {
        const brand = this.#brand(state, current.access.brandId);
        if (brand.status !== "active") {
          throw conflict(
            "AIC-ADMIN-GRANT_SCOPE_ARCHIVED",
            "Access cannot be restored for an archived brand.",
          );
        }
        if (current.access.kind === "vehicle_project") {
          const vehicle = this.#latestVehicle(state, current.access.vehicleId);
          if (
            targetAccount.role !== "creator" ||
            vehicle.brandId !== current.access.brandId ||
            vehicle.status !== "active"
          ) {
            throw conflict(
              "AIC-ADMIN-GRANT_SCOPE_ARCHIVED",
              "Vehicle-project access can only be restored for an active vehicle and production account.",
            );
          }
        }
        if (state.accessGrants.some(
          (grant) =>
            grant.id !== current.id &&
            grant.accountId === current.accountId &&
            grant.status === "active" &&
            sameAccess(grant.access, current.access),
        )) {
          throw conflict(
            "AIC-ADMIN-GRANT_ALREADY_EXISTS",
            "An active grant already exists for this scope.",
          );
        }
      }
      updated = {
        ...current,
        status,
        revision: current.revision + 1,
        updatedAt: this.now(),
        updatedBy: session.actorAccountId,
      };
      return {
        ...state,
        accessGrants: state.accessGrants.map((grant) => grant.id === grantId ? updated! : grant),
      };
    });
    if (!updated) throw new Error("Access grant update returned no record.");
    return structuredClone(updated);
  }

  async listAccountsWithAdministration(
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<WorkspaceAdministrationAccountView[]> {
    assertAdministrator(session);
    const grants = await this.listAccessGrants(session);
    return Promise.all(this.#accountsForTenant(session.tenantId).map(async (account) => {
      const budget = await this.budgets.loadForAdministration(account.accountId, session);
      return {
        account,
        accessGrants: grants.filter((grant) => grant.accountId === account.accountId),
        ...(budget === undefined ? {} : { budget }),
      };
    }));
  }

  async getAccountBudget(
    accountId: string,
    session: Readonly<WorkspaceSessionScope>,
  ) {
    assertAdministrator(session);
    this.#targetAccount(session.tenantId, accountId);
    return this.budgets.loadForAdministration(accountId, session);
  }

  async getOwnAccountBudget(session: Readonly<WorkspaceSessionScope>) {
    return this.budgets.loadForSession(session);
  }

  async createAccountBudget(
    accountId: string,
    currency: string,
    limitAmountMinor: number,
    session: Readonly<WorkspaceSessionScope>,
  ) {
    assertAdministrator(session);
    this.#targetAccount(session.tenantId, accountId);
    return this.budgets.createForAccount(accountId, currency, limitAmountMinor, session);
  }

  async updateAccountBudget(
    accountId: string,
    expectedRevision: number,
    limitAmountMinor: number,
    session: Readonly<WorkspaceSessionScope>,
  ) {
    assertAdministrator(session);
    this.#targetAccount(session.tenantId, accountId);
    return this.budgets.updateLimit(accountId, expectedRevision, limitAmountMinor, session);
  }

  async searchCompanyAssets(
    query: Readonly<CompanyAssetCatalogQuery>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<CompanyAssetCatalogPage> {
    assertAdministrator(session);
    const state = await this.store.load(session.tenantId);
    const scope = this.#companyAssetScope(state, session);
    return this.companyAssets.searchAssets(query, scope);
  }

  #companyAssetScope(
    state: Readonly<WorkspaceAdminState>,
    session: Readonly<WorkspaceSessionScope>,
  ): CompanyAssetProviderScope {
    const allowedBrandIds = this.#managedBrandIds(session)
      .filter((brandId) => state.brands.some((brand) => brand.id === brandId));
    const allowedBrandSet = new Set(allowedBrandIds);
    const allowedVehicleIds = latestVehicles(state.vehicleVersions)
      .filter((vehicle) => allowedBrandSet.has(vehicle.brandId))
      .map((vehicle) => vehicle.id);
    return {
      tenantId: session.tenantId,
      actorAccountId: session.actorAccountId,
      allowedBrandIds,
      allowedVehicleIds,
    };
  }

  async getVehicleAssetAssociations(
    vehicleId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VehicleAssetAssociation | undefined> {
    assertAdministrator(session);
    const state = await this.store.load(session.tenantId);
    const vehicle = this.#latestVehicle(state, vehicleId);
    this.#managedBrand(state, vehicle.brandId, session);
    return structuredClone(
      state.vehicleAssetAssociations.find((record) => record.vehicleId === vehicleId),
    );
  }

  async getVehicleAssetPackage(
    vehicleId: string,
    session: Readonly<WorkspaceSessionScope>,
  ) {
    const association = await this.getVehicleAssetAssociations(vehicleId, session);
    if (!association) {
      return { association: null, assets: [], missingReferences: [] };
    }
    const state = await this.store.load(session.tenantId);
    const resolved = await this.companyAssets.resolveAssets(
      association.assets,
      this.#companyAssetScope(state, session),
    );
    return {
      association,
      assets: resolved.items,
      missingReferences: resolved.missingReferences,
    };
  }

  async replaceVehicleAssetAssociations(
    vehicleId: string,
    input: Readonly<ReplaceVehicleAssetAssociationsRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VehicleAssetAssociation> {
    assertAdministrator(session);
    const before = await this.store.load(session.tenantId);
    const vehicle = this.#latestVehicle(before, vehicleId);
    this.#managedBrand(before, vehicle.brandId, session);
    if (vehicle.status !== "active") {
      throw conflict(
        "AIC-ADMIN-VEHICLE_ARCHIVED",
        "Recommended assets cannot be changed for an archived vehicle.",
      );
    }
    const keys = input.assets.map(referenceKey);
    if (new Set(keys).size !== keys.length) {
      throw new BusinessRuntimeError(
        "AIC-ADMIN-ASSET_ASSOCIATION_DUPLICATE",
        "The recommended asset package contains duplicate references.",
        400,
      );
    }
    if (input.assets.some(
      (reference) => reference.category === "vehicle" && reference.vehicleId !== vehicleId,
    )) {
      throw new BusinessRuntimeError(
        "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_MISMATCH",
        "Vehicle assets cannot be associated across vehicles.",
        400,
      );
    }
    if (!input.assets.some(
      (reference) => reference.category === "vehicle" && reference.vehicleId === vehicleId,
    )) {
      throw new BusinessRuntimeError(
        "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_REQUIRED",
        "The recommended asset package requires an asset for the current vehicle.",
        400,
      );
    }
    const resolved = await this.companyAssets.resolveAssets(
      input.assets,
      this.#companyAssetScope(before, session),
    );
    const requestedKeys = new Set(input.assets.map(referenceKey));
    const resolvedKeys = new Set(resolved.items.map((item) => referenceKey(item.reference)));
    if (
      resolved.missingReferences.length > 0 ||
      resolvedKeys.size !== requestedKeys.size ||
      [...requestedKeys].some((key) => !resolvedKeys.has(key)) ||
      resolved.items.some(
        (item) => item.brandIds.length > 0 && !item.brandIds.includes(vehicle.brandId),
      )
    ) {
      throw new BusinessRuntimeError(
        "AIC-ADMIN-ASSET_ASSOCIATION_UNAVAILABLE",
        "One or more company assets are unavailable for this brand and vehicle scope.",
        400,
      );
    }
    let saved: VehicleAssetAssociation | undefined;
    await this.store.transact(session.tenantId, (state) => {
      const currentVehicle = this.#latestVehicle(state, vehicleId);
      const currentBrand = this.#managedBrand(state, currentVehicle.brandId, session);
      if (currentBrand.status !== "active" || currentVehicle.status !== "active") {
        throw conflict(
          "AIC-ADMIN-VEHICLE_ARCHIVED",
          "Recommended assets cannot be changed for an archived brand or vehicle.",
        );
      }
      const current = state.vehicleAssetAssociations.find((record) => record.vehicleId === vehicleId);
      const actualRevision = current?.revision ?? 0;
      if (input.expectedRevision !== actualRevision) {
        throw new RevisionConflictError(input.expectedRevision, actualRevision);
      }
      const occurredAt = this.now();
      saved = current
        ? {
            ...current,
            revision: current.revision + 1,
            assets: structuredClone(input.assets),
            updatedAt: occurredAt,
            updatedBy: session.actorAccountId,
          }
        : {
            id: this.createId("vehicle_asset_association"),
            tenantId: session.tenantId,
            brandId: currentVehicle.brandId,
            vehicleId,
            revision: 1,
            assets: structuredClone(input.assets),
            createdAt: occurredAt,
            createdBy: session.actorAccountId,
            updatedAt: occurredAt,
            updatedBy: session.actorAccountId,
          };
      return {
        ...state,
        vehicleAssetAssociations: current
          ? state.vehicleAssetAssociations.map((record) => record.vehicleId === vehicleId ? saved! : record)
          : [...state.vehicleAssetAssociations, saved],
      };
    });
    if (!saved) throw new Error("Vehicle asset association update returned no record.");
    return structuredClone(saved);
  }

  async getOverview(session: Readonly<WorkspaceSessionScope>) {
    assertAdministrator(session);
    const [brands, accounts] = await Promise.all([
      this.listBrands(session),
      this.listAccountsWithAdministration(session),
    ]);
    const state = await this.store.load(session.tenantId);
    const managedBrandIds = new Set(brands.map((brand) => brand.id));
    const vehicles = latestVehicles(state.vehicleVersions)
      .filter((vehicle) => managedBrandIds.has(vehicle.brandId));
    const configuredBudgets = accounts.flatMap((entry) => entry.budget ? [entry.budget] : []);
    return {
      counts: {
        brands: brands.length,
        activeBrands: brands.filter((brand) => brand.status === "active").length,
        vehicles: vehicles.length,
        activeVehicles: vehicles.filter((vehicle) => vehicle.status === "active").length,
        accounts: accounts.length,
        activeAccessGrants: accounts.reduce(
          (total, entry) => total + entry.accessGrants.filter((grant) => grant.status === "active").length,
          0,
        ),
        configuredBudgets: configuredBudgets.length,
      },
      consumptionByCurrency: Object.values(configuredBudgets.reduce<Record<string, {
        currency: string;
        limitAmountMinor: number;
        spentAmountMinor: number;
        reservedAmountMinor: number;
        availableAmountMinor: number;
      }>>((summary, entry) => {
        const currency = entry.balance.currency;
        const current = summary[currency] ?? {
          currency,
          limitAmountMinor: 0,
          spentAmountMinor: 0,
          reservedAmountMinor: 0,
          availableAmountMinor: 0,
        };
        current.limitAmountMinor = safeMinorTotal(
          current.limitAmountMinor,
          entry.balance.limitAmountMinor,
        );
        current.spentAmountMinor = safeMinorTotal(
          current.spentAmountMinor,
          entry.balance.spentAmountMinor,
        );
        current.reservedAmountMinor = safeMinorTotal(
          current.reservedAmountMinor,
          entry.balance.reservedAmountMinor,
        );
        current.availableAmountMinor = safeMinorTotal(
          current.availableAmountMinor,
          entry.balance.availableAmountMinor,
        );
        summary[currency] = current;
        return summary;
      }, {})),
      taskOverview: {
        available: false,
        reason: "Video task administration is delivered by WS-304.",
      },
    };
  }
}
