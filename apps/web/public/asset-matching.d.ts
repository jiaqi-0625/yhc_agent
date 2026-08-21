import type { AssetReference } from "@firefly/schemas";

export function assetReferenceIdentity(reference: Readonly<AssetReference>): string;

export function selectionWithManualPriority(
  recommendations: readonly AssetReference[],
  manualSelection: ReadonlySet<string> | null,
): Set<string>;

export function assetMatchingTaskContextKey(
  projectId: string | null | undefined,
  task: Readonly<{
    id?: string;
    revision?: number;
    status?: string;
    currentStage?: string;
    stageStatus?: string;
  }> | null,
  visible: boolean,
): string;

export function createAssetMatchingPanel(options: Readonly<Record<string, unknown>>): {
  setContext(projectId: string | undefined, task: {
    id?: string;
    revision?: number;
    status?: string;
    currentStage?: string;
    stageStatus?: string;
  } | null, visible: boolean): void;
  refresh(): Promise<void>;
};
