import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  BrandSchema,
  VehicleSchema,
  VehicleAssetAssociationSchema,
  WorkspaceAccessGrantSchema,
  type Brand,
  type Vehicle,
  type VehicleAssetAssociation,
  type WorkspaceAccessGrant,
} from "@firefly/schemas";
import { Value } from "typebox/value";

import type { WorkspaceAccessGrantProvider } from "./workspace-session-runtime.ts";

export interface WorkspaceAdminState {
  schemaVersion: 1;
  tenantId: string;
  brands: Brand[];
  vehicleVersions: Vehicle[];
  vehicleAssetAssociations: VehicleAssetAssociation[];
  accessGrants: WorkspaceAccessGrant[];
}

export interface WorkspaceAdminSeed {
  brands?: readonly Brand[];
  vehicleVersions?: readonly Vehicle[];
  vehicleAssetAssociations?: readonly VehicleAssetAssociation[];
  accessGrants?: readonly WorkspaceAccessGrant[];
}

export interface WorkspaceAdminStore extends WorkspaceAccessGrantProvider {
  load(tenantId: string): Promise<WorkspaceAdminState>;
  withSnapshot<Result>(
    tenantId: string,
    inspect: (current: WorkspaceAdminState) => Result | Promise<Result>,
  ): Promise<Result>;
  transact(
    tenantId: string,
    update: (
      current: WorkspaceAdminState,
    ) => WorkspaceAdminState | Promise<WorkspaceAdminState>,
  ): Promise<WorkspaceAdminState>;
}

export function assertWorkspaceAdminIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
}

export function emptyWorkspaceAdminState(
  tenantId: string,
  seed: Readonly<WorkspaceAdminSeed>,
): WorkspaceAdminState {
  return {
    schemaVersion: 1,
    tenantId,
    brands: structuredClone(seed.brands?.filter((brand) => brand.tenantId === tenantId) ?? []),
    vehicleVersions: structuredClone(
      seed.vehicleVersions?.filter((vehicle) => vehicle.tenantId === tenantId) ?? [],
    ),
    vehicleAssetAssociations: structuredClone(
      seed.vehicleAssetAssociations?.filter((record) => record.tenantId === tenantId) ?? [],
    ),
    accessGrants: structuredClone(
      seed.accessGrants?.filter((grant) => grant.tenantId === tenantId) ?? [],
    ),
  };
}

export function validateWorkspaceAdminState(
  state: Readonly<WorkspaceAdminState>,
  tenantId: string,
): void {
  if (state.schemaVersion !== 1 || state.tenantId !== tenantId) {
    throw new Error("Persisted workspace administration state has an invalid tenant scope.");
  }
  if (
    state.brands.some(
      (brand) => brand.tenantId !== tenantId || !Value.Check(BrandSchema, brand),
    ) ||
    state.vehicleVersions.some(
      (vehicle) => vehicle.tenantId !== tenantId || !Value.Check(VehicleSchema, vehicle),
    ) ||
    state.vehicleAssetAssociations.some(
      (record) =>
        record.tenantId !== tenantId || !Value.Check(VehicleAssetAssociationSchema, record),
    ) ||
    state.accessGrants.some(
      (grant) => grant.tenantId !== tenantId || !Value.Check(WorkspaceAccessGrantSchema, grant),
    )
  ) {
    throw new Error("Persisted workspace administration state contains an invalid record.");
  }
  if (new Set(state.brands.map((brand) => brand.id)).size !== state.brands.length) {
    throw new Error("Workspace administration state contains duplicate brand IDs.");
  }
  const vehicleVersionKeys = state.vehicleVersions.map(
    (vehicle) => `${vehicle.id}:${vehicle.version}`,
  );
  if (new Set(vehicleVersionKeys).size !== vehicleVersionKeys.length) {
    throw new Error("Workspace administration state contains duplicate vehicle versions.");
  }
  if (new Set(state.accessGrants.map((grant) => grant.id)).size !== state.accessGrants.length) {
    throw new Error("Workspace administration state contains duplicate access grant IDs.");
  }
  const brands = new Set(state.brands.map((brand) => brand.id));
  const vehicleBrands = new Map<string, string>();
  const vehicleVersionNumbers = new Map<string, number[]>();
  for (const vehicle of state.vehicleVersions) {
    if (!brands.has(vehicle.brandId)) {
      throw new Error("Workspace administration state contains a vehicle without its brand.");
    }
    const knownBrand = vehicleBrands.get(vehicle.id);
    if (knownBrand !== undefined && knownBrand !== vehicle.brandId) {
      throw new Error("A vehicle identity cannot move between brands across fact versions.");
    }
    vehicleBrands.set(vehicle.id, vehicle.brandId);
    vehicleVersionNumbers.set(
      vehicle.id,
      [...(vehicleVersionNumbers.get(vehicle.id) ?? []), vehicle.version],
    );
  }
  for (const versions of vehicleVersionNumbers.values()) {
    const ordered = versions.sort((left, right) => left - right);
    if (ordered.some((version, index) => version !== index + 1)) {
      throw new Error("Vehicle fact versions must be contiguous and start at version one.");
    }
  }
  if (
    new Set(state.vehicleAssetAssociations.map((record) => record.vehicleId)).size !==
    state.vehicleAssetAssociations.length
  ) {
    throw new Error("Workspace administration state contains duplicate vehicle asset associations.");
  }
  for (const record of state.vehicleAssetAssociations) {
    if (vehicleBrands.get(record.vehicleId) !== record.brandId) {
      throw new Error("A vehicle asset association is outside its vehicle and brand scope.");
    }
  }
  for (const grant of state.accessGrants) {
    if (!brands.has(grant.access.brandId)) {
      throw new Error("A workspace access grant references an unknown brand.");
    }
    if (
      grant.access.kind === "vehicle_project" &&
      vehicleBrands.get(grant.access.vehicleId) !== grant.access.brandId
    ) {
      throw new Error("A vehicle-project grant is outside its vehicle and brand scope.");
    }
  }
  const activeGrantKeys = state.accessGrants
    .filter((grant) => grant.status === "active")
    .map((grant) =>
      `${grant.accountId}:${grant.access.kind}:${grant.access.brandId}:` +
      (grant.access.kind === "vehicle_project" ? grant.access.vehicleId : ""),
    );
  if (new Set(activeGrantKeys).size !== activeGrantKeys.length) {
    throw new Error("Workspace administration state contains duplicate active access grants.");
  }
}

