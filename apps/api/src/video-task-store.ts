import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { VideoTaskProductionRecord } from "@firefly/domain";
import {
  AgentActionCommandReceiptSchema,
  StageArtifactInvalidationSchema,
  StageArtifactVersionSchema,
  StageConfirmationSchema,
  StageConfirmationRequestSchema,
  StageRollbackRecordSchema,
  TaskAssetSnapshotSchema,
  VehicleSnapshotSchema,
  VideoTaskOwnershipTransferSchema,
  VideoTaskSchema,
  VideoTaskStrategyDraftSchema,
  VideoTaskStageSchema,
  type StageArtifactVersion,
  type StageConfirmation,
  type VideoTask,
  type VideoTaskStage,
} from "@firefly/schemas";
import { Type } from "typebox";
import { Value } from "typebox/value";

interface LegacyVideoTaskProductionRecord {
  schemaVersion: 1;
  videoTask: VideoTask;
  stageArtifactVersions: StageArtifactVersion[];
  stageConfirmations: StageConfirmation[];
}

type LegacyVideoTaskProductionRecordV4 = Omit<
  VideoTaskProductionRecord,
  | "schemaVersion"
  | "taskVehicleSnapshots"
  | "strategyDrafts"
  | "activeStrategyDraftId"
  | "stageConfirmationRequests"
  | "commandReceipts"
> & { schemaVersion: 4 };

type LegacyVideoTaskProductionRecordV3 = Omit<
  LegacyVideoTaskProductionRecordV4,
  "schemaVersion" | "taskAssetSnapshots"
> & { schemaVersion: 3 };

type LegacyVideoTaskProductionRecordV2 = Omit<
  LegacyVideoTaskProductionRecordV3,
  "schemaVersion" | "ownershipTransfers"
> & { schemaVersion: 2 };

export interface VideoTaskCreationMetadata {
  requestId: string;
  actorAccountId: string;
  payloadHash: string;
}

export interface VideoTaskCreateResult {
  record: VideoTaskProductionRecord;
  replayed: boolean;
}

interface StoredVideoTaskProductionRecord extends VideoTaskProductionRecord {
  _creation?: VideoTaskCreationMetadata;
}

interface LoadedVideoTaskProductionRecord {
  record: VideoTaskProductionRecord;
  creation?: VideoTaskCreationMetadata;
}

const defaultTransactionLockTimeoutMilliseconds = 10_000;
const defaultTransactionLockLeaseMilliseconds = 10 * 60 * 1_000;
const defaultTransactionLockHeartbeatMilliseconds = 30_000;

export interface VideoTaskStoreLockOptions {
  timeoutMilliseconds?: number;
  leaseMilliseconds?: number;
  heartbeatMilliseconds?: number;
}

interface VideoTaskFileLock {
  withWriteFence<Result>(operation: () => Promise<Result>): Promise<Result>;
  release(): Promise<void>;
}

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_-]+$",
});

const ActiveStageArtifactVersionIdsSchema = Type.Partial(
  Type.Object(
    {
      strategy: IdentifierSchema,
      asset_matching: IdentifierSchema,
      script: IdentifierSchema,
      storyboard: IdentifierSchema,
      video_preview: IdentifierSchema,
      delivery: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
);

const VideoTaskProductionRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(5),
    videoTask: VideoTaskSchema,
    stageArtifactVersions: Type.Array(StageArtifactVersionSchema),
    stageConfirmations: Type.Array(StageConfirmationSchema),
    activeStageArtifactVersionIds: ActiveStageArtifactVersionIdsSchema,
    stageRollbacks: Type.Array(StageRollbackRecordSchema),
    stageArtifactInvalidations: Type.Array(StageArtifactInvalidationSchema),
    ownershipTransfers: Type.Array(VideoTaskOwnershipTransferSchema),
    taskAssetSnapshots: Type.Array(TaskAssetSnapshotSchema),
    taskVehicleSnapshots: Type.Array(VehicleSnapshotSchema),
    strategyDrafts: Type.Array(VideoTaskStrategyDraftSchema),
    activeStrategyDraftId: Type.Optional(IdentifierSchema),
    stageConfirmationRequests: Type.Array(StageConfirmationRequestSchema),
    commandReceipts: Type.Array(AgentActionCommandReceiptSchema),
  },
  { additionalProperties: false },
);

const videoTaskStageRank: Record<VideoTaskStage, number> = {
  strategy: 0,
  asset_matching: 1,
  script: 2,
  storyboard: 3,
  video_preview: 4,
  delivery: 5,
};

function stageArtifactDependencyIdentity(
  dependency: StageArtifactVersion["dependencies"][number],
): string {
  switch (dependency.kind) {
    case "stage_artifact":
      return `${dependency.kind}:${dependency.stage}:${dependency.artifactVersionId}`;
    case "vehicle_snapshot":
      return `${dependency.kind}:${dependency.vehicleSnapshotId}`;
    case "asset_snapshot":
      return `${dependency.kind}:${dependency.assetSnapshotId}`;
  }
}

function upgradeLegacyStageArtifactVersions(
  record: Readonly<{
    stageArtifactVersions: readonly StageArtifactVersion[];
    stageConfirmations: readonly StageConfirmation[];
  }>,
): StageArtifactVersion[] {
  const confirmationIds = new Set(record.stageConfirmations.map(({ id }) => id));
  return record.stageArtifactVersions.map((artifact) => {
    const copy = structuredClone(artifact);
    if (
      copy.provenance.kind === "human_confirmation" &&
      !confirmationIds.has(copy.provenance.confirmationId)
    ) {
      copy.provenance = {
        kind: "migrated_confirmation",
        legacyApprovalId: copy.provenance.confirmationId,
      };
    }
    return copy;
  });
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
}

