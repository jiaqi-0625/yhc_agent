import type { VideoTask, VideoTaskStage, VideoTaskStageVersionsResponse } from "@firefly/schemas";

export function stagePosition(task: Readonly<VideoTask>, stage: VideoTaskStage): "complete" | "current" | "locked";
export function rollbackImpact(stage: VideoTaskStage): string[];
export function expectedVideoShotCount(durationSeconds: number): number;
export function remainingVideoShotIndices(
  shotCount: number,
  generations: ReadonlyArray<Readonly<Record<string, unknown>>>,
): number[];
export function latestVideoGenerationForShot(
  generations: ReadonlyArray<Readonly<Record<string, unknown>>>,
  shotIndex: number,
): Readonly<Record<string, unknown>> | null;
export function simulatedStageActionCard(
  videoTaskId: string,
  stage: "storyboard" | "video_preview" | "delivery",
  expectedRevision: number,
): Readonly<Record<string, unknown>>;
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
