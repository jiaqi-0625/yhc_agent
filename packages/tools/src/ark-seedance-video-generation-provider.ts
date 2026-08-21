import type {
  ProductionJobFailure,
  ProductionJobStatus,
  ProductionProviderRequestOptions,
  ProductionProviderScope,
} from "./production-provider.ts";
import {
  SEEDANCE_2_5_MODEL,
  type GeneratedVideoArtifact,
  type VideoGenerationJob,
  type VideoGenerationProvider,
  type VideoGenerationReference,
  type VideoGenerationRequest,
} from "./video-generation-provider.ts";

const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const TASKS_PATH = "/contents/generations/tasks";
const ARK_SEEDANCE_2_5_MODEL_ID = "doubao-seedance-2-5-260628";
const ARK_SEEDANCE_2_5_MIN_DURATION_SECONDS = 4;
const ARK_SEEDANCE_2_5_MAX_DURATION_SECONDS = 30;

export interface SeedanceArtifactImportRequest {
  readonly providerJobId: string;
  readonly sourceUrl: string;
  readonly scope: Readonly<ProductionProviderScope>;
  readonly signal?: AbortSignal;
}

export interface SeedanceArtifactImporter {
  importVideo(request: Readonly<SeedanceArtifactImportRequest>): Promise<GeneratedVideoArtifact>;
}

export interface ArkSeedanceVideoGenerationProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly artifactImporter?: SeedanceArtifactImporter;
  readonly now?: () => string;
}

