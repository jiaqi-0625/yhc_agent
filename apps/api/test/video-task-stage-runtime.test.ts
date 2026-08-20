import assert from "node:assert/strict";
import test from "node:test";

import {
  RevisionConflictError,
  WorkspaceAccessDeniedError,
  type VideoTaskProductionRecord,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  AgentActionCard,
  AssetReference,
  BatchProject,
  ProjectAssetPool,
  StageArtifactDependency,
  StageArtifactVersion,
  StageConfirmation,
  TaskAssetSnapshot,
  TemporaryAsset,
} from "@firefly/schemas";
import { MockCompanyAssetProvider } from "@firefly/tools";

import { AgentActionCommandRuntime } from "../src/agent-action-command-runtime.ts";
import { AssetMatchingRuntime } from "../src/asset-matching-runtime.ts";
import {
  BatchProjectAssetPoolStoreAdapter,
  LocalBatchProjectStore,
  type BatchProjectAggregate,
  type BatchProjectCreateMetadata,
  type BatchProjectStore,
} from "../src/batch-project-store.ts";
import { BusinessRuntimeError } from "../src/business-runtime.ts";
import {
  LocalProjectAssetCoordinator,
  type ProjectAssetCoordinator,
} from "../src/project-asset-coordinator.ts";
import { ProjectAssetRuntime, ProjectAssetRuntimeError } from "../src/project-asset-runtime.ts";
import { VideoTaskRuntime } from "../src/video-task-runtime.ts";
import { VideoTaskStageRuntime } from "../src/video-task-stage-runtime.ts";
import {
  LocalVideoTaskProductionStore,
  type VideoTaskProductionStore,
} from "../src/video-task-store.ts";
import {
  DEFAULT_ADMIN_BRANDS,
  DEFAULT_ADMIN_VEHICLES,
  DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
} from "../src/workspace-admin-runtime.ts";
import {
  LocalWorkspaceAdminStore,
  type WorkspaceAdminStore,
} from "../src/workspace-admin-store.ts";
import {
  DEVELOPMENT_ACCESS_GRANTS,
  DEVELOPMENT_ACCOUNTS,
} from "../src/workspace-session-runtime.ts";

const tenantId = "tenant_firefly";
const vehicleId = "vehicle_firefly_e5_2026_long_range";

const project: BatchProject = {
  id: "batch_project_ws306_runtime",
  tenantId,
  brandId: "brand_firefly_demo",
  vehicleId,
  vehicleVersion: 1,
  name: "萤火汽车 萤火 E5 长续航版 9:16 WS306 Runtime",
  batchName: "WS306 Runtime",
  aspectRatio: "9:16",
  visualStylePresetId: "asset_style_firefly_demo_clean",
  assetPoolId: "project_asset_pool_ws306_runtime",
  status: "active",
  revision: 1,
  createdAt: "2026-08-19T16:00:00.000Z",
  createdBy: "account_creator_a",
  updatedAt: "2026-08-19T16:00:00.000Z",
  updatedBy: "account_creator_a",
};

const assetPool: ProjectAssetPool = {
  id: project.assetPoolId,
  tenantId,
  batchProjectId: project.id,
  vehicleId,
  revision: 1,
  assets: [
    {
      assetId: "asset_firefly_demo_e5_hero",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId,
    },
    {
      assetId: "asset_style_firefly_demo_clean",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "visual_style",
    },
    {
      assetId: "asset_person_young_driver",
      version: 2,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "person",
    },
    {
      assetId: "asset_scene_city_night",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "scene",
    },
  ],
  createdAt: project.createdAt,
  createdBy: project.createdBy,
  updatedAt: project.updatedAt,
  updatedBy: project.updatedBy,
};

class MutableBatchProjectStore implements BatchProjectStore {
  readonly #statuses = new Map<string, BatchProject["status"]>();

  constructor(readonly inner: LocalBatchProjectStore) {}

  setStatus(projectId: string, status: BatchProject["status"]): void {
    this.#statuses.set(projectId, status);
  }

  #withStatus(aggregate: BatchProjectAggregate | undefined): BatchProjectAggregate | undefined {
    if (aggregate === undefined) return undefined;
    const status = this.#statuses.get(aggregate.project.id);
    return status === undefined
      ? structuredClone(aggregate)
      : {
          ...structuredClone(aggregate),
          project: { ...structuredClone(aggregate.project), status },
        };
  }

  async load(tenant: string, projectId: string): Promise<BatchProjectAggregate | undefined> {
    return this.#withStatus(await this.inner.load(tenant, projectId));
  }

  async loadByProjectId(projectId: string): Promise<BatchProjectAggregate | undefined> {
    return this.#withStatus(await this.inner.loadByProjectId(projectId));
  }

  async loadByRequest(
    tenant: string,
    actorAccountId: string,
    requestId: string,
  ): Promise<BatchProjectAggregate | undefined> {
    return this.#withStatus(
      await this.inner.loadByRequest(tenant, actorAccountId, requestId),
    );
  }

  async list(tenant: string): Promise<BatchProjectAggregate[]> {
    return (await this.inner.list(tenant)).map((aggregate) => this.#withStatus(aggregate)!);
  }

  async create(
    value: Readonly<BatchProject>,
    pool: Readonly<ProjectAssetPool>,
    metadata: Readonly<BatchProjectCreateMetadata>,
  ): Promise<BatchProjectAggregate> {
    return (await this.inner.create(value, pool, metadata));
  }

  async transactAssetPool(
    tenant: string,
    projectId: string,
    update: (
      current: ProjectAssetPool,
    ) => ProjectAssetPool | Promise<ProjectAssetPool>,
  ): Promise<ProjectAssetPool> {
    return this.inner.transactAssetPool(tenant, projectId, update);
  }
}

async function scope(
  administration: LocalWorkspaceAdminStore,
  accountId = "account_creator_a",
): Promise<WorkspaceSessionScope> {
  const account = DEVELOPMENT_ACCOUNTS.find((candidate) => candidate.accountId === accountId);
  assert.ok(account);
  return {
    actorAccountId: account.accountId,
    tenantId: account.tenantId,
    role: account.role,
    accessGrants: await administration.listForAccount(account.tenantId, account.accountId),
  };
}

async function fixture() {
  const administration = new LocalWorkspaceAdminStore(".data/test-ws306-stage-admin", {
    brands: DEFAULT_ADMIN_BRANDS,
    vehicleVersions: DEFAULT_ADMIN_VEHICLES.map((vehicle) => ({
      ...vehicle,
      fixedClaims: [{
        id: "claim_family_space",
        kind: "fixed" as const,
        name: "五座空间",
        statement: "提供五座乘坐空间。",
        evidence: {
          sourceName: "车型配置表",
          sourceReference: "vehicle-facts-v1",
          effectiveFrom: "2026-08-01",
        },
        requiredInVoiceover: true,
        requiredInSubtitle: true,
        mayRephrase: true,
        riskNotes: [],
      }],
    })),
    vehicleAssetAssociations: DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
    accessGrants: DEVELOPMENT_ACCESS_GRANTS,
  }, false);
  const localProjects = new LocalBatchProjectStore(".data/test-ws306-stage-projects", false);
  const projects = new MutableBatchProjectStore(localProjects);
  await projects.create(project, assetPool, {
    requestId: "request_ws306_project",
    actorAccountId: "account_creator_a",
    payloadHash: "payload_ws306_project",
  });
  const tasks = new LocalVideoTaskProductionStore(".data/test-ws306-stage-tasks", false);
  const creator = await scope(administration);
  let sequence = 0;
  const now = () => "2026-08-19T16:30:00.000Z";
  const videoTasks = new VideoTaskRuntime(
    administration,
    projects,
    tasks,
    () => DEVELOPMENT_ACCOUNTS,
    () => "2026-08-19T16:10:00.000Z",
  );
  const created = await videoTasks.create(project.id, {
    requestId: "request_ws306_task",
    name: "WS306 策略确认任务",
    audience: "城市家庭",
    theme: "智能通勤",
    durationSeconds: 30,
    platformTags: ["douyin"],
  }, creator);
  const commands = new AgentActionCommandRuntime(
    administration,
    projects,
    tasks,
    now,
    (kind) => `${kind}_${++sequence}`,
  );
  const projectAssets = new ProjectAssetRuntime(
    new MockCompanyAssetProvider(),
    new BatchProjectAssetPoolStoreAdapter(projects),
    now,
  );
  const stages = new VideoTaskStageRuntime(
    administration,
    projects,
    tasks,
    now,
    (kind) => `${kind}_${++sequence}`,
    projectAssets,
  );
  return {
    administration,
    commands,
    creator,
    projects,
    projectAssets,
    stages,
    taskId: created.record.videoTask.id,
    tasks,
    videoTasks,
  };
}

