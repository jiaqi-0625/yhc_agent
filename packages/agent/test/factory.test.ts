import assert from "node:assert/strict";
import test from "node:test";

import type { BeforeToolCallContext, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { InMemoryVehicleService } from "@firefly/tools";

import { ADVERTISING_AGENT_SYSTEM_PROMPT, createAdvertisingAgent, redactSensitive } from "../src/index.ts";

const model = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://invalid.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
} as Model<Api>;

const streamFn: StreamFn = async () => {
  throw new Error("Mock stream function must not be called by construction tests.");
};

const scope = {
  actorId: "user_001",
  tenantId: "tenant_001",
  projectId: "project_001",
  role: "creator" as const,
  allowedBrandIds: ["brand_001"],
  budgetRemaining: 100,
  hasInteractiveApprovalChannel: true,
};

function createAgent(status: "created" | "script_draft" = "created") {
  return createAdvertisingAgent({
    model,
    streamFn,
    scope,
    getWorkStatus: () => status,
    vehicleService: new InMemoryVehicleService([]),
  });
}

test("agent registers only the two current domain tools", () => {
  const agent = createAgent();
  assert.deepEqual(
    agent.state.tools.map((tool) => tool.name),
    ["get_vehicle_snapshot", "validate_vehicle_claims"],
  );
  assert.equal(agent.state.systemPrompt, ADVERTISING_AGENT_SYSTEM_PROMPT);
  assert.match(agent.state.systemPrompt, /不能批准自己的/);
  assert.doesNotMatch(agent.state.tools.map((tool) => tool.name).join(","), /bash|shell|http|browser|approve/u);
});

test("business assembly adds strategy tools without exposing an approval decision tool", () => {
  const strategyService = {
    async generate() { throw new Error("not called"); },
    async validate() { return { valid: true, issues: [] }; },
    async requestApproval() { throw new Error("not called"); },
  };
  const agent = createAdvertisingAgent({
    model,
    streamFn,
    scope,
    getWorkStatus: () => "strategy_draft",
    vehicleService: new InMemoryVehicleService([]),
    strategyService,
  });
  assert.deepEqual(
    agent.state.tools.map((tool) => tool.name),
    [
      "get_vehicle_snapshot",
      "validate_vehicle_claims",
      "generate_strategy",
      "validate_strategy",
      "request_strategy_approval",
    ],
  );
  assert.doesNotMatch(agent.state.tools.map((tool) => tool.name).join(","), /approve_strategy/u);
});

test("before-tool hook blocks a registered tool in the wrong workflow state", async () => {
  const agent = createAgent("script_draft");
  assert.ok(agent.beforeToolCall);
  const result = await agent.beforeToolCall({
    toolCall: { type: "toolCall", id: "call_1", name: "get_vehicle_snapshot", arguments: {} },
  } as unknown as BeforeToolCallContext);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /AIC-WORKFLOW-TOOL_NOT_ALLOWED/);
});

test("redaction removes secret-bearing fields and bearer credentials", () => {
  assert.deepEqual(
    redactSensitive({ apiKey: "not-for-logs", nested: { authorization: "Bearer abc.def", safe: "Bearer abc.def" } }),
    { apiKey: "[REDACTED]", nested: { authorization: "[REDACTED]", safe: "[REDACTED]" } },
  );
});
