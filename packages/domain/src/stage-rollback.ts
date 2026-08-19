import type {
  RollbackStageRequest,
  StageArtifactDependency,
  StageArtifactInvalidation,
  StageArtifactVersion,
  StageRollbackRecord,
  VideoTaskStage,
} from "@firefly/schemas";

import type { VideoTaskProductionRecord } from "./stage-confirmation.ts";
import { assertRevision, videoTaskStageOrder } from "./workflow.ts";

export interface RollbackStageContext {
  tenantId: string;
  batchProjectId: string;
  actorAccountId: string;
  occurredAt: string;
  createId: (kind: "rollback" | "invalidation") => string;
}

export class StageRollbackDeniedError extends Error {
  readonly code = "AIC-STAGE-ROLLBACK-DENIED";

  constructor(message: string) {
    super(message);
    this.name = "StageRollbackDeniedError";
  }
}

interface PlannedInvalidation {
  artifact: StageArtifactVersion;
  dependency: Extract<StageArtifactDependency, { kind: "stage_artifact" }>;
}

function assertRollbackScope(
  record: Readonly<VideoTaskProductionRecord>,
  request: Readonly<RollbackStageRequest>,
  context: Readonly<RollbackStageContext>,
): void {
  const { videoTask } = record;
  if (videoTask.tenantId !== context.tenantId || videoTask.batchProjectId !== context.batchProjectId) {
    throw new StageRollbackDeniedError("The server session scope does not own this video task.");
  }
  if (videoTask.ownerAccountId !== context.actorAccountId) {
    throw new StageRollbackDeniedError("Only the current task owner can roll back a stage.");
  }
  if (videoTask.status === "cancelled" || videoTask.status === "archived") {
    throw new StageRollbackDeniedError("A cancelled or archived video task cannot be rolled back.");
  }
  if (request.reason.trim().length === 0 || request.reason.length > 2000) {
    throw new StageRollbackDeniedError("A rollback reason must contain 1 to 2000 characters.");
  }
}

function planDownstreamInvalidations(
  record: Readonly<VideoTaskProductionRecord>,
  stage: VideoTaskStage,
  fromArtifactVersionId: string,
): PlannedInvalidation[] {
  const stageIndex = videoTaskStageOrder.indexOf(stage);
  const alreadyInvalidated = new Set(
    record.stageArtifactInvalidations.map((item) => item.artifactVersionId),
  );
  const affectedIds = new Set([fromArtifactVersionId]);
  const planned: PlannedInvalidation[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const artifact of record.stageArtifactVersions) {
      if (
        affectedIds.has(artifact.id) ||
        alreadyInvalidated.has(artifact.id) ||
        videoTaskStageOrder.indexOf(artifact.stage) <= stageIndex
      ) {
        continue;
      }
      const dependency = artifact.dependencies.find(
        (item): item is Extract<StageArtifactDependency, { kind: "stage_artifact" }> =>
          item.kind === "stage_artifact" && affectedIds.has(item.artifactVersionId),
      );
      if (!dependency) continue;
      affectedIds.add(artifact.id);
      planned.push({ artifact, dependency });
      changed = true;
    }
  }

  if (planned.length > 500) {
    throw new StageRollbackDeniedError("A rollback cannot invalidate more than 500 artifacts.");
  }
  return planned;
}

function rollbackWorkflowState(stage: VideoTaskStage): {
  status: "active" | "completed";
  currentStage: VideoTaskStage;
  stageStatus: "in_progress" | "confirmed";
} {
  const nextStage = videoTaskStageOrder[videoTaskStageOrder.indexOf(stage) + 1];
  if (nextStage === undefined) {
    return { status: "completed", currentStage: "delivery", stageStatus: "confirmed" };
  }
  return { status: "active", currentStage: nextStage, stageStatus: "in_progress" };
}

