import type {
  AgentActionCommandReceipt,
  StageConfirmationRequest,
  StageArtifactContentReference,
  StageArtifactDependency,
  StageArtifactInvalidation,
  StageArtifactVersion,
  StageConfirmation,
  StageMutationReceipt,
  StageRollbackRecord,
  TaskAssetSnapshot,
  VehicleSnapshot,
  VideoTask,
  VideoTaskOwnershipTransfer,
  VideoTaskStage,
  VideoTaskStrategyDraft,
} from "@firefly/schemas";

import { assertRevision, nextVideoTaskWorkflowState, videoTaskStageOrder } from "./workflow.ts";

export interface VideoTaskProductionRecord {
  schemaVersion: 6;
  videoTask: VideoTask;
  stageArtifactVersions: StageArtifactVersion[];
  stageConfirmations: StageConfirmation[];
  activeStageArtifactVersionIds: Partial<Record<VideoTaskStage, string>>;
  stageRollbacks: StageRollbackRecord[];
  stageArtifactInvalidations: StageArtifactInvalidation[];
  ownershipTransfers: VideoTaskOwnershipTransfer[];
  taskVehicleSnapshots: VehicleSnapshot[];
  taskAssetSnapshots: TaskAssetSnapshot[];
  strategyDrafts: VideoTaskStrategyDraft[];
  activeStrategyDraftId?: string;
  stageConfirmationRequests: StageConfirmationRequest[];
  commandReceipts: AgentActionCommandReceipt[];
  stageMutationReceipts: StageMutationReceipt[];
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

function sameDependency(
  left: Readonly<StageArtifactDependency>,
  right: Readonly<StageArtifactDependency>,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "vehicle_snapshot":
      return right.kind === "vehicle_snapshot" && left.vehicleSnapshotId === right.vehicleSnapshotId;
    case "asset_snapshot":
      return right.kind === "asset_snapshot" && left.assetSnapshotId === right.assetSnapshotId;
    case "stage_artifact":
      return right.kind === "stage_artifact" &&
        left.stage === right.stage &&
        left.artifactVersionId === right.artifactVersionId;
  }
}

/**
 * Derives the only dependency set accepted for a human stage confirmation.
 * Snapshot pointers and the direct upstream version are server-owned facts;
 * callers may not omit, replace, or add dependencies.
 */
export function deriveStageConfirmationDependencies(
  record: Readonly<VideoTaskProductionRecord>,
  stage: VideoTaskStage,
): StageArtifactDependency[] {
  const { videoTask } = record;
  const vehicleSnapshotId = videoTask.vehicleSnapshotId;
  const assetSnapshotId = videoTask.assetSnapshotId;
  const vehicleSnapshot = record.taskVehicleSnapshots.find(
    (snapshot) =>
      snapshot.id === vehicleSnapshotId && snapshot.projectId === videoTask.batchProjectId,
  );
  const assetSnapshot = record.taskAssetSnapshots.find(
    (snapshot) =>
      snapshot.id === assetSnapshotId &&
      snapshot.tenantId === videoTask.tenantId &&
      snapshot.batchProjectId === videoTask.batchProjectId &&
      snapshot.videoTaskId === videoTask.id &&
      snapshot.vehicleSnapshotId === vehicleSnapshotId,
  );
  const requiresAssetSnapshot = videoTaskStageOrder.indexOf(stage) >=
    videoTaskStageOrder.indexOf("asset_matching");
  if (vehicleSnapshotId === undefined || vehicleSnapshot === undefined) {
    throw new StageConfirmationDeniedError(
      "A stage confirmation requires the task's exact locked vehicle snapshot.",
    );
  }
  if (requiresAssetSnapshot && (assetSnapshotId === undefined || assetSnapshot === undefined)) {
    throw new StageConfirmationDeniedError(
      "Asset matching and downstream confirmation require the task's exact locked asset snapshot.",
    );
  }

  const dependencies: StageArtifactDependency[] = [
    { kind: "vehicle_snapshot", vehicleSnapshotId },
    ...(requiresAssetSnapshot && assetSnapshotId !== undefined
      ? [{ kind: "asset_snapshot" as const, assetSnapshotId }]
      : []),
  ];
  if (stage === "strategy") return dependencies;

  const stageIndex = videoTaskStageOrder.indexOf(stage);
  const upstreamStage = videoTaskStageOrder[stageIndex - 1];
  if (upstreamStage === undefined) {
    throw new StageConfirmationDeniedError("The requested confirmation stage is invalid.");
  }
  const upstreamArtifactVersionId = record.activeStageArtifactVersionIds[upstreamStage];
  const upstreamArtifact = record.stageArtifactVersions.find(
    (artifact) =>
      artifact.id === upstreamArtifactVersionId &&
      artifact.stage === upstreamStage &&
      artifact.tenantId === videoTask.tenantId &&
      artifact.batchProjectId === videoTask.batchProjectId &&
      artifact.videoTaskId === videoTask.id,
  );
  const upstreamInvalidated = upstreamArtifact !== undefined &&
    record.stageArtifactInvalidations.some(
      (invalidation) => invalidation.artifactVersionId === upstreamArtifact.id,
    );
  if (upstreamArtifact === undefined || upstreamInvalidated) {
    throw new StageConfirmationDeniedError(
      "A stage confirmation requires the current valid direct upstream version.",
    );
  }
  dependencies.push({
    kind: "stage_artifact",
    stage: upstreamStage,
    artifactVersionId: upstreamArtifact.id,
  });
  return dependencies;
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
  const expectedDependencies = deriveStageConfirmationDependencies(record, command.stage);
  if (
    command.dependencies.length !== expectedDependencies.length ||
    command.dependencies.some(
      (dependency, index) => !sameDependency(dependency, expectedDependencies[index]!),
    )
  ) {
    throw new StageConfirmationDeniedError(
      "Stage confirmation dependencies must exactly match the server-derived snapshot and upstream versions.",
    );
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
    schemaVersion: 6,
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