function assertVideoTaskId(videoTaskId: string): void {
  assertIdentifier(videoTaskId, "Video task ID");
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function validateCreationMetadata(metadata: Readonly<VideoTaskCreationMetadata>): void {
  assertIdentifier(metadata.requestId, "Request ID");
  assertIdentifier(metadata.actorAccountId, "Actor account ID");
  if (metadata.payloadHash.length < 1 || metadata.payloadHash.length > 128) {
    throw new Error("Video task creation metadata has an invalid payload hash.");
  }
}

function validateRecord(
  record: Readonly<VideoTaskProductionRecord>,
  expectedVideoTaskId = record.videoTask?.id,
): void {
  if (!Value.Check(VideoTaskProductionRecordSchema, record)) {
    throw new Error("Persisted video task has an invalid format or scope.");
  }
  const { id, tenantId, batchProjectId } = record.videoTask;
  if (id !== expectedVideoTaskId) {
    throw new Error("Persisted video task has an invalid format or scope.");
  }
  const scoped = [
    ...record.stageArtifactVersions,
    ...record.stageConfirmations,
    ...record.stageRollbacks,
    ...record.stageArtifactInvalidations,
    ...record.ownershipTransfers,
    ...record.taskAssetSnapshots,
    ...record.strategyDrafts,
    ...record.stageConfirmationRequests,
    ...record.commandReceipts,
  ];
  if (
    scoped.some(
      (item) =>
        item.tenantId !== tenantId ||
        item.batchProjectId !== batchProjectId ||
        item.videoTaskId !== id,
    )
  ) {
    throw new Error("Persisted video task has an invalid format or scope.");
  }
  if (
    record.taskVehicleSnapshots.some((snapshot) => snapshot.projectId !== batchProjectId)
  ) {
    throw new Error("Persisted video task has an invalid format or scope.");
  }
  const collections = [
    record.stageArtifactVersions,
    record.stageConfirmations,
    record.stageRollbacks,
    record.stageArtifactInvalidations,
    record.ownershipTransfers,
    record.taskAssetSnapshots,
    record.taskVehicleSnapshots,
    record.strategyDrafts,
    record.stageConfirmationRequests,
    record.commandReceipts,
  ] as const;
  if (
    collections.some(
      (items) => new Set(items.map(({ id: itemId }) => itemId)).size !== items.length,
    )
  ) {
    throw new Error("Persisted video task has duplicate aggregate record identities.");
  }
  const activeEntries = Object.entries(record.activeStageArtifactVersionIds) as Array<
    [VideoTaskStage, string]
  >;
  if (
    activeEntries.some(
      ([stage, artifactId]) =>
        !Value.Check(VideoTaskStageSchema, stage) ||
        !record.stageArtifactVersions.some(
          (artifact) => artifact.id === artifactId && artifact.stage === stage,
        ) ||
        record.stageArtifactInvalidations.some(
          (invalidation) => invalidation.artifactVersionId === artifactId,
        ),
    )
  ) {
    throw new Error("Persisted video task has an invalid format or scope.");
  }
  const vehicleSnapshotIds = new Set(record.taskVehicleSnapshots.map(({ id: snapshotId }) => snapshotId));
  const vehicleSnapshotVersionKeys = record.taskVehicleSnapshots.map(
    (snapshot) => `${snapshot.vehicleId}:${snapshot.vehicleVersion}`,
  );
  const strategyDraftIds = new Set(record.strategyDrafts.map(({ id: draftId }) => draftId));
  const strategyDraftVersions = record.strategyDrafts.map(({ version }) => version);
  const latestStrategyDraft = record.strategyDrafts.reduce<
    VideoTaskProductionRecord["strategyDrafts"][number] | undefined
  >((latest, draft) => latest === undefined || draft.version > latest.version ? draft : latest, undefined);
  const assetSnapshotIds = new Set(record.taskAssetSnapshots.map(({ id: snapshotId }) => snapshotId));
  const assetSnapshotVersions = record.taskAssetSnapshots.map(({ version }) => version);
  const versionsAreContiguous = (versions: readonly number[]): boolean =>
    [...versions].sort((left, right) => left - right).every(
      (version, index) => version === index + 1,
    );
  const artifactVersionsByStage = new Map<VideoTaskStage, number[]>();
  for (const artifact of record.stageArtifactVersions) {
    artifactVersionsByStage.set(
      artifact.stage,
      [...(artifactVersionsByStage.get(artifact.stage) ?? []), artifact.version],
    );
  }
  if (
    record.taskVehicleSnapshots.length > 1 ||
    new Set(vehicleSnapshotVersionKeys).size !== vehicleSnapshotVersionKeys.length ||
    !versionsAreContiguous(strategyDraftVersions) ||
    !versionsAreContiguous(assetSnapshotVersions) ||
    [...artifactVersionsByStage.values()].some((versions) => !versionsAreContiguous(versions)) ||
    (record.taskVehicleSnapshots.length > 0 &&
      (record.videoTask.vehicleSnapshotId === undefined ||
        !vehicleSnapshotIds.has(record.videoTask.vehicleSnapshotId))) ||
    (record.taskAssetSnapshots.length > 0 &&
      (record.videoTask.assetSnapshotId === undefined ||
        !assetSnapshotIds.has(record.videoTask.assetSnapshotId))) ||
    record.taskAssetSnapshots.some(
      (snapshot) =>
        record.taskVehicleSnapshots.length > 0 &&
        !vehicleSnapshotIds.has(snapshot.vehicleSnapshotId),
    ) ||
    record.strategyDrafts.some(
      (draft) =>
        !vehicleSnapshotIds.has(draft.vehicleSnapshotId) ||
        draft.validation.valid !==
          !draft.validation.issues.some((issue) => issue.severity === "error"),
    ) ||
    (latestStrategyDraft === undefined
      ? record.activeStrategyDraftId !== undefined
      : record.activeStrategyDraftId !== latestStrategyDraft.id)
  ) {
    throw new Error("Persisted video task has an invalid strategy draft or vehicle snapshot pointer.");
  }
  const artifactsById = new Map(
    record.stageArtifactVersions.map((artifact) => [artifact.id, artifact] as const),
  );
  const confirmationsById = new Map(
    record.stageConfirmations.map((confirmation) => [confirmation.id, confirmation] as const),
  );
  for (const artifact of record.stageArtifactVersions) {
    const dependencyIdentities = artifact.dependencies.map(stageArtifactDependencyIdentity);
    if (new Set(dependencyIdentities).size !== dependencyIdentities.length) {
      throw new Error("Persisted video task has a duplicate stage artifact dependency.");
    }
    for (const dependency of artifact.dependencies) {
      if (dependency.kind === "stage_artifact") {
        const dependencyArtifact = artifactsById.get(dependency.artifactVersionId);
        if (
          dependencyArtifact === undefined ||
          dependencyArtifact.stage !== dependency.stage ||
          videoTaskStageRank[dependencyArtifact.stage] >= videoTaskStageRank[artifact.stage]
        ) {
          throw new Error("Persisted video task has an invalid stage artifact dependency graph.");
        }
        continue;
      }
      if (
        dependency.kind === "vehicle_snapshot" &&
        record.taskVehicleSnapshots.length > 0 &&
        !vehicleSnapshotIds.has(dependency.vehicleSnapshotId)
      ) {
        throw new Error("Persisted video task has an invalid vehicle snapshot dependency.");
      }
      if (
        dependency.kind === "asset_snapshot" &&
        record.taskAssetSnapshots.length > 0 &&
        !assetSnapshotIds.has(dependency.assetSnapshotId)
      ) {
        throw new Error("Persisted video task has an invalid asset snapshot dependency.");
      }
    }
    if (artifact.provenance.kind === "human_confirmation") {
      const confirmation = confirmationsById.get(artifact.provenance.confirmationId);
      if (
        confirmation === undefined ||
        confirmation.artifactVersionId !== artifact.id ||
        confirmation.stage !== artifact.stage
      ) {
        throw new Error("Persisted video task has an invalid stage artifact provenance graph.");
      }
    }
  }
  for (const confirmation of record.stageConfirmations) {
    const artifact = artifactsById.get(confirmation.artifactVersionId);
    if (
      artifact === undefined ||
      artifact.stage !== confirmation.stage ||
      (artifact.provenance.kind === "human_confirmation" &&
        artifact.provenance.confirmationId !== confirmation.id)
    ) {
      throw new Error("Persisted video task has an invalid stage confirmation graph.");
    }
  }
  const rollbacksById = new Map(
    record.stageRollbacks.map((rollback) => [rollback.id, rollback] as const),
  );
  const invalidationsById = new Map(
    record.stageArtifactInvalidations.map((invalidation) => [invalidation.id, invalidation] as const),
  );
  for (const rollback of record.stageRollbacks) {
    const fromArtifact = artifactsById.get(rollback.fromArtifactVersionId);
    const toArtifact = artifactsById.get(rollback.toArtifactVersionId);
    if (
      fromArtifact === undefined ||
      toArtifact === undefined ||
      fromArtifact.stage !== rollback.stage ||
      toArtifact.stage !== rollback.stage ||
      fromArtifact.id === toArtifact.id ||
      rollback.expectedTaskRevision > record.videoTask.revision ||
      rollback.invalidationIds.some((invalidationId) => !invalidationsById.has(invalidationId))
    ) {
      throw new Error("Persisted video task has an invalid stage rollback graph.");
    }
  }
  const invalidatedArtifactIds = new Set<string>();
  for (const invalidation of record.stageArtifactInvalidations) {
    const artifact = artifactsById.get(invalidation.artifactVersionId);
    const dependency = invalidation.invalidatedDependency;
    if (
      artifact === undefined ||
      artifact.stage !== invalidation.stage ||
      invalidatedArtifactIds.has(invalidation.artifactVersionId) ||
      dependency.kind !== "stage_artifact" ||
      !artifact.dependencies.some(
        (candidate) =>
          stageArtifactDependencyIdentity(candidate) ===
          stageArtifactDependencyIdentity(dependency),
      )
    ) {
      throw new Error("Persisted video task has an invalid stage artifact invalidation graph.");
    }
    invalidatedArtifactIds.add(invalidation.artifactVersionId);
    const dependencyArtifact = artifactsById.get(dependency.artifactVersionId);
    if (
      dependencyArtifact === undefined ||
      dependencyArtifact.stage !== dependency.stage ||
      videoTaskStageRank[dependencyArtifact.stage] >= videoTaskStageRank[artifact.stage]
    ) {
      throw new Error("Persisted video task has an invalid invalidated dependency graph.");
    }
    if (invalidation.cause.kind === "rollback") {
      const rollback = rollbacksById.get(invalidation.cause.rollbackId);
      if (
        rollback === undefined ||
        dependency.artifactVersionId !== rollback.fromArtifactVersionId
      ) {
        throw new Error("Persisted video task has an invalid rollback invalidation cause.");
      }
    } else {
      const upstream = invalidationsById.get(invalidation.cause.invalidationId);
      if (
        upstream === undefined ||
        dependency.artifactVersionId !== upstream.artifactVersionId
      ) {
        throw new Error("Persisted video task has an invalid upstream invalidation cause.");
      }
    }
  }
  const rollbackRootByInvalidationId = new Map<string, string>();
  for (const invalidation of record.stageArtifactInvalidations) {
    const visited = new Set<string>();
    let current = invalidation;
    while (current.cause.kind === "upstream_invalidation") {
      if (visited.has(current.id)) {
        throw new Error("Persisted video task has a cyclic artifact invalidation graph.");
      }
      visited.add(current.id);
      const upstream = invalidationsById.get(current.cause.invalidationId);
      if (upstream === undefined) {
        throw new Error("Persisted video task has an invalid upstream invalidation cause.");
      }
      current = upstream;
    }
    if (visited.has(current.id)) {
      throw new Error("Persisted video task has a cyclic artifact invalidation graph.");
    }
    if (!rollbacksById.has(current.cause.rollbackId)) {
      throw new Error("Persisted video task has an invalid rollback invalidation cause.");
    }
    rollbackRootByInvalidationId.set(invalidation.id, current.cause.rollbackId);
  }
  for (const rollback of record.stageRollbacks) {
    const rootedInvalidationIds = new Set(
      record.stageArtifactInvalidations
        .filter((invalidation) => rollbackRootByInvalidationId.get(invalidation.id) === rollback.id)
        .map(({ id: invalidationId }) => invalidationId),
    );
    const listedInvalidationIds = new Set(rollback.invalidationIds);
    if (
      rootedInvalidationIds.size !== listedInvalidationIds.size ||
      [...rootedInvalidationIds].some(
        (invalidationId) => !listedInvalidationIds.has(invalidationId),
      )
    ) {
      throw new Error("Persisted video task has an incomplete stage rollback invalidation graph.");
    }
  }
  const confirmationRequests = new Map(
    record.stageConfirmationRequests.map((request) => [request.id, request] as const),
  );
  if (
    record.stageConfirmationRequests.some(
      (request) =>
        !strategyDraftIds.has(request.strategyDraftId) ||
        record.strategyDrafts.find(({ id: draftId }) => draftId === request.strategyDraftId)
          ?.status !== "awaiting_confirmation" ||
        request.expectedTaskRevision + 1 > record.videoTask.revision,
    )
  ) {
    throw new Error("Persisted video task has an invalid stage confirmation request pointer.");
  }
  const receiptRequestKeys = record.commandReceipts.map(
    (receipt) => `${receipt.actorAccountId}:${receipt.requestId}`,
  );
  if (new Set(receiptRequestKeys).size !== receiptRequestKeys.length) {
    throw new Error("Persisted video task has duplicate command request identities.");
  }
  const receiptResultingRevisions = record.commandReceipts.map(
    ({ resultingTaskRevision }) => resultingTaskRevision,
  );
  if (new Set(receiptResultingRevisions).size !== receiptResultingRevisions.length) {
    throw new Error("Persisted video task has duplicate command result revisions.");
  }
  const referencedConfirmationRequestIds = new Set<string>();
  for (const receipt of record.commandReceipts) {
    if (
      receipt.resultingTaskRevision !== receipt.expectedTaskRevision + 1 ||
      receipt.resultingTaskRevision > record.videoTask.revision
    ) {
      throw new Error("Persisted video task has an invalid command receipt revision.");
    }
    if (receipt.action === "generate_strategy") {
      const generatedResult = receipt.result;
      const draft = generatedResult.kind === "strategy_generated"
        ? record.strategyDrafts.find(
            ({ id: draftId }) => draftId === generatedResult.strategyDraftId,
          )
        : undefined;
      if (
        draft === undefined ||
        draft.createdBy !== receipt.actorAccountId ||
        draft.createdAt !== receipt.occurredAt
      ) {
        throw new Error("Persisted video task has an invalid strategy command receipt.");
      }
      continue;
    }
    if (receipt.action === "request_strategy_approval") {
      if (receipt.result.kind !== "strategy_confirmation_requested") {
        throw new Error("Persisted video task has an invalid confirmation command receipt.");
      }
      const request = confirmationRequests.get(receipt.result.stageConfirmationRequestId);
      if (
        request === undefined ||
        request.strategyDraftId !== receipt.result.strategyDraftId ||
        request.expectedTaskRevision !== receipt.expectedTaskRevision ||
        request.actorAccountId !== receipt.actorAccountId ||
        request.occurredAt !== receipt.occurredAt
      ) {
        throw new Error("Persisted video task has an invalid confirmation command receipt.");
      }
      referencedConfirmationRequestIds.add(request.id);
      continue;
    }
    if (receipt.result.kind !== "stage_rolled_back") {
      throw new Error("Persisted video task has an invalid rollback command receipt.");
    }
    const rollbackResult = receipt.result;
    const rollback = record.stageRollbacks.find(
      ({ id: rollbackId }) => rollbackId === rollbackResult.stageRollbackId,
    );
    if (
      rollback === undefined ||
      rollback.expectedTaskRevision !== receipt.expectedTaskRevision ||
      rollback.requestedBy !== receipt.actorAccountId ||
      rollback.occurredAt !== receipt.occurredAt ||
      rollback.invalidationIds.length !== rollbackResult.invalidationIds.length ||
      rollback.invalidationIds.some(
        (invalidationId, index) => invalidationId !== rollbackResult.invalidationIds[index],
      ) ||
      rollbackResult.invalidationIds.some(
        (invalidationId) =>
          !record.stageArtifactInvalidations.some(({ id: currentId }) => currentId === invalidationId),
      )
    ) {
      throw new Error("Persisted video task has an invalid rollback command receipt.");
    }
  }
  if (referencedConfirmationRequestIds.size !== record.stageConfirmationRequests.length) {
    throw new Error("Persisted video task has an unreferenced stage confirmation request.");
  }
  const generatedDraftIds = record.commandReceipts.flatMap((receipt) =>
    receipt.action === "generate_strategy" && receipt.result.kind === "strategy_generated"
      ? [receipt.result.strategyDraftId]
      : [],
  );
  if (
    new Set(generatedDraftIds).size !== generatedDraftIds.length ||
    generatedDraftIds.length !== record.strategyDrafts.length
  ) {
    throw new Error("Persisted video task has an invalid strategy command receipt graph.");
  }
}

export interface VideoTaskProductionStore {
  load(videoTaskId: string): Promise<VideoTaskProductionRecord | undefined>;
  save(record: VideoTaskProductionRecord): Promise<void>;
  transact(
    videoTaskId: string,
    update: (
      current: VideoTaskProductionRecord | undefined,
    ) => VideoTaskProductionRecord | Promise<VideoTaskProductionRecord>,
  ): Promise<VideoTaskProductionRecord>;
}

export interface VideoTaskCreationStore extends VideoTaskProductionStore {
  create(
    record: Readonly<VideoTaskProductionRecord>,
    metadata: Readonly<VideoTaskCreationMetadata>,
  ): Promise<VideoTaskProductionRecord>;
  createWithResult(
    record: Readonly<VideoTaskProductionRecord>,
    metadata: Readonly<VideoTaskCreationMetadata>,
  ): Promise<VideoTaskCreateResult>;
  list(tenantId: string, batchProjectId?: string): Promise<VideoTaskProductionRecord[]>;
}

function upgradeRecord(
  parsed:
    | VideoTaskProductionRecord
    | LegacyVideoTaskProductionRecordV4
    | LegacyVideoTaskProductionRecordV3
    | LegacyVideoTaskProductionRecordV2
    | LegacyVideoTaskProductionRecord,
  videoTaskId: string,
): VideoTaskProductionRecord {
  if (parsed.videoTask.id !== videoTaskId) {
    throw new Error("Persisted video task has an invalid format or scope.");
  }
  if (parsed.schemaVersion === 5) return structuredClone(parsed);
  if (parsed.schemaVersion === 4) {
    return {
      ...structuredClone(parsed),
      schemaVersion: 5,
      stageArtifactVersions: upgradeLegacyStageArtifactVersions(parsed),
      taskVehicleSnapshots: [],
      strategyDrafts: [],
      stageConfirmationRequests: [],
      commandReceipts: [],
    };
  }
  if (parsed.schemaVersion === 3) {
    return {
      ...structuredClone(parsed),
      schemaVersion: 5,
      stageArtifactVersions: upgradeLegacyStageArtifactVersions(parsed),
      taskAssetSnapshots: [],
      taskVehicleSnapshots: [],
      strategyDrafts: [],
      stageConfirmationRequests: [],
      commandReceipts: [],
    };
  }
  if (parsed.schemaVersion === 2) {
    return {
      ...structuredClone(parsed),
      schemaVersion: 5,
      stageArtifactVersions: upgradeLegacyStageArtifactVersions(parsed),
      ownershipTransfers: [],
      taskAssetSnapshots: [],
      taskVehicleSnapshots: [],
      strategyDrafts: [],
      stageConfirmationRequests: [],
      commandReceipts: [],
    };
  }
  if ((parsed as { schemaVersion: number }).schemaVersion !== 1) {
    throw new Error("Persisted video task has an unsupported schema version.");
  }
  const activeStageArtifactVersionIds: Partial<Record<VideoTaskStage, string>> = {};
  for (const artifact of parsed.stageArtifactVersions) {
    const activeId = activeStageArtifactVersionIds[artifact.stage];
    const active = parsed.stageArtifactVersions.find((item) => item.id === activeId);
    if (!active || artifact.version > active.version) {
      activeStageArtifactVersionIds[artifact.stage] = artifact.id;
    }
  }
  return {
    schemaVersion: 5,
    videoTask: structuredClone(parsed.videoTask),
    stageArtifactVersions: upgradeLegacyStageArtifactVersions(parsed),
    stageConfirmations: structuredClone(parsed.stageConfirmations),
    activeStageArtifactVersionIds,
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskAssetSnapshots: [],
    taskVehicleSnapshots: [],
    strategyDrafts: [],
    stageConfirmationRequests: [],
    commandReceipts: [],
  };
}

export class LocalVideoTaskProductionStore implements VideoTaskCreationStore {
  readonly #directory: string;
  readonly #memory = new Map<string, LoadedVideoTaskProductionRecord>();
  readonly #transactionTails = new Map<string, Promise<void>>();
  readonly #lockTimeoutMilliseconds: number;
  readonly #lockLeaseMilliseconds: number;
  readonly #lockHeartbeatMilliseconds: number;

  constructor(
    directory = ".data/video-tasks",
    readonly persist = true,
    lockOptions: Readonly<VideoTaskStoreLockOptions> = {},
  ) {
    this.#directory = resolve(directory);
    this.#lockTimeoutMilliseconds =
      lockOptions.timeoutMilliseconds ?? defaultTransactionLockTimeoutMilliseconds;
    this.#lockLeaseMilliseconds =
      lockOptions.leaseMilliseconds ?? defaultTransactionLockLeaseMilliseconds;
    this.#lockHeartbeatMilliseconds =
      lockOptions.heartbeatMilliseconds ?? defaultTransactionLockHeartbeatMilliseconds;
    if (
      this.#lockTimeoutMilliseconds < 1 ||
      this.#lockHeartbeatMilliseconds < 1 ||
      this.#lockLeaseMilliseconds <= this.#lockHeartbeatMilliseconds * 2
    ) {
      throw new Error("Video task transaction lock timing options are invalid.");
    }
  }

  #path(videoTaskId: string): string {
    assertVideoTaskId(videoTaskId);
    const path = resolve(join(this.#directory, `${videoTaskId}.json`));
    if (!path.startsWith(`${this.#directory}${sep}`)) {
      throw new Error("Video task path escaped the configured data directory.");
    }
    return path;
  }

  #lockDirectory(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    const lockDirectory = resolve(join(this.#directory, ".locks"));
    const directory = resolve(join(lockDirectory, `${digest}.lock`));
    if (!directory.startsWith(`${lockDirectory}${sep}`)) {
      throw new Error("Video task lock path escaped the configured data directory.");
    }
    return directory;
  }

  #parseLockOwner(name: string): { pid: number; token: string } | undefined {
    const match = /^(\d+)\.([A-Fa-f0-9-]{36})\.owner$/u.exec(name);
    if (!match) return undefined;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
    return { pid, token: match[2]! };
  }

  #parseLockFence(name: string): { pid: number; token: string } | undefined {
    const match = /^(\d+)\.([A-Fa-f0-9-]{36})\.fence$/u.exec(name);
    if (!match) return undefined;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
    return { pid, token: match[2]! };
  }

  #isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  async #removeStaleLockDirectory(directory: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      const owner = entry.isFile()
        ? this.#parseLockOwner(entry.name)
        : entry.isDirectory()
          ? this.#parseLockFence(entry.name)
          : undefined;
      if (owner === undefined) continue;
      try {
        const details = await stat(
          entry.isDirectory() ? join(entryPath, "held") : entryPath,
        );
        const leaseExpired = Date.now() - details.mtimeMs > this.#lockLeaseMilliseconds;
        if (this.#isProcessAlive(owner.pid) && !leaseExpired) return false;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // Remove only entries observed in this scan. A newly written owner has a
    // different token and makes rmdir fail instead of being deleted.
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      try {
        if (entry.isDirectory()) {
          if (this.#parseLockFence(entry.name) !== undefined) {
            await unlink(join(entryPath, "held")).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
          }
          await rmdir(entryPath);
        } else {
          await unlink(entryPath);
        }
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
      }
    }
    try {
      await rmdir(directory);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      if (code === "ENOTEMPTY" || code === "EEXIST") return false;
      throw error;
    }
  }

  async #acquireFileLock(key: string): Promise<VideoTaskFileLock> {
    const directory = this.#lockDirectory(key);
    await mkdir(dirname(directory), { recursive: true });
    const token = randomUUID();
    const ownerPath = join(directory, `${process.pid}.${token}.owner`);
    const deadline = Date.now() + this.#lockTimeoutMilliseconds;
    while (true) {
      try {
        await mkdir(directory);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.#removeStaleLockDirectory(directory);
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for a video task transaction lock.");
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
        continue;
      }
      try {
        await writeFile(ownerPath, "", { flag: "wx" });
      } catch (error: unknown) {
        await rmdir(directory).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let heartbeatTail = Promise.resolve();
      let heartbeatError: unknown;
      let lockLost = false;
      const heartbeat = setInterval(() => {
        heartbeatTail = heartbeatTail
          .then(async () => {
            const now = new Date();
            try {
              await utimes(ownerPath, now, now);
            } catch (error: unknown) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                lockLost = true;
              } else {
                heartbeatError ??= error;
              }
            }
          })
          .catch((error: unknown) => {
            heartbeatError ??= error;
          });
      }, this.#lockHeartbeatMilliseconds);
      heartbeat.unref();
      const assertOwned = async (): Promise<void> => {
        if (heartbeatError !== undefined) {
          throw new Error("Video task transaction lock heartbeat failed.", {
            cause: heartbeatError,
          });
        }
        if (lockLost) throw new Error("Video task transaction lock was lost.");
        try {
          const details = await stat(ownerPath);
          if (!details.isFile()) throw new Error("Video task transaction lock was lost.");
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            lockLost = true;
            throw new Error("Video task transaction lock was lost.");
          }
          throw error;
        }
      };
      return {
        withWriteFence: async <Result>(operation: () => Promise<Result>): Promise<Result> => {
          const fenceDirectory = join(directory, `${process.pid}.${token}.fence`);
          const fenceMarker = join(fenceDirectory, "held");
          try {
            await mkdir(fenceDirectory);
            await writeFile(fenceMarker, "", { flag: "wx" });
            await assertOwned();
            return await operation();
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              lockLost = true;
              throw new Error("Video task transaction lock was lost.", { cause: error });
            }
            throw error;
          } finally {
            await unlink(fenceMarker).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
            await rmdir(fenceDirectory).catch((error: unknown) => {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
            });
          }
        },
        release: async (): Promise<void> => {
          clearInterval(heartbeat);
          await heartbeatTail;
          await unlink(ownerPath).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
          await rmdir(directory).catch((error: unknown) => {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
          });
        },
      };
    }
  }

  async #read(videoTaskId: string): Promise<LoadedVideoTaskProductionRecord | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.#path(videoTaskId), "utf8")) as Record<
        string,
        unknown
      >;
      const { _creation: rawCreation, ...rawRecord } = raw;
      const record = upgradeRecord(
        rawRecord as
          | VideoTaskProductionRecord
          | LegacyVideoTaskProductionRecordV4
          | LegacyVideoTaskProductionRecordV3
          | LegacyVideoTaskProductionRecordV2
          | LegacyVideoTaskProductionRecord,
        videoTaskId,
      );
      validateRecord(record, videoTaskId);
      let creation: VideoTaskCreationMetadata | undefined;
      if (rawCreation !== undefined) {
        if (
          typeof rawCreation !== "object" ||
          rawCreation === null ||
          Array.isArray(rawCreation) ||
          Object.keys(rawCreation).some(
            (key) => !["requestId", "actorAccountId", "payloadHash"].includes(key),
          )
        ) {
          throw new Error("Persisted video task has invalid creation metadata.");
        }
        creation = rawCreation as unknown as VideoTaskCreationMetadata;
        validateCreationMetadata(creation);
      }
      return {
        record: structuredClone(record),
        ...(creation === undefined ? {} : { creation: structuredClone(creation) }),
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #loadStored(videoTaskId: string): Promise<LoadedVideoTaskProductionRecord | undefined> {
    assertVideoTaskId(videoTaskId);
    const memory = this.#memory.get(videoTaskId);
    if (memory) return structuredClone(memory);
    if (!this.persist) return undefined;
    const loaded = await this.#read(videoTaskId);
    if (loaded !== undefined) this.#memory.set(videoTaskId, structuredClone(loaded));
    return loaded === undefined ? undefined : structuredClone(loaded);
  }

  async load(videoTaskId: string): Promise<VideoTaskProductionRecord | undefined> {
    const loaded = await this.#loadStored(videoTaskId);
    return loaded === undefined ? undefined : structuredClone(loaded.record);
  }

  async #write(
    record: Readonly<VideoTaskProductionRecord>,
    creation: Readonly<VideoTaskCreationMetadata> | undefined,
    exclusive: boolean,
  ): Promise<void> {
    validateRecord(record);
    if (creation !== undefined) validateCreationMetadata(creation);
    const copy = structuredClone(record);
    const copiedCreation = creation === undefined ? undefined : structuredClone(creation);
    if (this.persist) {
      const path = this.#path(copy.videoTask.id);
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const stored: StoredVideoTaskProductionRecord = {
        ...copy,
        ...(copiedCreation === undefined ? {} : { _creation: copiedCreation }),
      };
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      try {
        if (exclusive) {
          await link(temporaryPath, path);
          await unlink(temporaryPath);
        } else {
          await rename(temporaryPath, path);
        }
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    }
    this.#memory.set(copy.videoTask.id, {
      record: copy,
      ...(copiedCreation === undefined ? {} : { creation: copiedCreation }),
    });
  }

  async save(record: VideoTaskProductionRecord): Promise<void> {
    validateRecord(record);
    const existing = await this.#loadStored(record.videoTask.id);
    if (
      existing !== undefined &&
      (existing.record.videoTask.tenantId !== record.videoTask.tenantId ||
        existing.record.videoTask.batchProjectId !== record.videoTask.batchProjectId)
    ) {
      throw new Error("A video task save cannot change the aggregate scope.");
    }
    await this.#write(record, existing?.creation, false);
  }

  async #listStored(
    tenantId: string,
    batchProjectId?: string,
  ): Promise<LoadedVideoTaskProductionRecord[]> {
    assertIdentifier(tenantId, "Tenant ID");
    if (batchProjectId !== undefined) assertIdentifier(batchProjectId, "Batch project ID");
    const records = new Map<string, LoadedVideoTaskProductionRecord>();
    if (this.persist) {
      try {
        const entries = await readdir(this.#directory, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const videoTaskId = entry.name.slice(0, -".json".length);
          assertVideoTaskId(videoTaskId);
          const loaded = await this.#read(videoTaskId);
          if (loaded !== undefined) {
            this.#memory.set(videoTaskId, structuredClone(loaded));
            records.set(videoTaskId, loaded);
          }
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const [videoTaskId, loaded] of this.#memory) {
      records.set(videoTaskId, structuredClone(loaded));
    }
    const result = [...records.values()]
      .filter(
        ({ record }) =>
          record.videoTask.tenantId === tenantId &&
          (batchProjectId === undefined || record.videoTask.batchProjectId === batchProjectId),
      )
      .sort((left, right) =>
        left.record.videoTask.id.localeCompare(right.record.videoTask.id, "en"),
      );
    const namesByProject = new Set<string>();
    const requestsByProject = new Set<string>();
    for (const { record, creation } of result) {
      const scope = record.videoTask.batchProjectId;
      const nameKey = `${scope}:${normalizedName(record.videoTask.name)}`;
      if (namesByProject.has(nameKey)) {
        throw new Error("Persisted video tasks contain a duplicate project task name.");
      }
      namesByProject.add(nameKey);
      if (creation !== undefined) {
        const requestKey = `${scope}:${creation.actorAccountId}:${creation.requestId}`;
        if (requestsByProject.has(requestKey)) {
          throw new Error("Persisted video tasks contain a duplicate creation request.");
        }
        requestsByProject.add(requestKey);
      }
    }
    return result;
  }

  async list(tenantId: string, batchProjectId?: string): Promise<VideoTaskProductionRecord[]> {
    return structuredClone(
      (await this.#listStored(tenantId, batchProjectId)).map(({ record }) => record),
    );
  }

  async #transact<T>(
    key: string,
    operation: (fileLock: VideoTaskFileLock | undefined) => Promise<T>,
  ): Promise<T> {
    const previous = this.#transactionTails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.#transactionTails.set(key, tail);
    await previous;
    let fileLock: VideoTaskFileLock | undefined;
    try {
      if (this.persist) fileLock = await this.#acquireFileLock(key);
      return await operation(fileLock);
    } finally {
      try {
        await fileLock?.release();
      } finally {
        release();
        if (this.#transactionTails.get(key) === tail) this.#transactionTails.delete(key);
      }
    }
  }

  async create(
    record: Readonly<VideoTaskProductionRecord>,
    metadata: Readonly<VideoTaskCreationMetadata>,
  ): Promise<VideoTaskProductionRecord> {
    return (await this.createWithResult(record, metadata)).record;
  }

  async createWithResult(
    record: Readonly<VideoTaskProductionRecord>,
    metadata: Readonly<VideoTaskCreationMetadata>,
  ): Promise<VideoTaskCreateResult> {
    validateRecord(record);
    validateCreationMetadata(metadata);
    const candidate = structuredClone(record);
    const creation = structuredClone(metadata);
    const { tenantId, batchProjectId, id } = candidate.videoTask;
    const scopeKey = `create:${tenantId}:${batchProjectId}`;
    return this.#transact(scopeKey, async (fileLock) => {
      const existing = await this.#listStored(tenantId, batchProjectId);
      const replay = existing.find(
        ({ creation: current }) =>
          current?.actorAccountId === creation.actorAccountId &&
          current.requestId === creation.requestId,
      );
      if (replay !== undefined) {
        if (replay.creation?.payloadHash !== creation.payloadHash) {
          throw new Error("Video task creation request conflicts with a different payload.");
        }
        return { record: structuredClone(replay.record), replayed: true };
      }
      const occupied = await this.#loadStored(id);
      if (occupied !== undefined) {
        return this.#resolveCreationCollision(occupied, creation);
      }
      const name = normalizedName(candidate.videoTask.name);
      if (
        existing.some(
          ({ record: current }) => normalizedName(current.videoTask.name) === name,
        )
      ) {
        throw new Error("A video task with the same name already exists in this batch project.");
      }
      try {
        if (fileLock === undefined) {
          await this.#write(candidate, creation, true);
        } else {
          await fileLock.withWriteFence(() => this.#write(candidate, creation, true));
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          // Another store instance may have atomically claimed the same
          // deterministic task ID after our preflight scan. Read the winner
          // directly from disk instead of consulting this instance's cache.
          const winner = await this.#read(id);
          if (winner !== undefined) {
            this.#memory.set(id, structuredClone(winner));
            return this.#resolveCreationCollision(winner, creation);
          }
        }
        throw error;
      }
      return { record: structuredClone(candidate), replayed: false };
    });
  }

  #resolveCreationCollision(
    occupied: Readonly<LoadedVideoTaskProductionRecord>,
    creation: Readonly<VideoTaskCreationMetadata>,
  ): VideoTaskCreateResult {
    if (
      occupied.creation?.actorAccountId === creation.actorAccountId &&
      occupied.creation.requestId === creation.requestId
    ) {
      if (occupied.creation.payloadHash !== creation.payloadHash) {
        throw new Error("Video task creation request conflicts with a different payload.");
      }
      return { record: structuredClone(occupied.record), replayed: true };
    }
    throw new Error("A video task with the same ID already exists.");
  }

  async transact(
    videoTaskId: string,
    update: (
      current: VideoTaskProductionRecord | undefined,
    ) => VideoTaskProductionRecord | Promise<VideoTaskProductionRecord>,
  ): Promise<VideoTaskProductionRecord> {
    assertVideoTaskId(videoTaskId);
    return this.#transact(`task:${videoTaskId}`, async (fileLock) => {
      const current = this.persist
        ? await this.#read(videoTaskId)
        : await this.#loadStored(videoTaskId);
      if (current !== undefined) this.#memory.set(videoTaskId, structuredClone(current));
      const next = await update(
        current === undefined ? undefined : structuredClone(current.record),
      );
      if (next.videoTask.id !== videoTaskId) {
        throw new Error("A video task transaction cannot change the aggregate identity.");
      }
      if (
        current !== undefined &&
        (next.videoTask.tenantId !== current.record.videoTask.tenantId ||
          next.videoTask.batchProjectId !== current.record.videoTask.batchProjectId)
      ) {
        throw new Error("A video task transaction cannot change the aggregate scope.");
      }
      if (fileLock === undefined) {
        await this.#write(next, current?.creation, false);
      } else {
        await fileLock.withWriteFence(() => this.#write(next, current?.creation, false));
      }
      return structuredClone(next);
    });
  }
}
