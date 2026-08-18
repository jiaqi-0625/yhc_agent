import { randomUUID } from "node:crypto";

import {
  confirmVideoTaskStage,
  type ConfirmStageCommand,
  type VideoTaskProductionRecord,
} from "@firefly/domain";

import type { VideoTaskProductionStore } from "./video-task-store.ts";

export interface HumanSessionScope {
  tenantId: string;
  batchProjectId: string;
  actorAccountId: string;
}

export class VideoTaskNotFoundError extends Error {
  readonly code = "AIC-VIDEO-TASK-NOT-FOUND";

  constructor(readonly videoTaskId: string) {
    super(`Video task '${videoTaskId}' was not found.`);
    this.name = "VideoTaskNotFoundError";
  }
}

export class StageConfirmationRuntime {
  constructor(
    private readonly store: VideoTaskProductionStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: (kind: "artifact_version" | "confirmation") => string = (kind) =>
      `${kind === "artifact_version" ? "sav" : "sc"}_${randomUUID()}`,
  ) {}

  async confirmStage(
    videoTaskId: string,
    command: Readonly<ConfirmStageCommand>,
    session: Readonly<HumanSessionScope>,
  ): Promise<VideoTaskProductionRecord> {
    const current = await this.store.load(videoTaskId);
    if (!current) throw new VideoTaskNotFoundError(videoTaskId);
    const next = confirmVideoTaskStage(current, command, {
      ...session,
      occurredAt: this.now(),
      createId: this.createId,
    });
    await this.store.save(next);
    return structuredClone(next);
  }
}
