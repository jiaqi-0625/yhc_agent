import type {
  AssetCategory,
  BatchProject,
  ProjectAssetPool,
  TemporaryAsset,
  TemporaryAssetReference,
  TemporaryAssetValidationIssue,
  TemporaryAssetValidationStatus,
} from "@firefly/schemas";

import { assertRevision } from "./workflow.ts";

const MAX_IMAGE_BYTES = 50_000_000;
const MAX_VIDEO_BYTES = 500_000_000;
const MIN_MEDIA_EDGE_PIXELS = 720;
const CHECKSUM_PATTERN = /^[a-f\d]{64}$/i;
const SAFE_FILE_NAME_PATTERN = /^[^\\/\r\n]{1,255}$/;
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MEDIA_TYPE_PATTERN = /^(image|video)\/[A-Za-z0-9.+-]+$/;
const assetCategories = new Set<AssetCategory>(["vehicle", "person", "scene", "visual_style"]);

const supportedMediaExtensions = new Map<string, readonly string[]>([
  ["image/jpeg", ["jpg", "jpeg"]],
  ["image/png", ["png"]],
  ["image/webp", ["webp"]],
  ["video/mp4", ["mp4"]],
  ["video/webm", ["webm"]],
]);

export interface TemporaryAssetMutationContext {
  tenantId: string;
  actorAccountId: string;
  occurredAt: string;
  createId: (kind: "temporary_asset") => string;
}

export interface RegisterTemporaryAssetCommand {
  // The API runtime must populate these file facts from trusted server-side inspection.
  category: AssetCategory;
  fileName: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  checksumSha256: string;
  sourceDescription: string;
  rightsDeclaration: string;
  rightsConfirmed: boolean;
  expiresAt?: string;
}

export interface UpdateTemporaryAssetDeclarationCommand {
  sourceDescription: string;
  rightsDeclaration: string;
  rightsConfirmed: boolean;
  expiresAt?: string;
}

export interface AddTemporaryAssetToProjectPoolResult {
  reference: TemporaryAssetReference;
  pool: ProjectAssetPool;
}

export type TemporaryAssetErrorCode =
  | "AIC-ASSET-TEMPORARY_SCOPE_INVALID"
  | "AIC-ASSET-TEMPORARY_METADATA_INVALID"
  | "AIC-ASSET-TEMPORARY_STATE_INVALID"
  | "AIC-ASSET-TEMPORARY_NOT_USABLE"
  | "AIC-ASSET-TEMPORARY_POOL_DUPLICATE"
  | "AIC-ASSET-TEMPORARY_POOL_FULL";

export class TemporaryAssetError extends Error {
  constructor(
    readonly code: TemporaryAssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TemporaryAssetError";
  }
}

function metadataError(message: string): never {
  throw new TemporaryAssetError("AIC-ASSET-TEMPORARY_METADATA_INVALID", message);
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 2_000) {
    metadataError(`${field} must contain 1 to 2000 characters.`);
  }
  return normalized;
}

