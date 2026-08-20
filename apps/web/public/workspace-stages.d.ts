import type { VideoTask, VideoTaskStage, VideoTaskStageVersionsResponse } from "@firefly/schemas";

export function stagePosition(task: Readonly<VideoTask>, stage: VideoTaskStage): "complete" | "current" | "locked";
export function rollbackImpact(stage: VideoTaskStage): string[];
export function confirmationAvailability(
  task: Readonly<VideoTask> & { ownedByCurrentAccount?: boolean },
  stage: VideoTaskStage,
  view: Readonly<VideoTaskStageVersionsResponse>,
): { enabled: boolean; label: string; artifact?: Readonly<Record<string, unknown>> };
export interface WorkspaceStatusPresentation {
  tone: "neutral" | "success" | "warning" | "pending" | "danger";
  value: string;
  detail: string;
}
export function workspaceBudgetPresentation(
  view: Readonly<Record<string, unknown>> | null | undefined,
  expectedAccountId: string | null | undefined,
): WorkspaceStatusPresentation;
export function workspaceRunLockPresentation(
  status: Readonly<Record<string, unknown>>,
  videoTaskId: string,
): WorkspaceStatusPresentation;
export function workspaceProductionErrorText(error: unknown): string;
export function createWorkspaceStagesPanel(options: Readonly<Record<string, unknown>>): {
  setContext(projectId: string | undefined, project: unknown, task: VideoTask | null, activeModule: string | null): void;
  refresh(): Promise<void>;
  reset(): void;
  isBusy(): boolean;
};
