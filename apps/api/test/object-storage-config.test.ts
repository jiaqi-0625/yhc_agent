import assert from "node:assert/strict";
import test from "node:test";

import {
  ObjectStorageConfigError,
  parseObjectStorageConfig,
} from "../src/object-storage-config.ts";

const s3Environment = Object.freeze({
  OBJECT_STORAGE_BACKEND: "s3",
  OBJECT_STORAGE_S3_REGION: "cn-north-1",
  OBJECT_STORAGE_S3_BUCKET: "firefly-private-media",
});

test("object storage is disabled by default without requiring S3 settings", () => {
  const config = parseObjectStorageConfig({});

  assert.deepEqual(config, { backend: "disabled" });
  assert.ok(Object.isFrozen(config));
});

test("S3 configuration supports workload identity defaults and bounded signing TTL", () => {
  const config = parseObjectStorageConfig({
    ...s3Environment,
    OBJECT_STORAGE_S3_ENDPOINT: "https://objects.example.test/",
    OBJECT_STORAGE_S3_FORCE_PATH_STYLE: "true",
    OBJECT_STORAGE_SIGNED_GET_TTL_SECONDS: "600",
    NODE_ENV: "production",
  });

  assert.deepEqual(config, {
    backend: "s3",
    region: "cn-north-1",
    bucket: "firefly-private-media",
    endpoint: "https://objects.example.test",
    forcePathStyle: true,
    signedGetTtlSeconds: 600,
  });
  assert.ok(Object.isFrozen(config));
  assert.equal("credentials" in config, false);
});

test("S3 configuration accepts only a complete optional static credential set", () => {
  const config = parseObjectStorageConfig({
    ...s3Environment,
    OBJECT_STORAGE_S3_ACCESS_KEY_ID: "test-access-key",
    OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "test-secret-key",
    OBJECT_STORAGE_S3_SESSION_TOKEN: "test-session-token",
  });

  assert.equal(config.backend, "s3");
  assert.deepEqual(config.credentials, {
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    sessionToken: "test-session-token",
  });
  assert.ok(Object.isFrozen(config.credentials));
});

test("S3 configuration rejects incomplete credentials without echoing credential values", () => {
  const secret = "do-not-echo-static-secret";
  const token = "do-not-echo-session-token";
  for (const environment of [
    { ...s3Environment, OBJECT_STORAGE_S3_ACCESS_KEY_ID: "access-only" },
    { ...s3Environment, OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: secret },
    { ...s3Environment, OBJECT_STORAGE_S3_SESSION_TOKEN: token },
    {
      ...s3Environment,
      OBJECT_STORAGE_S3_ACCESS_KEY_ID: "access",
      OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: ` ${secret}`,
    },
  ]) {
    assert.throws(
      () => parseObjectStorageConfig(environment),
      (error: unknown) => {
        assert.ok(error instanceof ObjectStorageConfigError);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(token), false);
        assert.equal(error.message.includes("access-only"), false);
        return true;
      },
    );
  }
});

test("S3 endpoint policy requires production HTTPS and limits development HTTP to loopback", () => {
  for (const endpoint of [
    "http://objects.example.test",
    "ftp://objects.example.test",
    "https://user:password@objects.example.test",
    "https://objects.example.test/private",
    "https://objects.example.test?secret=query",
    "https://objects.example.test#fragment",
  ]) {
    assert.throws(
      () => parseObjectStorageConfig({
        ...s3Environment,
        OBJECT_STORAGE_S3_ENDPOINT: endpoint,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ObjectStorageConfigError);
        assert.equal(error.message.includes(endpoint), false);
        assert.equal(error.message.includes("password"), false);
        assert.equal(error.message.includes("secret=query"), false);
        return true;
      },
    );
  }

  assert.throws(
    () => parseObjectStorageConfig({
      ...s3Environment,
      OBJECT_STORAGE_S3_ENDPOINT: "http://127.0.0.1:9000",
      NODE_ENV: "production",
    }),
    /must use HTTPS/u,
  );
  for (const endpoint of ["http://localhost:9000", "http://127.0.0.2:9000", "http://[::1]:9000"] ) {
    const config = parseObjectStorageConfig({
      ...s3Environment,
      OBJECT_STORAGE_S3_ENDPOINT: endpoint,
      NODE_ENV: "development",
    });
    assert.equal(config.backend, "s3");
    assert.equal(config.endpoint, endpoint);
  }
});

test("S3 configuration enforces required identifiers, strict booleans, and 60-900 second TTL", () => {
  for (const environment of [
    { OBJECT_STORAGE_BACKEND: "filesystem" },
    { OBJECT_STORAGE_BACKEND: "s3", OBJECT_STORAGE_S3_BUCKET: "valid-bucket" },
    { OBJECT_STORAGE_BACKEND: "s3", OBJECT_STORAGE_S3_REGION: "valid-region" },
    { ...s3Environment, OBJECT_STORAGE_S3_REGION: " region" },
    { ...s3Environment, OBJECT_STORAGE_S3_BUCKET: "Invalid_Bucket" },
    { ...s3Environment, OBJECT_STORAGE_S3_BUCKET: "127.0.0.1" },
    { ...s3Environment, OBJECT_STORAGE_S3_FORCE_PATH_STYLE: "TRUE" },
    { ...s3Environment, OBJECT_STORAGE_SIGNED_GET_TTL_SECONDS: "59" },
    { ...s3Environment, OBJECT_STORAGE_SIGNED_GET_TTL_SECONDS: "901" },
    { ...s3Environment, OBJECT_STORAGE_SIGNED_GET_TTL_SECONDS: "60.0" },
  ]) {
    assert.throws(() => parseObjectStorageConfig(environment), ObjectStorageConfigError);
  }

  for (const ttl of ["60", "900"]) {
    const config = parseObjectStorageConfig({
      ...s3Environment,
      OBJECT_STORAGE_SIGNED_GET_TTL_SECONDS: ttl,
    });
    assert.equal(config.backend, "s3");
    assert.equal(config.signedGetTtlSeconds, Number(ttl));
  }
});
