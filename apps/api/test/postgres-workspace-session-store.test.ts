import assert from "node:assert/strict";
import test from "node:test";

import type {
  PostgresQueryResult,
  PostgresQueryable,
  PostgresTransactionProvider,
} from "../src/postgres-contract.ts";
import { PostgresWorkspaceSessionStore } from "../src/postgres-workspace-session-store.ts";
import {
  workspaceSessionIdHash,
  type StoredWorkspaceSessionRecord,
} from "../src/workspace-session-store.ts";

interface QueryCall { sql: string; parameters: readonly unknown[] }

class FakePostgres implements PostgresTransactionProvider {
  readonly calls: QueryCall[] = [];
  rollbacks = 0;
  constructor(private readonly responses: Array<PostgresQueryResult<unknown> | Error>) {}

  async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters: structuredClone(parameters) });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected query: ${sql}`);
    if (response instanceof Error) throw response;
    return response as PostgresQueryResult<Row>;
  }

  async transaction<Result>(operation: (transaction: PostgresQueryable) => Promise<Result>): Promise<Result> {
    try {
      return await operation(this);
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }
}

const createdAt = "2026-08-19T06:00:00.000Z";
const expiresAt = "2026-08-19T14:00:00.000Z";
const token = "session_postgres_secret";
const digest = workspaceSessionIdHash(token);
const stored = (signedOutAt?: string): StoredWorkspaceSessionRecord => ({
  schemaVersion: 1,
  sessionIdHash: digest,
  accountId: "account_creator",
  createdAt,
  expiresAt,
  ...(signedOutAt === undefined ? {} : { signedOutAt }),
});
const row = (value: StoredWorkspaceSessionRecord, revision: number | string = 1) => ({
  session_id_hash: digest,
  account_id: value.accountId,
  created_at: value.createdAt,
  expires_at: value.expiresAt,
  signed_out_at: value.signedOutAt ?? null,
  revision,
  state: value,
});
test("postgres workspace session persists only the token hash", async () => {
  const postgres = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [{ revision: 1 }], rowCount: 1 },
  ]);
  const session = await new PostgresWorkspaceSessionStore(
    postgres,
    () => createdAt,
    () => token,
  ).create("account_creator", expiresAt);

  assert.equal(session.sessionId, token);
  assert.deepEqual(postgres.calls[0]!.parameters, [`workspace_session:${digest}`]);
  assert.match(postgres.calls[1]!.sql, /ON CONFLICT \(session_id_hash\) DO NOTHING/u);
  assert.equal(postgres.calls[1]!.parameters[0], digest);
  assert.doesNotMatch(JSON.stringify(postgres.calls), new RegExp(token, "u"));
  const persisted = JSON.parse(postgres.calls[1]!.parameters[4] as string) as Record<string, unknown>;
  assert.equal(persisted.sessionIdHash, digest);
  assert.equal(persisted.sessionId, undefined);
});

test("postgres workspace session load is hash-scoped, validated, and defensive", async () => {
  const postgres = new FakePostgres([
    { rows: [row(stored())], rowCount: 1 },
    { rows: [row(stored())], rowCount: 1 },
    { rows: [row(stored())], rowCount: 1 },
  ]);
  const store = new PostgresWorkspaceSessionStore(postgres, () => createdAt, () => token);
  const loaded = await store.load(token);
  loaded!.accountId = "account_attacker";
  assert.equal((await store.load(token))!.accountId, "account_creator");
  assert.deepEqual(await store.loadActive(token, "2026-08-19T07:00:00.000Z"), {
    schemaVersion: 1,
    sessionId: token,
    accountId: "account_creator",
    createdAt,
    expiresAt,
  });
  assert.ok(postgres.calls.every((call) => call.parameters[0] === digest));

  const crossScope = new FakePostgres([
    { rows: [{ ...row(stored()), account_id: "account_other" }], rowCount: 1 },
  ]);
  await assert.rejects(
    new PostgresWorkspaceSessionStore(crossScope).load(token),
    /invalid scope/u,
  );

  const mismatchedExpiry = new FakePostgres([{
    rows: [{ ...row(stored()), expires_at: "2026-08-20T14:00:00.000Z" }],
    rowCount: 1,
  }]);
  await assert.rejects(
    new PostgresWorkspaceSessionStore(mismatchedExpiry).load(token),
    /invalid scope/u,
  );
});

test("postgres workspace session accepts equivalent timestamp offsets", async () => {
  const offsetCreatedAt = "2026-08-19T14:00:00.000+08:00";
  const offsetExpiresAt = "2026-08-19T22:00:00.000+08:00";
  const offsetSignedOutAt = "2026-08-19T15:00:00.000+08:00";
  const offsetSession: StoredWorkspaceSessionRecord = {
    ...stored(offsetSignedOutAt),
    createdAt: offsetCreatedAt,
    expiresAt: offsetExpiresAt,
  };
  const postgres = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [{ revision: 1 }], rowCount: 1 },
    {
      rows: [{
        ...row(offsetSession),
        created_at: new Date(createdAt),
        expires_at: new Date(expiresAt),
        signed_out_at: new Date("2026-08-19T07:00:00.000Z"),
      }],
      rowCount: 1,
    },
    { rows: [], rowCount: 1 },
    {
      rows: [{
        ...row(offsetSession, 2),
        created_at: createdAt,
        expires_at: expiresAt,
        signed_out_at: "2026-08-19T07:00:00.000Z",
      }],
      rowCount: 1,
    },
  ]);
  const store = new PostgresWorkspaceSessionStore(
    postgres,
    () => offsetCreatedAt,
    () => token,
  );

  const created = await store.create("account_creator", offsetExpiresAt);
  assert.equal(created.createdAt, offsetCreatedAt);
  assert.equal(created.expiresAt, offsetExpiresAt);
  assert.equal((await store.load(token))!.signedOutAt, offsetSignedOutAt);
  assert.equal((await store.signOut(token))!.signedOutAt, offsetSignedOutAt);
  assert.equal(postgres.calls.length, 5);
});

test("postgres workspace session rejects timestamps for different instants", async () => {
  const mismatchedSignOut = new FakePostgres([{
    rows: [{
      ...row(stored("2026-08-19T15:00:00.000+08:00")),
      signed_out_at: "2026-08-19T08:00:00.000Z",
    }],
    rowCount: 1,
  }]);

  await assert.rejects(
    new PostgresWorkspaceSessionStore(mismatchedSignOut).load(token),
    /invalid scope/u,
  );
});

test("postgres workspace session sign-out is atomic and idempotent", async () => {
  const signedOutAt = "2026-08-19T07:00:00.000Z";
  const postgres = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [row(stored(), "5")], rowCount: 1 },
    { rows: [{ revision: "6" }], rowCount: 1 },
  ]);
  const signedOut = await new PostgresWorkspaceSessionStore(
    postgres,
    () => signedOutAt,
  ).signOut(token);
  assert.equal(signedOut!.signedOutAt, signedOutAt);
  assert.match(postgres.calls[1]!.sql, /session_id_hash = \$1 FOR UPDATE/u);
  assert.deepEqual(postgres.calls[2]!.parameters.slice(0, 2), [digest, signedOutAt]);
  assert.equal(postgres.calls[2]!.parameters[3], "5");

  const already = stored(signedOutAt);
  const idempotent = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [row(already, 6)], rowCount: 1 },
  ]);
  assert.equal(
    (await new PostgresWorkspaceSessionStore(idempotent).signOut(token))!.signedOutAt,
    signedOutAt,
  );
  assert.equal(idempotent.calls.length, 2);
});

test("postgres workspace session collision and optimistic conflicts roll back", async () => {
  const collision = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  await assert.rejects(
    new PostgresWorkspaceSessionStore(collision, () => createdAt, () => token)
      .create("account_creator", expiresAt),
    /ID collision/u,
  );
  assert.equal(collision.rollbacks, 1);

  const conflict = new FakePostgres([
    { rows: [], rowCount: 1 },
    { rows: [row(stored(), 2)], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  await assert.rejects(
    new PostgresWorkspaceSessionStore(
      conflict,
      () => "2026-08-19T07:00:00.000Z",
    ).signOut(token),
    /changed concurrently/u,
  );
  assert.equal(conflict.rollbacks, 1);
});
