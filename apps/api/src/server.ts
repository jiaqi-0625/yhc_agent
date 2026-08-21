import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { loadLocalAgentConfig, LocalAgentRuntime } from "@firefly/agent";
import {
  createScopedStageSuggestionContextReader,
  createScopedTaskAssetSnapshotReader,
  MockCompanyAssetProvider,
} from "@firefly/tools";

import { AccountBudgetRuntime } from "./account-budget-runtime.ts";
import { LocalAccountBudgetStore } from "./account-budget-store.ts";
import { AccountRunLockRuntime } from "./account-run-lock-runtime.ts";
import { LocalAccountRunLockStore } from "./account-run-lock-store.ts";
import {
  createAgentAssetMatchingCandidateReader,
  createCurrentProjectAssetPoolReader,
} from "./agent-asset-matching-candidates.ts";
import {
  handleAgentActionCommandRoute,
  matchAgentActionCommandPath,
} from "./agent-action-command-routes.ts";
import { AgentActionCommandRuntime } from "./agent-action-command-runtime.ts";
import { handleAssetMatchingRoute, matchesAssetRoute } from "./asset-matching-routes.ts";
import { AssetMatchingRuntime } from "./asset-matching-runtime.ts";
import {
  handleAgentRoute,
  type AgentIdentityResolver,
  type AgentTaskContextResolver,
} from "./agent-routes.ts";
import {
  BatchProjectAssetPoolStoreAdapter,
  LocalBatchProjectStore,
} from "./batch-project-store.ts";
import {
  createBusinessAgentRuntime,
  isMigrationSafeAgentRuntime,
} from "./business-agent-runtime.ts";
import { BusinessRuntimeError, LocalBusinessRuntime } from "./business-runtime.ts";
import { parsePostgresDatabaseConfig, type PostgresDatabaseConfig } from "./database-config.ts";
import {
  DevelopmentCompanyAssetMediaStore,
  type DevelopmentCompanyAssetMediaReader,
} from "./development-company-asset-media.ts";
import { LOCAL_SCOPE } from "./golden-sample.ts";
import { sendJson, sendRequestError } from "./http-boundary.ts";
import {
  createPostgresApiRuntime,
  type PostgresApiRuntime,
} from "./postgres-api-runtime.ts";
import {
  handleProjectLibraryRoute,
  ProjectLibraryPath,
} from "./project-library-routes.ts";
import { ProjectLibraryRuntime } from "./project-library-runtime.ts";
import { ProjectAssetRuntime } from "./project-asset-runtime.ts";
import { handleProjectCreationRoute } from "./project-creation-routes.ts";
import { ProjectCreationRuntime } from "./project-creation-runtime.ts";
import { handleVideoTaskRoute } from "./video-task-routes.ts";
import { VideoTaskRuntime } from "./video-task-runtime.ts";
import {
  handleVideoTaskStageRoute,
  matchVideoTaskStagePath,
} from "./video-task-stage-routes.ts";
import { VideoTaskStageRuntime } from "./video-task-stage-runtime.ts";
import { LocalVideoTaskProductionStore } from "./video-task-store.ts";
import { LocalTemporaryAssetStore } from "./temporary-asset-store.ts";
import { TemporaryAssetRuntime } from "./temporary-asset-runtime.ts";
import { sendWebAsset } from "./web-assets.ts";
import { handleMockCompanyAssetMediaRoute } from "./mock-company-asset-routes.ts";
import { handleWorkspaceAdminRoute } from "./workspace-admin-routes.ts";
import {
  DEFAULT_ADMIN_BRANDS,
  DEFAULT_ADMIN_VEHICLES,
  DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
  WorkspaceAdminRuntime,
} from "./workspace-admin-runtime.ts";
import { LocalWorkspaceAdminStore } from "./workspace-admin-store.ts";
import { handleWorkspaceRoute } from "./workspace-routes.ts";
import {
  handleWorkspaceSessionRoute,
  readOptionalWorkspaceBearer,
} from "./workspace-session-routes.ts";
import {
  DEVELOPMENT_ACCESS_GRANTS,
  WorkspaceSessionRuntime,
} from "./workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "./workspace-session-store.ts";
import { WorkspaceMigrationStateStore } from "./workspace-migration-state.ts";
import {
  handleWorkspaceProductionStatusRoute,
  WorkspaceProductionStatusPath,
} from "./workspace-production-status-routes.ts";
import {
  createWorkspaceTaskVehicleService,
  readWorkspaceTaskPolicyStatus,
  WorkspaceTaskContextResolver,
} from "./workspace-task-context.ts";

