import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";

import type { GeneratedVideoArtifact, SeedanceArtifactImporter } from "@firefly/tools";
import type { BatchProjectStore } from "./batch-project-store.ts";
import type { VideoTaskProductionStore } from "./video-task-store.ts";

const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

const maximumVideoBytes = 200 * 1024 * 1024;

function isMp4(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
}

function hasAudioTrack(bytes: Buffer): boolean {
  const handlerAtom = Buffer.from("hdlr", "ascii");
  let offset = 0;
  while ((offset = bytes.indexOf(handlerAtom, offset)) >= 0) {
    const handlerTypeOffset = offset + 12;
    if (
      handlerTypeOffset + 4 <= bytes.length &&
      bytes.toString("ascii", handlerTypeOffset, handlerTypeOffset + 4) === "soun"
    ) return true;
    offset += handlerAtom.length;
  }
  return false;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error("Generated video scope contains an invalid identifier.");
  return value;
}

function dimensions(aspectRatio: string): readonly [number, number] {
  if (aspectRatio === "16:9") return [1920, 1080];
  if (aspectRatio === "1:1") return [1080, 1080];
  return [1080, 1920];
}

export class GeneratedVideoArtifactImporter implements SeedanceArtifactImporter {
  readonly #root: string;

  constructor(
    root: string,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskProductionStore,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.#root = resolve(root);
  }

  async importVideo(request: Parameters<SeedanceArtifactImporter["importVideo"]>[0]): Promise<GeneratedVideoArtifact> {
    const source = new URL(request.sourceUrl);
    if (source.protocol !== "https:" && source.hostname !== "127.0.0.1" && source.hostname !== "localhost") {
      throw new Error("Generated video download URL must use HTTPS.");
    }
    const response = await this.fetchImpl(source, {
      redirect: "error",
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!response.ok) throw new Error(`Generated video download failed (HTTP ${response.status}).`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maximumVideoBytes) {
      throw new Error("Generated video exceeds the maximum allowed size.");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maximumVideoBytes || !isMp4(bytes)) {
      throw new Error("Generated video is not a valid bounded MP4 file.");
    }
    if (!hasAudioTrack(bytes)) {
      throw new Error("Seedance returned an MP4 without an audio track; the silent result was rejected.");
    }

    const task = await this.tasks.load(request.scope.videoTaskId);
    const project = await this.projects.load(request.scope.tenantId, request.scope.batchProjectId);
    if (!task || !project || task.videoTask.batchProjectId !== project.project.id) {
      throw new Error("Generated video target task was not found.");
    }
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = [
      safeSegment(request.scope.tenantId), safeSegment(request.scope.batchProjectId),
      safeSegment(request.scope.videoTaskId), `${safeSegment(request.providerJobId)}.mp4`,
    ].join("/");
    const target = this.resolveStoragePath(storageKey);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" }).catch(async (error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await readFile(target);
      if (createHash("sha256").update(existing).digest("hex") !== checksumSha256) {
        throw new Error("Generated video storage key already contains different content.");
      }
    });
    const [width, height] = dimensions(project.project.aspectRatio);
    return {
      artifactId: `generated_video_${checksumSha256.slice(0, 48)}`,
      storageKey,
      mediaType: "video/mp4",
      width,
      height,
      durationSeconds: Math.min(5, task.videoTask.durationSeconds),
      checksumSha256,
    };
  }

  resolveStoragePath(storageKey: string): string {
    const target = resolve(this.#root, storageKey);
    if (target !== this.#root && !target.startsWith(`${this.#root}${sep}`)) {
      throw new Error("Generated video storage key escaped the configured directory.");
    }
    return target;
  }

  async composeVideo(input: Readonly<{
    tenantId: string;
    batchProjectId: string;
    videoTaskId: string;
    compositionId: string;
    aspectRatio: string;
    durationSeconds: number;
    sourceDurationsSeconds: readonly number[];
    sources: readonly GeneratedVideoArtifact[];
  }>): Promise<GeneratedVideoArtifact> {
    if (!ffmpegPath) throw new Error("The bundled FFmpeg runtime is unavailable.");
    if (input.sources.length < 2) throw new Error("At least two generated shots are required for composition.");
    if (input.sourceDurationsSeconds.length !== input.sources.length
      || input.sourceDurationsSeconds.some((duration) => !Number.isSafeInteger(duration) || duration < 1)
      || input.sourceDurationsSeconds.reduce((total, duration) => total + duration, 0) !== input.durationSeconds) {
      throw new Error("Composition source durations must be positive integers that add up to the target duration.");
    }
    const baseKey = [safeSegment(input.tenantId), safeSegment(input.batchProjectId), safeSegment(input.videoTaskId), "compositions"].join("/");
    const compositionId = safeSegment(input.compositionId);
    const storageKey = `${baseKey}/${compositionId}.mp4`;
    const outputPath = this.resolveStoragePath(storageKey);
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    const sourcePaths = input.sources.map((source) => this.resolveStoragePath(source.storageKey));
    const inputArgs = sourcePaths.flatMap((path) => ["-i", path]);
    const trimmedInputs = input.sourceDurationsSeconds.flatMap(
      (duration, index) => [
        `[${index}:v]trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`,
        `[${index}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`,
      ],
    );
    const concatInputs = input.sources.map((_source, index) => `[v${index}][a${index}]`).join("");
    const filter = `${trimmedInputs.join(";")};${concatInputs}concat=n=${input.sources.length}:v=1:a=1[v][a]`;
    await new Promise<void>((resolveRun, rejectRun) => {
      const process = spawn(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", ...inputArgs,
        "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-y", outputPath,
      ], { windowsHide: true });
      let details = "";
      process.stderr.on("data", (chunk: Buffer) => { details = `${details}${chunk.toString("utf8")}`.slice(-4000); });
      process.once("error", rejectRun);
      process.once("exit", (code) => code === 0
        ? resolveRun()
        : rejectRun(new Error(`Video composition failed${details ? `: ${details.trim()}` : "."}`)));
    });
    const bytes = await readFile(outputPath);
    if (bytes.length === 0 || bytes.length > maximumVideoBytes || !isMp4(bytes) || !hasAudioTrack(bytes)) {
      throw new Error("Composed video is invalid or has no audio track.");
    }
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const [width, height] = dimensions(input.aspectRatio);
    return {
      artifactId: `composed_video_${checksumSha256.slice(0, 48)}`,
      storageKey,
      mediaType: "video/mp4",
      width,
      height,
      durationSeconds: input.durationSeconds,
      checksumSha256,
    };
  }
}
