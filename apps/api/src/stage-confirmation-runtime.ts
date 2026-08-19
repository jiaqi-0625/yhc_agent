import { randomUUID } from "node:crypto";

import {
  assertCanOperateVideoTask,
  assertCanTakeOverVideoTask,
  confirmVideoTaskStage,
  rollbackVideoTaskStage,
  takeOverVideoTask,
  type ConfirmStageCommand,
  type VideoTaskProductionRecord,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  BatchProject,
  RollbackStageRequest,
  TakeOverVideoTaskRequest,
} from "@firefly/schemas";

import type { VideoTaskProductionStore } from "./video-task-store.ts";

const idPrefixes = {
  artifact_version: "sav",
  confirmation: "sc",
  rollback: "sr",
  invalidation: "sai",
  ownership_transfer: "vot",
} as const;

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
      kind:
        | "artifact_version"
        | "confirmation"
        | "rollback"
        | "invalidation"
        | "ownership_transfer",
    ) => string = (kind) => `${idPrefixes[kind]}_${randomUUID()}`,
  ) {}

  async confirmStage(
    videoTaskId: string,
    command: Readonly<ConfirmStageCommand>,
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VideoTaskProductionRecord> {
    return this.store.transact(videoTaskId, (current) => {
      if (!current) throw new VideoTaskNotFoundError(videoTaskId);
      assertCanOperateVideoTask(session, project, current.videoTask);
      return confirmVideoTaskStage(current, command, {
        tenantId: session.tenantId,
        batchProjectId: project.id,
        actorAccountId: session.actorAccountId,
        occurredAt: this.now(),
        createId: this.createId,
      });
    });
  }

  async rollbackStage(
    videoTaskId: string,
    request: Readonly<RollbackStageRequest>,
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VideoTaskProductionRecord> {
    return this.store.transact(videoTaskId, (current) => {
      if (!current) throw new VideoTaskNotFoundError(videoTaskId);
      assertCanOperateVideoTask(session, project, current.videoTask);
      return rollbackVideoTaskStage(current, request, {
        tenantId: session.tenantId,
        batchProjectId: project.id,
        actorAccountId: session.actorAccountId,
        occurredAt: this.now(),
        createId: this.createId,
      });
    });
  }

  async takeOverTask(
    videoTaskId: string,
    request: Readonly<TakeOverVideoTaskRequest>,
    project: Readonly<BatchProject>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VideoTaskProductionRecord> {
    return this.store.transact(videoTaskId, (current) => {
      if (!current) throw new VideoTaskNotFoundError(videoTaskId);
      assertCanTakeOverVideoTask(session, project, current.videoTask);
      return takeOverVideoTask(current, request, {
        tenantId: session.tenantId,
        batchProjectId: project.id,
        actorAccountId: session.actorAccountId,
        occurredAt: this.now(),
        createId: () => this.createId("ownership_transfer"),
      });
    });
  }
}