const version = "0.1.0";
export type ApiReadinessProbe = () => Promise<void>;

const alwaysReady: ApiReadinessProbe = async () => undefined;
const resolveLocalAgentIdentity: AgentIdentityResolver = () => ({
  actorId: LOCAL_SCOPE.actorId,
  tenantId: LOCAL_SCOPE.tenantId,
});

function createWorkspaceAgentIdentityResolver(
  workspaceSessions: WorkspaceSessionRuntime,
  legacyLocalAccessEnabled: boolean,
): AgentIdentityResolver {
  return async (request) => {
    const bearer = readOptionalWorkspaceBearer(request);
    if (bearer !== undefined) {
      const session = await workspaceSessions.resolveSession(bearer);
      return {
        actorId: session.scope.actorAccountId,
        tenantId: session.scope.tenantId,
      };
    }
    if (legacyLocalAccessEnabled) return resolveLocalAgentIdentity(request);
    throw new BusinessRuntimeError(
      "AIC-AUTH-SESSION_REQUIRED",
      "A valid workspace bearer session is required.",
      401,
    );
  };
}

function developmentAccountsAllowed(
  host: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (environment.NODE_ENV === "production") return false;
  if (["127.0.0.1", "::1", "localhost"].includes(host)) return true;
  return environment.FIREFLY_ENABLE_DEVELOPMENT_ACCOUNTS === "true";
}

