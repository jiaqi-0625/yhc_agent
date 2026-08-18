import { randomUUID } from "node:crypto";

import { type Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";

import { createBaseAgent } from "./base-agent.ts";
import { redactSensitive } from "./factory.ts";
import {
  LocalAgentCredentialsError,
  loadLocalAgentConfig,
  toPublicLocalAgentConfig,
  type LocalAgentConfig,
  type PublicLocalAgentConfig,
} from "./local-config.ts";
import { createLocalModelRuntime, type LocalModelRuntime } from "./model-runtime.ts";
import { assertLocalSessionId, LocalSessionStore, type PersistedLocalSession } from "./session-store.ts";
import { LOCAL_FRAMEWORK_SYSTEM_PROMPT } from "./system-prompt.ts";

export interface LocalSessionSummary {
  id: string;
  workId?: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  modelId: string;
  messageCount: number;
  isRunning: boolean;
  domainToolsLoaded: boolean;
  toolNames: string[];
}

export interface LocalWorkAgentFactoryContext {
  model: Model<Api>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  messages: readonly AgentMessage[];
  sessionId: string;
  workId: string;
}

export type LocalWorkAgentFactory = (context: LocalWorkAgentFactoryContext) => Agent;

export type LocalRuntimeEvent =
  | {
      type: "agent_start" | "agent_end" | "turn_start" | "turn_end" | "message_start" | "message_end";
      occurredAt: string;
    }
  | { type: "text_delta"; delta: string; occurredAt: string }
  | {
      type: "tool_start";
      toolName: string;
      toolCallId: string;
      input?: unknown;
      occurredAt: string;
    }
  | {
      type: "tool_end";
      toolName: string;
      toolCallId: string;
      output?: unknown;
      isError: boolean;
      durationMs?: number;
      occurredAt: string;
    };

export interface LocalPromptResult {
  session: LocalSessionSummary;
  assistantText: string;
  usage?: Usage;
  stopReason?: AssistantMessage["stopReason"];
  events: LocalRuntimeEvent[];
}

interface ActiveLocalSession {
  agent: Agent;
  workId?: string;
  createdAt: string;
  updatedAt: string;
}

function assistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  const message = [...messages].reverse().find((candidate) => candidate.role === "assistant");
  return message?.role === "assistant" ? message : undefined;
}

const maximumTimelinePayloadCharacters = 6_000;

export function toTimelinePayload(value: unknown): unknown {
  const redacted = redactSensitive(value);
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized === undefined || serialized.length <= maximumTimelinePayloadCharacters) return redacted;
    return `${serialized.slice(0, maximumTimelinePayloadCharacters)}…`;
  } catch {
    return "[Unserializable tool payload]";
  }
}

export function toPublicTranscript(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  return messages.map((message) => {
    const redacted = redactSensitive(structuredClone(message)) as AgentMessage;
    if (redacted.role === "assistant") {
      return {
        ...redacted,
        content: redacted.content
          .filter((part) => part.type !== "thinking")
          .map((part) => part.type === "toolCall"
            ? { ...part, arguments: toTimelinePayload(part.arguments) }
            : part),
      } as AgentMessage;
    }
    if (redacted.role === "toolResult") {
      return {
        ...redacted,
        content: redacted.content.map((part) => part.type === "text"
          ? { ...part, text: String(toTimelinePayload(part.text)) }
          : part),
        details: toTimelinePayload(redacted.details),
      } as AgentMessage;
    }
    return redacted;
  });
}

function normalizeEvent(event: AgentEvent, toolStartedAt: Map<string, number>): LocalRuntimeEvent | undefined {
  const occurredAt = new Date().toISOString();
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return { type: "text_delta", delta: event.assistantMessageEvent.delta, occurredAt };
  }
  if (
    event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "turn_start" ||
    event.type === "turn_end" ||
    event.type === "message_start" ||
    event.type === "message_end"
  ) {
    return { type: event.type, occurredAt };
  }
  if (event.type === "tool_execution_start") {
    toolStartedAt.set(event.toolCallId, Date.now());
    return {
      type: "tool_start",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: toTimelinePayload(event.args),
      occurredAt,
    };
  }
  if (event.type === "tool_execution_end") {
    const startedAt = toolStartedAt.get(event.toolCallId);
    toolStartedAt.delete(event.toolCallId);
    return {
      type: "tool_end",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      output: toTimelinePayload(event.result),
      isError: event.isError,
      ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
      occurredAt,
    };
  }
  return undefined;
}

export class LocalAgentRuntime {
  readonly #sessions = new Map<string, ActiveLocalSession>();
  readonly #modelRuntime: LocalModelRuntime;
  readonly #store: LocalSessionStore;
  readonly #workAgentFactory: LocalWorkAgentFactory | undefined;

  constructor(
    readonly config: LocalAgentConfig = loadLocalAgentConfig(),
    modelRuntime: LocalModelRuntime = createLocalModelRuntime(config),
    store: LocalSessionStore = new LocalSessionStore(config.dataDirectory, config.persistSessions),
    workAgentFactory?: LocalWorkAgentFactory,
  ) {
    this.#modelRuntime = modelRuntime;
    this.#store = store;
    this.#workAgentFactory = workAgentFactory;
  }

  publicConfig(): PublicLocalAgentConfig {
    return toPublicLocalAgentConfig(this.config);
  }

  get domainToolsAvailable(): boolean {
    return this.#workAgentFactory !== undefined;
  }

