import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TemporaryAsset } from "@firefly/schemas";

import { LocalTemporaryAssetStore } from "../src/temporary-asset-store.ts";

function asset(
  id = "temporary_asset_1",
  batchProjectId = "project_launch",
): TemporaryAsset {
  return {
    id,
    tenantId: "tenant_firefly",
    batchProjectId,
    vehicleId: "vehicle_e5",
    version: 1,
    revision: 1,
    category: "vehicle",
    fileName: `${id}.png`,
    mediaType: "image/png",
    byteSize: 1024,
    width: 1920,
    height: 1080,
    checksumSha256: "a".repeat(64),
    sourceDescription: "Uploaded by the project producer.",
    rightsDeclaration: "The producer confirms project usage rights.",
    rightsConfirmed: true,
    validationStatus: "valid",
    validationIssues: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_creator",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_creator",
  };
}

test("temporary asset transactions are serialized by batch project ID", async () => {
  const store = new LocalTemporaryAssetStore(
    ".data/test-temporary-assets",
    false,
  );
  await store.transactProject("project_launch", () => [asset()]);

  let releaseFirst = (): void => undefined;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered = (): void => undefined;
  const firstDidEnter = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const seenLengths: number[] = [];

  const first = store.transactProject("project_launch", async (current) => {
    seenLengths.push(current.length);
    firstEntered();
    await firstMayFinish;
    return [...current, asset("temporary_asset_2")];
  });
  await firstDidEnter;
  const second = store.transactProject("project_launch", (current) => {
    seenLengths.push(current.length);
    return [...current, asset("temporary_asset_3")];
  });

  await Promise.resolve();
  assert.deepEqual(seenLengths, [1]);
  releaseFirst();
  const [, result] = await Promise.all([first, second]);
  assert.deepEqual(seenLengths, [1, 2]);
  assert.deepEqual(
    result.map((item) => item.id),
    ["temporary_asset_1", "temporary_asset_2", "temporary_asset_3"],
  );
});

test("temporary assets survive a local store restart in a versioned record", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-temporary-assets-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const first = new LocalTemporaryAssetStore(directory);
  const saved = await first.transactProject("project_launch", () => [asset()]);

  const path = join(directory, "project_launch.json");
  const record = JSON.parse(await readFile(path, "utf8")) as {
    schemaVersion: number;
    batchProjectId: string;
  };
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.batchProjectId, "project_launch");
  assert.deepEqual(
    await new LocalTemporaryAssetStore(directory).loadProject("project_launch"),
    saved,
  );
  assert.deepEqual(await readdir(directory), ["project_launch.json"]);
});

test("temporary asset store returns defensive copies", async () => {
  const store = new LocalTemporaryAssetStore(
    ".data/test-temporary-asset-copies",
    false,
  );
  const saved = await store.transactProject("project_launch", () => [asset()]);
  saved[0]!.revision = 99;
  const loaded = await store.loadProject("project_launch");
  assert.equal(loaded[0]?.revision, 1);
  loaded[0]!.revision = 88;
  assert.equal((await store.loadProject("project_launch"))[0]?.revision, 1);

  await assert.rejects(
    store.transactProject("project_launch", (current) => {
      current[0]!.revision = 77;
      throw new Error("cancel update");
    }),
    /cancel update/u,
  );
  assert.equal((await store.loadProject("project_launch"))[0]?.revision, 1);
});

test("temporary asset store rejects invalid scope, schema, and duplicate IDs", async () => {
  const store = new LocalTemporaryAssetStore(
    ".data/test-temporary-asset-validation",
    false,
  );
  await assert.rejects(
    store.transactProject("project_launch", () => [asset("asset_1", "project_other")]),
    /invalid format, scope, or duplicate ID/u,
  );
  await assert.rejects(
    store.transactProject("project_launch", () => [
      asset("asset_1"),
      asset("asset_1"),
    ]),
    /invalid format, scope, or duplicate ID/u,
  );
  await assert.rejects(
    store.transactProject("project_launch", () => [
      { ...asset("asset_1"), width: 0 },
    ]),
    /invalid format, scope, or duplicate ID/u,
  );
});

test("temporary asset store validates persisted record version and project scope", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-invalid-assets-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "project_launch.json"),
    JSON.stringify({
      schemaVersion: 2,
      batchProjectId: "project_launch",
      assets: [asset()],
    }),
    "utf8",
  );

  await assert.rejects(
    new LocalTemporaryAssetStore(directory).loadProject("project_launch"),
    /invalid format or scope/u,
  );
});
