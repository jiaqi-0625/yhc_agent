import { createHash } from "node:crypto";

import {
  assertProjectAssetPoolAssets,
  validateStrategy,
  type VideoTaskProductionRecord,
} from "@firefly/domain";
import {
  BatchProjectSchema,
  ProjectAssetPoolSchema,
  StrategyApprovalSchema,
  StrategySchema,
  VehicleSnapshotSchema,
  WorkSchema,
  type AspectRatio,
  type AssetReference,
  type BatchProject,
  type MigratedStrategyApproval,
  type ProjectAssetPool,
  type StageArtifactDependency,
  type StageArtifactVersion,
  type Strategy,
  type StrategyApproval,
  type TaskAssetSnapshot,
  type VehicleSnapshot,
  type VideoTaskStage,
  type VideoTaskStrategyDraft,
  type VideoTaskStrategyDraftGeneration,
  type WorkStatus,
} from "@firefly/schemas";
import { Value } from "typebox/value";

import type { LocalWorkRecord } from "./business-store.ts";

export type LegacyStrategyApprovalProjection = MigratedStrategyApproval;

/**
 * This shape is part of the explicit v1 migration path. It must never be
 * emitted by normal V2 strategy generation.
 */
export type LegacyStrategyGeneration = Extract<
  VideoTaskStrategyDraftGeneration,
  { kind: "legacy_migration" }
>;

export interface LegacyWorkMigrationConfig {
  migrationId: string;
  migrationOccurredAt: string;
  migrationActorAccountId: string;
  tenantId: string;
  brandId: string;
  brandName: string;
  vehicleId: string;
  vehicleVersion: number;
  batchProjectId: string;
  assetPoolId: string;
  batchName: string;
  aspectRatio: AspectRatio;
  visualStylePresetId: string;
  projectAssets: readonly AssetReference[];
  taskOwnerAccountId: string;
  taskCreatedByAccountId: string;
  taskNamePrefix: string;
  defaultAudience: string;
  defaultTheme: string;
  defaultDurationSeconds: number;
  defaultPlatformTags: readonly string[];
}

export interface LegacyWorkMigrationSummary {
  sourceSchemaVersion: 1;
  workCount: number;
  vehicleSnapshotCount: number;
  canonicalizedVehicleSnapshotTimestampCount: number;
  strategyVersionCount: number;
  approvalCount: number;
  inferredArtifactCount: number;
  sourceFingerprintSha256: string;
  configurationFingerprintSha256: string;
  migrationFingerprintSha256: string;
}

export interface LegacyWorkMigrationResult {
  migrationId: string;
  project: BatchProject;
  assetPool: ProjectAssetPool;
  /** Deduplicated audit view. Each task aggregate also embeds its locked copy. */
  vehicleSnapshots: VehicleSnapshot[];
  taskRecords: VideoTaskProductionRecord[];
  summary: LegacyWorkMigrationSummary;
}

export interface MigratedLegacyWorkflowState {
  taskStatus: "active" | "completed";
  currentStage: VideoTaskStage;
  stageStatus: "in_progress" | "awaiting_confirmation" | "confirmed";
}

const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/u;

const legacyStatusRank: Readonly<Record<WorkStatus, number>> = {
  created: 0,
  strategy_draft: 1,
  awaiting_strategy_approval: 2,
  strategy_approved: 3,
  script_draft: 4,
  awaiting_script_approval: 5,
  script_approved: 6,
  prompt_draft: 7,
  awaiting_prompt_approval: 8,
  prompt_approved: 9,
  storyboard_draft: 10,
  awaiting_storyboard_approval: 11,
  storyboard_approved: 12,
  rendering: 13,
  final_review: 14,
  export_ready: 15,
  exported: 16,
};

export const legacyWorkStatusMigration: Readonly<
  Record<WorkStatus, MigratedLegacyWorkflowState>
