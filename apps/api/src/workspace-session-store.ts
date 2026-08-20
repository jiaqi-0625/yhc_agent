import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_-]+$",
});
const IsoDateTimeSchema = Type.String({ format: "date-time" });

const WorkspaceSessionRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sessionId: IdentifierSchema,
    accountId: IdentifierSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    signedOutAt: Type.Optional(IsoDateTimeSchema),
  },
  { additionalProperties: false },
);

const StoredWorkspaceSessionRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sessionIdHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    accountId: IdentifierSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    signedOutAt: Type.Optional(IsoDateTimeSchema),
  },
  { additionalProperties: false },
);

const WorkspaceSessionFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sessions: Type.Array(StoredWorkspaceSessionRecordSchema),
  },
  { additionalProperties: false },
);

export interface WorkspaceSessionRecord {
  schemaVersion: 1;
  sessionId: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
  signedOutAt?: string;
}

interface WorkspaceSessionFile {
  schemaVersion: 1;
  sessions: StoredWorkspaceSessionRecord[];
}

export interface StoredWorkspaceSessionRecord {
  schemaVersion: 1;
  sessionIdHash: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
  signedOutAt?: string;
}

export function assertWorkspaceSessionIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
}

export function workspaceSessionTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date-time.`);
  return parsed;
}

export function validateWorkspaceSession(session: Readonly<WorkspaceSessionRecord>): void {
  if (!Value.Check(WorkspaceSessionRecordSchema, session)) {
    throw new Error("Workspace session has an invalid format.");
  }
  const createdAt = workspaceSessionTimestamp(session.createdAt, "Session creation time");
  const expiresAt = workspaceSessionTimestamp(session.expiresAt, "Session expiry time");
  if (expiresAt <= createdAt) {
    throw new Error("Workspace session expiry must be after its creation time.");
  }
  if (
    session.signedOutAt !== undefined &&
    workspaceSessionTimestamp(session.signedOutAt, "Session sign-out time") < createdAt
  ) {
    throw new Error("Workspace session sign-out cannot precede its creation time.");
  }
}

export function validateStoredWorkspaceSession(
  session: Readonly<StoredWorkspaceSessionRecord>,
): void {
  if (!Value.Check(StoredWorkspaceSessionRecordSchema, session)) {
    throw new Error("Persisted workspace session has an invalid format.");
  }
  const { sessionIdHash: _sessionIdHash, ...record } = session;
  validateWorkspaceSession({ ...record, sessionId: "session_persisted_digest" });
}

export function workspaceSessionIdHash(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

export function hydrateWorkspaceSession(
  sessionId: string,
  stored: Readonly<StoredWorkspaceSessionRecord>,
): WorkspaceSessionRecord {
  const { sessionIdHash: _sessionIdHash, ...record } = structuredClone(stored);
  return { ...record, sessionId };
}

export interface WorkspaceSessionStore {
  create(accountId: string, expiresAt: string): Promise<WorkspaceSessionRecord>;
  load(sessionId: string): Promise<WorkspaceSessionRecord | undefined>;
  loadActive(
    sessionId: string,
    occurredAt?: string,
  ): Promise<WorkspaceSessionRecord | undefined>;
  signOut(sessionId: string): Promise<WorkspaceSessionRecord | undefined>;
}

export class LocalWorkspaceSessionStore implements WorkspaceSessionStore {
  readonly #directory: string;
  readonly #path: string;
  readonly #sessions = new Map<string, StoredWorkspaceSessionRecord>();
  #loaded = false;
  #transactionTail: Promise<void> = Promise.resolve();

  constructor(
    directory = ".data/workspace-sessions",
    readonly persist = true,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createSessionId: () => string = () =>
      `session_${randomBytes(32).toString("base64url")}`,
  ) {
    this.#directory = resolve(directory);
    this.#path = resolve(join(this.#directory, "sessions.json"));
    if (!this.#path.startsWith(`${this.#directory}${sep}`)) {
      throw new Error("Workspace session path escaped the configured data directory.");
    }
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    if (!this.persist) {
      this.#loaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(
        await readFile(this.#path, "utf8"),
      ) as WorkspaceSessionFile;
      if (!Value.Check(WorkspaceSessionFileSchema, parsed)) {
        throw new Error("Persisted workspace sessions have an invalid format.");
      }
      const ids = new Set<string>();
      for (const session of parsed.sessions) {
        validateStoredWorkspaceSession(session);
        if (ids.has(session.sessionIdHash)) {
          throw new Error("Persisted workspace sessions contain a duplicate ID.");
        }
        ids.add(session.sessionIdHash);
      }
      for (const session of parsed.sessions) {
        this.#sessions.set(session.sessionIdHash, structuredClone(session));
      }
      this.#loaded = true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#loaded = true;
        return;
      }
      throw error;
    }
  }

  async #save(): Promise<void> {
    const sessions = [...this.#sessions.values()].map((session) => {
      validateStoredWorkspaceSession(session);
      return structuredClone(session);
    });
    if (this.persist) {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporaryPath = `${this.#path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
      const record: WorkspaceSessionFile = { schemaVersion: 1, sessions };
      await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      try {
        await rename(temporaryPath, this.#path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    }
  }

  async #transact<T>(update: () => Promise<T>): Promise<T> {
    const previous = this.#transactionTail;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    this.#transactionTail = previous.then(() => gate);
    await previous;
    try {
      await this.#ensureLoaded();
      return await update();
    } finally {
      release();
    }
  }

  async create(
    accountId: string,
    expiresAt: string,
  ): Promise<WorkspaceSessionRecord> {
    assertWorkspaceSessionIdentifier(accountId, "Account ID");
    return this.#transact(async () => {
      const createdAt = this.now();
      const sessionId = this.createSessionId();
      assertWorkspaceSessionIdentifier(sessionId, "Session ID");
      const digest = workspaceSessionIdHash(sessionId);
      if (this.#sessions.has(digest)) {
        throw new Error("Workspace session ID collision.");
      }
      const session: WorkspaceSessionRecord = {
        schemaVersion: 1,
        sessionId,
        accountId,
        createdAt,
        expiresAt,
      };
      validateWorkspaceSession(session);
      const stored: StoredWorkspaceSessionRecord = {
        schemaVersion: 1,
        sessionIdHash: digest,
        accountId,
        createdAt,
        expiresAt,
      };
      this.#sessions.set(digest, stored);
      try {
        await this.#save();
      } catch (error) {
        this.#sessions.delete(digest);
        throw error;
      }
      return structuredClone(session);
    });
  }

  async load(sessionId: string): Promise<WorkspaceSessionRecord | undefined> {
    assertWorkspaceSessionIdentifier(sessionId, "Session ID");
    await this.#ensureLoaded();
    const session = this.#sessions.get(workspaceSessionIdHash(sessionId));
    return session === undefined ? undefined : hydrateWorkspaceSession(sessionId, session);
  }

  async loadActive(
    sessionId: string,
    occurredAt = this.now(),
  ): Promise<WorkspaceSessionRecord | undefined> {
    const session = await this.load(sessionId);
    const occurredAtTimestamp = workspaceSessionTimestamp(occurredAt, "Session resolution time");
    if (
      session === undefined ||
      session.signedOutAt !== undefined ||
      occurredAtTimestamp >= workspaceSessionTimestamp(session.expiresAt, "Session expiry time")
    ) {
      return undefined;
    }
    return structuredClone(session);
  }

  async signOut(sessionId: string): Promise<WorkspaceSessionRecord | undefined> {
    assertWorkspaceSessionIdentifier(sessionId, "Session ID");
    return this.#transact(async () => {
      const digest = workspaceSessionIdHash(sessionId);
      const current = this.#sessions.get(digest);
      if (current === undefined) return undefined;
      if (current.signedOutAt !== undefined) {
        return hydrateWorkspaceSession(sessionId, current);
      }
      const updated: StoredWorkspaceSessionRecord = {
        ...structuredClone(current),
        signedOutAt: this.now(),
      };
      validateStoredWorkspaceSession(updated);
      this.#sessions.set(digest, updated);
      try {
        await this.#save();
      } catch (error) {
        this.#sessions.set(digest, current);
        throw error;
      }
      return hydrateWorkspaceSession(sessionId, updated);
    });
  }
}
