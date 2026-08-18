import { resolve } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type LocalAgentProvider = "mock" | "deepseek" | "volcengine";

export interface LocalAgentConfig {
  provider: LocalAgentProvider;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  thinkingLevel: ThinkingLevel;
  persistSessions: boolean;
  dataDirectory: string;
}

export interface PublicLocalAgentConfig {
  provider: LocalAgentProvider;
  modelId: string;
  baseUrl: string;
  thinkingLevel: ThinkingLevel;
  persistSessions: boolean;
  credentialsConfigured: boolean;
}

const defaultModels: Readonly<Record<LocalAgentProvider, string>> = {
  mock: "mock-local",
  deepseek: "deepseek-v4-flash",
  volcengine: "doubao-seed-2-1-turbo-260628",
};

const defaultBaseUrls: Readonly<Record<LocalAgentProvider, string>> = {
  mock: "local://mock",
  deepseek: "https://api.deepseek.com",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
};

const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class LocalAgentCredentialsError extends Error {
  readonly code = "AIC-AGENT-CREDENTIALS_MISSING";

  constructor(readonly provider: Exclude<LocalAgentProvider, "mock">) {
    const variable = provider === "deepseek" ? "DEEPSEEK_API_KEY" : "ARK_API_KEY";
    super(`主 Agent 已配置为 ${provider}，但服务端尚未设置 ${variable}。`);
    this.name = "LocalAgentCredentialsError";
  }
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("LOCAL_AGENT_PERSIST_SESSIONS must be 'true' or 'false'.");
}

export function loadLocalAgentConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LocalAgentConfig {
  const providerValue = environment.AGENT_PROVIDER?.trim() || "deepseek";
  if (providerValue !== "mock" && providerValue !== "deepseek" && providerValue !== "volcengine") {
    throw new Error("AGENT_PROVIDER must be one of: mock, deepseek, volcengine.");
  }
  const provider = providerValue;
  const thinkingValue = environment.AGENT_THINKING_LEVEL?.trim() || "medium";
  if (!thinkingLevels.has(thinkingValue as ThinkingLevel)) {
    throw new Error("AGENT_THINKING_LEVEL is invalid.");
  }

  const providerKey =
    provider === "deepseek"
      ? optionalValue(environment.DEEPSEEK_API_KEY)
      : provider === "volcengine"
        ? optionalValue(environment.ARK_API_KEY)
        : undefined;
  const apiKey = optionalValue(environment.AGENT_PROVIDER_API_KEY) ?? providerKey;
  return {
    provider,
    modelId: optionalValue(environment.AGENT_MODEL) ?? defaultModels[provider],
    baseUrl: optionalValue(environment.AGENT_BASE_URL) ?? defaultBaseUrls[provider],
    ...(apiKey === undefined ? {} : { apiKey }),
    thinkingLevel: thinkingValue as ThinkingLevel,
    persistSessions: parseBoolean(environment.LOCAL_AGENT_PERSIST_SESSIONS, true),
    dataDirectory: resolve(optionalValue(environment.LOCAL_AGENT_DATA_DIR) ?? ".data/sessions"),
  };
}

export function toPublicLocalAgentConfig(config: LocalAgentConfig): PublicLocalAgentConfig {
  return {
    provider: config.provider,
    modelId: config.modelId,
    baseUrl: config.baseUrl,
    thinkingLevel: config.thinkingLevel,
    persistSessions: config.persistSessions,
    credentialsConfigured: config.provider === "mock" || config.apiKey !== undefined,
  };
}
