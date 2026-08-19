import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

import {
  createBaseAgent,
  createLocalModelRuntime,
  LocalAgentRuntime,
  LocalSessionStore,
  loadLocalAgentConfig,
  toPublicTranscript,
  toTimelinePayload,
  toPublicLocalAgentConfig,
  type LocalAgentConfig,
  type LocalModelRuntime,
} from "../src/index.ts";
import { MOCK_TASK_CONTEXT } from "./task-context-fixture.ts";

test("timeline payloads are redacted and bounded before leaving the runtime", () => {
  assert.deepEqual(
    toTimelinePayload({ apiKey: "credential-placeholder", nested: { safe: "ok" } }),
    { apiKey: "[REDACTED]", nested: { safe: "ok" } },
  );
  const bounded = toTimelinePayload({ value: "x".repeat(7_000) });
  assert.equal(typeof bounded, "string");
  assert.ok((bounded as string).length <= 6_001);
});

test("public transcripts remove hidden reasoning and sanitize tool payloads", () => {
  const transcript = toPublicTranscript([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden reasoning", thinkingSignature: "reasoning_content" },
        { type: "text", text: "可见回答" },
        { type: "toolCall", id: "call_1", name: "safe_tool", arguments: { apiKey: "credential-placeholder" } },
      ],
    },
  ] as unknown as AgentMessage[]);
  const serialized = JSON.stringify(transcript);
  assert.doesNotMatch(serialized, /hidden reasoning/u);
  assert.doesNotMatch(serialized, /credential-placeholder/u);
  assert.match(serialized, /可见回答/u);
  assert.match(serialized, /\[REDACTED\]/u);
});

test("local configuration defaults the main Agent to DeepSeek without exposing credentials", () => {
  const config = loadLocalAgentConfig({});
  assert.equal(config.provider, "deepseek");
  assert.equal(config.modelId, "deepseek-v4-flash");
  assert.equal(config.baseUrl, "https://api.deepseek.com");
  assert.equal(config.apiKey, undefined);
  assert.equal(toPublicLocalAgentConfig(config).credentialsConfigured, false);
});

test("credential-free mock mode remains available explicitly for tests and local development", () => {
  const config = loadLocalAgentConfig({ AGENT_PROVIDER: "mock" });
  assert.equal(config.provider, "mock");
  assert.equal(config.modelId, "mock-local");
  assert.equal(toPublicLocalAgentConfig(config).credentialsConfigured, true);
});

test("real providers start for diagnostics but reject prompts without a server-side API key", async () => {
  for (const provider of ["deepseek", "volcengine"] as const) {
    const runtime = new LocalAgentRuntime(
      loadLocalAgentConfig({
        AGENT_PROVIDER: provider,
        LOCAL_AGENT_PERSIST_SESSIONS: "false",
      }),
    );
    const session = await runtime.createSession(`missing_key_${provider}`);
    await assert.rejects(
      () => runtime.prompt(session.id, "不会发起外部调用"),
      /服务端尚未设置/u,
    );
  }
});

test("public configuration never exposes provider credentials", () => {
  const config = loadLocalAgentConfig({
    AGENT_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "sensitive-test-value",
  });
  const publicConfig = toPublicLocalAgentConfig(config);
  assert.equal(publicConfig.credentialsConfigured, true);
  assert.equal("apiKey" in publicConfig, false);
  assert.doesNotMatch(JSON.stringify(publicConfig), /sensitive-test-value/u);
});

test("mock runtime persists and restores a multi-turn Pi transcript", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-local-agent-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const config: LocalAgentConfig = {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: true,
    dataDirectory: directory,
  };
  const firstRuntime = new LocalAgentRuntime(config);
  await firstRuntime.createSession("session_persistence_test");
  const first = await firstRuntime.prompt("session_persistence_test", "第一轮");
  assert.match(first.assistantText, /第一轮/u);
  assert.equal(first.session.messageCount, 2);
  assert.ok(first.events.some((event) => event.type === "run_started"));
  assert.ok(first.events.some((event) => event.type === "text_delta"));
  assert.deepEqual(first.events.map((event) => event.sequence), first.events.map((_event, index) => index + 1));
  assert.equal(first.lastEventId, first.events.at(-1)?.eventId);

  const secondRuntime = new LocalAgentRuntime(config);
  const restored = await secondRuntime.getSession("session_persistence_test");
  assert.equal(restored?.messageCount, 2);
  const second = await secondRuntime.prompt("session_persistence_test", "第二轮");
  assert.equal(second.session.messageCount, 4);

  const reset = await secondRuntime.resetSession("session_persistence_test");
  assert.equal(reset.messageCount, 0);
});

