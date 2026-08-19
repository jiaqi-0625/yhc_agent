import { randomUUID } from "node:crypto";

import {
  addTemporaryAssetToProjectPool,
  assertCanManageBatchProjectAssets,
  assertCanViewBatchProject,
  registerTemporaryAsset,
  updateTemporaryAssetDeclaration,
  validateTemporaryAsset,
  type UpdateTemporaryAssetDeclarationCommand,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type { AssetCategory, BatchProject, ProjectAssetPool, TemporaryAsset } from "@firefly/schemas";

import {
  defaultProjectAssetCoordinator,
  type ProjectAssetCoordinator,
} from "./project-asset-coordinator.ts";
import type { ProjectAssetPoolStore } from "./project-asset-pool-store.ts";
import type { TemporaryAssetStore } from "./temporary-asset-store.ts";

/** File facts produced by a trusted upload inspector, never by request JSON. */
export interface TrustedTemporaryAssetInspection {
  fileName: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  checksumSha256: string;
}

/** Human declaration bound to the authenticated session by the runtime. */
export interface TemporaryAssetDeclaration {
  category: AssetCategory;
  sourceDescription: string;
  rightsDeclaration: string;
  rightsConfirmed: boolean;
  expiresAt?: string;
}

export type TemporaryAssetRuntimeErrorCode =
  | "AIC-ASSET-TEMPORARY-NOT-FOUND"
  | "AIC-ASSET-TEMPORARY-PERSISTED-SCOPE-INVALID"
  | "AIC-ASSET-POOL-NOT-FOUND";

export class TemporaryAssetRuntimeError extends Error {
  constructor(
    readonly code: TemporaryAssetRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TemporaryAssetRuntimeError";
  }
}

function assertPersistedProjectScope(
  assets: readonly TemporaryAsset[],
  project: Readonly<BatchProject>,
): void {
  if (
    assets.some(
      (asset) =>
        asset.tenantId !== project.tenantId ||
        asset.batchProjectId !== project.id ||
        asset.vehicleId !== project.vehicleId,
    )
  ) {
    throw new TemporaryAssetRuntimeError(
      "AIC-ASSET-TEMPORARY-PERSISTED-SCOPE-INVALID",
      "Persisted temporary assets do not match the authenticated project scope.",
    );
  }
}

function findAsset(assets: readonly TemporaryAsset[], assetId: string): TemporaryAsset {
  const asset = assets.find((candidate) => candidate.id === assetId);
  if (asset === undefined) {
    throw new TemporaryAssetRuntimeError(
      "AIC-ASSET-TEMPORARY-NOT-FOUND",
      `Temporary asset '${assetId}' was not found.`,
    );
  }
  return asset;
}

function replaceAsset(
  assets: readonly TemporaryAsset[],
  replacement: Readonly<TemporaryAsset>,
): TemporaryAsset[] {
  return assets.map((asset) =>
    asset.id === replacement.id ? structuredClone(replacement) : structuredClone(asset),
  );
}

export class TemporaryAssetRuntime {
  constructor(
    private readonly store: TemporaryAssetStore,
    private readonly poolStore: ProjectAssetPoolStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => `tmp_${randomUUID()}`,
    private readonly coordinator: ProjectAssetCoordinator = defaultProjectAssetCoordinator,
  ) {}

  async listTemporaryAssets(
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<TemporaryAsset[]> {
    assertCanViewBatchProject(session, project);
    const assets = await this.store.loadProject(project.id);
    assertPersistedProjectScope(assets, project);
    return structuredClone(assets);
  }

  async registerTemporaryAsset(
    project: Readonly<BatchProject>,
    inspection: Readonly<TrustedTemporaryAssetInspection>,
    declaration: Readonly<TemporaryAssetDeclaration>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<TemporaryAsset> {
    return this.coordinator.runExclusive(project.id, async () => {
      assertCanManageBatchProjectAssets(session, project);
      let created: TemporaryAsset | undefined;
      await this.store.transactProject(project.id, (current) => {
        assertPersistedProjectScope(current, project);
        created = registerTemporaryAsset(
          project,
          {
            category: declaration.category,
            fileName: inspection.fileName,
            mediaType: inspection.mediaType,
            byteSize: inspection.byteSize,
            width: inspection.width,
            height: inspection.height,
            checksumSha256: inspection.checksumSha256,
            sourceDescription: declaration.sourceDescription,
            rightsDeclaration: declaration.rightsDeclaration,
            rightsConfirmed: declaration.rightsConfirmed,
            ...(declaration.expiresAt === undefined
              ? {}
              : { expiresAt: declaration.expiresAt }),
          },
          {
            tenantId: session.tenantId,
            actorAccountId: session.actorAccountId,
            occurredAt: this.now(),
            createId: () => this.createId(),
          },
        );
        return [...current, created];
      });
      if (created === undefined) throw new Error("Temporary asset transaction did not run.");
      return structuredClone(created);
    });
  }

  async validateTemporaryAsset(
    project: Readonly<BatchProject>,
    assetId: string,
    expectedRevision: number,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<TemporaryAsset> {
    return this.coordinator.runExclusive(project.id, async () => {
      assertCanManageBatchProjectAssets(session, project);
      let validated: TemporaryAsset | undefined;
      await this.store.transactProject(project.id, (current) => {
        assertPersistedProjectScope(current, project);
        validated = validateTemporaryAsset(
          findAsset(current, assetId),
          project,
          current,
          expectedRevision,
          {
            tenantId: session.tenantId,
            actorAccountId: session.actorAccountId,
            occurredAt: this.now(),
            createId: () => this.createId(),
          },
        );
        return replaceAsset(current, validated);
      });
      if (validated === undefined) throw new Error("Temporary asset transaction did not run.");
      return structuredClone(validated);
    });
  }

  async updateDeclaration(
    project: Readonly<BatchProject>,
    assetId: string,
    command: Readonly<UpdateTemporaryAssetDeclarationCommand>,
    expectedRevision: number,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<TemporaryAsset> {
    return this.coordinator.runExclusive(project.id, async () => {
      assertCanManageBatchProjectAssets(session, project);
      let updated: TemporaryAsset | undefined;
      await this.store.transactProject(project.id, (current) => {
        assertPersistedProjectScope(current, project);
        updated = updateTemporaryAssetDeclaration(
          findAsset(current, assetId),
          project,
          command,
          expectedRevision,
          {
            tenantId: session.tenantId,
            actorAccountId: session.actorAccountId,
            occurredAt: this.now(),
            createId: () => this.createId(),
          },
        );
        return replaceAsset(current, updated);
      });
      if (updated === undefined) throw new Error("Temporary asset transaction did not run.");
      return structuredClone(updated);
    });
  }

  async addToProjectPool(
    project: Readonly<BatchProject>,
    assetId: string,
    expectedAssetRevision: number,
    expectedPoolRevision: number,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ProjectAssetPool> {
    return this.coordinator.runExclusive(project.id, async () => {
      assertCanManageBatchProjectAssets(session, project);
      const assets = await this.store.loadProject(project.id);
      assertPersistedProjectScope(assets, project);
      const asset = findAsset(assets, assetId);
      return this.poolStore.transact(project.id, (current) => {
        if (current === undefined) {
          throw new TemporaryAssetRuntimeError(
            "AIC-ASSET-POOL-NOT-FOUND",
            `Batch project '${project.id}' does not have an asset pool.`,
          );
        }
        return addTemporaryAssetToProjectPool(
          asset,
          project,
          current,
          expectedAssetRevision,
          expectedPoolRevision,
          {
            tenantId: session.tenantId,
            actorAccountId: session.actorAccountId,
            occurredAt: this.now(),
            createId: () => this.createId(),
          },
        ).pool;
      });
    });
  }
}
