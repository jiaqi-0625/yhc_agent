import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { LocalAgentRuntime } from "@firefly/agent";
import { MockCompanyAssetProvider } from "@firefly/tools";

import { AccountBudgetRuntime } from "./account-budget-runtime.ts";
import { LocalAccountBudgetStore } from "./account-budget-store.ts";
import { handleAgentRoute, type AgentIdentityResolver } from "./agent-routes.ts";
import { LocalBatchProjectStore } from "./batch-project-store.ts";
import { createBusinessAgentRuntime } from "./business-agent-runtime.ts";
import { BusinessRuntimeError, LocalBusinessRuntime } from "./business-runtime.ts";
import { LOCAL_SCOPE } from "./golden-sample.ts";
import { sendJson, sendRequestError } from "./http-boundary.ts";
import { handleProjectCreationRoute } from "./project-creation-routes.ts";
import { ProjectCreationRuntime } from "./project-creation-runtime.ts";
import { handleVideoTaskRoute } from "./video-task-routes.ts";
import { VideoTaskRuntime } from "./video-task-runtime.ts";
import { LocalVideoTaskProductionStore } from "./video-task-store.ts";
import { sendWebAsset } from "./web-assets.ts";
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

const version = "0.1.0";
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

function developmentAccountsAllowed(host: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (["127.0.0.1", "::1", "localhost"].includes(host)) return true;
  return process.env.FIREFLY_ENABLE_DEVELOPMENT_ACCOUNTS === "true";
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: LocalAgentRuntime,
  business: LocalBusinessRuntime,
  resolveAgentIdentity: AgentIdentityResolver,
  workspaceSessions: WorkspaceSessionRuntime,
  workspaceAdmin: WorkspaceAdminRuntime | undefined,
  projectCreation: ProjectCreationRuntime | undefined,
  videoTasks: VideoTaskRuntime | undefined,
  developmentAccountsEnabled: boolean,
  legacyLocalAccessEnabled: boolean,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && (await sendWebAsset(response, url.pathname))) return;
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "firefly-ad-agent-api", version });
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
  if (await handleWorkspaceRoute(request, response, url, business, legacyLocalAccessEnabled)) return;
  if (
    await handleAgentRoute(
      request,
      response,
      url,
      runtime,
      business,
      resolveAgentIdentity,
      legacyLocalAccessEnabled,
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
): Server {
  if (
    workspaceSessions === undefined &&
    (workspaceAdmin !== undefined || projectCreation !== undefined || videoTasks !== undefined)
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
  const activeVideoTasks = videoTasks ?? (adminStore === undefined ? undefined : new VideoTaskRuntime(
    adminStore,
    batchProjectStore!,
    new LocalVideoTaskProductionStore(
      process.env.VIDEO_TASK_DATA_DIRECTORY ?? ".data/video-tasks",
    ),
    () => activeWorkspaceSessions.listDevelopmentAccounts(),
  ));
  const activeRuntime = runtime ?? createBusinessAgentRuntime(business);
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
      activeWorkspaceAdmin,
      activeProjectCreation,
      activeVideoTasks,
      developmentAccountsEnabled,
      legacyLocalAccessEnabled,
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
): Promise<Server> {
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
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const configuredPort = Number.parseInt(process.env.PORT ?? "3100", 10);
  const configuredHost = process.env.HOST ?? "127.0.0.1";
  const business = new LocalBusinessRuntime();
  const runtime = createBusinessAgentRuntime(business);
  const server = await startApiServer(configuredPort, configuredHost, runtime, business);
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : configuredPort;
  console.log(
    `Firefly Local Agent API listening on http://${configuredHost}:${activePort} provider=${runtime.config.provider} model=${runtime.config.modelId}`,
  );
}
