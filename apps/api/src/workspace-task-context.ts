import {
  assertCanViewVideoTask,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import {
  TaskContextSchema,
  type TaskContext,
  type TaskContextOwnership,
  type VehicleSnapshot,
  type VideoTask,
  type WorkStatus,
} from "@firefly/schemas";
import {
  SnapshotNotFoundError,
  validateClaimsAgainstSnapshot,
  VehicleAccessError,
  VehicleNotFoundError,
  type ToolExecutionScope,
  type VehicleServicePort,
} from "@firefly/tools";
import { Value } from "typebox/value";

import type { BatchProjectStore } from "./batch-project-store.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import type { VideoTaskProductionStore } from "./video-task-store.ts";
import type { WorkspaceAdminStore } from "./workspace-admin-store.ts";

export type WorkspaceAccountDisplayNameResolver = (
  tenantId: string,
  accountId: string,
) => string | undefined | Promise<string | undefined>;

export interface WorkspaceAgentTaskBinding {
  readonly actorId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly videoTaskId: string;
}

/** Compatibility projection for the V1 tool-policy table while Agent tools migrate to V2 stages. */
export function workspaceTaskPolicyStatus(task: Readonly<VideoTask>): WorkStatus {
  if (task.status !== "active") return "exported";
  switch (task.currentStage) {
    case "strategy":
      return task.stageStatus === "awaiting_confirmation"
        ? "awaiting_strategy_approval"
        : task.stageStatus === "confirmed"
          ? "strategy_approved"
          : "strategy_draft";
    case "asset_matching":
      return "strategy_approved";
    case "script":
      return task.stageStatus === "awaiting_confirmation"
        ? "awaiting_script_approval"
        : task.stageStatus === "confirmed"
          ? "script_approved"
          : "script_draft";
    case "storyboard":
      return task.stageStatus === "awaiting_confirmation"
        ? "awaiting_storyboard_approval"
        : task.stageStatus === "confirmed"
          ? "storyboard_approved"
          : "storyboard_draft";
    case "video_preview":
      return task.stageStatus === "awaiting_confirmation"
        ? "final_review"
        : task.stageStatus === "confirmed"
          ? "export_ready"
          : "rendering";
    case "delivery":
      return task.stageStatus === "confirmed" ? "exported" : "export_ready";
  }
}

export async function readWorkspaceTaskPolicyStatus(
  tasks: VideoTaskProductionStore,
  taskContext: Readonly<TaskContext>,
  tenantId: string,
): Promise<WorkStatus> {
  const record = await tasks.load(taskContext.videoTask.id);
  if (record === undefined || record.videoTask.tenantId !== tenantId) {
    throw notFound(taskContext.videoTask.id);
  }
  if (record.videoTask.batchProjectId !== taskContext.batchProject.id) {
    throw invalidContext("The Agent task context no longer matches its V2 project scope.");
  }
  return workspaceTaskPolicyStatus(record.videoTask);
}

/**
 * Binds the legacy-named vehicle tools to the one immutable snapshot locked by
 * the current V2 task. Every execution reloads the task aggregate, so an API
 * restart never depends on the process-local V1 snapshot map.
 */
export function createWorkspaceTaskVehicleService(
  tasks: Pick<VideoTaskProductionStore, "load">,
  taskContext: Readonly<TaskContext>,
  binding: Readonly<WorkspaceAgentTaskBinding>,
): VehicleServicePort {
  const expectedSnapshotId = taskContext.videoTask.vehicleSnapshotId;

  function assertToolScope(scope: Readonly<ToolExecutionScope>): void {
    if (
      binding.videoTaskId !== taskContext.videoTask.id ||
      binding.tenantId !== scope.tenantId ||
      binding.actorId !== scope.actorId ||
      binding.projectId !== scope.projectId ||
      binding.projectId !== taskContext.batchProject.id ||
      !scope.allowedBrandIds.includes(taskContext.brand.id)
    ) {
      throw new VehicleAccessError(
        "The locked vehicle snapshot is outside the authenticated Agent task scope.",
      );
    }
  }

  async function readLockedSnapshot(scope: Readonly<ToolExecutionScope>): Promise<VehicleSnapshot> {
    assertToolScope(scope);
    if (expectedSnapshotId === undefined) {
      throw new VehicleAccessError("The current video task does not have a locked vehicle snapshot.");
    }
    const record = await tasks.load(binding.videoTaskId);
    if (
      record === undefined ||
      record.videoTask.id !== binding.videoTaskId ||
      record.videoTask.tenantId !== binding.tenantId ||
      record.videoTask.batchProjectId !== binding.projectId ||
      record.videoTask.vehicleSnapshotId !== expectedSnapshotId
    ) {
      throw new VehicleAccessError(
        "The current video task no longer matches the locked vehicle snapshot scope.",
      );
    }
    const snapshot = record.taskVehicleSnapshots.find(
      (candidate) => candidate.id === expectedSnapshotId,
    );
    if (
      snapshot === undefined ||
      snapshot.projectId !== binding.projectId ||
      snapshot.brandId !== taskContext.brand.id ||
      snapshot.vehicleId !== taskContext.vehicle.id ||
      snapshot.vehicleVersion !== taskContext.vehicle.version
    ) {
      throw new VehicleAccessError(
        "The current video task's locked vehicle snapshot is unavailable or inconsistent.",
      );
    }
    return structuredClone(snapshot);
  }

  return {
    async createSnapshot(request, scope) {
      const snapshot = await readLockedSnapshot(scope);
      if (request.vehicleId !== snapshot.vehicleId) {
        throw new VehicleNotFoundError(request.vehicleId);
      }
      if (request.color !== undefined && request.color !== snapshot.color) {
        throw new VehicleAccessError(
          "The requested vehicle color does not match the task's locked snapshot.",
        );
      }
      return snapshot;
    },
    async validateClaims(request, scope) {
      if (request.snapshotId !== expectedSnapshotId) {
        throw new SnapshotNotFoundError(request.snapshotId);
      }
      const snapshot = await readLockedSnapshot(scope);
      return validateClaimsAgainstSnapshot(request, snapshot);
    },
  };
}

function notFound(videoTaskId: string): BusinessRuntimeError {
  return new BusinessRuntimeError(
    "AIC-AGENT-VIDEO-TASK_NOT_FOUND",
    `Video task '${videoTaskId}' was not found.`,
    404,
  );
}

function invalidContext(message: string): BusinessRuntimeError {
  return new BusinessRuntimeError(
    "AIC-AGENT-TASK_CONTEXT_INVALID",
    message,
    409,
  );
}

/**
 * Resolves the current V2 task aggregate into the read-only context embedded in
 * an Agent session. Authorization is recalculated from the administration
 * snapshot on every call; the persisted Agent context is never an authority.
 */
export class WorkspaceTaskContextResolver {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskProductionStore,
    private readonly resolveAccountDisplayName: WorkspaceAccountDisplayNameResolver = () => undefined,
  ) {}

  async resolve(
    videoTaskId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<TaskContext> {
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope: WorkspaceSessionScope = {
        actorAccountId: session.actorAccountId,
        tenantId: session.tenantId,
        role: session.role,
        accessGrants: state.accessGrants.filter(
          (grant) => grant.accountId === session.actorAccountId,
        ),
      };
      const record = await this.tasks.load(videoTaskId);
      if (record === undefined || record.videoTask.tenantId !== scope.tenantId) {
        throw notFound(videoTaskId);
      }
      const task = record.videoTask;
      const aggregate = await this.projects.load(scope.tenantId, task.batchProjectId);
      if (aggregate === undefined) throw notFound(videoTaskId);
      const project = aggregate.project;
      assertCanViewVideoTask(scope, project, task);

      const brand = state.brands.find(
        (candidate) => candidate.id === project.brandId && candidate.tenantId === scope.tenantId,
      );
      const vehicle = state.vehicleVersions.find(
        (candidate) =>
          candidate.id === project.vehicleId &&
          candidate.version === project.vehicleVersion &&
          candidate.brandId === project.brandId &&
          candidate.tenantId === scope.tenantId,
      );
      if (brand === undefined || vehicle === undefined) {
        throw invalidContext("The video task's locked brand or vehicle version is unavailable.");
      }

      const snapshot = task.vehicleSnapshotId === undefined
        ? undefined
        : record.taskVehicleSnapshots.find(
            (candidate) => candidate.id === task.vehicleSnapshotId,
          );
      if (
        task.vehicleSnapshotId !== undefined &&
        (
          snapshot === undefined ||
          snapshot.projectId !== project.id ||
          snapshot.brandId !== project.brandId ||
          snapshot.vehicleId !== project.vehicleId ||
          snapshot.vehicleVersion !== project.vehicleVersion
        )
      ) {
        throw invalidContext("The video task's locked vehicle snapshot is inconsistent.");
      }

      let ownership: TaskContextOwnership;
      if (task.ownerAccountId === scope.actorAccountId) {
        ownership = { state: "owned_by_current_account" };
      } else {
        const ownerDisplayName = await this.resolveAccountDisplayName(
          scope.tenantId,
          task.ownerAccountId,
        );
        ownership = {
          state: "owned_by_other_account",
          ownerDisplayName: ownerDisplayName?.normalize("NFKC").trim() || "其他制作账号",
        };
      }

      const context: TaskContext = {
        schemaVersion: 1,
        kind: "task_context",
        brand: { id: brand.id, name: brand.name },
        vehicle: {
          id: vehicle.id,
          displayName: snapshot === undefined
            ? `${vehicle.series} ${vehicle.trim}`
            : `${snapshot.series} ${snapshot.trim}`,
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
          ...(
            task.assetSnapshotId === undefined ||
              (task.status === "active" &&
                (task.currentStage === "strategy" ||
                  task.currentStage === "script" ||
                  task.currentStage === "asset_matching"))
            ? {}
            : { assetSnapshotId: task.assetSnapshotId }),
          ownership,
        },
        productionBrief: {
          audience: task.audience,
          theme: task.theme,
          durationSeconds: task.durationSeconds,
          platformTags: [...task.platformTags],
        },
      };
      if (!Value.Check(TaskContextSchema, context)) {
        throw invalidContext("The video task cannot form a valid Agent task context.");
      }
      return context;
    });
  }
}
