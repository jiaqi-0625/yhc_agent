import { randomUUID } from "node:crypto";

import { type Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { AgentStreamEvent, TaskContext } from "@firefly/schemas";

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
  videoTaskId?: string;
  taskContext?: TaskContext;
  createdAt: string;
  updatedAt: string;
  provider: string;
  modelId: string;
  messageCount: number;
  isRunning: boolean;
  domainToolsLoaded: boolean;
  toolNames: string[];
}

export interface LocalTaskAgentFactoryContext {
  model: Model<Api>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  messages: readonly AgentMessage[];
  sessionId: string;
  taskContext: TaskContext;
}

export type LocalTaskAgentFactory = (context: LocalTaskAgentFactoryContext) => Agent;
export type LegacyTaskContextResolver = (workId: string) => TaskContext | Promise<TaskContext>;

export type LocalRuntimeEvent = AgentStreamEvent;

export interface LocalPromptResult {
  session: LocalSessionSummary;
  assistantText: string;
  usage?: Usage;
  stopReason?: AssistantMessage["stopReason"];
  runId: string;
  lastEventId: string;
  events: LocalRuntimeEvent[];
}

interface ActiveLocalSession {
  agent: Agent;
  taskContext?: TaskContext;
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

interface StreamEventContext {
  base: () => Pick<AgentStreamEvent, "schemaVersion" | "eventId" | "sequence" | "sessionId" | "runId" | "videoTaskId" | "occurredAt">;
  messageId: string;
}

function normalizeEvent(
  event: AgentEvent,
  toolStartedAt: Map<string, number>,
  context: StreamEventContext,
): LocalRuntimeEvent | undefined {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return {
      ...context.base(),
      type: "text_delta",
      messageId: context.messageId,
      delta: event.assistantMessageEvent.delta,
    };
  }
  if (event.type === "tool_execution_start") {
    toolStartedAt.set(event.toolCallId, Date.now());
    return {
      ...context.base(),
      type: "tool_status",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      status: "running",
      input: toTimelinePayload(event.args),
    };
  }
  if (event.type === "tool_execution_end") {
    const startedAt = toolStartedAt.get(event.toolCallId);
    toolStartedAt.delete(event.toolCallId);
    const output = toTimelinePayload(event.result);
    const blocked = event.isError && /AIC-(?:AUTH|WORKFLOW)-/u.test(JSON.stringify(output));
    return {
      ...context.base(),
      type: "tool_status",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      status: event.isError ? (blocked ? "blocked" : "failed") : "succeeded",
      output,
      ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
    };
  }
  return undefined;
}

export class LocalAgentRuntime {
  readonly #sessions = new Map<string, ActiveLocalSession>();
  readonly #modelRuntime: LocalModelRuntime;
  readonly #store: LocalSessionStore;
  readonly #taskAgentFactory: LocalTaskAgentFactory | undefined;
  readonly #legacyTaskContextResolver: LegacyTaskContextResolver | undefined;

  constructor(
    readonly config: LocalAgentConfig = loadLocalAgentConfig(),
    modelRuntime: LocalModelRuntime = createLocalModelRuntime(config),
    store: LocalSessionStore = new LocalSessionStore(config.dataDirectory, config.persistSessions),
    taskAgentFactory?: LocalTaskAgentFactory,
    legacyTaskContextResolver?: LegacyTaskContextResolver,
  ) {
    this.#modelRuntime = modelRuntime;
    this.#store = store;
    this.#taskAgentFactory = taskAgentFactory;
    this.#legacyTaskContextResolver = legacyTaskContextResolver;
  }

  publicConfig(): PublicLocalAgentConfig {
    return toPublicLocalAgentConfig(this.config);
  }

  get domainToolsAvailable(): boolean {
    return this.#taskAgentFactory !== undefined;
  }