function parseIsoDateTime(value: string, field: string): number {
  const match = ISO_DATE_TIME_PATTERN.exec(value);
  const timestamp = Date.parse(value);
  if (match === null || !Number.isFinite(timestamp)) {
    metadataError(`${field} must be a valid ISO 8601 date-time.`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const maximumDay = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (
    day < 1 ||
    day > maximumDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    metadataError(`${field} must be a valid ISO 8601 date-time.`);
  }
  return timestamp;
}

function assertMutationTime(context: Readonly<TemporaryAssetMutationContext>): number {
  return parseIsoDateTime(context.occurredAt, "Mutation time");
}

function assertFutureExpiry(expiresAt: string | undefined, occurredAt: number): void {
  if (expiresAt !== undefined && parseIsoDateTime(expiresAt, "Expiry time") <= occurredAt) {
    metadataError("Expiry time must be later than the mutation time.");
  }
}

function assertRegistrationShape(command: Readonly<RegisterTemporaryAssetCommand>): void {
  if (!assetCategories.has(command.category)) {
    metadataError("The asset category is invalid.");
  }
  if (!SAFE_FILE_NAME_PATTERN.test(command.fileName)) {
    metadataError("The file name must be a safe base name of at most 255 characters.");
  }
  if (!Number.isInteger(command.byteSize) || command.byteSize < 1 || command.byteSize > 5_000_000_000) {
    metadataError("The file size must be an integer between 1 and 5000000000 bytes.");
  }
  if (
    !Number.isInteger(command.width) ||
    command.width < 1 ||
    command.width > 32_768 ||
    !Number.isInteger(command.height) ||
    command.height < 1 ||
    command.height > 32_768
  ) {
    metadataError("Media dimensions must be integer pixels between 1 and 32768.");
  }
  if (!CHECKSUM_PATTERN.test(command.checksumSha256)) {
    metadataError("The SHA-256 checksum must contain exactly 64 hexadecimal characters.");
  }
  if (!MEDIA_TYPE_PATTERN.test(command.mediaType)) {
    metadataError("The media type must identify image or video media.");
  }
  if (typeof command.rightsConfirmed !== "boolean") {
    metadataError("Rights confirmation must be a boolean.");
  }
  normalizeRequiredText(command.sourceDescription, "Source description");
  normalizeRequiredText(command.rightsDeclaration, "Rights declaration");
}

function assertAssetScope(
  asset: Readonly<TemporaryAsset>,
  project: Readonly<BatchProject>,
  context: Readonly<TemporaryAssetMutationContext>,
): void {
  if (
    project.status !== "active" ||
    project.tenantId !== context.tenantId ||
    asset.tenantId !== project.tenantId ||
    asset.batchProjectId !== project.id ||
    asset.vehicleId !== project.vehicleId
  ) {
    throw new TemporaryAssetError(
      "AIC-ASSET-TEMPORARY_SCOPE_INVALID",
      "The temporary asset is outside the authenticated project scope.",
    );
  }
}

function issue(code: string, message: string): TemporaryAssetValidationIssue {
  return { code, message };
}

function fileExtension(fileName: string): string | undefined {
  const separator = fileName.lastIndexOf(".");
  if (separator < 1 || separator === fileName.length - 1) return undefined;
  return fileName.slice(separator + 1).toLowerCase();
}

function collectTechnicalIssues(
  asset: Readonly<TemporaryAsset>,
  occurredAt: number,
): TemporaryAssetValidationIssue[] {
  const issues: TemporaryAssetValidationIssue[] = [];
  const mediaType = asset.mediaType.toLowerCase();
  const extensions = supportedMediaExtensions.get(mediaType);
  if (extensions === undefined) {
    issues.push(issue("AIC-ASSET-FORMAT_UNSUPPORTED", "Only JPEG, PNG, WebP, MP4, and WebM files are supported."));
    return issues;
  }
  const extension = fileExtension(asset.fileName);
  if (extension === undefined || !extensions.includes(extension)) {
    issues.push(issue("AIC-ASSET-EXTENSION_MISMATCH", "The file extension does not match the declared media type."));
  }
  const maximumBytes = mediaType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (asset.byteSize > maximumBytes) {
    issues.push(
      issue(
        "AIC-ASSET-FILE_TOO_LARGE",
        mediaType.startsWith("image/")
          ? "Image files must not exceed 50 MB."
          : "Video files must not exceed 500 MB.",
      ),
    );
  }
  if (Math.min(asset.width, asset.height) < MIN_MEDIA_EDGE_PIXELS) {
    issues.push(issue("AIC-ASSET-DIMENSIONS_TOO_SMALL", "The shortest media edge must be at least 720 pixels."));
  }
  if (
    asset.expiresAt !== undefined &&
    parseIsoDateTime(asset.expiresAt, "Expiry time") <= occurredAt
  ) {
    issues.push(issue("AIC-ASSET-EXPIRED", "The temporary asset has expired."));
  }
  return issues;
}

export function registerTemporaryAsset(
  project: Readonly<BatchProject>,
  command: Readonly<RegisterTemporaryAssetCommand>,
  context: Readonly<TemporaryAssetMutationContext>,
): TemporaryAsset {
  if (project.status !== "active" || project.tenantId !== context.tenantId) {
    throw new TemporaryAssetError(
      "AIC-ASSET-TEMPORARY_SCOPE_INVALID",
      "The project is outside the authenticated tenant scope.",
    );
  }
  const occurredAt = assertMutationTime(context);
  assertFutureExpiry(command.expiresAt, occurredAt);
  assertRegistrationShape(command);
  return {
    id: context.createId("temporary_asset"),
    tenantId: project.tenantId,
    batchProjectId: project.id,
    vehicleId: project.vehicleId,
    version: 1,
    revision: 1,
    category: command.category,
    fileName: command.fileName,
    mediaType: command.mediaType.toLowerCase(),
    byteSize: command.byteSize,
    width: command.width,
    height: command.height,
    checksumSha256: command.checksumSha256.toLowerCase(),
    sourceDescription: normalizeRequiredText(command.sourceDescription, "Source description"),
    rightsDeclaration: normalizeRequiredText(command.rightsDeclaration, "Rights declaration"),
    rightsConfirmed: command.rightsConfirmed,
    validationStatus: "pending",
    validationIssues: [],
    ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
    createdAt: context.occurredAt,
    createdBy: context.actorAccountId,
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}

export function validateTemporaryAsset(
  current: Readonly<TemporaryAsset>,
  project: Readonly<BatchProject>,
  projectAssets: readonly Readonly<TemporaryAsset>[],
  expectedRevision: number,
  context: Readonly<TemporaryAssetMutationContext>,
): TemporaryAsset {
  assertRevision(expectedRevision, current.revision);
  assertAssetScope(current, project, context);
  const occurredAt = assertMutationTime(context);
  if (current.validationStatus !== "pending") {
    throw new TemporaryAssetError(
      "AIC-ASSET-TEMPORARY_STATE_INVALID",
      "Only pending temporary assets may be validated for the current binary version.",
    );
  }
  const technicalIssues = collectTechnicalIssues(current, occurredAt);
  const currentCreatedAt = Date.parse(current.createdAt);
  const duplicate = projectAssets
    .filter((candidate) => {
      const candidateCreatedAt = Date.parse(candidate.createdAt);
      return (
        candidate.id !== current.id &&
        candidate.tenantId === current.tenantId &&
        candidate.batchProjectId === current.batchProjectId &&
        candidate.checksumSha256.toLowerCase() === current.checksumSha256.toLowerCase() &&
        (candidateCreatedAt < currentCreatedAt ||
          (candidateCreatedAt === currentCreatedAt && candidate.id.localeCompare(current.id) < 0))
      );
    })
    .toSorted((left, right) => {
      const timestampDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return timestampDifference === 0 ? left.id.localeCompare(right.id) : timestampDifference;
    })[0];
  const reviewIssues: TemporaryAssetValidationIssue[] = [];
  if (duplicate !== undefined) {
    reviewIssues.push(issue("AIC-ASSET-DUPLICATE", "Another project asset has the same SHA-256 checksum."));
  }
  if (!current.rightsConfirmed) {
    reviewIssues.push(issue("AIC-ASSET-RIGHTS_UNCONFIRMED", "Usage rights must be explicitly confirmed before this asset can be used."));
  }
  const validationStatus: TemporaryAssetValidationStatus =
    technicalIssues.length > 0 ? "rejected" : reviewIssues.length > 0 ? "needs_review" : "valid";
  const { duplicateOfAssetId: _previousDuplicate, ...base } = structuredClone(current);
  return {
    ...base,
    revision: current.revision + 1,
    validationStatus,
    validationIssues: [...technicalIssues, ...reviewIssues],
    ...(duplicate === undefined ? {} : { duplicateOfAssetId: duplicate.id }),
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}

export function updateTemporaryAssetDeclaration(
  current: Readonly<TemporaryAsset>,
  project: Readonly<BatchProject>,
  command: Readonly<UpdateTemporaryAssetDeclarationCommand>,
  expectedRevision: number,
  context: Readonly<TemporaryAssetMutationContext>,
): TemporaryAsset {
  assertRevision(expectedRevision, current.revision);
  assertAssetScope(current, project, context);
  const occurredAt = assertMutationTime(context);
  assertFutureExpiry(command.expiresAt, occurredAt);
  if (current.validationStatus !== "pending" && current.validationStatus !== "needs_review") {
    throw new TemporaryAssetError(
      "AIC-ASSET-TEMPORARY_STATE_INVALID",
      "Declarations may only be updated while a temporary asset is pending or needs review.",
    );
  }
  const sourceDescription = normalizeRequiredText(command.sourceDescription, "Source description");
  const rightsDeclaration = normalizeRequiredText(command.rightsDeclaration, "Rights declaration");
  const {
    duplicateOfAssetId: _previousDuplicate,
    expiresAt: _previousExpiry,
    ...base
  } = structuredClone(current);
  return {
    ...base,
    revision: current.revision + 1,
    sourceDescription,
    rightsDeclaration,
    rightsConfirmed: command.rightsConfirmed,
    validationStatus: "pending" as const,
    validationIssues: [],
    ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
    updatedAt: context.occurredAt,
    updatedBy: context.actorAccountId,
  };
}

export function addTemporaryAssetToProjectPool(
  current: Readonly<TemporaryAsset>,
  project: Readonly<BatchProject>,
  pool: Readonly<ProjectAssetPool>,
  expectedAssetRevision: number,
  expectedPoolRevision: number,
  context: Readonly<TemporaryAssetMutationContext>,
): AddTemporaryAssetToProjectPoolResult {
  assertRevision(expectedAssetRevision, current.revision);
  assertRevision(expectedPoolRevision, pool.revision);
  assertAssetScope(current, project, context);
  const occurredAt = assertMutationTime(context);
  if (
    project.status !== "active" ||
    pool.id !== project.assetPoolId ||
    pool.tenantId !== project.tenantId ||
    pool.batchProjectId !== project.id ||
    pool.vehicleId !== project.vehicleId
  ) {
    throw new TemporaryAssetError(
      "AIC-ASSET-TEMPORARY_SCOPE_INVALID",
      "The project asset pool is outside the authenticated project scope.",
    );
  }
  if (
    current.validationStatus !== "valid" ||
    current.validationIssues.length !== 0 ||
    !current.rightsConfirmed ||
    (current.expiresAt !== undefined && parseIsoDateTime(current.expiresAt, "Expiry time") <= occurredAt)
  ) {
    throw new TemporaryAssetError(
      "AIC-ASSET-TEMPORARY_NOT_USABLE",
      "Only valid temporary assets with confirmed usage rights may enter the project asset pool.",
    );
  }
  const duplicate = pool.assets.some(
    (candidate) =>
      candidate.source === "local_upload" &&
      (candidate.assetId === current.id ||
        candidate.checksumSha256.toLowerCase() === current.checksumSha256.toLowerCase()),
  );
  if (duplicate) {
    throw new TemporaryAssetError(
      "AIC-ASSET-TEMPORARY_POOL_DUPLICATE",
      "The project asset pool already contains this temporary asset or checksum.",
    );
  }
  if (pool.assets.length >= 500) {
    throw new TemporaryAssetError(
      "AIC-ASSET-TEMPORARY_POOL_FULL",
      "The project asset pool cannot contain more than 500 assets.",
    );
  }
  const reference: TemporaryAssetReference = {
    assetId: current.id,
    version: current.version,
    category: current.category,
    source: "local_upload",
    batchProjectId: current.batchProjectId,
    checksumSha256: current.checksumSha256,
  };
  return {
    reference: structuredClone(reference),
    pool: {
      ...structuredClone(pool),
      revision: pool.revision + 1,
      assets: [...structuredClone(pool.assets), structuredClone(reference)],
      updatedAt: context.occurredAt,
      updatedBy: context.actorAccountId,
    },
  };
}
