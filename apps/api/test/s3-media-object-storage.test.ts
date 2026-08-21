import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { Readable } from "node:stream";
import test from "node:test";

import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import { MediaObjectStorageError } from "../src/media-object-storage.ts";
import type { S3ObjectStorageConfig } from "../src/object-storage-config.ts";
import {
  createS3MediaObjectStorage,
  type S3MediaObjectStorageClient,
  type S3MediaObjectStorageCommand,
} from "../src/s3-media-object-storage.ts";

const bucket = "firefly-private-media";
const objectKey = "tenants/tenant-1/tasks/task-1/delivery/video.mp4";
const content = new Uint8Array([1, 2, 3, 4]);
const checksumSha256 = createHash("sha256").update(content).digest("hex");
const checksumBase64 = Buffer.from(checksumSha256, "hex").toString("base64");
const config: S3ObjectStorageConfig = Object.freeze({
  backend: "s3",
  region: "cn-north-1",
  bucket,
  forcePathStyle: false,
  signedGetTtlSeconds: 120,
});

class FakeS3Client implements S3MediaObjectStorageClient {
  readonly calls: S3MediaObjectStorageCommand[] = [];
  readonly failures = new Map<Function, unknown>();
  headResult: unknown = {
    ContentLength: content.byteLength,
    ContentType: "video/mp4",
    ChecksumSHA256: checksumBase64,
    VersionId: "version-1",
  };
  destroyCount = 0;
  destroyFailure: unknown;

  async send(command: S3MediaObjectStorageCommand): Promise<unknown> {
    this.calls.push(command);
    const failure = this.failures.get(command.constructor);
    if (failure !== undefined) {
      throw failure;
    }
    return command instanceof HeadObjectCommand ? this.headResult : {};
  }

  destroy(): void {
    this.destroyCount += 1;
    if (this.destroyFailure !== undefined) {
      throw this.destroyFailure;
    }
  }
}

function assertSafeStorageError(
  error: unknown,
  operation: MediaObjectStorageError["operation"],
  code: MediaObjectStorageError["code"],
): error is MediaObjectStorageError {
  assert.ok(error instanceof MediaObjectStorageError);
  assert.equal(error.operation, operation);
  assert.equal(error.code, code);
  const inspected = inspect(error, { depth: 5, showHidden: true });
  for (const sensitive of [bucket, objectKey, "super-secret", "https://signed.example.test"]) {
    assert.equal(error.message.includes(sensitive), false);
    assert.equal(inspected.includes(sensitive), false);
  }
  return true;
}

test("S3 adapter exposes a fixed provider and bucket, pings the private bucket, and closes once", async () => {
  const client = new FakeS3Client();
  const storage = createS3MediaObjectStorage(config, {
    client,
    signer: async () => "https://signed.example.test/video?signature=test",
  });

  assert.equal(storage.providerId, "s3");
  assert.equal(storage.bucketName, bucket);
  await storage.ping();
  assert.ok(client.calls[0] instanceof HeadBucketCommand);
  assert.deepEqual((client.calls[0] as HeadBucketCommand).input, { Bucket: bucket });

  await storage.close();
  await storage.close();
  assert.equal(client.destroyCount, 1);
  await assert.rejects(
    storage.headObject(objectKey),
    (error: unknown) => assertSafeStorageError(error, "head", "STORAGE_CLOSED"),
  );
});

test("putObject sends an immutable checksum-bound upload without ACL and verifies authoritative HEAD", async () => {
  const client = new FakeS3Client();
  const storage = createS3MediaObjectStorage(config, {
    client,
    signer: async () => "https://signed.example.test/video?signature=test",
  });

  const stored = await storage.putObject({
    objectKey,
    body: content,
    contentType: "video/mp4",
    contentLength: content.byteLength,
    checksumSha256,
  });

  assert.deepEqual(stored, {
    contentLength: 4,
    contentType: "video/mp4",
    checksumSha256,
    versionId: "version-1",
  });
  assert.ok(Object.isFrozen(stored));
  assert.equal(client.calls.length, 2);
  const put = client.calls[0];
  assert.ok(put instanceof PutObjectCommand);
  assert.equal(put.input.Bucket, bucket);
  assert.equal(put.input.Key, objectKey);
  assert.equal(put.input.Body, content);
  assert.equal(put.input.ContentType, "video/mp4");
  assert.equal(put.input.ContentLength, 4);
  assert.equal(put.input.ChecksumSHA256, checksumBase64);
  assert.equal(put.input.IfNoneMatch, "*");
  assert.equal("ACL" in put.input, false);
  const head = client.calls[1];
  assert.ok(head instanceof HeadObjectCommand);
  assert.equal(head.input.ChecksumMode, "ENABLED");
});

