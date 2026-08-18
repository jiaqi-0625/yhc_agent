import assert from "node:assert/strict";
import test from "node:test";
import { AgentActionCardSchema } from "@firefly/schemas";
import { Value } from "typebox/value";

import { createStrategyTools, type StrategyWorkflowPort } from "../src/index.ts";
import { agentActionCardFixtures, taskContextFixture } from "../../schemas/test/fixtures/workspace-v2.ts";

test("dialog fixtures consume the shared workspace v2 Agent contracts", () => {
  assert.equal(taskContextFixture.schemaVersion, 1);
  for (const card of agentActionCardFixtures) {
    assert.equal(card.schemaVersion, taskContextFixture.schemaVersion);
    assert.equal(card.videoTaskId, taskContextFixture.videoTask.id);
    assert.equal(Value.Check(AgentActionCardSchema, card), true);
  }
});

test("strategy Agent tools return versioned proposals without mutating workflow state", async () => {
  let mutationCalls = 0;
  const service: StrategyWorkflowPort = {
    async currentRevision() { return 3; },
    async generate() {
      mutationCalls += 1;
      throw new Error("proposal tools must not generate strategies");
    },
    async validate() {
      return { valid: true, issues: [] };
    },
    async requestApproval() {
      mutationCalls += 1;
      throw new Error("proposal tools must not request approval");
    },
  };
  const tools = createStrategyTools(service);
  assert.deepEqual(tools.map((tool) => tool.name), [
    "propose_strategy_generation",
    "validate_strategy",
    "propose_strategy_approval",
  ]);

  const generation = tools.find((tool) => tool.name === "propose_strategy_generation");
  assert.ok(generation);
  const generationResult = await generation.execute("call_generate", {
    audience: "年轻家庭",
    theme: "周末露营",
  });
  assert.deepEqual(generationResult.details, {
    schemaVersion: 1,
    kind: "action_proposal",
    action: "generate_strategy",
    label: "生成卖点策略草稿",
    summary: "面向“年轻家庭”生成“周末露营”策略，点击后才会写入作品。",
    expectedRevision: 3,
    payload: { expectedRevision: 3, audience: "年轻家庭", theme: "周末露营" },
  });

  const approval = tools.find((tool) => tool.name === "propose_strategy_approval");
  assert.ok(approval);
  const approvalResult = await approval.execute("call_approval", {});
  assert.equal(approvalResult.details.action, "request_strategy_approval");
  assert.equal(approvalResult.details.expectedRevision, 3);
  assert.equal(mutationCalls, 0);
});
