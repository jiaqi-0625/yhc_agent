import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import { evaluateToolPolicy, type SessionScope } from "@firefly/domain";
import type { WorkStatus } from "@firefly/schemas";
import {
  createStrategyTools,
  createVehicleTools,
  type InMemoryVehicleService,
  type StrategyWorkflowPort,
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
  scope: SessionScope;
  getWorkStatus: () => WorkStatus;
  vehicleService: InMemoryVehicleService;
  strategyService?: StrategyWorkflowPort;
  auditSink?: AgentAuditSink;
}

const sensitiveKeyPattern = /(?:api[-_]?key|authorization|cookie|password|secret|token)/iu;
const sensitiveTextPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
];

export function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    return sensitiveTextPatterns.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
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
  const vehicleTools = createVehicleTools(options.vehicleService, {
    actorId: options.scope.actorId,
    tenantId: options.scope.tenantId,
    projectId: options.scope.projectId,
    allowedBrandIds: options.scope.allowedBrandIds,
  });
  const tools = [
    ...vehicleTools,
    ...(options.strategyService === undefined ? [] : createStrategyTools(options.strategyService)),
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
      status: options.getWorkStatus(),
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
    systemPrompt: ADVERTISING_AGENT_SYSTEM_PROMPT,
    tools,
    beforeToolCall,
    afterToolCall,
  });
}
