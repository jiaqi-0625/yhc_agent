import { randomUUID } from "node:crypto";

import {
  confirmVideoTaskStage,
  rollbackVideoTaskStage,
  type ConfirmStageCommand,
  type VideoTaskProductionRecord,
} from "@firefly/domain";
import type { RollbackStageRequest } from "@firefly/schemas";

import type { VideoTaskProductionStore } from "./video-task-store.ts";

const idPrefixes = {
  artifact_version: "sav",
  confirmation: "sc",
  rollback: "sr",
  invalidation: "sai",
} as const;

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
    private readonly createId: (
      kind: "artifact_version" | "confirmation" | "rollback" | "invalidation",
    ) => string = (kind) => `${idPrefixes[kind]}_${randomUUID()}`,
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

  async rollbackStage(
    videoTaskId: string,
    request: Readonly<RollbackStageRequest>,
    session: Readonly<HumanSessionScope>,
  ): Promise<VideoTaskProductionRecord> {
    const current = await this.store.load(videoTaskId);
    if (!current) throw new VideoTaskNotFoundError(videoTaskId);
    const next = rollbackVideoTaskStage(current, request, {
      ...session,
      occurredAt: this.now(),
      createId: this.createId,
    });
    await this.store.save(next);
    return structuredClone(next);
  }
}
