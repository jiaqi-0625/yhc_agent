import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  BatchProjectSchema,
  ProjectAssetPoolSchema,
  type BatchProject,
  type ProjectAssetPool,
} from "@firefly/schemas";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { ProjectAssetPoolStore } from "./project-asset-pool-store.ts";

const LegacyBatchProjectSchema = Type.Omit(BatchProjectSchema, ["vehicleVersion"]);

const StoredBatchProjectAggregateV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    requestId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    }),
    actorAccountId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    }),
    payloadHash: Type.String({ minLength: 1, maxLength: 128 }),
    project: LegacyBatchProjectSchema,
    assetPool: ProjectAssetPoolSchema,
  },
  { additionalProperties: false },
);

const StoredBatchProjectAggregateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    requestId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    }),
    actorAccountId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    }),
    payloadHash: Type.String({ minLength: 1, maxLength: 128 }),
    project: BatchProjectSchema,
    assetPool: ProjectAssetPoolSchema,
  },
  { additionalProperties: false },
);

interface StoredBatchProjectAggregate extends BatchProjectAggregate {
  schemaVersion: 2;
}

export interface BatchProjectAggregate {
  requestId: string;
  actorAccountId: string;
  payloadHash: string;
  project: BatchProject;
  assetPool: ProjectAssetPool;
}

export interface BatchProjectCreateMetadata {
  requestId: string;
  actorAccountId: string;
  payloadHash: string;
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim();
}

function validateAggregate(
  aggregate: Readonly<BatchProjectAggregate>,
  tenantId: string,
  projectId: string,
): void {
  const { project, assetPool } = aggregate;
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(aggregate.requestId) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(aggregate.actorAccountId) ||
    aggregate.payloadHash.length < 1 ||
    aggregate.payloadHash.length > 128 ||
    project.tenantId !== tenantId ||
    project.id !== projectId ||
    !Value.Check(BatchProjectSchema, project) ||
    !Value.Check(ProjectAssetPoolSchema, assetPool) ||
    project.assetPoolId !== assetPool.id ||
    project.id !== assetPool.batchProjectId ||
    project.tenantId !== assetPool.tenantId ||
    project.vehicleId !== assetPool.vehicleId
  ) {
    throw new Error("Batch project aggregate has an invalid format or scope.");
  }
}

export interface BatchProjectStore {
  load(tenantId: string, projectId: string): Promise<BatchProjectAggregate | undefined>;
  loadByProjectId(projectId: string): Promise<BatchProjectAggregate | undefined>;
  loadByRequest(
    tenantId: string,
    actorAccountId: string,
    requestId: string,
  ): Promise<BatchProjectAggregate | undefined>;
  list(tenantId: string): Promise<BatchProjectAggregate[]>;
  create(
    project: Readonly<BatchProject>,
    assetPool: Readonly<ProjectAssetPool>,
    metadata: Readonly<BatchProjectCreateMetadata>,
  ): Promise<BatchProjectAggregate>;
  transactAssetPool(
    tenantId: string,
    projectId: string,
    update: (
      current: ProjectAssetPool,
    ) => ProjectAssetPool | Promise<ProjectAssetPool>,
  ): Promise<ProjectAssetPool>;
}

export class LocalBatchProjectStore implements BatchProjectStore {
  readonly #directory: string;
  readonly #memory = new Map<string, BatchProjectAggregate>();
  readonly #transactionTails = new Map<string, Promise<void>>();

  constructor(directory = ".data/batch-projects", readonly persist = true) {
    this.#directory = resolve(directory);
  }

