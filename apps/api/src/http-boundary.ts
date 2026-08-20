import type { IncomingMessage, ServerResponse } from "node:http";

import { LocalAgentCredentialsError, LocalAgentRunError } from "@firefly/agent";
import {
  AccountBudgetError,
  AccountHighCostTaskRunningError,
  AccountRunLockDeniedError,
  AccountRunLockTokenMismatchError,
  AgentActionCommandError,
  AssetPoolError,
  BatchProjectCreationError,
  RevisionConflictError,
  StageConfirmationDeniedError,
  StageRollbackDeniedError,
  TaskTakeoverDeniedError,
  VideoTaskAssignmentDeniedError,
  VideoTaskCreationError,
  WorkspaceAccessDeniedError,
} from "@firefly/domain";
import {
  CompanyAssetCatalogAccessError,
  CompanyAssetCatalogQueryError,
  CompanyAssetProviderAbortedError,
} from "@firefly/tools";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { BusinessRuntimeError } from "./business-runtime.ts";
import {
  PostgresDatabaseClosedError,
  PostgresPersistenceError,
  PostgresTransactionContextClosedError,
} from "./postgres-database.ts";

const maximumBodyBytes = 64 * 1024;

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function startEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  response.flushHeaders();
}

export function sendEvent(response: ServerResponse, event: string, data: unknown, id?: string): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBodyBytes) throw new Error("Request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function validateBody<T>(schema: TSchema, body: Record<string, unknown>): T {
  if (!Value.Check(schema, body)) {
    const first = [...Value.Errors(schema, body)][0];
    throw new BusinessRuntimeError(
      "AIC-API-SCHEMA_INVALID",
      first ? `请求数据不符合 Schema：${first.message}` : "请求数据不符合 Schema。",
      400,
    );
  }
  return body as T;
}

export function errorStatus(error: Error): number {
  if (error instanceof PostgresPersistenceError) {
    return error.sqlState?.startsWith("23") === true ||
      error.sqlState === "40001" ||
      error.sqlState === "40P01"
      ? 409
      : 503;
  }
  if (
    error instanceof PostgresDatabaseClosedError ||
    error instanceof PostgresTransactionContextClosedError
  ) {
    return 503;
  }
  if (error instanceof BusinessRuntimeError) return error.statusCode;
  if (error instanceof LocalAgentRunError) return error.statusCode;
  if (error instanceof WorkspaceAccessDeniedError) return 403;
  if (error instanceof CompanyAssetCatalogAccessError) return 403;
  if (error instanceof LocalAgentCredentialsError) return 503;
  if (
    error instanceof VideoTaskAssignmentDeniedError ||
    error instanceof TaskTakeoverDeniedError ||
    error instanceof AgentActionCommandError ||
    error instanceof StageConfirmationDeniedError ||
    error instanceof StageRollbackDeniedError ||
    (error instanceof VideoTaskCreationError &&
      error.code === "AIC-VIDEO-TASK-CREATION-PROJECT_INACTIVE")
  ) {
    return 409;
  }
  if (
    error instanceof RevisionConflictError ||
    error instanceof AccountBudgetError ||
    error instanceof AccountHighCostTaskRunningError ||
    error instanceof AccountRunLockDeniedError ||
    error instanceof AccountRunLockTokenMismatchError
  ) {
    return 409;
  }
  if (error.message.includes("was not found")) return 404;
  if (error.message.includes("already exists") || error.message.includes("already running")) return 409;
  return 400;
}

export interface RequestErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly charged: false;
}

export function requestErrorBody(error: Error): RequestErrorBody {
  if (error instanceof PostgresPersistenceError) {
    const conflict = error.sqlState?.startsWith("23") === true ||
      error.sqlState === "40001" ||
      error.sqlState === "40P01";
    return {
      code: conflict ? "AIC-PERSISTENCE-CONFLICT" : "AIC-PERSISTENCE-UNAVAILABLE",
      message: conflict
        ? "The persistence operation conflicted with current database state."
        : "The persistence service is temporarily unavailable.",
      retryable: !conflict || error.sqlState === "40001" || error.sqlState === "40P01",
      charged: false,
    };
  }
  if (
    error instanceof PostgresDatabaseClosedError ||
    error instanceof PostgresTransactionContextClosedError
  ) {
    return {
      code: "AIC-PERSISTENCE-UNAVAILABLE",
      message: "The persistence service is temporarily unavailable.",
      retryable: true,
      charged: false,
    };
  }
  return {
    code:
      error instanceof BusinessRuntimeError ||
      error instanceof RevisionConflictError ||
      error instanceof AccountBudgetError ||
      error instanceof AccountHighCostTaskRunningError ||
      error instanceof AccountRunLockDeniedError ||
      error instanceof AccountRunLockTokenMismatchError ||
      error instanceof AssetPoolError ||
      error instanceof AgentActionCommandError ||
      error instanceof BatchProjectCreationError ||
      error instanceof StageConfirmationDeniedError ||
      error instanceof StageRollbackDeniedError ||
      error instanceof VideoTaskCreationError ||
      error instanceof VideoTaskAssignmentDeniedError ||
      error instanceof TaskTakeoverDeniedError ||
      error instanceof LocalAgentRunError ||
      error instanceof LocalAgentCredentialsError ||
      error instanceof CompanyAssetCatalogAccessError ||
      error instanceof CompanyAssetCatalogQueryError ||
      error instanceof CompanyAssetProviderAbortedError ||
      error instanceof WorkspaceAccessDeniedError
        ? error.code
        : "AIC-API-INVALID_REQUEST",
    message: error.message,
    retryable: false,
    charged: false,
  };
}

export function sendRequestError(response: ServerResponse, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error("Unknown request error.");
  sendJson(response, errorStatus(normalized), requestErrorBody(normalized));
}