export function createDevelopmentCompanyAssetMediaStore(
  host: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DevelopmentCompanyAssetMediaStore | undefined {
  if (environment.NODE_ENV === "production") return undefined;
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (!loopback && environment.FIREFLY_ENABLE_DEVELOPMENT_ASSET_MEDIA !== "true") {
    return undefined;
  }
  return new DevelopmentCompanyAssetMediaStore(
    environment.MOCK_COMPANY_ASSET_MEDIA_DIRECTORY ?? ".data/mock-company-assets",
  );
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: LocalAgentRuntime,
  business: LocalBusinessRuntime,
  resolveAgentIdentity: AgentIdentityResolver,
  workspaceSessions: WorkspaceSessionRuntime,
  resolveAgentTaskContext: AgentTaskContextResolver | undefined,
  workspaceAdmin: WorkspaceAdminRuntime | undefined,
  projectCreation: ProjectCreationRuntime | undefined,
  videoTasks: VideoTaskRuntime | undefined,
  agentActionCommands: AgentActionCommandRuntime | undefined,
  videoTaskStages: VideoTaskStageRuntime | undefined,
  developmentAccountsEnabled: boolean,
  legacyLocalAccessEnabled: boolean,
  projectLibrary: ProjectLibraryRuntime | undefined,
  legacyWritesDisabled: boolean,
  readiness: ApiReadinessProbe,
  assetMatching: AssetMatchingRuntime | undefined,
  accountRunLocks: AccountRunLockRuntime | undefined,
  developmentCompanyAssetMedia: DevelopmentCompanyAssetMediaReader | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && (await sendWebAsset(response, url.pathname))) return;
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "firefly-ad-agent-api", version });
    return;
  }
  if (request.method === "GET" && url.pathname === "/ready") {
    try {
      await readiness();
      sendJson(response, 200, { status: "ready", service: "firefly-ad-agent-api", version });
    } catch {
      sendJson(response, 503, {
        status: "unavailable",
        service: "firefly-ad-agent-api",
        version,
      });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/meta") {
    sendJson(response, 200, {
      service: "firefly-ad-agent-api",
      version,
      maturity: "strategy-vertical-slice",
      capabilities: [
        "local_chat",
        "streaming_chat",
        "session_persistence",
        "lifecycle_events",
        "request_cancellation",
        "vehicle_snapshot",
        "strategy_draft",
        "human_strategy_approval",
        "work_bound_agent",
        "task_context_v1",
        ...(projectLibrary === undefined ? [] : ["project_library_v1"]),
      ],
      domainTools: [
        "get_vehicle_snapshot",
        "validate_vehicle_claims",
        "propose_strategy_generation",
        "validate_strategy",
        "propose_strategy_approval",
      ],
      agentDomainToolsLoaded: runtime.domainToolsAvailable,
      model: runtime.publicConfig(),
      boundaries: {
        publishesAds: false,
        modelCanApprove: false,
        genericToolsEnabled: false,
      },
    });
    return;
  }

  if (
    await handleWorkspaceSessionRoute(
      request,
      response,
      url,
      workspaceSessions,
      developmentAccountsEnabled,
    )
  ) return;
  if (
    developmentCompanyAssetMedia !== undefined &&
    await handleMockCompanyAssetMediaRoute(
      request,
      response,
      url,
      developmentCompanyAssetMedia,
      workspaceSessions,
    )
  ) return;
  if (
    projectLibrary === undefined &&
    url.pathname === ProjectLibraryPath
  ) {
    throw new BusinessRuntimeError(
      "AIC-PROJECT-LIBRARY-RUNTIME-NOT-CONFIGURED",
      "Project library APIs must be injected with the custom workspace session runtime.",
      503,
    );
  }
  if (
    projectLibrary !== undefined &&
    await handleProjectLibraryRoute(
      request,
      response,
      url,
      projectLibrary,
      workspaceSessions,
    )
  ) return;
  if (
    projectCreation === undefined &&
    (
      url.pathname.startsWith("/v1/workspace/project-creation/") ||
      url.pathname === "/v1/workspace/batch-projects"
    )
  ) {
    throw new BusinessRuntimeError(
      "AIC-PROJECT-CREATION-RUNTIME_NOT_CONFIGURED",
      "Project creation must be injected with the custom workspace session runtime.",
      503,
    );
  }
  if (
    projectCreation !== undefined &&
    await handleProjectCreationRoute(
      request,
      response,
      url,
      projectCreation,
      workspaceSessions,
    )
  ) return;
  if (
    videoTaskStages === undefined &&
    matchVideoTaskStagePath(url.pathname) !== undefined
  ) {
    throw new BusinessRuntimeError(
      "AIC-VIDEO-TASK-STAGE-RUNTIME_NOT_CONFIGURED",
      "Video task stage APIs must be injected with the custom workspace session runtime.",
      503,
    );
  }
  if (
    videoTaskStages !== undefined &&
    await handleVideoTaskStageRoute(
      request,
      response,
      url,
      videoTaskStages,
      workspaceSessions,
      developmentAccountsEnabled,
    )
  ) return;
  if (
    agentActionCommands === undefined &&
    matchAgentActionCommandPath(url.pathname) !== undefined
  ) {
    throw new BusinessRuntimeError(
      "AIC-AGENT-COMMAND-RUNTIME_NOT_CONFIGURED",
      "Agent action commands must be injected with the custom workspace session runtime.",
      503,
    );
  }
  if (
    agentActionCommands !== undefined &&
    await handleAgentActionCommandRoute(
      request,
      response,
      url,
      agentActionCommands,
      workspaceSessions,
    )
  ) return;
  if (
    videoTasks === undefined &&
    url.pathname.startsWith("/v1/workspace/batch-projects/") &&
    url.pathname.includes("/video-tasks")
  ) {
    throw new BusinessRuntimeError(
      "AIC-VIDEO-TASK-RUNTIME_NOT_CONFIGURED",
      "Video task APIs must be injected with the custom workspace session runtime.",
      503,
    );
  }
  if (
    videoTasks !== undefined &&
    await handleVideoTaskRoute(request, response, url, videoTasks, workspaceSessions)
  ) return;
  if (
    workspaceAdmin === undefined &&
    (url.pathname.startsWith("/v1/admin/") || url.pathname === "/v1/workspace/me/budget")
  ) {
    throw new BusinessRuntimeError(
      "AIC-ADMIN-RUNTIME_NOT_CONFIGURED",
      "Workspace administration must be injected with the custom session runtime.",
      503,
    );
  }
  if (
    workspaceAdmin !== undefined &&
    await handleWorkspaceAdminRoute(
      request,
      response,
      url,
      workspaceAdmin,
      workspaceSessions,
    )
  ) return;
  if (
    accountRunLocks === undefined &&
    url.pathname === WorkspaceProductionStatusPath
  ) {
    throw new BusinessRuntimeError(
      "AIC-PRODUCTION-STATUS-RUNTIME-NOT-CONFIGURED",
      "Production status must be injected with the custom workspace session runtime.",
      503,
    );
  }
  if (
    accountRunLocks !== undefined &&
    await handleWorkspaceProductionStatusRoute(
      request,
      response,
      url,
      accountRunLocks,
      workspaceSessions,
    )
  ) return;
  if (
    assetMatching === undefined &&
    matchesAssetRoute(url.pathname)
  ) {
    throw new BusinessRuntimeError(
      "AIC-ASSET-MATCHING-RUNTIME_NOT_CONFIGURED",
      "Asset matching APIs must be injected with the custom workspace session runtime.",
      503,
    );
  }
  if (
    assetMatching !== undefined &&
    await handleAssetMatchingRoute(request, response, url, assetMatching, workspaceSessions)
  ) return;
  if (
    await handleWorkspaceRoute(
      request,
      response,
      url,
      business,
      legacyLocalAccessEnabled,
      legacyWritesDisabled,
    )
  ) return;
  if (
    await handleAgentRoute(
      request,
      response,
      url,
      runtime,
      business,
      resolveAgentIdentity,
      legacyLocalAccessEnabled,
      resolveAgentTaskContext,
    )
  ) return;

  sendJson(response, 404, {
    code: "AIC-API-NOT_FOUND",
    message: "Endpoint not found.",
    retryable: false,
    charged: false,
  });
}

