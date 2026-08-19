import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LegacyWorkspaceMigrationCoordinator,
  type LegacyWorkspaceMigrationConfig,
} from "./legacy-work-migration-coordinator.ts";

type MigrationCommand = "plan" | "apply" | "resume" | "status" | "restore";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const matches = arguments_.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) throw new Error(`Option '--${name}' may only be provided once.`);
  return matches[0]?.slice(prefix.length);
}

function resolveConfiguredPath(
  base: string,
  directories: Readonly<Record<string, unknown>>,
  name: keyof LegacyWorkspaceMigrationConfig["directories"],
): string {
  const value = directories[name];
  if (typeof value !== "string") {
    throw new Error(`Migration data directory '${name}' must be a string.`);
  }
  if (value.trim().length === 0) throw new Error("Migration data directory cannot be blank.");
  return resolve(isAbsolute(value) ? value : resolve(base, value));
}

async function loadConfig(path: string): Promise<LegacyWorkspaceMigrationConfig> {
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Migration config '${absolutePath}' cannot be read as JSON.`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("Migration config must be a JSON object.");
  }
  if (!isRecord(parsed.migration)) {
    throw new Error("Migration config must define explicit migration settings.");
  }
  if (typeof parsed.legacySessionOwnerAccountId !== "string") {
    throw new Error("Migration config must define a legacy Session owner account ID.");
  }
  if (typeof parsed.taskOwnerDisplayName !== "string") {
    throw new Error("Migration config must define the task owner display name.");
  }
  if (!Array.isArray(parsed.legacyV3SessionScopeMappings)) {
    throw new Error("Migration config must define explicit legacy V3 Session scope mappings.");
  }
  if (!isRecord(parsed.administration)) {
    throw new Error("Migration config must define explicit Workspace administration data.");
  }
  for (const name of [
    "brands",
    "vehicleVersions",
    "vehicleAssetAssociations",
    "accessGrants",
  ] as const) {
    if (!Array.isArray(parsed.administration[name])) {
      throw new Error(`Migration administration '${name}' must be an array.`);
    }
  }
  if (!isRecord(parsed.directories)) {
    throw new Error("Migration config must define explicit data directories.");
  }
  const config = parsed as unknown as LegacyWorkspaceMigrationConfig;
  const directories = parsed.directories;
  const base = dirname(absolutePath);
  return {
    ...config,
    directories: {
      works: resolveConfiguredPath(base, directories, "works"),
      sessions: resolveConfiguredPath(base, directories, "sessions"),
      workspaceAdmin: resolveConfiguredPath(base, directories, "workspaceAdmin"),
      batchProjects: resolveConfiguredPath(base, directories, "batchProjects"),
      videoTasks: resolveConfiguredPath(base, directories, "videoTasks"),
      migrations: resolveConfiguredPath(base, directories, "migrations"),
    },
  };
}

export async function runLegacyWorkspaceMigrationCli(
  arguments_: readonly string[],
  writeOutput: (output: string) => void = console.log,
): Promise<void> {
  const [rawCommand, ...options] = arguments_;
  if (!(["plan", "apply", "resume", "status", "restore"] as readonly string[]).includes(rawCommand ?? "")) {
    throw new Error("Usage: migrate:workspace-v2 <plan|apply|resume|status|restore> --config=<path> [--plan-hash=<sha256>]");
  }
  const command = rawCommand as MigrationCommand;
  const supportedOptions = new Set(["config", "plan-hash"]);
  for (const argument of options) {
    const match = /^--([^=]+)=/u.exec(argument);
    if (!match?.[1] || !supportedOptions.has(match[1])) {
      throw new Error(`Unknown migration option '${argument}'.`);
    }
  }
  const configPath = option(options, "config");
  if (!configPath) throw new Error("Migration command requires '--config=<path>'.");
  const coordinator = new LegacyWorkspaceMigrationCoordinator(await loadConfig(configPath));
  const requestedPlanHash = option(options, "plan-hash");
  if (["apply", "resume"].includes(command) && !requestedPlanHash) {
    throw new Error(`Migration '${command}' requires '--plan-hash=<sha256>' from the plan output.`);
  }
  if (!["apply", "resume"].includes(command) && requestedPlanHash !== undefined) {
    throw new Error(`Migration '${command}' does not accept '--plan-hash'.`);
  }

  const result = command === "plan"
    ? await coordinator.plan()
    : command === "status"
      ? { manifest: (await coordinator.status()) ?? null }
      : command === "restore"
        ? await coordinator.restore()
        : command === "resume"
          ? await coordinator.resume(requestedPlanHash!)
          : await coordinator.apply(requestedPlanHash!);
  writeOutput(JSON.stringify(result, null, 2));
}

const isEntrypoint = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntrypoint) {
  try {
    await runLegacyWorkspaceMigrationCli(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
