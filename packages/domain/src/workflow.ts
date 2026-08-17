import type { WorkStatus } from "@firefly/schemas";

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
