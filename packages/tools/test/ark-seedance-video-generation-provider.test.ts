import assert from "node:assert/strict";
import test from "node:test";

import {
  ArkSeedanceVideoGenerationProvider,
  SEEDANCE_2_5_MODEL,
  createArkSeedanceVideoGenerationProviderFromEnv,
  type ProductionProviderScope,
  type VideoGenerationRequest,
} from "../src/index.ts";

const scope: ProductionProviderScope = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_owner",
  batchProjectId: "project_launch",
  videoTaskId: "video_task_1",
  taskRevision: 7,
};

const request: VideoGenerationRequest = {
  idempotencyKey: "video_task_1_revision_7",
  model: SEEDANCE_2_5_MODEL,
  assetSnapshotId: "asset_snapshot_1",
  storyboardArtifactVersionId: "storyboard_v3",
  prompt: "写实汽车广告首镜头。",
  generateAudio: true,
  aspectRatio: "16:9",
  durationSeconds: 5,
  watermark: false,
};

test("Ark adapter maps the stable product model to the configured Seedance endpoint", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const provider = new ArkSeedanceVideoGenerationProvider({
    apiKey: "test-key-not-real",
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "task_123", status: "queued" }), { status: 200 });
    },
  });
  const job = await provider.createGeneration(request, scope);
  assert.equal(capturedUrl, "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
  assert.equal(new Headers(capturedInit?.headers).get("Authorization"), "Bearer test-key-not-real");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: "doubao-seedance-2-5-260628",
    content: [{ type: "text", text: request.prompt }],
    generate_audio: true,
    ratio: "16:9",
    duration: 5,
    watermark: false,
  });
  assert.equal(job.providerJobId, "task_123");
  assert.equal(job.status, "queued");
});

test("Ark adapter rejects an unsupported duration before making a paid request", async () => {
  let fetchCalls = 0;
  const provider = new ArkSeedanceVideoGenerationProvider({
    apiKey: "test-key-not-real",
    fetch: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    provider.createGeneration({ ...request, durationSeconds: 2 }, scope),
    /duration must be an integer from 4 to 30 seconds/u,
  );
  assert.equal(fetchCalls, 0);
});

test("Ark adapter imports a completed provider result without exposing its URL", async () => {
  let importedUrl = "";
  const provider = new ArkSeedanceVideoGenerationProvider({
    apiKey: "test-key-not-real",
    fetch: async () => new Response(JSON.stringify({
      id: "task_123",
      status: "succeeded",
      content: { video_url: "https://temporary.example/result.mp4" },
    }), { status: 200 }),
    artifactImporter: {
      async importVideo(input) {
        importedUrl = input.sourceUrl;
        return {
          artifactId: "artifact_123",
          storageKey: "generated/result.mp4",
          mediaType: "video/mp4",
          width: 1920,
          height: 1080,
          durationSeconds: 5,
          checksumSha256: "a".repeat(64),
        };
      },
    },
  });
  const job = await provider.getGeneration("task_123", scope);
  assert.equal(importedUrl, "https://temporary.example/result.mp4");
  assert.equal(job.output?.artifactId, "artifact_123");
  assert.equal("sourceUrl" in job, false);
});

test("environment factory requires an Ark credential", () => {
  assert.throws(() => createArkSeedanceVideoGenerationProviderFromEnv({}), /ARK_API_KEY/u);
});
