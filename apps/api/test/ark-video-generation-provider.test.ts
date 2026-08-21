import assert from "node:assert/strict";
import test from "node:test";

import { ArkVideoGenerationError, ArkVideoGenerationProvider } from "../src/ark-video-generation-provider.ts";
import type { ArkVideoGenerationConfig } from "../src/video-generation-config.ts";

const config: ArkVideoGenerationConfig = {
  backend: "volcengine_ark",
  apiKey: "provider-test-secret",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  modelId: "seedance-endpoint-test",
  resolution: "720p",
  watermark: false,
  pollIntervalMs: 1_000,
  timeoutMs: 60_000,
  estimatedCostMinor: 1_000,
};

const scope = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_owner",
  batchProjectId: "project_c10",
  videoTaskId: "task_c10",
  taskRevision: 8,
};

const request = {
  idempotencyKey: "video_task_c10_revision_8",
  model: config.modelId,
  assetSnapshotId: "snapshot_1",
  storyboardArtifactVersionId: "storyboard_v1",
  prompt: "A vertical automotive information-feed video.",
  aspectRatio: "9:16",
  durationSeconds: 5,
};

test("Ark adapter submits only production input and maps an async job", async () => {
  let captured: { url: string; init: RequestInit | undefined } | undefined;
  const provider = new ArkVideoGenerationProvider(config, async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ id: "job_1", status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const job = await provider.createGeneration(request, scope);
  assert.equal(job.providerJobId, "job_1");
  assert.equal(job.status, "queued");
  assert.equal(captured?.url, `${config.baseUrl}/contents/generations/tasks`);
  assert.equal(new Headers(captured?.init?.headers).get("authorization"), "Bearer provider-test-secret");
  const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, config.modelId);
  assert.equal("tenantId" in body, false);
  assert.equal("actorAccountId" in body, false);
});

test("Ark adapter maps successful output internally without logging provider payloads", async () => {
  const provider = new ArkVideoGenerationProvider(config, async () => new Response(JSON.stringify({
    id: "job_1",
    status: "succeeded",
    content: { video_url: "https://provider.example/video.mp4?token=private", width: 720, height: 1280, duration: 5 },
    usage: { total_tokens: 1234 },
  }), { status: 200 }));
  const job = await provider.getGeneration("job_1", scope);
  assert.equal(job.status, "succeeded");
  assert.equal(job.output?.downloadUrl, "https://provider.example/video.mp4?token=private");
  assert.equal(job.output?.usageTokens, 1234);
});

test("Ark adapter sanitizes HTTP failures", async () => {
  const provider = new ArkVideoGenerationProvider(config, async () => new Response(
    JSON.stringify({ error: { message: "secret provider detail" } }),
    { status: 429 },
  ));
  await assert.rejects(
    provider.createGeneration(request, scope),
    (error: unknown) => error instanceof ArkVideoGenerationError
      && error.code === "AIC-VIDEO-PROVIDER_RATE_LIMIT"
      && error.retryable
      && !error.message.includes("secret"),
  );
});
