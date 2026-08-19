import type {
  ProductionJobFailure,
  ProductionJobStatus,
  ProductionProviderRequestOptions,
  ProductionProviderScope,
} from "./production-provider.ts";

/** Supplier-neutral edit request. Provider-specific template fields stay in adapters. */
export interface AutomaticEditingRequest {
  readonly idempotencyKey: string;
  readonly assetSnapshotId: string;
  readonly storyboardArtifactVersionId: string;
  readonly sourceVideoArtifactIds: readonly string[];
  readonly draftName: string;
  readonly aspectRatio: string;
}

/** Internal draft handle that can later be mapped to any automation tool. */
export interface AutomaticEditingDraft {
  readonly draftId: string;
  readonly storageKey: string;
  readonly manifestSchemaVersion: number;
  readonly sourceVideoArtifactIds: readonly string[];
}

export interface AutomaticEditingJob {
  readonly providerJobId: string;
  readonly idempotencyKey: string;
  readonly status: ProductionJobStatus;
  readonly progressPercent: number;
  readonly draft?: AutomaticEditingDraft;
  readonly failure?: ProductionJobFailure;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Reserved supplier-neutral port for a future automated editing tool adapter.
 *
 * This interface does not authorize execution. The application service must
 * enforce task ownership, revision, account run lock, budget, and approval
 * before calling an implementation.
 */
export interface AutomaticEditingProvider {
  readonly providerId: string;

  createEditingJob(
    request: Readonly<AutomaticEditingRequest>,
    scope: Readonly<ProductionProviderScope>,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<AutomaticEditingJob>;

  getEditingJob(
    providerJobId: string,
    scope: Readonly<ProductionProviderScope>,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<AutomaticEditingJob>;

  cancelEditingJob(
    providerJobId: string,
    scope: Readonly<ProductionProviderScope>,
    options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<AutomaticEditingJob>;
}
