import {
  createScopedStageSuggestionContextReader,
  createScopedTaskAssetSnapshotReader,
  createArkSeedanceVideoGenerationProviderFromEnv,
  MockCompanyAssetProvider,
  type StageSuggestionContextReader,
  type StrategyDraftReader,
  type TaskAssetSnapshotReader,
} from "@firefly/tools";
import type { AgentSessionScope } from "@firefly/agent";
import type { TaskContext } from "@firefly/schemas";

import { AccountBudgetRuntime } from "./account-budget-runtime.ts";
import { AccountRunLockRuntime } from "./account-run-lock-runtime.ts";
import { GeneratedVideoArtifactImporter } from "./generated-video-artifact-importer.ts";
import {
  createAgentAssetMatchingCandidateReader,
  createCurrentProjectAssetPoolReader,
} from "./agent-asset-matching-candidates.ts";
import { AgentActionCommandRuntime } from "./agent-action-command-runtime.ts";
import { AssetMatchingRuntime } from "./asset-matching-runtime.ts";
import {
  BatchProjectAssetPoolStoreAdapter,
} from "./batch-project-store.ts";
import type { PostgresDatabaseConfig } from "./database-config.ts";
import {
  loadDatabaseMigrations,
  verifyDatabaseSchema,
  type DatabaseMigration,
} from "./database-migrations.ts";
import { PostgresAccountBudgetStore } from "./postgres-account-budget-store.ts";
import { PostgresAccountRunLockStore } from "./postgres-account-run-lock-store.ts";
import { PostgresBatchProjectStore } from "./postgres-batch-project-store.ts";
import type { PostgresTransactionProvider } from "./postgres-contract.ts";
import {
  createPostgresDatabase,
} from "./postgres-database.ts";
import { PostgresTemporaryAssetStore } from "./postgres-temporary-asset-store.ts";
import { PostgresVideoTaskProductionStore } from "./postgres-video-task-store.ts";
import { PostgresVideoGenerationStore } from "./postgres-video-generation-store.ts";
import { PostgresWorkspaceAdminStore } from "./postgres-workspace-admin-store.ts";
import { PostgresWorkspaceSessionStore } from "./postgres-workspace-session-store.ts";
import {
  type ProjectAssetCoordinator,
} from "./project-asset-coordinator.ts";
import { ProjectAssetRuntime } from "./project-asset-runtime.ts";
import { ProjectCreationRuntime } from "./project-creation-runtime.ts";
import { ProjectLibraryRuntime } from "./project-library-runtime.ts";
import { TemporaryAssetRuntime } from "./temporary-asset-runtime.ts";
import { VideoTaskRuntime } from "./video-task-runtime.ts";
import { VideoTaskStageRuntime } from "./video-task-stage-runtime.ts";
import { VideoGenerationRuntime } from "./video-generation-runtime.ts";
import { WorkspaceAdminRuntime } from "./workspace-admin-runtime.ts";
import { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";
import {
  createWorkspaceStrategyDraftReader,
  createWorkspaceTaskVehicleService,
  readWorkspaceTaskPolicyStatus,
  WorkspaceTaskContextResolver,
} from "./workspace-task-context.ts";

export interface PostgresApiDatabase extends PostgresTransactionProvider {
  ping(): Promise<void>;
  close(): Promise<void>;
}

function assertBatchProjectId(batchProjectId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(batchProjectId)) {
    throw new Error("Batch project ID contains invalid characters.");
  }
}

const coordinatedAssetOperationTails = new Map<string, Promise<void>>();

async function runOneCoordinatedAssetOperation<Result>(
  batchProjectId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = coordinatedAssetOperationTails.get(batchProjectId) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  coordinatedAssetOperationTails.set(batchProjectId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (coordinatedAssetOperationTails.get(batchProjectId) === tail) {
      coordinatedAssetOperationTails.delete(batchProjectId);
    }
  }
}

/**
 * Holds a PostgreSQL transaction-scoped advisory lock for the complete asset
 * operation. PostgresDatabase propagates this root transaction through nested
 * Store calls, so the coordinated cross-Store write uses one checked-out
 * client and commits or rolls back as a unit.
 */
