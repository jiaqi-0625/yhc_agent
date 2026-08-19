import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import type { VideoTaskProductionRecord } from "@firefly/domain";
import type {
  StageArtifactVersion,
  StageConfirmation,
  VideoTask,
  VideoTaskStage,
} from "@firefly/schemas";

interface LegacyVideoTaskProductionRecord {
  schemaVersion: 1;
  videoTask: VideoTask;
  stageArtifactVersions: StageArtifactVersion[];
  stageConfirmations: StageConfirmation[];
}

type LegacyVideoTaskProductionRecordV3 = Omit<
  VideoTaskProductionRecord,
  "schemaVersion" | "taskAssetSnapshots"
> & { schemaVersion: 3 };

type LegacyVideoTaskProductionRecordV2 = Omit<
  LegacyVideoTaskProductionRecordV3,
  "schemaVersion" | "ownershipTransfers"
> & { schemaVersion: 2 };

function assertVideoTaskId(videoTaskId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(videoTaskId)) {
    throw new Error("Video task ID contains invalid characters.");
  }
}

export interface VideoTaskProductionStore {
  load(videoTaskId: string): Promise<VideoTaskProductionRecord | undefined>;
  save(record: VideoTaskProductionRecord): Promise<void>;
  transact(
    videoTaskId: string,
    update: (
      current: VideoTaskProductionRecord | undefined,
    ) => VideoTaskProductionRecord | Promise<VideoTaskProductionRecord>,
  ): Promise<VideoTaskProductionRecord>;
}

function upgradeRecord(
  parsed:
    | VideoTaskProductionRecord
    | LegacyVideoTaskProductionRecordV3
    | LegacyVideoTaskProductionRecordV2
    | LegacyVideoTaskProductionRecord,
  videoTaskId: string,
): VideoTaskProductionRecord {
  if (parsed.videoTask.id !== videoTaskId) {
    throw new Error("Persisted video task has an invalid format.");
  }
  if (parsed.schemaVersion === 4) return parsed;
  if (parsed.schemaVersion === 3) {
    return {
      ...structuredClone(parsed),
      schemaVersion: 4,
      taskAssetSnapshots: [],
    };
  }
  if (parsed.schemaVersion === 2) {
    return {
      ...structuredClone(parsed),
      schemaVersion: 4,
      ownershipTransfers: [],
      taskAssetSnapshots: [],
    };
  }
  if ((parsed as { schemaVersion: number }).schemaVersion !== 1) {
    throw new Error("Persisted video task has an unsupported schema version.");
  }
  const activeStageArtifactVersionIds: Partial<Record<VideoTaskStage, string>> = {};
  for (const artifact of parsed.stageArtifactVersions) {
    const activeId = activeStageArtifactVersionIds[artifact.stage];
    const active = parsed.stageArtifactVersions.find((item) => item.id === activeId);
    if (!active || artifact.version > active.version) {
      activeStageArtifactVersionIds[artifact.stage] = artifact.id;
    }
  }
  return {
    schemaVersion: 4,
    videoTask: structuredClone(parsed.videoTask),
    stageArtifactVersions: structuredClone(parsed.stageArtifactVersions),
    stageConfirmations: structuredClone(parsed.stageConfirmations),
    activeStageArtifactVersionIds,
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskAssetSnapshots: [],
  };
}

export class LocalVideoTaskProductionStore implements VideoTaskProductionStore {
  readonly #directory: string;
  readonly #memory = new Map<string, VideoTaskProductionRecord>();
  readonly #transactionTails = new Map<string, Promise<void>>();

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
      const parsed = JSON.parse(await readFile(this.#path(videoTaskId), "utf8")) as
        | VideoTaskProductionRecord
        | LegacyVideoTaskProductionRecordV3
        | LegacyVideoTaskProductionRecordV2
        | LegacyVideoTaskProductionRecord;
      const upgraded = upgradeRecord(parsed, videoTaskId);
      this.#memory.set(videoTaskId, structuredClone(upgraded));
      return structuredClone(upgraded);
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

  async transact(
    videoTaskId: string,
    update: (
      current: VideoTaskProductionRecord | undefined,
    ) => VideoTaskProductionRecord | Promise<VideoTaskProductionRecord>,
  ): Promise<VideoTaskProductionRecord> {
    assertVideoTaskId(videoTaskId);
    const previous = this.#transactionTails.get(videoTaskId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.#transactionTails.set(videoTaskId, tail);
    await previous;
    try {
      const next = await update(await this.load(videoTaskId));
      if (next.videoTask.id !== videoTaskId) {
        throw new Error("A video task transaction cannot change the aggregate identity.");
      }
      await this.save(next);
      return structuredClone(next);
    } finally {
      release();
      if (this.#transactionTails.get(videoTaskId) === tail) {
        this.#transactionTails.delete(videoTaskId);
      }
    }
  }
}