  #createAgent(messages: readonly AgentMessage[], sessionId: string, workId?: string): Agent {
    if (workId !== undefined && this.#workAgentFactory !== undefined) {
      const agent = this.#workAgentFactory({
        model: this.#modelRuntime.model,
        streamFn: this.#modelRuntime.streamFn,
        messages,
        sessionId,
        workId,
        ...(this.#modelRuntime.getApiKey === undefined ? {} : { getApiKey: this.#modelRuntime.getApiKey }),
      });
      agent.state.thinkingLevel = this.config.thinkingLevel;
      return agent;
    }
    const agent = createBaseAgent({
      model: this.#modelRuntime.model,
      streamFn: this.#modelRuntime.streamFn,
      systemPrompt: LOCAL_FRAMEWORK_SYSTEM_PROMPT,
      messages,
      sessionId,
      ...(this.#modelRuntime.getApiKey === undefined ? {} : { getApiKey: this.#modelRuntime.getApiKey }),
    });
    agent.state.thinkingLevel = this.config.thinkingLevel;
    return agent;
  }

  async createSession(
    sessionId = `session_${randomUUID()}`,
    options: { workId?: string } = {},
  ): Promise<LocalSessionSummary> {
    assertLocalSessionId(sessionId);
    if (this.#sessions.has(sessionId) || (await this.#store.load(sessionId))) {
      throw new Error(`Session '${sessionId}' already exists.`);
    }
    const now = new Date().toISOString();
    const active = {
      agent: this.#createAgent([], sessionId, options.workId),
      ...(options.workId === undefined ? {} : { workId: options.workId }),
      createdAt: now,
      updatedAt: now,
    };
    this.#sessions.set(sessionId, active);
    await this.#persist(sessionId, active);
    return this.#summary(sessionId, active);
  }

  async #getActive(sessionId: string): Promise<ActiveLocalSession | undefined> {
    assertLocalSessionId(sessionId);
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const persisted = await this.#store.load(sessionId);
    if (!persisted) return undefined;
    const active = {
      agent: this.#createAgent(persisted.messages, sessionId, persisted.workId),
      ...(persisted.workId === undefined ? {} : { workId: persisted.workId }),
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
    };
    this.#sessions.set(sessionId, active);
    return active;
  }

  async getSession(sessionId: string): Promise<LocalSessionSummary | undefined> {
    const active = await this.#getActive(sessionId);
    return active ? this.#summary(sessionId, active) : undefined;
  }

  async getTranscript(sessionId: string): Promise<readonly AgentMessage[] | undefined> {
    const active = await this.#getActive(sessionId);
    return active ? toPublicTranscript(active.agent.state.messages) : undefined;
  }

  async prompt(
    sessionId: string,
    input: string,
    onEvent?: (event: LocalRuntimeEvent) => void,
  ): Promise<LocalPromptResult> {
    const message = input.trim();
    if (!message) throw new Error("Prompt message must not be empty.");
    const active = await this.#getActive(sessionId);
    if (!active) throw new Error(`Session '${sessionId}' was not found.`);
    if (active.agent.state.isStreaming) throw new Error(`Session '${sessionId}' is already running.`);
    if (this.config.provider !== "mock" && this.config.apiKey === undefined) {
      throw new LocalAgentCredentialsError(this.config.provider);
    }

    const events: LocalRuntimeEvent[] = [];
    const toolStartedAt = new Map<string, number>();
    const unsubscribe = active.agent.subscribe((event) => {
      const normalized = normalizeEvent(event, toolStartedAt);
      if (normalized) {
        events.push(normalized);
        onEvent?.(normalized);
      }
    });
    try {
      await active.agent.prompt(message);
    } finally {
      unsubscribe();
    }

    active.updatedAt = new Date().toISOString();
    await this.#persist(sessionId, active);
    const response = lastAssistant(active.agent.state.messages);
    return {
      session: this.#summary(sessionId, active),
      assistantText: assistantText(response),
      ...(response?.usage === undefined ? {} : { usage: response.usage }),
      ...(response?.stopReason === undefined ? {} : { stopReason: response.stopReason }),
      events,
    };
  }

  async resetSession(sessionId: string): Promise<LocalSessionSummary> {
    const active = await this.#getActive(sessionId);
    if (!active) throw new Error(`Session '${sessionId}' was not found.`);
    if (active.agent.state.isStreaming) active.agent.abort();
    await active.agent.waitForIdle();
    active.agent.reset();
    active.updatedAt = new Date().toISOString();
    await this.#persist(sessionId, active);
    return this.#summary(sessionId, active);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const active = this.#sessions.get(sessionId);
    if (active?.agent.state.isStreaming) {
      active.agent.abort();
      await active.agent.waitForIdle();
    }
    this.#sessions.delete(sessionId);
    await this.#store.delete(sessionId);
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const active = await this.#getActive(sessionId);
    if (!active?.agent.state.isStreaming) return false;
    active.agent.abort();
    return true;
  }

  #summary(sessionId: string, active: ActiveLocalSession): LocalSessionSummary {
    return {
      id: sessionId,
      ...(active.workId === undefined ? {} : { workId: active.workId }),
      createdAt: active.createdAt,
      updatedAt: active.updatedAt,
      provider: this.config.provider,
      modelId: this.config.modelId,
      messageCount: active.agent.state.messages.length,
      isRunning: active.agent.state.isStreaming,
      domainToolsLoaded: active.agent.state.tools.length > 0,
      toolNames: active.agent.state.tools.map((tool) => tool.name),
    };
  }

  async #persist(sessionId: string, active: ActiveLocalSession): Promise<void> {
    const record: PersistedLocalSession = {
      schemaVersion: 1,
      id: sessionId,
      ...(active.workId === undefined ? {} : { workId: active.workId }),
      createdAt: active.createdAt,
      updatedAt: active.updatedAt,
      provider: this.config.provider,
      modelId: this.config.modelId,
      messages: structuredClone(active.agent.state.messages),
    };
    await this.#store.save(record);
  }
}
