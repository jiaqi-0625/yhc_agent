import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { LocalAgentRuntime } from "@firefly/agent";

import { handleAgentRoute, type AgentIdentityResolver } from "./agent-routes.ts";
import { createBusinessAgentRuntime } from "./business-agent-runtime.ts";
import { BusinessRuntimeError, LocalBusinessRuntime } from "./business-runtime.ts";
import { LOCAL_SCOPE } from "./golden-sample.ts";
import { sendJson, sendRequestError } from "./http-boundary.ts";
import { sendWebAsset } from "./web-assets.ts";
import { handleWorkspaceRoute } from "./workspace-routes.ts";
import {
  handleWorkspaceSessionRoute,
  readOptionalWorkspaceBearer,
} from "./workspace-session-routes.ts";
import {
  InMemoryWorkspaceAccessGrantProvider,
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
  workspaceSessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(
      process.env.WORKSPACE_SESSION_DATA_DIRECTORY ?? ".data/workspace-sessions",
    ),
    new InMemoryWorkspaceAccessGrantProvider(),
  ),
  developmentAccountsEnabled = false,
  legacyLocalAccessEnabled = false,
): Server {
  const activeRuntime = runtime ?? createBusinessAgentRuntime(business);
  const activeIdentityResolver = resolveAgentIdentity ??
    createWorkspaceAgentIdentityResolver(workspaceSessions, legacyLocalAccessEnabled);
  return createServer((request, response) => {
    void handleRequest(
      request,
      response,
      activeRuntime,
      business,
      activeIdentityResolver,
      workspaceSessions,
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
  workspaceSessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(
      process.env.WORKSPACE_SESSION_DATA_DIRECTORY ?? ".data/workspace-sessions",
    ),
    new InMemoryWorkspaceAccessGrantProvider(),
  ),
  developmentAccountsEnabled = developmentAccountsAllowed(host),
  legacyLocalAccessEnabled = developmentAccountsAllowed(host),
): Promise<Server> {
  const server = createApiServer(
    runtime,
    business,
    resolveAgentIdentity,
    workspaceSessions,
    developmentAccountsEnabled,
    legacyLocalAccessEnabled,
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
