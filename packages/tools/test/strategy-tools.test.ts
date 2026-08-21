import assert from "node:assert/strict";
import test from "node:test";
import { AgentActionCardSchema } from "@firefly/schemas";
import { Value } from "typebox/value";

import {
  createStrategyProposalTools,
  createStrategyDraftTools,
  createStrategyTools,
  type StrategyWorkflowPort,
} from "../src/index.ts";
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
    videoTaskId: "video_task_strategy_001",
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
    kind: "agent_action_card",
    videoTaskId: "video_task_strategy_001",
    action: "generate_strategy",
    label: "生成卖点策略草稿",
    summary: "面向“年轻家庭”生成“周末露营”策略，点击后才会写入作品。",
    expectedRevision: 3,
    cost: { kind: "free" },
    payload: { schemaVersion: 1, audience: "年轻家庭", theme: "周末露营" },
  });

  const approval = tools.find((tool) => tool.name === "propose_strategy_approval");
  assert.ok(approval);
  const approvalResult = await approval.execute("call_approval", {});
  assert.equal(approvalResult.details.action, "request_strategy_approval");
  assert.equal(approvalResult.details.expectedRevision, 3);
  assert.equal(mutationCalls, 0);
});

test("V2 strategy proposal tools need only the server-bound task revision", async () => {
  let revisionReads = 0;
  const tools = createStrategyProposalTools({
    videoTaskId: "video_task_v2_strategy_001",
    async currentRevision() {
      revisionReads += 1;
      return 7;
    },
  });
  assert.deepEqual(tools.map((tool) => tool.name), [
    "propose_strategy_generation",
    "propose_strategy_approval",
  ]);
  assert.equal(tools.some((tool) => tool.name === "validate_strategy"), false);

  const generation = await tools[0].execute("call_v2_generate", {
    audience: "周末亲子家庭",
    theme: "城市周末短途出行",
  });
  assert.deepEqual(generation.details, {
    schemaVersion: 1,
    kind: "agent_action_card",
    videoTaskId: "video_task_v2_strategy_001",
    action: "generate_strategy",
    label: "生成卖点策略草稿",
    summary: "面向“周末亲子家庭”生成“城市周末短途出行”策略，点击后才会写入作品。",
    expectedRevision: 7,
    cost: { kind: "free" },
    payload: {
      schemaVersion: 1,
      audience: "周末亲子家庭",
      theme: "城市周末短途出行",
    },
  });
  const approval = await tools[1].execute("call_v2_approval", {});
  assert.equal(approval.details.action, "request_strategy_approval");
  assert.equal(approval.details.expectedRevision, 7);
  assert.equal(revisionReads, 2);
});

test("current strategy draft tool returns only the task-scoped persisted draft view", async () => {
  const [tool] = createStrategyDraftTools({
    videoTaskId: "video_task_v2_strategy_001",
    async read() {
      return {
        schemaVersion: 1,
        kind: "current_strategy_draft",
        videoTaskId: "video_task_v2_strategy_001",
        taskRevision: 8,
        vehicleSnapshotId: "vehicle_snapshot_c10_v3",
        draft: {
          schemaVersion: 1,
          id: "strategy_draft_c10_v1",
          videoTaskId: "video_task_v2_strategy_001",
          vehicleSnapshotId: "vehicle_snapshot_c10_v3",
          version: 1,
          status: "draft",
          audience: "城市家庭",
          theme: "通勤与周末出行",
          items: [{
            id: "strategy_item_c10_1",
            claimId: "claim_c10_space",
            kind: "fixed",
            title: "舒适空间",
            statement: "提供舒适乘坐空间。",
            rationale: "匹配家庭出行场景。",
            order: 1,
            locked: false,
          }],
          validation: { valid: true, issues: [] },
        },
        readBoundary: {
          taskScoped: true,
          immutableVehicleFacts: true,
          mayMutateDraft: false,
          mayRequestApproval: false,
          mayApprove: false,
        },
      };
    },
  });
  assert.ok(tool);
  assert.equal(tool.name, "get_current_strategy_draft");
  const result = await tool.execute("call_read_strategy", {});
  assert.equal(result.details.taskRevision, 8);
  assert.equal(result.details.draft.items[0]?.claimId, "claim_c10_space");
  assert.equal("tenantId" in result.details.draft, false);
  assert.equal("createdBy" in result.details.draft, false);
  assert.equal("generation" in result.details.draft, false);
  assert.equal("createdAt" in result.details.draft, false);
});
