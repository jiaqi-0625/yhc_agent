import type { IncomingMessage, ServerResponse } from "node:http";

import { Type } from "typebox";

import { BusinessRuntimeError } from "./business-runtime.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";
import {
  type ResolvedWorkspaceSession,
  WorkspaceSessionRuntime,
} from "./workspace-session-runtime.ts";

const CreateWorkspaceSessionBodySchema = Type.Object(
  {
    accountId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    }),
  },
  { additionalProperties: false },
);

function sessionRequired(): BusinessRuntimeError {
  return new BusinessRuntimeError(
    "AIC-AUTH-SESSION_REQUIRED",
    "A valid workspace bearer session is required.",
    401,
  );
}

function malformedSessionHeader(): BusinessRuntimeError {
  return new BusinessRuntimeError(
    "AIC-AUTH-SESSION_HEADER_INVALID",
    "Authorization must contain exactly one Bearer workspace session.",
    401,
  );
}

function authorizationValues(request: IncomingMessage): readonly string[] {
  return request.headersDistinct.authorization ?? [];
}

export function readOptionalWorkspaceBearer(request: IncomingMessage): string | undefined {
  const values = authorizationValues(request);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || values[0]!.includes(",")) throw malformedSessionHeader();
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/u.exec(values[0]!);
  if (!match?.[1]) throw malformedSessionHeader();
  return match[1];
}

export async function resolveWorkspaceSession(
  request: IncomingMessage,
  runtime: WorkspaceSessionRuntime,
): Promise<ResolvedWorkspaceSession> {
  const sessionId = readOptionalWorkspaceBearer(request);
  if (sessionId === undefined) throw sessionRequired();
  return runtime.resolveSession(sessionId);
}

function publicAccount(session: ResolvedWorkspaceSession) {
  return {
    accountId: session.account.accountId,
    displayName: session.account.displayName,
    role: session.account.role,
  };
}

export async function handleWorkspaceSessionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: WorkspaceSessionRuntime,
  enabled: boolean,
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/auth/")) return false;
  if (!enabled) return false;

  if (request.method === "GET" && url.pathname === "/v1/auth/development-accounts") {
    sendJson(response, 200, {
      accounts: runtime.listDevelopmentAccounts().map(({ accountId, displayName, role }) => ({
        accountId,
        displayName,
        role,
      })),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/auth/session") {
    const { accountId } = validateBody<{ accountId: string }>(
      CreateWorkspaceSessionBodySchema,
      await readJson(request),
    );
    const currentSessionId = readOptionalWorkspaceBearer(request);
    const session = await runtime.createOrSwitchSession(accountId, currentSessionId);
    sendJson(response, 201, {
      session: {
        token: session.sessionId,
        expiresAt: session.expiresAt,
        account: publicAccount(session),
      },
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/auth/session") {
    const session = await resolveWorkspaceSession(request, runtime);
    sendJson(response, 200, {
      session: {
        expiresAt: session.expiresAt,
        account: publicAccount(session),
      },
    });
    return true;
  }

  if (request.method === "DELETE" && url.pathname === "/v1/auth/session") {
    const session = await resolveWorkspaceSession(request, runtime);
    await runtime.endSession(session.sessionId);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  return false;
}
