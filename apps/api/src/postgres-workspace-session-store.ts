import { randomBytes } from "node:crypto";

import type {
  PostgresQueryable,
  PostgresTransactionProvider,
} from "./postgres-contract.ts";
import {
  assertWorkspaceSessionIdentifier,
  hydrateWorkspaceSession,
  validateStoredWorkspaceSession,
  validateWorkspaceSession,
  workspaceSessionIdHash,
  workspaceSessionTimestamp,
  type StoredWorkspaceSessionRecord,
  type WorkspaceSessionRecord,
  type WorkspaceSessionStore,
} from "./workspace-session-store.ts";

interface WorkspaceSessionRow {
  session_id_hash: string;
  account_id: string;
  created_at: string | Date;
  expires_at: string | Date;
  signed_out_at: string | Date | null;
  revision: number | string;
  state: unknown;
}
function timestampMilliseconds(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function timestampsRepresentSameInstant(left: string | Date, right: string): boolean {
  const leftTimestamp = timestampMilliseconds(left);
  const rightTimestamp = timestampMilliseconds(right);
  return (
    Number.isFinite(leftTimestamp) &&
    Number.isFinite(rightTimestamp) &&
    leftTimestamp === rightTimestamp
  );
}

function decodeStoredSession(
  row: Readonly<WorkspaceSessionRow>,
  digest: string,
): StoredWorkspaceSessionRecord {
  const decoded = typeof row.state === "string"
    ? (JSON.parse(row.state) as unknown)
    : row.state;
  const stored = structuredClone(decoded) as StoredWorkspaceSessionRecord;
  validateStoredWorkspaceSession(stored);
  if (
    row.session_id_hash !== digest ||
    stored.sessionIdHash !== digest ||
    row.account_id !== stored.accountId ||
    !timestampsRepresentSameInstant(row.created_at, stored.createdAt) ||
    !timestampsRepresentSameInstant(row.expires_at, stored.expiresAt) ||
    (row.signed_out_at === null) !== (stored.signedOutAt === undefined) ||
    (row.signed_out_at !== null &&
      stored.signedOutAt !== undefined &&
      !timestampsRepresentSameInstant(row.signed_out_at, stored.signedOutAt))
  ) {
    throw new Error("Persisted workspace session has an invalid scope.");
  }
  return stored;
}

async function lockSession(transaction: PostgresQueryable, digest: string): Promise<void> {
  await transaction.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`workspace_session:${digest}`],
  );
}

async function selectSession(
  queryable: PostgresQueryable,
  digest: string,
  forUpdate = false,
): Promise<WorkspaceSessionRow | undefined> {
  const result = await queryable.query<WorkspaceSessionRow>(
    `SELECT session_id_hash, account_id, created_at, expires_at, signed_out_at,
            revision, state
       FROM workspace_sessions
      WHERE session_id_hash = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [digest],
  );
  if (result.rows.length > 1) {
    throw new Error("Persisted workspace sessions contain a duplicate ID.");
  }
  return result.rows[0];
}

export class PostgresWorkspaceSessionStore implements WorkspaceSessionStore {
  constructor(
    private readonly postgres: PostgresTransactionProvider,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createSessionId: () => string = () =>
      `session_${randomBytes(32).toString("base64url")}`,
  ) {}

  async create(accountId: string, expiresAt: string): Promise<WorkspaceSessionRecord> {
    assertWorkspaceSessionIdentifier(accountId, "Account ID");
    const createdAt = this.now();
    const sessionId = this.createSessionId();
    assertWorkspaceSessionIdentifier(sessionId, "Session ID");
    const digest = workspaceSessionIdHash(sessionId);
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
    validateStoredWorkspaceSession(stored);
    await this.postgres.transaction(async (transaction) => {
      await lockSession(transaction, digest);
      const write = await transaction.query<{ revision: number | string }>(
        `INSERT INTO workspace_sessions
           (session_id_hash, account_id, created_at, expires_at, signed_out_at,
            revision, state, updated_at)
         VALUES ($1, $2, $3::timestamptz, $4::timestamptz, NULL, 1, $5::jsonb, now())
         ON CONFLICT (session_id_hash) DO NOTHING
         RETURNING revision`,
        [digest, accountId, createdAt, expiresAt, JSON.stringify(stored)],
      );
      if (write.rowCount !== 1) throw new Error("Workspace session ID collision.");
    });
    return structuredClone(session);
  }

  async load(sessionId: string): Promise<WorkspaceSessionRecord | undefined> {
    assertWorkspaceSessionIdentifier(sessionId, "Session ID");
    const digest = workspaceSessionIdHash(sessionId);
    const row = await selectSession(this.postgres, digest);
    if (row === undefined) return undefined;
    return hydrateWorkspaceSession(sessionId, decodeStoredSession(row, digest));
  }

  async loadActive(
    sessionId: string,
    occurredAt = this.now(),
  ): Promise<WorkspaceSessionRecord | undefined> {
    const session = await this.load(sessionId);
    const occurredAtTimestamp = workspaceSessionTimestamp(
      occurredAt,
      "Session resolution time",
    );
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
    const digest = workspaceSessionIdHash(sessionId);
    return this.postgres.transaction(async (transaction) => {
      await lockSession(transaction, digest);
      const row = await selectSession(transaction, digest, true);
      if (row === undefined) return undefined;
      const current = decodeStoredSession(row, digest);
      if (current.signedOutAt !== undefined) {
        return hydrateWorkspaceSession(sessionId, current);
      }
      const updated: StoredWorkspaceSessionRecord = {
        ...structuredClone(current),
        signedOutAt: this.now(),
      };
      validateStoredWorkspaceSession(updated);
      const write = await transaction.query<{ revision: number | string }>(
        `UPDATE workspace_sessions
            SET signed_out_at = $2::timestamptz,
                state = $3::jsonb,
                revision = revision + 1,
                updated_at = now()
          WHERE session_id_hash = $1 AND revision = $4
          RETURNING revision`,
        [digest, updated.signedOutAt, JSON.stringify(updated), row.revision],
      );
      if (write.rowCount !== 1) throw new Error("Workspace session changed concurrently.");
      return hydrateWorkspaceSession(sessionId, updated);
    });
  }
}
