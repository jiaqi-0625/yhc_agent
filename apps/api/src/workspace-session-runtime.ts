import type { WorkspaceSessionScope } from "@firefly/domain";
import type { Role, WorkspaceAccessGrant } from "@firefly/schemas";

import { BusinessRuntimeError } from "./business-runtime.ts";
import type {
  WorkspaceSessionRecord,
  WorkspaceSessionStore,
} from "./workspace-session-store.ts";

const DEFAULT_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;

export interface DevelopmentAccount {
  accountId: string;
  tenantId: string;
  displayName: string;
  role: Role;
}

export const DEVELOPMENT_ACCOUNTS: readonly DevelopmentAccount[] = [
  {
    accountId: "account_admin",
    tenantId: "tenant_firefly",
    displayName: "内容管理员",
    role: "content_admin",
  },
  {
    accountId: "account_creator_a",
    tenantId: "tenant_firefly",
    displayName: "制作账号 A",
    role: "creator",
  },
  {
    accountId: "account_creator_b",
    tenantId: "tenant_firefly",
    displayName: "制作账号 B",
    role: "creator",
  },
] as const;

export const DEVELOPMENT_ACCESS_GRANTS: readonly WorkspaceAccessGrant[] = [
  {
    id: "grant_admin_firefly_demo",
    tenantId: "tenant_firefly",
    accountId: "account_admin",
    access: { kind: "brand", brandId: "brand_firefly_demo" },
    status: "active",
    revision: 1,
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_admin",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_admin",
  },
  ...["account_creator_a", "account_creator_b"].map((accountId) => ({
    id: `grant_${accountId}_firefly_e5`,
    tenantId: "tenant_firefly",
    accountId,
    access: {
      kind: "vehicle_project" as const,
      brandId: "brand_firefly_demo",
      vehicleId: "vehicle_firefly_e5_2026_long_range",
    },
    status: "active" as const,
    revision: 1,
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_admin",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_admin",
  })),
];

/** Access grants are reloaded on every scope resolution. */
export interface WorkspaceAccessGrantProvider {
  listForAccount(tenantId: string, accountId: string): Promise<readonly WorkspaceAccessGrant[]>;
}

export class InMemoryWorkspaceAccessGrantProvider implements WorkspaceAccessGrantProvider {
  #records: readonly WorkspaceAccessGrant[];

  constructor(records: readonly WorkspaceAccessGrant[] = DEVELOPMENT_ACCESS_GRANTS) {
    this.#records = structuredClone(records);
  }

  replace(records: readonly WorkspaceAccessGrant[]): void {
    this.#records = structuredClone(records);
  }

  async listForAccount(tenantId: string, accountId: string): Promise<readonly WorkspaceAccessGrant[]> {
    return structuredClone(this.#records.filter(
      (grant) => grant.tenantId === tenantId && grant.accountId === accountId,
    ));
  }
}

export interface ResolvedWorkspaceSession {
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  account: DevelopmentAccount;
  scope: WorkspaceSessionScope;
}

function accountNotFound(accountId: string): BusinessRuntimeError {
  return new BusinessRuntimeError(
    "AIC-AUTH-DEVELOPMENT_ACCOUNT_NOT_FOUND",
    `Development account '${accountId}' was not found.`,
    404,
  );
}

function invalidSession(_sessionId: string): BusinessRuntimeError {
  return new BusinessRuntimeError(
    "AIC-AUTH-SESSION_INVALID",
    "The workspace session is missing, expired, or signed out.",
    401,
  );
}

export class WorkspaceSessionRuntime {
  readonly #accounts: ReadonlyMap<string, DevelopmentAccount>;

  constructor(
    private readonly store: WorkspaceSessionStore,
    private readonly grants: WorkspaceAccessGrantProvider,
    accounts: readonly Readonly<DevelopmentAccount>[] = DEVELOPMENT_ACCOUNTS,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly sessionLifetimeMs = DEFAULT_SESSION_LIFETIME_MS,
  ) {
    if (!Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs <= 0) {
      throw new Error("Workspace session lifetime must be a positive safe integer.");
    }
    const entries = accounts.map((account) => [account.accountId, structuredClone(account)] as const);
    if (new Set(entries.map(([accountId]) => accountId)).size !== entries.length) {
      throw new Error("Development account IDs must be unique.");
    }
    this.#accounts = new Map(entries);
  }

  listDevelopmentAccounts(): DevelopmentAccount[] {
    return structuredClone([...this.#accounts.values()]);
  }

  async createSession(accountId: string): Promise<ResolvedWorkspaceSession> {
    this.#account(accountId);
    const occurredAt = this.now();
    const timestamp = Date.parse(occurredAt);
    if (!Number.isFinite(timestamp)) throw new Error("Session clock returned an invalid date-time.");
    const expiresAt = new Date(timestamp + this.sessionLifetimeMs).toISOString();
    const record = await this.store.create(accountId, expiresAt);
    if (record.accountId !== accountId) {
      throw new Error("Session store returned an identity different from the requested account.");
    }
    return this.#resolveRecord(record);
  }

  async switchSession(
    currentSessionId: string,
    accountId: string,
  ): Promise<ResolvedWorkspaceSession> {
    await this.resolveSession(currentSessionId);
    const replacement = await this.createSession(accountId);
    await this.endSession(currentSessionId);
    return replacement;
  }

  async createOrSwitchSession(
    accountId: string,
    currentSessionId?: string,
  ): Promise<ResolvedWorkspaceSession> {
    return currentSessionId === undefined
      ? this.createSession(accountId)
      : this.switchSession(currentSessionId, accountId);
  }

  async resolveSession(sessionId: string): Promise<ResolvedWorkspaceSession> {
    const record = await this.store.loadActive(sessionId, this.now());
    if (record === undefined) throw invalidSession(sessionId);
    return this.#resolveRecord(record);
  }

  async endSession(sessionId: string): Promise<void> {
    const signedOut = await this.store.signOut(sessionId);
    if (signedOut === undefined) throw invalidSession(sessionId);
  }

  #account(accountId: string): DevelopmentAccount {
    const account = this.#accounts.get(accountId);
    if (account === undefined) throw accountNotFound(accountId);
    return structuredClone(account);
  }

  async #resolveRecord(
    record: Readonly<WorkspaceSessionRecord>,
  ): Promise<ResolvedWorkspaceSession> {
    const account = this.#account(record.accountId);
    const accessGrants = (await this.grants.listForAccount(account.tenantId, account.accountId))
      .filter(
        (grant) =>
          grant.tenantId === account.tenantId && grant.accountId === account.accountId,
      );
    return structuredClone({
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      account,
      scope: {
        actorAccountId: account.accountId,
        tenantId: account.tenantId,
        role: account.role,
        accessGrants,
      },
    });
  }
}
