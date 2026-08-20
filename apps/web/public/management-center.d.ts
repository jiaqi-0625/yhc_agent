import type {
  CreateVehicleRequest,
  CreateWorkspaceAccessGrantRequest,
  ReplaceVehicleAssetAssociationsRequest,
  Role,
} from "@firefly/schemas";

export type ManagementSectionId = "overview" | "catalog" | "assets" | "access" | "budgets";

export interface ManagementSection {
  readonly id: ManagementSectionId;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
}

export const managementSections: readonly ManagementSection[];

export type VehicleFactsInput = Readonly<Record<string, unknown>> & {
  readonly status?: unknown;
  readonly series?: unknown;
  readonly modelYear?: unknown;
  readonly trim?: unknown;
  readonly parametersText?: unknown;
  readonly fixedClaimsText?: unknown;
  readonly optionalClaimsText?: unknown;
  readonly prohibitedClaimsText?: unknown;
  readonly expectedVersion?: unknown;
};

export type ManagementVehicleFactsRequest = CreateVehicleRequest & {
  expectedVersion?: number;
};

export function createVehicleFactsRequest(
  input: VehicleFactsInput,
): ManagementVehicleFactsRequest;

export function assetReferenceIdentity(reference: unknown): string;

export interface AssetPaginationCursorDecision {
  readonly nextCursor: string | null;
  readonly error: string | null;
}

export function resolveAssetPaginationCursor(
  responseCursor: unknown,
  requestedCursor: unknown,
  seenCursors: ReadonlySet<string> | unknown,
): AssetPaginationCursorDecision;

export interface ManagementVisualStyleCatalogItem {
  readonly reference?: {
    readonly assetId?: string;
    readonly version?: number;
  };
  readonly brandIds?: readonly string[];
  readonly displayName?: string;
  readonly [key: string]: unknown;
}

export function resolveBrandVisualStyleOptions(
  styles: readonly ManagementVisualStyleCatalogItem[] | null | undefined,
  brand?: {
    readonly id?: string;
    readonly defaultVisualStylePresetId?: string;
  } | null,
): ManagementVisualStyleCatalogItem[];

export function createAssetAssociationRequest(
  expectedRevision: unknown,
  references: readonly unknown[],
  vehicleId: unknown,
): ReplaceVehicleAssetAssociationsRequest;

export function createAccessGrantRequest(
  input: Readonly<Record<string, unknown>>,
): CreateWorkspaceAccessGrantRequest;

export function majorAmountToMinor(value: unknown, currency?: string): number;

export function minorAmountToMajor(value: number, currency?: string): string;

export function formatMinorAmount(value: number, currency?: string): string;

export interface ManagedTaskSummary {
  readonly status?: string;
  readonly stageStatus?: string;
}

export interface ManagedProjectSummary {
  readonly project?: {
    readonly status?: string;
  } | null;
  readonly tasks?: readonly (ManagedTaskSummary | null | undefined)[] | null;
}

export interface ManagedProjectCounts {
  readonly projects: number;
  readonly activeProjects: number;
  readonly tasks: number;
  readonly activeTasks: number;
  readonly pendingTasks: number;
}

export function summarizeManagedProjects(
  projects: readonly ManagedProjectSummary[] | null | undefined,
): ManagedProjectCounts;

export function managementErrorMessage(error: unknown, fallback?: string): string;

export interface ManagementAccount {
  readonly accountId: string;
  readonly tenantId?: string;
  readonly displayName?: string;
  readonly role: Role;
}

export interface ManagementCenterOptions {
  readonly api: Readonly<Record<string, unknown>>;
  readonly mount?: unknown;
  readonly topbarActions?: unknown;
  readonly topbarTitle?: unknown;
  readonly getProjects?: () => readonly ManagedProjectSummary[] | null | undefined;
  readonly onBeforeOpen?: () => void;
  readonly onAfterClose?: (detail: { reason: "user" | "account" | "history" }) => void;
  readonly onCatalogChanged?: () => void | Promise<void>;
}

export interface ManagementCenterController {
  open(): void;
  close(): void;
  setAccount(account: ManagementAccount | null | undefined, disabled?: boolean): void;
  refresh(): Promise<void>;
}

export function createManagementCenter(
  options: ManagementCenterOptions,
): ManagementCenterController;
