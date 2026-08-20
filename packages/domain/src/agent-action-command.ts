import type {
  AgentActionCommandAction,
  AgentActionCommandReceipt,
  BatchProject,
  ProjectAssetPool,
  StageConfirmationRequest,
  StrategyItem,
  VehicleSnapshot,
  VideoTaskStrategyDraft,
} from "@firefly/schemas";

import type { VideoTaskProductionRecord } from "./stage-confirmation.ts";
import { preserveLockedStrategyItems, validateStrategy } from "./strategy.ts";
import { assertRevision, nextVideoTaskWorkflowState } from "./workflow.ts";

export interface GenerateVideoTaskStrategyCommand {
  expectedTaskRevision: number;
  audience: string;
  theme: string;
}

export interface RequestVideoTaskStrategyApprovalCommand {
  expectedTaskRevision: number;
}

export type AgentActionCommandIdKind =
  | "strategy_draft"
  | "strategy_item"
  | "task_asset_snapshot"
  | "stage_confirmation_request"
  | "command_receipt";

export interface AgentActionCommandContext {
  tenantId: string;
  batchProjectId: string;
  actorAccountId: string;
  requestId: string;
  payloadHash: string;
  occurredAt: string;
  createId: (kind: AgentActionCommandIdKind) => string;
}

export type AgentActionCommandErrorCode =
  | "AIC-AGENT-COMMAND-SCOPE_INVALID"
  | "AIC-AGENT-COMMAND-STATE_CONFLICT"
  | "AIC-AGENT-COMMAND-SNAPSHOT_INVALID"
  | "AIC-AGENT-COMMAND-STRATEGY_FACTS_INVALID"
  | "AIC-AGENT-COMMAND-STRATEGY_DRAFT_NOT_FOUND"
  | "AIC-AGENT-COMMAND-STRATEGY_VALIDATION_FAILED"
  | "AIC-AGENT-COMMAND-IDEMPOTENCY_CONFLICT";

export class AgentActionCommandError extends Error {
  constructor(
    readonly code: AgentActionCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentActionCommandError";
  }
}

const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const sha256Pattern = /^[A-Fa-f0-9]{64}$/u;

function normalizeText(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length < 1 || normalized.length > 500) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-STRATEGY_FACTS_INVALID",
      `${label} must contain 1 to 500 normalized characters.`,
    );
  }
  return normalized;
}

function assertCommandContext(context: Readonly<AgentActionCommandContext>): void {
  if (
    !identifierPattern.test(context.actorAccountId) ||
    !identifierPattern.test(context.requestId) ||
    !sha256Pattern.test(context.payloadHash) ||
    !Number.isFinite(Date.parse(context.occurredAt))
  ) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-SCOPE_INVALID",
      "The server command identity, payload hash, or occurrence time is invalid.",
    );
  }
}

function replayOrThrow(
  record: Readonly<VideoTaskProductionRecord>,
  action: AgentActionCommandAction,
  context: Readonly<AgentActionCommandContext>,
): VideoTaskProductionRecord | undefined {
  const existing = record.commandReceipts.find(
    (receipt) =>
      receipt.actorAccountId === context.actorAccountId &&
      receipt.requestId === context.requestId,
  );
  if (!existing) return undefined;
  if (existing.action !== action || existing.payloadHash !== context.payloadHash) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-IDEMPOTENCY_CONFLICT",
      "The command request ID was already used with a different action or payload.",
    );
  }
  return structuredClone(record);
}

function assertMutableStrategyScope(
  record: Readonly<VideoTaskProductionRecord>,
  context: Readonly<AgentActionCommandContext>,
): void {
  const task = record.videoTask;
  if (
    task.tenantId !== context.tenantId ||
    task.batchProjectId !== context.batchProjectId ||
    task.ownerAccountId !== context.actorAccountId
  ) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-SCOPE_INVALID",
      "Only the current task owner in the authenticated project scope can execute this command.",
    );
  }
  if (
    task.status !== "active" ||
    task.currentStage !== "strategy" ||
    task.stageStatus !== "in_progress"
  ) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-STATE_CONFLICT",
      "The strategy command requires an active strategy stage in progress.",
    );
  }
}

function assertProjectInputs(
  record: Readonly<VideoTaskProductionRecord>,
  project: Readonly<BatchProject>,
  vehicleSnapshot: Readonly<VehicleSnapshot>,
  context: Readonly<AgentActionCommandContext>,
): void {
  if (
    project.id !== context.batchProjectId ||
    project.tenantId !== context.tenantId ||
    project.status !== "active" ||
    record.videoTask.batchProjectId !== project.id ||
    vehicleSnapshot.projectId !== project.id ||
    vehicleSnapshot.vehicleId !== project.vehicleId ||
    vehicleSnapshot.vehicleVersion !== project.vehicleVersion ||
    vehicleSnapshot.brandId !== project.brandId
  ) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-SNAPSHOT_INVALID",
      "The project and vehicle snapshot do not share the task scope.",
    );
  }
  // Asset candidates intentionally stay mutable until the later asset-matching stage.
  // Strategy generation therefore validates only project and locked vehicle facts.
}

