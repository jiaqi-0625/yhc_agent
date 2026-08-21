import assert from "node:assert/strict";
import test from "node:test";

import {
  SEEDANCE_2_5_MODEL,
  type ProductionProviderRequestOptions,
  type ProductionProviderScope,
  type VideoGenerationJob,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
} from "../src/index.ts";

class ContractVideoGenerationProvider implements VideoGenerationProvider {
  readonly providerId = "contract_seedance_adapter";
  readonly targetModel = SEEDANCE_2_5_MODEL;
  lastRequest: Readonly<VideoGenerationRequest> | undefined;
  lastScope: Readonly<ProductionProviderScope> | undefined;

  async createGeneration(
    request: Readonly<VideoGenerationRequest>,
    scope: Readonly<ProductionProviderScope>,
    _options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<VideoGenerationJob> {
    this.lastRequest = request;
    this.lastScope = scope;
    return this.job("queued");
  }

  async getGeneration(
    _providerJobId: string,
    _scope: Readonly<ProductionProviderScope>,
  ): Promise<VideoGenerationJob> {
    return this.job("running");
  }

  async cancelGeneration(
    _providerJobId: string,
    _scope: Readonly<ProductionProviderScope>,
  ): Promise<VideoGenerationJob> {
    return this.job("cancelled");
  }

  private job(status: VideoGenerationJob["status"]): VideoGenerationJob {
    return {
      providerJobId: "seedance_job_1",
      idempotencyKey: "video_task_1_revision_7",
      model: SEEDANCE_2_5_MODEL,
      status,
      progressPercent: status === "running" ? 40 : 0,
      createdAt: "2026-08-19T13:00:00.000Z",
      updatedAt: "2026-08-19T13:00:00.000Z",
    };
  }
}

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
  prompt: "城市夜景中展示车型外观与座舱细节",
  aspectRatio: "9:16",
  durationSeconds: 30,
};

test("video generation port is explicitly reserved for Seedance 2.5", async () => {
  const provider = new ContractVideoGenerationProvider();
  const job = await provider.createGeneration(request, scope);
  assert.equal(provider.targetModel, "seedance-2.5");
  assert.equal(job.model, SEEDANCE_2_5_MODEL);
  assert.equal(job.status, "queued");
  assert.deepEqual(provider.lastRequest, request);
  assert.deepEqual(provider.lastScope, scope);
});

test("video requests keep authority, billing, approval, and provider URLs outside the port DTO", () => {
  assert.equal("tenantId" in request, false);
  assert.equal("actorAccountId" in request, false);
  assert.equal("taskRevision" in request, false);
  assert.equal("amountMinor" in request, false);
  assert.equal("approvedBy" in request, false);
  const artifact = {
    artifactId: "generated_video_1",
    storageKey: "generated/video_task_1/result.mp4",
    mediaType: "video/mp4" as const,
    width: 1080,
    height: 1920,
    durationSeconds: 30,
    checksumSha256: "a".repeat(64),
  };
  assert.equal("downloadUrl" in artifact, false);
  assert.equal("providerPrivatePayload" in artifact, false);
});
