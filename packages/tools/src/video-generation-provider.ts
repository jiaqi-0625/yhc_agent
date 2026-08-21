import type {
  ProductionJobFailure,
  ProductionJobStatus,
  ProductionProviderRequestOptions,
  ProductionProviderScope,
} from "./production-provider.ts";

/** Provider-independent product model identifier. */
export const SEEDANCE_2_5_MODEL = "seedance-2.5" as const;
export type SeedanceVideoGenerationModel = typeof SEEDANCE_2_5_MODEL;

export type VideoGenerationReference =
  | {
      readonly type: "image_url";
      readonly url: string;
      readonly role: "reference_image";
    }
  | {
      readonly type: "video_url";
      readonly url: string;
      readonly role: "reference_video";
    }
  | {
      readonly type: "audio_url";
      readonly url: string;
      readonly role: "reference_audio";
    };

/** Provider request contains production input only; authority and billing stay outside this DTO. */
export interface VideoGenerationRequest {
  readonly idempotencyKey: string;
  readonly model: SeedanceVideoGenerationModel;
  readonly assetSnapshotId: string;
  readonly storyboardArtifactVersionId: string;
  readonly prompt: string;
  readonly references?: readonly VideoGenerationReference[];
  readonly generateAudio?: boolean;
  readonly aspectRatio: string;
  readonly durationSeconds: number;
  readonly watermark?: boolean;
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
 * Video-generation port implemented by the dedicated Volcengine Ark adapter.
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
