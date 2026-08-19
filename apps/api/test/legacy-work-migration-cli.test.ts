import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { LegacyWorkspaceMigrationConfig } from "../src/legacy-work-migration-coordinator.ts";
import { runLegacyWorkspaceMigrationCli } from "../src/legacy-work-migration-cli.ts";

const exampleConfigPath = fileURLToPath(
  new URL("../../../docs/examples/ws-307-migration.config.example.json", import.meta.url),
);

interface TemporaryConfig {
  root: string;
  path: string;
  config: LegacyWorkspaceMigrationConfig;
}

async function temporaryDirectory(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "firefly-ws307-cli-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function temporaryConfig(context: TestContext): Promise<TemporaryConfig> {
  const root = await temporaryDirectory(context);
  const config = JSON.parse(await readFile(exampleConfigPath, "utf8")) as LegacyWorkspaceMigrationConfig;
  config.directories = {
    works: "data/works",
    sessions: "data/sessions",
    workspaceAdmin: "data/workspace-admin",
    batchProjects: "data/batch-projects",
    videoTasks: "data/video-tasks",
    migrations: "state/workspace-migrations",
  };
  const path = join(root, "operator", "ws307.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { root, path, config };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("the tracked example is secret-free, parser-readable, and resolves directories from the config file", async (context) => {
  const rawExample = await readFile(exampleConfigPath, "utf8");
  assert.doesNotMatch(
    rawExample,
    /"(?:api[-_]?key|credential|password|secret|token)"\s*:/iu,
  );
  const fixture = await temporaryConfig(context);
  const migrationId = fixture.config.migration.migrationId;
  const manifest = {
    schemaVersion: 1,
    migrationId,
    status: "completed",
    plan: {
      schemaVersion: 1,
      migrationId,
      planHashSha256: "a".repeat(64),
      configurationFingerprintSha256: "b".repeat(64),
      sourceFingerprintSha256: "c".repeat(64),
      migrationFingerprintSha256: "d".repeat(64),
      sources: { works: [], sessions: [] },
      targets: [],
      summary: {},
    },
    startedAt: "2026-08-19T20:00:00.000Z",
    updatedAt: "2026-08-19T20:01:00.000Z",
    completedAt: "2026-08-19T20:01:00.000Z",
  };
  const expectedMigrationDirectory = resolve(
    dirname(fixture.path),
    fixture.config.directories.migrations,
  );
  await writeJson(join(expectedMigrationDirectory, migrationId, "manifest.json"), manifest);

  const outputs: string[] = [];
  await runLegacyWorkspaceMigrationCli(
    ["status", `--config=${fixture.path}`],
    (output) => outputs.push(output),
  );

  assert.equal(outputs.length, 1);
  assert.deepEqual(JSON.parse(outputs[0]!) as unknown, { manifest });
});

