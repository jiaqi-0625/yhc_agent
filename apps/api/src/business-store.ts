import { rename, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { Strategy, StrategyApproval, VehicleSnapshot, Work } from "@firefly/schemas";

export interface LocalWorkRecord {
  schemaVersion: 1;
  work: Work;
  vehicleSnapshot: VehicleSnapshot;
  strategyVersions: Strategy[];
  approvals: StrategyApproval[];
}

function assertWorkId(workId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(workId)) throw new Error("Work ID contains invalid characters.");
}

export class LocalWorkStore {
  readonly #directory: string;
  readonly #memory = new Map<string, LocalWorkRecord>();

  constructor(directory = ".data/works", readonly persist = true) {
    this.#directory = resolve(directory);
  }

  #path(workId: string): string {
    assertWorkId(workId);
    const path = resolve(join(this.#directory, `${workId}.json`));
    if (!path.startsWith(`${this.#directory}${sep}`)) throw new Error("Work path escaped the configured data directory.");
    return path;
  }

  async load(workId: string): Promise<LocalWorkRecord | undefined> {
    const memory = this.#memory.get(workId);
    if (memory) return structuredClone(memory);
    if (!this.persist) return undefined;
    try {
      const parsed = JSON.parse(await readFile(this.#path(workId), "utf8")) as LocalWorkRecord;
      if (parsed.schemaVersion !== 1 || parsed.work.id !== workId) throw new Error("Persisted work has an invalid format.");
      this.#memory.set(workId, structuredClone(parsed));
      return structuredClone(parsed);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<LocalWorkRecord[]> {
    if (this.persist) {
      try {
        const names = await readdir(this.#directory);
        await Promise.all(
          names
            .filter((name) => name.endsWith(".json"))
            .map((name) => this.load(name.slice(0, -5))),
        );
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return [...this.#memory.values()].map((record) => structuredClone(record));
  }

  async save(record: LocalWorkRecord): Promise<void> {
    const copy = structuredClone(record);
    this.#memory.set(record.work.id, copy);
    if (!this.persist) return;
    const path = this.#path(record.work.id);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(copy, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
