export interface ProjectAssetReference {
  assetId: string;
  version: number;
  source: "company_catalog";
  sourceProvider: string;
  category: "vehicle" | "person" | "scene" | "visual_style";
  vehicleId?: string;
}

export interface ProjectCreationAsset {
  reference: ProjectAssetReference;
  displayName: string;
  description: string;
  preview: {
    mediaType: string;
    width: number;
    height: number;
    thumbnailUrl?: string;
  };
}

export function normalizeProjectCreationOptions(response: unknown): {
  brands: Array<{
    id: string;
    name: string;
    revision: number;
    vehicles: Array<{
      id: string;
      brandId: string;
      version: number;
      series: string;
      modelYear: number;
      trim: string;
      displayName: string;
    }>;
  }>;
  aspectRatios: string[];
};

export function normalizeProjectAssetPackage(response: unknown, vehicleId: string): {
  brandId: string;
  brandName: string;
  associationRevision: number;
  assets: ProjectCreationAsset[];
} | null;

export function normalizeProjectConfiguration(response: unknown): {
  brandRevision: number;
  vehicleVersion: number;
  associationRevision: number;
  defaultVisualStyle: ProjectCreationAsset;
  aspectRatios: string[];
} | null;

export const projectDurationOptions: number[];
export const projectCreativeTypes: Array<{ id: string; label: string }>;

export function createProjectRequest(input: Record<string, unknown>): {
  requestId: string;
  vehicleId: string;
  expectedBrandRevision: number;
  expectedVehicleVersion: number;
  expectedAssetAssociationRevision: number;
  selectedAssets: ProjectAssetReference[];
  aspectRatio: string;
  batchName: string;
  customStylePrompt?: string;
} | null;

export function createInitialVideoTaskRequest(input: Record<string, unknown>): {
  requestId: string;
  name: string;
  audience: string;
  theme: string;
  durationSeconds: number;
  platformTags: string[];
} | null;

export function projectBatchName(creativeTypeId: string, now?: Date): string | null;

export function createProjectCreationWizard(options: Record<string, unknown>): {
  open(): void;
  close(): void;
  resetForAccount(): void;
  syncAvailability(): void;
};