test("putObject accepts a Readable and rejects a HEAD result that does not match upload metadata", async () => {
  const client = new FakeS3Client();
  client.headResult = {
    ContentLength: 5,
    ContentType: "video/mp4",
    ChecksumSHA256: checksumBase64,
  };
  const storage = createS3MediaObjectStorage(config, {
    client,
    signer: async () => "https://signed.example.test/video?signature=test",
  });

  await assert.rejects(
    storage.putObject({
      objectKey,
      body: Readable.from(content),
      contentType: "video/mp4",
      contentLength: content.byteLength,
      checksumSha256,
    }),
    (error: unknown) => assertSafeStorageError(error, "put", "INVALID_STORAGE_RESPONSE"),
  );
});

test("headObject returns authoritative size, type, checksum, and optional version", async () => {
  const client = new FakeS3Client();
  client.headResult = {
    ContentLength: 123,
    ContentType: "video/webm",
    ChecksumSHA256: Buffer.alloc(32, 7).toString("base64"),
  };
  const storage = createS3MediaObjectStorage(config, {
    client,
    signer: async () => "https://signed.example.test/video?signature=test",
  });

  const head = await storage.headObject(objectKey);
  assert.deepEqual(head, {
    contentLength: 123,
    contentType: "video/webm",
    checksumSha256: Buffer.alloc(32, 7).toString("hex"),
    versionId: null,
  });
  assert.deepEqual((client.calls[0] as HeadObjectCommand).input, {
    Bucket: bucket,
    Key: objectKey,
    ChecksumMode: "ENABLED",
  });
});

test("createReadAccess signs GET playback and download URLs with the configured TTL and disposition", async () => {
  const client = new FakeS3Client();
  const signedCommands: Array<{ command: GetObjectCommand; ttl: number }> = [];
  const now = new Date("2026-08-20T06:00:00.000Z");
  const storage = createS3MediaObjectStorage(config, {
    client,
    now: () => now,
    signer: async (command, ttl) => {
      signedCommands.push({ command, ttl });
      return `https://signed.example.test/video?signature=${signedCommands.length}`;
    },
  });

  const playback = await storage.createReadAccess({
    objectKey,
    purpose: "playback",
    versionId: "version-1",
  });
  const download = await storage.createReadAccess({
    objectKey,
    purpose: "download",
    versionId: "version-1",
    downloadFilename: "firefly-delivery.mp4",
  });

  assert.deepEqual(playback, {
    url: "https://signed.example.test/video?signature=1",
    method: "GET",
    expiresAt: new Date("2026-08-20T06:02:00.000Z"),
  });
  assert.deepEqual(download, {
    url: "https://signed.example.test/video?signature=2",
    method: "GET",
    expiresAt: new Date("2026-08-20T06:02:00.000Z"),
  });
  assert.equal(signedCommands[0]?.ttl, 120);
  assert.equal(signedCommands[0]?.command.input.ResponseContentDisposition, "inline");
  assert.equal(signedCommands[0]?.command.input.VersionId, "version-1");
  assert.equal(
    signedCommands[1]?.command.input.ResponseContentDisposition,
    "attachment; filename=\"firefly-delivery.mp4\"",
  );
  assert.equal(signedCommands[1]?.command.input.VersionId, "version-1");
  assert.equal(client.calls.length, 0);
});

