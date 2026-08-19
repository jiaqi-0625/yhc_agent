import { COPYFILE_EXCL } from "node:constants";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  LocalSessionStore,
  type LoadedLocalSession,
  type PersistedLocalSession,
} from "@firefly/agent";
import type { VideoTaskProductionRecord } from "@firefly/domain";
import type {
  Brand,
  Vehicle,
  VehicleAssetAssociation,
  VehicleSnapshot,
  WorkspaceAccessGrant,
} from "@firefly/schemas";

import {
  LocalBatchProjectStore,
  type BatchProjectAggregate,
  type BatchProjectCreateMetadata,
} from "./batch-project-store.ts";
import type { LocalWorkRecord } from "./business-store.ts";
import {
  migrateLegacyAgentSessions,
  type LegacySessionMigrationResult,
  type LegacyV3ScopeMapping,
} from "./legacy-session-migration.ts";
import {
  migrateLegacyWorkRecords,
  type LegacyWorkMigrationConfig,
  type LegacyWorkMigrationResult,
} from "./legacy-work-migration.ts";
import {
  LocalVideoTaskProductionStore,
  type VideoTaskCreationMetadata,
} from "./video-task-store.ts";
import {
  LocalWorkspaceAdminStore,
  type WorkspaceAdminSeed,
  type WorkspaceAdminState,
} from "./workspace-admin-store.ts";
import {
  WorkspaceMigrationStateStore,
  type WorkspaceMigrationStatus,
} from "./workspace-migration-state.ts";

export interface LegacyWorkspaceMigrationDirectories {
  works: string;
  sessions: string;
  workspaceAdmin: string;
  batchProjects: string;
  videoTasks: string;
  migrations: string;
}

/** Every administration record used by the one-time migration is explicit. */
export interface LegacyWorkspaceMigrationAdministration {
  brands: readonly Brand[];
  vehicleVersions: readonly Vehicle[];
  vehicleAssetAssociations: readonly VehicleAssetAssociation[];
  accessGrants: readonly WorkspaceAccessGrant[];
}

export interface LegacyWorkspaceMigrationConfig {
  schemaVersion: 1;
  migration: LegacyWorkMigrationConfig;
  legacySessionOwnerAccountId: string;
  taskOwnerDisplayName: string;
  legacyV3SessionScopeMappings: readonly LegacyV3ScopeMapping[];
  administration: LegacyWorkspaceMigrationAdministration;
  directories: LegacyWorkspaceMigrationDirectories;
}

export interface MigrationFileSnapshot {
  name: string;
  sha256: string;
  size: number;
  backupRelativePath: string;
}

export type MigrationTargetKind =
  | "workspace_admin"
  | "batch_project"
  | "video_task"
  | "agent_session";

export interface MigrationTargetSnapshot {
  kind: MigrationTargetKind;
  id: string;
  writeRequired: boolean;
  existed: boolean;
  preimageSha256?: string;
  preimageSize?: number;
  backupRelativePath?: string;
  expectedPostimageSha256: string;
  expectedPostimageSize: number;
  appliedSha256?: string;
}

export interface LegacyWorkspaceMigrationPlan {
  schemaVersion: 1;
  migrationId: string;
  planHashSha256: string;
  configurationFingerprintSha256: string;
  sourceFingerprintSha256: string;
  migrationFingerprintSha256: string;
  sources: {
    works: MigrationFileSnapshot[];
    sessions: MigrationFileSnapshot[];
  };
  targets: MigrationTargetSnapshot[];
  summary: {
    works: LegacyWorkMigrationResult["summary"];
    sessions: LegacySessionMigrationResult["summary"];
    targetWriteCount: number;
  };
}

export interface LegacyWorkspaceMigrationManifest {
  schemaVersion: 1;
  migrationId: string;
  status: WorkspaceMigrationStatus;
  plan: LegacyWorkspaceMigrationPlan;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  restoredAt?: string;
}

export interface LegacyWorkspaceMigrationApplyResult {
  replayed: boolean;
  manifest: LegacyWorkspaceMigrationManifest;
}

export type LegacyWorkspaceMigrationStep =
  | "manifest_written"
  | "workspace_admin_written"
  | "batch_project_written"
  | "video_task_written"
  | "agent_session_written"
  | "verified";

export interface LegacyWorkspaceMigrationCoordinatorOptions {
  now?: () => string;
  afterStep?: (
    step: LegacyWorkspaceMigrationStep,
    id: string,
  ) => void | Promise<void>;
}

interface FileWithBytes extends MigrationFileSnapshot {
  path: string;
  bytes: Buffer;
}

interface TargetWithBytes extends MigrationTargetSnapshot {
  path: string;
  expectedBytes: Buffer;
}

interface PreparedMigration {
  configFingerprint: string;
  workMigration: LegacyWorkMigrationResult;
  sessionMigration: LegacySessionMigrationResult;
  administrationState: WorkspaceAdminState;
  projectMetadata: BatchProjectCreateMetadata;
  taskMetadata: Map<string, VideoTaskCreationMetadata>;
  sources: {
    works: FileWithBytes[];
    sessions: FileWithBytes[];
  };
  targets: TargetWithBytes[];
  plan: LegacyWorkspaceMigrationPlan;
}

const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/u;

