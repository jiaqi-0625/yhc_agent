import { Buffer } from "node:buffer";

import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  MediaObjectStorageError,
  type CreateMediaReadAccessInput,
  type MediaObjectHead,
  type MediaObjectReadAccess,
  type MediaObjectStorage,
  type MediaObjectStorageErrorCode,
  type MediaObjectStorageOperation,
  type PutMediaObjectInput,
} from "./media-object-storage.ts";
import type { S3ObjectStorageConfig } from "./object-storage-config.ts";

export type S3MediaObjectStorageCommand =
  | HeadBucketCommand
  | PutObjectCommand
  | HeadObjectCommand;

export interface S3MediaObjectStorageClient {
  send(command: S3MediaObjectStorageCommand): Promise<unknown>;
  destroy(): void;
}

export type S3MediaObjectStorageSigner = (
  command: GetObjectCommand,
  expiresInSeconds: number,
  signingDate: Date,
) => Promise<string>;

export interface S3MediaObjectStorageDependencies {
  readonly client?: S3MediaObjectStorageClient;
  readonly signer?: S3MediaObjectStorageSigner;
  readonly now?: () => Date;
}

interface HeadObjectResult {
  readonly ContentLength?: unknown;
  readonly ContentType?: unknown;
  readonly ChecksumSHA256?: unknown;
  readonly VersionId?: unknown;
}

const objectKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u;
const contentTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const base64Sha256Pattern = /^[A-Za-z0-9+/]{43}=$/u;
const versionIdPattern = /^[A-Za-z0-9+_.=/~-]{1,1024}$/u;
const filenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function storageError(
  operation: MediaObjectStorageOperation,
  code: MediaObjectStorageErrorCode,
): MediaObjectStorageError {
  return new MediaObjectStorageError(operation, code);
}

function validateObjectKey(
  objectKey: string,
  operation: MediaObjectStorageOperation,
): void {
  const segments = objectKey.split("/");
  if (
    !objectKeyPattern.test(objectKey)
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw storageError(operation, "INVALID_INPUT");
  }
}

function validateVersionId(
  versionId: string | undefined,
  operation: MediaObjectStorageOperation,
): void {
  if (versionId !== undefined && !versionIdPattern.test(versionId)) {
    throw storageError(operation, "INVALID_INPUT");
  }
}

function validatePutInput(input: PutMediaObjectInput): void {
  validateObjectKey(input.objectKey, "put");
  if (!contentTypePattern.test(input.contentType)) {
    throw storageError("put", "INVALID_INPUT");
  }
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0) {
    throw storageError("put", "INVALID_INPUT");
  }
  if (!sha256Pattern.test(input.checksumSha256)) {
    throw storageError("put", "INVALID_INPUT");
  }
  if (input.body instanceof Uint8Array && input.body.byteLength !== input.contentLength) {
    throw storageError("put", "INVALID_INPUT");
  }
}

function checksumHexToBase64(checksumSha256: string): string {
  return Buffer.from(checksumSha256, "hex").toString("base64");
}

function checksumBase64ToHex(value: unknown): string | null {
  if (typeof value !== "string" || !base64Sha256Pattern.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== value) {
    return null;
  }
  return bytes.toString("hex");
}

function safeSdkStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return null;
  }
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) {
    return null;
  }
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : null;
}

function safeSdkName(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return null;
  }
  return typeof error.name === "string" ? error.name : null;
}

function sdkFailureCode(
  operation: MediaObjectStorageOperation,
  error: unknown,
): MediaObjectStorageErrorCode {
  const status = safeSdkStatus(error);
  const name = safeSdkName(error);
  if (
    operation === "head"
    && (status === 404 || name === "NotFound" || name === "NoSuchKey")
  ) {
    return "OBJECT_NOT_FOUND";
  }
  if (
    operation === "put"
    && (status === 409 || status === 412 || name === "PreconditionFailed")
  ) {
    return "OBJECT_ALREADY_EXISTS";
  }
  return "STORAGE_UNAVAILABLE";
}

function normalizeHeadResult(result: HeadObjectResult): MediaObjectHead {
  const checksumSha256 = checksumBase64ToHex(result.ChecksumSHA256);
  if (
    typeof result.ContentLength !== "number"
    || !Number.isSafeInteger(result.ContentLength)
    || result.ContentLength < 0
    || typeof result.ContentType !== "string"
    || !contentTypePattern.test(result.ContentType)
    || checksumSha256 === null
    || (result.VersionId !== undefined && (
      typeof result.VersionId !== "string" || !versionIdPattern.test(result.VersionId)
    ))
  ) {
    throw storageError("head", "INVALID_STORAGE_RESPONSE");
  }
  return Object.freeze({
    contentLength: result.ContentLength,
    contentType: result.ContentType,
    checksumSha256,
    versionId: typeof result.VersionId === "string" ? result.VersionId : null,
  });
}

function downloadDisposition(input: CreateMediaReadAccessInput): string {
  if (input.downloadFilename === undefined) {
    return "attachment";
  }
  if (!filenamePattern.test(input.downloadFilename)) {
    throw storageError("sign", "INVALID_INPUT");
  }
  return `attachment; filename="${input.downloadFilename}"`;
}

function validateSignedUrl(value: string, allowLoopbackHttp: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw storageError("sign", "INVALID_STORAGE_RESPONSE");
  }
  const normalizedHostname = parsed.hostname.toLowerCase();
  const isLoopback = normalizedHostname === "localhost"
    || normalizedHostname === "[::1]"
    || /^127(?:\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])){3}$/u
      .test(normalizedHostname);
  if (
    (parsed.protocol !== "https:" && !(allowLoopbackHttp && parsed.protocol === "http:" && isLoopback))
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.hash.length > 0
    || parsed.search.length === 0
  ) {
    throw storageError("sign", "INVALID_STORAGE_RESPONSE");
  }
}

