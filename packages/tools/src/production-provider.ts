/** Server-resolved production scope. Never populate this from model or request payload fields. */
export interface ProductionProviderScope {
  readonly tenantId: string;
  readonly actorAccountId: string;
  readonly batchProjectId: string;
  readonly videoTaskId: string;
  readonly taskRevision: number;
}

export type ProductionJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ProductionJobFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ProductionProviderRequestOptions {
  readonly signal?: AbortSignal;
}