function assertIdentifier(value: string, label: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${label} contains invalid characters.`);
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableSha256(value: unknown): string {
  return sha256(stableJson(value));
}

function prettyJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function recordsEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function resolvedDirectories(
  directories: Readonly<LegacyWorkspaceMigrationDirectories>,
): LegacyWorkspaceMigrationDirectories {
  return {
    works: resolve(directories.works),
    sessions: resolve(directories.sessions),
    workspaceAdmin: resolve(directories.workspaceAdmin),
    batchProjects: resolve(directories.batchProjects),
    videoTasks: resolve(directories.videoTasks),
    migrations: resolve(directories.migrations),
  };
}

function safeFilePath(directory: string, name: string): string {
  const path = resolve(join(directory, name));
  if (!path.startsWith(`${resolve(directory)}${sep}`)) {
    throw new Error("Migration file path escaped its configured directory.");
  }
  return path;
}

async function existingBytes(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function fileSnapshot(
  name: string,
  path: string,
  bytes: Buffer,
  backupRelativePath: string,
): FileWithBytes {
  return {
    name,
    path,
    bytes,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    backupRelativePath,
  };
}

function targetSnapshot(
  kind: MigrationTargetKind,
  id: string,
  path: string,
  current: Buffer | undefined,
  expectedBytes: Buffer,
  backupRelativePath: string | undefined,
  semanticallyEqual = current?.equals(expectedBytes) ?? false,
): TargetWithBytes {
  const postimage = semanticallyEqual && current !== undefined ? current : expectedBytes;
  return {
    kind,
    id,
    path,
    writeRequired: !semanticallyEqual,
    expectedBytes: postimage,
    existed: current !== undefined,
    ...(current === undefined
      ? {}
      : {
          preimageSha256: sha256(current),
          preimageSize: current.byteLength,
          ...(semanticallyEqual || backupRelativePath === undefined ? {} : { backupRelativePath }),
        }),
    expectedPostimageSha256: sha256(postimage),
    expectedPostimageSize: postimage.byteLength,
  };
}

function publicFileSnapshot(file: Readonly<FileWithBytes>): MigrationFileSnapshot {
  return {
    name: file.name,
    sha256: file.sha256,
    size: file.size,
    backupRelativePath: file.backupRelativePath,
  };
}

function publicTargetSnapshot(target: Readonly<TargetWithBytes>): MigrationTargetSnapshot {
  const { path: _path, expectedBytes: _expectedBytes, ...snapshot } = target;
  return structuredClone(snapshot);
}

function administrationSeed(
  administration: Readonly<LegacyWorkspaceMigrationAdministration>,
): WorkspaceAdminSeed {
  return {
    brands: structuredClone(administration.brands),
    vehicleVersions: structuredClone(administration.vehicleVersions),
    vehicleAssetAssociations: structuredClone(administration.vehicleAssetAssociations),
    accessGrants: structuredClone(administration.accessGrants),
  };
}

function appendExplicitRecords<T>(
  label: string,
  current: readonly T[],
  required: readonly T[],
  identity: (record: T) => string,
): T[] {
  const result = [...structuredClone(current)];
  const currentById = new Map(result.map((record) => [identity(record), record] as const));
  const requiredIds = new Set<string>();
  for (const record of required) {
    const id = identity(record);
    if (requiredIds.has(id)) throw new Error(`Migration administration has duplicate ${label} '${id}'.`);
    requiredIds.add(id);
    const existing = currentById.get(id);
    if (existing !== undefined && !recordsEqual(existing, record)) {
      throw new Error(`Migration target ${label} '${id}' conflicts with persisted administration data.`);
    }
    if (existing === undefined) {
      const copy = structuredClone(record);
      result.push(copy);
      currentById.set(id, copy);
    }
  }
  return result;
}

function mergeAdministration(
  current: Readonly<WorkspaceAdminState>,
  required: Readonly<LegacyWorkspaceMigrationAdministration>,
): WorkspaceAdminState {
  return {
    schemaVersion: 1,
    tenantId: current.tenantId,
    brands: appendExplicitRecords("brand", current.brands, required.brands, (record) => record.id),
    vehicleVersions: appendExplicitRecords(
      "vehicle fact version",
      current.vehicleVersions,
      required.vehicleVersions,
      (record) => `${record.id}:${record.version}`,
    ),
    vehicleAssetAssociations: appendExplicitRecords(
      "vehicle asset association",
      current.vehicleAssetAssociations,
      required.vehicleAssetAssociations,
      (record) => record.id,
    ),
    accessGrants: appendExplicitRecords(
      "workspace access grant",
      current.accessGrants,
      required.accessGrants,
      (record) => record.id,
    ),
  };
}

function assertAdministrationMatchesMigration(
  config: Readonly<LegacyWorkspaceMigrationConfig>,
): void {
  const migration = config.migration;
  const administration = config.administration;
  const brand = administration.brands.find(
    (candidate) => candidate.id === migration.brandId && candidate.tenantId === migration.tenantId,
  );
  const vehicle = administration.vehicleVersions.find(
    (candidate) =>
      candidate.id === migration.vehicleId &&
      candidate.version === migration.vehicleVersion &&
      candidate.tenantId === migration.tenantId &&
      candidate.brandId === migration.brandId,
  );
  if (brand === undefined || brand.name !== migration.brandName || vehicle === undefined) {
    throw new Error("Explicit migration administration does not contain the configured brand and vehicle version.");
  }
  const associationAssets = administration.vehicleAssetAssociations
    .filter(
      (record) =>
        record.tenantId === migration.tenantId &&
        record.brandId === migration.brandId &&
        record.vehicleId === migration.vehicleId,
    )
    .flatMap((record) => record.assets);
  if (
    migration.projectAssets.some(
      (asset) => !associationAssets.some((candidate) => recordsEqual(candidate, asset)),
    )
  ) {
    throw new Error("Explicit migration project assets are not present in the vehicle association catalog.");
  }
  const accounts = new Set([
    migration.migrationActorAccountId,
    migration.taskOwnerAccountId,
    migration.taskCreatedByAccountId,
    config.legacySessionOwnerAccountId,
    ...config.legacyV3SessionScopeMappings.map((mapping) => mapping.targetAccountId),
  ]);
  for (const accountId of accounts) {
    const granted = administration.accessGrants.some(
      (grant) =>
        grant.tenantId === migration.tenantId &&
        grant.accountId === accountId &&
        grant.status === "active" &&
        grant.access.brandId === migration.brandId &&
        (grant.access.kind === "brand" || grant.access.vehicleId === migration.vehicleId),
    );
    if (!granted) {
      throw new Error(`Migration target account '${accountId}' lacks explicit project access.`);
    }
  }
}

function vehicleFacts(
  vehicle: Readonly<Pick<
    Vehicle | VehicleSnapshot,
    | "series"
    | "modelYear"
    | "trim"
    | "parameters"
    | "fixedClaims"
    | "optionalClaims"
    | "prohibitedClaims"
  >>,
): unknown {
  return {
    series: vehicle.series,
    modelYear: vehicle.modelYear,
    trim: vehicle.trim,
    parameters: vehicle.parameters,
    fixedClaims: vehicle.fixedClaims,
    optionalClaims: vehicle.optionalClaims,
    prohibitedClaims: vehicle.prohibitedClaims,
  };
}

function assertAdministrationMatchesSnapshots(
  config: Readonly<LegacyWorkspaceMigrationConfig>,
  migration: Readonly<LegacyWorkMigrationResult>,
): void {
  const configured = config.administration.vehicleVersions.find(
    (vehicle) =>
      vehicle.id === config.migration.vehicleId &&
      vehicle.version === config.migration.vehicleVersion,
  );
  if (
    configured === undefined ||
    migration.vehicleSnapshots.some(
      (snapshot) => !recordsEqual(vehicleFacts(snapshot), vehicleFacts(configured)),
    )
  ) {
    throw new Error(
      "Explicit migration vehicle facts do not match every legacy vehicle snapshot.",
    );
  }
}

async function readDirectoryEntries(directory: string, label: string) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error(`${label} contains unexpected entry '${entry.name}'.`);
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

async function readWorkSources(directory: string): Promise<{
  files: FileWithBytes[];
  records: LocalWorkRecord[];
}> {
  const files: FileWithBytes[] = [];
  const records: LocalWorkRecord[] = [];
  for (const entry of await readDirectoryEntries(directory, "Legacy Work source directory")) {
    const path = safeFilePath(directory, entry.name);
    const bytes = await readFile(path);
    let parsed: LocalWorkRecord;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as LocalWorkRecord;
    } catch (error) {
      throw new Error(`Legacy Work source '${entry.name}' is not valid JSON.`, { cause: error });
    }
    if (parsed?.work?.id !== entry.name.slice(0, -".json".length)) {
      throw new Error(`Legacy Work source '${entry.name}' does not match its Work ID.`);
    }
    files.push(fileSnapshot(entry.name, path, bytes, `source-works/${entry.name}`));
    records.push(parsed);
  }
  return { files, records };
}

async function readSessionSources(directory: string): Promise<{
  files: FileWithBytes[];
  sessions: LoadedLocalSession[];
}> {
  const files: FileWithBytes[] = [];
  const sessions: LoadedLocalSession[] = [];
  const store = new LocalSessionStore(directory);
  for (const entry of await readDirectoryEntries(directory, "Agent session source directory")) {
    const sessionId = entry.name.slice(0, -".json".length);
    assertIdentifier(sessionId, "Session ID");
    const path = safeFilePath(directory, entry.name);
    const bytes = await readFile(path);
    const session = await store.load(sessionId);
    if (session === undefined || session.id !== sessionId) {
      throw new Error(`Agent session source '${entry.name}' has an invalid identity.`);
    }
    files.push(fileSnapshot(entry.name, path, bytes, `source-sessions/${entry.name}`));
    sessions.push(session);
  }
  return { files, sessions };
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function projectCreationMetadata(
  migration: Readonly<LegacyWorkMigrationResult>,
  actorAccountId: string,
): BatchProjectCreateMetadata {
  return {
    requestId: `migration_project_${migration.summary.migrationFingerprintSha256.slice(0, 32)}`,
    actorAccountId,
    payloadHash: migration.summary.migrationFingerprintSha256,
  };
}

function videoTaskCreationMetadata(
  migration: Readonly<LegacyWorkMigrationResult>,
  record: Readonly<VideoTaskProductionRecord>,
  actorAccountId: string,
): VideoTaskCreationMetadata {
  return {
    requestId: `migration_task_${stableSha256([
      migration.summary.migrationFingerprintSha256,
      record.videoTask.id,
    ]).slice(0, 32)}`,
    actorAccountId,
    payloadHash: stableSha256({
      migrationFingerprintSha256: migration.summary.migrationFingerprintSha256,
      record,
    }),
  };
}

function configFingerprint(
  config: Readonly<LegacyWorkspaceMigrationConfig>,
  directories: Readonly<LegacyWorkspaceMigrationDirectories>,
): string {
  return stableSha256({
    schemaVersion: config.schemaVersion,
    migration: config.migration,
    legacySessionOwnerAccountId: config.legacySessionOwnerAccountId,
    taskOwnerDisplayName: config.taskOwnerDisplayName,
    legacyV3SessionScopeMappings: config.legacyV3SessionScopeMappings,
    administration: config.administration,
    directories,
  });
}

function sourceFingerprint(
  works: readonly Readonly<FileWithBytes>[],
  sessions: readonly Readonly<FileWithBytes>[],
): string {
  return stableSha256({
    works: works.map(publicFileSnapshot),
    sessions: sessions.map(publicFileSnapshot),
  });
}

function planHash(plan: Omit<LegacyWorkspaceMigrationPlan, "planHashSha256">): string {
  return stableSha256(plan);
}

function sameTargetSnapshot(
  left: Readonly<MigrationTargetSnapshot>,
  right: Readonly<TargetWithBytes>,
): boolean {
  const publicRight = publicTargetSnapshot(right);
  return recordsEqual(
    { ...left, appliedSha256: undefined },
    { ...publicRight, appliedSha256: undefined },
  );
}

export class LegacyWorkspaceMigrationCoordinator {
  readonly config: LegacyWorkspaceMigrationConfig;
  readonly directories: LegacyWorkspaceMigrationDirectories;
  readonly state: WorkspaceMigrationStateStore;
  readonly #now: () => string;
  readonly #afterStep:
    | LegacyWorkspaceMigrationCoordinatorOptions["afterStep"]
    | undefined;

  constructor(
    config: Readonly<LegacyWorkspaceMigrationConfig>,
    options: Readonly<LegacyWorkspaceMigrationCoordinatorOptions> = {},
  ) {
    if (config.schemaVersion !== 1) {
      throw new Error("Legacy workspace migration config uses an unsupported schema version.");
    }
    assertIdentifier(config.migration.migrationId, "Migration ID");
    assertIdentifier(config.legacySessionOwnerAccountId, "Legacy session owner account ID");
    this.directories = resolvedDirectories(config.directories);
    if (new Set(Object.values(this.directories)).size !== Object.keys(this.directories).length) {
      throw new Error("Workspace migration data directories must be distinct.");
    }
    this.config = {
      ...structuredClone(config),
      directories: structuredClone(this.directories),
    };
    assertAdministrationMatchesMigration(this.config);
    this.state = new WorkspaceMigrationStateStore(this.directories.migrations);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#afterStep = options.afterStep;
  }

  async #step(step: LegacyWorkspaceMigrationStep, id: string): Promise<void> {
    await this.#afterStep?.(step, id);
  }

  #adminPath(): string {
    return safeFilePath(
      this.directories.workspaceAdmin,
      `${this.config.migration.tenantId}.json`,
    );
  }

  #projectPath(): string {
    const tenantDirectory = safeFilePath(
      this.directories.batchProjects,
      this.config.migration.tenantId,
    );
    return safeFilePath(tenantDirectory, `${this.config.migration.batchProjectId}.json`);
  }

  #taskPath(videoTaskId: string): string {
    assertIdentifier(videoTaskId, "Video task ID");
    return safeFilePath(this.directories.videoTasks, `${videoTaskId}.json`);
  }

  #sessionPath(sessionId: string): string {
    assertIdentifier(sessionId, "Session ID");
    return safeFilePath(this.directories.sessions, `${sessionId}.json`);
  }

  async #prepare(
    sourceDirectories: { works: string; sessions: string } = this.directories,
    originalAdministration: { bytes: Buffer | undefined } | undefined = undefined,
  ): Promise<PreparedMigration> {
    const workSources = await readWorkSources(sourceDirectories.works);
    const sessionSources = await readSessionSources(sourceDirectories.sessions);
    const workMigration = migrateLegacyWorkRecords(workSources.records, this.config.migration);
    assertAdministrationMatchesSnapshots(this.config, workMigration);
    const validationTaskStore = new LocalVideoTaskProductionStore(
      safeFilePath(this.directories.migrations, ".validation-video-tasks"),
      false,
    );
    for (const record of workMigration.taskRecords) {
      await validationTaskStore.save(structuredClone(record));
    }
    const sessionMigration = migrateLegacyAgentSessions({
      sessions: sessionSources.sessions,
      project: workMigration.project,
      taskRecords: workMigration.taskRecords,
      brandName: this.config.migration.brandName,
      legacySessionOwnerAccountId: this.config.legacySessionOwnerAccountId,
      taskOwnerDisplayName: this.config.taskOwnerDisplayName,
      legacyV3ScopeMappings: this.config.legacyV3SessionScopeMappings,
    });
    const seed = administrationSeed(this.config.administration);
    let currentAdministration: WorkspaceAdminState;
    if (originalAdministration?.bytes !== undefined) {
      currentAdministration = JSON.parse(
        originalAdministration.bytes.toString("utf8"),
      ) as WorkspaceAdminState;
      // Reuse the production Store validator without writing a temporary file.
      await new LocalWorkspaceAdminStore(
        safeFilePath(this.directories.migrations, ".validation-admin"),
        currentAdministration,
        false,
      ).load(this.config.migration.tenantId);
    } else if (originalAdministration !== undefined) {
      currentAdministration = await new LocalWorkspaceAdminStore(
        safeFilePath(this.directories.migrations, ".validation-admin-seed"),
        seed,
        false,
      ).load(this.config.migration.tenantId);
    } else {
      currentAdministration = await new LocalWorkspaceAdminStore(
        this.directories.workspaceAdmin,
        seed,
      ).load(this.config.migration.tenantId);
    }
    const nextAdministration = mergeAdministration(
      currentAdministration,
      this.config.administration,
    );
    await new LocalWorkspaceAdminStore(
      safeFilePath(this.directories.migrations, ".validation-admin-next"),
      nextAdministration,
      false,
    ).load(this.config.migration.tenantId);

    const projectMetadata = projectCreationMetadata(
      workMigration,
      this.config.migration.migrationActorAccountId,
    );
    const desiredProject: BatchProjectAggregate = {
      ...projectMetadata,
      project: structuredClone(workMigration.project),
      assetPool: structuredClone(workMigration.assetPool),
    };
    const taskMetadata = new Map<string, VideoTaskCreationMetadata>();
    for (const record of workMigration.taskRecords) {
      taskMetadata.set(
        record.videoTask.id,
        videoTaskCreationMetadata(
          workMigration,
          record,
          this.config.migration.migrationActorAccountId,
        ),
      );
    }

    const targets: TargetWithBytes[] = [];
    const adminPath = this.#adminPath();
    const currentAdminBytes = originalAdministration === undefined
      ? await existingBytes(adminPath)
      : originalAdministration.bytes;
    const adminSemanticallyEqual = currentAdminBytes !== undefined &&
      recordsEqual(currentAdministration, nextAdministration);
    targets.push(targetSnapshot(
      "workspace_admin",
      this.config.migration.tenantId,
      adminPath,
      currentAdminBytes,
      prettyJsonBytes(nextAdministration),
      `target-preimages/workspace-admin/${this.config.migration.tenantId}.json`,
      adminSemanticallyEqual,
    ));

    const projectStore = new LocalBatchProjectStore(this.directories.batchProjects);
    const persistedProject = await projectStore.loadByProjectId(workMigration.project.id);
    if (persistedProject !== undefined && !recordsEqual(persistedProject, desiredProject)) {
      throw new Error(`Migration target batch project '${workMigration.project.id}' already exists with different data.`);
    }
    const projects = await projectStore.list(workMigration.project.tenantId);
    for (const existing of projects) {
      if (existing.project.id === workMigration.project.id) continue;
      if (normalizedName(existing.project.name) === normalizedName(workMigration.project.name)) {
        throw new Error("Migration target batch project name conflicts with an existing project.");
      }
      if (
        existing.actorAccountId === projectMetadata.actorAccountId &&
        existing.requestId === projectMetadata.requestId
      ) {
        throw new Error("Migration target batch project request identity is already occupied.");
      }
    }
    const projectPath = this.#projectPath();
    const currentProjectBytes = await existingBytes(projectPath);
    targets.push(targetSnapshot(
      "batch_project",
      workMigration.project.id,
      projectPath,
      currentProjectBytes,
      prettyJsonBytes({ schemaVersion: 2, ...desiredProject }),
      `target-preimages/batch-projects/${this.config.migration.tenantId}/${workMigration.project.id}.json`,
      persistedProject !== undefined,
    ));

    const taskStore = new LocalVideoTaskProductionStore(this.directories.videoTasks);
    const existingProjectTasks = await taskStore.list(
      workMigration.project.tenantId,
      workMigration.project.id,
    );
    for (const record of workMigration.taskRecords) {
      const metadata = taskMetadata.get(record.videoTask.id)!;
      const existing = await taskStore.load(record.videoTask.id);
      const path = this.#taskPath(record.videoTask.id);
      const current = await existingBytes(path);
      let exactExisting = false;
      if (existing !== undefined) {
        const raw = current === undefined
          ? undefined
          : JSON.parse(current.toString("utf8")) as Record<string, unknown>;
        const creation = raw?._creation;
        if (!recordsEqual(existing, record) || !recordsEqual(creation, metadata)) {
          throw new Error(`Migration target video task '${record.videoTask.id}' already exists with different data.`);
        }
        exactExisting = true;
      }
      for (const candidate of existingProjectTasks) {
        if (candidate.videoTask.id === record.videoTask.id) continue;
        if (normalizedName(candidate.videoTask.name) === normalizedName(record.videoTask.name)) {
          throw new Error(`Migration target task name '${record.videoTask.name}' is already occupied.`);
        }
      }
      targets.push(targetSnapshot(
        "video_task",
        record.videoTask.id,
        path,
        current,
        prettyJsonBytes({ ...structuredClone(record), _creation: metadata }),
        `target-preimages/video-tasks/${record.videoTask.id}.json`,
        exactExisting,
      ));
    }

    const sourceSessionById = new Map(
      sessionSources.sessions.map((session) => [session.id, session] as const),
    );
    for (const session of sessionMigration.sessions) {
      const source = sourceSessionById.get(session.id);
      if (source === undefined) throw new Error(`Migrated session '${session.id}' has no source record.`);
      const path = this.#sessionPath(session.id);
      const current = await existingBytes(path);
      targets.push(targetSnapshot(
        "agent_session",
        session.id,
        path,
        current,
        prettyJsonBytes(session),
        `source-sessions/${session.id}.json`,
        recordsEqual(source, session),
      ));
    }

    const configHash = configFingerprint(this.config, this.directories);
    const sourceHash = sourceFingerprint(workSources.files, sessionSources.files);
    const publicTargets = targets.map(publicTargetSnapshot);
    const withoutHash: Omit<LegacyWorkspaceMigrationPlan, "planHashSha256"> = {
      schemaVersion: 1,
      migrationId: workMigration.migrationId,
      configurationFingerprintSha256: configHash,
      sourceFingerprintSha256: sourceHash,
      migrationFingerprintSha256: workMigration.summary.migrationFingerprintSha256,
      sources: {
        works: workSources.files.map(publicFileSnapshot),
        sessions: sessionSources.files.map(publicFileSnapshot),
      },
      targets: publicTargets,
      summary: {
        works: structuredClone(workMigration.summary),
        sessions: structuredClone(sessionMigration.summary),
        targetWriteCount: publicTargets.filter((target) => target.writeRequired).length,
      },
    };
    const plan: LegacyWorkspaceMigrationPlan = {
      ...withoutHash,
      planHashSha256: planHash(withoutHash),
    };
    return {
      configFingerprint: configHash,
      workMigration,
      sessionMigration,
      administrationState: nextAdministration,
      projectMetadata,
      taskMetadata,
      sources: { works: workSources.files, sessions: sessionSources.files },
      targets,
      plan,
    };
  }

  async plan(): Promise<LegacyWorkspaceMigrationPlan> {
    return structuredClone((await this.#prepare()).plan);
  }

  #backupRoot(): string {
    const root = resolve(join(
      this.directories.migrations,
      this.config.migration.migrationId,
      "backup",
    ));
    if (!root.startsWith(`${this.directories.migrations}${sep}`)) {
      throw new Error("Workspace migration backup path escaped the configured directory.");
    }
    return root;
  }

  #backupPath(relativePath: string): string {
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("/") ||
      relativePath.startsWith("\\") ||
      relativePath.split(/[\\/]/u).includes("..")
    ) {
      throw new Error("Workspace migration backup relative path is invalid.");
    }
    const root = this.#backupRoot();
    const path = resolve(join(root, relativePath));
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error("Workspace migration backup path escaped the configured directory.");
    }
    return path;
  }

  async #writeManifest(manifest: Readonly<LegacyWorkspaceMigrationManifest>): Promise<void> {
    await atomicWrite(
      this.state.manifestPath(manifest.migrationId),
      prettyJsonBytes(manifest),
    );
  }

  async loadManifest(): Promise<LegacyWorkspaceMigrationManifest | undefined> {
    const migrationId = this.config.migration.migrationId;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.state.manifestPath(migrationId), "utf8")) as unknown;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Workspace migration manifest '${migrationId}' cannot be read.`, {
        cause: error,
      });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Workspace migration manifest '${migrationId}' has an invalid format.`);
    }
    const manifest = parsed as LegacyWorkspaceMigrationManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.migrationId !== migrationId ||
      !["in_progress", "completed", "restored"].includes(manifest.status) ||
      manifest.plan?.schemaVersion !== 1 ||
      manifest.plan.migrationId !== migrationId ||
      !/^[a-f0-9]{64}$/u.test(manifest.plan.planHashSha256) ||
      !/^[a-f0-9]{64}$/u.test(manifest.plan.configurationFingerprintSha256) ||
      !Array.isArray(manifest.plan.sources?.works) ||
      !Array.isArray(manifest.plan.sources?.sessions) ||
      !Array.isArray(manifest.plan.targets)
    ) {
      throw new Error(`Workspace migration manifest '${migrationId}' has an invalid format.`);
    }
    const targetKeys = manifest.plan.targets.map((target) => `${target.kind}:${target.id}`);
    if (new Set(targetKeys).size !== targetKeys.length) {
      throw new Error(`Workspace migration manifest '${migrationId}' has duplicate targets.`);
    }
    return structuredClone(manifest);
  }

  async status(): Promise<LegacyWorkspaceMigrationManifest | undefined> {
    return this.loadManifest();
  }

  async #copyVerifiedBackup(
    sourcePath: string,
    snapshot: Pick<MigrationFileSnapshot, "sha256" | "size" | "backupRelativePath">,
  ): Promise<void> {
    const current = await readFile(sourcePath);
    if (current.byteLength !== snapshot.size || sha256(current) !== snapshot.sha256) {
      throw new Error(`Migration source '${sourcePath}' changed after planning.`);
    }
    const destination = this.#backupPath(snapshot.backupRelativePath);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(sourcePath, destination, COPYFILE_EXCL);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const copied = await readFile(destination);
    if (copied.byteLength !== snapshot.size || sha256(copied) !== snapshot.sha256) {
      throw new Error(`Migration backup '${snapshot.backupRelativePath}' failed checksum verification.`);
    }
  }

  async #createBackups(prepared: Readonly<PreparedMigration>): Promise<void> {
    for (const source of [...prepared.sources.works, ...prepared.sources.sessions]) {
      await this.#copyVerifiedBackup(source.path, source);
    }
    for (const target of prepared.targets) {
      const current = await existingBytes(target.path);
      if (!target.writeRequired) {
        if (
          current === undefined ||
          sha256(current) !== target.expectedPostimageSha256 ||
          current.byteLength !== target.expectedPostimageSize
        ) {
          throw new Error(`Migration target '${target.kind}:${target.id}' changed after planning.`);
        }
        continue;
      }
      if (!target.existed) {
        if (current !== undefined) {
          throw new Error(`Migration target '${target.kind}:${target.id}' appeared after planning.`);
        }
        continue;
      }
      if (
        current === undefined ||
        target.preimageSha256 === undefined ||
        target.preimageSize === undefined ||
        target.backupRelativePath === undefined ||
        sha256(current) !== target.preimageSha256 ||
        current.byteLength !== target.preimageSize
      ) {
        throw new Error(`Migration target '${target.kind}:${target.id}' changed after planning.`);
      }
      // Changed sessions are already backed up as source files.
      if (target.kind === "agent_session") {
        const backup = await readFile(this.#backupPath(target.backupRelativePath));
        if (sha256(backup) !== target.preimageSha256) {
          throw new Error(`Migration session backup '${target.id}' has an invalid checksum.`);
        }
      } else {
        await this.#copyVerifiedBackup(target.path, {
          sha256: target.preimageSha256,
          size: target.preimageSize,
          backupRelativePath: target.backupRelativePath,
        });
      }
    }
  }

  async #prepareResume(
    manifest: Readonly<LegacyWorkspaceMigrationManifest>,
  ): Promise<PreparedMigration> {
    if (manifest.plan.configurationFingerprintSha256 !== configFingerprint(this.config, this.directories)) {
      throw new Error("Workspace migration config conflicts with the in-progress manifest.");
    }
    for (const source of [...manifest.plan.sources.works, ...manifest.plan.sources.sessions]) {
      const bytes = await readFile(this.#backupPath(source.backupRelativePath));
      if (bytes.byteLength !== source.size || sha256(bytes) !== source.sha256) {
        throw new Error(`Workspace migration backup '${source.backupRelativePath}' is corrupt.`);
      }
    }
    const adminTarget = manifest.plan.targets.find(
      (target) => target.kind === "workspace_admin" && target.id === this.config.migration.tenantId,
    );
    if (adminTarget === undefined) {
      throw new Error("Workspace migration manifest is missing its administration target.");
    }
    const originalAdminBytes = adminTarget.existed && adminTarget.writeRequired
      ? await readFile(this.#backupPath(adminTarget.backupRelativePath!))
      : adminTarget.existed
        ? await readFile(this.#adminPath())
        : undefined;
    if (
      originalAdminBytes !== undefined &&
      adminTarget.preimageSha256 !== undefined &&
      sha256(originalAdminBytes) !== adminTarget.preimageSha256
    ) {
      throw new Error("Workspace migration administration backup is corrupt.");
    }
    const prepared = await this.#prepare(
      {
        works: this.#backupPath("source-works"),
        sessions: this.#backupPath("source-sessions"),
      },
      { bytes: originalAdminBytes },
    );
    if (
      prepared.workMigration.summary.migrationFingerprintSha256 !==
        manifest.plan.migrationFingerprintSha256 ||
      !recordsEqual(prepared.plan.summary.works, manifest.plan.summary.works) ||
      !recordsEqual(prepared.plan.summary.sessions, manifest.plan.summary.sessions)
    ) {
      throw new Error("Workspace migration backups no longer reproduce the recorded migration plan.");
    }
    const candidates = new Map(
      prepared.targets.map((target) => [`${target.kind}:${target.id}`, target] as const),
    );
    const targets: TargetWithBytes[] = [];
    for (const snapshot of manifest.plan.targets) {
      const candidate = candidates.get(`${snapshot.kind}:${snapshot.id}`);
      if (
        candidate === undefined ||
        sha256(candidate.expectedBytes) !== snapshot.expectedPostimageSha256 ||
        candidate.expectedBytes.byteLength !== snapshot.expectedPostimageSize
      ) {
        throw new Error(`Workspace migration target '${snapshot.kind}:${snapshot.id}' no longer reproduces its plan.`);
      }
      targets.push({
        ...structuredClone(snapshot),
        path: candidate.path,
        expectedBytes: candidate.expectedBytes,
      });
    }
    return {
      ...prepared,
      targets,
      plan: structuredClone(manifest.plan),
    };
  }

  async #assertTargetsReady(
    manifest: Readonly<LegacyWorkspaceMigrationManifest>,
    prepared: Readonly<PreparedMigration>,
  ): Promise<void> {
    for (const target of prepared.targets) {
      const current = await existingBytes(target.path);
      const currentHash = current === undefined ? undefined : sha256(current);
      if (!target.writeRequired) {
        if (
          currentHash !== target.expectedPostimageSha256 ||
          current?.byteLength !== target.expectedPostimageSize
        ) {
          throw new Error(`Unchanged migration target '${target.kind}:${target.id}' was modified.`);
        }
        continue;
      }
      if (currentHash === target.expectedPostimageSha256) continue;
      if (target.appliedSha256 !== undefined) {
        throw new Error(`Applied migration target '${target.kind}:${target.id}' was modified.`);
      }
      if (target.existed) {
        if (
          currentHash !== target.preimageSha256 ||
          current?.byteLength !== target.preimageSize
        ) {
          throw new Error(`Migration target '${target.kind}:${target.id}' no longer matches its preimage.`);
        }
      } else if (current !== undefined) {
        throw new Error(`Migration target '${target.kind}:${target.id}' was unexpectedly created.`);
      }
    }
    if (manifest.status !== "in_progress") {
      throw new Error("Only an in-progress workspace migration can write targets.");
    }
  }

  async #writeTarget(
    target: Readonly<TargetWithBytes>,
    prepared: Readonly<PreparedMigration>,
  ): Promise<void> {
    switch (target.kind) {
      case "workspace_admin": {
        const store = new LocalWorkspaceAdminStore(
          this.directories.workspaceAdmin,
          administrationSeed(this.config.administration),
        );
        await store.transact(this.config.migration.tenantId, () =>
          structuredClone(prepared.administrationState));
        return;
      }
      case "batch_project": {
        const saved = await new LocalBatchProjectStore(this.directories.batchProjects).create(
          prepared.workMigration.project,
          prepared.workMigration.assetPool,
          prepared.projectMetadata,
        );
        if (!recordsEqual(saved, {
          ...prepared.projectMetadata,
          project: prepared.workMigration.project,
          assetPool: prepared.workMigration.assetPool,
        })) {
          throw new Error("Workspace migration batch project replay returned different data.");
        }
        return;
      }
      case "video_task": {
        const record = prepared.workMigration.taskRecords.find(
          (candidate) => candidate.videoTask.id === target.id,
        );
        const metadata = prepared.taskMetadata.get(target.id);
        if (record === undefined || metadata === undefined) {
          throw new Error(`Workspace migration task '${target.id}' is missing from the prepared plan.`);
        }
        const saved = await new LocalVideoTaskProductionStore(
          this.directories.videoTasks,
        ).createWithResult(record, metadata);
        if (!recordsEqual(saved.record, record)) {
          throw new Error(`Workspace migration task '${target.id}' replay returned different data.`);
        }
        return;
      }
      case "agent_session": {
        const session = prepared.sessionMigration.sessions.find(
          (candidate) => candidate.id === target.id,
        );
        if (session === undefined) {
          throw new Error(`Workspace migration session '${target.id}' is missing from the prepared plan.`);
        }
        await new LocalSessionStore(this.directories.sessions).save(session);
        return;
      }
    }
  }

  async #applyTargets(
    manifest: LegacyWorkspaceMigrationManifest,
    prepared: Readonly<PreparedMigration>,
  ): Promise<void> {
    await this.#assertTargetsReady(manifest, prepared);
    for (const target of prepared.targets) {
      if (!target.writeRequired) continue;
      const current = await existingBytes(target.path);
      if (
        current !== undefined &&
        sha256(current) === target.expectedPostimageSha256 &&
        current.byteLength === target.expectedPostimageSize
      ) {
        target.appliedSha256 = target.expectedPostimageSha256;
      } else {
        await this.#writeTarget(target, prepared);
        const written = await readFile(target.path);
        if (
          written.byteLength !== target.expectedPostimageSize ||
          sha256(written) !== target.expectedPostimageSha256
        ) {
          throw new Error(`Workspace migration target '${target.kind}:${target.id}' failed postimage verification.`);
        }
        target.appliedSha256 = target.expectedPostimageSha256;
      }
      const persistedTarget = manifest.plan.targets.find(
        (candidate) => candidate.kind === target.kind && candidate.id === target.id,
      );
      if (persistedTarget === undefined) throw new Error("Workspace migration manifest target disappeared.");
      persistedTarget.appliedSha256 = target.expectedPostimageSha256;
      manifest.updatedAt = this.#now();
      await this.#writeManifest(manifest);
      const step: LegacyWorkspaceMigrationStep = target.kind === "workspace_admin"
        ? "workspace_admin_written"
        : target.kind === "batch_project"
          ? "batch_project_written"
          : target.kind === "video_task"
            ? "video_task_written"
            : "agent_session_written";
      await this.#step(step, target.id);
    }
  }

  async #verifyCompleted(prepared: Readonly<PreparedMigration>): Promise<void> {
    const freshAdmin = await new LocalWorkspaceAdminStore(
      this.directories.workspaceAdmin,
      administrationSeed(this.config.administration),
    ).load(this.config.migration.tenantId);
    if (!recordsEqual(freshAdmin, prepared.administrationState)) {
      throw new Error("Fresh workspace administration reload differs from the migration plan.");
    }
    const freshProject = await new LocalBatchProjectStore(
      this.directories.batchProjects,
    ).load(this.config.migration.tenantId, this.config.migration.batchProjectId);
    if (!recordsEqual(freshProject, {
      ...prepared.projectMetadata,
      project: prepared.workMigration.project,
      assetPool: prepared.workMigration.assetPool,
    })) {
      throw new Error("Fresh batch project reload differs from the migration plan.");
    }
    const taskStore = new LocalVideoTaskProductionStore(this.directories.videoTasks);
    for (const expected of prepared.workMigration.taskRecords) {
      const actual = await taskStore.load(expected.videoTask.id);
      if (!recordsEqual(actual, expected)) {
        throw new Error(`Fresh video task '${expected.videoTask.id}' reload differs from the migration plan.`);
      }
    }
    const sessionStore = new LocalSessionStore(this.directories.sessions);
    for (const expected of prepared.sessionMigration.sessions) {
      const actual = await sessionStore.load(expected.id);
      if (!recordsEqual(actual, expected)) {
        throw new Error(`Fresh Agent session '${expected.id}' reload differs from the migration plan.`);
      }
    }
    const currentWorks = await readWorkSources(this.directories.works);
    if (!recordsEqual(
      currentWorks.files.map(publicFileSnapshot),
      prepared.plan.sources.works,
    )) {
      throw new Error("Legacy Work source files changed during migration.");
    }
    for (const target of prepared.targets) {
      const current = await readFile(target.path);
      if (
        current.byteLength !== target.expectedPostimageSize ||
        sha256(current) !== target.expectedPostimageSha256
      ) {
        throw new Error(`Migration target '${target.kind}:${target.id}' failed final verification.`);
      }
    }
    await this.#step("verified", this.config.migration.migrationId);
  }

  async #run(
    expectedPlanHash: string,
    requireExisting: boolean,
  ): Promise<LegacyWorkspaceMigrationApplyResult> {
    if (!/^[a-f0-9]{64}$/u.test(expectedPlanHash)) {
      throw new Error("An exact 64-character migration plan hash is required.");
    }
    const lease = await this.state.acquireMigrationLease(this.config.migration.migrationId);
    try {
      let manifest = await this.loadManifest();
      if (manifest?.status === "completed") {
        if (
          manifest.plan.planHashSha256 !== expectedPlanHash ||
          manifest.plan.configurationFingerprintSha256 !== configFingerprint(this.config, this.directories)
        ) {
          throw new Error("Completed workspace migration conflicts with the requested plan.");
        }
        return { replayed: true, manifest };
      }
      if (manifest?.status === "restored") {
        throw new Error("A restored migration ID cannot be reused; choose a new migration ID.");
      }
      if (requireExisting && manifest === undefined) {
        throw new Error("Workspace migration cannot resume because no manifest exists.");
      }

      let prepared: PreparedMigration;
      if (manifest === undefined) {
        prepared = await this.#prepare();
        if (prepared.plan.planHashSha256 !== expectedPlanHash) {
          throw new Error(
            `Workspace migration plan changed; expected '${expectedPlanHash}', ` +
            `current '${prepared.plan.planHashSha256}'.`,
          );
        }
        await this.#createBackups(prepared);
        const now = this.#now();
        manifest = {
          schemaVersion: 1,
          migrationId: this.config.migration.migrationId,
          status: "in_progress",
          plan: structuredClone(prepared.plan),
          startedAt: now,
          updatedAt: now,
        };
        await this.#writeManifest(manifest);
        await this.#step("manifest_written", manifest.migrationId);
      } else {
        if (manifest.plan.planHashSha256 !== expectedPlanHash) {
          throw new Error("In-progress workspace migration conflicts with the requested plan hash.");
        }
        prepared = await this.#prepareResume(manifest);
        for (const target of prepared.targets) {
          const persisted = manifest.plan.targets.find(
            (candidate) => candidate.kind === target.kind && candidate.id === target.id,
          );
          if (persisted === undefined || !sameTargetSnapshot(persisted, target)) {
            throw new Error(`In-progress migration target '${target.kind}:${target.id}' conflicts with its manifest.`);
          }
        }
      }

      await this.#applyTargets(manifest, prepared);
      await this.#verifyCompleted(prepared);
      const completedAt = this.#now();
      manifest.status = "completed";
      manifest.updatedAt = completedAt;
      manifest.completedAt = completedAt;
      await this.#writeManifest(manifest);
      return { replayed: false, manifest: structuredClone(manifest) };
    } finally {
      await lease.release();
    }
  }

  async apply(expectedPlanHash: string): Promise<LegacyWorkspaceMigrationApplyResult> {
    return this.#run(expectedPlanHash, false);
  }

  async resume(expectedPlanHash: string): Promise<LegacyWorkspaceMigrationApplyResult> {
    return this.#run(expectedPlanHash, true);
  }

  async restore(): Promise<LegacyWorkspaceMigrationManifest> {
    const lease = await this.state.acquireMigrationLease(this.config.migration.migrationId);
    try {
      const manifest = await this.loadManifest();
      if (manifest === undefined) throw new Error("Workspace migration has no manifest to restore.");
      if (manifest.status === "restored") return manifest;
      if (
        manifest.plan.configurationFingerprintSha256 !== configFingerprint(this.config, this.directories)
      ) {
        throw new Error("Workspace migration restore config conflicts with its manifest.");
      }
      const changed = manifest.plan.targets.filter((target) => target.writeRequired);
      const restoreRequired = new Set<string>();
      for (const target of changed) {
        const path = this.#pathForTarget(target);
        const current = await existingBytes(path);
        const currentHash = current === undefined ? undefined : sha256(current);
        const alreadyPreimage = target.existed
          ? currentHash === target.preimageSha256 && current?.byteLength === target.preimageSize
          : current === undefined;
        if (alreadyPreimage) continue;
        if (
          currentHash !== target.expectedPostimageSha256 ||
          current?.byteLength !== target.expectedPostimageSize
        ) {
          throw new Error(
            `Workspace migration target '${target.kind}:${target.id}' changed after migration; restore refused.`,
          );
        }
        restoreRequired.add(`${target.kind}:${target.id}`);
      }
      for (const target of [...changed].reverse()) {
        if (!restoreRequired.has(`${target.kind}:${target.id}`)) continue;
        const path = this.#pathForTarget(target);
        if (target.existed) {
          if (
            target.backupRelativePath === undefined ||
            target.preimageSha256 === undefined ||
            target.preimageSize === undefined
          ) {
            throw new Error(`Workspace migration target '${target.kind}:${target.id}' lacks a restorable preimage.`);
          }
          const backup = await readFile(this.#backupPath(target.backupRelativePath));
          if (backup.byteLength !== target.preimageSize || sha256(backup) !== target.preimageSha256) {
            throw new Error(`Workspace migration backup for '${target.kind}:${target.id}' is corrupt.`);
          }
          await atomicWrite(path, backup);
        } else {
          await unlink(path).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        }
      }
      const restoredAt = this.#now();
      const restored: LegacyWorkspaceMigrationManifest = {
        ...manifest,
        status: "restored",
        updatedAt: restoredAt,
        restoredAt,
      };
      await this.#writeManifest(restored);
      return structuredClone(restored);
    } finally {
      await lease.release();
    }
  }

  #pathForTarget(target: Readonly<MigrationTargetSnapshot>): string {
    switch (target.kind) {
      case "workspace_admin":
        if (target.id !== this.config.migration.tenantId) {
          throw new Error("Workspace migration manifest has an unexpected administration target.");
        }
        return this.#adminPath();
      case "batch_project":
        if (target.id !== this.config.migration.batchProjectId) {
          throw new Error("Workspace migration manifest has an unexpected batch project target.");
        }
        return this.#projectPath();
      case "video_task":
        return this.#taskPath(target.id);
      case "agent_session":
        return this.#sessionPath(target.id);
    }
  }
}
