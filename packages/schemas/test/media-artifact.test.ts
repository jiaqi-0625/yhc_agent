import assert from "node:assert/strict";
import test from "node:test";

import { Value } from "typebox/value";

import {
  CreateMediaArtifactAccessRequestSchema,
  MediaArtifactAccessResponseSchema,
  MediaArtifactSchema,
  type CreateMediaArtifactAccessRequest,
  type MediaArtifact,
  type MediaArtifactAccessResponse,
} from "../src/index.ts";

const previewArtifact = {
  schemaVersion: 1,
  id: "media_preview_1",
  tenantId: "tenant_firefly",
  batchProjectId: "project_launch",
  videoTaskId: "task_launch",
  stage: "video_preview",
  role: "preview",
  version: 1,
  mediaType: "video/mp4",
  byteSize: 12_345_678,
  checksumSha256: "a".repeat(64),
  width: 1920,
  height: 1080,
  durationMs: 30_000,
  createdAt: "2026-08-20T09:00:00.000Z",
  createdBy: "account_creator",
} satisfies MediaArtifact;

const deliveryArtifact = {
  ...previewArtifact,
  id: "media_delivery_1",
  stage: "delivery",
  role: "delivery",
} satisfies MediaArtifact;

test("media artifact v1 strictly exposes immutable public metadata", () => {
  assert.equal(Value.Check(MediaArtifactSchema, previewArtifact), true);
  assert.equal(Value.Check(MediaArtifactSchema, deliveryArtifact), true);

  for (const internalField of [
    "providerId",
    "bucketName",
    "objectKey",
    "objectVersion",
    "url",
    "contentHashSha256",
    "status",
  ]) {
    assert.equal(
      Value.Check(MediaArtifactSchema, { ...previewArtifact, [internalField]: "private" }),
      false,
      `${internalField} must not be public`,
    );
  }
});

test("media artifact stage and role are correlated and metadata is bounded", () => {
  assert.equal(
    Value.Check(MediaArtifactSchema, { ...previewArtifact, role: "delivery" }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactSchema, { ...deliveryArtifact, role: "preview" }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactSchema, { ...previewArtifact, version: 0 }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactSchema, { ...previewArtifact, byteSize: 0 }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactSchema, { ...previewArtifact, checksumSha256: "A".repeat(64) }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactSchema, { ...previewArtifact, mediaType: "https://media.invalid" }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactSchema, { ...previewArtifact, mediaType: "Video/MP4" }),
    false,
  );
});

test("media access request accepts only playback or download purpose", () => {
  const request = { purpose: "playback" } satisfies CreateMediaArtifactAccessRequest;
  assert.equal(Value.Check(CreateMediaArtifactAccessRequestSchema, request), true);
  assert.equal(
    Value.Check(CreateMediaArtifactAccessRequestSchema, { purpose: "download" }),
    true,
  );
  assert.equal(
    Value.Check(CreateMediaArtifactAccessRequestSchema, { ...request, artifactId: previewArtifact.id }),
    false,
  );
  assert.equal(
    Value.Check(CreateMediaArtifactAccessRequestSchema, { purpose: "stream" }),
    false,
  );
});

test("media access response keeps public metadata separate from a short-lived GET credential", () => {
  const response = {
    artifact: previewArtifact,
    access: {
      method: "GET",
      url: "https://media.example.test/private/preview.mp4?signature=opaque",
      expiresAt: "2026-08-20T09:10:00.000Z",
    },
  } satisfies MediaArtifactAccessResponse;

  assert.equal(Value.Check(MediaArtifactAccessResponseSchema, response), true);
  assert.equal(
    Value.Check(MediaArtifactAccessResponseSchema, {
      ...response,
      access: { ...response.access, method: "POST" },
    }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactAccessResponseSchema, {
      ...response,
      access: { ...response.access, providerId: "s3_primary" },
    }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactAccessResponseSchema, {
      artifact: { ...previewArtifact, objectKey: "private/preview.mp4" },
      access: response.access,
    }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactAccessResponseSchema, {
      ...response,
      access: { ...response.access, url: "not-a-uri" },
    }),
    false,
  );
  assert.equal(
    Value.Check(MediaArtifactAccessResponseSchema, {
      ...response,
      access: { ...response.access, url: "ftp://media.example.test/private/preview.mp4" },
    }),
    false,
  );
});