  #key(tenantId: string, projectId: string): string {
    assertIdentifier(tenantId, "Tenant ID");
    assertIdentifier(projectId, "Batch project ID");
    return `${tenantId}:${projectId}`;
  }

  #tenantDirectory(tenantId: string): string {
    assertIdentifier(tenantId, "Tenant ID");
    const directory = resolve(join(this.#directory, tenantId));
    if (!directory.startsWith(`${this.#directory}${sep}`)) {
      throw new Error("Batch project path escaped the configured data directory.");
    }
    return directory;
  }

  #path(tenantId: string, projectId: string): string {
    this.#key(tenantId, projectId);
    const path = resolve(join(this.#tenantDirectory(tenantId), `${projectId}.json`));
    if (!path.startsWith(`${this.#directory}${sep}`)) {
      throw new Error("Batch project path escaped the configured data directory.");
    }
    return path;
  }

  async #read(
    tenantId: string,
    projectId: string,
  ): Promise<BatchProjectAggregate | undefined> {
    try {
      const persisted = JSON.parse(
        await readFile(this.#path(tenantId, projectId), "utf8"),
      ) as unknown;
      if (Value.Check(StoredBatchProjectAggregateV1Schema, persisted)) {
        throw new Error(
          "Persisted batch project requires an explicit vehicle fact version migration.",
        );
      }
      if (!Value.Check(StoredBatchProjectAggregateSchema, persisted)) {
        throw new Error("Persisted batch project aggregate has an invalid format or scope.");
      }
      const stored = persisted as StoredBatchProjectAggregate;
      validateAggregate(stored, tenantId, projectId);
      const { schemaVersion: _schemaVersion, ...aggregate } = stored;
      return aggregate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async load(
    tenantId: string,
    projectId: string,
  ): Promise<BatchProjectAggregate | undefined> {
    const key = this.#key(tenantId, projectId);
    const memory = this.#memory.get(key);
    if (memory !== undefined) return structuredClone(memory);
    if (!this.persist) return undefined;
    const aggregate = await this.#read(tenantId, projectId);
    if (aggregate === undefined) return undefined;
    this.#memory.set(key, structuredClone(aggregate));
    return structuredClone(aggregate);
  }

  async loadByProjectId(
    projectId: string,
  ): Promise<BatchProjectAggregate | undefined> {
    assertIdentifier(projectId, "Batch project ID");
    const aggregates = new Map<string, BatchProjectAggregate>();
    for (const aggregate of this.#memory.values()) {
      if (aggregate.project.id === projectId) {
        aggregates.set(aggregate.project.tenantId, structuredClone(aggregate));
      }
    }
    if (this.persist) {
      try {
        const entries = await readdir(this.#directory, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/u.test(entry.name)) {
            continue;
          }
          const aggregate = await this.#read(entry.name, projectId);
          if (aggregate !== undefined) {
            aggregates.set(aggregate.project.tenantId, aggregate);
          }
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (aggregates.size > 1) {
      throw new Error("Batch project ID is ambiguous across tenants.");
    }
    const aggregate = aggregates.values().next().value as
      | BatchProjectAggregate
      | undefined;
    return aggregate === undefined ? undefined : structuredClone(aggregate);
  }

  async list(tenantId: string): Promise<BatchProjectAggregate[]> {
    assertIdentifier(tenantId, "Tenant ID");
    const aggregates = new Map<string, BatchProjectAggregate>();
    if (this.persist) {
      try {
        const entries = await readdir(this.#tenantDirectory(tenantId), {
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const projectId = entry.name.slice(0, -".json".length);
          assertIdentifier(projectId, "Batch project ID");
          const aggregate = await this.#read(tenantId, projectId);
          if (aggregate !== undefined) aggregates.set(aggregate.project.id, aggregate);
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const aggregate of this.#memory.values()) {
      if (aggregate.project.tenantId === tenantId) {
        aggregates.set(aggregate.project.id, structuredClone(aggregate));
      }
    }

    const names = new Set<string>();
    const requestKeys = new Set<string>();
    const result = [...aggregates.values()].sort((left, right) =>
      left.project.id.localeCompare(right.project.id, "en"),
    );
    for (const aggregate of result) {
      const name = normalizedName(aggregate.project.name);
      if (names.has(name)) {
        throw new Error("Persisted batch projects contain a duplicate name.");
      }
      names.add(name);
      const requestKey = `${aggregate.actorAccountId}:${aggregate.requestId}`;
      if (requestKeys.has(requestKey)) {
        throw new Error("Persisted batch projects contain a duplicate creation request.");
      }
      requestKeys.add(requestKey);
    }
    return structuredClone(result);
  }

  async loadByRequest(
    tenantId: string,
    actorAccountId: string,
    requestId: string,
  ): Promise<BatchProjectAggregate | undefined> {
    assertIdentifier(tenantId, "Tenant ID");
    assertIdentifier(actorAccountId, "Actor account ID");
    assertIdentifier(requestId, "Request ID");
    const aggregate = (await this.list(tenantId)).find(
      (current) =>
        current.actorAccountId === actorAccountId && current.requestId === requestId,
    );
    return aggregate === undefined ? undefined : structuredClone(aggregate);
  }

  async #save(aggregate: Readonly<BatchProjectAggregate>): Promise<void> {
    validateAggregate(aggregate, aggregate.project.tenantId, aggregate.project.id);
    const copy = structuredClone(aggregate);
    if (this.persist) {
      const path = this.#path(copy.project.tenantId, copy.project.id);
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const stored: StoredBatchProjectAggregate = { schemaVersion: 2, ...copy };
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
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
    this.#memory.set(this.#key(copy.project.tenantId, copy.project.id), copy);
  }

  async #transact<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    assertIdentifier(tenantId, "Tenant ID");
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

  async create(
    project: Readonly<BatchProject>,
    assetPool: Readonly<ProjectAssetPool>,
    metadata: Readonly<BatchProjectCreateMetadata>,
  ): Promise<BatchProjectAggregate> {
    this.#key(project.tenantId, project.id);
    assertIdentifier(metadata.actorAccountId, "Actor account ID");
    assertIdentifier(metadata.requestId, "Request ID");
    const candidate = structuredClone({ ...metadata, project, assetPool });
    validateAggregate(candidate, project.tenantId, project.id);
    return this.#transact(candidate.project.tenantId, async () => {
      const existing = await this.list(candidate.project.tenantId);
      const replay = existing.find(
        (current) =>
          current.actorAccountId === candidate.actorAccountId &&
          current.requestId === candidate.requestId,
      );
      if (replay !== undefined) {
        if (replay.payloadHash !== candidate.payloadHash) {
          throw new Error("Batch project creation request conflicts with a different payload.");
        }
        return structuredClone(replay);
      }
      if (existing.some(({ project: current }) => current.id === candidate.project.id)) {
        throw new Error("A batch project with the same ID already exists.");
      }
      const name = normalizedName(candidate.project.name);
      if (
        existing.some(({ project: current }) => normalizedName(current.name) === name)
      ) {
        throw new Error("A batch project with the same name already exists.");
      }
      await this.#save(candidate);
      return structuredClone(candidate);
    });
  }

  async transactAssetPool(
    tenantId: string,
    projectId: string,
    update: (
      current: ProjectAssetPool,
    ) => ProjectAssetPool | Promise<ProjectAssetPool>,
  ): Promise<ProjectAssetPool> {
    this.#key(tenantId, projectId);
    return this.#transact(tenantId, async () => {
      const current = await this.load(tenantId, projectId);
      if (current === undefined) throw new Error("Batch project was not found.");
      const nextPool = await update(structuredClone(current.assetPool));
      const next = { ...current, project: current.project, assetPool: nextPool };
      validateAggregate(next, tenantId, projectId);
      await this.#save(next);
      return structuredClone(nextPool);
    });
  }
}

/**
 * Presents an aggregate-backed asset pool through the pre-existing asset-pool
 * store contract. Project IDs must resolve to exactly one tenant because that
 * contract predates tenant-aware aggregate storage.
 */
export class BatchProjectAssetPoolStoreAdapter implements ProjectAssetPoolStore {
  constructor(private readonly projects: BatchProjectStore) {}

  async load(batchProjectId: string): Promise<ProjectAssetPool | undefined> {
    const aggregate = await this.projects.loadByProjectId(batchProjectId);
    return aggregate === undefined ? undefined : structuredClone(aggregate.assetPool);
  }

  async transact(
    batchProjectId: string,
    update: (
      current: ProjectAssetPool | undefined,
    ) => ProjectAssetPool | Promise<ProjectAssetPool>,
  ): Promise<ProjectAssetPool> {
    const aggregate = await this.projects.loadByProjectId(batchProjectId);
    if (aggregate === undefined) throw new Error("Batch project was not found.");
    return this.projects.transactAssetPool(
      aggregate.project.tenantId,
      batchProjectId,
      update,
    );
  }
}
