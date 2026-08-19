import { randomUUID } from "node:crypto";

import { type Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { AgentStreamEventSchema, type AgentStreamEvent, type TaskContext } from "@firefly/schemas";
import { Value } from "typebox/value";

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
import {
  assertLocalSessionId,
  LocalSessionStore,
  type AgentSessionScope,
  type PersistedLocalSession,
} from "./session-store.ts";
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
  sessionScope: AgentSessionScope;
  taskContext: TaskContext;
}

export type LocalTaskAgentFactory = (context: LocalTaskAgentFactoryContext) => Agent;
export type LegacyTaskContextResolver = (workId: string) => TaskContext | Promise<TaskContext>;
export type LegacySessionScopeResolver = (
  taskContext: TaskContext,
) => AgentSessionScope | Promise<AgentSessionScope>;

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

export type LocalPromptRunStatus = "running" | "completed" | "failed";

export interface LocalPromptRunSummary {
  requestId: string;
  runId: string;
  sessionId: string;
  status: LocalPromptRunStatus;
  createdAt: string;
  completedAt?: string;
  lastEventId?: string;
}

export interface LocalPromptRunFailure {
  code: string;
  message: string;
  retryable: boolean;
  charged: boolean;
}

export type LocalPromptRunOutcome =
  | { status: "completed"; result: LocalPromptResult }
  | { status: "failed"; error: LocalPromptRunFailure };

export interface LocalPromptRunObservation {
  run: LocalPromptRunSummary;
  outcome: Promise<LocalPromptRunOutcome>;
  activate: (onEvent: (event: LocalRuntimeEvent) => void) => () => void;
  release: () => void;
}

export class LocalAgentRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "LocalAgentRunError";
  }
}

interface ActiveLocalSession {
  agent: Agent;
  taskContext?: TaskContext;
  scope?: AgentSessionScope;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
}

interface LocalPromptRunRecord {
  requestId: string;
  runId: string;
  sessionId: string;
  message: string;
  status: LocalPromptRunStatus;
  createdAt: string;
  completedAt?: string;
  events: LocalRuntimeEvent[];
  subscribers: Set<(event: LocalRuntimeEvent) => void>;
  outcome: Promise<LocalPromptRunOutcome>;
  resolveOutcome: (outcome: LocalPromptRunOutcome) => void;
  cancelRequested: boolean;
}

const maximumRetainedRunsPerSession = 20;
const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

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
  isCancelling: () => boolean,
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
      status: event.isError ? (isCancelling() ? "cancelled" : blocked ? "blocked" : "failed") : "succeeded",
      output,
      ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
    };
  }
  return undefined;
}

export class LocalAgentRuntime {
  readonly #sessions = new Map<string, ActiveLocalSession>();
  readonly #runs = new Map<string, LocalPromptRunRecord>();
  readonly #runIdsByRequest = new Map<string, string>();
  readonly #expiredRequestKeys = new Set<string>();
  readonly #modelRuntime: LocalModelRuntime;
  readonly #store: LocalSessionStore;
  readonly #taskAgentFactory: LocalTaskAgentFactory | undefined;
  readonly #legacyTaskContextResolver: LegacyTaskContextResolver | undefined;
  readonly #legacySessionScopeResolver: LegacySessionScopeResolver | undefined;

  constructor(
    readonly config: LocalAgentConfig = loadLocalAgentConfig(),
    modelRuntime: LocalModelRuntime = createLocalModelRuntime(config),
    store: LocalSessionStore = new LocalSessionStore(config.dataDirectory, config.persistSessions),
    taskAgentFactory?: LocalTaskAgentFactory,
    legacyTaskContextResolver?: LegacyTaskContextResolver,
    legacySessionScopeResolver?: LegacySessionScopeResolver,
  ) {
    this.#modelRuntime = modelRuntime;
    this.#store = store;
    this.#taskAgentFactory = taskAgentFactory;
    this.#legacyTaskContextResolver = legacyTaskContextResolver;
    this.#legacySessionScopeResolver = legacySessionScopeResolver;
  }

