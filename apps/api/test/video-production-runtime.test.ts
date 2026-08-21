import assert from "node:assert/strict";
import test from "node:test";

import { parseMp4Metadata } from "../src/video-production-runtime.ts";

function box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength);
  bytes.set([...type].map((character) => character.charCodeAt(0)), 4);
  bytes.set(payload, 8);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function validMp4(): Uint8Array {
  const ftypPayload = new Uint8Array(8);
  ftypPayload.set([0x69, 0x73, 0x6f, 0x6d]);
  const mvhdPayload = new Uint8Array(100);
  const mvhd = new DataView(mvhdPayload.buffer);
  mvhd.setUint32(12, 1_000);
  mvhd.setUint32(16, 5_000);
  const tkhdPayload = new Uint8Array(84);
  const tkhd = new DataView(tkhdPayload.buffer);
  tkhd.setUint32(tkhdPayload.byteLength - 8, 720 * 65536);
  tkhd.setUint32(tkhdPayload.byteLength - 4, 1280 * 65536);
  return concat(
    box("ftyp", ftypPayload),
    box("moov", concat(box("mvhd", mvhdPayload), box("trak", box("tkhd", tkhdPayload)))),
  );
}

test("real video ingestion derives dimensions and duration from MP4 bytes", () => {
  assert.deepEqual(parseMp4Metadata(validMp4()), {
    width: 720,
    height: 1280,
    durationMs: 5_000,
  });
});

test("real video ingestion rejects non-MP4 and incomplete metadata", () => {
  assert.throws(() => parseMp4Metadata(new Uint8Array(32)), /valid MP4/u);
  assert.throws(() => parseMp4Metadata(box("ftyp", new Uint8Array(8))), /metadata is missing/u);
});
