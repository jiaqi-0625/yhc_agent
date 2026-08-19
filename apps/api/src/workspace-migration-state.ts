import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export type WorkspaceMigrationStatus = "in_progress" | "completed" | "restored";

export interface WorkspaceMigrationStatusRecord {
  schemaVersion: 1;
  migrationId: string;
  status: WorkspaceMigrationStatus;
}

export interface WorkspaceMigrationStateSnapshot {
  inProgressMigrationIds: string[];
  completedMigrationIds: string[];
  restoredMigrationIds: string[];
}

export interface WorkspaceLifecycleLease {
  release(): Promise<void>;
}

interface ProcessLeaseRecord {
  schemaVersion: 1;
  pid: number;
  token: string;
  kind: "api" | "migration";
  migrationId?: string;
  acquiredAt: string;
}

const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const apiLeasePattern = /^api-(\d+)-([A-Fa-f0-9-]{36})\.json$/u;

function assertIdentifier(value: string, label: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${label} contains invalid characters.`);
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseProcessLease(value: unknown, expectedKind: ProcessLeaseRecord["kind"]): ProcessLeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace lifecycle lease has an invalid format.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== expectedKind ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.token !== "string" ||
    !/^[A-Fa-f0-9-]{36}$/u.test(record.token) ||
    typeof record.acquiredAt !== "string" ||
    (record.migrationId !== undefined &&
      (typeof record.migrationId !== "string" || !identifierPattern.test(record.migrationId)))
  ) {
    throw new Error("Workspace lifecycle lease has an invalid format.");
  }
  return record as unknown as ProcessLeaseRecord;
}

/**
 * Coordinates the API process and the offline Workspace V1 -> V2 migrator.
 * API processes may coexist with each other, while a migration lease is
 * globally exclusive. An in-progress manifest remains fail-closed after a
 * crashed migrator until an explicit resume or restore completes it.
 */
export class WorkspaceMigrationStateStore {
  readonly directory: string;
  readonly #apiLeaseDirectory: string;
  readonly #migrationLockDirectory: string;

  constructor(directory = ".data/workspace-migrations") {
    this.directory = resolve(directory);
    this.#apiLeaseDirectory = resolve(join(this.directory, ".api-leases"));
    this.#migrationLockDirectory = resolve(join(this.directory, ".migration.lock"));
    if (
      !this.#apiLeaseDirectory.startsWith(`${this.directory}${sep}`) ||
      !this.#migrationLockDirectory.startsWith(`${this.directory}${sep}`)
    ) {
      throw new Error("Workspace migration lifecycle paths escaped the configured directory.");
    }
  }

  manifestPath(migrationId: string): string {
    assertIdentifier(migrationId, "Migration ID");
    const path = resolve(join(this.directory, migrationId, "manifest.json"));
    if (!path.startsWith(`${this.directory}${sep}`)) {
      throw new Error("Workspace migration manifest path escaped the configured directory.");
    }
    return path;
  }

  async inspect(): Promise<WorkspaceMigrationStateSnapshot> {
    const snapshot: WorkspaceMigrationStateSnapshot = {
      inProgressMigrationIds: [],
      completedMigrationIds: [],
      restoredMigrationIds: [],
    };
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || !identifierPattern.test(entry.name)) {
        continue;
      }
      const path = this.manifestPath(entry.name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`Workspace migration manifest '${entry.name}' cannot be read.`, {
          cause: error,
        });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Workspace migration manifest '${entry.name}' has an invalid format.`);
      }
      const record = parsed as Record<string, unknown>;
      if (
        record.schemaVersion !== 1 ||
        record.migrationId !== entry.name ||
        !["in_progress", "completed", "restored"].includes(String(record.status))
      ) {
        throw new Error(`Workspace migration manifest '${entry.name}' has an invalid format.`);
      }
      if (record.status === "in_progress") snapshot.inProgressMigrationIds.push(entry.name);
      if (record.status === "completed") snapshot.completedMigrationIds.push(entry.name);
      if (record.status === "restored") snapshot.restoredMigrationIds.push(entry.name);
    }
    snapshot.inProgressMigrationIds.sort((left, right) => left.localeCompare(right, "en"));
    snapshot.completedMigrationIds.sort((left, right) => left.localeCompare(right, "en"));
    snapshot.restoredMigrationIds.sort((left, right) => left.localeCompare(right, "en"));
    return snapshot;
  }

  async assertApiCanStart(): Promise<WorkspaceMigrationStateSnapshot> {
    const state = await this.inspect();
    if (state.inProgressMigrationIds.length > 0) {
      throw new Error(
        `Workspace migration is incomplete (${state.inProgressMigrationIds.join(", ")}); ` +
        "resume or restore it before starting the API.",
      );
    }
    return state;
  }

  async #migrationLockExists(): Promise<boolean> {
    try {
      return (await stat(this.#migrationLockDirectory)).isDirectory();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async acquireApiLease(): Promise<WorkspaceLifecycleLease> {
    await this.assertApiCanStart();
    if (await this.#migrationLockExists()) {
      throw new Error("An offline workspace migration currently owns the data lifecycle lock.");
    }
    await mkdir(this.#apiLeaseDirectory, { recursive: true });
    const token = randomUUID();
    const path = resolve(join(this.#apiLeaseDirectory, `api-${process.pid}-${token}.json`));
    if (!path.startsWith(`${this.#apiLeaseDirectory}${sep}`)) {
      throw new Error("Workspace API lease path escaped the configured directory.");
    }
    const lease: ProcessLeaseRecord = {
      schemaVersion: 1,
      pid: process.pid,
      token,
      kind: "api",
      acquiredAt: new Date().toISOString(),
    };
    await writeFile(path, `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      // Close the race where a migrator creates the exclusive directory after
      // the first check but before this API lease becomes visible.
      await this.assertApiCanStart();
      if (await this.#migrationLockExists()) {
        throw new Error("An offline workspace migration currently owns the data lifecycle lock.");
      }
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await unlink(path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      },
    };
  }

  async #activeApiLeases(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.#apiLeaseDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const active: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new Error("Workspace API lease directory contains an unexpected entry.");
      }
      const match = apiLeasePattern.exec(entry.name);
      if (!match) throw new Error("Workspace API lease directory contains an invalid lease name.");
      const path = resolve(join(this.#apiLeaseDirectory, entry.name));
      if (!path.startsWith(`${this.#apiLeaseDirectory}${sep}`)) {
        throw new Error("Workspace API lease path escaped the configured directory.");
      }
      const lease = parseProcessLease(JSON.parse(await readFile(path, "utf8")) as unknown, "api");
      if (lease.pid !== Number(match[1]) || lease.token !== match[2]) {
        throw new Error("Workspace API lease identity does not match its file name.");
      }
      if (isProcessAlive(lease.pid)) {
        active.push(entry.name);
      } else {
        await unlink(path);
      }
    }
    return active.sort((left, right) => left.localeCompare(right, "en"));
  }

  async #removeStaleMigrationLock(): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(this.#migrationLockDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (entries.length !== 1 || entries[0]?.name !== "owner.json" || !entries[0].isFile()) {
      throw new Error("Workspace migration lifecycle lock has an invalid format.");
    }
    const ownerPath = join(this.#migrationLockDirectory, "owner.json");
    const owner = parseProcessLease(JSON.parse(await readFile(ownerPath, "utf8")) as unknown, "migration");
    if (isProcessAlive(owner.pid)) return false;
    await unlink(ownerPath);
    await rmdir(this.#migrationLockDirectory);
    return true;
  }

  async acquireMigrationLease(migrationId: string): Promise<WorkspaceLifecycleLease> {
    assertIdentifier(migrationId, "Migration ID");
    await mkdir(this.directory, { recursive: true });
    while (true) {
      try {
        await mkdir(this.#migrationLockDirectory);
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await this.#removeStaleMigrationLock())) {
          throw new Error("Another workspace migration currently owns the data lifecycle lock.");
        }
      }
    }
    const token = randomUUID();
    const ownerPath = join(this.#migrationLockDirectory, "owner.json");
    const owner: ProcessLeaseRecord = {
      schemaVersion: 1,
      pid: process.pid,
      token,
      kind: "migration",
      migrationId,
      acquiredAt: new Date().toISOString(),
    };
    try {
      await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
      const activeApiLeases = await this.#activeApiLeases();
      if (activeApiLeases.length > 0) {
        throw new Error(
          `The API is still using workspace data (${activeApiLeases.length} active lease(s)); stop it before migrating.`,
        );
      }
    } catch (error) {
      await unlink(ownerPath).catch(() => undefined);
      await rmdir(this.#migrationLockDirectory).catch(() => undefined);
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const persisted = parseProcessLease(
          JSON.parse(await readFile(ownerPath, "utf8")) as unknown,
          "migration",
        );
        if (persisted.pid !== process.pid || persisted.token !== token) {
          throw new Error("Workspace migration lifecycle lock ownership was lost.");
        }
        await unlink(ownerPath);
        await rmdir(this.#migrationLockDirectory);
      },
    };
  }
}