  publicConfig(): PublicLocalAgentConfig {
    return toPublicLocalAgentConfig(this.config);
  }

  get domainToolsAvailable(): boolean {
    return this.#taskAgentFactory !== undefined;
  }

  #requestKey(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`;
  }

  #assertRequestId(requestId: string): void {
    if (!requestIdPattern.test(requestId)) {
      throw new LocalAgentRunError(
        "AIC-AGENT-RUN_REQUEST_INVALID",
        "Run request ID must contain only letters, numbers, underscores, or hyphens.",
        400,
      );
    }
  }

  #runSummary(record: LocalPromptRunRecord): LocalPromptRunSummary {
    const lastEventId = record.events.at(-1)?.eventId;
    return {
      requestId: record.requestId,
      runId: record.runId,
      sessionId: record.sessionId,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(lastEventId === undefined ? {} : { lastEventId }),
    };
  }

  #appendRunEvent(record: LocalPromptRunRecord, event: LocalRuntimeEvent): void {
    if (!Value.Check(AgentStreamEventSchema, event)) {
      throw new Error(`Agent run '${record.runId}' produced an invalid stream event.`);
    }
    const previous = record.events.at(-1);
    if (event.runId !== record.runId || event.sessionId !== record.sessionId) {
      throw new Error(`Agent run '${record.runId}' produced an event for another run or session.`);
    }
    if (event.sequence !== (previous?.sequence ?? 0) + 1) {
      throw new Error(`Agent run '${record.runId}' produced an out-of-order event.`);
    }
    if (record.events.some((candidate) => candidate.eventId === event.eventId)) {
      throw new Error(`Agent run '${record.runId}' produced a duplicate event ID.`);
    }
    record.events.push(event);
    for (const subscriber of record.subscribers) {
      try {
        subscriber(event);
      } catch {
        record.subscribers.delete(subscriber);
      }
    }
  }

  #pruneCompletedRuns(sessionId: string): void {
    const completed = [...this.#runs.values()]
      .filter((record) => record.sessionId === sessionId && record.status !== "running")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (completed.length > maximumRetainedRunsPerSession) {
      const record = completed.shift();
      if (!record) break;
      this.#runs.delete(record.runId);
      const requestKey = this.#requestKey(record.sessionId, record.requestId);
      this.#runIdsByRequest.delete(requestKey);
      this.#expiredRequestKeys.add(requestKey);
    }
  }

  #removeSessionRuns(sessionId: string): void {
    for (const [runId, record] of this.#runs) {
      if (record.sessionId !== sessionId) continue;
      this.#runs.delete(runId);
      this.#runIdsByRequest.delete(this.#requestKey(sessionId, record.requestId));
    }
    for (const requestKey of this.#expiredRequestKeys) {
      if (requestKey.startsWith(`${sessionId}:`)) this.#expiredRequestKeys.delete(requestKey);
    }
  }

  #createAgent(
    messages: readonly AgentMessage[],
    sessionId: string,
    taskContext?: TaskContext,
    sessionScope?: AgentSessionScope,
  ): Agent {
    if (taskContext !== undefined && this.#taskAgentFactory !== undefined) {
      if (sessionScope === undefined) throw new Error("Task-bound Agent sessions require a server-resolved scope.");
      const agent = this.#taskAgentFactory({
        model: this.#modelRuntime.model,
        streamFn: this.#modelRuntime.streamFn,
        messages,
        sessionId,
        sessionScope: structuredClone(sessionScope),
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
    options: { taskContext?: TaskContext; scope?: AgentSessionScope } = {},
  ): Promise<LocalSessionSummary> {
    assertLocalSessionId(sessionId);
    this.#assertTaskBinding(options.taskContext, options.scope);
    if (this.#sessions.has(sessionId) || (await this.#store.load(sessionId))) {
      throw new Error(`Session '${sessionId}' already exists.`);
    }
    const now = new Date().toISOString();
    const active = {
      agent: this.#createAgent([], sessionId, options.taskContext, options.scope),
      ...(options.taskContext === undefined ? {} : { taskContext: structuredClone(options.taskContext) }),
      ...(options.scope === undefined ? {} : { scope: structuredClone(options.scope) }),
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
    const taskContext = persisted.schemaVersion === 2 || persisted.schemaVersion === 3
      ? persisted.taskContext
      : persisted.workId === undefined
        ? undefined
        : await this.#resolveLegacyTaskContext(persisted.workId);
    const scope = persisted.schemaVersion === 3
      ? persisted.scope
      : taskContext === undefined
        ? undefined
        : await this.#resolveLegacySessionScope(taskContext);
    this.#assertTaskBinding(taskContext, scope);
    const active = {
      agent: this.#createAgent(persisted.messages, sessionId, taskContext, scope),
      ...(taskContext === undefined ? {} : { taskContext: structuredClone(taskContext) }),
      ...(scope === undefined ? {} : { scope: structuredClone(scope) }),
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

  async #resolveLegacySessionScope(taskContext: TaskContext): Promise<AgentSessionScope> {
    if (!this.#legacySessionScopeResolver) {
      throw new Error(
        `Legacy task session '${taskContext.videoTask.id}' cannot be restored without a session scope resolver.`,
      );
    }
    return this.#legacySessionScopeResolver(taskContext);
  }

  #assertTaskBinding(taskContext?: TaskContext, scope?: AgentSessionScope): void {
    if (taskContext === undefined && scope === undefined) return;
    if (
      taskContext === undefined ||
      scope === undefined ||
      !scope.actorId ||
      !scope.tenantId ||
      scope.projectId !== taskContext.batchProject.id ||
      scope.videoTaskId !== taskContext.videoTask.id
    ) {
      throw new Error("Agent session task context and authenticated scope must match.");
    }
  }

  #scopeMatches(expected: AgentSessionScope | undefined, actual: AgentSessionScope | undefined): boolean {
    if (expected === undefined || actual === undefined) return expected === actual;
    return expected.actorId === actual.actorId &&
      expected.tenantId === actual.tenantId &&
      expected.projectId === actual.projectId &&
      expected.videoTaskId === actual.videoTaskId;
  }

  async authorizeSession(sessionId: string, scope?: AgentSessionScope): Promise<void> {
    const active = await this.#getActive(sessionId);
    if (!active) throw new Error(`Session '${sessionId}' was not found.`);
    if (!this.#scopeMatches(active.scope, scope)) {
      throw new LocalAgentRunError(
        "AIC-AUTH-SESSION_SCOPE_DENIED",
        "当前认证账号与任务无权访问该 Agent 会话。",
        403,
      );
    }
  }

  async listSessions(scope?: AgentSessionScope): Promise<LocalSessionSummary[]> {
    const sessionIds = new Set(this.#sessions.keys());
    for (const persisted of await this.#store.list()) {
      if (persisted.schemaVersion === 3 && !this.#scopeMatches(persisted.scope, scope)) continue;
      const persistedVideoTaskId = persisted.schemaVersion === 2 || persisted.schemaVersion === 3
        ? persisted.taskContext?.videoTask.id
        : persisted.workId;
      if (scope !== undefined && persistedVideoTaskId !== scope.videoTaskId) continue;
      sessionIds.add(persisted.id);
    }
    const sessions: LocalSessionSummary[] = [];
    for (const sessionId of sessionIds) {
      const active = await this.#getActive(sessionId);
      if (!active) continue;
      if (!this.#scopeMatches(active.scope, scope)) continue;
      const summary = this.#summary(sessionId, active);
      sessions.push(summary);
    }
    return sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  async startPromptRun(sessionId: string, input: string, requestId: string): Promise<LocalPromptRunSummary> {
    assertLocalSessionId(sessionId);
    this.#assertRequestId(requestId);
    const message = input.trim();
    if (!message) throw new Error("Prompt message must not be empty.");
    const active = await this.#getActive(sessionId);
    if (!active) throw new Error(`Session '${sessionId}' was not found.`);

    const requestKey = this.#requestKey(sessionId, requestId);
    if (this.#expiredRequestKeys.has(requestKey)) {
      throw new LocalAgentRunError(
        "AIC-AGENT-RUN_EXPIRED",
        "This Agent run is no longer available for replay.",
        410,
      );
    }
    const existingRunId = this.#runIdsByRequest.get(requestKey);
    if (existingRunId !== undefined) {
      const existing = this.#runs.get(existingRunId);
      if (!existing) throw new Error(`Agent run '${existingRunId}' has an inconsistent journal entry.`);
      if (existing.message !== message) {
        throw new LocalAgentRunError(
          "AIC-AGENT-RUN_REQUEST_CONFLICT",
          "The run request ID is already bound to a different message.",
          409,
        );
      }
      return this.#runSummary(existing);
    }

    if (active.activeRunId !== undefined || active.agent.state.isStreaming) {
      throw new LocalAgentRunError(
        "AIC-AGENT-RUN_CONFLICT",
        `Session '${sessionId}' is already running.`,
        409,
      );
    }
    if (this.config.provider !== "mock" && this.config.apiKey === undefined) {
      throw new LocalAgentCredentialsError(this.config.provider);
    }

    const runId = `run_${randomUUID()}`;
    let resolveOutcome!: (outcome: LocalPromptRunOutcome) => void;
    const outcome = new Promise<LocalPromptRunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const record: LocalPromptRunRecord = {
      requestId,
      runId,
      sessionId,
      message,
      status: "running",
      createdAt: new Date().toISOString(),
      events: [],
      subscribers: new Set(),
      outcome,
      resolveOutcome,
      cancelRequested: false,
    };
    this.#runs.set(runId, record);
    this.#runIdsByRequest.set(requestKey, runId);
    active.activeRunId = runId;
    void this.#executePromptRun(active, record);
    return this.#runSummary(record);
  }

  observePromptRun(
    sessionId: string,
    runId: string,
    afterEventId?: string,
  ): LocalPromptRunObservation {
    assertLocalSessionId(sessionId);
    const record = this.#runs.get(runId);
    if (!record || record.sessionId !== sessionId) {
      throw new Error(`Agent run '${runId}' was not found.`);
    }
    let cursorIndex = -1;
    if (afterEventId !== undefined) {
      cursorIndex = record.events.findIndex((event) => event.eventId === afterEventId);
      if (cursorIndex < 0) {
        throw new LocalAgentRunError(
          "AIC-AGENT-REPLAY_CURSOR_INVALID",
          "The requested Agent event cursor is not available for this run.",
          409,
        );
      }
    }

    const replay = record.events.slice(cursorIndex + 1);
    const pending: LocalRuntimeEvent[] = [];
    const bufferSubscriber = (event: LocalRuntimeEvent) => pending.push(event);
    record.subscribers.add(bufferSubscriber);
    let activated = false;
    let released = false;
    let liveSubscriber: ((event: LocalRuntimeEvent) => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      record.subscribers.delete(bufferSubscriber);
      if (liveSubscriber) record.subscribers.delete(liveSubscriber);
    };
    return {
      run: this.#runSummary(record),
      outcome: record.outcome,
      activate: (onEvent) => {
        if (activated) throw new Error(`Agent run '${runId}' observation was already activated.`);
        if (released) throw new Error(`Agent run '${runId}' observation was already released.`);
        activated = true;
        record.subscribers.delete(bufferSubscriber);
        for (const event of replay) onEvent(event);
        for (const event of pending) onEvent(event);
        pending.length = 0;
        if (record.status === "running") {
          liveSubscriber = onEvent;
          record.subscribers.add(liveSubscriber);
        }
        return release;
      },
      release,
    };
  }

  async #executePromptRun(active: ActiveLocalSession, record: LocalPromptRunRecord): Promise<void> {
    const toolStartedAt = new Map<string, number>();
    const messageId = `message_${randomUUID()}`;
    let sequence = 0;
    const base = () => {
      sequence += 1;
      return {
        schemaVersion: 1 as const,
        eventId: `event_${record.runId}_${sequence}`,
        sequence,
        sessionId: record.sessionId,
        runId: record.runId,
        ...(active.taskContext === undefined ? {} : { videoTaskId: active.taskContext.videoTask.id }),
        occurredAt: new Date().toISOString(),
      };
    };
    const emit = (event: LocalRuntimeEvent) => this.#appendRunEvent(record, event);
    let unsubscribe: (() => void) | undefined;
    try {
      emit({ ...base(), type: "run_started" });
      emit({
        ...base(),
        type: "thinking_status",
        status: "started",
        summary: "正在分析当前任务上下文并规划受控操作。",
      });
      emit({ ...base(), type: "message_started", messageId, role: "assistant" });
      unsubscribe = active.agent.subscribe((event) => {
        const normalized = normalizeEvent(event, toolStartedAt, { base, messageId }, () => record.cancelRequested);
        if (normalized) emit(normalized);
      });
      await active.agent.prompt(record.message);

      active.updatedAt = new Date().toISOString();
      await this.#persist(record.sessionId, active);
      const response = lastAssistant(active.agent.state.messages);
      const responseText = assistantText(response);
      const aborted = record.cancelRequested || response?.stopReason === "aborted";
      for (const [toolCallId, startedAt] of toolStartedAt) {
        emit({
          ...base(),
          type: "tool_status",
          toolName: "interrupted_tool",
          toolCallId,
          status: aborted ? "cancelled" : "failed",
          durationMs: Date.now() - startedAt,
        });
      }
      toolStartedAt.clear();
      emit({
        ...base(),
        type: "thinking_status",
        status: "completed",
        summary: aborted ? "已取消当前处理。" : "已完成上下文分析、工具选择与响应生成。",
      });
      emit({ ...base(), type: "message_completed", messageId, text: responseText });
      emit({
        ...base(),
        type: "run_completed",
        ...(aborted ? { stopReason: "aborted" } : response?.stopReason === undefined ? {} : { stopReason: response.stopReason }),
      });
      record.status = "completed";
      record.completedAt = new Date().toISOString();
      if (active.activeRunId === record.runId) delete active.activeRunId;
      const result: LocalPromptResult = {
        session: this.#summary(record.sessionId, active),
        assistantText: responseText,
        ...(response?.usage === undefined ? {} : { usage: response.usage }),
        ...(aborted ? { stopReason: "aborted" } : response?.stopReason === undefined ? {} : { stopReason: response.stopReason }),
        runId: record.runId,
        lastEventId: record.events.at(-1)?.eventId ?? `event_${record.runId}_0`,
        events: structuredClone(record.events),
      };
      record.resolveOutcome({ status: "completed", result });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Unknown Agent run error.");
      try {
        emit({
          ...base(),
          type: "run_error",
          code: normalized instanceof LocalAgentCredentialsError ? normalized.code : "AIC-AGENT-RUN_FAILED",
          message: normalized.message,
          retryable: false,
          charged: false,
        });
      } catch {
        // Preserve the original failure if even the terminal event cannot be journaled.
      }
      active.updatedAt = new Date().toISOString();
      try {
        await this.#persist(record.sessionId, active);
      } catch {
        // The retained failure still needs to unblock observers when persistence fails.
      }
      record.status = "failed";
      record.completedAt = new Date().toISOString();
      record.resolveOutcome({
        status: "failed",
        error: {
          code: normalized instanceof LocalAgentCredentialsError ? normalized.code : "AIC-AGENT-RUN_FAILED",
          message: normalized.message,
          retryable: false,
          charged: false,
        },
      });
    } finally {
      unsubscribe?.();
      if (active.activeRunId === record.runId) delete active.activeRunId;
      this.#pruneCompletedRuns(record.sessionId);
    }
  }

  async prompt(
    sessionId: string,
    input: string,
    onEvent?: (event: LocalRuntimeEvent) => void,
  ): Promise<LocalPromptResult> {
    const run = await this.startPromptRun(sessionId, input, `request_${randomUUID()}`);
    const observation = this.observePromptRun(sessionId, run.runId);
    const unsubscribe = observation.activate((event) => onEvent?.(event));
    try {
      const outcome = await observation.outcome;
      if (outcome.status === "failed") throw new Error(outcome.error.message);
      return outcome.result;
    } finally {
      unsubscribe();
    }
  }

  async resetSession(sessionId: string): Promise<LocalSessionSummary> {
    const active = await this.#getActive(sessionId);
    if (!active) throw new Error(`Session '${sessionId}' was not found.`);
    const activeRun = active.activeRunId === undefined ? undefined : this.#runs.get(active.activeRunId);
    if (active.activeRunId !== undefined) await this.abortPromptRun(sessionId, active.activeRunId);
    else if (active.agent.state.isStreaming) active.agent.abort();
    await active.agent.waitForIdle();
    if (activeRun) await activeRun.outcome;
    active.agent.reset();
    this.#removeSessionRuns(sessionId);
    active.updatedAt = new Date().toISOString();
    await this.#persist(sessionId, active);
    return this.#summary(sessionId, active);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const active = this.#sessions.get(sessionId);
    if (active?.activeRunId !== undefined) {
      const activeRun = this.#runs.get(active.activeRunId);
      await this.abortPromptRun(sessionId, active.activeRunId);
      await active.agent.waitForIdle();
      if (activeRun) await activeRun.outcome;
    } else if (active?.agent.state.isStreaming) {
      active.agent.abort();
      await active.agent.waitForIdle();
    }
    this.#removeSessionRuns(sessionId);
    this.#sessions.delete(sessionId);
    await this.#store.delete(sessionId);
  }

  async abortPromptRun(sessionId: string, runId: string): Promise<boolean> {
    const record = this.#runs.get(runId);
    if (!record || record.sessionId !== sessionId) throw new Error(`Agent run '${runId}' was not found.`);
    if (record.cancelRequested) return true;
    if (record.status !== "running") {
      const outcome = await record.outcome;
      return outcome.status === "completed" && outcome.result.stopReason === "aborted";
    }
    const active = await this.#getActive(sessionId);
    if (!active || active.activeRunId !== runId) {
      throw new LocalAgentRunError(
        "AIC-AGENT-RUN_STATE_INVALID",
        `Agent run '${runId}' is not the active run for this session.`,
        409,
      );
    }
    record.cancelRequested = true;
    active.agent.abort();
    return true;
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const active = await this.#getActive(sessionId);
    if (!active) return false;
    if (active.activeRunId !== undefined) return this.abortPromptRun(sessionId, active.activeRunId);
    if (!active.agent.state.isStreaming) return false;
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
      isRunning: active.activeRunId !== undefined || active.agent.state.isStreaming,
      domainToolsLoaded: active.agent.state.tools.length > 0,
      toolNames: active.agent.state.tools.map((tool) => tool.name),
    };
  }

  async #persist(sessionId: string, active: ActiveLocalSession): Promise<void> {
    const record: PersistedLocalSession = {
      schemaVersion: 3,
      id: sessionId,
      ...(active.taskContext === undefined ? {} : { taskContext: structuredClone(active.taskContext) }),
      ...(active.scope === undefined ? {} : { scope: structuredClone(active.scope) }),
      createdAt: active.createdAt,
      updatedAt: active.updatedAt,
      provider: this.config.provider,
      modelId: this.config.modelId,
      messages: structuredClone(active.agent.state.messages),
    };
    await this.#store.save(record);
  }
}
