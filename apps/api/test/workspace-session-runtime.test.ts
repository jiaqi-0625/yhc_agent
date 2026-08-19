import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceAccessGrant } from "@firefly/schemas";

import { BusinessRuntimeError } from "../src/business-runtime.ts";
import {
  DEVELOPMENT_ACCOUNTS,
  WorkspaceSessionRuntime,
  type WorkspaceAccessGrantProvider,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

function grant(
  accountId: string,
  overrides: Partial<WorkspaceAccessGrant> = {},
): WorkspaceAccessGrant {
  return {
    id: `grant_${accountId}_e5`,
    tenantId: "tenant_firefly",
    accountId,
    access: {
      kind: "vehicle_project",
      brandId: "brand_firefly",
      vehicleId: "vehicle_e5",
    },
    status: "active",
    revision: 1,
    createdAt: "2026-08-19T08:00:00.000Z",
    createdBy: "account_admin",
    updatedAt: "2026-08-19T08:00:00.000Z",
    updatedBy: "account_admin",
    ...overrides,
  };
}

class MutableGrantProvider implements WorkspaceAccessGrantProvider {
  records: WorkspaceAccessGrant[] = [];
  calls = 0;

  async listForAccount(): Promise<readonly WorkspaceAccessGrant[]> {
    this.calls += 1;
    return structuredClone(this.records);
  }
}

function businessError(code: string, statusCode: number): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof BusinessRuntimeError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  };
}

function fixture() {
  let occurredAt = "2026-08-19T08:00:00.000Z";
  let sequence = 0;
  const grants = new MutableGrantProvider();
  const store = new LocalWorkspaceSessionStore(
    ".data/test-workspace-session-runtime",
    false,
    () => occurredAt,
    () => `workspace_session_${++sequence}`,
  );
  const runtime = new WorkspaceSessionRuntime(
    store,
    grants,
    DEVELOPMENT_ACCOUNTS,
    () => occurredAt,
  );
  return {
    grants,
    runtime,
    store,
    setTime(value: string) {
      occurredAt = value;
    },
  };
}

test("development account catalog contains one administrator and two creators", () => {
  const { runtime } = fixture();
  const accounts = runtime.listDevelopmentAccounts();

  assert.equal(accounts.length, 3);
  assert.deepEqual(
    accounts.map(({ accountId, role }) => ({ accountId, role })),
    [
      { accountId: "account_admin", role: "content_admin" },
      { accountId: "account_creator_a", role: "creator" },
      { accountId: "account_creator_b", role: "creator" },
    ],
  );
  accounts[0]!.displayName = "被客户端篡改";
  assert.equal(runtime.listDevelopmentAccounts()[0]?.displayName, "内容管理员");
});

test("createSession derives tenant, role, and matching grants from server records", async () => {
  const { grants, runtime, store } = fixture();
  grants.records = [
    grant("account_creator_a"),
    grant("account_creator_b"),
    grant("account_creator_a", { id: "grant_wrong_tenant", tenantId: "tenant_other" }),
  ];

  const session = await runtime.createSession("account_creator_a");
  assert.equal(session.sessionId, "workspace_session_1");
  assert.equal(session.createdAt, "2026-08-19T08:00:00.000Z");
  assert.equal(session.expiresAt, "2026-08-19T16:00:00.000Z");
  assert.deepEqual(session.account, {
    accountId: "account_creator_a",
    tenantId: "tenant_firefly",
    displayName: "制作账号 A",
    role: "creator",
  });
  assert.equal(session.scope.actorAccountId, "account_creator_a");
  assert.equal(session.scope.tenantId, "tenant_firefly");
  assert.equal(session.scope.role, "creator");
  assert.deepEqual(session.scope.accessGrants.map(({ id }) => id), ["grant_account_creator_a_e5"]);

  const persisted = await store.load(session.sessionId);
  assert.deepEqual(persisted, {
    schemaVersion: 1,
    sessionId: "workspace_session_1",
    accountId: "account_creator_a",
    createdAt: "2026-08-19T08:00:00.000Z",
    expiresAt: "2026-08-19T16:00:00.000Z",
  });
  assert.equal("role" in (persisted ?? {}), false);
  assert.equal("accessGrants" in (persisted ?? {}), false);
});

