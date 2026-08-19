import type {
  BatchProject,
  Brand,
  ProjectCreationAspectRatio,
  Vehicle,
} from "@firefly/schemas";

export interface BatchProjectCreationInput {
  batchName: string;
  aspectRatio: ProjectCreationAspectRatio;
  customStylePrompt?: string;
}

export interface BatchProjectCreationContext {
  tenantId: string;
  actorAccountId: string;
  occurredAt: string;
  projectId: string;
  assetPoolId: string;
}

export type BatchProjectCreationErrorCode =
  | "AIC-PROJECT-CREATION-SCOPE_INVALID"
  | "AIC-PROJECT-CREATION-RESOURCE_ARCHIVED"
  | "AIC-PROJECT-CREATION-NAME_INVALID"
  | "AIC-PROJECT-CREATION-ASPECT_RATIO_INVALID";

export class BatchProjectCreationError extends Error {
  constructor(
    readonly code: BatchProjectCreationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BatchProjectCreationError";
  }
}

export const supportedProjectAspectRatios = ["9:16", "16:9", "1:1", "4:5"] as const;

function normalizeRequiredText(value: string, label: string, maximumLength: number): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new BatchProjectCreationError(
      "AIC-PROJECT-CREATION-NAME_INVALID",
      `${label} must contain 1 to ${maximumLength} normalized characters.`,
    );
  }
  return normalized;
}

export function createBatchProject(
  brand: Readonly<Brand>,
  vehicle: Readonly<Vehicle>,
  input: Readonly<BatchProjectCreationInput>,
  context: Readonly<BatchProjectCreationContext>,
): BatchProject {
  if (
    brand.tenantId !== context.tenantId ||
    vehicle.tenantId !== context.tenantId ||
    vehicle.brandId !== brand.id
  ) {
    throw new BatchProjectCreationError(
      "AIC-PROJECT-CREATION-SCOPE_INVALID",
      "The brand and vehicle must share the authenticated tenant and hierarchy.",
    );
  }
  if (brand.status !== "active" || vehicle.status !== "active") {
    throw new BatchProjectCreationError(
      "AIC-PROJECT-CREATION-RESOURCE_ARCHIVED",
      "Batch projects can only be created for active brands and vehicles.",
    );
  }
  if (!supportedProjectAspectRatios.includes(input.aspectRatio)) {
    throw new BatchProjectCreationError(
      "AIC-PROJECT-CREATION-ASPECT_RATIO_INVALID",
      "The requested project aspect ratio is not supported.",
    );
  }
  const brandName = normalizeRequiredText(brand.name, "Brand name", 120);
  const series = normalizeRequiredText(vehicle.series, "Vehicle series", 120);
  const trim = normalizeRequiredText(vehicle.trim, "Vehicle trim", 120);
  const batchName = normalizeRequiredText(input.batchName, "Batch name", 120);
  const name = `${brandName} ${series} ${trim} ${input.aspectRatio} ${batchName}`;
  if (name.length > 240) {
    throw new BatchProjectCreationError(
      "AIC-PROJECT-CREATION-NAME_INVALID",
      "The generated project name exceeds 240 characters.",
    );
  }
  const customStylePrompt = input.customStylePrompt === undefined
    ? undefined
    : normalizeRequiredText(input.customStylePrompt, "Custom style prompt", 2000);
  return {
    id: context.projectId,
    tenantId: context.tenantId,
    brandId: brand.id,
    vehicleId: vehicle.id,
    name,
    batchName,
    aspectRatio: input.aspectRatio,
    visualStylePresetId: brand.defaultVisualStylePresetId,
    ...(customStylePrompt === undefined ? {} : { customStylePrompt }),
    assetPoolId: context.assetPoolId,
    status: "active",
    revision: 1,
    createdAt: context.occurredAt,
    createdBy: context.actorAccountId,
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}
