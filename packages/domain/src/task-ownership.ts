import type {
  TakeOverVideoTaskRequest,
  VideoTaskOwnershipTransfer,
} from "@firefly/schemas";

import type { VideoTaskProductionRecord } from "./stage-confirmation.ts";
import { assertRevision } from "./workflow.ts";

export interface TakeOverVideoTaskContext {
  tenantId: string;
  batchProjectId: string;
  actorAccountId: string;
  occurredAt: string;
  createId: () => string;
}

export class TaskTakeoverDeniedError extends Error {
  readonly code = "AIC-TASK-TAKEOVER-DENIED";

  constructor(message: string) {
    super(message);
    this.name = "TaskTakeoverDeniedError";
  }
}

export function takeOverVideoTask(
  record: Readonly<VideoTaskProductionRecord>,
  request: Readonly<TakeOverVideoTaskRequest>,
  context: Readonly<TakeOverVideoTaskContext>,
): VideoTaskProductionRecord {
  assertRevision(request.expectedTaskRevision, record.videoTask.revision);
  const { videoTask } = record;
  if (videoTask.tenantId !== context.tenantId || videoTask.batchProjectId !== context.batchProjectId) {
    throw new TaskTakeoverDeniedError("The server session scope does not own this video task.");
  }
  if (videoTask.status !== "active") {
    throw new TaskTakeoverDeniedError("Only an active video task can be taken over.");
  }
  if (videoTask.ownerAccountId === context.actorAccountId) {
    throw new TaskTakeoverDeniedError("The account already owns this video task.");
  }
  if (request.reason.trim().length === 0 || request.reason.length > 2000) {
    throw new TaskTakeoverDeniedError("A takeover reason must contain 1 to 2000 characters.");
  }

  const transfer: VideoTaskOwnershipTransfer = {
    id: context.createId(),
    tenantId: videoTask.tenantId,
    batchProjectId: videoTask.batchProjectId,
    videoTaskId: videoTask.id,
    fromOwnerAccountId: videoTask.ownerAccountId,
    toOwnerAccountId: context.actorAccountId,
    expectedTaskRevision: request.expectedTaskRevision,
    reason: request.reason,
    source: "human_action",
    actorAccountId: context.actorAccountId,
    occurredAt: context.occurredAt,
  };

  return {
    schemaVersion: 6,
    videoTask: {
      ...structuredClone(videoTask),
      ownerAccountId: context.actorAccountId,
      revision: videoTask.revision + 1,
      updatedAt: context.occurredAt,
      updatedBy: context.actorAccountId,
    },
    stageArtifactVersions: structuredClone(record.stageArtifactVersions),
    stageConfirmations: structuredClone(record.stageConfirmations),
    activeStageArtifactVersionIds: structuredClone(record.activeStageArtifactVersionIds),
    stageRollbacks: structuredClone(record.stageRollbacks),
    stageArtifactInvalidations: structuredClone(record.stageArtifactInvalidations),
    ownershipTransfers: [...structuredClone(record.ownershipTransfers), transfer],
    taskVehicleSnapshots: structuredClone(record.taskVehicleSnapshots),
    taskAssetSnapshots: structuredClone(record.taskAssetSnapshots),
    strategyDrafts: structuredClone(record.strategyDrafts),
    ...(record.activeStrategyDraftId === undefined
      ? {}
      : { activeStrategyDraftId: record.activeStrategyDraftId }),
    stageConfirmationRequests: structuredClone(record.stageConfirmationRequests),
    commandReceipts: structuredClone(record.commandReceipts),
    stageMutationReceipts: structuredClone(record.stageMutationReceipts),
  };
}
