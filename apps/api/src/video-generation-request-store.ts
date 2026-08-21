import { createHash } from "node:crypto";

export type VideoGenerationProviderStatus =
  | "request_failed"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface VideoGenerationRequestRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly batchProjectId: string;
  readonly videoTaskId: string;
  readonly actorAccountId: string;
  readonly requestId: string;
  readonly taskRevision: number;
  readonly vehicleSnapshotId: string;
  readonly assetSnapshotId: string;
  readonly storyboardArtifactVersionId: string;
  readonly providerId: string;
  readonly providerJobId?: string;
  readonly providerStatus: VideoGenerationProviderStatus;
  readonly outcomeStatus: "succeeded" | "failed";
  readonly modelId: string;
  readonly resolution: "480p" | "720p" | "1080p";
  readonly aspectRatio: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "adaptive";
  readonly durationSeconds: number;
  readonly promptText: string;
  readonly promptSha256: string;
  readonly requestedAt: string;
  readonly completedAt: string;
  readonly chargedAmountMinor: number;
  readonly currency: "CNY";
  readonly mediaArtifactId?: string;
  readonly failureCode?: string;
}

export interface VideoGenerationRequestCreateResult {
  readonly record: VideoGenerationRequestRecord;
  readonly replayed: boolean;
}

export class VideoGenerationRequestConflictError extends Error {
  readonly code = "AIC-VIDEO-GENERATION-REQUEST_CONFLICT";
  constructor() {
    super("The video generation request ID is already bound to another result.");
    this.name = "VideoGenerationRequestConflictError";
  }
}

const identifier = /^[A-Za-z0-9_-]{1,128}$/u;
const providerJobIdentifier = /^[A-Za-z0-9_-]{1,256}$/u;
const sha256 = /^[0-9a-f]{64}$/u;
const providerStatuses = new Set<VideoGenerationProviderStatus>([
  "request_failed", "queued", "running", "succeeded", "failed", "cancelled",
]);
const aspectRatios = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]);
const resolutions = new Set(["480p", "720p", "1080p"]);

function assertIdentifier(value: string, label: string): void {
  if (!identifier.test(value)) throw new Error(`${label} is invalid.`);
}

function validTimestamp(value: string): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

export function videoGenerationPromptSha256(promptText: string): string {
  return createHash("sha256").update(promptText, "utf8").digest("hex");
}

export function validateVideoGenerationRequestRecord(
  record: Readonly<VideoGenerationRequestRecord>,
): void {
  const keys = Object.keys(record).sort();
  const allowed = [
    "actorAccountId", "aspectRatio", "assetSnapshotId", "batchProjectId",
    "chargedAmountMinor", "completedAt", "currency", "durationSeconds", "failureCode",
    "id", "mediaArtifactId", "modelId", "outcomeStatus", "promptSha256", "promptText",
    "providerId", "providerJobId", "providerStatus", "requestId", "requestedAt", "resolution",
    "storyboardArtifactVersionId", "taskRevision", "tenantId", "vehicleSnapshotId", "videoTaskId",
  ].filter((key) => (record as unknown as Record<string, unknown>)[key] !== undefined).sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new Error("Video generation request contains unsupported fields.");
  }
  for (const [value, label] of [
    [record.id, "Video generation request ID"],
    [record.tenantId, "Tenant ID"],
    [record.batchProjectId, "Batch project ID"],
    [record.videoTaskId, "Video task ID"],
    [record.actorAccountId, "Actor account ID"],
    [record.requestId, "Request ID"],
    [record.vehicleSnapshotId, "Vehicle snapshot ID"],
    [record.assetSnapshotId, "Asset snapshot ID"],
    [record.storyboardArtifactVersionId, "Storyboard artifact version ID"],
    [record.providerId, "Provider ID"],
  ] as const) assertIdentifier(value, label);
  if (record.providerJobId !== undefined && !providerJobIdentifier.test(record.providerJobId)) {
    throw new Error("Provider job ID is invalid.");
  }
  if (record.mediaArtifactId !== undefined) assertIdentifier(record.mediaArtifactId, "Media artifact ID");
  if (!Number.isSafeInteger(record.taskRevision) || record.taskRevision < 0) {
    throw new Error("Task revision is invalid.");
  }
  if (!providerStatuses.has(record.providerStatus)) throw new Error("Provider status is invalid.");
  if (record.outcomeStatus !== "succeeded" && record.outcomeStatus !== "failed") {
    throw new Error("Generation outcome is invalid.");
  }
  if (record.modelId.length < 1 || record.modelId.length > 256 || record.modelId !== record.modelId.trim()) {
    throw new Error("Model ID is invalid.");
  }
  if (!resolutions.has(record.resolution) || !aspectRatios.has(record.aspectRatio)) {
    throw new Error("Generation dimensions are invalid.");
  }
  if (!Number.isSafeInteger(record.durationSeconds) || record.durationSeconds < 1 || record.durationSeconds > 3600) {
    throw new Error("Generation duration is invalid.");
  }
  if (
    record.promptText.length < 1 || record.promptText.length > 20_000
    || record.promptText !== record.promptText.trim()
    || !sha256.test(record.promptSha256)
    || record.promptSha256 !== videoGenerationPromptSha256(record.promptText)
  ) throw new Error("Generation prompt or hash is invalid.");
  const requestedAt = validTimestamp(record.requestedAt);
  const completedAt = validTimestamp(record.completedAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(completedAt) || completedAt < requestedAt) {
    throw new Error("Generation timestamps are invalid.");
  }
  if (!Number.isSafeInteger(record.chargedAmountMinor) || record.chargedAmountMinor < 0) {
    throw new Error("Charged amount is invalid.");
  }
  if (record.currency !== "CNY") throw new Error("Generation currency is invalid.");
  if (record.outcomeStatus === "succeeded") {
    if (
      record.providerStatus !== "succeeded" || record.providerJobId === undefined
      || record.mediaArtifactId === undefined || record.chargedAmountMinor < 1
      || record.failureCode !== undefined
    ) throw new Error("Successful generation request is incomplete.");
  } else if (
    record.chargedAmountMinor !== 0 || record.failureCode === undefined
    || record.failureCode.length < 1 || record.failureCode.length > 200
    || record.failureCode !== record.failureCode.trim()
  ) throw new Error("Failed generation request is incomplete.");
}

export interface VideoGenerationRequestStore {
  create(
    record: Readonly<VideoGenerationRequestRecord>,
  ): Promise<VideoGenerationRequestCreateResult>;
  load(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
    generationRequestId: string,
  ): Promise<VideoGenerationRequestRecord | undefined>;
  loadByActorRequest(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
    actorAccountId: string,
    requestId: string,
  ): Promise<VideoGenerationRequestRecord | undefined>;
  list(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
  ): Promise<VideoGenerationRequestRecord[]>;
}
