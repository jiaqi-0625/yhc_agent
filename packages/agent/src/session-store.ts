import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface PersistedLocalSession {
  schemaVersion: 1;
  id: string;
  workId?: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  modelId: string;
  messages: AgentMessage[];
}

const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

export function assertLocalSessionId(sessionId: string): void {
  if (!sessionIdPattern.test(sessionId)) {
    throw new Error("Session ID must contain only letters, numbers, underscores, or hyphens.");
  }
}

function isPersistedSession(value: unknown): value is PersistedLocalSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    (record.workId === undefined || typeof record.workId === "string") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.provider === "string" &&
    typeof record.modelId === "string" &&
    Array.isArray(record.messages)
  );
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

  async load(sessionId: string): Promise<PersistedLocalSession | undefined> {
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
    await writeFile(this.#pathFor(session.id), `${JSON.stringify(session, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async delete(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    await rm(this.#pathFor(sessionId), { force: true });
  }
}
