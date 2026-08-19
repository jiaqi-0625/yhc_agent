import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { ProjectAssetPoolSchema, type ProjectAssetPool } from "@firefly/schemas";
import { Value } from "typebox/value";

function assertBatchProjectId(batchProjectId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(batchProjectId)) {
    throw new Error("Batch project ID contains invalid characters.");
  }
}

export interface ProjectAssetPoolStore {
  load(batchProjectId: string): Promise<ProjectAssetPool | undefined>;
  transact(
    batchProjectId: string,
    update: (
      current: ProjectAssetPool | undefined,
    ) => ProjectAssetPool | Promise<ProjectAssetPool>,
  ): Promise<ProjectAssetPool>;
}

export class LocalProjectAssetPoolStore implements ProjectAssetPoolStore {
  readonly #directory: string;
  readonly #memory = new Map<string, ProjectAssetPool>();
  readonly #transactionTails = new Map<string, Promise<void>>();

  constructor(directory = ".data/project-asset-pools", readonly persist = true) {
    this.#directory = resolve(directory);
  }

  #path(batchProjectId: string): string {
    assertBatchProjectId(batchProjectId);
    const path = resolve(join(this.#directory, `${batchProjectId}.json`));
    if (!path.startsWith(`${this.#directory}${sep}`)) {
      throw new Error("Project asset pool path escaped the configured data directory.");
    }
    return path;
  }

  #validate(pool: Readonly<ProjectAssetPool>, batchProjectId: string): void {
    if (
      pool.batchProjectId !== batchProjectId ||
      !Value.Check(ProjectAssetPoolSchema, pool)
    ) {
      throw new Error("Persisted project asset pool has an invalid format or scope.");
    }
  }

  async load(batchProjectId: string): Promise<ProjectAssetPool | undefined> {
    assertBatchProjectId(batchProjectId);
    const memory = this.#memory.get(batchProjectId);
    if (memory) return structuredClone(memory);
    if (!this.persist) return undefined;
    try {
      const parsed = JSON.parse(
        await readFile(this.#path(batchProjectId), "utf8"),
      ) as ProjectAssetPool;
      this.#validate(parsed, batchProjectId);
      this.#memory.set(batchProjectId, structuredClone(parsed));
      return structuredClone(parsed);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #save(pool: Readonly<ProjectAssetPool>): Promise<void> {
    this.#validate(pool, pool.batchProjectId);
    const copy = structuredClone(pool);
    if (this.persist) {
      const path = this.#path(pool.batchProjectId);
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
    this.#memory.set(pool.batchProjectId, copy);
  }

  async transact(
    batchProjectId: string,
    update: (
      current: ProjectAssetPool | undefined,
    ) => ProjectAssetPool | Promise<ProjectAssetPool>,
  ): Promise<ProjectAssetPool> {
    assertBatchProjectId(batchProjectId);
    const previous = this.#transactionTails.get(batchProjectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.#transactionTails.set(batchProjectId, tail);
    await previous;
    try {
      const next = await update(await this.load(batchProjectId));
      this.#validate(next, batchProjectId);
      await this.#save(next);
      return structuredClone(next);
    } finally {
      release();
      if (this.#transactionTails.get(batchProjectId) === tail) {
        this.#transactionTails.delete(batchProjectId);
      }
    }
  }
}
