import type {
  AccountBudgetReservationEntry,
  AccountHighCostTaskRunLock,
  CurrencyCode,
} from "@firefly/schemas";
import type {
  GeneratedVideoArtifact,
  ProductionJobFailure,
  ProductionJobStatus,
} from "@firefly/tools";

export interface VideoGenerationRecord {
  readonly schemaVersion: 1;
  /** Present and true for generations whose imported output must contain a validated audio track. */
  readonly audioEnabled?: boolean;
  readonly id: string;
  readonly tenantId: string;
  readonly batchProjectId: string;
  readonly videoTaskId: string;
  readonly actorAccountId: string;
  readonly requestId: string;
  readonly sourceTaskRevision: number;
  /** Immutable provider inputs retained for terminal request auditing. */
  readonly vehicleSnapshotId?: string;
  readonly storyboardArtifactVersionId: string;
  readonly assetSnapshotId: string;
  readonly promptText?: string;
  readonly promptSha256?: string;
  readonly modelId?: string;
  readonly aspectRatio?: string;
  readonly durationSeconds?: number;
  readonly shotIndex: number;
  readonly providerId: string;
  readonly providerJobId: string;
  readonly idempotencyKey: string;
  readonly status: ProductionJobStatus;
  readonly progressPercent: number;
  readonly estimatedAmountMinor: number;
  readonly currency: CurrencyCode;
  readonly reservation: AccountBudgetReservationEntry;
  readonly runLock: AccountHighCostTaskRunLock;
  readonly output?: GeneratedVideoArtifact;
  readonly compositeOutput?: GeneratedVideoArtifact;
  readonly compositeRequestId?: string;
  readonly compositeCreatedAt?: string;
  readonly failure?: ProductionJobFailure;
  readonly settledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface VideoGenerationStore {
  load(jobId: string): Promise<VideoGenerationRecord | undefined>;
  listForTask(tenantId: string, batchProjectId: string, videoTaskId: string): Promise<VideoGenerationRecord[]>;
  loadLatestForTask(tenantId: string, batchProjectId: string, videoTaskId: string): Promise<VideoGenerationRecord | undefined>;
  loadByRequest(tenantId: string, actorAccountId: string, requestId: string): Promise<VideoGenerationRecord | undefined>;
  create(record: Readonly<VideoGenerationRecord>): Promise<VideoGenerationRecord>;
  save(record: Readonly<VideoGenerationRecord>, expectedRevision: number): Promise<VideoGenerationRecord>;
}

function copy(record: Readonly<VideoGenerationRecord>): VideoGenerationRecord {
  return structuredClone(record);
}

export class MemoryVideoGenerationStore implements VideoGenerationStore {
  readonly #records = new Map<string, VideoGenerationRecord>();

  async load(jobId: string): Promise<VideoGenerationRecord | undefined> {
    const record = this.#records.get(jobId);
    return record === undefined ? undefined : copy(record);
  }

  async loadLatestForTask(tenantId: string, batchProjectId: string, videoTaskId: string): Promise<VideoGenerationRecord | undefined> {
    const record = [...this.#records.values()]
      .filter((candidate) => candidate.tenantId === tenantId && candidate.batchProjectId === batchProjectId && candidate.videoTaskId === videoTaskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt, "en"))[0];
    return record === undefined ? undefined : copy(record);
  }

  async listForTask(tenantId: string, batchProjectId: string, videoTaskId: string): Promise<VideoGenerationRecord[]> {
    return [...this.#records.values()]
      .filter((candidate) => candidate.tenantId === tenantId && candidate.batchProjectId === batchProjectId && candidate.videoTaskId === videoTaskId)
      .sort((left, right) => left.shotIndex - right.shotIndex || left.createdAt.localeCompare(right.createdAt, "en"))
      .map(copy);
  }

  async loadByRequest(tenantId: string, actorAccountId: string, requestId: string): Promise<VideoGenerationRecord | undefined> {
    const record = [...this.#records.values()].find((candidate) =>
      candidate.tenantId === tenantId && candidate.actorAccountId === actorAccountId && candidate.requestId === requestId
    );
    return record === undefined ? undefined : copy(record);
  }

  async create(record: Readonly<VideoGenerationRecord>): Promise<VideoGenerationRecord> {
    const replay = await this.loadByRequest(record.tenantId, record.actorAccountId, record.requestId);
    if (replay) return replay;
    if (this.#records.has(record.id)) throw new Error("Video generation job already exists.");
    this.#records.set(record.id, copy(record));
    return copy(record);
  }

  async save(record: Readonly<VideoGenerationRecord>, expectedRevision: number): Promise<VideoGenerationRecord> {
    const current = this.#records.get(record.id);
    if (!current) throw new Error("Video generation job was not found.");
    if (current.revision !== expectedRevision) throw new Error("Video generation job changed concurrently.");
    const next = { ...copy(record), revision: expectedRevision + 1 };
    this.#records.set(record.id, next);
    return copy(next);
  }
}
