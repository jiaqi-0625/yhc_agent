export type WorkspaceFrameModule = "planning" | "assets" | "storyboard" | "production" | "delivery";

export interface WorkspaceFrameTask {
  id: string;
  name: string;
  status: string;
  currentStage: string;
  stageStatus: string;
  revision: number;
  ownedByCurrentAccount: boolean;
  updatedAt: string;
}

export interface WorkspaceFrameProject {
  project: {
    id: string;
    status: string;
    name: string;
    batchName: string;
    aspectRatio: string;
  };
  brand: { name: string };
  vehicle: { displayName: string; version: number };
  tasks: WorkspaceFrameTask[];
  latestActivityAt: string;
}

export interface WorkspaceUrlState {
  projectId: string;
  videoTaskId?: string | null;
  module?: WorkspaceFrameModule | null;
}

export const workspaceTaskContextEventName: "firefly:workspace-task-context-change";

export function workspaceModuleForStage(stage: string | undefined): WorkspaceFrameModule;

export function readWorkspaceUrlState(href: string): {
  projectId: string;
  videoTaskId: string | null;
  module: WorkspaceFrameModule | null;
} | null;

export function workspaceUrlForState(href: string, state?: WorkspaceUrlState | null): string;

export function workspaceOwnerLabel(task: WorkspaceFrameTask | null | undefined): string;

export function summarizeWorkspaceProject(project: WorkspaceFrameProject | null | undefined): {
  total: number;
  active: number;
  pending: number;
  mine: number;
};

export function createWorkspaceContextDetail(
  project: WorkspaceFrameProject,
  task: WorkspaceFrameTask | null,
): Record<string, unknown> | null;

export function resolveWorkspaceSelection(
  projects: WorkspaceFrameProject[] | null | undefined,
  projectId: string,
  taskId?: string,
): { project: WorkspaceFrameProject; task: WorkspaceFrameTask | null } | null;

export function workspaceRouteChangesSelection(
  route: WorkspaceUrlState | null,
  selection: { project: WorkspaceFrameProject; task: WorkspaceFrameTask | null } | null,
): boolean;

export function createWorkspaceFrame(options: Record<string, unknown>): {
  open(projectId: string, taskId?: string): boolean;
  close(): void;
  restore(): boolean;
};
