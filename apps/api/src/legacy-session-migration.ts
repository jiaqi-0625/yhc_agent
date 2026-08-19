import { isDeepStrictEqual } from "node:util";

import {
  type AgentSessionScope,
  type LoadedLocalSession,
  type PersistedLocalSession,
} from "@firefly/agent";
import type { VideoTaskProductionRecord } from "@firefly/domain";
import {
  BatchProjectSchema,
  TaskContextSchema,
  VehicleSnapshotSchema,
  VideoTaskSchema,
  type BatchProject,
  type TaskContext,
} from "@firefly/schemas";
import { Value } from "typebox/value";

export interface LegacySessionMigrationInput {
  sessions: readonly Readonly<LoadedLocalSession>[];
  project: Readonly<BatchProject>;
  taskRecords: readonly Readonly<VideoTaskProductionRecord>[];
  brandName: string;
  /**
   * V1/V2 sessions have no trustworthy account owner. The operator must map
   * them explicitly to the owner of the migrated tasks.
   */
  legacySessionOwnerAccountId: string;
  /** Display-only owner label for migrated V3 sessions retained by another authorized account. */
  taskOwnerDisplayName: string;
  /** Trusted V3 scopes require an explicit, audited account transfer mapping. */
  legacyV3ScopeMappings?: readonly Readonly<LegacyV3ScopeMapping>[];
}

export interface LegacyV3ScopeMapping {
  sourceActorId: string;
  sourceTenantId: string;
  targetAccountId: string;
}

export interface LegacySessionMigrationSummary {
  sessionCount: number;
  convertedSessionCount: number;
  unchangedSessionCount: number;
  boundSessionCount: number;
  unboundSessionCount: number;
}

export interface LegacySessionMigrationResult {
  sessions: PersistedLocalSession[];
  summary: LegacySessionMigrationSummary;
}

const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/u;