test("default AWS presigner emits a fixed-date SigV4 GET URL without exposing the secret", async () => {
  const signingDate = new Date("2026-08-20T06:00:00.000Z");
  const accessKeyId = "TESTACCESSKEY123456";
  const secretAccessKey = "do-not-appear-in-the-signed-url";
  const storage = createS3MediaObjectStorage(Object.freeze({
    ...config,
    endpoint: "https://objects.example.test",
    forcePathStyle: true,
    credentials: Object.freeze({ accessKeyId, secretAccessKey }),
  }), {
    now: () => signingDate,
  });

  try {
    const access = await storage.createReadAccess({
      objectKey,
      purpose: "download",
      versionId: "version-1",
      downloadFilename: "firefly-delivery.mp4",
    });
    const signedUrl = new URL(access.url);

    assert.equal(access.method, "GET");
    assert.equal(access.expiresAt.toISOString(), "2026-08-20T06:02:00.000Z");
    assert.equal(signedUrl.protocol, "https:");
    assert.equal(signedUrl.host, "objects.example.test");
    assert.equal(signedUrl.pathname, `/${bucket}/${objectKey}`);
    assert.equal(signedUrl.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.match(signedUrl.searchParams.get("X-Amz-Credential") ?? "", new RegExp(`^${accessKeyId}/`));
    assert.equal(signedUrl.searchParams.get("X-Amz-Date"), "20260820T060000Z");
    assert.equal(signedUrl.searchParams.get("X-Amz-Expires"), "120");
    assert.equal(signedUrl.searchParams.get("X-Amz-SignedHeaders"), "host");
    assert.match(signedUrl.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(signedUrl.searchParams.get("versionId"), "version-1");
    assert.equal(
      signedUrl.searchParams.get("response-content-disposition"),
      "attachment; filename=\"firefly-delivery.mp4\"",
    );
    assert.equal(access.url.includes(secretAccessKey), false);
  } finally {
    await storage.close();
  }
});

test("S3 adapter rejects unsafe keys and header inputs before calling the SDK", async () => {
  const unsafeKeys = [
    "",
    "/absolute/video.mp4",
    "../video.mp4",
    "safe/../video.mp4",
    "safe//video.mp4",
    "safe\\video.mp4",
    "safe/video.mp4?token=secret",
    "safe/video name.mp4",
    "安全/video.mp4",
    `a${"b".repeat(1024)}`,
  ];
  for (const unsafeKey of unsafeKeys) {
    const client = new FakeS3Client();
    const storage = createS3MediaObjectStorage(config, {
      client,
      signer: async () => "https://signed.example.test/video?signature=test",
    });
    await assert.rejects(
      storage.headObject(unsafeKey),
      (error: unknown) => assertSafeStorageError(error, "head", "INVALID_INPUT"),
    );
    assert.equal(client.calls.length, 0);
  }

  for (const invalidInput of [
    { contentType: "video/mp4\r\nx-secret: value", contentLength: 4, checksumSha256 },
    { contentType: "video/mp4", contentLength: -1, checksumSha256 },
    { contentType: "video/mp4", contentLength: 5, checksumSha256 },
    { contentType: "video/mp4", contentLength: 4, checksumSha256: "not-a-checksum" },
  ]) {
    const client = new FakeS3Client();
    const storage = createS3MediaObjectStorage(config, {
      client,
      signer: async () => "https://signed.example.test/video?signature=test",
    });
    await assert.rejects(
      storage.putObject({ objectKey, body: content, ...invalidInput }),
      (error: unknown) => assertSafeStorageError(error, "put", "INVALID_INPUT"),
    );
    assert.equal(client.calls.length, 0);
  }
});

test("SDK and signer failures are wrapped with stable safe error codes", async () => {
  const driverDetail = new Error(
    `super-secret ${bucket} ${objectKey} https://signed.example.test/private`,
  );
  Object.assign(driverDetail, { $metadata: { httpStatusCode: 404 } });
  const headClient = new FakeS3Client();
  headClient.failures.set(HeadObjectCommand, driverDetail);
  const headStorage = createS3MediaObjectStorage(config, {
    client: headClient,
    signer: async () => "https://signed.example.test/video?signature=test",
  });
  await assert.rejects(
    headStorage.headObject(objectKey),
    (error: unknown) => assertSafeStorageError(error, "head", "OBJECT_NOT_FOUND"),
  );

  const putClient = new FakeS3Client();
  const preconditionFailure = Object.assign(new Error("super-secret"), {
    $metadata: { httpStatusCode: 412 },
  });
  putClient.failures.set(PutObjectCommand, preconditionFailure);
  const putStorage = createS3MediaObjectStorage(config, {
    client: putClient,
    signer: async () => "https://signed.example.test/video?signature=test",
  });
  await assert.rejects(
    putStorage.putObject({
      objectKey,
      body: content,
      contentType: "video/mp4",
      contentLength: content.byteLength,
      checksumSha256,
    }),
    (error: unknown) => assertSafeStorageError(error, "put", "OBJECT_ALREADY_EXISTS"),
  );

  const signStorage = createS3MediaObjectStorage(config, {
    client: new FakeS3Client(),
    signer: async () => { throw driverDetail; },
  });
  await assert.rejects(
    signStorage.createReadAccess({ objectKey, purpose: "playback" }),
    (error: unknown) => assertSafeStorageError(error, "sign", "STORAGE_UNAVAILABLE"),
  );
});

test("invalid HEAD and signed URL responses fail closed without leaking provider values", async () => {
  const client = new FakeS3Client();
  client.headResult = {
    ContentLength: 4,
    ContentType: "video/mp4",
    ChecksumSHA256: "invalid-checksum super-secret",
  };
  const storage = createS3MediaObjectStorage(config, {
    client,
    signer: async () => `http://external.example.test/${objectKey}?signature=super-secret`,
  });

  await assert.rejects(
    storage.headObject(objectKey),
    (error: unknown) => assertSafeStorageError(error, "head", "INVALID_STORAGE_RESPONSE"),
  );
  await assert.rejects(
    storage.createReadAccess({ objectKey, purpose: "playback" }),
    (error: unknown) => assertSafeStorageError(error, "sign", "INVALID_STORAGE_RESPONSE"),
  );
});

test("close failures are wrapped safely and do not allow reuse", async () => {
  const client = new FakeS3Client();
  client.destroyFailure = new Error(`super-secret ${bucket}`);
  const storage = createS3MediaObjectStorage(config, {
    client,
    signer: async () => "https://signed.example.test/video?signature=test",
  });

  await assert.rejects(
    storage.close(),
    (error: unknown) => assertSafeStorageError(error, "close", "STORAGE_UNAVAILABLE"),
  );
  await assert.rejects(
    storage.ping(),
    (error: unknown) => assertSafeStorageError(error, "ping", "STORAGE_CLOSED"),
  );
  assert.equal(client.destroyCount, 1);
});