test("task session listing restores persisted sessions in a stable task-scoped order", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-session-list-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const config: LocalAgentConfig = {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: true,
    dataDirectory: directory,
  };
  const firstRuntime = new LocalAgentRuntime(config);
  await firstRuntime.createSession("session_task_list_b", { taskContext: MOCK_TASK_CONTEXT });
  await firstRuntime.createSession("session_task_list_a", { taskContext: MOCK_TASK_CONTEXT });
  await firstRuntime.createSession("session_unbound_list");

  const restoredRuntime = new LocalAgentRuntime(config);
  const sessions = await restoredRuntime.listSessions(MOCK_TASK_CONTEXT.videoTask.id);
  assert.deepEqual(sessions.map((session) => session.id), ["session_task_list_a", "session_task_list_b"]);
  assert.ok(sessions.every((session) => session.videoTaskId === MOCK_TASK_CONTEXT.videoTask.id));
  assert.equal((await restoredRuntime.listSessions()).length, 3);
});

test("prompt runs are idempotent by client request ID and retain replayable events", async () => {
  const config: LocalAgentConfig = {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: false,
    dataDirectory: ".data/test-sessions",
  };
  const baseRuntime = createLocalModelRuntime(config);
  let modelCalls = 0;
  const runtime = new LocalAgentRuntime(config, {
    ...baseRuntime,
    streamFn: (...args) => {
      modelCalls += 1;
      return baseRuntime.streamFn(...args);
    },
  });
  await runtime.createSession("session_idempotent_run");

  const first = await runtime.startPromptRun("session_idempotent_run", "只执行一次", "request_same_message");
  const duplicate = await runtime.startPromptRun("session_idempotent_run", "只执行一次", "request_same_message");
  assert.equal(duplicate.runId, first.runId);
  const initialObservation = runtime.observePromptRun("session_idempotent_run", first.runId);
  const initialEvents: Array<{ eventId: string; sequence: number }> = [];
  const unsubscribe = initialObservation.activate((event) => initialEvents.push(event));
  const outcome = await initialObservation.outcome;
  unsubscribe();
  assert.equal(outcome.status, "completed");
  assert.equal(modelCalls, 1);
  assert.ok(initialEvents.length > 4);

  const cursor = initialEvents[1]?.eventId;
  assert.ok(cursor);
  const replayObservation = runtime.observePromptRun("session_idempotent_run", first.runId, cursor);
  const replayed: Array<{ eventId: string; sequence: number }> = [];
  replayObservation.activate((event) => replayed.push(event))();
  await replayObservation.outcome;
  assert.deepEqual(
    replayed.map((event) => event.sequence),
    initialEvents.slice(2).map((event) => event.sequence),
  );
  assert.equal(new Set(replayed.map((event) => event.eventId)).size, replayed.length);

  await assert.rejects(
    () => runtime.startPromptRun("session_idempotent_run", "另一条消息", "request_same_message"),
    /already bound to a different message/u,
  );
  assert.throws(
    () => runtime.observePromptRun("session_idempotent_run", first.runId, "event_unknown_cursor"),
    /cursor is not available/u,
  );
  assert.equal(modelCalls, 1);
});

test("detaching a run observer does not abort the run", async () => {
  const config: LocalAgentConfig = {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: false,
    dataDirectory: ".data/test-sessions",
  };
  const runtime = new LocalAgentRuntime(config);
  await runtime.createSession("session_detach_run");
  const run = await runtime.startPromptRun("session_detach_run", "断开订阅", "request_detach");
  const observation = runtime.observePromptRun("session_detach_run", run.runId);
  const unsubscribe = observation.activate(() => {});
  unsubscribe();
  const outcome = await observation.outcome;
  assert.equal(outcome.status, "completed");
  if (outcome.status === "completed") assert.notEqual(outcome.result.stopReason, "aborted");

  const replay = runtime.observePromptRun("session_detach_run", run.runId);
  const events: Array<{ sequence: number }> = [];
  replay.activate((event) => events.push(event))();
  assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index + 1));
});