  #createAgent(messages: readonly AgentMessage[], sessionId: string, taskContext?: TaskContext): Agent {
    if (taskContext !== undefined && this.#taskAgentFactory !== undefined) {
      const agent = this.#taskAgentFactory({
        model: this.#modelRuntime.model,
        streamFn: this.#modelRuntime.streamFn,
        messages,
        sessionId,
        taskContext,
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
    options: { taskContext?: TaskContext } = {},
  ): Promise<LocalSessionSummary> {
    assertLocalSessionId(sessionId);
    if (this.#sessions.has(sessionId) || (await this.#store.load(sessionId))) {
      throw new Error(`Session '${sessionId}' already exists.`);
    }
    const now = new Date().toISOString();
    const active = {
      agent: this.#createAgent([], sessionId, options.taskContext),
      ...(options.taskContext === undefined ? {} : { taskContext: structuredClone(options.taskContext) }),
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
    const taskContext = persisted.schemaVersion === 2
      ? persisted.taskContext
      : persisted.workId === undefined
        ? undefined
        : await this.#resolveLegacyTaskContext(persisted.workId);
    const active = {
      agent: this.#createAgent(persisted.messages, sessionId, taskContext),
      ...(taskContext === undefined ? {} : { taskContext: structuredClone(taskContext) }),
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
    };
    this.#sessions.set(sessionId, active);
    return active;
  }

  async #resolveLegacyTaskContext(workId: string): Promise<TaskContext> {
    if (!this.#legacyTaskContextResolver) {
      throw new Error(`Legacy session work '${workId}' cannot be restored without a task context resolver.`);
    }
    return this.#legacyTaskContextResolver(workId);
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
    const runId = `run_${randomUUID()}`;
    const messageId = `message_${randomUUID()}`;
    let sequence = 0;
    const base = () => {
      sequence += 1;
      return {
        schemaVersion: 1 as const,
        eventId: `event_${runId}_${sequence}`,
        sequence,
        sessionId,
        runId,
        ...(active.taskContext === undefined ? {} : { videoTaskId: active.taskContext.videoTask.id }),
        occurredAt: new Date().toISOString(),
      };
    };
    const emit = (event: LocalRuntimeEvent) => {
      events.push(event);
      onEvent?.(event);
    };
    emit({ ...base(), type: "run_started" });
    emit({
      ...base(),
      type: "thinking_status",
      status: "started",
      summary: "正在分析当前任务上下文并规划受控操作。",
    });
    emit({ ...base(), type: "message_started", messageId, role: "assistant" });
    const unsubscribe = active.agent.subscribe((event) => {
      const normalized = normalizeEvent(event, toolStartedAt, { base, messageId });
      if (normalized) emit(normalized);
    });
    try {
      await active.agent.prompt(message);
    } finally {
      unsubscribe();
    }

    active.updatedAt = new Date().toISOString();
    await this.#persist(sessionId, active);
    const response = lastAssistant(active.agent.state.messages);
    const responseText = assistantText(response);
    emit({
      ...base(),
      type: "thinking_status",
      status: "completed",
      summary: "已完成上下文分析、工具选择与响应生成。",
    });
    emit({ ...base(), type: "message_completed", messageId, text: responseText });
    emit({
      ...base(),
      type: "run_completed",
      ...(response?.stopReason === undefined ? {} : { stopReason: response.stopReason }),
    });
    return {
      session: this.#summary(sessionId, active),
      assistantText: responseText,
      ...(response?.usage === undefined ? {} : { usage: response.usage }),
      ...(response?.stopReason === undefined ? {} : { stopReason: response.stopReason }),
      runId,
      lastEventId: events.at(-1)?.eventId ?? `event_${runId}_0`,
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
      ...(active.taskContext === undefined
        ? {}
        : {
            videoTaskId: active.taskContext.videoTask.id,
            taskContext: structuredClone(active.taskContext),
          }),
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
      schemaVersion: 2,
      id: sessionId,
      ...(active.taskContext === undefined ? {} : { taskContext: structuredClone(active.taskContext) }),
      createdAt: active.createdAt,
      updatedAt: active.updatedAt,
      provider: this.config.provider,
      modelId: this.config.modelId,
      messages: structuredClone(active.agent.state.messages),
    };
    await this.#store.save(record);
  }
}
