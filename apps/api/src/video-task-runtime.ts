import { createHash, randomUUID } from "node:crypto";

import {
  assertCanOperateVideoTask,
  assertCanTakeOverVideoTask,
  assertCanViewBatchProject,
  assignVideoTaskOwner,
  createVideoTask,
  takeOverVideoTask,
  type VideoTaskProductionRecord,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  AssignVideoTaskOwnerRequest,
  BatchProject,
  CreateVideoTaskRequest,
  TakeOverVideoTaskRequest,
} from "@firefly/schemas";

import type { BatchProjectStore } from "./batch-project-store.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import type {
  VideoTaskCreationStore,
} from "./video-task-store.ts";
import type {
  WorkspaceAdminState,
  WorkspaceAdminStore,
} from "./workspace-admin-store.ts";
import type { DevelopmentAccount } from "./workspace-session-runtime.ts";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function creationPayloadHash(
  projectId: string,
  input: Readonly<CreateVideoTaskRequest>,
): string {
  return createHash("sha256").update(canonicalJson({ projectId, ...input })).digest("hex");
}

function creationTaskId(
  tenantId: string,
  projectId: string,
  actorAccountId: string,
  requestId: string,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ tenantId, projectId, actorAccountId, requestId }))
    .digest("hex");
  return `video_task_${digest.slice(0, 48)}`;
}

function runtimeError(
  code: string,
  message: string,
  statusCode: number,
): BusinessRuntimeError {
  return new BusinessRuntimeError(code, message, statusCode);
}

