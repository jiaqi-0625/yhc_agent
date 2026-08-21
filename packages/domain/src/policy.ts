import type { Role, WorkStatus } from "@firefly/schemas";

export type ToolRisk = "read" | "proposal" | "draft" | "expensive" | "approval_request" | "export";

/** @deprecated Workspace V1 Agent tool scope. Use WorkspaceSessionScope for V2 resource authorization. */
export interface SessionScope {
  actorId: string;
  tenantId: string;
  projectId: string;
  role: Role;
  allowedBrandIds: readonly string[];
  budgetRemaining: number;
  hasInteractiveApprovalChannel: boolean;
}

export interface ToolPolicy {
  risk: ToolRisk;
  allowedStatuses: readonly WorkStatus[];
  allowedRoles: readonly Role[];
  estimatedMaximumCost?: number;
}

export interface PolicyInput {
  toolName: string;
  status: WorkStatus;
  scope: SessionScope;
}

export type PolicyDecision =
  | { allowed: true; risk: ToolRisk }
  | { allowed: false; code: string; reason: string; severity: "normal" | "critical" };

const creatorsAndAdmins: readonly Role[] = ["creator", "content_admin"];

export const toolPolicies: Readonly<Record<string, ToolPolicy>> = {
  get_vehicle_snapshot: {
    risk: "read",
    allowedStatuses: ["created", "strategy_draft"],
    allowedRoles: creatorsAndAdmins,
  },
  validate_vehicle_claims: {
    risk: "read",
    allowedStatuses: [
      "created",
      "strategy_draft",
      "awaiting_strategy_approval",
      "strategy_approved",
      "script_draft",
      "awaiting_script_approval",
      "script_approved",
      "prompt_draft",
      "awaiting_prompt_approval",
      "prompt_approved",
      "storyboard_draft",
      "awaiting_storyboard_approval",
      "storyboard_approved",
      "rendering",
      "final_review",
      "export_ready",
    ],
    allowedRoles: ["creator", "reviewer", "content_admin"],
  },
  get_task_asset_snapshot: {
    risk: "read",
    allowedStatuses: [
      "created",
      "strategy_draft",
      "awaiting_strategy_approval",
      "strategy_approved",
      "script_draft",
      "awaiting_script_approval",
      "script_approved",
      "prompt_draft",
      "awaiting_prompt_approval",
      "prompt_approved",
      "storyboard_draft",
      "awaiting_storyboard_approval",
      "storyboard_approved",
      "rendering",
      "final_review",
      "export_ready",
    ],
    allowedRoles: ["creator", "reviewer", "content_admin"],
  },
  get_current_stage_suggestion_context: {
    risk: "read",
    allowedStatuses: [
      "strategy_approved",
      "script_draft",
      "awaiting_script_approval",
      "prompt_approved",
      "storyboard_draft",
      "awaiting_storyboard_approval",
      "export_ready",
    ],
    allowedRoles: ["creator", "reviewer", "content_admin"],
  },
  get_current_strategy_draft: {
    risk: "read",
    allowedStatuses: ["strategy_draft", "awaiting_strategy_approval", "strategy_approved", "script_draft"],
    allowedRoles: ["creator", "reviewer", "content_admin"],
  },
  validate_strategy: {
    risk: "read",
    allowedStatuses: ["strategy_draft", "awaiting_strategy_approval", "strategy_approved"],
    allowedRoles: ["creator", "reviewer", "content_admin"],
  },
  propose_strategy_generation: {
    risk: "proposal",
    allowedStatuses: ["created", "strategy_draft"],
    allowedRoles: creatorsAndAdmins,
  },
  propose_strategy_approval: {
    risk: "proposal",
    allowedStatuses: ["strategy_draft"],
    allowedRoles: creatorsAndAdmins,
  },
  propose_script_generation: {
    risk: "proposal",
    allowedStatuses: ["script_draft"],
    allowedRoles: creatorsAndAdmins,
  },
  generate_script: {
    risk: "draft",
    allowedStatuses: ["strategy_approved", "script_draft"],
    allowedRoles: creatorsAndAdmins,
  },
  request_script_approval: {
    risk: "approval_request",
    allowedStatuses: ["script_draft"],
    allowedRoles: creatorsAndAdmins,
  },
  convert_video_prompt: {
    risk: "draft",
    allowedStatuses: ["script_approved", "prompt_draft"],
    allowedRoles: creatorsAndAdmins,
  },
  create_storyboard_draft: {
    risk: "draft",
    allowedStatuses: ["prompt_approved", "storyboard_draft"],
    allowedRoles: creatorsAndAdmins,
  },
  start_video_generation: {
    risk: "expensive",
    allowedStatuses: ["storyboard_approved"],
    allowedRoles: creatorsAndAdmins,
    estimatedMaximumCost: 100,
  },
  prepare_export: {
    risk: "export",
    allowedStatuses: ["export_ready"],
    allowedRoles: ["reviewer", "content_admin"],
  },
};

const forbiddenGenericTools = new Set(["bash", "shell", "read", "write", "edit", "sql", "http", "browser"]);
const forbiddenBusinessTools = new Set(["approve_strategy", "approve_script", "approve_storyboard", "publish_ad"]);

export function evaluateToolPolicy(input: PolicyInput): PolicyDecision {
  if (forbiddenGenericTools.has(input.toolName) || forbiddenBusinessTools.has(input.toolName)) {
    return {
      allowed: false,
      code: "AIC-AUTH-FORBIDDEN_TOOL",
      reason: `Tool '${input.toolName}' is outside the production agent boundary.`,
      severity: "critical",
    };
  }

  const policy = toolPolicies[input.toolName];
  if (!policy) {
    return {
      allowed: false,
      code: "AIC-AUTH-UNKNOWN_TOOL",
      reason: `Tool '${input.toolName}' is not in the allowlist.`,
      severity: "critical",
    };
  }

  if (!policy.allowedRoles.includes(input.scope.role)) {
    return {
      allowed: false,
      code: "AIC-AUTH-ROLE_DENIED",
      reason: `Role '${input.scope.role}' cannot use tool '${input.toolName}'.`,
      severity: "normal",
    };
  }

  if (!policy.allowedStatuses.includes(input.status)) {
    return {
      allowed: false,
      code: "AIC-WORKFLOW-TOOL_NOT_ALLOWED",
      reason: `Tool '${input.toolName}' is not allowed while work status is '${input.status}'.`,
      severity: "normal",
    };
  }

  if ((policy.risk === "approval_request" || policy.risk === "export") && !input.scope.hasInteractiveApprovalChannel) {
    return {
      allowed: false,
      code: "AIC-AUTH-APPROVAL_CHANNEL_REQUIRED",
      reason: `Tool '${input.toolName}' requires an interactive approval channel.`,
      severity: "critical",
    };
  }

  if (policy.estimatedMaximumCost !== undefined && input.scope.budgetRemaining < policy.estimatedMaximumCost) {
    return {
      allowed: false,
      code: "AIC-COST-BUDGET_EXCEEDED",
      reason: `Remaining project budget is insufficient for tool '${input.toolName}'.`,
      severity: "normal",
    };
  }

  return { allowed: true, risk: policy.risk };
}