export class PostgresProjectAssetCoordinator implements ProjectAssetCoordinator {
  constructor(private readonly database: PostgresTransactionProvider) {}

  async runExclusive<Result>(
    batchProjectId: string,
    operation: () => Result | Promise<Result>,
  ): Promise<Result> {
    assertBatchProjectId(batchProjectId);
    return runOneCoordinatedAssetOperation(batchProjectId, () =>
      this.database.transaction(async (transaction) => {
        await transaction.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`project_assets:${batchProjectId}`],
        );
        return operation();
      })
    );
  }
}

export interface PostgresApiRuntime {
  readonly database: PostgresApiDatabase;
  readonly workspaceSessions: WorkspaceSessionRuntime;
  readonly workspaceAdmin: WorkspaceAdminRuntime;
  readonly projectCreation: ProjectCreationRuntime;
  readonly videoTasks: VideoTaskRuntime;
  readonly videoTaskStages: VideoTaskStageRuntime;
  readonly projectLibrary: ProjectLibraryRuntime;
  readonly agentActionCommands: AgentActionCommandRuntime;
  readonly projectAssets: ProjectAssetRuntime;
  readonly temporaryAssets: TemporaryAssetRuntime;
  readonly assetMatching: AssetMatchingRuntime;
  readonly accountRunLocks: AccountRunLockRuntime;
  readonly videoGenerations?: VideoGenerationRuntime;
  readonly videoGenerationArtifacts?: GeneratedVideoArtifactImporter;
  readonly assetCoordinator: PostgresProjectAssetCoordinator;
  readonly taskContexts: WorkspaceTaskContextResolver;
  readonly resolveWorkStatus: (
    taskContext: Parameters<typeof readWorkspaceTaskPolicyStatus>[1],
    sessionScope: Parameters<typeof createWorkspaceTaskVehicleService>[2],
  ) => ReturnType<typeof readWorkspaceTaskPolicyStatus>;
  readonly resolveVehicleService: (
    taskContext: Parameters<typeof createWorkspaceTaskVehicleService>[1],
    sessionScope: Parameters<typeof createWorkspaceTaskVehicleService>[2],
  ) => ReturnType<typeof createWorkspaceTaskVehicleService>;
  readonly resolveTaskAssetReader: (
    taskContext: Readonly<TaskContext>,
    sessionScope: Readonly<AgentSessionScope>,
  ) => TaskAssetSnapshotReader | undefined;
  readonly resolveStageSuggestionReader: (
    taskContext: Readonly<TaskContext>,
    sessionScope: Readonly<AgentSessionScope>,
  ) => StageSuggestionContextReader | undefined;
  readonly resolveStrategyDraftReader: (
    taskContext: Readonly<TaskContext>,
    sessionScope: Readonly<AgentSessionScope>,
  ) => StrategyDraftReader | undefined;
  readiness(): Promise<void>;
  close(): Promise<void>;
}

