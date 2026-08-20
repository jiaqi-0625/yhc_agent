import { createHash, randomUUID } from "node:crypto";

import {
  assertCanCreateBatchProject,
  assertCanViewBatchProject,
  createBatchProject,
  createProjectAssetPool,
  supportedProjectAspectRatios,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  Brand,
  CompanyAssetReference,
  CreateBatchProjectRequest,
  Vehicle,
  VehicleAssetAssociation,
} from "@firefly/schemas";
import type {
  CompanyAssetCatalogItem,
  CompanyAssetCatalogPage,
  CompanyAssetCatalogQuery,
  CompanyAssetProvider,
  CompanyAssetProviderScope,
} from "@firefly/tools";

import type {
  BatchProjectAggregate,
  BatchProjectStore,
} from "./batch-project-store.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import type {
  WorkspaceAdminState,
  WorkspaceAdminStore,
} from "./workspace-admin-store.ts";
import { hasUsableVehicleFacts } from "./vehicle-facts.ts";

function latestVehicles(versions: readonly Vehicle[]): Vehicle[] {
  const latest = new Map<string, Vehicle>();
  for (const vehicle of versions) {
    const current = latest.get(vehicle.id);
    if (!current || vehicle.version > current.version) latest.set(vehicle.id, vehicle);
  }
  return [...latest.values()];
}

function exactReferenceKey(reference: Readonly<CompanyAssetReference>): string {
  return `${reference.sourceProvider}:${reference.assetId}:${reference.version}:${reference.category}:` +
    (reference.category === "vehicle" ? reference.vehicleId : "");
}