export class VideoTaskRuntime {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskCreationStore,
    private readonly accounts: () => readonly Readonly<DevelopmentAccount>[],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: (kind: "ownership_transfer") => string =
      (kind) => `${kind}_${randomUUID()}`,
  ) {}

  #currentScope(
    session: Readonly<WorkspaceSessionScope>,
    state: Readonly<WorkspaceAdminState>,
  ): WorkspaceSessionScope {
    return {
      actorAccountId: session.actorAccountId,
      tenantId: session.tenantId,
      role: session.role,
      accessGrants: state.accessGrants.filter(
        (grant) => grant.accountId === session.actorAccountId,
      ),
    };
  }

  async #project(
    projectId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<BatchProject> {
    const aggregate = await this.projects.load(session.tenantId, projectId);
    if (!aggregate) {
      throw runtimeError(
        "AIC-VIDEO-TASK-PROJECT_NOT_FOUND",
        `Batch project '${projectId}' was not found.`,
        404,
      );
    }
    return aggregate.project;
  }

  #assertCreator(scope: Readonly<WorkspaceSessionScope>): void {
    if (scope.role !== "creator") {
      throw runtimeError(
        "AIC-AUTH-ROLE_DENIED",
        "Only an authorized production account can change video tasks.",
        403,
      );
    }
  }

  #assertEligibleOwner(
    ownerAccountId: string,
    project: Readonly<BatchProject>,
    state: Readonly<WorkspaceAdminState>,
  ): void {
    const account = this.accounts().find(
      (candidate) =>
        candidate.accountId === ownerAccountId && candidate.tenantId === project.tenantId,
    );
    if (!account || account.role !== "creator") {
      throw runtimeError(
        "AIC-VIDEO-TASK-OWNER_INELIGIBLE",
        "The selected owner is not an eligible production account in this tenant.",
        409,
      );
    }
    try {
      assertCanViewBatchProject(
        {
          actorAccountId: account.accountId,
          tenantId: account.tenantId,
          role: account.role,
          accessGrants: state.accessGrants.filter(
            (grant) => grant.accountId === account.accountId,
          ),
        },
        project,
      );
    } catch {
      throw runtimeError(
        "AIC-VIDEO-TASK-OWNER_INELIGIBLE",
        "The selected owner does not have active access to this vehicle project.",
        409,
      );
    }
  }

  async list(
    projectId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VideoTaskProductionRecord[]> {
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = this.#currentScope(session, state);
      const project = await this.#project(projectId, scope);
      assertCanViewBatchProject(scope, project);
      const records = await this.tasks.list(session.tenantId, project.id);
      return records.sort((left, right) =>
        right.videoTask.updatedAt.localeCompare(left.videoTask.updatedAt, "en") ||
        left.videoTask.id.localeCompare(right.videoTask.id, "en"));
    });
  }

  async create(
    projectId: string,
    input: Readonly<CreateVideoTaskRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<{ record: VideoTaskProductionRecord; replayed: boolean }> {
    this.#assertCreator(session);
    const payloadHash = creationPayloadHash(projectId, input);
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = this.#currentScope(session, state);
      this.#assertCreator(scope);
      const project = await this.#project(projectId, scope);
      assertCanViewBatchProject(scope, project);
      if (project.status !== "active") {
        throw runtimeError(
          "AIC-VIDEO-TASK-PROJECT_INACTIVE",
          "Video tasks can only be created in an active batch project.",
          409,
        );
      }
      const ownerAccountId = input.ownerAccountId ?? session.actorAccountId;
      this.#assertEligibleOwner(ownerAccountId, project, state);
      const candidate = createVideoTask(
        project,
        {
          name: input.name,
          audience: input.audience,
          theme: input.theme,
          durationSeconds: input.durationSeconds,
          platformTags: input.platformTags,
          ...(input.scriptInput === undefined ? {} : { scriptInput: input.scriptInput }),
        },
        {
          tenantId: session.tenantId,
          actorAccountId: session.actorAccountId,
          ownerAccountId,
          occurredAt: this.now(),
          taskId: creationTaskId(
            session.tenantId,
            project.id,
            session.actorAccountId,
            input.requestId,
          ),
        },
      );
      let saved: { record: VideoTaskProductionRecord; replayed: boolean };
      try {
        saved = await this.tasks.createWithResult(candidate, {
          requestId: input.requestId,
          actorAccountId: session.actorAccountId,
          payloadHash,
        });
      } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : "Video task creation failed.";
        if (message.includes("different payload")) {
          throw runtimeError("AIC-VIDEO-TASK-IDEMPOTENCY_CONFLICT", message, 409);
        }
        if (message.includes("already exists") || message.includes("same name")) {
          throw runtimeError("AIC-VIDEO-TASK-CREATION-CONFLICT", message, 409);
        }
        throw caught;
      }
      return saved;
    });
  }

  async assign(
    projectId: string,
    videoTaskId: string,
    request: Readonly<AssignVideoTaskOwnerRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VideoTaskProductionRecord> {
    this.#assertCreator(session);
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = this.#currentScope(session, state);
      const project = await this.#project(projectId, scope);
      return this.tasks.transact(videoTaskId, (current) => {
        if (!current) {
          throw runtimeError(
            "AIC-VIDEO-TASK-NOT-FOUND",
            `Video task '${videoTaskId}' was not found.`,
            404,
          );
        }
        assertCanOperateVideoTask(scope, project, current.videoTask);
        this.#assertEligibleOwner(request.targetOwnerAccountId, project, state);
        return assignVideoTaskOwner(current, request, {
          tenantId: session.tenantId,
          batchProjectId: project.id,
          actorAccountId: session.actorAccountId,
          occurredAt: this.now(),
          createId: () => this.createId("ownership_transfer"),
        });
      });
    });
  }

  async takeOver(
    projectId: string,
    videoTaskId: string,
    request: Readonly<TakeOverVideoTaskRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VideoTaskProductionRecord> {
    this.#assertCreator(session);
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = this.#currentScope(session, state);
      const project = await this.#project(projectId, scope);
      return this.tasks.transact(videoTaskId, (current) => {
        if (!current) {
          throw runtimeError(
            "AIC-VIDEO-TASK-NOT-FOUND",
            `Video task '${videoTaskId}' was not found.`,
            404,
          );
        }
        assertCanTakeOverVideoTask(scope, project, current.videoTask);
        return takeOverVideoTask(current, request, {
          tenantId: session.tenantId,
          batchProjectId: project.id,
          actorAccountId: session.actorAccountId,
          occurredAt: this.now(),
          createId: () => this.createId("ownership_transfer"),
        });
      });
    });
  }
}
