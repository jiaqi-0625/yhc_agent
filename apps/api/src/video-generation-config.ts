export type VideoGenerationBackend = "disabled" | "volcengine_ark";

export interface DisabledVideoGenerationConfig {
  readonly backend: "disabled";
}

export interface ArkVideoGenerationConfig {
  readonly backend: "volcengine_ark";
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly resolution: "720p" | "1080p";
  readonly watermark: boolean;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly estimatedCostMinor: number;
}

export type VideoGenerationConfig = DisabledVideoGenerationConfig | ArkVideoGenerationConfig;

export class VideoGenerationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoGenerationConfigError";
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

function required(environment: Environment, key: string, label: string): string {
  const value = environment[key];
  if (!value || value !== value.trim()) {
    throw new VideoGenerationConfigError(`${label} is required when real video generation is enabled.`);
  }
  return value;
}

function positiveInteger(
  environment: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[key];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new VideoGenerationConfigError(`${key} must be a positive base-10 integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new VideoGenerationConfigError(`${key} is outside the supported range.`);
  }
  return value;
}

function baseUrl(environment: Environment): string {
  const raw = environment.ARK_VIDEO_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new VideoGenerationConfigError("ARK video base URL must be a valid HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.hostname !== "ark.cn-beijing.volces.com"
  ) {
    throw new VideoGenerationConfigError("ARK video base URL must use the approved Volcengine Ark HTTPS host.");
  }
  return parsed.href.replace(/\/$/u, "");
}

export function parseVideoGenerationConfig(
  environment: Environment = process.env,
): VideoGenerationConfig {
  const backend = environment.VIDEO_GENERATION_BACKEND ?? "disabled";
  if (backend === "disabled") return Object.freeze({ backend });
  if (backend !== "volcengine_ark") {
    throw new VideoGenerationConfigError(
      "VIDEO_GENERATION_BACKEND must be one of disabled or volcengine_ark.",
    );
  }
  const resolution = environment.ARK_VIDEO_RESOLUTION ?? "720p";
  if (resolution !== "720p" && resolution !== "1080p") {
    throw new VideoGenerationConfigError("ARK_VIDEO_RESOLUTION must be 720p or 1080p.");
  }
  const watermarkRaw = environment.ARK_VIDEO_WATERMARK ?? "false";
  if (watermarkRaw !== "true" && watermarkRaw !== "false") {
    throw new VideoGenerationConfigError("ARK_VIDEO_WATERMARK must be true or false.");
  }
  return Object.freeze({
    backend,
    apiKey: required(environment, "ARK_VIDEO_API_KEY", "ARK video API key"),
    baseUrl: baseUrl(environment),
    modelId: required(environment, "ARK_VIDEO_MODEL_ID", "ARK video Model ID or Endpoint ID"),
    resolution,
    watermark: watermarkRaw === "true",
    pollIntervalMs: positiveInteger(environment, "ARK_VIDEO_POLL_INTERVAL_MS", 5_000, 1_000, 60_000),
    timeoutMs: positiveInteger(environment, "ARK_VIDEO_TIMEOUT_MS", 900_000, 60_000, 3_600_000),
    estimatedCostMinor: positiveInteger(
      environment,
      "ARK_VIDEO_ESTIMATED_COST_CNY_MINOR",
      1_000,
      1,
      1_000_000,
    ),
  });
}
