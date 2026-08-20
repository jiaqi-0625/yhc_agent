export interface WorkspaceAgentTaskBinding {
  projectId: string;
  brandId: string;
  vehicleId: string;
  vehicleVersion: number;
}

export function workspaceAgentTaskBinding(projects: unknown, videoTaskId: string): WorkspaceAgentTaskBinding | null;
export function assertWorkspaceAgentSession<T>(summary: T, videoTaskId: string | null, projects: unknown): T;
