import assert from "node:assert/strict";
import test from "node:test";

import { parseVideoGenerationConfig, VideoGenerationConfigError } from "../src/video-generation-config.ts";

test("real video generation is disabled by default", () => {
  assert.deepEqual(parseVideoGenerationConfig({}), { backend: "disabled" });
});

test("Ark video configuration requires a key and runtime model ID", () => {
  assert.throws(
    () => parseVideoGenerationConfig({ VIDEO_GENERATION_BACKEND: "volcengine_ark" }),
    VideoGenerationConfigError,
  );
  const config = parseVideoGenerationConfig({
    VIDEO_GENERATION_BACKEND: "volcengine_ark",
    ARK_VIDEO_API_KEY: "secret-for-test-only",
    ARK_VIDEO_MODEL_ID: "seedance-endpoint-test",
  });
  assert.equal(config.backend, "volcengine_ark");
  assert.equal(config.modelId, "seedance-endpoint-test");
  assert.equal(config.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
});

test("Ark video configuration rejects unapproved hosts and invalid paid-call bounds", () => {
  const base = {
    VIDEO_GENERATION_BACKEND: "volcengine_ark",
    ARK_VIDEO_API_KEY: "secret-for-test-only",
    ARK_VIDEO_MODEL_ID: "seedance-endpoint-test",
  };
  assert.throws(
    () => parseVideoGenerationConfig({ ...base, ARK_VIDEO_BASE_URL: "https://evil.invalid/api/v3" }),
    VideoGenerationConfigError,
  );
  assert.throws(
    () => parseVideoGenerationConfig({ ...base, ARK_VIDEO_TIMEOUT_MS: "10" }),
    VideoGenerationConfigError,
  );
});