function referenceIdentity(reference: Readonly<CompanyAssetReference>): string {
  return `${reference.sourceProvider}:${reference.assetId}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(input: Readonly<CreateBatchProjectRequest>): string {
  return createHash("sha256").update(canonicalJson({
    ...input,
    selectedAssets: [...input.selectedAssets].sort((left, right) =>
      exactReferenceKey(left).localeCompare(exactReferenceKey(right), "en")),
  })).digest("hex");
}

function error(code: string, message: string, statusCode: number): BusinessRuntimeError {
  return new BusinessRuntimeError(code, message, statusCode);
}

interface ProjectCreationSelection {
  state: WorkspaceAdminState;
  brand: Brand;
  vehicle: Vehicle;
  association?: VehicleAssetAssociation;
  providerScope: CompanyAssetProviderScope;
}

export class ProjectCreationRuntime {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly companyAssets: CompanyAssetProvider,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: (kind: "batch_project" | "project_asset_pool") => string =
      (kind) => `${kind}_${randomUUID()}`,
  ) {}

  #assertCreator(session: Readonly<WorkspaceSessionScope>): void {
    if (session.role !== "creator") {
      throw error(
        "AIC-AUTH-ROLE_DENIED",
        "Only an authorized production account can use project creation APIs.",
        403,
      );
    }
  }

  #currentScope(
    session: Readonly<WorkspaceSessionScope>,
    state: Readonly<WorkspaceAdminState>,
  ): WorkspaceSessionScope {
    return {
      actorAccountId: session.actorAccountId,
      tenantId: session.tenantId,
      role: session.role,
      accessGrants: state.accessGrants.filter(
        (grant) => grant.accountId === session.actorAccountId,
      ),
    };
  }

  #selectionFromState(
    vehicleId: string,
    session: Readonly<WorkspaceSessionScope>,
    state: Readonly<WorkspaceAdminState>,
  ): ProjectCreationSelection {
    const currentScope = this.#currentScope(session, state);
    const vehicle = latestVehicles(state.vehicleVersions).find((candidate) => candidate.id === vehicleId);
    if (!vehicle) {
      throw error(
        "AIC-PROJECT-CREATION-VEHICLE_NOT_FOUND",
        `Vehicle '${vehicleId}' was not found.`,
        404,
      );
    }
    const brand = state.brands.find((candidate) => candidate.id === vehicle.brandId);
    if (!brand) throw new Error("Workspace administration contains a vehicle without its brand.");
    assertCanCreateBatchProject(currentScope, brand, vehicle);
    if (brand.status !== "active" || vehicle.status !== "active") {
      throw error(
        "AIC-PROJECT-CREATION-RESOURCE_ARCHIVED",
        "Projects can only be created for active brands and vehicles.",
        409,
      );
    }
    if (!hasUsableVehicleFacts(vehicle)) {
      throw error(
        "AIC-PROJECT-CREATION-VEHICLE_FACTS_INVALID",
        "The selected vehicle does not have 1 to 20 usable, uniquely identified facts.",
        409,
      );
    }
    const association = state.vehicleAssetAssociations.find(
      (candidate) => candidate.vehicleId === vehicle.id,
    );
    return {
      state: structuredClone(state),
      brand,
      vehicle,
      ...(association === undefined ? {} : { association }),
      providerScope: {
        tenantId: session.tenantId,
        actorAccountId: session.actorAccountId,
        allowedBrandIds: [brand.id],
        allowedVehicleIds: [vehicle.id],
      },
    };
  }

  async #selection(
    vehicleId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ProjectCreationSelection> {
    this.#assertCreator(session);
    const state = await this.administration.load(session.tenantId);
    return this.#selectionFromState(vehicleId, session, state);
  }

  async getOptions(session: Readonly<WorkspaceSessionScope>) {
    this.#assertCreator(session);
    const state = await this.administration.load(session.tenantId);
    const grants = this.#currentScope(session, state).accessGrants.filter(
      (grant) =>
        grant.tenantId === session.tenantId &&
        grant.accountId === session.actorAccountId &&
        grant.status === "active" &&
        grant.access.kind === "vehicle_project",
    );
    const allowedVehicles = new Set(grants.map((grant) =>
      grant.access.kind === "vehicle_project"
        ? `${grant.access.brandId}:${grant.access.vehicleId}`
        : ""));
    const vehicles = latestVehicles(state.vehicleVersions).filter(
      (vehicle) =>
        vehicle.status === "active" &&
        hasUsableVehicleFacts(vehicle) &&
        allowedVehicles.has(`${vehicle.brandId}:${vehicle.id}`),
    );
    const brandIds = new Set(vehicles.map((vehicle) => vehicle.brandId));
    const brands = state.brands
      .filter((brand) => brand.status === "active" && brandIds.has(brand.id))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
      .map((brand) => ({
        id: brand.id,
        name: brand.name,
        revision: brand.revision,
        vehicles: vehicles
          .filter((vehicle) => vehicle.brandId === brand.id)
          .sort((left, right) => left.series.localeCompare(right.series, "zh-CN") ||
            left.trim.localeCompare(right.trim, "zh-CN"))
          .map((vehicle) => ({
            id: vehicle.id,
            brandId: vehicle.brandId,
            version: vehicle.version,
            series: vehicle.series,
            modelYear: vehicle.modelYear,
            trim: vehicle.trim,
            displayName: `${vehicle.series} ${vehicle.modelYear} ${vehicle.trim}`,
          })),
      }));
    return { brands, aspectRatios: [...supportedProjectAspectRatios] };
  }

  async #latestCatalogItems(
    selection: Readonly<ProjectCreationSelection>,
    categories?: CompanyAssetCatalogQuery["categories"],
  ): Promise<CompanyAssetCatalogItem[]> {
    const items: CompanyAssetCatalogItem[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.companyAssets.searchAssets(
        {
          brandId: selection.brand.id,
          vehicleId: selection.vehicle.id,
          ...(categories === undefined ? {} : { categories }),
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
        selection.providerScope,
      );
      items.push(...page.items.map((item) => structuredClone(item)));
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw error(
            "AIC-PROJECT-CREATION-ASSET_UNAVAILABLE",
            "The company asset catalog returned a repeated pagination cursor.",
            409,
          );
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    return items;
  }

  async #normalizeReferences(
    references: readonly CompanyAssetReference[],
    selection: Readonly<ProjectCreationSelection>,
  ): Promise<CompanyAssetReference[]> {
    if (references.some((reference) => reference.sourceProvider !== this.companyAssets.providerId)) {
      throw error(
        "AIC-PROJECT-CREATION-ASSET_UNAVAILABLE",
        "A selected asset belongs to a different company asset provider.",
        400,
      );
    }
    const identities = references.map(referenceIdentity);
    if (new Set(identities).size !== identities.length) {
      throw error(
        "AIC-PROJECT-CREATION-ASSET_DUPLICATE",
        "A project asset selection cannot contain duplicate company asset identities.",
        400,
      );
    }
    const resolved = await this.companyAssets.resolveAssets(references, selection.providerScope);
    const exact = new Set(resolved.items.map((item) => exactReferenceKey(item.reference)));
    if (
      resolved.missingReferences.length > 0 ||
      references.some((reference) => !exact.has(exactReferenceKey(reference)))
    ) {
      throw error(
        "AIC-PROJECT-CREATION-ASSET_UNAVAILABLE",
        "A selected company asset version is unavailable in the server-resolved scope.",
        400,
      );
    }
    const latest = await this.#latestCatalogItems(selection);
    const latestByIdentity = new Map(
      latest.map((item) => [referenceIdentity(item.reference), item.reference] as const),
    );
    return references.map((reference) => {
      const current = latestByIdentity.get(referenceIdentity(reference));
      if (
        !current ||
        current.category !== reference.category ||
        (reference.category === "vehicle" &&
          (current.category !== "vehicle" || current.vehicleId !== reference.vehicleId))
      ) {
        throw error(
          "AIC-PROJECT-CREATION-ASSET_UNAVAILABLE",
          "A selected company asset is no longer available for this brand and vehicle.",
          400,
        );
      }
      return structuredClone(current);
    });
  }

  #requiredAssociation(selection: Readonly<ProjectCreationSelection>): VehicleAssetAssociation {
    if (!selection.association) {
      throw error(
        "AIC-PROJECT-CREATION-ASSET_PACKAGE_MISSING",
        "The administrator has not configured a recommended asset package for this vehicle.",
        409,
      );
    }
    return selection.association;
  }

  async #defaultVisualStyle(
    selection: Readonly<ProjectCreationSelection>,
  ): Promise<CompanyAssetCatalogItem> {
    const styles = await this.#latestCatalogItems(selection, ["visual_style"]);
    const style = styles.find(
      (item) =>
        item.reference.category === "visual_style" &&
        item.reference.assetId === selection.brand.defaultVisualStylePresetId &&
        (item.brandIds.length === 0 || item.brandIds.includes(selection.brand.id)),
    );
    if (!style) {
      throw error(
        "AIC-PROJECT-CREATION-VISUAL_STYLE_UNAVAILABLE",
        "The brand default visual style is unavailable in the company asset catalog.",
        409,
      );
    }
    return style;
  }

  async getAssetPackage(
    vehicleId: string,
    session: Readonly<WorkspaceSessionScope>,
  ) {
    const selection = await this.#selection(vehicleId, session);
    const association = this.#requiredAssociation(selection);
    const normalized = await this.#normalizeReferences(
      association.assets.filter((reference) => reference.category !== "visual_style"),
      selection,
    );
    const assets = await this.companyAssets.resolveAssets(normalized, selection.providerScope);
    if (assets.missingReferences.length > 0 || assets.items.length !== normalized.length) {
      throw error(
        "AIC-PROJECT-CREATION-ASSET_UNAVAILABLE",
        "The recommended asset package could not be hydrated from the company catalog.",
        409,
      );
    }
    const selectableAssets = assets.items.filter((item) => item.reference.category !== "visual_style");
    if (!selectableAssets.some((item) => item.reference.category === "vehicle")) {
      throw error(
        "AIC-PROJECT-CREATION-VEHICLE_ASSET_REQUIRED",
        "The recommended asset package must contain at least one vehicle asset.",
        409,
      );
    }
    return {
      brand: selection.brand,
      vehicle: selection.vehicle,
      associationRevision: association.revision,
      recommendedAssets: selectableAssets,
      replacementPolicy: {
        lockedCategories: ["vehicle"],
        replaceableCategories: ["person", "scene"],
      },
    };
  }

  async getConfiguration(
    vehicleId: string,
    session: Readonly<WorkspaceSessionScope>,
  ) {
    const selection = await this.#selection(vehicleId, session);
    const association = this.#requiredAssociation(selection);
    return {
      brandRevision: selection.brand.revision,
      vehicleVersion: selection.vehicle.version,
      associationRevision: association.revision,
      defaultVisualStyle: await this.#defaultVisualStyle(selection),
      aspectRatios: [...supportedProjectAspectRatios],
    };
  }

  async searchReplacementAssets(
    vehicleId: string,
    query: Readonly<CompanyAssetCatalogQuery>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<CompanyAssetCatalogPage> {
    const selection = await this.#selection(vehicleId, session);
    const categories = query.categories ?? ["person", "scene"];
    if (categories.some((category) => category !== "person" && category !== "scene")) {
      throw error(
        "AIC-PROJECT-CREATION-REPLACEMENT_CATEGORY_DENIED",
        "Only person and scene assets can replace recommended project assets.",
        400,
      );
    }
    return this.companyAssets.searchAssets(
      {
        ...query,
        categories,
        brandId: selection.brand.id,
        vehicleId: selection.vehicle.id,
      },
      selection.providerScope,
    );
  }

  #assertExpectedCatalog(
    input: Readonly<CreateBatchProjectRequest>,
    selection: Readonly<ProjectCreationSelection>,
    association: Readonly<VehicleAssetAssociation>,
  ): void {
    if (
      input.expectedBrandRevision !== selection.brand.revision ||
      input.expectedVehicleVersion !== selection.vehicle.version ||
      input.expectedAssetAssociationRevision !== association.revision
    ) {
      throw error(
        "AIC-PROJECT-CREATION-CATALOG_STALE",
        "The brand, vehicle facts, or recommended asset package changed during project creation.",
        409,
      );
    }
  }

  async create(
    input: Readonly<CreateBatchProjectRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<BatchProjectAggregate & {
    vehicleFactSource: { vehicleId: string; vehicleVersion: number };
    replayed: boolean;
  }> {
    this.#assertCreator(session);
    const hash = payloadHash(input);
    const replay = await this.projects.loadByRequest(
      session.tenantId,
      session.actorAccountId,
      input.requestId,
    );
    if (replay) {
      await this.administration.withSnapshot(session.tenantId, (state) => {
        assertCanViewBatchProject(this.#currentScope(session, state), replay.project);
      });
      if (replay.payloadHash !== hash) {
        throw error(
          "AIC-PROJECT-CREATION-IDEMPOTENCY_CONFLICT",
          "The project creation request ID was already used with a different payload.",
          409,
        );
      }
      return {
        ...replay,
        replayed: true,
        vehicleFactSource: {
          vehicleId: input.vehicleId,
          vehicleVersion: input.expectedVehicleVersion,
        },
      };
    }

    const selection = await this.#selection(input.vehicleId, session);
    const association = this.#requiredAssociation(selection);
    this.#assertExpectedCatalog(input, selection, association);
    if (input.selectedAssets.some((reference) => reference.category === "visual_style")) {
      throw error(
        "AIC-PROJECT-CREATION-VISUAL_STYLE_LOCKED",
        "The brand visual style is inherited by the server and cannot be selected as a replacement.",
        400,
      );
    }
    const [recommended, selected, defaultVisualStyle] = await Promise.all([
      this.#normalizeReferences(
        association.assets.filter((reference) => reference.category !== "visual_style"),
        selection,
      ),
      this.#normalizeReferences(input.selectedAssets, selection),
      this.#defaultVisualStyle(selection),
    ]);
    if (selected.some((reference) =>
      reference.category !== "vehicle" && reference.category !== "person" && reference.category !== "scene")) {
      throw error(
        "AIC-PROJECT-CREATION-REPLACEMENT_CATEGORY_DENIED",
        "Only vehicle, person, and scene assets can enter the initial selection.",
        400,
      );
    }
    const requiredVehicleIdentities = new Set(
      recommended.filter((reference) => reference.category === "vehicle").map(referenceIdentity),
    );
    const selectedVehicleIdentities = new Set(
      selected.filter((reference) => reference.category === "vehicle").map(referenceIdentity),
    );
    if (
      requiredVehicleIdentities.size === 0 ||
      requiredVehicleIdentities.size !== selectedVehicleIdentities.size ||
      [...requiredVehicleIdentities].some((identity) => !selectedVehicleIdentities.has(identity))
    ) {
      throw error(
        "AIC-PROJECT-CREATION-VEHICLE_ASSETS_LOCKED",
        "Every recommended vehicle asset must remain selected and cannot be replaced.",
        400,
      );
    }

    const occurredAt = this.now();
    const project = createBatchProject(
      selection.brand,
      selection.vehicle,
      {
        batchName: input.batchName,
        aspectRatio: input.aspectRatio,
        ...(input.customStylePrompt === undefined
          ? {}
          : { customStylePrompt: input.customStylePrompt }),
      },
      {
        tenantId: session.tenantId,
        actorAccountId: session.actorAccountId,
        occurredAt,
        projectId: this.createId("batch_project"),
        assetPoolId: this.createId("project_asset_pool"),
      },
    );
    const finalAssets = [...selected, structuredClone(defaultVisualStyle.reference)];
    const assetPool = createProjectAssetPool(project, finalAssets, {
      tenantId: session.tenantId,
      actorAccountId: session.actorAccountId,
      occurredAt,
      createId: (kind) => {
        if (kind !== "project_asset_pool") throw new Error("Unexpected asset pool identity request.");
        return project.assetPoolId;
      },
    });

    let saved: BatchProjectAggregate;
    try {
      saved = await this.administration.withSnapshot(session.tenantId, async (state) => {
        const currentSelection = this.#selectionFromState(input.vehicleId, session, state);
        const currentAssociation = this.#requiredAssociation(currentSelection);
        this.#assertExpectedCatalog(input, currentSelection, currentAssociation);
        return this.projects.create(project, assetPool, {
          requestId: input.requestId,
          actorAccountId: session.actorAccountId,
          payloadHash: hash,
        });
      });
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : "Batch project creation failed.";
      if (message.includes("different payload")) {
        throw error("AIC-PROJECT-CREATION-IDEMPOTENCY_CONFLICT", message, 409);
      }
      if (message.includes("same name") || message.includes("same ID")) {
        throw error("AIC-PROJECT-CREATION-CONFLICT", message, 409);
      }
      throw caught;
    }
    return {
      ...saved,
      replayed: saved.project.id !== project.id,
      vehicleFactSource: {
        vehicleId: input.vehicleId,
        vehicleVersion: input.expectedVehicleVersion,
      },
    };
  }
}
