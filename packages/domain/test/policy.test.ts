import assert from "node:assert/strict";
import test from "node:test";
import { evaluateToolPolicy, type SessionScope } from "../src/policy.ts";

const scope: SessionScope = {
  actorId: "user_001",
  tenantId: "tenant_001",
  projectId: "project_001",
  role: "creator",
  allowedBrandIds: ["brand_001"],
  budgetRemaining: 500,
  hasInteractiveApprovalChannel: true,
};

test("policy allows an allowlisted read tool in the correct state", () => {
  assert.deepEqual(evaluateToolPolicy({ toolName: "get_vehicle_snapshot", status: "created", scope }), {
    allowed: true,
    risk: "read",
  });
});

test("policy allows the task-bound asset snapshot reader but not a catalog search tool", () => {
  assert.deepEqual(evaluateToolPolicy({ toolName: "get_task_asset_snapshot", status: "created", scope }), {
    allowed: true,
    risk: "read",
  });
  assert.equal(evaluateToolPolicy({ toolName: "search_company_assets", status: "created", scope }).allowed, false);
});

test("policy allows non-mutating action proposals but rejects model-callable state changes", () => {
  assert.deepEqual(evaluateToolPolicy({ toolName: "propose_strategy_generation", status: "created", scope }), {
    allowed: true,
    risk: "proposal",
  });
  const mutation = evaluateToolPolicy({ toolName: "generate_strategy", status: "created", scope });
  assert.equal(mutation.allowed, false);
  if (!mutation.allowed) assert.equal(mutation.code, "AIC-AUTH-UNKNOWN_TOOL");
});
test("policy blocks generic and unknown tools", () => {
  assert.equal(evaluateToolPolicy({ toolName: "bash", status: "created", scope }).allowed, false);
  assert.equal(evaluateToolPolicy({ toolName: "arbitrary_network_call", status: "created", scope }).allowed, false);
});

test("policy blocks model-callable approvals", () => {
  const decision = evaluateToolPolicy({ toolName: "approve_strategy", status: "awaiting_strategy_approval", scope });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "AIC-AUTH-FORBIDDEN_TOOL");
});

test("policy blocks tools in the wrong workflow state", () => {
  const decision = evaluateToolPolicy({ toolName: "generate_script", status: "strategy_draft", scope });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "AIC-WORKFLOW-TOOL_NOT_ALLOWED");
});

test("policy blocks expensive tools when budget is insufficient", () => {
  const decision = evaluateToolPolicy({
    toolName: "start_video_generation",
    status: "storyboard_approved",
    scope: { ...scope, budgetRemaining: 99 },
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "AIC-COST-BUDGET_EXCEEDED");
});
