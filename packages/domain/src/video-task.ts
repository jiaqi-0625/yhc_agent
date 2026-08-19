import type {
  AssignVideoTaskOwnerRequest,
  BatchProject,
  CreateVideoTaskRequest,
  VideoTaskOwnershipTransfer,
} from "@firefly/schemas";

import type { VideoTaskProductionRecord } from "./stage-confirmation.ts";
import { assertRevision } from "./workflow.ts";

export type VideoTaskCreationInput = Pick<
  CreateVideoTaskRequest,
  "name" | "audience" | "theme" | "durationSeconds" | "platformTags" | "scriptInput"
>;

export interface VideoTaskCreationContext {
  tenantId: string;
  actorAccountId: string;
  ownerAccountId: string;
  occurredAt: string;
  taskId: string;
}

export interface AssignVideoTaskOwnerContext {
  tenantId: string;
  batchProjectId: string;
  actorAccountId: string;
  occurredAt: string;
  createId: () => string;
}

export type VideoTaskCreationErrorCode =
  | "AIC-VIDEO-TASK-CREATION-SCOPE_INVALID"
  | "AIC-VIDEO-TASK-CREATION-PROJECT_INACTIVE"
  | "AIC-VIDEO-TASK-CREATION-INPUT_INVALID";

export class VideoTaskCreationError extends Error {
  constructor(
    readonly code: VideoTaskCreationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VideoTaskCreationError";
  }
}

export class VideoTaskAssignmentDeniedError extends Error {
  readonly code = "AIC-VIDEO-TASK-ASSIGNMENT-DENIED";

  constructor(message: string) {
    super(message);
    this.name = "VideoTaskAssignmentDeniedError";
  }
}

const identifierPattern = /^[A-Za-z0-9_-]+$/u;

function isIdentifier(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && identifierPattern.test(value);
}

function normalizeCreationText(value: string, label: string, maximumLength: number): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new VideoTaskCreationError(
      "AIC-VIDEO-TASK-CREATION-INPUT_INVALID",
      `${label} must contain 1 to ${maximumLength} normalized characters.`,
    );
  }
  return normalized;
}

function normalizeScriptInput(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 20000) {
    throw new VideoTaskCreationError(
      "AIC-VIDEO-TASK-CREATION-INPUT_INVALID",
      "Script input must contain 1 to 20000 normalized characters.",
    );
  }
  return normalized;
}

function validatePlatformTags(tags: readonly string[]): string[] {
  if (
    tags.length > 20 ||
    tags.some((tag) => !isIdentifier(tag)) ||
    new Set(tags).size !== tags.length
  ) {
    throw new VideoTaskCreationError(
      "AIC-VIDEO-TASK-CREATION-INPUT_INVALID",
      "Platform tags must contain at most 20 unique identifiers.",
    );
  }
  return [...tags];
}

export function createVideoTask(
  project: Readonly<BatchProject>,
  input: Readonly<VideoTaskCreationInput>,
  context: Readonly<VideoTaskCreationContext>,
): VideoTaskProductionRecord {
  if (project.tenantId !== context.tenantId) {
    throw new VideoTaskCreationError(
      "AIC-VIDEO-TASK-CREATION-SCOPE_INVALID",
      "The batch project is outside the authenticated tenant scope.",
    );
  }
  if (
    !isIdentifier(context.taskId) ||
    !isIdentifier(context.actorAccountId) ||
    !isIdentifier(context.ownerAccountId)
  ) {
    throw new VideoTaskCreationError(
      "AIC-VIDEO-TASK-CREATION-SCOPE_INVALID",
      "Server-resolved task, actor, and owner identities must be valid identifiers.",
    );
  }
  if (project.status !== "active") {
    throw new VideoTaskCreationError(
      "AIC-VIDEO-TASK-CREATION-PROJECT_INACTIVE",
      "Video tasks can only be created in an active batch project.",
    );
  }
  if (
    !Number.isInteger(input.durationSeconds) ||
    input.durationSeconds < 1 ||
    input.durationSeconds > 600
  ) {
    throw new VideoTaskCreationError(
      "AIC-VIDEO-TASK-CREATION-INPUT_INVALID",
      "Duration must be an integer from 1 to 600 seconds.",
    );
  }

  const scriptInput = input.scriptInput === undefined
    ? undefined
    : normalizeScriptInput(input.scriptInput);
  const timestamp = context.occurredAt;

  return {
    schemaVersion: 6,
    videoTask: {
      id: context.taskId,
      tenantId: context.tenantId,
      batchProjectId: project.id,
      name: normalizeCreationText(input.name, "Task name", 160),
      ownerAccountId: context.ownerAccountId,
      status: "active",
      currentStage: "strategy",
      stageStatus: "in_progress",
      revision: 1,
      audience: normalizeCreationText(input.audience, "Audience", 500),
      theme: normalizeCreationText(input.theme, "Theme", 500),
      durationSeconds: input.durationSeconds,
      ...(scriptInput === undefined ? {} : { scriptInput }),
      platformTags: validatePlatformTags(input.platformTags),
      createdAt: timestamp,
      createdBy: context.actorAccountId,
      updatedAt: timestamp,
      updatedBy: context.actorAccountId,
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskVehicleSnapshots: [],
    taskAssetSnapshots: [],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
    stageMutationReceipts: [],
  };
}

function normalizeAssignmentReason(reason: string): string {
  const normalized = reason.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > 2000) {
    throw new VideoTaskAssignmentDeniedError(
      "An assignment reason must contain 1 to 2000 normalized characters.",
    );
  }
  return normalized;
}

export function assignVideoTaskOwner(
  record: Readonly<VideoTaskProductionRecord>,
  request: Readonly<AssignVideoTaskOwnerRequest>,
  context: Readonly<AssignVideoTaskOwnerContext>,
): VideoTaskProductionRecord {
  assertRevision(request.expectedTaskRevision, record.videoTask.revision);
  const { videoTask } = record;
  if (videoTask.tenantId !== context.tenantId || videoTask.batchProjectId !== context.batchProjectId) {
    throw new VideoTaskAssignmentDeniedError(
      "The server session scope does not own this video task.",
    );
  }
  if (videoTask.status !== "active") {
    throw new VideoTaskAssignmentDeniedError("Only an active video task can be assigned.");
  }
  if (!isIdentifier(request.targetOwnerAccountId)) {
    throw new VideoTaskAssignmentDeniedError("The target owner account identifier is invalid.");
  }
  if (videoTask.ownerAccountId === request.targetOwnerAccountId) {
    throw new VideoTaskAssignmentDeniedError("The target account already owns this video task.");
  }
  const reason = normalizeAssignmentReason(request.reason);
  const transfer: VideoTaskOwnershipTransfer = {
    id: context.createId(),
    tenantId: videoTask.tenantId,
    batchProjectId: videoTask.batchProjectId,
    videoTaskId: videoTask.id,
    fromOwnerAccountId: videoTask.ownerAccountId,
    toOwnerAccountId: request.targetOwnerAccountId,
    expectedTaskRevision: request.expectedTaskRevision,
    reason,
    source: "human_action",
    actorAccountId: context.actorAccountId,
    occurredAt: context.occurredAt,
  };

  return {
    schemaVersion: 6,
    videoTask: {
      ...structuredClone(videoTask),
      ownerAccountId: request.targetOwnerAccountId,
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