function projectVehicleFacts(
  snapshot: Readonly<VehicleSnapshot>,
  createId: AgentActionCommandContext["createId"],
): StrategyItem[] {
  const claims = [...snapshot.fixedClaims, ...snapshot.optionalClaims];
  if (
    claims.length < 1 ||
    claims.length > 20 ||
    new Set(claims.map((claim) => claim.id)).size !== claims.length
  ) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-STRATEGY_FACTS_INVALID",
      "A strategy requires 1 to 20 uniquely identified facts from the locked vehicle snapshot.",
    );
  }
  return claims.map((claim, index) => ({
    id: createId("strategy_item"),
    claimId: claim.id,
    kind: claim.kind,
    title: claim.name,
    statement: claim.statement,
    rationale: claim.kind === "fixed"
      ? "车型事实快照中的固定卖点。"
      : "车型事实快照中的可选卖点。",
    order: index + 1,
    locked: false,
    ...(claim.evidence === undefined ? {} : { evidence: structuredClone(claim.evidence) }),
  }));
}

function receipt(
  record: Readonly<VideoTaskProductionRecord>,
  action: AgentActionCommandAction,
  expectedTaskRevision: number,
  result: AgentActionCommandReceipt["result"],
  context: Readonly<AgentActionCommandContext>,
): AgentActionCommandReceipt {
  return {
    schemaVersion: 1,
    id: context.createId("command_receipt"),
    tenantId: record.videoTask.tenantId,
    batchProjectId: record.videoTask.batchProjectId,
    videoTaskId: record.videoTask.id,
    actorAccountId: context.actorAccountId,
    requestId: context.requestId,
    payloadHash: context.payloadHash.toLowerCase(),
    action,
    expectedTaskRevision,
    resultingTaskRevision: record.videoTask.revision + 1,
    cost: { kind: "free", amountMinor: 0, charged: false },
    result,
    occurredAt: context.occurredAt,
  };
}

export function generateVideoTaskStrategy(
  record: Readonly<VideoTaskProductionRecord>,
  command: Readonly<GenerateVideoTaskStrategyCommand>,
  project: Readonly<BatchProject>,
  _pool: Readonly<ProjectAssetPool>,
  vehicleSnapshot: Readonly<VehicleSnapshot>,
  context: Readonly<AgentActionCommandContext>,
): VideoTaskProductionRecord {
  assertCommandContext(context);
  const replay = replayOrThrow(record, "generate_strategy", context);
  if (replay) return replay;
  assertRevision(command.expectedTaskRevision, record.videoTask.revision);
  assertMutableStrategyScope(record, context);
  assertProjectInputs(record, project, vehicleSnapshot, context);

  const lockedVehicleSnapshot = record.videoTask.vehicleSnapshotId === undefined
    ? structuredClone(vehicleSnapshot)
    : record.taskVehicleSnapshots.find((item) => item.id === record.videoTask.vehicleSnapshotId);
  if (!lockedVehicleSnapshot || lockedVehicleSnapshot.id !== vehicleSnapshot.id) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-SNAPSHOT_INVALID",
      "Strategy generation cannot replace the task's locked vehicle snapshot.",
    );
  }

  const generatedItems = projectVehicleFacts(lockedVehicleSnapshot, context.createId);
  const previousDraft = record.strategyDrafts.find(
    (item) => item.id === record.activeStrategyDraftId,
  );
  const claimIds = new Set(
    [...lockedVehicleSnapshot.fixedClaims, ...lockedVehicleSnapshot.optionalClaims]
      .map((claim) => claim.id),
  );
  if (previousDraft?.items.some((item) => item.locked && !claimIds.has(item.claimId))) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-STRATEGY_FACTS_INVALID",
      "A locked strategy item no longer belongs to the task's vehicle facts.",
    );
  }
  const items = previousDraft === undefined
    ? generatedItems
    : preserveLockedStrategyItems(generatedItems, previousDraft.items);
  const draftId = context.createId("strategy_draft");
  const validation = validateStrategy({ items }, lockedVehicleSnapshot);
  const draft: VideoTaskStrategyDraft = {
    schemaVersion: 1,
    id: draftId,
    tenantId: record.videoTask.tenantId,
    batchProjectId: record.videoTask.batchProjectId,
    videoTaskId: record.videoTask.id,
    vehicleSnapshotId: lockedVehicleSnapshot.id,
    version: Math.max(0, ...record.strategyDrafts.map((item) => item.version)) + 1,
    status: "draft",
    audience: normalizeText(command.audience, "Audience"),
    theme: normalizeText(command.theme, "Theme"),
    items,
    validation,
    generation: { kind: "vehicle_fact_projection", templateVersion: "v1" },
    createdAt: context.occurredAt,
    createdBy: context.actorAccountId,
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
  const commandReceipt = receipt(
    record,
    "generate_strategy",
    command.expectedTaskRevision,
    { kind: "strategy_generated", strategyDraftId: draftId },
    context,
  );
  const workflow = nextVideoTaskWorkflowState({
    taskStatus: record.videoTask.status,
    currentStage: record.videoTask.currentStage,
    stageStatus: record.videoTask.stageStatus,
  }, {
    type: "stage_revised",
    stage: "strategy",
  });

  return {
    ...structuredClone(record),
    schemaVersion: 7,
    videoTask: {
      ...structuredClone(record.videoTask),
      status: workflow.taskStatus,
      currentStage: workflow.currentStage,
      stageStatus: workflow.stageStatus,
      vehicleSnapshotId: lockedVehicleSnapshot.id,
      revision: record.videoTask.revision + 1,
      updatedAt: context.occurredAt,
      updatedBy: context.actorAccountId,
    },
    taskVehicleSnapshots: record.videoTask.vehicleSnapshotId === undefined
      ? [...structuredClone(record.taskVehicleSnapshots), structuredClone(lockedVehicleSnapshot)]
      : structuredClone(record.taskVehicleSnapshots),
    taskAssetSnapshots: structuredClone(record.taskAssetSnapshots),
    strategyDrafts: [...structuredClone(record.strategyDrafts), draft],
    activeStrategyDraftId: draft.id,
    commandReceipts: [...structuredClone(record.commandReceipts), commandReceipt],
  };
}