> = {
  created: { taskStatus: "active", currentStage: "strategy", stageStatus: "in_progress" },
  strategy_draft: { taskStatus: "active", currentStage: "strategy", stageStatus: "in_progress" },
  awaiting_strategy_approval: {
    taskStatus: "active",
    currentStage: "strategy",
    stageStatus: "awaiting_confirmation",
  },
  strategy_approved: {
    taskStatus: "active",
    currentStage: "script",
    stageStatus: "in_progress",
  },
  script_draft: { taskStatus: "active", currentStage: "script", stageStatus: "in_progress" },
  awaiting_script_approval: {
    taskStatus: "active",
    currentStage: "script",
    stageStatus: "awaiting_confirmation",
  },
  script_approved: {
    taskStatus: "active",
    currentStage: "asset_matching",
    stageStatus: "in_progress",
  },
  prompt_draft: { taskStatus: "active", currentStage: "storyboard", stageStatus: "in_progress" },
  awaiting_prompt_approval: {
    taskStatus: "active",
    currentStage: "storyboard",
    stageStatus: "awaiting_confirmation",
  },
  prompt_approved: {
    taskStatus: "active",
    currentStage: "storyboard",
    stageStatus: "in_progress",
  },
  storyboard_draft: {
    taskStatus: "active",
    currentStage: "storyboard",
    stageStatus: "in_progress",
  },
  awaiting_storyboard_approval: {
    taskStatus: "active",
    currentStage: "storyboard",
    stageStatus: "awaiting_confirmation",
  },
  storyboard_approved: {
    taskStatus: "active",
    currentStage: "video_preview",
    stageStatus: "in_progress",
  },
  rendering: {
    taskStatus: "active",
    currentStage: "video_preview",
    stageStatus: "in_progress",
  },
  final_review: {
    taskStatus: "active",
    currentStage: "video_preview",
    stageStatus: "awaiting_confirmation",
  },
  export_ready: {
    taskStatus: "active",
    currentStage: "delivery",
    stageStatus: "in_progress",
  },
  exported: {
    taskStatus: "completed",
    currentStage: "delivery",
    stageStatus: "confirmed",
  },
};

function normalizedText(value: string, label: string, maximumLength: number): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error(`${label} must contain 1 to ${maximumLength} normalized characters.`);
  }
  return normalized;
}

