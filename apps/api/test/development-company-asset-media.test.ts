import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import type { MockCompanyAssetMediaManifestEntry } from "@firefly/tools";

import {
  DevelopmentCompanyAssetMediaStore,
  DevelopmentCompanyAssetMediaUnavailableError,
} from "../src/development-company-asset-media.ts";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function entry(
  overrides: Partial<MockCompanyAssetMediaManifestEntry> = {},
): MockCompanyAssetMediaManifestEntry {
  return {
    bundleId: "test-bundle",
    tenantId: "tenant_firefly",
    brandId: "brand_leapmotor_demo",
    vehicleId: "vehicle_leapmotor_c10_demo",
    assetId: "asset_leapmotor_c10_0001",
    version: 1,
    displayName: "Test image",
    visualDescription: "Visible test image content.",
    tags: ["test"],
    mediaType: "image/jpeg",
    width: 1,
    height: 1,
    byteSize: jpeg.byteLength,
    checksumSha256: createHash("sha256").update(jpeg).digest("hex"),
    relativePath: "bundle/v1/image.jpg",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "firefly-mock-media-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "bundle", "v1", "image.jpg");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, jpeg);
  return { root, target, store: new DevelopmentCompanyAssetMediaStore(root) };
}

test("development media store validates containment, magic, size, and SHA-256", async (context) => {
  const { store } = await fixture(context);
  const media = await store.read(entry());
  assert.deepEqual(media.content, jpeg);
  assert.equal(media.mediaType, "image/jpeg");
  assert.equal(media.byteSize, jpeg.byteLength);
  assert.equal(media.etag, `"sha256-${entry().checksumSha256}"`);

  await assert.rejects(
    store.read(entry({ checksumSha256: "0".repeat(64) })),
    DevelopmentCompanyAssetMediaUnavailableError,
  );
  await assert.rejects(
    store.read(entry({ byteSize: jpeg.byteLength + 1 })),
    DevelopmentCompanyAssetMediaUnavailableError,
  );
  await assert.rejects(
    store.read(entry({ mediaType: "image/webp" })),
    DevelopmentCompanyAssetMediaUnavailableError,
  );
});

test("development media store rejects absolute, Windows, ADS, and traversal manifest paths", async (context) => {
  const { store } = await fixture(context);
  for (const relativePath of [
    "../image.jpg",
    "bundle/../image.jpg",
    "/bundle/image.jpg",
    "C:/bundle/image.jpg",
    "bundle\\image.jpg",
    "bundle/image.jpg:secret",
    "bundle//image.jpg",
  ]) {
    await assert.rejects(
      store.read(entry({ relativePath })),
      DevelopmentCompanyAssetMediaUnavailableError,
      relativePath,
    );
  }
});

test("development media store rejects a symlink or junction that escapes its configured root", async (context) => {
  const { root, store } = await fixture(context);
  const outside = await mkdtemp(join(tmpdir(), "firefly-mock-media-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "image.jpg"), jpeg);
  const link = join(root, "escaped");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    store.read(entry({ relativePath: "escaped/image.jpg" })),
    DevelopmentCompanyAssetMediaUnavailableError,
  );
});

test("development media store propagates caller cancellation", async (context) => {
  const { store } = await fixture(context);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    store.read(entry(), controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("development media store preserves the configured Unicode root path", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "firefly-mock-media-unicode-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "e\u0301 assets");
  const target = join(root, "bundle", "v1", "image.jpg");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, jpeg);
  const media = await new DevelopmentCompanyAssetMediaStore(root).read(entry());
  assert.deepEqual(media.content, jpeg);
});


