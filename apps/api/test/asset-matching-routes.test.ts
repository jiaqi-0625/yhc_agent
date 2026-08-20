import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BusinessRuntimeError } from "../src/business-runtime.ts";
import { inspectTemporaryImage } from "../src/asset-matching-routes.ts";

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("temporary upload inspection derives file facts from image bytes", () => {
  const bytes = png(1920, 1080);
  const result = inspectTemporaryImage("scene.png", bytes.toString("base64"));
  assert.deepEqual(result, {
    fileName: "scene.png",
    mediaType: "image/png",
    byteSize: bytes.length,
    width: 1920,
    height: 1080,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  });
});

test("temporary upload inspection rejects non-image bytes and malformed encoding", () => {
  for (const value of ["not base64", Buffer.from("forged").toString("base64")]) {
    assert.throws(
      () => inspectTemporaryImage("scene.png", value),
      BusinessRuntimeError,
    );
  }
});
