import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BatchProject, ProjectAssetPool } from "@firefly/schemas";

import {
  BatchProjectAssetPoolStoreAdapter,
  LocalBatchProjectStore,
  type BatchProjectCreateMetadata,
} from "../src/batch-project-store.ts";
import type { ProjectAssetPoolStore } from "../src/project-asset-pool-store.ts";

function metadata(
  requestId = "request_create_project",
  payloadHash = "payload_hash_v1",
): BatchProjectCreateMetadata {
  return { requestId, actorAccountId: "account_creator", payloadHash };
}

function project(
  id = "project_e5_launch",
  name = "萤火汽车 萤火 E5 9:16 夏季上新",
  tenantId = "tenant_firefly",
): BatchProject {
  return {
    id,
    tenantId,
    brandId: "brand_firefly_demo",
    vehicleId: "vehicle_firefly_e5_2026_long_range",
    vehicleVersion: 1,
    name,
    batchName: "夏季上新",
    aspectRatio: "9:16",
    visualStylePresetId: "asset_style_firefly_demo_clean",
    customStylePrompt: "清爽夏日公路氛围",
    assetPoolId: `asset_pool_${id}`,
    status: "active",
    revision: 1,
    createdAt: "2026-08-19T00:00:00.000Z",
    createdBy: "account_creator",
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "account_creator",
  };
}

function assetPool(value = project()): ProjectAssetPool {
  return {
    id: value.assetPoolId,
    tenantId: value.tenantId,
    batchProjectId: value.id,
    vehicleId: value.vehicleId,
    revision: 1,
    assets: [
      {
        assetId: "asset_firefly_demo_e5_hero",
        version: 1,
        category: "vehicle",
        source: "company_catalog",
        sourceProvider: "mock_company_assets",
        vehicleId: value.vehicleId,
      },
    ],
    createdAt: value.createdAt,
    createdBy: value.createdBy,
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy,
  };
}

test("batch project store creates, loads, and lists defensive aggregate copies", async () => {
  const store = new LocalBatchProjectStore(".data/test-batch-project-copies", false);
  const input = project();
  const saved = await store.create(input, assetPool(input), metadata());
  saved.project.name = "attacker mutation";
  saved.assetPool.assets[0]!.version = 99;
  const loaded = await store.load("tenant_firefly", "project_e5_launch");
  assert.equal(loaded?.project.name, "萤火汽车 萤火 E5 9:16 夏季上新");
  assert.equal(loaded?.assetPool.assets[0]?.version, 1);
  loaded!.project.batchName = "another mutation";
  const listed = await store.list("tenant_firefly");
  listed[0]!.project.name = "list mutation";
  assert.equal(
    (await store.load("tenant_firefly", "project_e5_launch"))?.project.batchName,
    "夏季上新",
  );
  assert.equal((await store.list("tenant_other")).length, 0);
});

test("project and asset pool survive restart in one atomic aggregate file", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-batch-projects-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const input = project();
  const first = new LocalBatchProjectStore(directory);
  const saved = await first.create(input, assetPool(input), metadata());

  assert.deepEqual(
    await readdir(join(directory, "tenant_firefly")),
    ["project_e5_launch.json"],
  );
  const persisted = JSON.parse(
    await readFile(join(directory, "tenant_firefly", "project_e5_launch.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(Object.keys(persisted).sort(), [
    "actorAccountId",
    "assetPool",
    "payloadHash",
    "project",
    "requestId",
    "schemaVersion",
  ]);
  const restored = new LocalBatchProjectStore(directory);
  assert.deepEqual(await restored.load("tenant_firefly", input.id), saved);
  assert.deepEqual(
    await restored.loadByRequest(
      input.tenantId,
      saved.actorAccountId,
      saved.requestId,
    ),
    saved,
  );
  assert.deepEqual(await restored.list("tenant_firefly"), [saved]);
});

