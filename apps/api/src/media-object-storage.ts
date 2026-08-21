import type { Readable } from "node:stream";

export type MediaObjectStorageOperation = "ping" | "put" | "head" | "sign" | "close";

export type MediaObjectStorageErrorCode =
  | "OBJECT_NOT_FOUND"
  | "OBJECT_ALREADY_EXISTS"
  | "INVALID_INPUT"
  | "STORAGE_CLOSED"
  | "STORAGE_UNAVAILABLE"
  | "INVALID_STORAGE_RESPONSE";

export type MediaReadPurpose = "playback" | "download";

export interface PutMediaObjectInput {
  readonly objectKey: string;
  readonly body: Readable | Uint8Array;
  readonly contentType: string;
  readonly contentLength: number;
  readonly checksumSha256: string;
}

export interface MediaObjectHead {
  readonly contentLength: number;
  readonly contentType: string;
  readonly checksumSha256: string;
  readonly versionId: string | null;
}

export interface CreateMediaReadAccessInput {
  readonly objectKey: string;
  readonly purpose: MediaReadPurpose;
  readonly versionId?: string;
  readonly downloadFilename?: string;
}

export interface MediaObjectReadAccess {
  readonly url: string;
  readonly method: "GET";
  readonly expiresAt: Date;
}

export interface MediaObjectStorage {
  readonly providerId: "s3";
  readonly bucketName: string;

  ping(): Promise<void>;
  close(): Promise<void>;
  putObject(input: PutMediaObjectInput): Promise<MediaObjectHead>;
  headObject(objectKey: string): Promise<MediaObjectHead>;
  createReadAccess(input: CreateMediaReadAccessInput): Promise<MediaObjectReadAccess>;
}

const safeMessages: Readonly<Record<MediaObjectStorageOperation, string>> = Object.freeze({
  ping: "Media object storage health check failed.",
  put: "Media object upload failed.",
  head: "Media object metadata lookup failed.",
  sign: "Media object read access could not be created.",
  close: "Media object storage shutdown failed.",
});

export class MediaObjectStorageError extends Error {
  readonly operation: MediaObjectStorageOperation;
  readonly code: MediaObjectStorageErrorCode;

  constructor(
    operation: MediaObjectStorageOperation,
    code: MediaObjectStorageErrorCode,
    _options?: Readonly<{ cause?: unknown }>,
  ) {
    // Provider errors can contain endpoints, object keys, signed query strings,
    // or credential fragments. Deliberately do not retain a raw `cause` here.
    super(safeMessages[operation]);
    this.name = "MediaObjectStorageError";
    this.operation = operation;
    this.code = code;
  }
}