export function rollbackVideoTaskStage(
  record: Readonly<VideoTaskProductionRecord>,
  request: Readonly<RollbackStageRequest>,
  context: Readonly<RollbackStageContext>,
): VideoTaskProductionRecord {
  assertRevision(request.expectedTaskRevision, record.videoTask.revision);
  assertRollbackScope(record, request, context);

  const activeArtifactVersionId = record.activeStageArtifactVersionIds[request.stage];
  const activeArtifact = record.stageArtifactVersions.find(
    (item) => item.id === activeArtifactVersionId && item.stage === request.stage,
  );
  if (!activeArtifact) {
    throw new StageRollbackDeniedError("The stage does not have a selected artifact version.");
  }
  if (
    record.stageArtifactInvalidations.some(
      (invalidation) => invalidation.artifactVersionId === activeArtifact.id,
    )
  ) {
    throw new StageRollbackDeniedError("The selected artifact version is already invalidated.");
  }
  const targetArtifact = record.stageArtifactVersions.find(
    (item) => item.id === request.targetArtifactVersionId && item.stage === request.stage,
  );
  if (!targetArtifact) {
    throw new StageRollbackDeniedError("The rollback target is not a version of the requested stage.");
  }
  if (targetArtifact.id === activeArtifact.id) {
    throw new StageRollbackDeniedError("The rollback target is already the selected version.");
  }
  if (
    record.stageArtifactInvalidations.some(
      (invalidation) => invalidation.artifactVersionId === targetArtifact.id,
    )
  ) {
    throw new StageRollbackDeniedError("An invalidated artifact version cannot be selected.");
  }

  const planned = planDownstreamInvalidations(record, request.stage, activeArtifact.id);
  const rollbackId = context.createId("rollback");
  const invalidationIdsByArtifact = new Map<string, string>();
  for (const item of planned) {
    invalidationIdsByArtifact.set(item.artifact.id, context.createId("invalidation"));
  }
  const invalidations: StageArtifactInvalidation[] = planned.map(({ artifact, dependency }) => {
    const id = invalidationIdsByArtifact.get(artifact.id);
    if (!id) throw new Error("Missing generated invalidation ID.");
    const upstreamInvalidationId = invalidationIdsByArtifact.get(dependency.artifactVersionId);
    return {
      id,
      tenantId: record.videoTask.tenantId,
      batchProjectId: record.videoTask.batchProjectId,
      videoTaskId: record.videoTask.id,
      stage: artifact.stage,
      artifactVersionId: artifact.id,
      reason: request.reason,
      invalidatedDependency: structuredClone(dependency),
      cause:
        dependency.artifactVersionId === activeArtifact.id
          ? { kind: "rollback", reasonCode: "upstream_rollback", rollbackId }
          : {
              kind: "upstream_invalidation",
              reasonCode: "upstream_invalidation",
              invalidationId: upstreamInvalidationId ?? "",
            },
      occurredAt: context.occurredAt,
    };
  });
  if (
    invalidations.some(
      (item) => item.cause.kind === "upstream_invalidation" && item.cause.invalidationId.length === 0,
    )
  ) {
    throw new Error("Invalid downstream invalidation plan.");
  }

  const rollback: StageRollbackRecord = {
    id: rollbackId,
    tenantId: record.videoTask.tenantId,
    batchProjectId: record.videoTask.batchProjectId,
    videoTaskId: record.videoTask.id,
    stage: request.stage,
    fromArtifactVersionId: activeArtifact.id,
    toArtifactVersionId: targetArtifact.id,
    expectedTaskRevision: request.expectedTaskRevision,
    reason: request.reason,
    requestedBy: context.actorAccountId,
    invalidationIds: invalidations.map((item) => item.id),
    occurredAt: context.occurredAt,
  };
  const activeStageArtifactVersionIds = structuredClone(record.activeStageArtifactVersionIds);
  activeStageArtifactVersionIds[request.stage] = targetArtifact.id;
  for (const invalidation of invalidations) {
    if (activeStageArtifactVersionIds[invalidation.stage] === invalidation.artifactVersionId) {
      delete activeStageArtifactVersionIds[invalidation.stage];
    }
  }
  const workflow = rollbackWorkflowState(request.stage);

  return {
    schemaVersion: 3,
    videoTask: {
      ...structuredClone(record.videoTask),
      ...workflow,
      revision: record.videoTask.revision + 1,
      updatedAt: context.occurredAt,
      updatedBy: context.actorAccountId,
    },
    stageArtifactVersions: structuredClone(record.stageArtifactVersions),
    stageConfirmations: structuredClone(record.stageConfirmations),
    activeStageArtifactVersionIds,
    stageRollbacks: [...structuredClone(record.stageRollbacks), rollback],
    stageArtifactInvalidations: [
      ...structuredClone(record.stageArtifactInvalidations),
      ...invalidations,
    ],
    ownershipTransfers: structuredClone(record.ownershipTransfers),
  };
}