test("legacy batch project aggregates fail closed until vehicle version migration", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-legacy-batch-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const input = project();
  const { vehicleVersion: _vehicleVersion, ...legacyProject } = input;
  const tenantDirectory = join(directory, input.tenantId);
  await mkdir(tenantDirectory);
  await writeFile(
    join(tenantDirectory, `${input.id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      ...metadata(),
      project: legacyProject,
      assetPool: assetPool(input),
    }),
    "utf8",
  );

  await assert.rejects(
    new LocalBatchProjectStore(directory).load(input.tenantId, input.id),
    /explicit vehicle fact version migration/u,
  );
});

test("batch project creation rejects duplicate IDs and normalized names", async () => {
  const store = new LocalBatchProjectStore(".data/test-batch-project-duplicates", false);
  const first = project();
  await store.create(first, assetPool(first), metadata("request_first"));
  const duplicateId = project("project_e5_launch", "A different name");
  await assert.rejects(
    store.create(duplicateId, assetPool(duplicateId), metadata("request_duplicate_id")),
    /same ID already exists/u,
  );
  const duplicateName = project(
    "project_other",
    "  萤火汽车 萤火 E5 9:16 夏季上新  ",
  );
  await assert.rejects(
    store.create(
      duplicateName,
      assetPool(duplicateName),
      metadata("request_duplicate_name"),
    ),
    /same name already exists/u,
  );
  const otherTenant = project(
    "project_other_tenant",
    "萤火汽车 萤火 E5 9:16 夏季上新",
    "tenant_other",
  );
  await assert.doesNotReject(
    store.create(otherTenant, assetPool(otherTenant), metadata("request_other_tenant")),
  );
});

test("concurrent creates in one tenant allow only one duplicate", async () => {
  const store = new LocalBatchProjectStore(".data/test-batch-project-concurrent", false);
  const first = project("project_first", "Concurrent launch");
  const second = project("project_second", "Concurrent launch");
  const attempts = await Promise.allSettled([
    store.create(first, assetPool(first), metadata("request_first")),
    store.create(second, assetPool(second), metadata("request_second")),
  ]);

  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  assert.equal((await store.list("tenant_firefly")).length, 1);
});

test("creation request metadata supports replay and rejects payload conflicts", async () => {
  const store = new LocalBatchProjectStore(".data/test-batch-project-idempotency", false);
  const input = project();
  const creation = metadata("request_idempotent", "payload_hash_original");
  const [first, replay] = await Promise.all([
    store.create(input, assetPool(input), creation),
    store.create(input, assetPool(input), creation),
  ]);

  assert.deepEqual(replay, first);
  assert.equal((await store.list(input.tenantId)).length, 1);
  assert.deepEqual(
    await store.loadByRequest(input.tenantId, creation.actorAccountId, creation.requestId),
    first,
  );
  await assert.rejects(
    store.create(
      input,
      assetPool(input),
      metadata("request_idempotent", "payload_hash_different"),
    ),
    /conflicts with a different payload/u,
  );
});

test("aggregate validation enforces project and asset pool identity and scope", async () => {
  const store = new LocalBatchProjectStore(".data/test-invalid-batch-project", false);
  const input = project();
  const pool = assetPool(input);
  await assert.rejects(
    store.create({ ...input, revision: 0 }, pool, metadata()),
    /invalid format or scope/u,
  );
  await assert.rejects(
    store.create(input, { ...pool, batchProjectId: "project_other" }, metadata()),
    /invalid format or scope/u,
  );
  await assert.rejects(
    store.create(input, { ...pool, vehicleId: "vehicle_other" }, metadata()),
    /invalid format or scope/u,
  );
  await assert.rejects(
    store.create(input, { ...pool, tenantId: "tenant_other" }, metadata()),
    /invalid format or scope/u,
  );
});

test("persisted aggregate schema and tenant scope are validated", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-invalid-batch-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const tenantDirectory = join(directory, "tenant_firefly");
  await mkdir(tenantDirectory);
  const input = project("project_e5_launch", "Cross tenant", "tenant_other");
  await writeFile(
    join(tenantDirectory, "project_e5_launch.json"),
    JSON.stringify({
      schemaVersion: 2,
      ...metadata(),
      project: input,
      assetPool: assetPool(input),
    }),
    "utf8",
  );
  await assert.rejects(
    new LocalBatchProjectStore(directory).load("tenant_firefly", "project_e5_launch"),
    /invalid format or scope/u,
  );
});

test("asset pool transaction updates the aggregate without modifying its project", async () => {
  const store = new LocalBatchProjectStore(".data/test-batch-project-pool-update", false);
  const input = project();
  await store.create(input, assetPool(input), metadata());
  const before = await store.load(input.tenantId, input.id);
  const updated = await store.transactAssetPool(input.tenantId, input.id, (current) => ({
    ...current,
    revision: current.revision + 1,
    updatedAt: "2026-08-19T01:00:00.000Z",
  }));
  const after = await store.load(input.tenantId, input.id);

  assert.equal(updated.revision, 2);
  assert.deepEqual(after?.project, before?.project);
  assert.deepEqual(after?.assetPool, updated);
  updated.revision = 99;
  assert.equal((await store.load(input.tenantId, input.id))?.assetPool.revision, 2);
});

test("aggregate asset pools are consumable through the existing asset-pool store contract", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-batch-project-adapter-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const input = project();
  const projects = new LocalBatchProjectStore(directory);
  await projects.create(input, assetPool(input), metadata());
  const pools: ProjectAssetPoolStore = new BatchProjectAssetPoolStoreAdapter(projects);

  const loaded = await pools.load(input.id);
  assert.deepEqual(loaded, assetPool(input));
  loaded!.revision = 99;
  const updated = await pools.transact(input.id, (current) => {
    assert.ok(current);
    return {
      ...current,
      revision: current.revision + 1,
      updatedAt: "2026-08-19T02:00:00.000Z",
    };
  });

  assert.equal(updated.revision, 2);
  assert.deepEqual((await projects.load(input.tenantId, input.id))?.project, input);
  assert.deepEqual(
    await new BatchProjectAssetPoolStoreAdapter(
      new LocalBatchProjectStore(directory),
    ).load(input.id),
    updated,
  );
  assert.deepEqual(
    await readdir(join(directory, input.tenantId)),
    [`${input.id}.json`],
  );
});

test("aggregate asset-pool adapter fails closed for missing or cross-tenant ambiguous project IDs", async () => {
  const projects = new LocalBatchProjectStore(".data/test-batch-project-adapter-scope", false);
  const first = project("project_shared", "Tenant one", "tenant_one");
  const second = project("project_shared", "Tenant two", "tenant_two");
  await projects.create(first, assetPool(first), metadata("request_tenant_one"));
  await projects.create(second, assetPool(second), metadata("request_tenant_two"));
  const pools: ProjectAssetPoolStore = new BatchProjectAssetPoolStoreAdapter(projects);

  assert.equal(await pools.load("project_missing"), undefined);
  await assert.rejects(
    pools.transact("project_missing", () => assetPool(first)),
    /Batch project was not found/u,
  );
  await assert.rejects(pools.load("project_shared"), /ambiguous across tenants/u);
  await assert.rejects(
    pools.transact("project_shared", (current) => {
      assert.ok(current);
      return current;
    }),
    /ambiguous across tenants/u,
  );
});

test("batch project identifiers cannot escape the configured directory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-batch-project-path-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new LocalBatchProjectStore(directory);
  await assert.rejects(store.load("../outside", "project_safe"), /invalid characters/u);
  await assert.rejects(store.load("tenant_safe", "..\\outside"), /invalid characters/u);
  const escaped = project("../outside");
  await assert.rejects(
    store.create(escaped, assetPool(escaped), metadata()),
    /invalid characters/u,
  );
  assert.deepEqual(await readdir(directory), []);
});
