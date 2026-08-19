import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import type { AccountHighCostTaskRunLock } from "@firefly/schemas";

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
}

export interface AccountRunLockStore {
  load(tenantId: string, accountId: string): Promise<AccountHighCostTaskRunLock | undefined>;
  transact(
    tenantId: string,
    accountId: string,
    update: (
      current: AccountHighCostTaskRunLock | undefined,
    ) => AccountHighCostTaskRunLock | undefined | Promise<AccountHighCostTaskRunLock | undefined>,
  ): Promise<AccountHighCostTaskRunLock | undefined>;
}

export class LocalAccountRunLockStore implements AccountRunLockStore {
  readonly #directory: string;
  readonly #memory = new Map<string, AccountHighCostTaskRunLock>();
  readonly #transactionTails = new Map<string, Promise<void>>();

  constructor(directory = ".data/account-run-locks", readonly persist = true) {
    this.#directory = resolve(directory);
  }

  #key(tenantId: string, accountId: string): string {
    assertIdentifier(tenantId, "Tenant ID");
    assertIdentifier(accountId, "Account ID");
    return `${tenantId}:${accountId}`;
  }

  #path(tenantId: string, accountId: string): string {
    this.#key(tenantId, accountId);
    const path = resolve(join(this.#directory, tenantId, `${accountId}.json`));
    if (!path.startsWith(`${this.#directory}${sep}`)) {
      throw new Error("Account run lock path escaped the configured data directory.");
    }
    return path;
  }

  async load(
    tenantId: string,
    accountId: string,
  ): Promise<AccountHighCostTaskRunLock | undefined> {
    const key = this.#key(tenantId, accountId);
    const memory = this.#memory.get(key);
    if (memory) return structuredClone(memory);
    if (!this.persist) return undefined;
    try {
      const parsed = JSON.parse(
        await readFile(this.#path(tenantId, accountId), "utf8"),
      ) as AccountHighCostTaskRunLock;
      if (parsed.tenantId !== tenantId || parsed.accountId !== accountId) {
        throw new Error("Persisted account run lock has an invalid scope.");
      }
      this.#memory.set(key, structuredClone(parsed));
      return structuredClone(parsed);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #save(lock: Readonly<AccountHighCostTaskRunLock>): Promise<void> {
    const key = this.#key(lock.tenantId, lock.accountId);
    const copy = structuredClone(lock);
    if (this.persist) {
      const path = this.#path(lock.tenantId, lock.accountId);
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(copy, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      try {
        await rename(temporaryPath, path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    }
    this.#memory.set(key, copy);
  }

  async #delete(tenantId: string, accountId: string): Promise<void> {
    const key = this.#key(tenantId, accountId);
    if (this.persist) {
      await unlink(this.#path(tenantId, accountId)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    this.#memory.delete(key);
  }

  async transact(
    tenantId: string,
    accountId: string,
    update: (
      current: AccountHighCostTaskRunLock | undefined,
    ) => AccountHighCostTaskRunLock | undefined | Promise<AccountHighCostTaskRunLock | undefined>,
  ): Promise<AccountHighCostTaskRunLock | undefined> {
    const key = this.#key(tenantId, accountId);
    const previous = this.#transactionTails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.#transactionTails.set(key, tail);
    await previous;
    try {
      const next = await update(await this.load(tenantId, accountId));
      if (next && (next.tenantId !== tenantId || next.accountId !== accountId)) {
        throw new Error("An account run lock transaction cannot change its scope.");
      }
      if (next) await this.#save(next);
      else await this.#delete(tenantId, accountId);
      return next ? structuredClone(next) : undefined;
    } finally {
      release();
      if (this.#transactionTails.get(key) === tail) this.#transactionTails.delete(key);
    }
  }
}
