import assert from "node:assert/strict";
import test from "node:test";

import type { AfterToolCallContext, BeforeToolCallContext, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { toolPolicies } from "@firefly/domain";
import type { TaskContext } from "@firefly/schemas";
import { InMemoryVehicleService } from "@firefly/tools";

import { ADVERTISING_AGENT_SYSTEM_PROMPT, createAdvertisingAgent, redactSensitive } from "../src/index.ts";
import { MOCK_TASK_CONTEXT } from "./task-context-fixture.ts";

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
const TASK_ASSET_SNAPSHOT_ID = "asset_snapshot_factory_001";

function createAgent(status: "created" | "script_draft" = "created") {
  return createAdvertisingAgent({
    model,
    streamFn,
    scope,
    getWorkStatus: () => status,
    vehicleService: new InMemoryVehicleService([]),
  });
}

function taskContextWithoutAssetSnapshot(): TaskContext {
  const { assetSnapshotId, ...videoTask } = MOCK_TASK_CONTEXT.videoTask;
  void assetSnapshotId;
  return {
    ...MOCK_TASK_CONTEXT,
    videoTask: { ...videoTask, currentStage: "script", stageStatus: "in_progress" },
  };
}

function taskContextWithAssetSnapshot(): TaskContext {
  return {
    ...MOCK_TASK_CONTEXT,
    videoTask: {
      ...MOCK_TASK_CONTEXT.videoTask,
      currentStage: "storyboard",
      stageStatus: "in_progress",
      assetSnapshotId: TASK_ASSET_SNAPSHOT_ID,
    },
  };
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
    videoTaskId: "video_task_factory_001",
    async currentRevision() { return 1; },
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
      "propose_strategy_generation",
      "validate_strategy",
      "propose_strategy_approval",
    ],
  );
  assert.match(agent.state.systemPrompt, /卖点策略生成建议/u);
  assert.match(agent.state.systemPrompt, /策略人工审批请求建议/u);
  assert.match(agent.state.systemPrompt, /点击卡片/u);
  assert.match(agent.state.systemPrompt, /不得向用户索要 videoTaskId、vehicleId、revision/u);
  assert.match(agent.state.systemPrompt, /面向非技术人员表达/u);
  assert.match(agent.state.systemPrompt, /不得展示内部工具名、错误码、Schema、JSON/u);
  assert.match(agent.state.systemPrompt, /人工审批决策尚未注册/u);
  assert.doesNotMatch(
    agent.state.tools.map((tool) => tool.name).join(","),
    /(?:^|,)(?:generate_strategy|request_strategy_approval|approve_strategy)(?:,|$)/u,
  );
});

test("task-bound assembly adds the immutable asset snapshot reader only for the matching task", () => {
  const taskContext = taskContextWithAssetSnapshot();
  const reader = {
    videoTaskId: taskContext.videoTask.id,
    assetSnapshotId: TASK_ASSET_SNAPSHOT_ID,
    async read() { throw new Error("not called"); },
  };
  const agent = createAdvertisingAgent({
    model,
    streamFn,
    scope,
    taskContext,
    getWorkStatus: () => "created",
    vehicleService: new InMemoryVehicleService([]),
    taskAssetReader: reader,
  });
  assert.deepEqual(agent.state.tools.map((tool) => tool.name), [
    "get_vehicle_snapshot",
    "validate_vehicle_claims",
    "get_task_asset_snapshot",
  ]);
  assert.match(agent.state.systemPrompt, /本地上传必须提示人工复核原始来源说明与使用权声明/u);
  assert.match(agent.state.systemPrompt, /精确版本和推荐理由/u);
  assert.match(agent.state.systemPrompt, /车型素材不可跨车型替换/u);
  assert.match(agent.state.systemPrompt, /资产匹配确认后.*当前任务锁定的素材快照/u);
  assert.match(
    agent.state.tools.find((tool) => tool.name === "get_task_asset_snapshot")?.description ?? "",
    /素材匹配经人工确认后锁定.*逐项来源风险.*人物\/场景推荐.*资产匹配确认后/u,
  );
  assert.throws(
    () => createAdvertisingAgent({
      model,
      streamFn,
      scope,
      taskContext,
      getWorkStatus: () => "created",
      vehicleService: new InMemoryVehicleService([]),
      taskAssetReader: { ...reader, videoTaskId: "task_other" },
    }),
    /scope does not match/u,
  );
});

test("task-bound assembly omits the asset snapshot tool until a snapshot pointer exists", () => {
  const taskContext = taskContextWithoutAssetSnapshot();
  const agent = createAdvertisingAgent({
    model,
    streamFn,
    scope,
    taskContext,
    getWorkStatus: () => "script_draft",
    vehicleService: new InMemoryVehicleService([]),
  });
  assert.deepEqual(agent.state.tools.map((tool) => tool.name), [
    "get_vehicle_snapshot",
    "validate_vehicle_claims",
  ]);
  assert.doesNotMatch(agent.state.tools.map((tool) => tool.name).join(","), /get_task_asset_snapshot/u);

  assert.throws(
    () => createAdvertisingAgent({
      model,
      streamFn,
      scope,
      taskContext,
      getWorkStatus: () => "script_draft",
      vehicleService: new InMemoryVehicleService([]),
      taskAssetReader: {
        videoTaskId: taskContext.videoTask.id,
        assetSnapshotId: TASK_ASSET_SNAPSHOT_ID,
        async read() { throw new Error("not called"); },
      },
    }),
    /scope does not match/u,
  );
});

