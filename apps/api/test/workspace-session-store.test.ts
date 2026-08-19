import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const createdAt = "2026-08-19T06:00:00.000Z";
const expiresAt = "2026-08-19T14:00:00.000Z";

test("workspace sessions use distinct opaque random IDs", async () => {
  const store = new LocalWorkspaceSessionStore(
    ".data/test-random-workspace-sessions",
    false,
    () => createdAt,
  );
  const first = await store.create("account_creator", expiresAt);
  const second = await store.create("account_creator", expiresAt);

  assert.match(first.sessionId, /^session_[A-Za-z0-9_-]{40,}$/u);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.ok(!first.sessionId.includes(first.accountId));
});

test("active session resolution rejects unknown, expired, and signed-out sessions", async () => {
  let currentTime = createdAt;
  const store = new LocalWorkspaceSessionStore(
    ".data/test-active-workspace-sessions",
    false,
    () => currentTime,
    () => "session_known",
  );
  const session = await store.create("account_creator", expiresAt);
  assert.deepEqual(await store.loadActive(session.sessionId), session);
  assert.equal(await store.loadActive("session_unknown"), undefined);
  assert.equal(await store.loadActive(session.sessionId, expiresAt), undefined);

  currentTime = "2026-08-19T07:00:00.000Z";
  const signedOut = await store.signOut(session.sessionId);
  assert.equal(signedOut?.signedOutAt, currentTime);
  assert.equal(await store.loadActive(session.sessionId), undefined);
  assert.deepEqual(await store.signOut(session.sessionId), signedOut);
});

test("workspace sessions survive restart and persist no authorization snapshot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-workspace-sessions-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const first = new LocalWorkspaceSessionStore(
    directory,
    true,
    () => createdAt,
    () => "session_persisted",
  );
  const saved = await first.create("account_creator", expiresAt);

  const raw = JSON.parse(await readFile(join(directory, "sessions.json"), "utf8")) as {
    schemaVersion: number;
    sessions: Array<Record<string, unknown>>;
  };
  assert.equal(raw.schemaVersion, 1);
  assert.deepEqual(Object.keys(raw.sessions[0]!).sort(), [
    "accountId",
    "createdAt",
    "expiresAt",
    "schemaVersion",
    "sessionIdHash",
  ]);
  assert.doesNotMatch(JSON.stringify(raw), /session_persisted/u);
  assert.deepEqual(
    await new LocalWorkspaceSessionStore(directory).loadActive(
      saved.sessionId,
      "2026-08-19T07:00:00.000Z",
    ),
    saved,
  );
  assert.deepEqual(await readdir(directory), ["sessions.json"]);
});

test("workspace session store returns defensive copies", async () => {
  const store = new LocalWorkspaceSessionStore(
    ".data/test-workspace-session-copies",
    false,
    () => createdAt,
    () => "session_defensive",
  );
  const created = await store.create("account_creator", expiresAt);
  created.accountId = "account_attacker";
  assert.equal((await store.load(created.sessionId))?.accountId, "account_creator");
  const loaded = await store.load(created.sessionId);
  loaded!.accountId = "account_other";
  assert.equal((await store.load(created.sessionId))?.accountId, "account_creator");
});

test("workspace session store does not map untrusted session IDs to paths", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-session-path-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new LocalWorkspaceSessionStore(directory);
  await assert.rejects(store.load("../outside"), /invalid characters/u);
  await assert.rejects(store.signOut("..\\outside"), /invalid characters/u);
  assert.deepEqual(await readdir(directory), []);
});

test("workspace session store rejects invalid persisted records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-invalid-session-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "sessions.json"),
    JSON.stringify({
      schemaVersion: 1,
      sessions: [
        {
          schemaVersion: 1,
          sessionIdHash: "0".repeat(64),
          accountId: "account_creator",
          createdAt,
          expiresAt: createdAt,
        },
      ],
    }),
    "utf8",
  );

  await assert.rejects(
    new LocalWorkspaceSessionStore(directory).load("session_invalid"),
    /expiry must be after/u,
  );
});