function assertIdentifier(value: string, label: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${label} is not a valid identifier.`);
}

function normalizedBrandName(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length < 1 || normalized.length > 120) {
    throw new Error("Migrated brand name must contain 1 to 120 normalized characters.");
  }
  return normalized;
}

function normalizedDisplayName(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length < 1 || normalized.length > 120) {
    throw new Error(`${label} must contain 1 to 120 normalized characters.`);
  }
  return normalized;
}

function assertCommonSessionFields(session: Readonly<LoadedLocalSession>): void {
  assertIdentifier(session.id, "Session ID");
  if (
    typeof session.createdAt !== "string" ||
    typeof session.updatedAt !== "string" ||
    typeof session.provider !== "string" ||
    typeof session.modelId !== "string" ||
    !Array.isArray(session.messages)
  ) {
    throw new Error(`Session '${session.id}' has invalid common persisted fields.`);
  }
}

function assertSessionScope(scope: Readonly<AgentSessionScope>, sessionId: string): void {
  for (const [label, value] of [
    ["actor", scope.actorId],
    ["tenant", scope.tenantId],
    ["project", scope.projectId],
    ["video task", scope.videoTaskId],
  ] as const) {
    if (!identifierPattern.test(value)) {
      throw new Error(`Session '${sessionId}' has an invalid ${label} scope identifier.`);
    }
  }
}

function assertSourceSession(session: Readonly<LoadedLocalSession>): void {
  assertCommonSessionFields(session);
  const sessionId = session.id;
  if (session.schemaVersion === 1) {
    if (session.workId !== undefined && typeof session.workId !== "string") {
      throw new Error(`Session '${session.id}' has an invalid legacy Work binding.`);
    }
    return;
  }
  if (session.schemaVersion === 2) {
    if (session.taskContext !== undefined && !Value.Check(TaskContextSchema, session.taskContext)) {
      throw new Error(`Session '${session.id}' has an invalid V2 task context.`);
    }
    return;
  }
  if (session.schemaVersion !== 3) {
    throw new Error(`Session '${sessionId}' uses an unsupported persisted schema version.`);
  }
  if (session.taskContext === undefined && session.scope === undefined) return;
  if (
    session.taskContext === undefined ||
    session.scope === undefined ||
    !Value.Check(TaskContextSchema, session.taskContext)
  ) {
    throw new Error(`Session '${session.id}' has an incomplete V3 task binding.`);
  }
  assertSessionScope(session.scope, session.id);
  if (
    session.scope.projectId !== session.taskContext.batchProject.id ||
    session.scope.videoTaskId !== session.taskContext.videoTask.id
  ) {
    throw new Error(`Session '${session.id}' has inconsistent V3 scope and task context.`);
  }
}

function persistedEnvelope(
  source: Readonly<LoadedLocalSession>,
  binding: Pick<PersistedLocalSession, "taskContext" | "scope"> = {},
): PersistedLocalSession {
  return {
    schemaVersion: 3,
    id: source.id,
    ...(binding.taskContext === undefined
      ? {}
      : { taskContext: structuredClone(binding.taskContext) }),
    ...(binding.scope === undefined ? {} : { scope: structuredClone(binding.scope) }),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    provider: source.provider,
    modelId: source.modelId,
    messages: structuredClone(source.messages),
  };
}

function taskIndex(
  project: Readonly<BatchProject>,
  taskRecords: readonly Readonly<VideoTaskProductionRecord>[],
): Map<string, Readonly<VideoTaskProductionRecord>> {
  if (!Value.Check(BatchProjectSchema, project)) {
    throw new Error("Migrated batch project is invalid.");
  }
  const tasks = new Map<string, Readonly<VideoTaskProductionRecord>>();
  for (const record of taskRecords) {
    const task = record.videoTask;
    if (!Value.Check(VideoTaskSchema, task)) {
      throw new Error("Migrated session input contains an invalid video task.");
    }
    if (task.tenantId !== project.tenantId || task.batchProjectId !== project.id) {
      throw new Error(`Migrated video task '${task.id}' is outside the target batch project.`);
    }
    if (tasks.has(task.id)) {
      throw new Error(`Migrated session input contains duplicate video task '${task.id}'.`);
    }
    tasks.set(task.id, record);
  }
  return tasks;
}

function v3ScopeMappingIndex(
  mappings: readonly Readonly<LegacyV3ScopeMapping>[],
): Map<string, Readonly<LegacyV3ScopeMapping>> {
  const indexed = new Map<string, Readonly<LegacyV3ScopeMapping>>();
  for (const mapping of mappings) {
    assertIdentifier(mapping.sourceActorId, "Legacy V3 source actor ID");
    assertIdentifier(mapping.sourceTenantId, "Legacy V3 source tenant ID");
    assertIdentifier(mapping.targetAccountId, "Legacy V3 target account ID");
    const key = `${mapping.sourceTenantId}:${mapping.sourceActorId}`;
    if (indexed.has(key)) {
      throw new Error(
        `Legacy V3 scope mappings contain duplicate source '${mapping.sourceTenantId}/${mapping.sourceActorId}'.`,
      );
    }
    indexed.set(key, mapping);
  }
  return indexed;
}

function targetTaskContext(
  record: Readonly<VideoTaskProductionRecord>,
  project: Readonly<BatchProject>,
  brandName: string,
  sessionActorAccountId: string,
  taskOwnerDisplayName: string,
): TaskContext {
  const task = record.videoTask;
  const snapshotId = task.vehicleSnapshotId;
  const snapshots = snapshotId === undefined
    ? []
    : record.taskVehicleSnapshots.filter((snapshot) => snapshot.id === snapshotId);
  if (snapshots.length !== 1) {
    throw new Error(`Migrated video task '${task.id}' does not have one active vehicle snapshot.`);
  }
  const snapshot = snapshots[0]!;
  if (
    !Value.Check(VehicleSnapshotSchema, snapshot) ||
    snapshot.projectId !== project.id ||
    snapshot.brandId !== project.brandId ||
    snapshot.vehicleId !== project.vehicleId ||
    snapshot.vehicleVersion !== project.vehicleVersion
  ) {
    throw new Error(`Migrated video task '${task.id}' has a vehicle snapshot outside the target project.`);
  }
  const context: TaskContext = {
    schemaVersion: 1,
    kind: "task_context",
    brand: { id: project.brandId, name: brandName },
    vehicle: {
      id: project.vehicleId,
      displayName: `${snapshot.series} ${snapshot.trim}`,
      version: project.vehicleVersion,
    },
    batchProject: {
      id: project.id,
      name: project.name,
      aspectRatio: project.aspectRatio,
    },
    videoTask: {
      id: task.id,
      name: task.name,
      status: task.status,
      currentStage: task.currentStage,
      stageStatus: task.stageStatus,
      revision: task.revision,
      ...(task.vehicleSnapshotId === undefined
        ? {}
        : { vehicleSnapshotId: task.vehicleSnapshotId }),
      ...(task.assetSnapshotId === undefined ? {} : { assetSnapshotId: task.assetSnapshotId }),
      ownership: task.ownerAccountId === sessionActorAccountId
        ? { state: "owned_by_current_account" }
        : { state: "owned_by_other_account", ownerDisplayName: taskOwnerDisplayName },
    },
    productionBrief: {
      audience: task.audience,
      theme: task.theme,
      durationSeconds: task.durationSeconds,
      platformTags: [...task.platformTags],
    },
  };
  if (!Value.Check(TaskContextSchema, context)) {
    throw new Error(`Migrated video task '${task.id}' cannot form a valid Agent task context.`);
  }
  return context;
}

function sourceVideoTaskId(session: Readonly<LoadedLocalSession>): string | undefined {
  if (session.schemaVersion === 1) return session.workId;
  return session.taskContext?.videoTask.id;
}

function isAlreadyMigratedV3(
  session: Readonly<LoadedLocalSession>,
  taskContext: Readonly<TaskContext>,
  scope: Readonly<AgentSessionScope>,
): session is PersistedLocalSession {
  if (session.schemaVersion !== 3 || session.taskContext === undefined || session.scope === undefined) {
    return false;
  }
  return isDeepStrictEqual(session.taskContext, taskContext) &&
    isDeepStrictEqual(session.scope, scope);
}

/**
 * Purely converts persisted Agent sessions after Work records have been mapped
 * to their V2 project/task aggregates. This function performs no filesystem I/O.
 */
export function migrateLegacyAgentSessions(
  input: Readonly<LegacySessionMigrationInput>,
): LegacySessionMigrationResult {
  const brandName = normalizedBrandName(input.brandName);
  assertIdentifier(input.legacySessionOwnerAccountId, "Legacy session owner account ID");
  const taskOwnerDisplayName = normalizedDisplayName(
    input.taskOwnerDisplayName,
    "Migrated task owner display name",
  );
  const tasks = taskIndex(input.project, input.taskRecords);
  for (const record of tasks.values()) {
    if (record.videoTask.ownerAccountId !== input.legacySessionOwnerAccountId) {
      throw new Error(
        `Legacy session owner '${input.legacySessionOwnerAccountId}' does not own migrated video task '${record.videoTask.id}'.`,
      );
    }
  }
  const v3ScopeMappings = v3ScopeMappingIndex(input.legacyV3ScopeMappings ?? []);
  const allowedTargetActors = new Set([
    input.legacySessionOwnerAccountId,
    ...[...v3ScopeMappings.values()].map((mapping) => mapping.targetAccountId),
  ]);
  const seenSessionIds = new Set<string>();
  let convertedSessionCount = 0;
  let unchangedSessionCount = 0;
  let boundSessionCount = 0;
  let unboundSessionCount = 0;
  const sessions: PersistedLocalSession[] = [];

  for (const source of input.sessions) {
    assertSourceSession(source);
    if (seenSessionIds.has(source.id)) {
      throw new Error(`Legacy session input contains duplicate session '${source.id}'.`);
    }
    seenSessionIds.add(source.id);
    const videoTaskId = sourceVideoTaskId(source);
    if (videoTaskId === undefined) {
      unboundSessionCount += 1;
      if (source.schemaVersion === 3) {
        unchangedSessionCount += 1;
        sessions.push(structuredClone(source));
      } else {
        convertedSessionCount += 1;
        sessions.push(persistedEnvelope(source));
      }
      continue;
    }

    assertIdentifier(videoTaskId, `Session '${source.id}' video task ID`);
    const task = tasks.get(videoTaskId);
    if (task === undefined) {
      throw new Error(`Session '${source.id}' references orphan video task '${videoTaskId}'.`);
    }
    boundSessionCount += 1;
    if (source.schemaVersion === 3 && allowedTargetActors.has(source.scope!.actorId)) {
      const replayContext = targetTaskContext(
        task,
        input.project,
        brandName,
        source.scope!.actorId,
        taskOwnerDisplayName,
      );
      const replayScope: AgentSessionScope = {
        actorId: source.scope!.actorId,
        tenantId: input.project.tenantId,
        projectId: input.project.id,
        videoTaskId,
      };
      if (isAlreadyMigratedV3(source, replayContext, replayScope)) {
        unchangedSessionCount += 1;
        sessions.push(structuredClone(source));
        continue;
      }
    }

    let targetActorAccountId = input.legacySessionOwnerAccountId;
    if (source.schemaVersion === 3) {
      const sourceScope = source.scope!;
      const mapping = v3ScopeMappings.get(`${sourceScope.tenantId}:${sourceScope.actorId}`);
      if (mapping === undefined) {
        throw new Error(
          `Session '${source.id}' does not have an explicit V3 scope migration mapping.`,
        );
      }
      targetActorAccountId = mapping.targetAccountId;
    }

    const taskContext = targetTaskContext(
      task,
      input.project,
      brandName,
      targetActorAccountId,
      taskOwnerDisplayName,
    );
    const scope: AgentSessionScope = {
      actorId: targetActorAccountId,
      tenantId: input.project.tenantId,
      projectId: input.project.id,
      videoTaskId,
    };

    convertedSessionCount += 1;
    sessions.push(persistedEnvelope(source, {
      taskContext,
      scope,
    }));
  }

  return {
    sessions,
    summary: {
      sessionCount: sessions.length,
      convertedSessionCount,
      unchangedSessionCount,
      boundSessionCount,
      unboundSessionCount,
    },
  };
}
