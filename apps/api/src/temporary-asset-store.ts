import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  TemporaryAssetSchema,
  type TemporaryAsset,
} from "@firefly/schemas";
import { Type } from "typebox";
import { Value } from "typebox/value";

const TemporaryAssetProjectRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    batchProjectId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    }),
    assets: Type.Array(TemporaryAssetSchema),
  },
  { additionalProperties: false },
);

export interface TemporaryAssetProjectRecord {
  schemaVersion: 1;
  batchProjectId: string;
  assets: TemporaryAsset[];
}

export function assertTemporaryAssetProjectId(batchProjectId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(batchProjectId)) {
    throw new Error("Batch project ID contains invalid characters.");
  }
}

export function validateTemporaryAssets(
  assets: readonly TemporaryAsset[],
  batchProjectId: string,
): void {
  const ids = new Set<string>();
  for (const asset of assets) {
    if (
      asset.batchProjectId !== batchProjectId ||
      !Value.Check(TemporaryAssetSchema, asset) ||
      ids.has(asset.id)
    ) {
      throw new Error("Temporary assets have an invalid format, scope, or duplicate ID.");
    }
    ids.add(asset.id);
  }
}

export function validateTemporaryAssetProjectRecord(
  record: TemporaryAssetProjectRecord,
  batchProjectId: string,
): void {
  if (
    record.batchProjectId !== batchProjectId ||
    !Value.Check(TemporaryAssetProjectRecordSchema, record)
  ) {
    throw new Error("Persisted temporary assets have an invalid format or scope.");
  }
  validateTemporaryAssets(record.assets, batchProjectId);
}

export interface TemporaryAssetStore {
  loadProject(batchProjectId: string): Promise<TemporaryAsset[]>;
  transactProject(
    batchProjectId: string,
    update: (
      current: TemporaryAsset[],
    ) => TemporaryAsset[] | Promise<TemporaryAsset[]>,
  ): Promise<TemporaryAsset[]>;
}

export class LocalTemporaryAssetStore implements TemporaryAssetStore {
  readonly #directory: string;
  readonly #memory = new Map<string, TemporaryAsset[]>();
  readonly #transactionTails = new Map<string, Promise<void>>();

  constructor(directory = ".data/temporary-assets", readonly persist = true) {
    this.#directory = resolve(directory);
  }

  #path(batchProjectId: string): string {
    assertTemporaryAssetProjectId(batchProjectId);
    const path = resolve(join(this.#directory, `${batchProjectId}.json`));
    if (!path.startsWith(`${this.#directory}${sep}`)) {
      throw new Error("Temporary asset path escaped the configured data directory.");
    }
    return path;
  }

  async loadProject(batchProjectId: string): Promise<TemporaryAsset[]> {
    assertTemporaryAssetProjectId(batchProjectId);
    const memory = this.#memory.get(batchProjectId);
    if (memory) return structuredClone(memory);
    if (!this.persist) return [];
    try {
      const parsed = JSON.parse(
        await readFile(this.#path(batchProjectId), "utf8"),
      ) as TemporaryAssetProjectRecord;
      validateTemporaryAssetProjectRecord(parsed, batchProjectId);
      const assets = structuredClone(parsed.assets);
      this.#memory.set(batchProjectId, assets);
      return structuredClone(assets);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #saveProject(
    batchProjectId: string,
    assets: readonly TemporaryAsset[],
  ): Promise<void> {
    validateTemporaryAssets(assets, batchProjectId);
    const copy: TemporaryAsset[] = structuredClone([...assets]);
    if (this.persist) {
      const path = this.#path(batchProjectId);
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const record: TemporaryAssetProjectRecord = {
        schemaVersion: 1,
        batchProjectId,
        assets: copy,
      };
      await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
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
    this.#memory.set(batchProjectId, copy);
  }

  async transactProject(
    batchProjectId: string,
    update: (
      current: TemporaryAsset[],
    ) => TemporaryAsset[] | Promise<TemporaryAsset[]>,
  ): Promise<TemporaryAsset[]> {
    assertTemporaryAssetProjectId(batchProjectId);
    const previous =
      this.#transactionTails.get(batchProjectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.#transactionTails.set(batchProjectId, tail);
    await previous;
    try {
      const next = await update(await this.loadProject(batchProjectId));
      validateTemporaryAssets(next, batchProjectId);
      await this.#saveProject(batchProjectId, next);
      return structuredClone(next);
    } finally {
      release();
      if (this.#transactionTails.get(batchProjectId) === tail) {
        this.#transactionTails.delete(batchProjectId);
      }
    }
  }
}