export function validateWorkspaceAdminTransition(
  current: Readonly<WorkspaceAdminState>,
  next: Readonly<WorkspaceAdminState>,
): void {
  for (const historical of current.vehicleVersions) {
    const candidate = next.vehicleVersions.find(
      (vehicle) => vehicle.id === historical.id && vehicle.version === historical.version,
    );
    if (!candidate || JSON.stringify(candidate) !== JSON.stringify(historical)) {
      throw new Error("Persisted vehicle fact versions are immutable and cannot be removed or changed.");
    }
  }
}

export class LocalWorkspaceAdminStore implements WorkspaceAdminStore {
  readonly #directory: string;
  readonly #memory = new Map<string, WorkspaceAdminState>();
  readonly #transactionTails = new Map<string, Promise<void>>();

  constructor(
    directory = ".data/workspace-admin",
    private readonly seed: Readonly<WorkspaceAdminSeed> = {},
    readonly persist = true,
  ) {
    this.#directory = resolve(directory);
  }

  #path(tenantId: string): string {
    assertWorkspaceAdminIdentifier(tenantId, "Tenant ID");
    const path = resolve(join(this.#directory, `${tenantId}.json`));
    if (!path.startsWith(`${this.#directory}${sep}`)) {
      throw new Error("Workspace administration path escaped the configured data directory.");
    }
    return path;
  }

  async load(tenantId: string): Promise<WorkspaceAdminState> {
    assertWorkspaceAdminIdentifier(tenantId, "Tenant ID");
    const memory = this.#memory.get(tenantId);
    if (memory) return structuredClone(memory);
    let state: WorkspaceAdminState;
    if (!this.persist) {
      state = emptyWorkspaceAdminState(tenantId, this.seed);
    } else {
      try {
        state = JSON.parse(await readFile(this.#path(tenantId), "utf8")) as WorkspaceAdminState;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = emptyWorkspaceAdminState(tenantId, this.seed);
      }
    }
    validateWorkspaceAdminState(state, tenantId);
    this.#memory.set(tenantId, structuredClone(state));
    return structuredClone(state);
  }

  async #save(state: Readonly<WorkspaceAdminState>): Promise<void> {
    validateWorkspaceAdminState(state, state.tenantId);
    const copy = structuredClone(state);
    if (this.persist) {
      const path = this.#path(state.tenantId);
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(copy, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      try {
        await rename(temporaryPath, path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    }
    this.#memory.set(state.tenantId, copy);
  }

  async #exclusive<Result>(
    tenantId: string,
    operation: () => Result | Promise<Result>,
  ): Promise<Result> {
    assertWorkspaceAdminIdentifier(tenantId, "Tenant ID");
    const previous = this.#transactionTails.get(tenantId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.#transactionTails.set(tenantId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#transactionTails.get(tenantId) === tail) {
        this.#transactionTails.delete(tenantId);
      }
    }
  }

  async withSnapshot<Result>(
    tenantId: string,
    inspect: (current: WorkspaceAdminState) => Result | Promise<Result>,
  ): Promise<Result> {
    return this.#exclusive(tenantId, async () => inspect(await this.load(tenantId)));
  }

  async transact(
    tenantId: string,
    update: (
      current: WorkspaceAdminState,
    ) => WorkspaceAdminState | Promise<WorkspaceAdminState>,
  ): Promise<WorkspaceAdminState> {
    return this.#exclusive(tenantId, async () => {
      const current = await this.load(tenantId);
      const next = await update(structuredClone(current));
      validateWorkspaceAdminState(next, tenantId);
      validateWorkspaceAdminTransition(current, next);
      await this.#save(next);
      return structuredClone(next);
    });
  }

  async listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<readonly WorkspaceAccessGrant[]> {
    assertWorkspaceAdminIdentifier(accountId, "Account ID");
    const state = await this.load(tenantId);
    return structuredClone(
      state.accessGrants.filter((grant) => grant.accountId === accountId),
    );
  }
}
