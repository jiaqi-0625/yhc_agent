import type {
  ProductionJobStatus,
  ProductionProviderRequestOptions,
  ProductionProviderScope,
  VideoGenerationJob,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "@firefly/tools";

import type { ArkVideoGenerationConfig } from "./video-generation-config.ts";

type Fetch = typeof globalThis.fetch;

export class ArkVideoGenerationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly statusCode = 502,
  ) {
    super("The video generation provider request failed.");
    this.name = "ArkVideoGenerationError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function status(value: unknown): ProductionJobStatus {
  switch (value) {
    case "queued":
    case "pending": return "queued";
    case "running":
    case "processing": return "running";
    case "succeeded":
    case "completed": return "succeeded";
    case "failed":
    case "expired": return "failed";
    case "cancelled":
    case "canceled": return "cancelled";
    default: throw new ArkVideoGenerationError("AIC-VIDEO-PROVIDER_RESPONSE_INVALID", false);
  }
}

function safeProviderUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return undefined; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return undefined;
  return parsed.href;
}

function jobFromResponse(
  payload: unknown,
  request: Readonly<VideoGenerationRequest>,
  fallbackId?: string,
): VideoGenerationJob {
  const value = record(payload);
  if (!value) throw new ArkVideoGenerationError("AIC-VIDEO-PROVIDER_RESPONSE_INVALID", false);
  const providerJobId = text(value.id) ?? fallbackId;
  if (!providerJobId || !/^[A-Za-z0-9_-]{1,256}$/u.test(providerJobId)) {
    throw new ArkVideoGenerationError("AIC-VIDEO-PROVIDER_RESPONSE_INVALID", false);
  }
  const mappedStatus = status(value.status ?? "queued");
  const content = record(value.content);
  const usage = record(value.usage);
  const videoUrl = safeProviderUrl(content?.video_url ?? value.video_url);
  const width = number(content?.width);
  const height = number(content?.height);
  const durationSeconds = number(content?.duration);
  const usageTokens = number(usage?.total_tokens);
  const now = new Date().toISOString();
  if (mappedStatus === "succeeded" && !videoUrl) {
    throw new ArkVideoGenerationError("AIC-VIDEO-PROVIDER_OUTPUT_MISSING", false);
  }
  const error = record(value.error);
  return {
    providerJobId,
    idempotencyKey: request.idempotencyKey,
    model: request.model,
    status: mappedStatus,
    progressPercent: mappedStatus === "succeeded" ? 100 : mappedStatus === "running" ? 50 : 0,
    ...(videoUrl === undefined ? {} : {
      output: {
        downloadUrl: videoUrl,
        mediaType: "video/mp4",
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        ...(usageTokens === undefined ? {} : { usageTokens }),
      },
    }),
    ...(mappedStatus !== "failed" ? {} : {
      failure: {
        code: text(error?.code) ?? "AIC-VIDEO-PROVIDER_FAILED",
        message: "The video generation provider did not complete the job.",
        retryable: false,
      },
    }),
    createdAt: text(value.created_at) ?? now,
    updatedAt: text(value.updated_at) ?? now,
  };
}

export class ArkVideoGenerationProvider implements VideoGenerationProvider {
  readonly providerId = "volcengine_ark";
  readonly targetModel: string;

  constructor(
    private readonly config: ArkVideoGenerationConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.targetModel = config.modelId;
  }

  async #request(
    path: string,
    init: RequestInit,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<unknown> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${this.config.apiKey}`);
      headers.set("content-type", "application/json");
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        ...init,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        redirect: "error",
        headers,
      });
    } catch {
      throw new ArkVideoGenerationError("AIC-VIDEO-PROVIDER_UNAVAILABLE", true, 503);
    }
    if (!response.ok) {
      throw new ArkVideoGenerationError(
        response.status === 429 ? "AIC-VIDEO-PROVIDER_RATE_LIMIT" : "AIC-VIDEO-PROVIDER_REJECTED",
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status === 429 ? 429 : 502,
      );
    }
    try { return await response.json(); } catch {
      throw new ArkVideoGenerationError("AIC-VIDEO-PROVIDER_RESPONSE_INVALID", false);
    }
  }

  async createGeneration(
    request: Readonly<VideoGenerationRequest>,
    _scope: Readonly<ProductionProviderScope>,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<VideoGenerationJob> {
    if (request.model !== this.targetModel) {
      throw new ArkVideoGenerationError("AIC-VIDEO-MODEL_NOT_CONFIGURED", false, 409);
    }
    const payload = await this.#request("/contents/generations/tasks", {
      method: "POST",
      body: JSON.stringify({
        model: request.model,
        content: [{ type: "text", text: request.prompt }],
        ratio: request.aspectRatio,
        duration: request.durationSeconds,
        resolution: this.config.resolution,
        watermark: this.config.watermark,
      }),
      headers: { "x-client-request-id": request.idempotencyKey },
    }, options);
    return jobFromResponse(payload, request);
  }

  async getGeneration(
    providerJobId: string,
    _scope: Readonly<ProductionProviderScope>,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<VideoGenerationJob> {
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(providerJobId)) {
      throw new ArkVideoGenerationError("AIC-VIDEO-PROVIDER_JOB_INVALID", false, 400);
    }
    const request: VideoGenerationRequest = {
      idempotencyKey: providerJobId,
      model: this.targetModel,
      assetSnapshotId: "server_resolved",
      storyboardArtifactVersionId: "server_resolved",
      prompt: "server_resolved",
      aspectRatio: "9:16",
      durationSeconds: 5,
    };
    const payload = await this.#request(`/contents/generations/tasks/${providerJobId}`, {
      method: "GET",
    }, options);
    return jobFromResponse(payload, request, providerJobId);
  }

  async cancelGeneration(
    providerJobId: string,
    scope: Readonly<ProductionProviderScope>,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<VideoGenerationJob> {
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(providerJobId)) {
      throw new ArkVideoGenerationError("AIC-VIDEO-PROVIDER_JOB_INVALID", false, 400);
    }
    await this.#request(`/contents/generations/tasks/${providerJobId}`, { method: "DELETE" }, options);
    return {
      ...(await this.getGeneration(providerJobId, scope, options)),
      status: "cancelled",
      progressPercent: 0,
    };
  }
}
