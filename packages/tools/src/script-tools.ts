import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AgentActionCard,
  ProposeScriptGenerationRequestSchema,
  type ProposeScriptGenerationRequest,
} from "@firefly/schemas";

export interface ScriptProposalPort {
  readonly videoTaskId: string;
  currentRevision(): number | Promise<number>;
}

function textResult<T>(details: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export function createScriptProposalTools(service: ScriptProposalPort): readonly AgentTool[] {
  const proposeScriptGeneration: AgentTool<typeof ProposeScriptGenerationRequestSchema> = {
    name: "propose_script_generation",
    label: "建议生成脚本草稿",
    description:
      "将基于当前任务已确认策略拟定的一条完整脚本包装为需要负责人点击的操作卡片。调用前必须读取当前策略草稿与当前阶段建议依据。本工具只提出建议，不持久化脚本，也不确认脚本阶段。",
    parameters: ProposeScriptGenerationRequestSchema,
    async execute(_toolCallId, params: ProposeScriptGenerationRequest) {
      const expectedRevision = await service.currentRevision();
      return textResult({
        schemaVersion: 1,
        kind: "agent_action_card",
        videoTaskId: service.videoTaskId,
        action: "generate_script",
        label: "生成脚本草稿",
        summary: "生成一条遵守已确认策略、车型事实和任务时长的脚本草稿，点击后才会写入任务并进入人工确认。",
        expectedRevision,
        cost: { kind: "free" },
        payload: { schemaVersion: 1, script: params.script },
      } satisfies AgentActionCard);
    },
  };
  return [proposeScriptGeneration];
}