interface ArkTaskResponse {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly content?: unknown;
  readonly error?: unknown;
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty.`);
  return normalized;
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("ARK base URL must use HTTPS unless it targets localhost.");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function normalizeStatus(value: unknown): ProductionJobStatus {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "queued":
    case "pending": return "queued";
    case "running":
    case "processing": return "running";
    case "succeeded":
    case "success":
    case "completed": return "succeeded";
    case "failed":
    case "error": return "failed";
    case "cancelled":
    case "canceled": return "cancelled";
    default: return "queued";
  }
}

function timestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  return fallback;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function failureFrom(value: unknown): ProductionJobFailure | undefined {
  const error = record(value);
  if (!error) return undefined;
  return {
    code: typeof error.code === "string" ? error.code : "ARK_GENERATION_FAILED",
    message: typeof error.message === "string" ? error.message : "Seedance video generation failed.",
    retryable: false,
  };
}

function resultVideoUrl(content: unknown): string | undefined {
  const body = record(content);
  if (!body) return undefined;
  if (typeof body.video_url === "string") return body.video_url;
  const nested = record(body.video_url);
  return nested && typeof nested.url === "string" ? nested.url : undefined;
}

function referenceContent(reference: VideoGenerationReference): Record<string, unknown> {
  return {
    type: reference.type,
    [reference.type]: { url: requireNonEmpty(reference.url, `${reference.type} URL`) },
    role: reference.role,
  };
}

export class ArkSeedanceVideoGenerationProvider implements VideoGenerationProvider {
  readonly providerId = "volcengine_ark_seedance_2_5";
  readonly targetModel = SEEDANCE_2_5_MODEL;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly artifactImporter: SeedanceArtifactImporter | undefined;
  private readonly now: () => string;

  constructor(options: Readonly<ArkSeedanceVideoGenerationProviderOptions>) {
    this.apiKey = requireNonEmpty(options.apiKey, "ARK API key");
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_ARK_BASE_URL);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.artifactImporter = options.artifactImporter;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createGeneration(request: Readonly<VideoGenerationRequest>, scope: Readonly<ProductionProviderScope>, options?: Readonly<ProductionProviderRequestOptions>): Promise<VideoGenerationJob> {
    if (request.model !== this.targetModel) throw new Error(`Unsupported video model: ${request.model as string}`);
    requireNonEmpty(request.prompt, "Video prompt");
    if (!Number.isSafeInteger(request.durationSeconds)
      || request.durationSeconds < ARK_SEEDANCE_2_5_MIN_DURATION_SECONDS
      || request.durationSeconds > ARK_SEEDANCE_2_5_MAX_DURATION_SECONDS) {
      throw new Error(`Seedance 2.5 duration must be an integer from ${ARK_SEEDANCE_2_5_MIN_DURATION_SECONDS} to ${ARK_SEEDANCE_2_5_MAX_DURATION_SECONDS} seconds.`);
    }
    const response = await this.request("POST", TASKS_PATH, options?.signal, {
      model: ARK_SEEDANCE_2_5_MODEL_ID,
      content: [{ type: "text", text: request.prompt }, ...(request.references ?? []).map(referenceContent)],
      generate_audio: request.generateAudio ?? true,
      ratio: request.aspectRatio,
      duration: request.durationSeconds,
      watermark: request.watermark ?? false,
    }, request.idempotencyKey);
    return this.toJob(response, request.idempotencyKey, scope, options?.signal);
  }

  async getGeneration(providerJobId: string, scope: Readonly<ProductionProviderScope>, options?: Readonly<ProductionProviderRequestOptions>): Promise<VideoGenerationJob> {
    const id = encodeURIComponent(requireNonEmpty(providerJobId, "Provider job id"));
    return this.toJob(await this.request("GET", `${TASKS_PATH}/${id}`, options?.signal), providerJobId, scope, options?.signal);
  }

  async cancelGeneration(providerJobId: string, scope: Readonly<ProductionProviderScope>, options?: Readonly<ProductionProviderRequestOptions>): Promise<VideoGenerationJob> {
    const id = encodeURIComponent(requireNonEmpty(providerJobId, "Provider job id"));
    const job = await this.toJob(await this.request("DELETE", `${TASKS_PATH}/${id}`, options?.signal), providerJobId, scope, options?.signal);
    return { ...job, status: "cancelled", progressPercent: 0 };
  }

  private async request(method: "POST" | "GET" | "DELETE", path: string, signal?: AbortSignal, body?: Record<string, unknown>, idempotencyKey?: string): Promise<ArkTaskResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}`, ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try { payload = JSON.parse(text); } catch { throw new Error(`Ark API returned invalid JSON (HTTP ${response.status}).`); }
    }
    if (!response.ok) {
      const details = failureFrom(record(payload)?.error ?? payload);
      throw new Error(`Ark API request failed (HTTP ${response.status}): ${details?.code ?? "UNKNOWN"} - ${details?.message ?? "Unknown error"}`);
    }
    return record(payload) ?? {};
  }

  private async toJob(response: ArkTaskResponse, idempotencyKey: string, scope: Readonly<ProductionProviderScope>, signal?: AbortSignal): Promise<VideoGenerationJob> {
    const providerJobId = typeof response.id === "string" ? response.id : idempotencyKey;
    const status = normalizeStatus(response.status);
    const now = this.now();
    const sourceUrl = status === "succeeded" ? resultVideoUrl(response.content) : undefined;
    const output = sourceUrl === undefined || this.artifactImporter === undefined
      ? undefined
      : await this.artifactImporter.importVideo({ providerJobId, sourceUrl, scope, ...(signal === undefined ? {} : { signal }) });
    const failure = status === "failed" ? failureFrom(response.error) ?? { code: "ARK_GENERATION_FAILED", message: "Seedance video generation failed.", retryable: false } : undefined;
    return {
      providerJobId,
      idempotencyKey,
      model: this.targetModel,
      status,
      progressPercent: status === "succeeded" ? 100 : status === "running" ? 50 : 0,
      ...(output === undefined ? {} : { output }),
      ...(failure === undefined ? {} : { failure }),
      createdAt: timestamp(response.created_at, now),
      updatedAt: timestamp(response.updated_at, now),
    };
  }
}

export function createArkSeedanceVideoGenerationProviderFromEnv(environment: Readonly<Record<string, string | undefined>> = process.env, options: Omit<ArkSeedanceVideoGenerationProviderOptions, "apiKey" | "baseUrl"> = {}): ArkSeedanceVideoGenerationProvider {
  const apiKey = environment.ARK_API_KEY;
  if (!apiKey) throw new Error("ARK_API_KEY is required to enable Seedance video generation.");
  return new ArkSeedanceVideoGenerationProvider({ ...options, apiKey, ...(environment.ARK_VIDEO_BASE_URL === undefined ? {} : { baseUrl: environment.ARK_VIDEO_BASE_URL }) });
}
