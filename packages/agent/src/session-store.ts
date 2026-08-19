import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TaskContextSchema, type TaskContext } from "@firefly/schemas";
import { Value } from "typebox/value";

export interface PersistedLocalSessionV1 {
  schemaVersion: 1;
  id: string;
  workId?: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  modelId: string;
  messages: AgentMessage[];
}

export interface PersistedLocalSession {
  schemaVersion: 2;
  id: string;
  taskContext?: TaskContext;
  createdAt: string;
  updatedAt: string;
  provider: string;
  modelId: string;
  messages: AgentMessage[];
}

export type LoadedLocalSession = PersistedLocalSessionV1 | PersistedLocalSession;

const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

export function assertLocalSessionId(sessionId: string): void {
  if (!sessionIdPattern.test(sessionId)) {
    throw new Error("Session ID must contain only letters, numbers, underscores, or hyphens.");
  }
}

function hasCommonSessionFields(record: Record<string, unknown>): boolean {
  return (
    typeof record.id === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.provider === "string" &&
    typeof record.modelId === "string" &&
    Array.isArray(record.messages)
  );
}

function isPersistedSession(value: unknown): value is LoadedLocalSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!hasCommonSessionFields(record)) return false;
  if (record.schemaVersion === 1) return record.workId === undefined || typeof record.workId === "string";
  return record.schemaVersion === 2 &&
    (record.taskContext === undefined || Value.Check(TaskContextSchema, record.taskContext));
}

export class LocalSessionStore {
  readonly #directory: string;

  constructor(
    directory: string,
    readonly enabled = true,
  ) {
    this.#directory = resolve(directory);
  }

  get directory(): string {
    return this.#directory;
  }

  #pathFor(sessionId: string): string {
    assertLocalSessionId(sessionId);
    const path = resolve(join(this.#directory, `${sessionId}.json`));
    if (!path.startsWith(`${this.#directory}${sep}`)) throw new Error("Session path escaped the configured data directory.");
    return path;
  }

  async load(sessionId: string): Promise<LoadedLocalSession | undefined> {
    if (!this.enabled) return undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#pathFor(sessionId), "utf8"));
      if (!isPersistedSession(parsed) || parsed.id !== sessionId) {
        throw new Error(`Session '${sessionId}' has an invalid persisted format.`);
      }
      return structuredClone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(session: PersistedLocalSession): Promise<void> {
    if (!this.enabled) return;
    await mkdir(this.#directory, { recursive: true });
    const target = this.#pathFor(session.id);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  async list(): Promise<LoadedLocalSession[]> {
    if (!this.enabled) return [];
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sessions: LoadedLocalSession[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const sessionId = entry.name.slice(0, -5);
      const session = await this.load(sessionId);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  async delete(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    await rm(this.#pathFor(sessionId), { force: true });
  }
}
