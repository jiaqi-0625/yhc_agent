import type {
  ProductionJobFailure,
  ProductionJobStatus,
  ProductionProviderRequestOptions,
  ProductionProviderScope,
} from "./production-provider.ts";

export const SEEDANCE_2_5_MODEL = "seedance-2.5" as const;
export type SeedanceVideoGenerationModel = typeof SEEDANCE_2_5_MODEL;

/** Provider request contains production input only; authority and billing stay outside this DTO. */
export interface VideoGenerationRequest {
  readonly idempotencyKey: string;
  readonly model: SeedanceVideoGenerationModel;
  readonly assetSnapshotId: string;
  readonly storyboardArtifactVersionId: string;
  readonly prompt: string;
  readonly aspectRatio: string;
  readonly durationSeconds: number;
}

/** Internal artifact handle returned to persistence; never expose provider download URLs here. */
export interface GeneratedVideoArtifact {
  readonly artifactId: string;
  readonly storageKey: string;
  readonly mediaType: "video/mp4";
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly checksumSha256: string;
}

export interface VideoGenerationJob {
  readonly providerJobId: string;
  readonly idempotencyKey: string;
  readonly model: SeedanceVideoGenerationModel;
  readonly status: ProductionJobStatus;
  readonly progressPercent: number;
  readonly output?: GeneratedVideoArtifact;
  readonly failure?: ProductionJobFailure;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Reserved video-generation port for the future Seedance 2.5 adapter.
 *
 * This interface does not authorize execution. The application service must
 * enforce task ownership, revision, account run lock, budget, and approval
 * before calling an implementation.
 */
export interface VideoGenerationProvider {
  readonly providerId: string;
  readonly targetModel: SeedanceVideoGenerationModel;

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
