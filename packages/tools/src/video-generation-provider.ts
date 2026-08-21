import type {
  ProductionJobFailure,
  ProductionJobStatus,
  ProductionProviderRequestOptions,
  ProductionProviderScope,
} from "./production-provider.ts";

/** Provider request contains production input only; authority and billing stay outside this DTO. */
export interface VideoGenerationRequest {
  readonly idempotencyKey: string;
  /** Runtime-configured provider Model ID or Endpoint ID, never model-proposed. */
  readonly model: string;
  readonly assetSnapshotId: string;
  readonly storyboardArtifactVersionId: string;
  readonly prompt: string;
  readonly aspectRatio: string;
  readonly durationSeconds: number;
}

/** Internal artifact handle returned to persistence; never expose provider download URLs here. */
export interface GeneratedVideoArtifact {
  /** Short-lived provider URL. Infrastructure must download it before returning publicly. */
  readonly downloadUrl: string;
  readonly mediaType: "video/mp4";
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly usageTokens?: number;
}

export interface VideoGenerationJob {
  readonly providerJobId: string;
  readonly idempotencyKey: string;
  readonly model: string;
  readonly status: ProductionJobStatus;
  readonly progressPercent: number;
  readonly output?: GeneratedVideoArtifact;
  readonly failure?: ProductionJobFailure;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * This interface does not authorize execution. The application service must
 * enforce task ownership, revision, account run lock, budget, and approval
 * before calling an implementation.
 */
export interface VideoGenerationProvider {
  readonly providerId: string;
  readonly targetModel: string;

  createGeneration(
    request: Readonly<VideoGenerationRequest>,
    scope: Readonly<ProductionProviderScope>,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<VideoGenerationJob>;

  getGeneration(
    providerJobId: string,
    scope: Readonly<ProductionProviderScope>,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<VideoGenerationJob>;

  cancelGeneration(
    providerJobId: string,
    scope: Readonly<ProductionProviderScope>,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<VideoGenerationJob>;
}
