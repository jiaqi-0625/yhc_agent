import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

import {
  LocalAgentRuntime,
  loadLocalAgentConfig,
  toPublicLocalAgentConfig,
  type LocalAgentConfig,
  type LocalModelRuntime,
} from "../src/index.ts";

test("local configuration defaults to credential-free mock mode", () => {
  const config = loadLocalAgentConfig({});
  assert.equal(config.provider, "mock");
  assert.equal(config.modelId, "mock-local");
  assert.equal(config.apiKey, undefined);
  assert.equal(toPublicLocalAgentConfig(config).credentialsConfigured, true);
});

test("real providers fail closed without a server-side API key", () => {
  assert.throws(() => loadLocalAgentConfig({ AGENT_PROVIDER: "deepseek" }), /No API key/u);
  assert.throws(() => loadLocalAgentConfig({ AGENT_PROVIDER: "volcengine" }), /No API key/u);
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
