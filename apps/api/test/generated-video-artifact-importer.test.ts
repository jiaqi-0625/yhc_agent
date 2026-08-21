import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { GeneratedVideoArtifact } from "@firefly/tools";

import type { BatchProjectStore } from "../src/batch-project-store.ts";
import { GeneratedVideoArtifactImporter } from "../src/generated-video-artifact-importer.ts";
import type { VideoTaskProductionStore } from "../src/video-task-store.ts";

const run = promisify(execFile);
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

test("bundled FFmpeg composes generated shots into one playable MP4", async (context) => {
  assert.ok(ffmpegPath, "ffmpeg-static must resolve to a bundled executable");
  const root = await mkdtemp(join(tmpdir(), "firefly-video-composition-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const scope = join(root, "tenant_firefly", "project_ad", "task_ad");
  await mkdir(scope, { recursive: true });
  const shot1 = join(scope, "shot_1.mp4");
  const shot2 = join(scope, "shot_2.mp4");
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", shot1]);
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=2", "-f", "lavfi", "-i", "sine=frequency=660:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", shot2]);
  const artifact = (storageKey: string, artifactId: string): GeneratedVideoArtifact => ({
    artifactId, storageKey, mediaType: "video/mp4", width: 160, height: 90,
    durationSeconds: 1, checksumSha256: "a".repeat(64),
  });
  const importer = new GeneratedVideoArtifactImporter(
    root,
    {} as BatchProjectStore,
    {} as VideoTaskProductionStore,
  );
  const result = await importer.composeVideo({
    tenantId: "tenant_firefly",
    batchProjectId: "project_ad",
    videoTaskId: "task_ad",
    compositionId: "composition_test",
    aspectRatio: "16:9",
    durationSeconds: 2,
    sourceDurationsSeconds: [1, 1],
    sources: [
      artifact("tenant_firefly/project_ad/task_ad/shot_1.mp4", "shot_1"),
      artifact("tenant_firefly/project_ad/task_ad/shot_2.mp4", "shot_2"),
    ],
  });
  const bytes = await readFile(importer.resolveStoragePath(result.storageKey));
  assert.ok(bytes.length > 0);
  assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
  assert.ok(bytes.includes(Buffer.from("soun", "ascii")), "composed MP4 must retain an audio track");
  assert.equal(result.durationSeconds, 2);
  assert.match(result.checksumSha256, /^[a-f0-9]{64}$/u);
});
