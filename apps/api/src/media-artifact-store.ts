import { createHash } from "node:crypto";

import {
  MediaArtifactRoleSchema,
  MediaArtifactSchema,
  MediaArtifactStageSchema,
  type MediaArtifact,
  type MediaArtifactRole,
  type MediaArtifactStage,
  type StageArtifactContentReference,
} from "@firefly/schemas";
import { Type } from "typebox";
import { Value } from "typebox/value";

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_-]+$",
});
const LowercaseSha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });

const MediaArtifactStorageSchema = Type.Object(
  {
    providerId: IdentifierSchema,
    bucketName: Type.String({
      minLength: 3,
      maxLength: 255,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$",
    }),
    objectKey: Type.String({ minLength: 1, maxLength: 1024 }),
    objectVersion: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 1024,
      pattern: "^[A-Za-z0-9+_.=/~-]+$",
    })),
  },
  { additionalProperties: false },
);

const MediaArtifactCreationMetadataSchema = Type.Object(
  {
    actorAccountId: IdentifierSchema,
    requestId: IdentifierSchema,
    payloadHash: LowercaseSha256Schema,
  },
  { additionalProperties: false },
);

const UnversionedMediaArtifactSchema = Type.Omit(MediaArtifactSchema, ["version"]);

export type UnversionedMediaArtifact<Artifact = MediaArtifact> =
  Artifact extends MediaArtifact ? Omit<Artifact, "version"> : never;

export interface MediaArtifactStorage {
  readonly providerId: string;
  readonly bucketName: string;
  readonly objectKey: string;
  readonly objectVersion?: string;
}

export interface MediaArtifactCreationMetadata {
  readonly actorAccountId: string;
  readonly requestId: string;
  readonly payloadHash: string;
}

export interface MediaArtifactCreateCandidate {
  readonly artifact: UnversionedMediaArtifact;
  readonly storage: MediaArtifactStorage;
}

export interface MediaArtifactRecord {
  readonly artifact: MediaArtifact;
  readonly storage: MediaArtifactStorage;
  readonly creation: MediaArtifactCreationMetadata;
}

export interface MediaArtifactCreateResult {
  readonly record: MediaArtifactRecord;
  readonly replayed: boolean;
}

export interface MediaArtifactListFilter {
  readonly stage?: MediaArtifactStage;
  readonly role?: MediaArtifactRole;
}

export interface MediaArtifactScope {
  readonly tenantId: string;
  readonly batchProjectId: string;
  readonly videoTaskId: string;
  readonly artifactId?: string;
}

export interface MediaArtifactObjectKeyScope {
  readonly tenantId: string;
  readonly batchProjectId: string;
  readonly videoTaskId: string;
  readonly artifactId: string;
}

export class MediaArtifactCreationConflictError extends Error {
  constructor(message = "Media artifact creation request conflicts with a different payload.") {
    super(message);
    this.name = "MediaArtifactCreationConflictError";
  }
}

