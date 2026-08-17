import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  GenerateStrategyRequestSchema,
  StrategyApprovalRequestSchema,
  ValidateStrategyRequestSchema,
  type GenerateStrategyRequest,
  type StrategyApprovalRequest,
} from "@firefly/schemas";

import type { StrategyWorkflowPort } from "./strategy-service.ts";

function textResult<T>(details: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export function createStrategyTools(service: StrategyWorkflowPort): readonly AgentTool[] {
  const generateStrategy: AgentTool<typeof GenerateStrategyRequestSchema> = {
    name: "generate_strategy",
    label: "生成卖点策略草稿",
    description: "根据当前作品绑定的车型快照生成卖点策略草稿。作品和身份由服务端会话绑定。",
    parameters: GenerateStrategyRequestSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: GenerateStrategyRequest) {
      return textResult(await service.generate(params));
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

  const requestStrategyApproval: AgentTool<typeof StrategyApprovalRequestSchema> = {
    name: "request_strategy_approval",
    label: "提交卖点策略人工审批",
    description: "将校验通过的当前策略提交给人工审批。Agent 不能批准策略。",
    parameters: StrategyApprovalRequestSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: StrategyApprovalRequest) {
      return textResult(await service.requestApproval(params.expectedRevision));
    },
  };

  return [generateStrategy, validateStrategy, requestStrategyApproval];
}