test("task-bound sessions restore the same task context through the injected Agent factory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-bound-agent-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const config: LocalAgentConfig = {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: true,
    dataDirectory: directory,
  };
  const assembledTaskIds: string[] = [];
  const createRuntime = () =>
    new LocalAgentRuntime(
      config,
      createLocalModelRuntime(config),
      new LocalSessionStore(directory, true),
      (factoryContext) => {
        assembledTaskIds.push(factoryContext.taskContext.videoTask.id);
        return createBaseAgent({
          model: factoryContext.model,
          streamFn: factoryContext.streamFn,
          systemPrompt: "Bound test Agent",
          messages: factoryContext.messages,
          sessionId: factoryContext.sessionId,
        });
      },
    );

  const firstRuntime = createRuntime();
  const created = await firstRuntime.createSession("session_task_restore", { taskContext: MOCK_TASK_CONTEXT });
  assert.equal(created.videoTaskId, MOCK_TASK_CONTEXT.videoTask.id);
  await firstRuntime.prompt(created.id, "保存绑定");

  const restored = await createRuntime().getSession(created.id);
  assert.equal(restored?.videoTaskId, MOCK_TASK_CONTEXT.videoTask.id);
  assert.deepEqual(restored?.taskContext, MOCK_TASK_CONTEXT);
  assert.equal(restored?.messageCount, 2);
  assert.deepEqual(assembledTaskIds, [MOCK_TASK_CONTEXT.videoTask.id, MOCK_TASK_CONTEXT.videoTask.id]);
});

test("legacy work-bound sessions resolve once and persist back as task-context v2", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-legacy-agent-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const config: LocalAgentConfig = {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: true,
    dataDirectory: directory,
  };
  await writeFile(join(directory, "session_legacy.json"), JSON.stringify({
    schemaVersion: 1,
    id: "session_legacy",
    workId: MOCK_TASK_CONTEXT.videoTask.id,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    provider: "mock",
    modelId: "mock-local",
    messages: [],
  }));
  const resolvedLegacyIds: string[] = [];
  const runtime = new LocalAgentRuntime(
    config,
    createLocalModelRuntime(config),
    new LocalSessionStore(directory, true),
    (factoryContext) => createBaseAgent({
      model: factoryContext.model,
      streamFn: factoryContext.streamFn,
      systemPrompt: "Legacy migration test Agent",
      messages: factoryContext.messages,
      sessionId: factoryContext.sessionId,
    }),
    (workId) => {
      resolvedLegacyIds.push(workId);
      return MOCK_TASK_CONTEXT;
    },
  );

  const restored = await runtime.getSession("session_legacy");
  assert.equal(restored?.videoTaskId, MOCK_TASK_CONTEXT.videoTask.id);
  assert.deepEqual(resolvedLegacyIds, [MOCK_TASK_CONTEXT.videoTask.id]);
  await runtime.resetSession("session_legacy");
  const persisted = JSON.parse(await readFile(join(directory, "session_legacy.json"), "utf8")) as {
    schemaVersion: number;
    taskContext?: unknown;
    workId?: string;
  };
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(persisted.taskContext, MOCK_TASK_CONTEXT);
  assert.equal(persisted.workId, undefined);
});

test("session identifiers cannot escape the configured directory", async () => {
  const config: LocalAgentConfig = {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: false,
    dataDirectory: ".data/test-sessions",
  };
  const runtime = new LocalAgentRuntime(config);
  await assert.rejects(() => runtime.createSession("../outside"), /Session ID/u);
});

test("runtime cancellation aborts the active Pi model request", async () => {
  const config: LocalAgentConfig = {
    provider: "mock",
    modelId: "slow-mock",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: false,
    dataDirectory: ".data/test-sessions",
  };
  const model = {
    id: "slow-mock",
    name: "Slow mock",
    api: "mock-local",
    provider: "mock",
    baseUrl: "local://mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  } as Model<Api>;
  const streamFn: StreamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "mock-local",
      provider: "mock",
      model: "slow-mock",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial });
    options?.signal?.addEventListener(
      "abort",
      () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...partial, stopReason: "aborted", errorMessage: "Request aborted." },
        });
      },
      { once: true },
    );
    return stream;
  };
  const modelRuntime: LocalModelRuntime = { model, streamFn };
  const runtime = new LocalAgentRuntime(config, modelRuntime);
  await runtime.createSession("session_cancel_test");
  const run = await runtime.startPromptRun("session_cancel_test", "等待取消", "request_cancel_test");
  const observation = runtime.observePromptRun("session_cancel_test", run.runId);
  const events: Array<{ type: string; stopReason?: string }> = [];
  const unsubscribe = observation.activate((event) => events.push(event));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await runtime.abortPromptRun("session_cancel_test", run.runId), true);
  assert.equal(await runtime.abortPromptRun("session_cancel_test", run.runId), true);
  const outcome = await observation.outcome;
  unsubscribe();
  assert.equal(outcome.status, "completed");
  if (outcome.status === "completed") assert.equal(outcome.result.stopReason, "aborted");
  assert.equal(events.filter((event) => event.type === "run_completed").length, 1);
  assert.equal(events.find((event) => event.type === "run_completed")?.stopReason, "aborted");
});
