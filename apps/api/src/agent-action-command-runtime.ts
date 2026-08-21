import { createHash, randomUUID } from "node:crypto";

import {
  assertCanOperateVideoTask,
  assertCanViewBatchProject,
  assertCanViewVideoTask,
  generateSimulatedStageArtifact,
  generateVideoTaskScript,
  generateVideoTaskStrategy,
  normalizeVideoTaskScriptText,
  requestVideoTaskStrategyApproval,
  rollbackVideoTaskStage,
  type AgentActionCommandContext,
  type AgentActionCommandIdKind,
  type VideoTaskProductionRecord,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  AgentActionCommandReceipt,
  BatchProject,
  ExecuteAgentActionRequest,
  ExecuteAgentActionResponse,
  Vehicle,
  VehicleSnapshot,
} from "@firefly/schemas";

import type { BatchProjectAggregate, BatchProjectStore } from "./batch-project-store.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import type { VideoTaskProductionStore } from "./video-task-store.ts";
import {
  defaultProjectAssetCoordinator,
  type ProjectAssetCoordinator,
} from "./project-asset-coordinator.ts";
import type {
  WorkspaceAdminState,
  WorkspaceAdminStore,
} from "./workspace-admin-store.ts";

type CommandIdKind =
  | AgentActionCommandIdKind
  | "vehicle_snapshot"
  | "rollback"
  | "invalidation";

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

function commandPayloadHash(
  projectId: string,
  videoTaskId: string,
  input: Readonly<ExecuteAgentActionRequest>,
): string {
  const { card } = input;
  return createHash("sha256")
    .update(canonicalJson({
      projectId,
      videoTaskId,
      schemaVersion: card.schemaVersion,
      action: card.action,
      expectedRevision: card.expectedRevision,
      payload: card.payload,
    }))
    .digest("hex");
}

function deterministicVehicleSnapshotId(
  tenantId: string,
  project: Readonly<BatchProject>,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson({
      tenantId,
      projectId: project.id,
      brandId: project.brandId,
      vehicleId: project.vehicleId,
      vehicleVersion: project.vehicleVersion,
    }))
    .digest("hex");
  return `vehicle_snapshot_${digest.slice(0, 48)}`;
}

function runtimeError(code: string, message: string, statusCode: number): BusinessRuntimeError {
  return new BusinessRuntimeError(code, message, statusCode);
}