function createSdkClient(config: S3ObjectStorageConfig): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    maxAttempts: 3,
    disableMultiregionAccessPoints: true,
    followRegionRedirects: false,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.credentials === undefined ? {} : {
      // The AWS credential feature tracker annotates the resolved object. Keep
      // the parsed immutable configuration untouched and give the SDK its own copy.
      credentials: { ...config.credentials },
    }),
  };
  return new S3Client(clientConfig);
}

export class S3MediaObjectStorage implements MediaObjectStorage {
  readonly providerId = "s3" as const;
  readonly bucketName: string;

  readonly #client: S3MediaObjectStorageClient;
  readonly #signer: S3MediaObjectStorageSigner;
  readonly #now: () => Date;
  readonly #signedGetTtlSeconds: number;
  readonly #allowLoopbackHttp: boolean;
  #closed = false;

  constructor(
    config: S3ObjectStorageConfig,
    client: S3MediaObjectStorageClient,
    signer: S3MediaObjectStorageSigner,
    now: () => Date = () => new Date(),
  ) {
    this.bucketName = config.bucket;
    this.#client = client;
    this.#signer = signer;
    this.#now = now;
    this.#signedGetTtlSeconds = config.signedGetTtlSeconds;
    this.#allowLoopbackHttp = config.endpoint?.startsWith("http://") === true;
  }

  #assertOpen(operation: MediaObjectStorageOperation): void {
    if (this.#closed) {
      throw storageError(operation, "STORAGE_CLOSED");
    }
  }

  async ping(): Promise<void> {
    this.#assertOpen("ping");
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
    } catch (error) {
      if (error instanceof MediaObjectStorageError) {
        throw error;
      }
      throw storageError("ping", "STORAGE_UNAVAILABLE");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#client.destroy();
    } catch (error) {
      throw storageError("close", "STORAGE_UNAVAILABLE");
    }
  }

  async putObject(input: PutMediaObjectInput): Promise<MediaObjectHead> {
    this.#assertOpen("put");
    validatePutInput(input);
    try {
      await this.#client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: input.objectKey,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        ChecksumSHA256: checksumHexToBase64(input.checksumSha256),
        IfNoneMatch: "*",
      }));
      const stored = await this.#fetchHead(input.objectKey, "put");
      if (
        stored.contentLength !== input.contentLength
        || stored.contentType !== input.contentType
        || stored.checksumSha256 !== input.checksumSha256
      ) {
        throw storageError("put", "INVALID_STORAGE_RESPONSE");
      }
      return stored;
    } catch (error) {
      if (error instanceof MediaObjectStorageError) {
        if (error.operation === "head") {
          throw storageError("put", error.code);
        }
        throw error;
      }
      throw storageError("put", sdkFailureCode("put", error));
    }
  }

  async headObject(objectKey: string): Promise<MediaObjectHead> {
    this.#assertOpen("head");
    validateObjectKey(objectKey, "head");
    return this.#fetchHead(objectKey, "head");
  }

  async #fetchHead(
    objectKey: string,
    operation: "put" | "head",
  ): Promise<MediaObjectHead> {
    try {
      const result = await this.#client.send(new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        ChecksumMode: "ENABLED",
      })) as HeadObjectResult;
      try {
        return normalizeHeadResult(result);
      } catch (error) {
        if (error instanceof MediaObjectStorageError) {
          throw storageError(operation, error.code);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof MediaObjectStorageError) {
        throw error;
      }
      throw storageError(operation, sdkFailureCode(operation, error));
    }
  }

  async createReadAccess(
    input: CreateMediaReadAccessInput,
  ): Promise<MediaObjectReadAccess> {
    this.#assertOpen("sign");
    validateObjectKey(input.objectKey, "sign");
    validateVersionId(input.versionId, "sign");
    if (input.purpose !== "playback" && input.purpose !== "download") {
      throw storageError("sign", "INVALID_INPUT");
    }
    if (input.purpose === "playback" && input.downloadFilename !== undefined) {
      throw storageError("sign", "INVALID_INPUT");
    }

    const responseContentDisposition = input.purpose === "playback"
      ? "inline"
      : downloadDisposition(input);
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: input.objectKey,
      ResponseContentDisposition: responseContentDisposition,
      ...(input.versionId === undefined ? {} : { VersionId: input.versionId }),
    });

    try {
      const now = this.#now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw storageError("sign", "INVALID_STORAGE_RESPONSE");
      }
      const url = await this.#signer(command, this.#signedGetTtlSeconds, now);
      validateSignedUrl(url, this.#allowLoopbackHttp);
      return Object.freeze({
        url,
        method: "GET",
        expiresAt: new Date(now.getTime() + this.#signedGetTtlSeconds * 1_000),
      });
    } catch (error) {
      if (error instanceof MediaObjectStorageError) {
        throw error;
      }
      throw storageError("sign", "STORAGE_UNAVAILABLE");
    }
  }
}

export function createS3MediaObjectStorage(
  config: S3ObjectStorageConfig,
  dependencies: S3MediaObjectStorageDependencies = {},
): S3MediaObjectStorage {
  const sdkClient = dependencies.client === undefined ? createSdkClient(config) : undefined;
  const client = dependencies.client
    ?? (sdkClient as S3Client as unknown as S3MediaObjectStorageClient);
  const signer = dependencies.signer ?? (async (command, expiresInSeconds, signingDate) =>
    getSignedUrl(client as unknown as S3Client, command, {
      expiresIn: expiresInSeconds,
      signingDate,
    }));
  return new S3MediaObjectStorage(config, client, signer, dependencies.now);
}