test("task-bound assembly adds stage suggestions only for the matching server-bound task", () => {
  const taskContext = taskContextWithoutAssetSnapshot();
  const reader = {
    videoTaskId: taskContext.videoTask.id,
    async read() { throw new Error("not called"); },
  };
  const agent = createAdvertisingAgent({
    model,
    streamFn,
    scope,
    taskContext,
    getWorkStatus: () => "script_draft",
    vehicleService: new InMemoryVehicleService([]),
    stageSuggestionReader: reader,
  });
  assert.deepEqual(agent.state.tools.map((tool) => tool.name), [
    "get_vehicle_snapshot",
    "validate_vehicle_claims",
    "get_current_stage_suggestion_context",
  ]);
  assert.match(agent.state.systemPrompt, /脚本、资产匹配、分镜或交付阶段建议前/u);
  assert.match(agent.state.systemPrompt, /已确认上游产物精确版本/u);
  assert.match(agent.state.systemPrompt, /脚本建议只遵守已确认策略，不提前选材/u);
  assert.match(agent.state.systemPrompt, /资产匹配建议同时遵守已确认策略和脚本/u);
  assert.match(agent.state.systemPrompt, /分镜建议必须遵守已确认素材选择/u);
  assert.match(agent.state.systemPrompt, /当前项目资产池返回的素材描述词/u);
  assert.match(agent.state.systemPrompt, /本地候选必须提示人工复核来源和使用权/u);
  assert.match(agent.state.systemPrompt, /资产匹配可返回带描述词的精确版本人物\/场景候选并提出推荐/u);
  assert.match(agent.state.systemPrompt, /不得持久化选择或确认阶段/u);
  assert.match(agent.state.systemPrompt, /不得声称已生成、持久化、确认、导出或发布/u);
  assert.throws(
    () => createAdvertisingAgent({
      model,
      streamFn,
      scope,
      taskContext,
      getWorkStatus: () => "script_draft",
      vehicleService: new InMemoryVehicleService([]),
      stageSuggestionReader: { ...reader, videoTaskId: "task_other" },
    }),
    /scope does not match/u,
  );
});

test("every dynamically assembled production tool is allowlisted and no approval decision tool is registered", () => {
  const taskContext = taskContextWithAssetSnapshot();
  const strategyService = {
    videoTaskId: taskContext.videoTask.id,
    async currentRevision() { return taskContext.videoTask.revision; },
    async generate() { throw new Error("not called"); },
    async validate() { return { valid: true, issues: [] }; },
    async requestApproval() { throw new Error("not called"); },
  };
  const agent = createAdvertisingAgent({
    model,
    streamFn,
    scope,
    taskContext,
    getWorkStatus: () => "strategy_draft",
    vehicleService: new InMemoryVehicleService([]),
    strategyService,
    taskAssetReader: {
      videoTaskId: taskContext.videoTask.id,
      assetSnapshotId: TASK_ASSET_SNAPSHOT_ID,
      async read() { throw new Error("not called"); },
    },
    stageSuggestionReader: {
      videoTaskId: taskContext.videoTask.id,
      async read() { throw new Error("not called"); },
    },
  });
  const toolNames = agent.state.tools.map((tool) => tool.name);
  assert.ok(toolNames.every((toolName) => Object.hasOwn(toolPolicies, toolName)));
  assert.doesNotMatch(
    toolNames.join(","),
    /bash|shell|filesystem|sql|http|browser|approve_strategy|approve_script|approve_storyboard|publish_ad/u,
  );
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

test("before-tool hook awaits the current persisted workflow status", async () => {
  const agent = createAdvertisingAgent({
    model,
    streamFn,
    scope,
    getWorkStatus: async () => "awaiting_strategy_approval" as const,
    vehicleService: new InMemoryVehicleService([]),
  });
  assert.ok(agent.beforeToolCall);
  const result = await agent.beforeToolCall({
    toolCall: { type: "toolCall", id: "call_async_status", name: "get_vehicle_snapshot", arguments: {} },
  } as unknown as BeforeToolCallContext);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /AIC-WORKFLOW-TOOL_NOT_ALLOWED/u);
});

test("redaction removes secret-bearing fields and bearer credentials", () => {
  assert.deepEqual(
    redactSensitive({ apiKey: "not-for-logs", nested: { authorization: "Bearer abc.def", safe: "Bearer abc.def" } }),
    { apiKey: "[REDACTED]", nested: { authorization: "[REDACTED]", safe: "[REDACTED]" } },
  );
  const serialized = redactSensitive(
    '{"password":"text-secret","nested":{"apiKey":"json-secret"},"safe":"keep"}',
  );
  assert.doesNotMatch(String(serialized), /text-secret|json-secret/u);
  assert.match(String(serialized), /"safe":"keep"/u);
  assert.deepEqual(JSON.parse(String(serialized)), {
    password: "[REDACTED]",
    nested: { apiKey: "[REDACTED]" },
    safe: "keep",
  });
});

test("after-tool hook redacts serialized content and structured details before model or timeline use", async () => {
  const agent = createAgent();
  assert.ok(agent.afterToolCall);
  const result = await agent.afterToolCall({
    toolCall: { type: "toolCall", id: "call_redact", name: "get_vehicle_snapshot", arguments: {} },
    result: {
      content: [{ type: "text", text: '{"authorization":"Bearer tool-content-secret","safe":"visible"}' }],
      details: { password: "detail-secret", safe: "visible" },
    },
    isError: false,
  } as unknown as AfterToolCallContext);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /tool-content-secret|detail-secret/u);
  assert.match(serialized, /visible/u);
  assert.match(serialized, /\[REDACTED\]/u);
});
