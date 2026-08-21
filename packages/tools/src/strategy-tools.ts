import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AgentActionCard,
  ProposeStrategyApprovalRequestSchema,
  ProposeStrategyGenerationRequestSchema,
  ValidateStrategyRequestSchema,
  type ProposeStrategyApprovalRequest,
  type ProposeStrategyGenerationRequest,
  type VideoTaskStrategyDraft,
} from "@firefly/schemas";
import { Type } from "typebox";

import type { StrategyWorkflowPort } from "./strategy-service.ts";

function textResult<T>(details: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export interface StrategyProposalPort {
  readonly videoTaskId: string;
  currentRevision(): number | Promise<number>;
}

const GetCurrentStrategyDraftRequestSchema = Type.Object({}, { additionalProperties: false });

export interface StrategyDraftContextView {
  readonly schemaVersion: 1;
  readonly kind: "current_strategy_draft";
  readonly videoTaskId: string;
  readonly taskRevision: number;
  readonly vehicleSnapshotId: string;
  readonly draft: Pick<
    VideoTaskStrategyDraft,
    | "schemaVersion"
    | "id"
    | "videoTaskId"
    | "vehicleSnapshotId"
    | "version"
    | "status"
    | "audience"
    | "theme"
    | "items"
    | "validation"
  >;
  readonly readBoundary: {
    readonly taskScoped: true;
    readonly immutableVehicleFacts: true;
    readonly mayMutateDraft: false;
    readonly mayRequestApproval: false;
    readonly mayApprove: false;
  };
}

export interface StrategyDraftReader {
  readonly videoTaskId: string;
  read(signal?: AbortSignal): Promise<StrategyDraftContextView>;
}

export class StrategyDraftAccessError extends Error {
  readonly code = "AIC-STRATEGY-DRAFT-UNAVAILABLE";

  constructor(message = "The current task does not expose a readable active strategy draft.") {
    super(message);
    this.name = "StrategyDraftAccessError";
  }
}

export function createStrategyDraftTools(reader: StrategyDraftReader): readonly AgentTool[] {
  const getCurrentStrategyDraft: AgentTool<typeof GetCurrentStrategyDraftRequestSchema> = {
    name: "get_current_strategy_draft",
    label: "读取当前策略草稿",
    description: "读取当前任务服务端已持久化的策略草稿正文、卖点、校验结果和锁定车型快照引用。提交策略人工审批前必须先读取；本工具只读，不能修改草稿、提交审批或代替人工确认。",
    parameters: GetCurrentStrategyDraftRequestSchema,
    async execute(_toolCallId, _params, signal) {
      return textResult(await reader.read(signal));
    },
  };
  return [getCurrentStrategyDraft];
}

export function createStrategyProposalTools(service: StrategyProposalPort) {
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

  return [proposeStrategyGeneration, proposeStrategyApproval] as const;
}

export function createStrategyTools(service: StrategyWorkflowPort): readonly AgentTool[] {
  const [proposeStrategyGeneration, proposeStrategyApproval] = createStrategyProposalTools(service);
  const validateStrategy: AgentTool<typeof ValidateStrategyRequestSchema> = {
    name: "validate_strategy",
    label: "校验卖点策略",
    description: "校验当前策略的固定卖点覆盖、事实依据、类型和禁用表达。",
    parameters: ValidateStrategyRequestSchema,
    async execute() {
      return textResult(await service.validate());
    },
  };

  return [proposeStrategyGeneration, validateStrategy, proposeStrategyApproval];
}
