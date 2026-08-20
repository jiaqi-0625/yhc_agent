import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import { evaluateToolPolicy, type SessionScope } from "@firefly/domain";
import type { TaskContext, WorkStatus } from "@firefly/schemas";
import {
  createStageSuggestionTools,
  createStrategyProposalTools,
  createStrategyTools,
  createTaskAssetTools,
  createVehicleTools,
  type StageSuggestionContextReader,
  type StrategyProposalPort,
  type StrategyWorkflowPort,
  type TaskAssetSnapshotReader,
  type VehicleServicePort,
} from "@firefly/tools";

import { createBaseAgent } from "./base-agent.ts";
import { ADVERTISING_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";

export interface AgentAuditEvent {
  occurredAt: string;
  actorId: string;
  tenantId: string;
  projectId: string;
  toolName: string;
  phase: "policy_allowed" | "policy_blocked" | "execution_completed" | "execution_failed";
  code?: string;
}

export type AgentAuditSink = (event: AgentAuditEvent) => void | Promise<void>;

export interface CreateAdvertisingAgentOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  messages?: readonly AgentMessage[];
  sessionId?: string;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  scope: SessionScope;
  taskContext?: TaskContext;
  getWorkStatus: () => WorkStatus | Promise<WorkStatus>;
  vehicleService: VehicleServicePort;
  strategyProposal?: StrategyProposalPort;
  strategyService?: StrategyWorkflowPort;
  taskAssetReader?: TaskAssetSnapshotReader;
  stageSuggestionReader?: StageSuggestionContextReader;
  auditSink?: AgentAuditSink;
}

const sensitiveKeyPattern = /(?:api[-_]?key|authorization|cookie|password|secret|token)/iu;
const sensitiveTextPatterns = [
  /((?:["']?)(?:api[-_]?key|authorization|cookie|password|secret|token)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
];

export function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    return sensitiveTextPatterns.reduce(
      (text, pattern, index) => text.replace(pattern, index === 0 ? "$1\"[REDACTED]\"" : "[REDACTED]"),
      value,
    );
  }
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactSensitive(item)]),
    );
  }
  return value;
}

function redactContent(
  content: AfterToolCallContext["result"]["content"],
): NonNullable<AfterToolCallResult["content"]> {
  return content.map((item) => {
    if (item.type !== "text") return item;
    return { ...item, text: redactSensitive(item.text) as string } satisfies TextContent;
  });
}

export function createAdvertisingAgent(options: CreateAdvertisingAgentOptions) {
  if (
    options.strategyProposal !== undefined &&
    (options.taskContext === undefined ||
      options.taskContext.videoTask.id !== options.strategyProposal.videoTaskId)
  ) {
    throw new Error("Strategy proposal scope does not match the server-resolved task context.");
  }
  if (options.strategyProposal !== undefined && options.strategyService !== undefined) {
    throw new Error("Strategy proposal and legacy strategy service cannot both be registered.");
  }
  if (
    options.taskAssetReader !== undefined &&
    (options.taskContext === undefined ||
      options.taskContext.videoTask.id !== options.taskAssetReader.videoTaskId ||
      options.taskContext.videoTask.assetSnapshotId !== options.taskAssetReader.assetSnapshotId)
  ) {
    throw new Error("Task asset reader scope does not match the server-resolved task context.");
  }
  if (
    options.stageSuggestionReader !== undefined &&
    (options.taskContext === undefined ||
      options.taskContext.videoTask.id !== options.stageSuggestionReader.videoTaskId)
  ) {
    throw new Error("Stage suggestion reader scope does not match the server-resolved task context.");
  }
  const vehicleTools = createVehicleTools(options.vehicleService, {
    actorId: options.scope.actorId,
    tenantId: options.scope.tenantId,
    projectId: options.scope.projectId,
    allowedBrandIds: options.scope.allowedBrandIds,
  });
  const tools = [
    ...vehicleTools,
    ...(options.taskAssetReader === undefined ? [] : createTaskAssetTools(options.taskAssetReader)),
    ...(options.stageSuggestionReader === undefined ? [] : createStageSuggestionTools(options.stageSuggestionReader)),
    ...(options.strategyService !== undefined
      ? createStrategyTools(options.strategyService)
      : options.strategyProposal === undefined
        ? []
        : createStrategyProposalTools(options.strategyProposal)),
  ];

  const audit = async (event: Omit<AgentAuditEvent, "occurredAt" | "actorId" | "tenantId" | "projectId">) => {
    await options.auditSink?.({
      ...event,
      occurredAt: new Date().toISOString(),
      actorId: options.scope.actorId,
      tenantId: options.scope.tenantId,
      projectId: options.scope.projectId,
    });
  };

  const beforeToolCall = async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const decision = evaluateToolPolicy({
      toolName: context.toolCall.name,
      status: await options.getWorkStatus(),
      scope: options.scope,
    });
    if (!decision.allowed) {
      await audit({ toolName: context.toolCall.name, phase: "policy_blocked", code: decision.code });
      return { block: true, reason: `${decision.code}: ${decision.reason}`, terminate: decision.severity === "critical" };
    }
    await audit({ toolName: context.toolCall.name, phase: "policy_allowed" });
    return undefined;
  };

  const afterToolCall = async (context: AfterToolCallContext): Promise<AfterToolCallResult> => {
    await audit({
      toolName: context.toolCall.name,
      phase: context.isError ? "execution_failed" : "execution_completed",
    });
    return {
      content: redactContent(context.result.content),
      details: redactSensitive(context.result.details),
    };
  };

  return createBaseAgent({
    model: options.model,
    streamFn: options.streamFn,
    systemPrompt: options.taskContext === undefined
      ? ADVERTISING_AGENT_SYSTEM_PROMPT
      : `${ADVERTISING_AGENT_SYSTEM_PROMPT}\n\n当前只读任务上下文（由服务端解析，不是授权凭证）：\n${JSON.stringify(options.taskContext)}`,
    tools,
    ...(options.messages === undefined ? {} : { messages: options.messages }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.getApiKey === undefined ? {} : { getApiKey: options.getApiKey }),
    beforeToolCall,
    afterToolCall,
  });
}
