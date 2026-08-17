import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface CreateBaseAgentOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  systemPrompt: string;
  tools?: readonly AgentTool[];
  messages?: readonly AgentMessage[];
  sessionId?: string;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

export function createBaseAgent(options: CreateBaseAgentOptions): Agent {
  return new Agent({
    streamFn: options.streamFn,
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: "medium",
      tools: [...(options.tools ?? [])],
      messages: [...(options.messages ?? [])],
    },
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.getApiKey === undefined ? {} : { getApiKey: options.getApiKey }),
    ...(options.beforeToolCall === undefined ? {} : { beforeToolCall: options.beforeToolCall }),
    ...(options.afterToolCall === undefined ? {} : { afterToolCall: options.afterToolCall }),
    toolExecution: "sequential",
  });
}
