import type {
  ReopenAssetMatchingRequest,
  StageArtifactDependency,
  StageArtifactInvalidation,
  StageArtifactVersion,
} from "@firefly/schemas";

import type { VideoTaskProductionRecord } from "./stage-confirmation.ts";
import { assertRevision } from "./workflow.ts";

export interface ReopenAssetMatchingContext {
  tenantId: string;
  batchProjectId: string;
  actorAccountId: string;
  occurredAt: string;
  createInvalidationId: () => string;
}

export class AssetMatchingRevisionDeniedError extends Error {
  readonly code = "AIC-ASSET-MATCHING-REVISION-DENIED";

  constructor(message: string) {
    super(message);
    this.name = "AssetMatchingRevisionDeniedError";
  }
}

interface PlannedInvalidation {
  artifact: StageArtifactVersion;
  dependency: Extract<StageArtifactDependency, { kind: "stage_artifact" }>;
}

export function reopenAssetMatching(
  record: Readonly<VideoTaskProductionRecord>,
  request: Readonly<ReopenAssetMatchingRequest>,
  context: Readonly<ReopenAssetMatchingContext>,
): VideoTaskProductionRecord {
  assertRevision(request.expectedTaskRevision, record.videoTask.revision);
  const task = record.videoTask;
  if (task.tenantId !== context.tenantId || task.batchProjectId !== context.batchProjectId) {
    throw new AssetMatchingRevisionDeniedError("The server session scope does not own this video task.");
  }
  if (task.ownerAccountId !== context.actorAccountId) {
    throw new AssetMatchingRevisionDeniedError("Only the current task owner can revise asset matching.");
  }
  if (
    task.status !== "active" ||
    task.currentStage !== "storyboard" ||
    !["in_progress", "awaiting_confirmation"].includes(task.stageStatus)
  ) {
    throw new AssetMatchingRevisionDeniedError(
      "Asset matching can only be revised before storyboard confirmation and video generation.",
    );
  }
  if (request.reason.trim().length === 0 || request.reason.length > 2000) {
    throw new AssetMatchingRevisionDeniedError("A revision reason must contain 1 to 2000 characters.");
  }

  const assetArtifactId = record.activeStageArtifactVersionIds.asset_matching;
  const assetArtifact = record.stageArtifactVersions.find(
    (artifact) => artifact.id === assetArtifactId && artifact.stage === "asset_matching",
  );
  if (!assetArtifact || !task.assetSnapshotId) {
    throw new AssetMatchingRevisionDeniedError("The task does not have an active asset selection.");
  }
  if (record.stageArtifactInvalidations.some(({ artifactVersionId }) => artifactVersionId === assetArtifact.id)) {
    throw new AssetMatchingRevisionDeniedError("The active asset selection is already invalidated.");
  }
  const rootDependency = assetArtifact.dependencies.find(
    (dependency): dependency is Extract<StageArtifactDependency, { kind: "stage_artifact" }> =>
      dependency.kind === "stage_artifact" && dependency.stage === "script",
  );
  if (!rootDependency) {
    throw new AssetMatchingRevisionDeniedError("The active asset selection has no confirmed script dependency.");
  }

  const alreadyInvalidated = new Set(
    record.stageArtifactInvalidations.map(({ artifactVersionId }) => artifactVersionId),
  );
  const affectedIds = new Set([assetArtifact.id]);
  const planned: PlannedInvalidation[] = [{ artifact: assetArtifact, dependency: rootDependency }];
  let changed = true;
  while (changed) {
    changed = false;
    for (const artifact of record.stageArtifactVersions) {
      if (affectedIds.has(artifact.id) || alreadyInvalidated.has(artifact.id)) continue;
      const dependency = artifact.dependencies.find(
        (candidate): candidate is Extract<StageArtifactDependency, { kind: "stage_artifact" }> =>
          candidate.kind === "stage_artifact" && affectedIds.has(candidate.artifactVersionId),
      );
      if (!dependency) continue;
      affectedIds.add(artifact.id);
      planned.push({ artifact, dependency });
      changed = true;
    }
  }
  if (planned.length > 500) {
    throw new AssetMatchingRevisionDeniedError("An asset revision cannot invalidate more than 500 artifacts.");
  }

  const ids = new Map(planned.map(({ artifact }) => [artifact.id, context.createInvalidationId()]));
  const invalidations: StageArtifactInvalidation[] = planned.map(({ artifact, dependency }, index) => ({
    id: ids.get(artifact.id)!,
    tenantId: task.tenantId,
    batchProjectId: task.batchProjectId,
    videoTaskId: task.id,
    stage: artifact.stage,
    artifactVersionId: artifact.id,
    reason: request.reason.trim(),
    invalidatedDependency: structuredClone(dependency),
    cause: index === 0
      ? {
          kind: "manual_revision",
          reasonCode: "asset_selection_revision",
          requestId: request.requestId,
          requestedBy: context.actorAccountId,
          expectedTaskRevision: request.expectedTaskRevision,
        }
      : {
          kind: "upstream_invalidation",
          reasonCode: "upstream_invalidation",
          invalidationId: ids.get(dependency.artifactVersionId)!,
        },
    occurredAt: context.occurredAt,
  }));
  const activeStageArtifactVersionIds = structuredClone(record.activeStageArtifactVersionIds);
  for (const invalidation of invalidations) {
    if (activeStageArtifactVersionIds[invalidation.stage] === invalidation.artifactVersionId) {
      delete activeStageArtifactVersionIds[invalidation.stage];
    }
  }
  const videoTask = structuredClone(task);
  delete videoTask.assetSnapshotId;

  return {
    schemaVersion: 7,
    videoTask: {
      ...videoTask,
      status: "active",
      currentStage: "asset_matching",
      stageStatus: "in_progress",
      revision: task.revision + 1,
      updatedAt: context.occurredAt,
      updatedBy: context.actorAccountId,
    },
    stageArtifactVersions: structuredClone(record.stageArtifactVersions),
    stageConfirmations: structuredClone(record.stageConfirmations),
    activeStageArtifactVersionIds,
    stageRollbacks: structuredClone(record.stageRollbacks),
    stageArtifactInvalidations: [...structuredClone(record.stageArtifactInvalidations), ...invalidations],
    ownershipTransfers: structuredClone(record.ownershipTransfers),
    taskVehicleSnapshots: structuredClone(record.taskVehicleSnapshots),
    taskAssetSnapshots: structuredClone(record.taskAssetSnapshots),
    strategyDrafts: structuredClone(record.strategyDrafts),
    ...(record.activeStrategyDraftId === undefined ? {} : { activeStrategyDraftId: record.activeStrategyDraftId }),
    stageConfirmationRequests: structuredClone(record.stageConfirmationRequests),
    commandReceipts: structuredClone(record.commandReceipts),
    stageMutationReceipts: structuredClone(record.stageMutationReceipts),
  };
}