export class AgentActionCommandRuntime {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskProductionStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: (kind: CommandIdKind) => string =
      (kind) => `${kind}_${randomUUID()}`,
    private readonly assetCoordinator: ProjectAssetCoordinator = defaultProjectAssetCoordinator,
  ) {}

  #assertCreator(scope: Readonly<WorkspaceSessionScope>): void {
    if (scope.role !== "creator") {
      throw runtimeError(
        "AIC-AUTH-ROLE_DENIED",
        "Only an authorized production account can execute task commands.",
        403,
      );
    }
  }

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
    tenantId: string,
    projectId: string,
  ): Promise<BatchProjectAggregate> {
    const aggregate = await this.projects.load(tenantId, projectId);
    if (!aggregate) {
      throw runtimeError(
        "AIC-AGENT-COMMAND-PROJECT_NOT_FOUND",
        `Batch project '${projectId}' was not found.`,
        404,
      );
    }
    return aggregate;
  }

  #vehicle(
    state: Readonly<WorkspaceAdminState>,
    project: Readonly<BatchProject>,
  ): Vehicle {
    const brand = state.brands.find((candidate) => candidate.id === project.brandId);
    const vehicle = state.vehicleVersions.find(
      (candidate) =>
        candidate.id === project.vehicleId && candidate.version === project.vehicleVersion,
    );
    if (
      !brand ||
      !vehicle ||
      brand.tenantId !== project.tenantId ||
      vehicle.tenantId !== project.tenantId ||
      vehicle.brandId !== brand.id ||
      brand.status !== "active" ||
      vehicle.status !== "active"
    ) {
      throw runtimeError(
        "AIC-AGENT-COMMAND-SNAPSHOT_INVALID",
        "The project's frozen active brand and vehicle fact version are unavailable.",
        409,
      );
    }
    return vehicle;
  }

  #vehicleSnapshot(
    current: Readonly<VideoTaskProductionRecord>,
    state: Readonly<WorkspaceAdminState>,
    project: Readonly<BatchProject>,
    vehicle: Readonly<Vehicle> | undefined,
    actorAccountId: string,
    occurredAt: string,
  ): VehicleSnapshot {
    if (current.videoTask.vehicleSnapshotId !== undefined) {
      const locked = current.taskVehicleSnapshots.find(
        (snapshot) => snapshot.id === current.videoTask.vehicleSnapshotId,
      );
      if (!locked) {
        throw runtimeError(
          "AIC-AGENT-COMMAND-SNAPSHOT_MIGRATION_REQUIRED",
          "The task's legacy vehicle snapshot pointer requires an explicit snapshot migration.",
          409,
        );
      }
      if (
        locked.projectId !== project.id ||
        locked.brandId !== project.brandId ||
        locked.vehicleId !== project.vehicleId ||
        locked.vehicleVersion !== project.vehicleVersion
      ) {
        throw runtimeError(
          "AIC-AGENT-COMMAND-SNAPSHOT_INVALID",
          "The task's locked vehicle snapshot is missing or does not match the project.",
          409,
        );
      }
      return structuredClone(locked);
    }
    if (vehicle === undefined) {
      throw runtimeError(
        "AIC-AGENT-COMMAND-SNAPSHOT_INVALID",
        "The server did not resolve vehicle facts for the initial task snapshot.",
        409,
      );
    }
    const brand = state.brands.find((candidate) => candidate.id === project.brandId)!;
    return {
      id: deterministicVehicleSnapshotId(project.tenantId, project),
      projectId: project.id,
      vehicleId: vehicle.id,
      vehicleVersion: vehicle.version,
      brandId: brand.id,
      brand: brand.name,
      series: vehicle.series,
      modelYear: vehicle.modelYear,
      trim: vehicle.trim,
      ...(vehicle.factsText === undefined ? {} : { factsText: vehicle.factsText }),
      parameters: structuredClone(vehicle.parameters),
      fixedClaims: structuredClone(vehicle.fixedClaims),
      optionalClaims: structuredClone(vehicle.optionalClaims),
      prohibitedClaims: structuredClone(vehicle.prohibitedClaims),
      referenceAssetIds: [],
      createdAt: occurredAt,
      createdBy: actorAccountId,
    };
  }

  #receipt(
    record: Readonly<VideoTaskProductionRecord>,
    actorAccountId: string,
    requestId: string,
  ): AgentActionCommandReceipt {
    const receipt = record.commandReceipts.find(
      (candidate) =>
        candidate.actorAccountId === actorAccountId && candidate.requestId === requestId,
    );
    if (!receipt) {
      throw new Error("The command mutation did not append its required receipt.");
    }
    return structuredClone(receipt);
  }

  async execute(
    projectId: string,
    videoTaskId: string,
    input: Readonly<ExecuteAgentActionRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ExecuteAgentActionResponse> {
    this.#assertCreator(session);
    if (input.card.videoTaskId !== videoTaskId) {
      throw runtimeError(
        "AIC-AGENT-COMMAND-SCOPE_INVALID",
        "The action card does not belong to the video task in the request path.",
        409,
      );
    }
    const payloadHash = commandPayloadHash(projectId, videoTaskId, input);
    return this.assetCoordinator.runExclusive(projectId, () =>
      this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = this.#currentScope(session, state);
      this.#assertCreator(scope);
      const aggregate = await this.#project(scope.tenantId, projectId);
      const project = aggregate.project;
      assertCanViewBatchProject(scope, project);
      const occurredAt = this.now();
      let replayed = false;
      const record = await this.tasks.transact(videoTaskId, async (current) => {
        if (!current) {
          throw runtimeError(
            "AIC-AGENT-COMMAND-TASK_NOT_FOUND",
            `Video task '${videoTaskId}' was not found.`,
            404,
          );
        }
        assertCanViewVideoTask(scope, project, current.videoTask);
        const replay = current.commandReceipts.find(
          (candidate) =>
            candidate.actorAccountId === scope.actorAccountId &&
            candidate.requestId === input.requestId,
        );
        if (replay) {
          if (replay.payloadHash !== payloadHash || replay.action !== input.card.action) {
            throw runtimeError(
              "AIC-AGENT-COMMAND-IDEMPOTENCY_CONFLICT",
              "The command request ID was already used with a different action card.",
              409,
            );
          }
          replayed = true;
          return structuredClone(current);
        }
        if (
          current.stageMutationReceipts.some(
            (candidate) =>
              candidate.actorAccountId === scope.actorAccountId &&
              candidate.requestId === input.requestId,
          )
        ) {
          throw runtimeError(
            "AIC-AGENT-COMMAND-IDEMPOTENCY_CONFLICT",
            "The command request ID was already used by another stage mutation.",
            409,
          );
        }
        if (project.status !== "active") {
          throw runtimeError(
            "AIC-AGENT-COMMAND-STATE_CONFLICT",
            "Commands can only execute in an active batch project.",
            409,
          );
        }
        assertCanOperateVideoTask(scope, project, current.videoTask);

        const context: AgentActionCommandContext = {
          tenantId: scope.tenantId,
          batchProjectId: project.id,
          actorAccountId: scope.actorAccountId,
          requestId: input.requestId,
          payloadHash,
          occurredAt,
          createId: this.createId,
        };
          switch (input.card.action) {
          case "generate_strategy": {
            const vehicle = current.videoTask.vehicleSnapshotId === undefined
              ? this.#vehicle(state, project)
              : undefined;
            const snapshot = this.#vehicleSnapshot(
              current,
              state,
              project,
              vehicle,
              scope.actorAccountId,
              occurredAt,
            );
            if (current.videoTask.vehicleSnapshotId === undefined) {
              snapshot.referenceAssetIds = aggregate.assetPool.assets
                .filter(
                  (asset) =>
                    asset.source === "company_catalog" && asset.category === "vehicle",
                )
                .map((asset) => asset.assetId);
            }
            return generateVideoTaskStrategy(
              current,
              {
                expectedTaskRevision: input.card.expectedRevision,
                audience: input.card.payload.audience,
                theme: input.card.payload.theme,
              },
              project,
              aggregate.assetPool,
              snapshot,
              context,
            );
          }
          case "request_strategy_approval":
            return requestVideoTaskStrategyApproval(
              current,
              { expectedTaskRevision: input.card.expectedRevision },
              context,
            );
          case "generate_script": {
            const script = normalizeVideoTaskScriptText(input.card.payload.script);
            return generateVideoTaskScript(
              current,
              {
                expectedTaskRevision: input.card.expectedRevision,
                script,
                scriptContentHashSha256: createHash("sha256").update(script).digest("hex"),
              },
              context,
            );
          }
          case "generate_simulated_stage_artifact": {
            const stage = input.card.payload.stage;
            const artifactContentHashSha256 = createHash("sha256").update(JSON.stringify({
              schemaVersion: 1,
              kind: "ws503_simulated_stage_artifact",
              stage,
              videoTaskId: current.videoTask.id,
              sourceTaskRevision: current.videoTask.revision,
              activeUpstreamArtifactVersionIds: current.activeStageArtifactVersionIds,
              assetSnapshotId: current.videoTask.assetSnapshotId ?? null,
            })).digest("hex");
            return generateSimulatedStageArtifact(
              current,
              {
                expectedTaskRevision: input.card.expectedRevision,
                stage,
                artifactContentHashSha256,
              },
              context,
            );
          }
          case "rollback_stage": {
            const rolledBack = rollbackVideoTaskStage(
              current,
              {
                expectedTaskRevision: input.card.expectedRevision,
                stage: input.card.payload.stage,
                targetArtifactVersionId: input.card.payload.targetArtifactVersionId,
                reason: input.card.payload.reason,
              },
              {
                tenantId: scope.tenantId,
                batchProjectId: project.id,
                actorAccountId: scope.actorAccountId,
                occurredAt,
                createId: this.createId,
              },
            );
            const rollback = rolledBack.stageRollbacks.at(-1);
            if (!rollback || rollback.expectedTaskRevision !== input.card.expectedRevision) {
              throw new Error("The rollback mutation did not append its required audit record.");
            }
            const invalidationIds = rolledBack.stageArtifactInvalidations
              .slice(current.stageArtifactInvalidations.length)
              .map((invalidation) => invalidation.id);
            const receipt: AgentActionCommandReceipt = {
              schemaVersion: 1,
              id: this.createId("command_receipt"),
              tenantId: current.videoTask.tenantId,
              batchProjectId: current.videoTask.batchProjectId,
              videoTaskId: current.videoTask.id,
              actorAccountId: scope.actorAccountId,
              requestId: input.requestId,
              payloadHash,
              action: "rollback_stage",
              expectedTaskRevision: input.card.expectedRevision,
              resultingTaskRevision: rolledBack.videoTask.revision,
              cost: { kind: "free", amountMinor: 0, charged: false },
              result: {
                kind: "stage_rolled_back",
                stageRollbackId: rollback.id,
                invalidationIds,
              },
              occurredAt,
            };
            return {
              ...rolledBack,
              commandReceipts: [...structuredClone(rolledBack.commandReceipts), receipt],
            };
          }
        }
      });
      return {
        receipt: this.#receipt(record, scope.actorAccountId, input.requestId),
        replayed,
        videoTask: structuredClone(record.videoTask),
      };
      }),
    );
  }
}
