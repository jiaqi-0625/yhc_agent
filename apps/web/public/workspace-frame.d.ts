export type WorkspaceFrameModule = "planning" | "assets" | "storyboard" | "production" | "delivery";

export interface WorkspaceFrameTask {
  id: string;
  name?: string;
  status: string;
  currentStage: string;
  stageStatus?: string;
  revision?: number;
  ownedByCurrentAccount?: boolean;
}

export interface WorkspaceFrameProject {
  project: {
    id: string;
    status: string;
    batchName?: string;
    aspectRatio?: string;
  };
  brand?: { name?: string };
  vehicle?: { displayName?: string; version?: number };
  tasks: WorkspaceFrameTask[];
}

export function workspaceModuleForStage(stage: string | undefined): WorkspaceFrameModule;

export function resolveWorkspaceSelection(
  projects: WorkspaceFrameProject[] | null | undefined,
  projectId: string,
  taskId?: string,
): { project: WorkspaceFrameProject; task: WorkspaceFrameTask | null } | null;

export function createWorkspaceFrame(options: Record<string, unknown>): {
  open(projectId: string, taskId?: string): boolean;
  close(): void;
};