export function requestVideoTaskStrategyApproval(
  record: Readonly<VideoTaskProductionRecord>,
  command: Readonly<RequestVideoTaskStrategyApprovalCommand>,
  context: Readonly<AgentActionCommandContext>,
): VideoTaskProductionRecord {
  assertCommandContext(context);
  const replay = replayOrThrow(record, "request_strategy_approval", context);
  if (replay) return replay;
  assertRevision(command.expectedTaskRevision, record.videoTask.revision);
  assertMutableStrategyScope(record, context);

  const activeDraft = record.strategyDrafts.find(
    (draft) => draft.id === record.activeStrategyDraftId && draft.status === "draft",
  );
  if (!activeDraft) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-STRATEGY_DRAFT_NOT_FOUND",
      "The task has no active strategy draft that can request confirmation.",
    );
  }
  const vehicleSnapshot = record.taskVehicleSnapshots.find(
    (snapshot) => snapshot.id === activeDraft.vehicleSnapshotId,
  );
  if (!vehicleSnapshot || !validateStrategy(activeDraft, vehicleSnapshot).valid) {
    throw new AgentActionCommandError(
      "AIC-AGENT-COMMAND-STRATEGY_VALIDATION_FAILED",
      "The active strategy draft no longer passes validation against its locked vehicle facts.",
    );
  }

  const requestId = context.createId("stage_confirmation_request");
  const request: StageConfirmationRequest = {
    schemaVersion: 1,
    id: requestId,
    tenantId: record.videoTask.tenantId,
    batchProjectId: record.videoTask.batchProjectId,
    videoTaskId: record.videoTask.id,
    stage: "strategy",
    strategyDraftId: activeDraft.id,
    expectedTaskRevision: command.expectedTaskRevision,
    source: "human_action",
    actorAccountId: context.actorAccountId,
    occurredAt: context.occurredAt,
  };
  const commandReceipt = receipt(
    record,
    "request_strategy_approval",
    command.expectedTaskRevision,
    {
      kind: "strategy_confirmation_requested",
      strategyDraftId: activeDraft.id,
      stageConfirmationRequestId: requestId,
    },
    context,
  );
  const workflow = nextVideoTaskWorkflowState({
    taskStatus: record.videoTask.status,
    currentStage: record.videoTask.currentStage,
    stageStatus: record.videoTask.stageStatus,
  }, {
    type: "stage_confirmation_requested",
    stage: "strategy",
  });

  return {
    ...structuredClone(record),
    schemaVersion: 7,
    videoTask: {
      ...structuredClone(record.videoTask),
      status: workflow.taskStatus,
      currentStage: workflow.currentStage,
      stageStatus: workflow.stageStatus,
      revision: record.videoTask.revision + 1,
      updatedAt: context.occurredAt,
      updatedBy: context.actorAccountId,
    },
    strategyDrafts: record.strategyDrafts.map((draft) =>
      draft.id === activeDraft.id
        ? {
            ...structuredClone(draft),
            status: "awaiting_confirmation" as const,
            updatedAt: context.occurredAt,
            updatedBy: context.actorAccountId,
          }
        : structuredClone(draft),
    ),
    stageConfirmationRequests: [...structuredClone(record.stageConfirmationRequests), request],
    commandReceipts: [...structuredClone(record.commandReceipts), commandReceipt],
  };
}
