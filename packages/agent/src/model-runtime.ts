import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

import type { LocalAgentConfig } from "./local-config.ts";
import { mockStreamFn } from "./mock-stream.ts";

export interface LocalModelRuntime {
  model: Model<Api>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => string | undefined;
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function buildDeepSeekModel(modelId: string): Model<Api> {
  if (modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro") {
    return getBuiltinModel("deepseek", modelId);
  }
  throw new Error("Pi 0.84.1 local catalog supports deepseek-v4-flash and deepseek-v4-pro only.");
}

export function createLocalModelRuntime(config: LocalAgentConfig): LocalModelRuntime {
  if (config.provider === "mock") {
    return {
      model: {
        id: config.modelId,
        name: "Local deterministic mock",
        api: "mock-local",
        provider: "mock",
        baseUrl: config.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: zeroCost,
        contextWindow: 32_768,
        maxTokens: 4_096,
      },
      streamFn: mockStreamFn,
    };
  }

  const model =
    config.provider === "deepseek"
      ? buildDeepSeekModel(config.modelId)
      : ({
          id: config.modelId,
          name: config.modelId,
          api: "openai-completions",
          provider: "volcengine",
          baseUrl: config.baseUrl,
          reasoning: true,
          input: ["text", "image"],
          cost: config.modelId.includes("pro")
            ? { input: 6, output: 30, cacheRead: 1.2, cacheWrite: 0 }
            : { input: 3, output: 15, cacheRead: 0.6, cacheWrite: 0 },
          contextWindow: 256_000,
          maxTokens: 256_000,
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
          },
        } satisfies Model<"openai-completions">);

  return {
    model,
    streamFn: streamSimple,
    getApiKey: () => config.apiKey,
  };
}