test("resolveSession reloads authorization changes for an existing session", async () => {
  const { grants, runtime } = fixture();
  grants.records = [grant("account_creator_a")];
  const created = await runtime.createSession("account_creator_a");
  assert.equal(created.scope.accessGrants[0]?.status, "active");

  grants.records = [
    grant("account_creator_a", {
      status: "revoked",
      revision: 2,
      updatedAt: "2026-08-19T09:00:00.000Z",
    }),
    grant("account_creator_a", {
      id: "grant_account_creator_a_e6",
      access: {
        kind: "vehicle_project",
        brandId: "brand_firefly",
        vehicleId: "vehicle_e6",
      },
    }),
  ];
  const resolved = await runtime.resolveSession(created.sessionId);

  assert.equal(grants.calls, 2);
  assert.deepEqual(
    resolved.scope.accessGrants.map(({ id, status }) => ({ id, status })),
    [
      { id: "grant_account_creator_a_e5", status: "revoked" },
      { id: "grant_account_creator_a_e6", status: "active" },
    ],
  );
  assert.equal(created.scope.accessGrants[0]?.status, "active");
});

test("switchSession creates a new identity and revokes the old credential", async () => {
  const { grants, runtime, store } = fixture();
  grants.records = [grant("account_creator_a"), grant("account_creator_b")];
  const original = await runtime.createSession("account_creator_a");
  const switched = await runtime.switchSession(original.sessionId, "account_creator_b");

  assert.notEqual(switched.sessionId, original.sessionId);
  assert.equal(switched.scope.actorAccountId, "account_creator_b");
  await assert.rejects(
    runtime.resolveSession(original.sessionId),
    businessError("AIC-AUTH-SESSION_INVALID", 401),
  );
  assert.equal((await store.load(original.sessionId))?.accountId, "account_creator_a");
  assert.equal(typeof (await store.load(original.sessionId))?.signedOutAt, "string");
  assert.equal((await store.load(switched.sessionId))?.accountId, "account_creator_b");
});

test("session DTOs and scopes are defensive copies", async () => {
  const { grants, runtime } = fixture();
  grants.records = [grant("account_creator_a")];
  const created = await runtime.createOrSwitchSession("account_creator_a");

  created.account.displayName = "篡改名称";
  created.scope.actorAccountId = "account_creator_b";
  (created.scope.accessGrants as WorkspaceAccessGrant[])[0]!.status = "revoked";
  const resolved = await runtime.resolveSession(created.sessionId);

  assert.equal(resolved.account.displayName, "制作账号 A");
  assert.equal(resolved.scope.actorAccountId, "account_creator_a");
  assert.equal(resolved.scope.accessGrants[0]?.status, "active");
  assert.equal(grants.records[0]?.status, "active");
});

test("unknown accounts and inactive sessions use stable authentication errors", async () => {
  const { runtime, setTime } = fixture();
  await assert.rejects(
    runtime.createSession("account_unknown"),
    businessError("AIC-AUTH-DEVELOPMENT_ACCOUNT_NOT_FOUND", 404),
  );
  await assert.rejects(
    runtime.resolveSession("workspace_session_missing"),
    businessError("AIC-AUTH-SESSION_INVALID", 401),
  );

  const ended = await runtime.createSession("account_creator_a");
  await runtime.endSession(ended.sessionId);
  await assert.rejects(
    runtime.resolveSession(ended.sessionId),
    businessError("AIC-AUTH-SESSION_INVALID", 401),
  );

  const expired = await runtime.createSession("account_creator_b");
  setTime("2026-08-19T16:00:00.000Z");
  await assert.rejects(
    runtime.resolveSession(expired.sessionId),
    businessError("AIC-AUTH-SESSION_INVALID", 401),
  );
});
