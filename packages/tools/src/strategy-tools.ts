import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AgentActionCard,
  ProposeStrategyApprovalRequestSchema,
  ProposeStrategyGenerationRequestSchema,
  ValidateStrategyRequestSchema,
  type ProposeStrategyApprovalRequest,
  type ProposeStrategyGenerationRequest,
} from "@firefly/schemas";

import type { StrategyWorkflowPort } from "./strategy-service.ts";

function textResult<T>(details: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export function createStrategyTools(service: StrategyWorkflowPort): readonly AgentTool[] {
  const proposeStrategyGeneration: AgentTool<typeof ProposeStrategyGenerationRequestSchema> = {
    name: "propose_strategy_generation",
    label: "建议生成卖点策略草稿",
    description: "为当前作品创建一个需要负责人点击确认的策略生成操作卡片。本工具只提出建议，不生成或持久化策略。",
    parameters: ProposeStrategyGenerationRequestSchema,
    async execute(_toolCallId, params: ProposeStrategyGenerationRequest) {
      const expectedRevision = await service.currentRevision();
      return textResult({
        schemaVersion: 1,
        kind: "agent_action_card",
        videoTaskId: service.videoTaskId,
        action: "generate_strategy",
        label: "生成卖点策略草稿",
        summary: `面向“${params.audience}”生成“${params.theme}”策略，点击后才会写入作品。`,
        expectedRevision,
        cost: { kind: "free" },
        payload: { schemaVersion: 1, ...params },
      } satisfies AgentActionCard);
    },
  };

  const validateStrategy: AgentTool<typeof ValidateStrategyRequestSchema> = {
    name: "validate_strategy",
    label: "校验卖点策略",
    description: "校验当前策略的固定卖点覆盖、事实依据、类型和禁用表达。",
    parameters: ValidateStrategyRequestSchema,
    async execute() {
      return textResult(await service.validate());
    },
  };

  const proposeStrategyApproval: AgentTool<typeof ProposeStrategyApprovalRequestSchema> = {
    name: "propose_strategy_approval",
    label: "建议提交卖点策略人工审批",
    description: "为当前策略创建一个需要负责人点击确认的审批请求操作卡片。本工具不会提交审批，更不能批准策略。",
    parameters: ProposeStrategyApprovalRequestSchema,
    async execute(_toolCallId, _params: ProposeStrategyApprovalRequest) {
      const expectedRevision = await service.currentRevision();
      return textResult({
        schemaVersion: 1,
        kind: "agent_action_card",
        videoTaskId: service.videoTaskId,
        action: "request_strategy_approval",
        label: "提交卖点策略人工审批",
        summary: "校验当前策略后，由负责人点击提交到人工审批。",
        expectedRevision,
        cost: { kind: "free" },
        payload: { schemaVersion: 1 },
      } satisfies AgentActionCard);
    },
  };

  return [proposeStrategyGeneration, validateStrategy, proposeStrategyApproval];
}
