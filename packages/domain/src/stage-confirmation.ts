import type {
  StageArtifactContentReference,
  StageArtifactDependency,
  StageArtifactInvalidation,
  StageArtifactVersion,
  StageConfirmation,
  StageRollbackRecord,
  VideoTask,
  VideoTaskOwnershipTransfer,
  VideoTaskStage,
} from "@firefly/schemas";

import { assertRevision, nextVideoTaskWorkflowState } from "./workflow.ts";

export interface VideoTaskProductionRecord {
  schemaVersion: 3;
  videoTask: VideoTask;
  stageArtifactVersions: StageArtifactVersion[];
  stageConfirmations: StageConfirmation[];
  activeStageArtifactVersionIds: Partial<Record<VideoTaskStage, string>>;
  stageRollbacks: StageRollbackRecord[];
  stageArtifactInvalidations: StageArtifactInvalidation[];
  ownershipTransfers: VideoTaskOwnershipTransfer[];
}

export interface ConfirmStageCommand {
  expectedTaskRevision: number;
  stage: VideoTaskStage;
  artifact: StageArtifactContentReference;
  dependencies: StageArtifactDependency[];
  comment?: string;
}

export interface ConfirmStageContext {
  tenantId: string;
  batchProjectId: string;
  actorAccountId: string;
  occurredAt: string;
  createId: (kind: "artifact_version" | "confirmation") => string;
}

export class StageConfirmationDeniedError extends Error {
  readonly code = "AIC-STAGE-CONFIRMATION-DENIED";

  constructor(message: string) {
    super(message);
    this.name = "StageConfirmationDeniedError";
  }
}

function assertConfirmationScope(
  record: Readonly<VideoTaskProductionRecord>,
  command: Readonly<ConfirmStageCommand>,
  context: Readonly<ConfirmStageContext>,
): void {
  const { videoTask } = record;
  if (videoTask.tenantId !== context.tenantId || videoTask.batchProjectId !== context.batchProjectId) {
    throw new StageConfirmationDeniedError("The server session scope does not own this video task.");
  }
  if (videoTask.ownerAccountId !== context.actorAccountId) {
    throw new StageConfirmationDeniedError("Only the current task owner can confirm a stage.");
  }
  if (videoTask.status !== "active") {
    throw new StageConfirmationDeniedError("Only an active video task can be confirmed.");
  }
  if (videoTask.currentStage !== command.stage || videoTask.stageStatus !== "awaiting_confirmation") {
    throw new StageConfirmationDeniedError("Only the current stage awaiting confirmation can be confirmed.");
  }
  if (command.dependencies.length === 0) {
    throw new StageConfirmationDeniedError("A confirmed artifact must record at least one dependency.");
  }
  for (const dependency of command.dependencies) {
    if (dependency.kind !== "stage_artifact") continue;
    const dependencyVersion = record.stageArtifactVersions.find(
      (item) => item.id === dependency.artifactVersionId && item.stage === dependency.stage,
    );
    if (!dependencyVersion) {
      throw new StageConfirmationDeniedError("A stage dependency does not belong to this video task.");
    }
    if (
      record.stageArtifactInvalidations.some(
        (invalidation) => invalidation.artifactVersionId === dependency.artifactVersionId,
      )
    ) {
      throw new StageConfirmationDeniedError("An invalidated stage artifact cannot be used as a dependency.");
    }
    if (record.activeStageArtifactVersionIds[dependency.stage] !== dependency.artifactVersionId) {
      throw new StageConfirmationDeniedError("A stage dependency is not the currently selected version.");
    }
  }
}

export function confirmVideoTaskStage(
  record: Readonly<VideoTaskProductionRecord>,
  command: Readonly<ConfirmStageCommand>,
  context: Readonly<ConfirmStageContext>,
): VideoTaskProductionRecord {
  assertRevision(command.expectedTaskRevision, record.videoTask.revision);
  assertConfirmationScope(record, command, context);

  const confirmationId = context.createId("confirmation");
  const artifactVersionId = context.createId("artifact_version");
  const version =
    record.stageArtifactVersions.reduce(
      (highest, item) => (item.stage === command.stage ? Math.max(highest, item.version) : highest),
      0,
    ) + 1;
  const commonScope = {
    tenantId: record.videoTask.tenantId,
    batchProjectId: record.videoTask.batchProjectId,
    videoTaskId: record.videoTask.id,
    stage: command.stage,
  };
  const confirmation: StageConfirmation = {
    id: confirmationId,
    ...commonScope,
    artifactVersionId,
    decision: "confirmed",
    source: "human_action",
    expectedTaskRevision: command.expectedTaskRevision,
    actorAccountId: context.actorAccountId,
    ...(command.comment === undefined ? {} : { comment: command.comment }),
    occurredAt: context.occurredAt,
  };
  const artifactVersion: StageArtifactVersion = {
    id: artifactVersionId,
    ...commonScope,
    version,
    content: structuredClone(command.artifact),
    dependencies: structuredClone(command.dependencies),
    provenance: { kind: "human_confirmation", confirmationId },
    createdAt: context.occurredAt,
    createdBy: context.actorAccountId,
  };
  const workflow = nextVideoTaskWorkflowState(
    {
      taskStatus: record.videoTask.status,
      currentStage: record.videoTask.currentStage,
      stageStatus: record.videoTask.stageStatus,
    },
    { type: "stage_confirmed", stage: command.stage, source: "human_action" },
  );

  return {
    schemaVersion: 3,
    videoTask: {
      ...structuredClone(record.videoTask),
      status: workflow.taskStatus,
      currentStage: workflow.currentStage,
      stageStatus: workflow.stageStatus,
      revision: record.videoTask.revision + 1,
      updatedAt: context.occurredAt,
      updatedBy: context.actorAccountId,
    },
    stageArtifactVersions: [...structuredClone(record.stageArtifactVersions), artifactVersion],
    stageConfirmations: [...structuredClone(record.stageConfirmations), confirmation],
    activeStageArtifactVersionIds: {
      ...structuredClone(record.activeStageArtifactVersionIds),
      [command.stage]: artifactVersionId,
    },
    stageRollbacks: structuredClone(record.stageRollbacks),
    stageArtifactInvalidations: structuredClone(record.stageArtifactInvalidations),
    ownershipTransfers: structuredClone(record.ownershipTransfers),
  };
}