test("status reports an explicit null manifest without creating migration data", async (context) => {
  const fixture = await temporaryConfig(context);
  const outputs: string[] = [];

  await runLegacyWorkspaceMigrationCli(
    ["status", `--config=${fixture.path}`],
    (output) => outputs.push(output),
  );

  assert.deepEqual(JSON.parse(outputs[0]!) as unknown, { manifest: null });
  await assert.rejects(
    readFile(resolve(dirname(fixture.path), fixture.config.directories.migrations)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("the CLI rejects unknown, malformed, and duplicate options before running a command", async (context) => {
  const { path } = await temporaryConfig(context);
  const cases: ReadonlyArray<readonly [readonly string[], RegExp]> = [
    [[], /Usage: migrate:workspace-v2/u],
    [["inspect", `--config=${path}`], /Usage: migrate:workspace-v2/u],
    [["status"], /requires '--config=<path>'/u],
    [["status", "--config"], /Unknown migration option '--config'/u],
    [["status", `--config=${path}`, "unexpected"], /Unknown migration option 'unexpected'/u],
    [["status", `--config=${path}`, "--dry-run=true"], /Unknown migration option '--dry-run=true'/u],
    [
      ["status", `--config=${path}`, `--config=${path}`],
      /Option '--config' may only be provided once/u,
    ],
    [
      ["apply", `--config=${path}`, `--plan-hash=${"a".repeat(64)}`, `--plan-hash=${"a".repeat(64)}`],
      /Option '--plan-hash' may only be provided once/u,
    ],
  ];

  for (const [arguments_, expected] of cases) {
    await assert.rejects(
      runLegacyWorkspaceMigrationCli(arguments_, () => assert.fail("error path wrote output")),
      expected,
    );
  }
});

test("apply and resume require one exact plan hash while read-only and recovery commands reject it", async (context) => {
  const { path } = await temporaryConfig(context);
  const validHash = "a".repeat(64);

  for (const command of ["apply", "resume"] as const) {
    await assert.rejects(
      runLegacyWorkspaceMigrationCli([command, `--config=${path}`]),
      new RegExp(`Migration '${command}' requires '--plan-hash=<sha256>'`, "u"),
    );
    await assert.rejects(
      runLegacyWorkspaceMigrationCli([command, `--config=${path}`, "--plan-hash=ABC"]),
      /exact 64-character migration plan hash/u,
    );
  }

  for (const command of ["plan", "status", "restore"] as const) {
    await assert.rejects(
      runLegacyWorkspaceMigrationCli([command, `--config=${path}`, `--plan-hash=${validHash}`]),
      new RegExp(`Migration '${command}' does not accept '--plan-hash'`, "u"),
    );
  }

  await assert.rejects(
    runLegacyWorkspaceMigrationCli(["resume", `--config=${path}`, `--plan-hash=${validHash}`]),
    /cannot resume because no manifest exists/u,
  );
  await assert.rejects(
    runLegacyWorkspaceMigrationCli(["restore", `--config=${path}`]),
    /has no manifest to restore/u,
  );
});

test("config loading fails closed with actionable JSON and directory errors", async (context) => {
  const root = await temporaryDirectory(context);
  const path = join(root, "config.json");
  const runStatus = () => runLegacyWorkspaceMigrationCli(["status", `--config=${path}`]);
  const example = JSON.parse(await readFile(exampleConfigPath, "utf8")) as Record<string, unknown>;

  await writeFile(path, "{not-json", "utf8");
  await assert.rejects(runStatus(), /cannot be read as JSON/u);

  await writeJson(path, []);
  await assert.rejects(runStatus(), /must be a JSON object/u);

  await writeJson(path, { schemaVersion: 1 });
  await assert.rejects(runStatus(), /must define explicit migration settings/u);

  await writeJson(path, { ...example, legacyV3SessionScopeMappings: undefined });
  await assert.rejects(runStatus(), /must define explicit legacy V3 Session scope mappings/u);

  await writeJson(path, { ...example, administration: undefined });
  await assert.rejects(runStatus(), /must define explicit Workspace administration data/u);

  await writeJson(path, { ...example, directories: undefined });
  await assert.rejects(runStatus(), /must define explicit data directories/u);

  await writeJson(path, { ...example, directories: { works: "works" } });
  await assert.rejects(runStatus(), /directory 'sessions' must be a string/u);

  await writeJson(path, {
    ...example,
    directories: {
      works: 42,
      sessions: "sessions",
      workspaceAdmin: "admin",
      batchProjects: "projects",
      videoTasks: "tasks",
      migrations: "migrations",
    },
  });
  await assert.rejects(runStatus(), /directory 'works' must be a string/u);

  await writeJson(path, {
    ...example,
    directories: {
      works: "works",
      sessions: "sessions",
      workspaceAdmin: "admin",
      batchProjects: "projects",
      videoTasks: "tasks",
      migrations: "   ",
    },
  });
  await assert.rejects(runStatus(), /Migration data directory cannot be blank/u);
});
