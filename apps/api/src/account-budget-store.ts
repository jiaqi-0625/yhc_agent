import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { AccountBudgetSchema, type AccountBudget } from "@firefly/schemas";
import { Value } from "typebox/value";

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
}

export interface AccountBudgetStore {
  load(tenantId: string, accountId: string): Promise<AccountBudget | undefined>;
  transact(
    tenantId: string,
    accountId: string,
    update: (
      current: AccountBudget | undefined,
    ) => AccountBudget | Promise<AccountBudget>,
  ): Promise<AccountBudget>;
}

export class LocalAccountBudgetStore implements AccountBudgetStore {
  readonly #directory: string;
  readonly #memory = new Map<string, AccountBudget>();
  readonly #transactionTails = new Map<string, Promise<void>>();

  constructor(directory = ".data/account-budgets", readonly persist = true) {
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
      throw new Error("Account budget path escaped the configured data directory.");
    }
    return path;
  }

  #validate(budget: Readonly<AccountBudget>, tenantId: string, accountId: string): void {
    if (
      budget.tenantId !== tenantId ||
      budget.accountId !== accountId ||
      !Value.Check(AccountBudgetSchema, budget)
    ) {
      throw new Error("Persisted account budget has an invalid format or scope.");
    }
  }

  async load(tenantId: string, accountId: string): Promise<AccountBudget | undefined> {
    const key = this.#key(tenantId, accountId);
    const memory = this.#memory.get(key);
    if (memory) return structuredClone(memory);
    if (!this.persist) return undefined;
    try {
      const parsed = JSON.parse(
        await readFile(this.#path(tenantId, accountId), "utf8"),
      ) as AccountBudget;
      this.#validate(parsed, tenantId, accountId);
      this.#memory.set(key, structuredClone(parsed));
      return structuredClone(parsed);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #save(budget: Readonly<AccountBudget>): Promise<void> {
    this.#validate(budget, budget.tenantId, budget.accountId);
    const key = this.#key(budget.tenantId, budget.accountId);
    const copy = structuredClone(budget);
    if (this.persist) {
      const path = this.#path(budget.tenantId, budget.accountId);
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

  async transact(
    tenantId: string,
    accountId: string,
    update: (
      current: AccountBudget | undefined,
    ) => AccountBudget | Promise<AccountBudget>,
  ): Promise<AccountBudget> {
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
      this.#validate(next, tenantId, accountId);
      await this.#save(next);
      return structuredClone(next);
    } finally {
      release();
      if (this.#transactionTails.get(key) === tail) this.#transactionTails.delete(key);
    }
  }
}
