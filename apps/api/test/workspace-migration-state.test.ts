import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { WorkspaceMigrationStateStore } from "../src/workspace-migration-state.ts";

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "firefly-workspace-migration-state-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function writeManifest(
  store: WorkspaceMigrationStateStore,
  migrationId: string,
  status: "in_progress" | "completed" | "restored",
): Promise<void> {
  const path = store.manifestPath(migrationId);
  await mkdir(join(store.directory, migrationId), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    migrationId,
    status,
  })}\n`, "utf8");
}

test("an active API lease blocks the offline migration lease until release", async (context) => {
  const store = new WorkspaceMigrationStateStore(await temporaryDirectory(context));
  const apiLease = await store.acquireApiLease();

  await assert.rejects(
    store.acquireMigrationLease("migration_api_guard"),
    /API is still using workspace data \(1 active lease\(s\)\)/u,
  );

  await apiLease.release();
  await apiLease.release();
  const migrationLease = await store.acquireMigrationLease("migration_api_guard");
  await migrationLease.release();
});

test("an active migration lease blocks every API lease until release", async (context) => {
  const store = new WorkspaceMigrationStateStore(await temporaryDirectory(context));
  const migrationLease = await store.acquireMigrationLease("migration_offline_guard");

  await assert.rejects(
    store.acquireApiLease(),
    /offline workspace migration currently owns the data lifecycle lock/u,
  );

  await migrationLease.release();
  const apiLease = await store.acquireApiLease();
  await apiLease.release();
});

test("an in-progress manifest keeps API startup fail-closed after a migrator crash", async (context) => {
  const store = new WorkspaceMigrationStateStore(await temporaryDirectory(context));
  await writeManifest(store, "migration_interrupted", "in_progress");

  assert.deepEqual(await store.inspect(), {
    inProgressMigrationIds: ["migration_interrupted"],
    completedMigrationIds: [],
    restoredMigrationIds: [],
  });
  await assert.rejects(
    store.assertApiCanStart(),
    /migration is incomplete \(migration_interrupted\)/u,
  );
  await assert.rejects(
    store.acquireApiLease(),
    /resume or restore it before starting the API/u,
  );
});

test("completed and restored manifests are ordered audit history and no longer block API leases", async (context) => {
  const store = new WorkspaceMigrationStateStore(await temporaryDirectory(context));
  await writeManifest(store, "migration_z_completed", "completed");
  await writeManifest(store, "migration_a_completed", "completed");
  await writeManifest(store, "migration_restored", "restored");

  assert.deepEqual(await store.assertApiCanStart(), {
    inProgressMigrationIds: [],
    completedMigrationIds: ["migration_a_completed", "migration_z_completed"],
    restoredMigrationIds: ["migration_restored"],
  });
  const apiLease = await store.acquireApiLease();
  await apiLease.release();
});