export function assertMediaArtifactIdentifier(value: string, label: string): void {
  if (!Value.Check(IdentifierSchema, value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export function mediaArtifactObjectKey(
  scope: Readonly<MediaArtifactObjectKeyScope>,
): string {
  assertMediaArtifactIdentifier(scope.tenantId, "Tenant ID");
  assertMediaArtifactIdentifier(scope.batchProjectId, "Batch project ID");
  assertMediaArtifactIdentifier(scope.videoTaskId, "Video task ID");
  assertMediaArtifactIdentifier(scope.artifactId, "Media artifact ID");
  return `v1/tenants/${scope.tenantId}/projects/${scope.batchProjectId}/tasks/${scope.videoTaskId}/artifacts/${scope.artifactId}/media`;
}

function validateObjectKey(objectKey: string): void {
  const segments = objectKey.split("/");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u.test(objectKey)
    || Buffer.byteLength(objectKey, "utf8") > 1024
    || objectKey.endsWith("/")
    || segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Media artifact object key is invalid.");
  }
}

export function validateMediaArtifactStorage(
  storage: Readonly<MediaArtifactStorage>,
): void {
  if (!Value.Check(MediaArtifactStorageSchema, storage)) {
    throw new Error("Media artifact storage locator has an invalid format.");
  }
  validateObjectKey(storage.objectKey);
}

export function validateMediaArtifactCreationMetadata(
  metadata: Readonly<MediaArtifactCreationMetadata>,
): void {
  if (!Value.Check(MediaArtifactCreationMetadataSchema, metadata)) {
    throw new Error("Media artifact creation metadata has an invalid format.");
  }
}

export function validateMediaArtifactCreateCandidate(
  candidate: Readonly<MediaArtifactCreateCandidate>,
): void {
  if (
    typeof candidate !== "object"
    || candidate === null
    || !hasExactKeys(candidate, ["artifact", "storage"])
    || !Value.Check(UnversionedMediaArtifactSchema, candidate.artifact)
  ) {
    throw new Error("Media artifact candidate has an invalid format.");
  }
  validateMediaArtifactStorage(candidate.storage);
  if (candidate.storage.objectKey !== mediaArtifactObjectKey({
    tenantId: candidate.artifact.tenantId,
    batchProjectId: candidate.artifact.batchProjectId,
    videoTaskId: candidate.artifact.videoTaskId,
    artifactId: candidate.artifact.id,
  })) {
    throw new Error("Media artifact object key does not match its immutable scope.");
  }
}

export function validateMediaArtifactRecord(
  record: Readonly<MediaArtifactRecord>,
  expectedScope?: Readonly<MediaArtifactScope>,
): void {
  if (
    typeof record !== "object"
    || record === null
    || !hasExactKeys(record, ["artifact", "creation", "storage"])
    || !Value.Check(MediaArtifactSchema, record.artifact)
  ) {
    throw new Error("Media artifact record has an invalid format or scope.");
  }
  validateMediaArtifactStorage(record.storage);
  validateMediaArtifactCreationMetadata(record.creation);
  const { artifact, creation } = record;
  if (
    artifact.createdBy !== creation.actorAccountId
    || record.storage.objectKey !== mediaArtifactObjectKey({
      tenantId: artifact.tenantId,
      batchProjectId: artifact.batchProjectId,
      videoTaskId: artifact.videoTaskId,
      artifactId: artifact.id,
    })
    || (expectedScope !== undefined && (
      artifact.tenantId !== expectedScope.tenantId
      || artifact.batchProjectId !== expectedScope.batchProjectId
      || artifact.videoTaskId !== expectedScope.videoTaskId
      || (
        expectedScope.artifactId !== undefined
        && artifact.id !== expectedScope.artifactId
      )
    ))
  ) {
    throw new Error("Media artifact record has an invalid format or scope.");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Media artifact contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  throw new Error("Media artifact contains an unsupported value.");
}

/** Hashes public metadata, not the media byte checksum. */
export function mediaArtifactContentHash(artifact: Readonly<MediaArtifact>): string {
  if (!Value.Check(MediaArtifactSchema, artifact)) {
    throw new Error("Media artifact has an invalid public format.");
  }
  return createHash("sha256").update(canonicalJson(artifact), "utf8").digest("hex");
}

export function mediaArtifactContentReference(
  artifact: Readonly<MediaArtifact>,
): StageArtifactContentReference {
  return Object.freeze({
    artifactId: artifact.id,
    schemaName: "media_artifact",
    schemaVersion: artifact.schemaVersion,
    contentHashSha256: mediaArtifactContentHash(artifact),
  });
}

export function validateMediaArtifactListFilter(
  filter: Readonly<MediaArtifactListFilter>,
): void {
  if (
    (filter.stage !== undefined && !Value.Check(MediaArtifactStageSchema, filter.stage))
    || (filter.role !== undefined && !Value.Check(MediaArtifactRoleSchema, filter.role))
    || (filter.stage === "video_preview" && filter.role === "delivery")
    || (filter.stage === "delivery" && filter.role === "preview")
    || Object.keys(filter).some((key) => key !== "stage" && key !== "role")
  ) {
    throw new Error("Media artifact list filter is invalid.");
  }
}

export interface MediaArtifactStore {
  load(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
    artifactId: string,
  ): Promise<MediaArtifactRecord | undefined>;
  list(
    tenantId: string,
    batchProjectId: string,
    videoTaskId: string,
    filter?: Readonly<MediaArtifactListFilter>,
  ): Promise<MediaArtifactRecord[]>;
  createWithResult(
    candidate: Readonly<MediaArtifactCreateCandidate>,
    metadata: Readonly<MediaArtifactCreationMetadata>,
  ): Promise<MediaArtifactCreateResult>;
}