export interface CreatePostgresApiRuntimeOptions {
  readonly database?: PostgresApiDatabase;
  readonly migrations?: readonly DatabaseMigration[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function unavailablePricingProvider() {
  return {
    async estimate(): Promise<never> {
      throw new Error("High-cost pricing is unavailable from workspace administration routes.");
    },
  };
}

function videoGenerationPricingProvider(environment: Readonly<Record<string, string | undefined>>) {
  const amountMinor = Number.parseInt(environment.VIDEO_GENERATION_ESTIMATE_MINOR ?? "1000", 10);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    throw new Error("VIDEO_GENERATION_ESTIMATE_MINOR must be a positive integer.");
  }
  return {
    async estimate(_task: unknown, operation: string, estimatedAt: string) {
      if (operation !== "video_generation") {
        return unavailablePricingProvider().estimate();
      }
      return {
        amountMinor,
        currency: "CNY" as const,
        pricingVersion: environment.VIDEO_GENERATION_PRICING_VERSION ?? "seedance_2_5_fixed_v1",
        expiresAt: new Date(Date.parse(estimatedAt) + 10 * 60 * 1000).toISOString(),
      };
    },
  };
}

export async function createPostgresApiRuntime(
  config: PostgresDatabaseConfig,
  options: Readonly<CreatePostgresApiRuntimeOptions> = {},
): Promise<PostgresApiRuntime> {
  const database: PostgresApiDatabase = options.database ?? createPostgresDatabase(config);
  const environment = options.environment ?? process.env;
  try {
    const migrations = options.migrations ?? await loadDatabaseMigrations();
    const readiness = async (): Promise<void> => {
      await database.ping();
      await verifyDatabaseSchema(database, migrations);
    };
    await readiness();

    const administrationStore = new PostgresWorkspaceAdminStore(database);
    const sessionStore = new PostgresWorkspaceSessionStore(database);
    const budgetStore = new PostgresAccountBudgetStore(database);
    const projectStore = new PostgresBatchProjectStore(database);
    const videoTaskStore = new PostgresVideoTaskProductionStore(database);
    const temporaryAssetStore = new PostgresTemporaryAssetStore(database);
    const runLockStore = new PostgresAccountRunLockStore(database);
    const companyAssets = new MockCompanyAssetProvider();
    const assetPools = new BatchProjectAssetPoolStoreAdapter(projectStore);
    const assetCoordinator = new PostgresProjectAssetCoordinator(database);

    const workspaceSessions = new WorkspaceSessionRuntime(sessionStore, administrationStore);
    const accountBudgets = new AccountBudgetRuntime(budgetStore, videoGenerationPricingProvider(environment));
    const workspaceAdmin = new WorkspaceAdminRuntime(
      administrationStore,
      accountBudgets,
      companyAssets,
      () => workspaceSessions.listDevelopmentAccounts(),
    );
    const projectCreation = new ProjectCreationRuntime(
      administrationStore,
      projectStore,
      companyAssets,
    );
    const videoTasks = new VideoTaskRuntime(
      administrationStore,
      projectStore,
      videoTaskStore,
      () => workspaceSessions.listDevelopmentAccounts(),
    );
    const projectLibrary = new ProjectLibraryRuntime(
      administrationStore,
      projectStore,
      videoTaskStore,
    );
    const taskContexts = new WorkspaceTaskContextResolver(
      administrationStore,
      projectStore,
      videoTaskStore,
      (tenantId, accountId) => workspaceSessions.listDevelopmentAccounts().find(
        (account) => account.tenantId === tenantId && account.accountId === accountId,
      )?.displayName,
    );
    const temporaryAssets = new TemporaryAssetRuntime(
      temporaryAssetStore,
      assetPools,
      undefined,
      undefined,
      assetCoordinator,
    );
    const projectAssets = new ProjectAssetRuntime(
      companyAssets,
      assetPools,
      undefined,
      temporaryAssetStore,
      assetCoordinator,
    );
    const videoTaskStages = new VideoTaskStageRuntime(
      administrationStore,
      projectStore,
      videoTaskStore,
      undefined,
      undefined,
      projectAssets,
    );
    const assetMatching = new AssetMatchingRuntime(
      administrationStore,
      projectStore,
      videoTaskStore,
      companyAssets,
      projectAssets,
      temporaryAssets,
      videoTaskStages,
    );
    const agentActionCommands = new AgentActionCommandRuntime(
      administrationStore,
      projectStore,
      videoTaskStore,
      undefined,
      undefined,
      assetCoordinator,
    );
    const accountRunLocks = new AccountRunLockRuntime(runLockStore);
    const videoGenerationArtifacts = environment.ARK_API_KEY === undefined
      ? undefined
      : new GeneratedVideoArtifactImporter(
          environment.GENERATED_VIDEO_DATA_DIRECTORY ?? ".data/generated-videos",
          projectStore,
          videoTaskStore,
        );
    const videoGenerations = videoGenerationArtifacts === undefined
      ? undefined
      : new VideoGenerationRuntime(
          administrationStore,
          projectStore,
          videoTaskStore,
          new PostgresVideoGenerationStore(database),
          createArkSeedanceVideoGenerationProviderFromEnv(environment, {
            artifactImporter: videoGenerationArtifacts,
          }),
          accountRunLocks,
          accountBudgets,
          videoGenerationArtifacts,
        );

    return Object.freeze({
      database,
      workspaceSessions,
      workspaceAdmin,
      projectCreation,
      videoTasks,
      videoTaskStages,
      projectLibrary,
      agentActionCommands,
      projectAssets,
      temporaryAssets,
      assetMatching,
      accountRunLocks,
      ...(videoGenerations === undefined ? {} : { videoGenerations }),
      ...(videoGenerationArtifacts === undefined ? {} : { videoGenerationArtifacts }),
      assetCoordinator,
      taskContexts,
      resolveWorkStatus: (
        taskContext: Parameters<typeof readWorkspaceTaskPolicyStatus>[1],
        sessionScope: Parameters<typeof createWorkspaceTaskVehicleService>[2],
      ) => readWorkspaceTaskPolicyStatus(
        videoTaskStore,
        taskContext,
        sessionScope.tenantId,
      ),
      resolveVehicleService: (
        taskContext: Parameters<typeof createWorkspaceTaskVehicleService>[1],
        sessionScope: Parameters<typeof createWorkspaceTaskVehicleService>[2],
      ) => createWorkspaceTaskVehicleService(videoTaskStore, taskContext, sessionScope),
      resolveTaskAssetReader: (
        taskContext: Readonly<TaskContext>,
        sessionScope: Readonly<AgentSessionScope>,
      ) => taskContext.videoTask.assetSnapshotId === undefined
        ? undefined
        : createScopedTaskAssetSnapshotReader({
            taskContext,
            store: videoTaskStore,
            provider: companyAssets,
            providerScope: {
              tenantId: sessionScope.tenantId,
              actorAccountId: sessionScope.actorId,
              allowedBrandIds: [taskContext.brand.id],
              allowedVehicleIds: [taskContext.vehicle.id],
            },
          }),
      resolveStageSuggestionReader: (
        taskContext: Readonly<TaskContext>,
        sessionScope: Readonly<AgentSessionScope>,
      ) => ["script", "asset_matching", "storyboard", "delivery"].includes(
          taskContext.videoTask.currentStage,
        )
        ? createScopedStageSuggestionContextReader({
            taskContext,
            tenantId: sessionScope.tenantId,
            store: videoTaskStore,
            ...(taskContext.videoTask.currentStage !== "asset_matching"
              ? {}
              : {
                  assetMatchingCandidateReader: createAgentAssetMatchingCandidateReader({
                    taskContext,
                    currentProjectAssetPool: createCurrentProjectAssetPoolReader({
                      taskContext,
                      administration: administrationStore,
                      projects: projectStore,
                      projectAssets,
                      actor: {
                        tenantId: sessionScope.tenantId,
                        accountId: sessionScope.actorId,
                        role: workspaceSessions.listDevelopmentAccounts().find(
                          (account) =>
                            account.tenantId === sessionScope.tenantId &&
                            account.accountId === sessionScope.actorId,
                        )?.role,
                      },
                    }),
                    temporaryAssets: temporaryAssetStore,
                    companyAssets,
                    companyAssetScope: {
                      tenantId: sessionScope.tenantId,
                      actorAccountId: sessionScope.actorId,
                      allowedBrandIds: [taskContext.brand.id],
                      allowedVehicleIds: [taskContext.vehicle.id],
                    },
                  }),
                }),
          })
        : undefined,
      resolveStrategyDraftReader: (
        taskContext: Readonly<TaskContext>,
        sessionScope: Readonly<AgentSessionScope>,
      ) => ["strategy", "script"].includes(taskContext.videoTask.currentStage)
        ? createWorkspaceStrategyDraftReader(videoTaskStore, taskContext, sessionScope)
        : undefined,
      readiness,
      close: () => database.close(),
    });
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}
