import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

import {
  createBaseAgent,
  createLocalModelRuntime,
  LocalAgentRuntime,
  LocalSessionStore,
  loadLocalAgentConfig,
  toPublicLocalAgentConfig,
  type LocalAgentConfig,
  type LocalModelRuntime,
} from "../src/index.ts";

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
  assert.ok(first.events.some((event) => event.type === "agent_start"));
  assert.ok(first.events.some((event) => event.type === "text_delta"));

  const secondRuntime = new LocalAgentRuntime(config);
  const restored = await secondRuntime.getSession("session_persistence_test");
  assert.equal(restored?.messageCount, 2);
  const second = await secondRuntime.prompt("session_persistence_test", "第二轮");
  assert.equal(second.session.messageCount, 4);

  const reset = await secondRuntime.resetSession("session_persistence_test");
  assert.equal(reset.messageCount, 0);
});

test("work-bound sessions restore the same work through the injected Agent factory", async (context) => {
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
  const assembledWorkIds: string[] = [];
  const createRuntime = () =>
    new LocalAgentRuntime(
      config,
      createLocalModelRuntime(config),
      new LocalSessionStore(directory, true),
      (factoryContext) => {
        assembledWorkIds.push(factoryContext.workId);
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
  const created = await firstRuntime.createSession("session_work_restore", { workId: "work_bound_001" });
  assert.equal(created.workId, "work_bound_001");
  await firstRuntime.prompt(created.id, "保存绑定");

  const restored = await createRuntime().getSession(created.id);
  assert.equal(restored?.workId, "work_bound_001");
  assert.equal(restored?.messageCount, 2);
  assert.deepEqual(assembledWorkIds, ["work_bound_001", "work_bound_001"]);
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
  const pending = runtime.prompt("session_cancel_test", "等待取消");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await runtime.abortSession("session_cancel_test"), true);
  const result = await pending;
  assert.equal(result.stopReason, "aborted");
});
