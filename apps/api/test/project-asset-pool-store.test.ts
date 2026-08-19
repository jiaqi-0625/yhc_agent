import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProjectAssetPool } from "@firefly/schemas";

import { LocalProjectAssetPoolStore } from "../src/project-asset-pool-store.ts";

function pool(batchProjectId = "project_launch"): ProjectAssetPool {
  return {
    id: `pool_${batchProjectId}`,
    tenantId: "tenant_firefly",
    batchProjectId,
    vehicleId: "vehicle_e5",
    revision: 1,
    assets: [
      {
        assetId: "asset_vehicle_e5_front",
        version: 1,
        category: "vehicle",
        source: "company_catalog",
        sourceProvider: "mock_catalog",
        vehicleId: "vehicle_e5",
      },
    ],
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_creator",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_creator",
  };
}

test("project asset pool transactions are serialized by batch project ID", async () => {
  const store = new LocalProjectAssetPoolStore(".data/test-project-asset-pools", false);
  await store.transact("project_launch", () => pool());

  let releaseFirst = (): void => undefined;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered = (): void => undefined;
  const firstDidEnter = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const seenRevisions: number[] = [];

  const first = store.transact("project_launch", async (current) => {
    assert.ok(current);
    seenRevisions.push(current.revision);
    firstEntered();
    await firstMayFinish;
    return {
      ...current,
      revision: current.revision + 1,
      updatedAt: "2026-08-19T01:00:00.000Z",
    };
  });
  await firstDidEnter;
  const second = store.transact("project_launch", (current) => {
    assert.ok(current);
    seenRevisions.push(current.revision);
    return {
      ...current,
      revision: current.revision + 1,
      updatedAt: "2026-08-19T02:00:00.000Z",
    };
  });

  await Promise.resolve();
  assert.deepEqual(seenRevisions, [1]);
  releaseFirst();
  const [, result] = await Promise.all([first, second]);
  assert.deepEqual(seenRevisions, [1, 2]);
  assert.equal(result.revision, 3);
  assert.equal((await store.load("project_launch"))?.revision, 3);
});

test("project asset pools survive a local store restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-project-asset-pool-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const first = new LocalProjectAssetPoolStore(directory);
  const saved = await first.transact("project_launch", () => pool());

  const restored = await new LocalProjectAssetPoolStore(directory).load("project_launch");
  assert.deepEqual(restored, saved);
});

test("project asset pool store validates aggregate scope and returns defensive copies", async () => {
  const store = new LocalProjectAssetPoolStore(".data/test-project-asset-copies", false);
  const saved = await store.transact("project_launch", () => pool());
  saved.assets[0]!.version = 99;
  const loaded = await store.load("project_launch");
  assert.equal(loaded?.assets[0]?.version, 1);
  loaded!.assets[0]!.version = 88;
  assert.equal((await store.load("project_launch"))?.assets[0]?.version, 1);

  await assert.rejects(
    store.transact("project_launch", () => pool("project_other")),
    /invalid format or scope/u,
  );
  await assert.rejects(
    store.transact("project_launch", () => ({ ...pool(), revision: 0 })),
    /invalid format or scope/u,
  );
});