function assertIdentifier(value: string, label: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${label} is not a valid identifier.`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function contentSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function derivedId(prefix: string, ...parts: readonly unknown[]): string {
  return `${prefix}_${sha256(parts).slice(0, 32)}`;
}

function sortedAssets(assets: readonly AssetReference[]): AssetReference[] {
  return [...structuredClone(assets)].sort((left, right) =>
    left.category.localeCompare(right.category, "en") ||
    left.assetId.localeCompare(right.assetId, "en") ||
    left.version - right.version ||
    stableJson(left).localeCompare(stableJson(right), "en"),
  );
}

function approvalProjection(
  approval: Readonly<StrategyApproval>,
): LegacyStrategyApprovalProjection {
  return {
    legacyApprovalId: approval.id,
    decision: approval.decision,
    actorAccountId: approval.actorId,
    ...(approval.comment === undefined ? {} : { comment: approval.comment }),
    occurredAt: approval.occurredAt,
  };
}

function migratedDraft(
  strategy: Readonly<Strategy>,
  approvals: readonly StrategyApproval[],
  snapshot: Readonly<VehicleSnapshot>,
  config: Readonly<LegacyWorkMigrationConfig>,
  awaitingConfirmation: boolean,
): VideoTaskStrategyDraft {
  const generation: LegacyStrategyGeneration = {
    kind: "legacy_migration",
    migratedFromSchemaVersion: 1,
    migrationId: config.migrationId,
    legacyStrategyId: strategy.id,
    legacyStrategyStatus: strategy.status,
    model: strategy.model,
    templateVersion: strategy.templateVersion,
    approvals: approvals
      .filter((approval) => approval.strategyId === strategy.id)
      .sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt, "en") ||
        left.id.localeCompare(right.id, "en"),
      )
      .map(approvalProjection),
  };
  const draft: VideoTaskStrategyDraft = {
    schemaVersion: 1 as const,
    id: strategy.id,
    tenantId: config.tenantId,
    batchProjectId: config.batchProjectId,
    videoTaskId: strategy.workId,
    vehicleSnapshotId: snapshot.id,
    version: strategy.version,
    status: awaitingConfirmation ? "awaiting_confirmation" as const : "draft" as const,
    audience: strategy.audience,
    theme: strategy.theme,
    items: structuredClone(strategy.items),
    validation: validateStrategy(strategy, snapshot),
    generation,
    createdAt: strategy.createdAt,
    createdBy: strategy.createdBy,
    updatedAt: strategy.updatedAt,
    updatedBy: strategy.createdBy,
  };
  return draft;
}

function commonDependencies(
  vehicleSnapshotId: string,
  assetSnapshotId?: string,
): StageArtifactDependency[] {
  const dependencies: StageArtifactDependency[] = [
    { kind: "vehicle_snapshot", vehicleSnapshotId },
  ];
  if (assetSnapshotId !== undefined) {
    dependencies.push({ kind: "asset_snapshot", assetSnapshotId });
  }
  return dependencies;
}

function approvedStrategyArtifacts(
  drafts: readonly VideoTaskStrategyDraft[],
  approvals: readonly StrategyApproval[],
  snapshot: Readonly<VehicleSnapshot>,
  workId: string,
  config: Readonly<LegacyWorkMigrationConfig>,
): StageArtifactVersion[] {
  const draftById = new Map(drafts.map((draft) => [draft.id, draft] as const));
  return approvals
    .filter((approval) => approval.decision === "approved")
    .sort((left, right) =>
      left.occurredAt.localeCompare(right.occurredAt, "en") ||
      left.id.localeCompare(right.id, "en"),
    )
    .map((approval, index) => {
      const draft = draftById.get(approval.strategyId);
      if (draft === undefined) {
        throw new Error(`Legacy approval '${approval.id}' references an unknown strategy.`);
      }
      return {
        id: derivedId("migrated_strategy_artifact", config.migrationId, workId, approval.id),
        tenantId: config.tenantId,
        batchProjectId: config.batchProjectId,
        videoTaskId: workId,
        stage: "strategy",
        version: index + 1,
        content: {
          artifactId: draft.id,
          schemaName: "video_task_strategy_draft",
          schemaVersion: draft.schemaVersion,
          contentHashSha256: contentSha256(draft),
        },
        dependencies: commonDependencies(snapshot.id),
        provenance: {
          kind: "migrated_confirmation",
          legacyApprovalId: approval.id,
        },
        createdAt: approval.occurredAt,
        createdBy: approval.actorId,
      } satisfies StageArtifactVersion;
    });
}

function inferredArtifact(
  stage: VideoTaskStage,
  version: number,
  upstream: StageArtifactVersion | undefined,
  snapshot: Readonly<VehicleSnapshot>,
  assetSnapshotId: string | undefined,
  record: Readonly<LocalWorkRecord>,
  config: Readonly<LegacyWorkMigrationConfig>,
  strategyDraft?: Readonly<VideoTaskStrategyDraft>,
): StageArtifactVersion {
  const content = stage === "strategy" && strategyDraft !== undefined
    ? {
        artifactId: strategyDraft.id,
        schemaName: "video_task_strategy_draft",
        schemaVersion: strategyDraft.schemaVersion,
        contentHashSha256: contentSha256(strategyDraft),
      }
    : {
        artifactId: derivedId(
          `legacy_${stage}_content`,
          config.migrationId,
          record.work.id,
          record.work.status,
        ),
        schemaName: `legacy_${stage}`,
        schemaVersion: 1,
        contentHashSha256: sha256({
          migrationId: config.migrationId,
          videoTaskId: record.work.id,
          legacyStatus: record.work.status,
          stage,
        }),
      };
  const requiresAssetSnapshot = stage !== "strategy" && stage !== "script";
  if (requiresAssetSnapshot && assetSnapshotId === undefined) {
    throw new Error(`Legacy Work '${record.work.id}' cannot infer '${stage}' without an asset snapshot.`);
  }
  const dependencies = commonDependencies(
    snapshot.id,
    requiresAssetSnapshot ? assetSnapshotId : undefined,
  );
  if (upstream !== undefined) {
    dependencies.push({
      kind: "stage_artifact",
      stage: upstream.stage,
      artifactVersionId: upstream.id,
    });
  }
  return {
    id: derivedId(
      `legacy_${stage}_artifact`,
      config.migrationId,
      record.work.id,
      record.work.status,
      version,
    ),
    tenantId: config.tenantId,
    batchProjectId: config.batchProjectId,
    videoTaskId: record.work.id,
    stage,
    version,
    content,
    dependencies,
    provenance: {
      kind: "legacy_inferred",
      migrationId: config.migrationId,
      note: `Inferred from legacy Work status '${record.work.status}'; no V2 human confirmation is claimed.`,
    },
    createdAt: config.migrationOccurredAt,
    createdBy: config.migrationActorAccountId,
  };
}

function needsInferredStage(status: WorkStatus, stage: VideoTaskStage): boolean {
  const rank = legacyStatusRank[status];
  switch (stage) {
    case "script":
      return rank >= legacyStatusRank.script_approved;
    case "asset_matching":
      return rank >= legacyStatusRank.script_approved;
    case "storyboard":
      return rank >= legacyStatusRank.storyboard_approved;
    case "video_preview":
      return rank >= legacyStatusRank.export_ready;
    case "delivery":
      return status === "exported";
    case "strategy":
      return false;
  }
}

function validateLegacyRecord(
  record: Readonly<LocalWorkRecord>,
  config: Readonly<LegacyWorkMigrationConfig>,
): void {
  const topLevelKeys = Object.keys(record).sort((left, right) => left.localeCompare(right, "en"));
  if (
    stableJson(topLevelKeys) !== stableJson([
      "approvals",
      "schemaVersion",
      "strategyVersions",
      "vehicleSnapshot",
      "work",
    ]) ||
    record.schemaVersion !== 1 ||
    !Value.Check(WorkSchema, record.work) ||
    !Value.Check(VehicleSnapshotSchema, record.vehicleSnapshot) ||
    record.strategyVersions.some((strategy) => !Value.Check(StrategySchema, strategy)) ||
    record.approvals.some((approval) => !Value.Check(StrategyApprovalSchema, approval))
  ) {
    throw new Error("Legacy Work record has an invalid v1 format.");
  }
  const { work, vehicleSnapshot } = record;
  if (
    work.vehicleSnapshotId !== vehicleSnapshot.id ||
    vehicleSnapshot.brandId !== config.brandId ||
    vehicleSnapshot.vehicleId !== config.vehicleId ||
    vehicleSnapshot.vehicleVersion !== config.vehicleVersion
  ) {
    throw new Error(`Legacy Work '${work.id}' is outside the configured migration target.`);
  }
  const strategyIds = new Set<string>();
  const strategyVersions = new Set<number>();
  for (const strategy of record.strategyVersions) {
    if (
      strategy.workId !== work.id ||
      strategy.vehicleSnapshotId !== vehicleSnapshot.id ||
      strategyIds.has(strategy.id) ||
      strategyVersions.has(strategy.version)
    ) {
      throw new Error(`Legacy Work '${work.id}' has an invalid strategy history.`);
    }
    strategyIds.add(strategy.id);
    strategyVersions.add(strategy.version);
  }
  if (
    [...strategyVersions].sort((left, right) => left - right)
      .some((version, index) => version !== index + 1)
  ) {
    throw new Error(`Legacy Work '${work.id}' has a non-contiguous strategy history.`);
  }
  const approvalIds = new Set<string>();
  for (const approval of record.approvals) {
    if (
      approval.workId !== work.id ||
      !strategyIds.has(approval.strategyId) ||
      approvalIds.has(approval.id)
    ) {
      throw new Error(`Legacy Work '${work.id}' has an invalid approval history.`);
    }
    approvalIds.add(approval.id);
  }
  if (
    legacyStatusRank[work.status] >= legacyStatusRank.strategy_approved &&
    record.strategyVersions.length === 0
  ) {
    throw new Error(`Advanced legacy Work '${work.id}' has no strategy history to preserve.`);
  }
}

function validateConfig(config: Readonly<LegacyWorkMigrationConfig>): void {
  for (const [label, value] of [
    ["Migration ID", config.migrationId],
    ["Migration actor account ID", config.migrationActorAccountId],
    ["Tenant ID", config.tenantId],
    ["Brand ID", config.brandId],
    ["Vehicle ID", config.vehicleId],
    ["Batch project ID", config.batchProjectId],
    ["Asset pool ID", config.assetPoolId],
    ["Visual style preset ID", config.visualStylePresetId],
    ["Task owner account ID", config.taskOwnerAccountId],
    ["Task creator account ID", config.taskCreatedByAccountId],
  ] as const) {
    assertIdentifier(value, label);
  }
  normalizedText(config.brandName, "Brand name", 120);
  normalizedText(config.batchName, "Batch name", 120);
  normalizedText(config.taskNamePrefix, "Task name prefix", 30);
  normalizedText(config.defaultAudience, "Default audience", 500);
  normalizedText(config.defaultTheme, "Default theme", 500);
  if (
    !Number.isInteger(config.vehicleVersion) || config.vehicleVersion < 1 ||
    !Number.isInteger(config.defaultDurationSeconds) ||
    config.defaultDurationSeconds < 1 || config.defaultDurationSeconds > 600 ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(config.migrationOccurredAt) ||
    !(["9:16", "16:9", "1:1", "4:5"] as readonly string[]).includes(config.aspectRatio) ||
    config.defaultPlatformTags.length > 20 ||
    new Set(config.defaultPlatformTags).size !== config.defaultPlatformTags.length ||
    config.defaultPlatformTags.some((tag) => !identifierPattern.test(tag)) ||
    config.projectAssets.length === 0
  ) {
    throw new Error("Legacy Work migration defaults are invalid.");
  }
  const vehicleAssets = config.projectAssets.filter(
    (asset) =>
      asset.source === "company_catalog" &&
      asset.category === "vehicle" &&
      asset.vehicleId === config.vehicleId,
  );
  const selectedStyle = config.projectAssets.find(
    (asset) => asset.category === "visual_style" && asset.assetId === config.visualStylePresetId,
  );
  if (vehicleAssets.length === 0 || selectedStyle === undefined) {
    throw new Error("Migration project assets must include the target vehicle and visual style.");
  }
}

function snapshotWithoutCaptureTime(snapshot: Readonly<VehicleSnapshot>): Omit<VehicleSnapshot, "createdAt"> {
  const { createdAt: _createdAt, ...content } = snapshot;
  return content;
}

function migrateRecord(
  record: Readonly<LocalWorkRecord>,
  project: Readonly<BatchProject>,
  canonicalSnapshot: Readonly<VehicleSnapshot>,
  assets: readonly AssetReference[],
  config: Readonly<LegacyWorkMigrationConfig>,
): VideoTaskProductionRecord {
  validateLegacyRecord(record, config);
  if (canonicalSnapshot.id !== record.vehicleSnapshot.id) {
    throw new Error(`Legacy Work '${record.work.id}' has no canonical vehicle snapshot.`);
  }
  const snapshot = structuredClone(canonicalSnapshot);
  const shouldLockAssetSnapshot =
    legacyStatusRank[record.work.status] >= legacyStatusRank.script_approved;
  const assetSnapshotId = shouldLockAssetSnapshot
    ? derivedId(
        "legacy_asset_snapshot",
        config.migrationId,
        record.work.id,
        project.id,
      )
    : undefined;
  const assetSnapshot: TaskAssetSnapshot | undefined = assetSnapshotId === undefined
    ? undefined
    : {
        id: assetSnapshotId,
        tenantId: config.tenantId,
        batchProjectId: project.id,
        videoTaskId: record.work.id,
        version: 1,
        sourceProjectAssetPoolRevision: 1,
        vehicleSnapshotId: snapshot.id,
        assets: [...structuredClone(assets)],
        createdAt: config.migrationOccurredAt,
        createdBy: config.migrationActorAccountId,
      };
  const orderedStrategies = [...record.strategyVersions].sort(
    (left, right) => left.version - right.version,
  );
  const activeStrategy = orderedStrategies.at(-1);
  const drafts = orderedStrategies.map((strategy) =>
    migratedDraft(
      strategy,
      record.approvals,
      snapshot,
      config,
      strategy.id === activeStrategy?.id && record.work.status === "awaiting_strategy_approval",
    ),
  );
  const artifacts = approvedStrategyArtifacts(
    drafts,
    record.approvals,
    snapshot,
    record.work.id,
    config,
  );
  let upstream = artifacts.at(-1);
  if (
    legacyStatusRank[record.work.status] >= legacyStatusRank.strategy_approved &&
    upstream === undefined
  ) {
    const latestDraft = drafts.at(-1);
    if (latestDraft === undefined) {
      throw new Error(`Advanced legacy Work '${record.work.id}' has no strategy artifact source.`);
    }
    upstream = inferredArtifact(
      "strategy",
      1,
      undefined,
      snapshot,
      assetSnapshotId,
      record,
      config,
      latestDraft,
    );
    artifacts.push(upstream);
  }
  const activeStageArtifactVersionIds: Partial<Record<VideoTaskStage, string>> = {};
  if (upstream !== undefined) activeStageArtifactVersionIds.strategy = upstream.id;
  for (const stage of [
    "script",
    "asset_matching",
    "storyboard",
    "video_preview",
    "delivery",
  ] as const) {
    if (!needsInferredStage(record.work.status, stage)) continue;
    if (upstream === undefined) {
      throw new Error(`Legacy Work '${record.work.id}' cannot infer '${stage}' without an upstream artifact.`);
    }
    upstream = inferredArtifact(
      stage,
      1,
      upstream,
      snapshot,
      assetSnapshotId,
      record,
      config,
    );
    artifacts.push(upstream);
    activeStageArtifactVersionIds[stage] = upstream.id;
  }
  const workflow = legacyWorkStatusMigration[record.work.status];
  const audience = activeStrategy?.audience ?? normalizedText(config.defaultAudience, "Default audience", 500);
  const theme = activeStrategy?.theme ?? normalizedText(config.defaultTheme, "Default theme", 500);
  const taskName = `${normalizedText(config.taskNamePrefix, "Task name prefix", 30)} ${record.work.id}`;
  if (taskName.length > 160) throw new Error(`Migrated task name for '${record.work.id}' is too long.`);
  return {
    schemaVersion: 7,
    videoTask: {
      id: record.work.id,
      tenantId: config.tenantId,
      batchProjectId: project.id,
      name: taskName,
      ownerAccountId: config.taskOwnerAccountId,
      status: workflow.taskStatus,
      currentStage: workflow.currentStage,
      stageStatus: workflow.stageStatus,
      revision: record.work.revision,
      vehicleSnapshotId: snapshot.id,
      ...(assetSnapshotId === undefined ? {} : { assetSnapshotId }),
      audience,
      theme,
      durationSeconds: config.defaultDurationSeconds,
      platformTags: [...config.defaultPlatformTags].sort((left, right) => left.localeCompare(right, "en")),
      createdAt: record.work.createdAt,
      createdBy: config.taskCreatedByAccountId,
      updatedAt: record.work.updatedAt,
      updatedBy: config.migrationActorAccountId,
    },
    stageArtifactVersions: artifacts,
    stageConfirmations: [],
    activeStageArtifactVersionIds,
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskVehicleSnapshots: [snapshot],
    taskAssetSnapshots: assetSnapshot === undefined ? [] : [assetSnapshot],
    strategyDrafts: drafts,
    ...(activeStrategy === undefined ? {} : { activeStrategyDraftId: activeStrategy.id }),
    stageConfirmationRequests: [],
    commandReceipts: [],
    stageMutationReceipts: [],
  };
}

/**
 * Deterministically converts one configured legacy project group. It performs
 * no I/O: backup, migration markers, and atomic Store writes belong to the
 * migration coordinator rather than this mapping function.
 */
export function migrateLegacyWorkRecords(
  sourceRecords: readonly Readonly<LocalWorkRecord>[],
  config: Readonly<LegacyWorkMigrationConfig>,
): LegacyWorkMigrationResult {
  validateConfig(config);
  if (sourceRecords.length === 0) throw new Error("At least one legacy Work record is required.");
  const records = [...sourceRecords].sort((left, right) =>
    left.work.id.localeCompare(right.work.id, "en"),
  );
  if (new Set(records.map((record) => record.work.id)).size !== records.length) {
    throw new Error("Legacy Work migration input contains duplicate Work IDs.");
  }
  for (const record of records) validateLegacyRecord(record, config);
  const snapshots = new Map<string, VehicleSnapshot>();
  for (const record of records) {
    const migrated = { ...structuredClone(record.vehicleSnapshot), projectId: config.batchProjectId };
    const existing = snapshots.get(migrated.id);
    if (
      existing !== undefined &&
      stableJson(snapshotWithoutCaptureTime(existing)) !==
        stableJson(snapshotWithoutCaptureTime(migrated))
    ) {
      throw new Error(`Legacy vehicle snapshot '${migrated.id}' has conflicting contents.`);
    }
    if (existing === undefined || migrated.createdAt.localeCompare(existing.createdAt, "en") < 0) {
      snapshots.set(migrated.id, migrated);
    }
  }
  const sample = records[0]!.vehicleSnapshot;
  if (records.some((record) =>
    normalizedText(record.vehicleSnapshot.series, "Vehicle series", 120) !==
      normalizedText(sample.series, "Vehicle series", 120) ||
    normalizedText(record.vehicleSnapshot.trim, "Vehicle trim", 120) !==
      normalizedText(sample.trim, "Vehicle trim", 120)
  )) {
    throw new Error("Legacy Work records disagree on the configured vehicle series or trim.");
  }
  const brandName = normalizedText(config.brandName, "Brand name", 120);
  const batchName = normalizedText(config.batchName, "Batch name", 120);
  const projectName = `${brandName} ${sample.series} ${sample.trim} ${config.aspectRatio} ${batchName}`;
  if (projectName.length > 240) throw new Error("Migrated batch project name is too long.");
  const assets = sortedAssets(config.projectAssets);
  const project: BatchProject = {
    id: config.batchProjectId,
    tenantId: config.tenantId,
    brandId: config.brandId,
    vehicleId: config.vehicleId,
    vehicleVersion: config.vehicleVersion,
    name: projectName,
    batchName,
    aspectRatio: config.aspectRatio,
    visualStylePresetId: config.visualStylePresetId,
    assetPoolId: config.assetPoolId,
    status: "active",
    revision: 1,
    createdAt: config.migrationOccurredAt,
    createdBy: config.migrationActorAccountId,
    updatedAt: config.migrationOccurredAt,
    updatedBy: config.migrationActorAccountId,
  };
  const assetPool: ProjectAssetPool = {
    id: config.assetPoolId,
    tenantId: config.tenantId,
    batchProjectId: config.batchProjectId,
    vehicleId: config.vehicleId,
    revision: 1,
    assets,
    createdAt: config.migrationOccurredAt,
    createdBy: config.migrationActorAccountId,
    updatedAt: config.migrationOccurredAt,
    updatedBy: config.migrationActorAccountId,
  };
  assertProjectAssetPoolAssets(project, assets);
  if (!Value.Check(BatchProjectSchema, project) || !Value.Check(ProjectAssetPoolSchema, assetPool)) {
    throw new Error("Configured migration target does not form a valid batch project aggregate.");
  }
  const taskRecords = records.map((record) =>
    migrateRecord(record, project, snapshots.get(record.vehicleSnapshot.id)!, assets, config));
  const canonicalizedVehicleSnapshotTimestampCount = records.filter(
    (record) =>
      snapshots.get(record.vehicleSnapshot.id)?.createdAt !== record.vehicleSnapshot.createdAt,
  ).length;
  const inferredArtifactCount = taskRecords.reduce(
    (count, task) => count + task.stageArtifactVersions.filter(
      (artifact) => artifact.provenance.kind === "legacy_inferred",
    ).length,
    0,
  );
  const sourceFingerprintSha256 = sha256(records);
  const configurationFingerprintSha256 = sha256({
    ...config,
    projectAssets: assets,
    defaultPlatformTags: [...config.defaultPlatformTags]
      .sort((left, right) => left.localeCompare(right, "en")),
  });
  return {
    migrationId: config.migrationId,
    project,
    assetPool,
    vehicleSnapshots: [...snapshots.values()].sort((left, right) => left.id.localeCompare(right.id, "en")),
    taskRecords,
    summary: {
      sourceSchemaVersion: 1,
      workCount: records.length,
      vehicleSnapshotCount: snapshots.size,
      canonicalizedVehicleSnapshotTimestampCount,
      strategyVersionCount: records.reduce((count, record) => count + record.strategyVersions.length, 0),
      approvalCount: records.reduce((count, record) => count + record.approvals.length, 0),
      inferredArtifactCount,
      sourceFingerprintSha256,
      configurationFingerprintSha256,
      migrationFingerprintSha256: sha256({
        sourceFingerprintSha256,
        configurationFingerprintSha256,
      }),
    },
  };
}
