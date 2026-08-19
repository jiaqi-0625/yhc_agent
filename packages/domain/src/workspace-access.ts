import type {
  BatchProject,
  Brand,
  Role,
  Vehicle,
  VideoTask,
  WorkspaceAccessGrant,
} from "@firefly/schemas";

export interface WorkspaceSessionScope {
  actorAccountId: string;
  tenantId: string;
  role: Role;
  accessGrants: readonly WorkspaceAccessGrant[];
}

export type WorkspaceAccessDeniedCode =
  | "AIC-AUTH-TENANT_SCOPE_DENIED"
  | "AIC-AUTH-BRAND_SCOPE_DENIED"
  | "AIC-AUTH-PROJECT_SCOPE_DENIED"
  | "AIC-AUTH-TASK_SCOPE_DENIED"
  | "AIC-AUTH-TASK_OWNER_REQUIRED"
  | "AIC-AUTH-TASK_ALREADY_OWNED"
  | "AIC-AUTH-ROLE_DENIED";

export class WorkspaceAccessDeniedError extends Error {
  constructor(
    readonly code: WorkspaceAccessDeniedCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceAccessDeniedError";
  }
}

function activeGrants(scope: Readonly<WorkspaceSessionScope>): readonly WorkspaceAccessGrant[] {
  return scope.accessGrants.filter(
    (grant) =>
      grant.status === "active" &&
      grant.tenantId === scope.tenantId &&
      grant.accountId === scope.actorAccountId,
  );
}

function assertTenant(scope: Readonly<WorkspaceSessionScope>, tenantId: string): void {
  if (tenantId !== scope.tenantId) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-TENANT_SCOPE_DENIED",
      "The resource is outside the authenticated tenant scope.",
    );
  }
}

function hasBrandGrant(scope: Readonly<WorkspaceSessionScope>, brandId: string): boolean {
  return activeGrants(scope).some(
    (grant) => grant.access.kind === "brand" && grant.access.brandId === brandId,
  );
}

function hasVehicleProjectGrant(
  scope: Readonly<WorkspaceSessionScope>,
  brandId: string,
  vehicleId: string,
): boolean {
  return activeGrants(scope).some(
    (grant) =>
      grant.access.kind === "vehicle_project" &&
      grant.access.brandId === brandId &&
      grant.access.vehicleId === vehicleId,
  );
}

export function canViewBrand(
  scope: Readonly<WorkspaceSessionScope>,
  brand: Readonly<Brand>,
): boolean {
  if (brand.tenantId !== scope.tenantId) return false;
  return activeGrants(scope).some((grant) => grant.access.brandId === brand.id);
}

export function assertCanViewBrand(
  scope: Readonly<WorkspaceSessionScope>,
  brand: Readonly<Brand>,
): void {
  assertTenant(scope, brand.tenantId);
  if (!canViewBrand(scope, brand)) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-BRAND_SCOPE_DENIED",
      "The account does not have access to this brand.",
    );
  }
}

export function assertCanManageBrand(
  scope: Readonly<WorkspaceSessionScope>,
  brand: Readonly<Brand>,
): void {
  assertTenant(scope, brand.tenantId);
  if (scope.role !== "content_admin") {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-ROLE_DENIED",
      "Only a content administrator can manage brands and vehicles.",
    );
  }
  if (!hasBrandGrant(scope, brand.id)) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-BRAND_SCOPE_DENIED",
      "The administrator does not manage this brand.",
    );
  }
}

export function assertCanCreateBatchProject(
  scope: Readonly<WorkspaceSessionScope>,
  brand: Readonly<Brand>,
  vehicle: Readonly<Vehicle>,
): void {
  assertTenant(scope, brand.tenantId);
  assertTenant(scope, vehicle.tenantId);
  if (vehicle.brandId !== brand.id) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-BRAND_SCOPE_DENIED",
      "The vehicle does not belong to the requested brand.",
    );
  }
  if (scope.role !== "creator") {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-ROLE_DENIED",
      "Only an authorized production account can create a batch project.",
    );
  }
  if (!hasVehicleProjectGrant(scope, brand.id, vehicle.id)) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-PROJECT_SCOPE_DENIED",
      "The account does not have vehicle-project access for this brand and vehicle.",
    );
  }
}

export function canViewBatchProject(
  scope: Readonly<WorkspaceSessionScope>,
  project: Readonly<BatchProject>,
): boolean {
  if (project.tenantId !== scope.tenantId) return false;
  if (scope.role === "content_admin" && hasBrandGrant(scope, project.brandId)) return true;
  return hasVehicleProjectGrant(scope, project.brandId, project.vehicleId);
}

export function assertCanViewBatchProject(
  scope: Readonly<WorkspaceSessionScope>,
  project: Readonly<BatchProject>,
): void {
  assertTenant(scope, project.tenantId);
  if (!canViewBatchProject(scope, project)) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-PROJECT_SCOPE_DENIED",
      "The account is not a member of this vehicle project.",
    );
  }
}

function assertTaskBelongsToProject(
  project: Readonly<BatchProject>,
  task: Readonly<VideoTask>,
): void {
  if (task.tenantId !== project.tenantId || task.batchProjectId !== project.id) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-TASK_SCOPE_DENIED",
      "The video task does not belong to the requested batch project.",
    );
  }
}

export function canViewVideoTask(
  scope: Readonly<WorkspaceSessionScope>,
  project: Readonly<BatchProject>,
  task: Readonly<VideoTask>,
): boolean {
  return (
    task.tenantId === scope.tenantId &&
    task.tenantId === project.tenantId &&
    task.batchProjectId === project.id &&
    canViewBatchProject(scope, project)
  );
}

export function assertCanViewVideoTask(
  scope: Readonly<WorkspaceSessionScope>,
  project: Readonly<BatchProject>,
  task: Readonly<VideoTask>,
): void {
  assertTenant(scope, task.tenantId);
  assertCanViewBatchProject(scope, project);
  assertTaskBelongsToProject(project, task);
}

export function assertCanOperateVideoTask(
  scope: Readonly<WorkspaceSessionScope>,
  project: Readonly<BatchProject>,
  task: Readonly<VideoTask>,
): void {
  assertCanViewVideoTask(scope, project, task);
  if (task.ownerAccountId !== scope.actorAccountId) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-TASK_OWNER_REQUIRED",
      "Only the current task owner can change task state.",
    );
  }
}

export function assertCanTakeOverVideoTask(
  scope: Readonly<WorkspaceSessionScope>,
  project: Readonly<BatchProject>,
  task: Readonly<VideoTask>,
): void {
  assertCanViewVideoTask(scope, project, task);
  if (!hasVehicleProjectGrant(scope, project.brandId, project.vehicleId)) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-PROJECT_SCOPE_DENIED",
      "Brand administrators may view this task but need vehicle-project membership to take it over.",
    );
  }
  if (task.ownerAccountId === scope.actorAccountId) {
    throw new WorkspaceAccessDeniedError(
      "AIC-AUTH-TASK_ALREADY_OWNED",
      "The account already owns this task.",
    );
  }
}
