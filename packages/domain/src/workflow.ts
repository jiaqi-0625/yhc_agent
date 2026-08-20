import type {
  VideoTaskStage,
  VideoTaskStageStatus,
  VideoTaskStatus,
  WorkStatus,
} from "@firefly/schemas";

export const videoTaskStageOrder = [
  "strategy",
  "script",
  "asset_matching",
  "storyboard",
  "video_preview",
  "delivery",
] as const satisfies readonly VideoTaskStage[];

export interface VideoTaskWorkflowState {
  taskStatus: VideoTaskStatus;
  currentStage: VideoTaskStage;
  stageStatus: VideoTaskStageStatus;
}

export type VideoTaskWorkflowEvent =
  | { type: "stage_revised"; stage: VideoTaskStage }
  | { type: "stage_confirmation_requested"; stage: VideoTaskStage }
  | { type: "stage_confirmation_rejected"; stage: VideoTaskStage; source: "human_action" }
  | { type: "stage_confirmed"; stage: VideoTaskStage; source: "human_action" };

export type VideoTaskWorkflowEventType = VideoTaskWorkflowEvent["type"];

export const initialVideoTaskWorkflowState: Readonly<VideoTaskWorkflowState> = {
  taskStatus: "active",
  currentStage: "strategy",
  stageStatus: "in_progress",
};

const videoTaskTransitions: Readonly<
  Record<VideoTaskStageStatus, readonly VideoTaskWorkflowEventType[]>
> = {
  in_progress: ["stage_revised", "stage_confirmation_requested"],
  awaiting_confirmation: ["stage_confirmation_rejected", "stage_confirmed"],
  confirmed: [],
};

export class InvalidVideoTaskTransitionError extends Error {
  readonly code = "AIC-VIDEO-TASK-WORKFLOW-INVALID_TRANSITION";

  constructor(
    readonly state: Readonly<VideoTaskWorkflowState>,
    readonly event: Readonly<VideoTaskWorkflowEvent>,
  ) {
    super(
      `Video task event '${event.type}' for stage '${event.stage}' is not allowed from ` +
        `'${state.taskStatus}/${state.currentStage}/${state.stageStatus}'.`,
    );
    this.name = "InvalidVideoTaskTransitionError";
  }
}

export function allowedVideoTaskEvents(
  state: Readonly<VideoTaskWorkflowState>,
): readonly VideoTaskWorkflowEventType[] {
  if (state.taskStatus !== "active") return [];
  return videoTaskTransitions[state.stageStatus];
}

export function nextVideoTaskWorkflowState(
  state: Readonly<VideoTaskWorkflowState>,
  event: Readonly<VideoTaskWorkflowEvent>,
): VideoTaskWorkflowState {
  const requiresHumanAction =
    event.type === "stage_confirmation_rejected" || event.type === "stage_confirmed";
  if (
    state.taskStatus !== "active" ||
    event.stage !== state.currentStage ||
    (requiresHumanAction && event.source !== "human_action") ||
    !videoTaskTransitions[state.stageStatus].includes(event.type)
  ) {
    throw new InvalidVideoTaskTransitionError(state, event);
  }

  if (event.type === "stage_revised") return { ...state };
  if (event.type === "stage_confirmation_requested") {
    return { ...state, stageStatus: "awaiting_confirmation" };
  }
  if (event.type === "stage_confirmation_rejected") {
    return { ...state, stageStatus: "in_progress" };
  }

  const currentIndex = videoTaskStageOrder.indexOf(state.currentStage);
  const nextStage = videoTaskStageOrder[currentIndex + 1];
  if (nextStage === undefined) {
    return { taskStatus: "completed", currentStage: "delivery", stageStatus: "confirmed" };
  }
  return { taskStatus: "active", currentStage: nextStage, stageStatus: "in_progress" };
}

/** @deprecated Workspace V1 compatibility state machine. Use nextVideoTaskWorkflowState for V2 writes. */
export type WorkflowEvent =
  | "strategy_generated"
  | "strategy_regenerated"
  | "strategy_approval_requested"
  | "strategy_approved"
  | "strategy_rejected"
  | "script_generated"
  | "script_approval_requested"
  | "script_approved"
  | "script_rejected"
  | "prompt_generated"
  | "prompt_approval_requested"
  | "prompt_approved"
  | "prompt_rejected"
  | "storyboard_generated"
  | "storyboard_approval_requested"
  | "storyboard_approved"
  | "storyboard_rejected"
  | "rendering_started"
  | "rendering_completed"
  | "review_approved"
  | "review_rejected"
  | "export_completed";

const transitions: Readonly<Record<WorkStatus, Readonly<Partial<Record<WorkflowEvent, WorkStatus>>>>> = {
  created: { strategy_generated: "strategy_draft" },
  strategy_draft: {
    strategy_regenerated: "strategy_draft",
    strategy_approval_requested: "awaiting_strategy_approval",
  },
  awaiting_strategy_approval: {
    strategy_approved: "strategy_approved",
    strategy_rejected: "strategy_draft",
  },
  strategy_approved: { script_generated: "script_draft" },
  script_draft: { script_approval_requested: "awaiting_script_approval" },
  awaiting_script_approval: {
    script_approved: "script_approved",
    script_rejected: "script_draft",
  },
  script_approved: { prompt_generated: "prompt_draft" },
  prompt_draft: { prompt_approval_requested: "awaiting_prompt_approval" },
  awaiting_prompt_approval: {
    prompt_approved: "prompt_approved",
    prompt_rejected: "prompt_draft",
  },
  prompt_approved: { storyboard_generated: "storyboard_draft" },
  storyboard_draft: { storyboard_approval_requested: "awaiting_storyboard_approval" },
  awaiting_storyboard_approval: {
    storyboard_approved: "storyboard_approved",
    storyboard_rejected: "storyboard_draft",
  },
  storyboard_approved: { rendering_started: "rendering" },
  rendering: { rendering_completed: "final_review" },
  final_review: {
    review_approved: "export_ready",
    review_rejected: "storyboard_draft",
  },
  export_ready: { export_completed: "exported" },
  exported: {},
};

export class InvalidTransitionError extends Error {
  readonly code = "AIC-WORKFLOW-INVALID_TRANSITION";

  constructor(
    readonly status: WorkStatus,
    readonly event: WorkflowEvent,
  ) {
    super(`Workflow event '${event}' is not allowed from status '${status}'.`);
    this.name = "InvalidTransitionError";
  }
}

export class RevisionConflictError extends Error {
  readonly code = "AIC-WORKFLOW-REVISION_CONFLICT";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`);
    this.name = "RevisionConflictError";
  }
}

/** @deprecated Workspace V1 compatibility state machine. Use nextVideoTaskWorkflowState for V2 writes. */
export function nextWorkStatus(status: WorkStatus, event: WorkflowEvent): WorkStatus {
  const next = transitions[status][event];
  if (!next) throw new InvalidTransitionError(status, event);
  return next;
}

export function assertRevision(expectedRevision: number, actualRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new RangeError("Expected revision must be a positive integer.");
  }
  if (expectedRevision !== actualRevision) {
    throw new RevisionConflictError(expectedRevision, actualRevision);
  }
}

export function allowedEvents(status: WorkStatus): readonly WorkflowEvent[] {
  return Object.keys(transitions[status]) as WorkflowEvent[];
}
