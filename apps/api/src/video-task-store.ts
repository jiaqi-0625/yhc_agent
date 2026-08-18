import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import type { VideoTaskProductionRecord } from "@firefly/domain";

function assertVideoTaskId(videoTaskId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(videoTaskId)) {
    throw new Error("Video task ID contains invalid characters.");
  }
}

export interface VideoTaskProductionStore {
  load(videoTaskId: string): Promise<VideoTaskProductionRecord | undefined>;
  save(record: VideoTaskProductionRecord): Promise<void>;
}

export class LocalVideoTaskProductionStore implements VideoTaskProductionStore {
  readonly #directory: string;
  readonly #memory = new Map<string, VideoTaskProductionRecord>();

  constructor(directory = ".data/video-tasks", readonly persist = true) {
    this.#directory = resolve(directory);
  }

  #path(videoTaskId: string): string {
    assertVideoTaskId(videoTaskId);
    const path = resolve(join(this.#directory, `${videoTaskId}.json`));
    if (!path.startsWith(`${this.#directory}${sep}`)) {
      throw new Error("Video task path escaped the configured data directory.");
    }
    return path;
  }

  async load(videoTaskId: string): Promise<VideoTaskProductionRecord | undefined> {
    const memory = this.#memory.get(videoTaskId);
    if (memory) return structuredClone(memory);
    if (!this.persist) return undefined;
    try {
      const parsed = JSON.parse(await readFile(this.#path(videoTaskId), "utf8")) as VideoTaskProductionRecord;
      if (parsed.schemaVersion !== 1 || parsed.videoTask.id !== videoTaskId) {
        throw new Error("Persisted video task has an invalid format.");
      }
      this.#memory.set(videoTaskId, structuredClone(parsed));
      return structuredClone(parsed);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(record: VideoTaskProductionRecord): Promise<void> {
    const copy = structuredClone(record);
    if (this.persist) {
      const path = this.#path(record.videoTask.id);
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(copy, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      try {
        await rename(temporaryPath, path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    }
    this.#memory.set(record.videoTask.id, copy);
  }
}