function generateCard(
  videoTaskId: string,
  expectedRevision = 1,
): Extract<AgentActionCard, { action: "generate_strategy" }> {
  return {
    schemaVersion: 1,
    kind: "agent_action_card",
    videoTaskId,
    action: "generate_strategy",
    label: "生成卖点策略草稿",
    summary: "使用锁定车型事实生成策略。",
    expectedRevision,
    cost: { kind: "free" },
    payload: { schemaVersion: 1, audience: "城市家庭", theme: "智能通勤" },
  };
}

function approvalCard(
  videoTaskId: string,
  expectedRevision = 2,
): Extract<AgentActionCard, { action: "request_strategy_approval" }> {
  return {
    schemaVersion: 1,
    kind: "agent_action_card",
    videoTaskId,
    action: "request_strategy_approval",
    label: "提交卖点策略人工审批",
    summary: "明确请求负责人审批。",
    expectedRevision,
    cost: { kind: "free" },
    payload: { schemaVersion: 1 },
  };
}

async function prepareStrategyApproval(value: Awaited<ReturnType<typeof fixture>>) {
  await value.commands.execute(project.id, value.taskId, {
    requestId: "command_generate_strategy",
    card: generateCard(value.taskId),
  }, value.creator);
  await value.commands.execute(project.id, value.taskId, {
    requestId: "command_request_strategy_approval",
    card: approvalCard(value.taskId),
  }, value.creator);
}

async function prepareAssetMatchingApproval(value: Awaited<ReturnType<typeof fixture>>) {
  await prepareStrategyApproval(value);
  const strategy = await value.stages.confirmStage(project.id, value.taskId, "strategy", {
    requestId: "request_confirm_strategy_for_assets",
    expectedTaskRevision: 3,
  }, value.creator);
  const scriptReady = await value.tasks.load(value.taskId);
  assert.ok(scriptReady);
  await value.tasks.save({
    ...structuredClone(scriptReady),
    videoTask: {
      ...structuredClone(scriptReady.videoTask),
      stageStatus: "awaiting_confirmation",
    },
  });
  const script = await value.stages.confirmStage(project.id, value.taskId, "script", {
    requestId: "request_confirm_script_for_assets",
    expectedTaskRevision: 4,
    artifact: {
      artifactId: "script_draft_for_assets",
      schemaName: "video_task_script_draft",
      schemaVersion: 1,
      contentHashSha256: "a".repeat(64),
    },
  }, value.creator);
  return { strategy, script };
}

function selectedReusableAssets(): AssetReference[] {
  return assetPool.assets
    .filter((asset) => asset.category === "person" || asset.category === "scene")
    .map((asset) => structuredClone(asset));
}

function hasBusinessCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BusinessRuntimeError && error.code === code;
}

function deferredBarrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function completesWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} did not complete within the bounded test timeout.`));
    }, 2_000);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

test("generate, approval request, explicit confirmation, and stage reads form one audited chain", async () => {
  const value = await fixture();
  await prepareStrategyApproval(value);

  await assert.rejects(
    value.stages.confirmStage(project.id, value.taskId, "strategy", {
      requestId: "request_confirm_forged_strategy",
      expectedTaskRevision: 3,
      artifact: {
        artifactId: "strategy_draft_forged",
        schemaName: "video_task_strategy_draft",
        schemaVersion: 1,
        contentHashSha256: "d".repeat(64),
      },
    }, value.creator),
    hasBusinessCode("AIC-STAGE-STRATEGY_ARTIFACT_MISMATCH"),
  );
  const afterForgery = await value.tasks.load(value.taskId);
  assert.equal(afterForgery?.videoTask.revision, 3);
  assert.equal(afterForgery?.stageArtifactVersions.length, 0);
  assert.equal(afterForgery?.stageConfirmations.length, 0);
  assert.equal(afterForgery?.stageMutationReceipts.length, 0);

  const confirmed = await value.stages.confirmStage(project.id, value.taskId, "strategy", {
    requestId: "request_confirm_strategy",
    expectedTaskRevision: 3,
    comment: "人工确认事实和表达。",
  }, value.creator);

  assert.equal(confirmed.replayed, false);
  assert.equal(confirmed.videoTask.revision, 4);
  assert.equal(confirmed.videoTask.currentStage, "script");
  assert.equal(confirmed.videoTask.stageStatus, "in_progress");
  assert.equal(confirmed.confirmation.source, "human_action");
  assert.equal(confirmed.confirmation.actorAccountId, value.creator.actorAccountId);
  assert.match(confirmed.artifactVersion.content.artifactId, /^strategy_draft_/u);
  assert.equal(confirmed.artifactVersion.content.schemaName, "video_task_strategy_draft");
  assert.deepEqual(
    confirmed.artifactVersion.dependencies.map((dependency) => dependency.kind),
    ["vehicle_snapshot"],
  );

  const versions = await value.stages.getStageVersions(
    project.id,
    value.taskId,
    "strategy",
    value.creator,
  );
  assert.equal(versions.activeArtifactVersionId, confirmed.artifactVersion.id);
  assert.deepEqual(versions.versions.map(({ id }) => id), [confirmed.artifactVersion.id]);
  assert.deepEqual(versions.confirmations.map(({ id }) => id), [confirmed.confirmation.id]);
  assert.deepEqual(
    versions.strategyDrafts?.map(({ id }) => id),
    [confirmed.artifactVersion.content.artifactId],
  );
  assert.equal(versions.activeStrategyDraft?.id, confirmed.artifactVersion.content.artifactId);
  assert.equal(
    versions.confirmationRequest?.strategyDraftId,
    confirmed.artifactVersion.content.artifactId,
  );
  assert.deepEqual(versions.rollbacks, []);
  assert.deepEqual(versions.invalidations, []);
  assert.deepEqual(
    await value.stages.getStageAudit(project.id, value.taskId, value.creator),
    { videoTask: confirmed.videoTask, rollbacks: [], invalidations: [] },
  );
});

test("asset matching confirmation atomically locks the exact server-composed snapshot once", async () => {
  const value = await fixture();
  const upstream = await prepareAssetMatchingApproval(value);
  const editable = await value.tasks.load(value.taskId);
  assert.equal(editable?.videoTask.currentStage, "asset_matching");
  assert.equal(editable?.videoTask.stageStatus, "in_progress");
  assert.equal(editable?.videoTask.revision, 5);
  const input = {
    requestId: "request_confirm_asset_matching",
    expectedTaskRevision: 5,
    assetSelection: {
      expectedProjectAssetPoolRevision: 1,
      selectedAssets: selectedReusableAssets(),
    },
    comment: "人工确认人物与场景选材。",
  };

  const confirmed = await value.stages.confirmStage(
    project.id,
    value.taskId,
    "asset_matching",
    input,
    value.creator,
  );

  assert.equal(confirmed.replayed, false);
  assert.equal(confirmed.videoTask.revision, 6);
  assert.equal(confirmed.videoTask.currentStage, "storyboard");
  assert.equal(confirmed.videoTask.stageStatus, "in_progress");
  assert.equal(confirmed.receipt.expectedTaskRevision, 5);
  assert.equal(confirmed.receipt.resultingTaskRevision, 6);
  assert.equal(confirmed.artifactVersion.content.schemaName, "task_asset_snapshot");
  assert.match(confirmed.artifactVersion.content.contentHashSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    confirmed.artifactVersion.dependencies.map((dependency) => dependency.kind),
    ["vehicle_snapshot", "asset_snapshot", "stage_artifact"],
  );
  assert.deepEqual(confirmed.artifactVersion.dependencies.at(-1), {
    kind: "stage_artifact",
    stage: "script",
    artifactVersionId: upstream.script.artifactVersion.id,
  });

  const persisted = await value.tasks.load(value.taskId);
  assert.ok(persisted);
  assert.equal(persisted.taskAssetSnapshots.length, 1);
  assert.equal(persisted.stageArtifactVersions.length, 3);
  assert.equal(persisted.stageConfirmations.length, 3);
  assert.equal(persisted.stageMutationReceipts.length, 3);
  const snapshot = persisted.taskAssetSnapshots[0]!;
  assert.equal(persisted.videoTask.assetSnapshotId, snapshot.id);
  assert.equal(confirmed.artifactVersion.content.artifactId, snapshot.id);
  assert.equal(confirmed.artifactVersion.dependencies[1]?.kind, "asset_snapshot");
  assert.deepEqual(
    snapshot.assets.map(({ assetId, version, category }) => ({ assetId, version, category })),
    [
      { assetId: "asset_firefly_demo_e5_hero", version: 1, category: "vehicle" },
      { assetId: "asset_style_firefly_demo_clean", version: 1, category: "visual_style" },
      { assetId: "asset_person_young_driver", version: 2, category: "person" },
      { assetId: "asset_scene_city_night", version: 1, category: "scene" },
    ],
  );

  await value.projects.transactAssetPool(tenantId, project.id, (current) => ({
    ...structuredClone(current),
    revision: current.revision + 1,
    updatedAt: "2026-08-19T16:45:00.000Z",
  }));
  const replay = await value.stages.confirmStage(
    project.id,
    value.taskId,
    "asset_matching",
    input,
    value.creator,
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, confirmed.receipt);
  assert.deepEqual(await value.tasks.load(value.taskId), persisted);
});

test("a persisted awaiting asset selection remains confirmable through the canonical transaction", async () => {
  const value = await fixture();
  await prepareAssetMatchingApproval(value);
  const editable = await value.tasks.load(value.taskId);
  assert.ok(editable);
  await value.tasks.save({
    ...structuredClone(editable),
    videoTask: {
      ...structuredClone(editable.videoTask),
      stageStatus: "awaiting_confirmation",
    },
  });

  const confirmed = await value.stages.confirmStage(
    project.id,
    value.taskId,
    "asset_matching",
    {
      requestId: "request_confirm_submitted_asset_matching",
      expectedTaskRevision: 5,
      assetSelection: {
        expectedProjectAssetPoolRevision: 1,
        selectedAssets: selectedReusableAssets(),
      },
    },
    value.creator,
  );

  assert.equal(confirmed.videoTask.revision, 6);
  assert.equal(confirmed.videoTask.currentStage, "storyboard");
  assert.equal(confirmed.confirmation.stage, "asset_matching");
  assert.equal(confirmed.receipt.resultingTaskRevision, 6);
});

test("an old-order active asset pointer stays historical and can be replaced after canonical script", async () => {
  const value = await fixture();
  const upstream = await prepareAssetMatchingApproval(value);
  const current = await value.tasks.load(value.taskId);
  assert.ok(current?.videoTask.vehicleSnapshotId);
  const staleSnapshot: TaskAssetSnapshot = {
    id: "task_asset_snapshot_old_order_target",
    tenantId,
    batchProjectId: project.id,
    videoTaskId: value.taskId,
    version: 1,
    sourceProjectAssetPoolRevision: assetPool.revision,
    vehicleSnapshotId: current.videoTask.vehicleSnapshotId,
    assets: structuredClone(assetPool.assets),
    createdAt: "2026-08-19T16:20:00.000Z",
    createdBy: value.creator.actorAccountId,
  };
  const staleConfirmationId = "confirmation_old_order_asset_target";
  const staleArtifact: StageArtifactVersion = {
    id: "artifact_old_order_asset_target",
    tenantId,
    batchProjectId: project.id,
    videoTaskId: value.taskId,
    stage: "asset_matching",
    version: 1,
    content: {
      artifactId: staleSnapshot.id,
      schemaName: "task_asset_snapshot",
      schemaVersion: 1,
      contentHashSha256: "c".repeat(64),
    },
    dependencies: [
      { kind: "vehicle_snapshot", vehicleSnapshotId: current.videoTask.vehicleSnapshotId },
      { kind: "asset_snapshot", assetSnapshotId: staleSnapshot.id },
      {
        kind: "stage_artifact",
        stage: "strategy",
        artifactVersionId: upstream.strategy.artifactVersion.id,
      },
    ],
    provenance: { kind: "human_confirmation", confirmationId: staleConfirmationId },
    createdAt: "2026-08-19T16:20:00.000Z",
    createdBy: value.creator.actorAccountId,
  };
  const staleConfirmation: StageConfirmation = {
    id: staleConfirmationId,
    tenantId,
    batchProjectId: project.id,
    videoTaskId: value.taskId,
    stage: "asset_matching",
    artifactVersionId: staleArtifact.id,
    decision: "confirmed",
    source: "human_action",
    expectedTaskRevision: 4,
    actorAccountId: value.creator.actorAccountId,
    occurredAt: staleArtifact.createdAt,
  };
  await value.tasks.save({
    ...structuredClone(current),
    videoTask: {
      ...structuredClone(current.videoTask),
      assetSnapshotId: staleSnapshot.id,
    },
    taskAssetSnapshots: [...structuredClone(current.taskAssetSnapshots), staleSnapshot],
    stageArtifactVersions: [...structuredClone(current.stageArtifactVersions), staleArtifact],
    stageConfirmations: [...structuredClone(current.stageConfirmations), staleConfirmation],
    activeStageArtifactVersionIds: {
      ...structuredClone(current.activeStageArtifactVersionIds),
      asset_matching: staleArtifact.id,
    },
  });

  const matching = new AssetMatchingRuntime(
    value.administration,
    value.projects,
    value.tasks,
    new MockCompanyAssetProvider(),
    value.projectAssets,
    { async listTemporaryAssets() { return []; } } as never,
    value.stages,
  );
  const view = await matching.getView(project.id, value.taskId, value.creator);
  assert.equal(view.matchingReady, true);
  assert.equal(view.confirmationReady, true);
  assert.equal(view.matchingLocked, false);
  assert.equal(view.videoTask.assetSnapshotId, undefined);

  const confirmed = await value.stages.confirmStage(
    project.id,
    value.taskId,
    "asset_matching",
    {
      requestId: "request_replace_old_order_asset_target",
      expectedTaskRevision: 5,
      assetSelection: {
        expectedProjectAssetPoolRevision: view.poolRevision,
        selectedAssets: selectedReusableAssets(),
      },
    },
    value.creator,
  );
  const persisted = await value.tasks.load(value.taskId);
  assert.ok(persisted?.videoTask.assetSnapshotId);
  assert.notEqual(persisted.videoTask.assetSnapshotId, staleSnapshot.id);
  assert.equal(persisted.taskAssetSnapshots.length, 2);
  assert.equal(persisted.activeStageArtifactVersionIds.asset_matching, confirmed.artifactVersion.id);
  assert.equal(confirmed.videoTask.currentStage, "storyboard");
});

test("asset confirmation and Agent command share coordinator-before-admin lock order without deadlock", async () => {
  const value = await fixture();
  await prepareAssetMatchingApproval(value);

  const coordinatorAcquired = deferredBarrier();
  const allowCoordinatorHolderToEnterAdmin = deferredBarrier();
  const secondCoordinatorRequestStarted = deferredBarrier();
  const innerCoordinator = new LocalProjectAssetCoordinator();
  let coordinatorCallCount = 0;
  const coordinator: ProjectAssetCoordinator = {
    runExclusive(batchProjectId, operation) {
      coordinatorCallCount += 1;
      const callNumber = coordinatorCallCount;
      if (callNumber === 2) secondCoordinatorRequestStarted.release();
      return innerCoordinator.runExclusive(batchProjectId, async () => {
        if (callNumber === 1) {
          coordinatorAcquired.release();
          await allowCoordinatorHolderToEnterAdmin.promise;
        }
        return operation();
      });
    },
  };

  const adminSnapshotEntered = deferredBarrier();
  const allowAdminSnapshotToContinue = deferredBarrier();
  let pauseNextAdminSnapshot = true;
  const administration: WorkspaceAdminStore = {
    load: (requestedTenantId) => value.administration.load(requestedTenantId),
    listForAccount: (requestedTenantId, accountId) =>
      value.administration.listForAccount(requestedTenantId, accountId),
    transact: (requestedTenantId, update) =>
      value.administration.transact(requestedTenantId, update),
    withSnapshot: (requestedTenantId, inspect) =>
      value.administration.withSnapshot(requestedTenantId, async (state) => {
        if (pauseNextAdminSnapshot) {
          pauseNextAdminSnapshot = false;
          adminSnapshotEntered.release();
          await allowAdminSnapshotToContinue.promise;
        }
        return inspect(state);
      }),
  };
  const now = () => "2026-08-19T16:30:00.000Z";
  let sequence = 0;
  const createId = (kind: string) => `${kind}_lock_order_${++sequence}`;
  const commands = new AgentActionCommandRuntime(
    administration,
    value.projects,
    value.tasks,
    now,
    createId,
    coordinator,
  );
  const projectAssets = new ProjectAssetRuntime(
    new MockCompanyAssetProvider(),
    new BatchProjectAssetPoolStoreAdapter(value.projects),
    now,
    undefined,
    coordinator,
  );
  const stages = new VideoTaskStageRuntime(
    administration,
    value.projects,
    value.tasks,
    now,
    createId,
    projectAssets,
  );
  const confirmationInput = {
    requestId: "request_asset_lock_order",
    expectedTaskRevision: 5,
    assetSelection: {
      expectedProjectAssetPoolRevision: 1,
      selectedAssets: selectedReusableAssets(),
    },
  };

  const confirmationPromise = stages.confirmStage(
    project.id,
    value.taskId,
    "asset_matching",
    confirmationInput,
    value.creator,
  );
  await completesWithin(coordinatorAcquired.promise, "asset confirmation coordinator acquisition");

  const commandPromise = commands.execute(project.id, value.taskId, {
    requestId: "command_generate_strategy",
    card: generateCard(value.taskId),
  }, value.creator);
  await completesWithin(
    secondCoordinatorRequestStarted.promise,
    "concurrent Agent command coordinator request",
  );

  allowCoordinatorHolderToEnterAdmin.release();
  await completesWithin(adminSnapshotEntered.promise, "asset confirmation admin snapshot entry");
  allowAdminSnapshotToContinue.release();

  const [confirmation, commandReplay] = await completesWithin(
    Promise.all([confirmationPromise, commandPromise]),
    "asset confirmation and concurrent Agent command",
  );
  const confirmationReplay = await completesWithin(
    stages.confirmStage(
      project.id,
      value.taskId,
      "asset_matching",
      confirmationInput,
      value.creator,
    ),
    "third idempotent confirmation replay",
  );

  assert.equal(confirmation.replayed, false);
  assert.equal(commandReplay.replayed, true);
  assert.equal(confirmationReplay.replayed, true);
  assert.deepEqual(confirmationReplay.receipt, confirmation.receipt);
  const persisted = await value.tasks.load(value.taskId);
  assert.ok(persisted);
  assert.equal(persisted.taskAssetSnapshots.length, 1);
  assert.equal(
    persisted.stageConfirmations.filter((item) => item.stage === "asset_matching").length,
    1,
  );
  assert.equal(
    persisted.stageMutationReceipts.filter(
      (item) => item.requestId === confirmationInput.requestId,
    ).length,
    1,
  );
});

test("asset matching confirmation rejects stale selections and client-owned artifact input without mutation", async () => {
  const value = await fixture();
  await prepareAssetMatchingApproval(value);
  const before = await value.tasks.load(value.taskId);
  assert.ok(before);

  await assert.rejects(
    value.stages.confirmStage(project.id, value.taskId, "asset_matching", {
      requestId: "request_asset_with_client_artifact",
      expectedTaskRevision: 5,
      artifact: {
        artifactId: "client_asset_selection",
        schemaName: "client_asset_selection",
        schemaVersion: 1,
        contentHashSha256: "b".repeat(64),
      },
      assetSelection: {
        expectedProjectAssetPoolRevision: 1,
        selectedAssets: selectedReusableAssets(),
      },
    }, value.creator),
    hasBusinessCode("AIC-STAGE-ASSET-ARTIFACT-SERVER-OWNED"),
  );
  await assert.rejects(
    value.stages.confirmStage(project.id, value.taskId, "asset_matching", {
      requestId: "request_asset_stale_pool",
      expectedTaskRevision: 5,
      assetSelection: {
        expectedProjectAssetPoolRevision: 99,
        selectedAssets: selectedReusableAssets(),
      },
    }, value.creator),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "AIC-ASSET-SELECTION-REVISION-CONFLICT",
  );
  assert.deepEqual(await value.tasks.load(value.taskId), before);
});

test("non-asset stages reject asset selection input before any task mutation", async () => {
  const value = await fixture();
  await prepareStrategyApproval(value);
  const before = await value.tasks.load(value.taskId);
  assert.ok(before);
  await assert.rejects(
    value.stages.confirmStage(project.id, value.taskId, "strategy", {
      requestId: "request_strategy_with_asset_selection",
      expectedTaskRevision: 3,
      assetSelection: {
        expectedProjectAssetPoolRevision: 1,
        selectedAssets: selectedReusableAssets(),
      },
    }, value.creator),
    hasBusinessCode("AIC-STAGE-ASSET-SELECTION-NOT-ALLOWED"),
  );
  assert.deepEqual(await value.tasks.load(value.taskId), before);
});

test("migrated strategy awaiting confirmation resumes without a fabricated request", async () => {
  const generated = await fixture();
  await prepareStrategyApproval(generated);
  const generatedRecord = await generated.tasks.load(generated.taskId);
  assert.ok(generatedRecord);
  await generated.tasks.save({
    ...structuredClone(generatedRecord),
    stageConfirmationRequests: [],
    commandReceipts: generatedRecord.commandReceipts.filter(
      (receipt) => receipt.action !== "request_strategy_approval",
    ),
  });

  await assert.rejects(
    generated.stages.confirmStage(project.id, generated.taskId, "strategy", {
      requestId: "request_generated_without_confirmation_request",
      expectedTaskRevision: generatedRecord.videoTask.revision,
    }, generated.creator),
    hasBusinessCode("AIC-STAGE-CONFIRMATION_REQUEST_NOT_FOUND"),
  );
  const unchangedGenerated = await generated.tasks.load(generated.taskId);
  assert.equal(unchangedGenerated?.stageConfirmations.length, 0);
  assert.equal(unchangedGenerated?.stageArtifactVersions.length, 0);
  assert.equal(unchangedGenerated?.stageMutationReceipts.length, 0);

  const migrated = await fixture();
  await prepareStrategyApproval(migrated);
  const migratedRecord = await migrated.tasks.load(migrated.taskId);
  assert.ok(migratedRecord);
  const migratedDraft = migratedRecord.strategyDrafts[0];
  assert.ok(migratedDraft);
  migratedDraft.generation = {
    kind: "legacy_migration",
    migratedFromSchemaVersion: 1,
    migrationId: "migration_ws307_resume",
    legacyStrategyId: "legacy_strategy_awaiting_confirmation",
    legacyStrategyStatus: "awaiting_approval",
    model: "legacy-model",
    templateVersion: "legacy-template-v1",
    approvals: [],
  };
  migratedRecord.stageConfirmationRequests = [];
  migratedRecord.commandReceipts = [];
  await migrated.tasks.save(migratedRecord);

  const confirmed = await migrated.stages.confirmStage(
    project.id,
    migrated.taskId,
    "strategy",
    {
      requestId: "request_confirm_migrated_strategy",
      expectedTaskRevision: migratedRecord.videoTask.revision,
      comment: "对迁移策略执行当前人工确认。",
    },
    migrated.creator,
  );

  assert.equal(confirmed.replayed, false);
  assert.equal(confirmed.confirmation.source, "human_action");
  assert.equal(confirmed.confirmation.actorAccountId, migrated.creator.actorAccountId);
  assert.equal(confirmed.artifactVersion.content.artifactId, migratedDraft.id);
  assert.equal(confirmed.artifactVersion.provenance.kind, "human_confirmation");
  assert.deepEqual(confirmed.artifactVersion.dependencies, [
    { kind: "vehicle_snapshot", vehicleSnapshotId: migratedDraft.vehicleSnapshotId },
  ]);
  assert.equal(confirmed.receipt.action, "confirm_stage");
  assert.equal(confirmed.receipt.expectedTaskRevision, migratedRecord.videoTask.revision);
  assert.equal(confirmed.receipt.resultingTaskRevision, migratedRecord.videoTask.revision + 1);
  assert.equal(confirmed.videoTask.currentStage, "script");
  assert.equal(confirmed.videoTask.stageStatus, "in_progress");

  const persisted = await migrated.tasks.load(migrated.taskId);
  assert.equal(persisted?.stageConfirmationRequests.length, 0);
  assert.equal(persisted?.stageConfirmations.length, 1);
  assert.equal(persisted?.stageArtifactVersions.length, 1);
  assert.equal(persisted?.stageMutationReceipts.length, 1);
});

test("stage reads and writes enforce dynamic grants, project scope, owner, and creator role", async () => {
  const value = await fixture();
  await prepareStrategyApproval(value);
  const member = await scope(value.administration, "account_creator_b");
  const administrator = await scope(value.administration, "account_admin");

  await assert.doesNotReject(
    value.stages.getStageVersions(project.id, value.taskId, "strategy", member),
  );
  await assert.doesNotReject(
    value.stages.getStageAudit(project.id, value.taskId, administrator),
  );
  await assert.rejects(
    value.stages.confirmStage(project.id, value.taskId, "strategy", {
      requestId: "request_non_owner_confirm",
      expectedTaskRevision: 3,
    }, member),
    WorkspaceAccessDeniedError,
  );
  await assert.rejects(
    value.stages.confirmStage(project.id, value.taskId, "strategy", {
      requestId: "request_admin_confirm",
      expectedTaskRevision: 3,
    }, administrator),
    hasBusinessCode("AIC-AUTH-ROLE_DENIED"),
  );

  const secondProject = {
    ...project,
    id: "batch_project_ws306_second",
    name: "萤火汽车 萤火 E5 长续航版 9:16 WS306 Second",
    batchName: "WS306 Second",
    assetPoolId: "project_asset_pool_ws306_second",
  };
  await value.projects.create(secondProject, {
    ...assetPool,
    id: secondProject.assetPoolId,
    batchProjectId: secondProject.id,
  }, {
    requestId: "request_ws306_second_project",
    actorAccountId: value.creator.actorAccountId,
    payloadHash: "payload_ws306_second_project",
  });
  const secondTask = await value.videoTasks.create(secondProject.id, {
    requestId: "request_ws306_second_task",
    name: "WS306 第二项目任务",
    audience: "城市家庭",
    theme: "项目隔离",
    durationSeconds: 30,
    platformTags: ["douyin"],
  }, value.creator);
  await assert.rejects(
    value.stages.getStageVersions(
      project.id,
      secondTask.record.videoTask.id,
      "strategy",
      value.creator,
    ),
    hasBusinessCode("AIC-STAGE-TASK_NOT_FOUND"),
  );
  await assert.rejects(
    value.stages.getStageVersions(
      project.id,
      "task_does_not_exist",
      "strategy",
      value.creator,
    ),
    hasBusinessCode("AIC-STAGE-TASK_NOT_FOUND"),
  );

  const hiddenProject: BatchProject = {
    ...project,
    id: "batch_project_ws306_hidden",
    vehicleId: "vehicle_ungranted",
    name: "隐藏车型项目",
    batchName: "Hidden",
    assetPoolId: "project_asset_pool_ws306_hidden",
  };
  await value.projects.create(hiddenProject, {
    ...assetPool,
    id: hiddenProject.assetPoolId,
    batchProjectId: hiddenProject.id,
    vehicleId: hiddenProject.vehicleId,
    assets: [{
      assetId: "asset_hidden_vehicle",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "vehicle",
      vehicleId: hiddenProject.vehicleId,
    }],
  }, {
    requestId: "request_ws306_hidden_project",
    actorAccountId: value.creator.actorAccountId,
    payloadHash: "payload_ws306_hidden_project",
  });
  let taskLoads = 0;
  const countingTasks: VideoTaskProductionStore = {
    async load(videoTaskId) {
      taskLoads += 1;
      return value.tasks.load(videoTaskId);
    },
    async save(record) {
      return value.tasks.save(record);
    },
    async transact(videoTaskId, update) {
      return value.tasks.transact(videoTaskId, update);
    },
  };
  const countingRuntime = new VideoTaskStageRuntime(
    value.administration,
    value.projects,
    countingTasks,
  );
  await assert.rejects(
    countingRuntime.getStageVersions(
      hiddenProject.id,
      "task_guessed",
      "strategy",
      value.creator,
    ),
    WorkspaceAccessDeniedError,
  );
  assert.equal(taskLoads, 0);

  const confirmed = await value.stages.confirmStage(project.id, value.taskId, "strategy", {
    requestId: "request_confirm_before_revocation",
    expectedTaskRevision: 3,
  }, value.creator);
  await value.administration.transact(tenantId, (state) => ({
    ...state,
    accessGrants: state.accessGrants.map((grant) =>
      grant.accountId === value.creator.actorAccountId
        ? {
            ...grant,
            status: "revoked" as const,
            revision: grant.revision + 1,
            updatedAt: "2026-08-19T16:40:00.000Z",
            updatedBy: "account_admin",
          }
        : grant),
  }));
  await assert.rejects(
    value.stages.getStageAudit(project.id, value.taskId, value.creator),
    WorkspaceAccessDeniedError,
  );
  await assert.rejects(
    value.stages.confirmStage(project.id, value.taskId, "strategy", {
      requestId: confirmed.receipt.requestId,
      expectedTaskRevision: 3,
    }, value.creator),
    WorkspaceAccessDeniedError,
  );
});

test("confirmation is replay-safe under serial and concurrent retries and rejects payload conflicts", async () => {
  const value = await fixture();
  await prepareStrategyApproval(value);
  const input = {
    requestId: "request_concurrent_confirm",
    expectedTaskRevision: 3,
    comment: "显式人工确认。",
  };

  const concurrent = await Promise.all([
    value.stages.confirmStage(project.id, value.taskId, "strategy", input, value.creator),
    value.stages.confirmStage(project.id, value.taskId, "strategy", input, value.creator),
  ]);
  assert.deepEqual(concurrent.map(({ replayed }) => replayed).sort(), [false, true]);
  assert.deepEqual(concurrent[1]!.receipt, concurrent[0]!.receipt);

  const serialReplay = await value.stages.confirmStage(
    project.id,
    value.taskId,
    "strategy",
    input,
    value.creator,
  );
  assert.equal(serialReplay.replayed, true);
  assert.deepEqual(serialReplay.receipt, concurrent[0]!.receipt);

  await assert.rejects(
    value.stages.confirmStage(project.id, value.taskId, "strategy", {
      ...input,
      artifact: concurrent[0]!.artifactVersion.content,
    }, value.creator),
    hasBusinessCode("AIC-STAGE-IDEMPOTENCY_CONFLICT"),
  );
  const persisted = await value.tasks.load(value.taskId);
  assert.equal(persisted?.stageConfirmations.length, 1);
  assert.equal(persisted?.stageArtifactVersions.length, 1);
  assert.equal(persisted?.stageMutationReceipts.length, 1);
  assert.equal(persisted?.videoTask.revision, 4);
});

test("command and stage receipts reserve one actor request ID across both mutation collections", async () => {
  const value = await fixture();
  await prepareStrategyApproval(value);

  await assert.rejects(
    value.stages.confirmStage(project.id, value.taskId, "strategy", {
      requestId: "command_generate_strategy",
      expectedTaskRevision: 3,
    }, value.creator),
    hasBusinessCode("AIC-STAGE-IDEMPOTENCY_CONFLICT"),
  );
  const afterCommandCollision = await value.tasks.load(value.taskId);
  assert.equal(afterCommandCollision?.videoTask.revision, 3);
  assert.equal(afterCommandCollision?.stageMutationReceipts.length, 0);
  assert.equal(afterCommandCollision?.stageConfirmations.length, 0);

  const sharedRequestId = "request_stage_then_command_collision";
  await value.stages.confirmStage(project.id, value.taskId, "strategy", {
    requestId: sharedRequestId,
    expectedTaskRevision: 3,
  }, value.creator);
  const beforeStageCollision = await value.tasks.load(value.taskId);
  assert.ok(beforeStageCollision);
  await assert.rejects(
    value.commands.execute(project.id, value.taskId, {
      requestId: sharedRequestId,
      card: generateCard(value.taskId, 4),
    }, value.creator),
    hasBusinessCode("AIC-AGENT-COMMAND-IDEMPOTENCY_CONFLICT"),
  );
  assert.deepEqual(await value.tasks.load(value.taskId), beforeStageCollision);
});

test("different confirmation requests racing on one revision produce only one mutation", async () => {
  const value = await fixture();
  await prepareStrategyApproval(value);

  const outcomes = await Promise.allSettled([
    value.stages.confirmStage(project.id, value.taskId, "strategy", {
      requestId: "request_revision_race_a",
      expectedTaskRevision: 3,
    }, value.creator),
    value.stages.confirmStage(project.id, value.taskId, "strategy", {
      requestId: "request_revision_race_b",
      expectedTaskRevision: 3,
    }, value.creator),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = outcomes.find(({ status }) => status === "rejected");
  assert.equal(rejected?.status, "rejected");
  assert.ok(rejected.reason instanceof RevisionConflictError);
  const persisted = await value.tasks.load(value.taskId);
  assert.equal(persisted?.videoTask.revision, 4);
  assert.equal(persisted?.stageConfirmations.length, 1);
  assert.equal(persisted?.stageMutationReceipts.length, 1);
});

test("successful confirmation replays after owner and project state changes", async () => {
  const value = await fixture();
  await prepareStrategyApproval(value);
  const input = { requestId: "request_replay_after_state_change", expectedTaskRevision: 3 };
  const first = await value.stages.confirmStage(
    project.id,
    value.taskId,
    "strategy",
    input,
    value.creator,
  );
  await value.videoTasks.assign(project.id, value.taskId, {
    expectedTaskRevision: 4,
    targetOwnerAccountId: "account_creator_b",
    reason: "转交资产匹配。",
  }, value.creator);

  const ownerChangedReplay = await value.stages.confirmStage(
    project.id,
    value.taskId,
    "strategy",
    input,
    value.creator,
  );
  assert.equal(ownerChangedReplay.replayed, true);
  assert.deepEqual(ownerChangedReplay.receipt, first.receipt);
  assert.equal(ownerChangedReplay.videoTask.ownerAccountId, "account_creator_b");

  value.projects.setStatus(project.id, "archived");
  const archivedReplay = await value.stages.confirmStage(
    project.id,
    value.taskId,
    "strategy",
    input,
    value.creator,
  );
  assert.equal(archivedReplay.replayed, true);
  assert.deepEqual(archivedReplay.receipt, first.receipt);
  await assert.rejects(
    value.stages.rollbackStage(project.id, value.taskId, "strategy", {
      requestId: "request_new_on_archived_project",
      expectedTaskRevision: 5,
      targetArtifactVersionId: first.artifactVersion.id,
      reason: "归档后不应写入。",
    }, value.creator),
    hasBusinessCode("AIC-STAGE-PROJECT_INACTIVE"),
  );
});

function artifact(
  source: Readonly<VideoTaskProductionRecord>,
  id: string,
  stage: StageArtifactVersion["stage"],
  version: number,
  dependencies: StageArtifactDependency[],
  confirmationId: string,
  occurredAt: string,
): StageArtifactVersion {
  return {
    id,
    tenantId: source.videoTask.tenantId,
    batchProjectId: source.videoTask.batchProjectId,
    videoTaskId: source.videoTask.id,
    stage,
    version,
    content: {
      artifactId: `${id}_content`,
      schemaName: `${stage}_artifact`,
      schemaVersion: 1,
      contentHashSha256: version.toString(16).repeat(64),
    },
    dependencies: structuredClone(dependencies),
    provenance: { kind: "human_confirmation", confirmationId },
    createdAt: occurredAt,
    createdBy: source.videoTask.ownerAccountId,
  };
}

function confirmation(
  source: Readonly<VideoTaskProductionRecord>,
  artifactVersion: Readonly<StageArtifactVersion>,
  expectedTaskRevision: number,
): StageConfirmation {
  assert.equal(artifactVersion.provenance.kind, "human_confirmation");
  return {
    id: artifactVersion.provenance.confirmationId,
    tenantId: source.videoTask.tenantId,
    batchProjectId: source.videoTask.batchProjectId,
    videoTaskId: source.videoTask.id,
    stage: artifactVersion.stage,
    artifactVersionId: artifactVersion.id,
    decision: "confirmed",
    source: "human_action",
    expectedTaskRevision,
    actorAccountId: source.videoTask.ownerAccountId,
    occurredAt: artifactVersion.createdAt,
  };
}

async function prepareRollbackGraph(value: Awaited<ReturnType<typeof fixture>>) {
  await prepareStrategyApproval(value);
  const strategyV1 = await value.stages.confirmStage(project.id, value.taskId, "strategy", {
    requestId: "request_confirm_strategy_v1",
    expectedTaskRevision: 3,
  }, value.creator);
  const current = await value.tasks.load(value.taskId);
  assert.ok(current);
  const snapshotDependencies = structuredClone(strategyV1.artifactVersion.dependencies);
  const strategyV2 = artifact(
    current,
    "artifact_strategy_v2",
    "strategy",
    2,
    snapshotDependencies,
    "confirmation_strategy_v2",
    "2026-08-19T16:31:00.000Z",
  );
  const assetV1 = artifact(
    current,
    "artifact_asset_v1",
    "asset_matching",
    1,
    [
      ...snapshotDependencies,
      { kind: "stage_artifact", stage: "strategy", artifactVersionId: strategyV2.id },
    ],
    "confirmation_asset_v1",
    "2026-08-19T16:32:00.000Z",
  );
  const scriptV1 = artifact(
    current,
    "artifact_script_v1",
    "script",
    1,
    [
      ...snapshotDependencies,
      { kind: "stage_artifact", stage: "asset_matching", artifactVersionId: assetV1.id },
    ],
    "confirmation_script_v1",
    "2026-08-19T16:33:00.000Z",
  );
  const storyboardV1 = artifact(
    current,
    "artifact_storyboard_v1",
    "storyboard",
    1,
    [
      ...snapshotDependencies,
      { kind: "stage_artifact", stage: "script", artifactVersionId: scriptV1.id },
    ],
    "confirmation_storyboard_v1",
    "2026-08-19T16:34:00.000Z",
  );
  const appended = [strategyV2, assetV1, scriptV1, storyboardV1];
  const record: VideoTaskProductionRecord = {
    ...structuredClone(current),
    videoTask: {
      ...structuredClone(current.videoTask),
      status: "active",
      currentStage: "video_preview",
      stageStatus: "in_progress",
      revision: 8,
      updatedAt: "2026-08-19T16:34:00.000Z",
      updatedBy: value.creator.actorAccountId,
    },
    stageArtifactVersions: [...structuredClone(current.stageArtifactVersions), ...appended],
    stageConfirmations: [
      ...structuredClone(current.stageConfirmations),
      confirmation(current, strategyV2, 4),
      confirmation(current, assetV1, 5),
      confirmation(current, scriptV1, 6),
      confirmation(current, storyboardV1, 7),
    ],
    activeStageArtifactVersionIds: {
      strategy: strategyV2.id,
      asset_matching: assetV1.id,
      script: scriptV1.id,
      storyboard: storyboardV1.id,
    },
  };
  await value.tasks.save(record);
  return { strategyV1: strategyV1.artifactVersion, strategyV2, assetV1, scriptV1, storyboardV1 };
}

test("rollback replay atomically persists recursive invalidations and stage audit reads", async () => {
  const value = await fixture();
  const graph = await prepareRollbackGraph(value);
  const input = {
    requestId: "request_rollback_strategy_v1",
    expectedTaskRevision: 8,
    targetArtifactVersionId: graph.strategyV1.id,
    reason: "恢复首版策略。",
  };

  const rolledBack = await value.stages.rollbackStage(
    project.id,
    value.taskId,
    "strategy",
    input,
    value.creator,
  );
  assert.equal(rolledBack.replayed, false);
  assert.equal(rolledBack.videoTask.revision, 9);
  assert.deepEqual(
    rolledBack.invalidations.map(({ artifactVersionId }) => artifactVersionId),
    [graph.assetV1.id, graph.scriptV1.id, graph.storyboardV1.id],
  );
  const persisted = await value.tasks.load(value.taskId);
  assert.equal(persisted?.activeStageArtifactVersionIds.strategy, graph.strategyV1.id);
  assert.equal(persisted?.activeStageArtifactVersionIds.asset_matching, undefined);
  assert.equal(persisted?.activeStageArtifactVersionIds.script, undefined);
  assert.equal(persisted?.activeStageArtifactVersionIds.storyboard, undefined);
  assert.equal(persisted?.stageRollbacks.length, 1);
  assert.equal(persisted?.stageArtifactInvalidations.length, 3);

  const replay = await value.stages.rollbackStage(
    project.id,
    value.taskId,
    "strategy",
    input,
    value.creator,
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, rolledBack.receipt);
  assert.deepEqual(replay.rollback, rolledBack.rollback);
  assert.deepEqual(replay.invalidations, rolledBack.invalidations);
  await assert.rejects(
    value.stages.rollbackStage(project.id, value.taskId, "strategy", {
      ...input,
      reason: "同 requestId 不同原因。",
    }, value.creator),
    hasBusinessCode("AIC-STAGE-IDEMPOTENCY_CONFLICT"),
  );

  const strategyHistory = await value.stages.getStageVersions(
    project.id,
    value.taskId,
    "strategy",
    value.creator,
  );
  assert.deepEqual(strategyHistory.versions.map(({ version }) => version), [1, 2]);
  assert.deepEqual(strategyHistory.rollbacks.map(({ id }) => id), [rolledBack.rollback.id]);
  const assetHistory = await value.stages.getStageVersions(
    project.id,
    value.taskId,
    "asset_matching",
    value.creator,
  );
  assert.deepEqual(
    assetHistory.invalidations.map(({ artifactVersionId }) => artifactVersionId),
    [graph.assetV1.id],
  );
  assert.equal(assetHistory.strategyDrafts, undefined);
  const audit = await value.stages.getStageAudit(project.id, value.taskId, value.creator);
  assert.deepEqual(audit.rollbacks.map(({ id }) => id), [rolledBack.rollback.id]);
  assert.deepEqual(
    audit.invalidations.map(({ artifactVersionId }) => artifactVersionId),
    [graph.assetV1.id, graph.scriptV1.id, graph.storyboardV1.id],
  );

  assert.ok(persisted);
  const selectedDraft = persisted.strategyDrafts.find(
    (draft) => draft.id === graph.strategyV1.content.artifactId,
  );
  assert.ok(selectedDraft);
  const newerDraft = {
    ...structuredClone(selectedDraft),
    id: "strategy_draft_newer_than_rollback_target",
    version: selectedDraft.version + 1,
    createdAt: "2026-08-19T16:35:00.000Z",
    updatedAt: "2026-08-19T16:35:00.000Z",
  };
  const selectionRecord: VideoTaskProductionRecord = {
    ...structuredClone(persisted),
    strategyDrafts: [...structuredClone(persisted.strategyDrafts), newerDraft],
    activeStrategyDraftId: newerDraft.id,
  };
  const selectionStore: VideoTaskProductionStore = {
    async load() {
      return structuredClone(selectionRecord);
    },
    async save() {
      throw new Error("read-only selection fixture");
    },
    async transact() {
      throw new Error("read-only selection fixture");
    },
  };
  const selectionRuntime = new VideoTaskStageRuntime(
    value.administration,
    value.projects,
    selectionStore,
  );
  const selectedHistory = await selectionRuntime.getStageVersions(
    project.id,
    value.taskId,
    "strategy",
    value.creator,
  );
  assert.equal(selectedHistory.activeArtifactVersionId, graph.strategyV1.id);
  assert.deepEqual(
    selectedHistory.strategyDrafts?.map(({ id }) => id),
    [...selectionRecord.strategyDrafts]
      .sort((left, right) => left.version - right.version || left.id.localeCompare(right.id, "en"))
      .map(({ id }) => id),
  );
  assert.equal(selectedHistory.activeStrategyDraft?.id, selectedDraft.id);
  assert.equal(selectedHistory.confirmationRequest?.strategyDraftId, selectedDraft.id);
});

test("failed confirmation and rollback saves leave every stage audit unchanged", async () => {
  const value = await fixture();
  await prepareStrategyApproval(value);
  const source = await value.tasks.load(value.taskId);
  assert.ok(source);
  const failingStore: VideoTaskProductionStore = {
    async load() {
      return structuredClone(source);
    },
    async save() {
      throw new Error("simulated stage save failure");
    },
    async transact(_videoTaskId, update) {
      await update(structuredClone(source));
      throw new Error("simulated stage save failure");
    },
  };
  const failingRuntime = new VideoTaskStageRuntime(
    value.administration,
    value.projects,
    failingStore,
    () => "2026-08-19T16:35:00.000Z",
    (kind) => `${kind}_failing`,
  );

  await assert.rejects(
    failingRuntime.confirmStage(project.id, value.taskId, "strategy", {
      requestId: "request_failed_confirmation",
      expectedTaskRevision: 3,
    }, value.creator),
    /simulated stage save failure/u,
  );
  assert.equal(source.videoTask.revision, 3);
  assert.equal(source.stageArtifactVersions.length, 0);
  assert.equal(source.stageConfirmations.length, 0);
  assert.equal(source.stageMutationReceipts.length, 0);
  assert.deepEqual(await value.tasks.load(value.taskId), source);

  const rollbackValue = await fixture();
  const graph = await prepareRollbackGraph(rollbackValue);
  const rollbackSource = await rollbackValue.tasks.load(rollbackValue.taskId);
  assert.ok(rollbackSource);
  const failingRollbackStore: VideoTaskProductionStore = {
    async load() {
      return structuredClone(rollbackSource);
    },
    async save() {
      throw new Error("simulated rollback save failure");
    },
    async transact(_videoTaskId, update) {
      await update(structuredClone(rollbackSource));
      throw new Error("simulated rollback save failure");
    },
  };
  const failingRollbackRuntime = new VideoTaskStageRuntime(
    rollbackValue.administration,
    rollbackValue.projects,
    failingRollbackStore,
    () => "2026-08-19T16:36:00.000Z",
    (kind) => `${kind}_failing_rollback`,
  );
  await assert.rejects(
    failingRollbackRuntime.rollbackStage(
      project.id,
      rollbackValue.taskId,
      "strategy",
      {
        requestId: "request_failed_rollback",
        expectedTaskRevision: 8,
        targetArtifactVersionId: graph.strategyV1.id,
        reason: "模拟回退保存失败。",
      },
      rollbackValue.creator,
    ),
    /simulated rollback save failure/u,
  );
  assert.equal(rollbackSource.videoTask.revision, 8);
  assert.equal(rollbackSource.stageRollbacks.length, 0);
  assert.equal(rollbackSource.stageArtifactInvalidations.length, 0);
  assert.equal(rollbackSource.stageMutationReceipts.length, 1);
  assert.deepEqual(await rollbackValue.tasks.load(rollbackValue.taskId), rollbackSource);
});

test("temporary asset expiry during deferred metadata loading leaves confirmation atomic", async () => {
  const value = await fixture();
  await prepareAssetMatchingApproval(value);

  const checksumSha256 = "e".repeat(64);
  const localReference: AssetReference = {
    assetId: "temporary_scene_expiring_during_confirmation",
    version: 1,
    category: "scene",
    source: "local_upload",
    batchProjectId: project.id,
    checksumSha256,
  };
  const poolWithTemporaryAsset = await value.projects.transactAssetPool(
    tenantId,
    project.id,
    (current) => ({
      ...structuredClone(current),
      revision: current.revision + 1,
      assets: [...structuredClone(current.assets), structuredClone(localReference)],
      updatedAt: "2026-08-19T16:30:00.000Z",
      updatedBy: value.creator.actorAccountId,
    }),
  );
  const temporaryAsset: TemporaryAsset = {
    id: localReference.assetId,
    tenantId,
    batchProjectId: project.id,
    vehicleId,
    version: localReference.version,
    revision: 1,
    category: localReference.category,
    fileName: "expiring-scene.webp",
    mediaType: "image/webp",
    byteSize: 2048,
    width: 1920,
    height: 1080,
    checksumSha256,
    sourceDescription: "项目成员现场拍摄的场景素材",
    rightsDeclaration: "上传者确认拥有本项目广告制作所需授权",
    rightsConfirmed: true,
    validationStatus: "valid",
    validationIssues: [],
    expiresAt: "2026-08-19T16:31:00.000Z",
    createdAt: "2026-08-19T16:00:00.000Z",
    createdBy: value.creator.actorAccountId,
    updatedAt: "2026-08-19T16:20:00.000Z",
    updatedBy: value.creator.actorAccountId,
  };

  const loadStarted = deferredBarrier();
  const allowLoadToReturn = deferredBarrier();
  const deferredTemporaryStore = {
    async loadProject(batchProjectId: string): Promise<TemporaryAsset[]> {
      assert.equal(batchProjectId, project.id);
      loadStarted.release();
      await allowLoadToReturn.promise;
      return [structuredClone(temporaryAsset)];
    },
    async transactProject(): Promise<TemporaryAsset[]> {
      throw new Error("The deferred temporary asset fixture is read-only.");
    },
  };
  let currentTime = "2026-08-19T16:30:00.000Z";
  let sequence = 0;
  const projectAssets = new ProjectAssetRuntime(
    new MockCompanyAssetProvider(),
    new BatchProjectAssetPoolStoreAdapter(value.projects),
    () => currentTime,
    deferredTemporaryStore,
  );
  const stages = new VideoTaskStageRuntime(
    value.administration,
    value.projects,
    value.tasks,
    () => currentTime,
    (kind) => `${kind}_expiry_${++sequence}`,
    projectAssets,
  );
  const before = await value.tasks.load(value.taskId);
  assert.ok(before);

  const confirmation = stages.confirmStage(
    project.id,
    value.taskId,
    "asset_matching",
    {
      requestId: "request_expiring_temporary_asset_confirmation",
      expectedTaskRevision: before.videoTask.revision,
      assetSelection: {
        expectedProjectAssetPoolRevision: poolWithTemporaryAsset.revision,
        selectedAssets: [localReference],
      },
    },
    value.creator,
  );
  await completesWithin(loadStarted.promise, "temporary asset metadata load entry");
  currentTime = "2026-08-19T16:32:00.000Z";
  allowLoadToReturn.release();

  await assert.rejects(
    completesWithin(confirmation, "expired temporary asset confirmation rejection"),
    (error: unknown) =>
      error instanceof ProjectAssetRuntimeError &&
      error.code === "AIC-ASSET-TEMPORARY-REFERENCE-UNUSABLE",
  );
  const after = await value.tasks.load(value.taskId);
  assert.ok(after);
  assert.equal(after.videoTask.assetSnapshotId, before.videoTask.assetSnapshotId);
  assert.deepEqual(after.taskAssetSnapshots, before.taskAssetSnapshots);
  assert.deepEqual(after.stageConfirmations, before.stageConfirmations);
  assert.deepEqual(after.stageMutationReceipts, before.stageMutationReceipts);
  assert.deepEqual(after, before);
});
