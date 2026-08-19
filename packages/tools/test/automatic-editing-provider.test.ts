import assert from "node:assert/strict";
import test from "node:test";

import type {
  AutomaticEditingJob,
  AutomaticEditingProvider,
  AutomaticEditingRequest,
  ProductionProviderRequestOptions,
  ProductionProviderScope,
} from "../src/index.ts";

class ContractAutomaticEditingProvider implements AutomaticEditingProvider {
  readonly providerId = "contract_automation_tool";
  lastRequest: Readonly<AutomaticEditingRequest> | undefined;
  lastScope: Readonly<ProductionProviderScope> | undefined;

  async createEditingJob(
    request: Readonly<AutomaticEditingRequest>,
    scope: Readonly<ProductionProviderScope>,
    _options?: Readonly<ProductionProviderRequestOptions>,
  ): Promise<AutomaticEditingJob> {
    this.lastRequest = request;
    this.lastScope = scope;
    return this.job("queued");
  }

  async getEditingJob(
    _providerJobId: string,
    _scope: Readonly<ProductionProviderScope>,
  ): Promise<AutomaticEditingJob> {
    return this.job("running");
  }

  async cancelEditingJob(
    _providerJobId: string,
    _scope: Readonly<ProductionProviderScope>,
  ): Promise<AutomaticEditingJob> {
    return this.job("cancelled");
  }

  private job(status: AutomaticEditingJob["status"]): AutomaticEditingJob {
    return {
      providerJobId: "editing_job_1",
      idempotencyKey: "video_task_1_edit_revision_8",
      status,
      progressPercent: status === "running" ? 65 : 0,
      createdAt: "2026-08-19T13:30:00.000Z",
      updatedAt: "2026-08-19T13:30:00.000Z",
    };
  }
}

const scope: ProductionProviderScope = {
  tenantId: "tenant_firefly",
  actorAccountId: "account_owner",
  batchProjectId: "project_launch",
  videoTaskId: "video_task_1",
  taskRevision: 8,
};

const request: AutomaticEditingRequest = {
  idempotencyKey: "video_task_1_edit_revision_8",
  assetSnapshotId: "asset_snapshot_1",
  storyboardArtifactVersionId: "storyboard_v3",
  sourceVideoArtifactIds: ["generated_video_1", "generated_video_2"],
  draftName: "E5 城市通勤 30 秒",
  aspectRatio: "9:16",
};

test("automatic editing port keeps task scope separate from supplier-neutral input", async () => {
  const provider = new ContractAutomaticEditingProvider();
  const job = await provider.createEditingJob(request, scope);
  assert.deepEqual(provider.lastRequest, request);
  assert.deepEqual(provider.lastScope, scope);
  assert.equal(job.status, "queued");
  assert.equal("tenantId" in request, false);
  assert.equal("actorAccountId" in request, false);
  assert.equal("taskRevision" in request, false);
  assert.equal("amountMinor" in request, false);
  assert.equal("approvedBy" in request, false);
});

test("automatic editing draft exposes an internal handle without vendor-private fields", () => {
  const draft = {
    draftId: "draft_1",
    storageKey: "editing/video_task_1/draft.json",
    manifestSchemaVersion: 1,
    sourceVideoArtifactIds: request.sourceVideoArtifactIds,
  };
  assert.equal("jianyingDraftId" in draft, false);
  assert.equal("vendorPayload" in draft, false);
  assert.equal("downloadUrl" in draft, false);
});