export function createApiServer(
  runtime: LocalAgentRuntime | undefined = undefined,
  business = new LocalBusinessRuntime(),
  resolveAgentIdentity: AgentIdentityResolver | undefined = undefined,
  workspaceSessions: WorkspaceSessionRuntime | undefined = undefined,
  developmentAccountsEnabled = false,
  legacyLocalAccessEnabled = false,
  workspaceAdmin: WorkspaceAdminRuntime | undefined = undefined,
  projectCreation: ProjectCreationRuntime | undefined = undefined,
  videoTasks: VideoTaskRuntime | undefined = undefined,
  agentActionCommands: AgentActionCommandRuntime | undefined = undefined,
  videoTaskStages: VideoTaskStageRuntime | undefined = undefined,
  projectLibrary: ProjectLibraryRuntime | undefined = undefined,
  legacyWritesDisabled = false,
  resolveAgentTaskContext: AgentTaskContextResolver | undefined = undefined,
  readiness: ApiReadinessProbe = alwaysReady,
  assetMatching: AssetMatchingRuntime | undefined = undefined,
  accountRunLocks: AccountRunLockRuntime | undefined = undefined,
  developmentCompanyAssetMedia: DevelopmentCompanyAssetMediaReader | undefined = undefined,
): Server {
  if (
    legacyWritesDisabled &&
    runtime !== undefined &&
    !isMigrationSafeAgentRuntime(runtime)
  ) {
    throw new BusinessRuntimeError(
      "AIC-AGENT-TASK_CONTEXT_RUNTIME_NOT_CONFIGURED",
      "A completed Workspace migration cannot use an Agent runtime with unverified V1 dependencies.",
      503,
    );
  }
  if (
    workspaceSessions === undefined &&
    (
      workspaceAdmin !== undefined ||
      projectCreation !== undefined ||
      videoTasks !== undefined ||
      agentActionCommands !== undefined ||
      videoTaskStages !== undefined ||
      projectLibrary !== undefined ||
      accountRunLocks !== undefined
    )
  ) {
    throw new Error("A custom workspace runtime requires its matching session runtime.");
  }
  const adminStore = workspaceSessions === undefined
    ? new LocalWorkspaceAdminStore(
        process.env.WORKSPACE_ADMIN_DATA_DIRECTORY ?? ".data/workspace-admin",
        {
          brands: DEFAULT_ADMIN_BRANDS,
          vehicleVersions: DEFAULT_ADMIN_VEHICLES,
          vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
          accessGrants: DEVELOPMENT_ACCESS_GRANTS,
        },
      )
    : undefined;
  const activeWorkspaceSessions = workspaceSessions ?? new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(
      process.env.WORKSPACE_SESSION_DATA_DIRECTORY ?? ".data/workspace-sessions",
    ),
    adminStore!,
  );
  const companyAssetProvider = new MockCompanyAssetProvider();
  const activeAccountRunLocks = accountRunLocks ?? (
    workspaceSessions === undefined
      ? new AccountRunLockRuntime(
          new LocalAccountRunLockStore(
            process.env.ACCOUNT_RUN_LOCK_DATA_DIRECTORY ?? ".data/account-run-locks",
          ),
        )
      : undefined
  );
  const activeWorkspaceAdmin = workspaceAdmin ?? (adminStore === undefined ? undefined : new WorkspaceAdminRuntime(
    adminStore,
    new AccountBudgetRuntime(
      new LocalAccountBudgetStore(
        process.env.ACCOUNT_BUDGET_DATA_DIRECTORY ?? ".data/account-budgets",
      ),
      {
        async estimate() {
          throw new Error("High-cost pricing is unavailable from workspace administration routes.");
        },
      },
    ),
    companyAssetProvider,
    () => activeWorkspaceSessions.listDevelopmentAccounts(),
  ));
  const batchProjectStore = adminStore === undefined ? undefined : new LocalBatchProjectStore(
    process.env.BATCH_PROJECT_DATA_DIRECTORY ?? ".data/batch-projects",
  );
  const activeProjectCreation = projectCreation ?? (adminStore === undefined ? undefined : new ProjectCreationRuntime(
    adminStore,
    batchProjectStore!,
    companyAssetProvider,
  ));
  const videoTaskStore = adminStore === undefined ? undefined : new LocalVideoTaskProductionStore(
    process.env.VIDEO_TASK_DATA_DIRECTORY ?? ".data/video-tasks",
  );
  const temporaryAssetStore = adminStore === undefined ? undefined : new LocalTemporaryAssetStore(
    process.env.TEMPORARY_ASSET_DATA_DIRECTORY ?? ".data/temporary-assets",
  );
  const activeVideoTasks = videoTasks ?? (adminStore === undefined ? undefined : new VideoTaskRuntime(
    adminStore,
    batchProjectStore!,
    videoTaskStore!,
    () => activeWorkspaceSessions.listDevelopmentAccounts(),
  ));
  const activeProjectLibrary = projectLibrary ?? (adminStore === undefined ? undefined : new ProjectLibraryRuntime(
    adminStore,
    batchProjectStore!,
    videoTaskStore!,
  ));
  const assetPoolStore = batchProjectStore === undefined
    ? undefined
    : new BatchProjectAssetPoolStoreAdapter(batchProjectStore);
  const localTemporaryAssets = adminStore === undefined
    ? undefined
    : new TemporaryAssetRuntime(temporaryAssetStore!, assetPoolStore!);
  const localProjectAssets = adminStore === undefined
    ? undefined
    : new ProjectAssetRuntime(
        companyAssetProvider,
        assetPoolStore!,
        undefined,
        temporaryAssetStore!,
      );
  const activeVideoTaskStages = videoTaskStages ?? (
    adminStore === undefined
      ? undefined
      : new VideoTaskStageRuntime(
          adminStore,
          batchProjectStore!,
          videoTaskStore!,
          undefined,
          undefined,
          localProjectAssets,
        )
  );
  const activeAssetMatching = assetMatching ?? (adminStore === undefined ? undefined : new AssetMatchingRuntime(
    adminStore,
    batchProjectStore!,
    videoTaskStore!,
    companyAssetProvider,
    localProjectAssets!,
    localTemporaryAssets!,
    activeVideoTaskStages!,
  ));
  const activeAgentActionCommands = agentActionCommands ?? (
    adminStore === undefined
      ? undefined
      : new AgentActionCommandRuntime(
          adminStore,
          batchProjectStore!,
          videoTaskStore!,
          undefined,
          undefined,
        )
  );
  const workspaceTaskContext = legacyWritesDisabled && adminStore !== undefined
    ? new WorkspaceTaskContextResolver(
        adminStore,
        batchProjectStore!,
        videoTaskStore!,
        (tenantId, accountId) => activeWorkspaceSessions.listDevelopmentAccounts().find(
          (account) => account.tenantId === tenantId && account.accountId === accountId,
        )?.displayName,
      )
    : undefined;
  const activeAgentTaskContext = !legacyWritesDisabled
    ? undefined
    : resolveAgentTaskContext ?? (workspaceTaskContext === undefined
      ? async () => {
          throw new BusinessRuntimeError(
            "AIC-AGENT-TASK_CONTEXT_RUNTIME_NOT_CONFIGURED",
            "Migrated Agent sessions require a configured V2 task-context resolver.",
            503,
          );
        }
      : async (request, videoTaskId) => {
          const bearer = readOptionalWorkspaceBearer(request);
          if (bearer === undefined) {
            throw new BusinessRuntimeError(
              "AIC-AUTH-SESSION_REQUIRED",
              "A valid workspace bearer session is required.",
              401,
            );
          }
          const session = await activeWorkspaceSessions.resolveSession(bearer);
          return workspaceTaskContext.resolve(videoTaskId, session.scope);
        });
  const activeRuntime = runtime ?? createBusinessAgentRuntime(
    business,
    loadLocalAgentConfig(),
    {
      disableLegacyStrategyTools: legacyWritesDisabled,
      ...(legacyWritesDisabled
        ? {
            resolveWorkStatus: videoTaskStore === undefined
              ? async () => {
                  throw new BusinessRuntimeError(
                    "AIC-AGENT-TASK_CONTEXT_RUNTIME_NOT_CONFIGURED",
                    "Migrated Agent tools require a configured V2 task store.",
                    503,
                  );
                }
              : (taskContext, sessionScope) =>
                  readWorkspaceTaskPolicyStatus(
                    videoTaskStore,
                    taskContext,
                    sessionScope.tenantId,
                  ),
            resolveVehicleService: videoTaskStore === undefined
              ? () => {
                  throw new BusinessRuntimeError(
                    "AIC-AGENT-TASK_CONTEXT_RUNTIME_NOT_CONFIGURED",
                    "Migrated Agent vehicle tools require a configured V2 task store.",
                    503,
                  );
                }
              : (taskContext, sessionScope) =>
                  createWorkspaceTaskVehicleService(
                   videoTaskStore,
                   taskContext,
                   sessionScope,
                  ),
            resolveTaskAssetReader: videoTaskStore === undefined
              ? () => undefined
              : (taskContext, sessionScope) => taskContext.videoTask.assetSnapshotId === undefined
                ? undefined
                : createScopedTaskAssetSnapshotReader({
                    taskContext,
                    store: videoTaskStore,
                    provider: companyAssetProvider,
                    providerScope: {
                      tenantId: sessionScope.tenantId,
                      actorAccountId: sessionScope.actorId,
                      allowedBrandIds: [taskContext.brand.id],
                      allowedVehicleIds: [taskContext.vehicle.id],
                    },
                  }),
            resolveStageSuggestionReader: videoTaskStore === undefined
              ? () => undefined
              : (taskContext, sessionScope) => [
                    "script",
                    "asset_matching",
                    "storyboard",
                    "delivery",
                  ].includes(taskContext.videoTask.currentStage)
                ? createScopedStageSuggestionContextReader({
                    taskContext,
                    tenantId: sessionScope.tenantId,
                    store: videoTaskStore,
                    ...(taskContext.videoTask.currentStage !== "asset_matching" ||
                      assetPoolStore === undefined || temporaryAssetStore === undefined
                      ? {}
                      : {
                          assetMatchingCandidateReader: createAgentAssetMatchingCandidateReader({
                            taskContext,
                            currentProjectAssetPool: createCurrentProjectAssetPoolReader({
                              taskContext,
                              administration: adminStore!,
                              projects: batchProjectStore!,
                              projectAssets: localProjectAssets!,
                              actor: {
                                tenantId: sessionScope.tenantId,
                                accountId: sessionScope.actorId,
                                role: activeWorkspaceSessions.listDevelopmentAccounts().find(
                                  (account) =>
                                    account.tenantId === sessionScope.tenantId &&
                                    account.accountId === sessionScope.actorId,
                                )?.role,
                              },
                            }),
                            temporaryAssets: temporaryAssetStore,
                            companyAssets: companyAssetProvider,
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
          }
        : {}),
    },
  );
  const activeIdentityResolver = resolveAgentIdentity ??
    createWorkspaceAgentIdentityResolver(activeWorkspaceSessions, legacyLocalAccessEnabled);
  return createServer((request, response) => {
    void handleRequest(
      request,
      response,
      activeRuntime,
      business,
      activeIdentityResolver,
      activeWorkspaceSessions,
      activeAgentTaskContext,
      activeWorkspaceAdmin,
      activeProjectCreation,
      activeVideoTasks,
      activeAgentActionCommands,
      activeVideoTaskStages,
      developmentAccountsEnabled,
      legacyLocalAccessEnabled,
      activeProjectLibrary,
      legacyWritesDisabled,
      readiness,
      activeAssetMatching,
      activeAccountRunLocks,
      developmentCompanyAssetMedia,
    ).catch((error: unknown) => {
      sendRequestError(response, error);
    });
  });
}

export async function startApiServer(
  port = 3100,
  host = "127.0.0.1",
  runtime: LocalAgentRuntime | undefined = undefined,
  business = new LocalBusinessRuntime(),
  resolveAgentIdentity: AgentIdentityResolver | undefined = undefined,
  workspaceSessions: WorkspaceSessionRuntime | undefined = undefined,
  developmentAccountsEnabled = developmentAccountsAllowed(host),
  legacyLocalAccessEnabled = developmentAccountsAllowed(host),
  workspaceAdmin: WorkspaceAdminRuntime | undefined = undefined,
  projectCreation: ProjectCreationRuntime | undefined = undefined,
  videoTasks: VideoTaskRuntime | undefined = undefined,
  agentActionCommands: AgentActionCommandRuntime | undefined = undefined,
  videoTaskStages: VideoTaskStageRuntime | undefined = undefined,
  projectLibrary: ProjectLibraryRuntime | undefined = undefined,
  migrationStateDirectory = process.env.WORKSPACE_MIGRATION_DATA_DIRECTORY ?? ".data/workspace-migrations",
  resolveAgentTaskContext: AgentTaskContextResolver | undefined = undefined,
  readiness: ApiReadinessProbe = alwaysReady,
  forceLegacyWritesDisabled = false,
  assetMatching: AssetMatchingRuntime | undefined = undefined,
  accountRunLocks: AccountRunLockRuntime | undefined = undefined,
  developmentCompanyAssetMedia: DevelopmentCompanyAssetMediaReader | undefined = undefined,
): Promise<Server> {
  const migrationState = new WorkspaceMigrationStateStore(migrationStateDirectory);
  const apiLease = await migrationState.acquireApiLease();
  try {
    const legacyWritesDisabled = forceLegacyWritesDisabled ||
      (await migrationState.inspect()).completedMigrationIds.length > 0;
    const server = createApiServer(
      runtime,
      business,
      resolveAgentIdentity,
      workspaceSessions,
      developmentAccountsEnabled,
      legacyLocalAccessEnabled,
      workspaceAdmin,
      projectCreation,
      videoTasks,
      agentActionCommands,
      videoTaskStages,
      projectLibrary,
      legacyWritesDisabled,
      resolveAgentTaskContext,
      readiness,
      assetMatching,
      accountRunLocks,
      developmentCompanyAssetMedia,
    );
    server.once("close", () => {
      void apiLease.release().catch(() => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return server;
  } catch (error) {
    await apiLease.release();
    throw error;
  }
}

export type PersistenceBackend = "local" | "postgres";

type ApiEnvironment = Readonly<Record<string, string | undefined>>;

export function resolvePersistenceBackend(
  environment: ApiEnvironment = process.env,
): PersistenceBackend {
  const configured = environment.PERSISTENCE_BACKEND ?? "local";
  if (configured !== "local" && configured !== "postgres") {
    throw new Error("PERSISTENCE_BACKEND must be either local or postgres.");
  }
  if (environment.NODE_ENV === "production" && configured !== "postgres") {
    throw new Error("Production requires PERSISTENCE_BACKEND=postgres.");
  }
  return configured;
}

export interface StartConfiguredApiServerOptions {
  readonly environment?: ApiEnvironment;
  readonly business?: LocalBusinessRuntime;
  readonly createPostgresRuntime?: (
    config: PostgresDatabaseConfig,
  ) => Promise<PostgresApiRuntime>;
  readonly registerSignalHandlers?: boolean;
}

function closeListeningServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function attachPostgresLifecycle(
  server: Server,
  postgres: PostgresApiRuntime,
  registerSignalHandlers: boolean,
): void {
  let closePromise: Promise<void> | undefined;
  const closePostgres = (): Promise<void> => {
    closePromise ??= postgres.close();
    return closePromise;
  };
  const shutdown = (): void => {
    void (async () => {
      try {
        await closeListeningServer(server);
        await closePostgres();
      } catch {
        process.exitCode = 1;
      }
    })();
  };
  const removeSignalHandlers = (): void => {
    if (!registerSignalHandlers) return;
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };

  server.once("close", () => {
    removeSignalHandlers();
    void closePostgres().catch(() => {
      process.exitCode = 1;
    });
  });
  if (registerSignalHandlers) {
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}

export async function startConfiguredApiServer(
  port = 3100,
  host = "127.0.0.1",
  options: Readonly<StartConfiguredApiServerOptions> = {},
): Promise<Server> {
  const environment = options.environment ?? process.env;
  const backend = resolvePersistenceBackend(environment);
  const migrationStateDirectory = environment.WORKSPACE_MIGRATION_DATA_DIRECTORY ??
    process.env.WORKSPACE_MIGRATION_DATA_DIRECTORY ??
    ".data/workspace-migrations";
  if (backend === "local") {
    const business = options.business ?? new LocalBusinessRuntime();
    return startApiServer(
      port,
      host,
      undefined,
      business,
      undefined,
      undefined,
      developmentAccountsAllowed(host, environment),
      developmentAccountsAllowed(host, environment),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      migrationStateDirectory,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      createDevelopmentCompanyAssetMediaStore(host, environment),
    );
  }

  const postgres = await (options.createPostgresRuntime ?? createPostgresApiRuntime)(
    parsePostgresDatabaseConfig(environment),
  );
  const business = options.business ?? new LocalBusinessRuntime();
  let server: Server | undefined;
  try {
    const runtime = createBusinessAgentRuntime(
      business,
      loadLocalAgentConfig(environment),
      {
        disableLegacyStrategyTools: true,
        resolveWorkStatus: postgres.resolveWorkStatus,
        resolveVehicleService: postgres.resolveVehicleService,
        resolveTaskAssetReader: postgres.resolveTaskAssetReader,
        resolveStageSuggestionReader: postgres.resolveStageSuggestionReader,
      },
    );
    const resolvePostgresTaskContext: AgentTaskContextResolver = async (request, videoTaskId) => {
      const bearer = readOptionalWorkspaceBearer(request);
      if (bearer === undefined) {
        throw new BusinessRuntimeError(
          "AIC-AUTH-SESSION_REQUIRED",
          "A valid workspace bearer session is required.",
          401,
        );
      }
      const session = await postgres.workspaceSessions.resolveSession(bearer);
      return postgres.taskContexts.resolve(videoTaskId, session.scope);
    };
    server = await startApiServer(
      port,
      host,
      runtime,
      business,
      undefined,
      postgres.workspaceSessions,
      developmentAccountsAllowed(host, environment),
      false,
      postgres.workspaceAdmin,
      postgres.projectCreation,
      postgres.videoTasks,
      postgres.agentActionCommands,
      postgres.videoTaskStages,
      postgres.projectLibrary,
      migrationStateDirectory,
      resolvePostgresTaskContext,
      postgres.readiness,
      true,
      postgres.assetMatching,
      postgres.accountRunLocks,
      createDevelopmentCompanyAssetMediaStore(host, environment),
    );
    attachPostgresLifecycle(
      server,
      postgres,
      options.registerSignalHandlers ?? true,
    );
    return server;
  } catch (error) {
    if (server !== undefined) await closeListeningServer(server).catch(() => undefined);
    await postgres.close().catch(() => undefined);
    throw error;
  }
}

const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const configuredPort = Number.parseInt(process.env.PORT ?? "3100", 10);
  const configuredHost = process.env.HOST ?? "127.0.0.1";
  try {
    const server = await startConfiguredApiServer(configuredPort, configuredHost);
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : configuredPort;
    console.log(
      `Firefly Agent API listening on http://${configuredHost}:${activePort} persistence=${resolvePersistenceBackend()}`,
    );
  } catch {
    console.error("Firefly Agent API failed to start.");
    process.exitCode = 1;
  }
}
