import { canViewBatchProject, type WorkspaceSessionScope } from "@firefly/domain";
import type { BatchProject, VideoTask } from "@firefly/schemas";

import type { BatchProjectStore } from "./batch-project-store.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import type { VideoTaskCreationStore } from "./video-task-store.ts";
import type { WorkspaceAdminState, WorkspaceAdminStore } from "./workspace-admin-store.ts";

export interface ProjectLibraryTaskSummary {
  id: string;
  name: string;
  status: VideoTask["status"];
  currentStage: VideoTask["currentStage"];
  stageStatus: VideoTask["stageStatus"];
  revision: number;
  ownedByCurrentAccount: boolean;
  updatedAt: string;
}

export interface ProjectLibraryProjectSummary {
  project: Pick<
    BatchProject,
    | "id"
    | "brandId"
    | "vehicleId"
    | "vehicleVersion"
    | "name"
    | "batchName"
    | "aspectRatio"
    | "status"
    | "revision"
    | "createdAt"
    | "updatedAt"
  >;
  brand: {
    id: string;
    name: string;
  };
  vehicle: {
    id: string;
    version: number;
    series: string;
    modelYear: number;
    trim: string;
    displayName: string;
  };
  tasks: ProjectLibraryTaskSummary[];
  latestActivityAt: string;
}

function currentScope(
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

function timestampEpoch(value: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) {
    throw new BusinessRuntimeError(
      "AIC-PROJECT-LIBRARY-DATETIME_INVALID",
      "The project library contains an invalid activity time.",
      500,
    );
  }
  return epoch;
}

function compareTimestampDescending(left: string, right: string): number {
  const leftEpoch = timestampEpoch(left);
  const rightEpoch = timestampEpoch(right);
  return rightEpoch < leftEpoch ? -1 : rightEpoch > leftEpoch ? 1 : 0;
}

function latestTimestamp(values: readonly string[]): string {
  return values.reduce((latest, value) =>
    timestampEpoch(value) > timestampEpoch(latest) ? value : latest);
}

function projectIdentity(
  project: Readonly<BatchProject>,
  state: Readonly<WorkspaceAdminState>,
) {
  const brand = state.brands.find((candidate) => candidate.id === project.brandId);
  const vehicle = state.vehicleVersions.find(
    (candidate) =>
      candidate.id === project.vehicleId && candidate.version === project.vehicleVersion,
  );
  if (!brand || !vehicle || vehicle.brandId !== brand.id) {
    throw new BusinessRuntimeError(
      "AIC-PROJECT-LIBRARY-CATALOG_REFERENCE_INVALID",
      "The project library contains a project with unavailable brand or vehicle facts.",
      500,
    );
  }
  return { brand, vehicle };
}

export class ProjectLibraryRuntime {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskCreationStore,
  ) {}

  async list(
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ProjectLibraryProjectSummary[]> {
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = currentScope(session, state);
      const [projectAggregates, taskRecords] = await Promise.all([
        this.projects.list(session.tenantId),
        this.tasks.list(session.tenantId),
      ]);
      const visibleProjects = projectAggregates.filter(
        (aggregate) => canViewBatchProject(scope, aggregate.project),
      );
      const visibleIds = new Set(visibleProjects.map((aggregate) => aggregate.project.id));
      const tasksByProject = new Map<string, VideoTask[]>();
      for (const record of taskRecords) {
        const task = record.videoTask;
        if (!visibleIds.has(task.batchProjectId)) continue;
        const projectTasks = tasksByProject.get(task.batchProjectId) ?? [];
        projectTasks.push(task);
        tasksByProject.set(task.batchProjectId, projectTasks);
      }

      return visibleProjects.map((aggregate) => {
        const { project, assetPool } = aggregate;
        const { brand, vehicle } = projectIdentity(project, state);
        const projectTasks = (tasksByProject.get(project.id) ?? []).sort(
          (left, right) =>
            compareTimestampDescending(left.updatedAt, right.updatedAt) ||
            left.id.localeCompare(right.id, "en"),
        );
        return {
          project: {
            id: project.id,
            brandId: project.brandId,
            vehicleId: project.vehicleId,
            vehicleVersion: project.vehicleVersion,
            name: project.name,
            batchName: project.batchName,
            aspectRatio: project.aspectRatio,
            status: project.status,
            revision: project.revision,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
          brand: { id: brand.id, name: brand.name },
          vehicle: {
            id: vehicle.id,
            version: vehicle.version,
            series: vehicle.series,
            modelYear: vehicle.modelYear,
            trim: vehicle.trim,
            displayName: `${vehicle.series} ${vehicle.modelYear} ${vehicle.trim}`,
          },
          tasks: projectTasks.map((task) => ({
            id: task.id,
            name: task.name,
            status: task.status,
            currentStage: task.currentStage,
            stageStatus: task.stageStatus,
            revision: task.revision,
            ownedByCurrentAccount: task.ownerAccountId === session.actorAccountId,
            updatedAt: task.updatedAt,
          })),
          latestActivityAt: latestTimestamp([
            project.updatedAt,
            assetPool.updatedAt,
            ...projectTasks.map((task) => task.updatedAt),
          ]),
        } satisfies ProjectLibraryProjectSummary;
      }).sort((left, right) =>
        compareTimestampDescending(left.latestActivityAt, right.latestActivityAt) ||
        left.project.id.localeCompare(right.project.id, "en"));
    });
  }
}
