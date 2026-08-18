import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ConfirmStageCommand, VideoTaskProductionRecord } from "@firefly/domain";
import { RevisionConflictError } from "@firefly/domain";

import { StageConfirmationRuntime } from "../src/stage-confirmation-runtime.ts";
import {
  LocalVideoTaskProductionStore,
  type VideoTaskProductionStore,
} from "../src/video-task-store.ts";

function productionRecord(): VideoTaskProductionRecord {
  return {
    schemaVersion: 1,
    videoTask: {
      id: "task_persisted",
      tenantId: "tenant_firefly",
      batchProjectId: "project_launch",
      name: "持久化测试任务",
      ownerAccountId: "account_owner",
      status: "active",
      currentStage: "strategy",
      stageStatus: "awaiting_confirmation",
      revision: 5,
      vehicleSnapshotId: "vehicle_snapshot_1",
      audience: "家庭用户",
      theme: "城市通勤",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-18T08:00:00.000Z",
      createdBy: "account_owner",
      updatedAt: "2026-08-18T09:00:00.000Z",
      updatedBy: "account_owner",
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
  };
}

const command: ConfirmStageCommand = {
  expectedTaskRevision: 5,
  stage: "strategy",
  artifact: {
    artifactId: "strategy_artifact_1",
    schemaName: "marketing_strategy",
    schemaVersion: 1,
    contentHashSha256: "b".repeat(64),
  },
  dependencies: [{ kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" }],
};

const session = {
  tenantId: "tenant_firefly",
  batchProjectId: "project_launch",
  actorAccountId: "account_owner",
};

test("confirmation persists the task, immutable version, and audit event in one record", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-store-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const firstStore = new LocalVideoTaskProductionStore(directory);
  await firstStore.save(productionRecord());
  const runtime = new StageConfirmationRuntime(
    firstStore,
    () => "2026-08-18T10:00:00.000Z",
    (kind) => (kind === "confirmation" ? "confirmation_1" : "artifact_version_1"),
  );

  const result = await runtime.confirmStage("task_persisted", command, session);
  assert.equal(result.videoTask.revision, 6);
  assert.equal(result.stageArtifactVersions.length, 1);
  assert.equal(result.stageConfirmations.length, 1);

  const restored = await new LocalVideoTaskProductionStore(directory).load("task_persisted");
  assert.deepEqual(restored, result);
  await assert.rejects(
    runtime.confirmStage("task_persisted", command, session),
    RevisionConflictError,
  );
  assert.deepEqual(await new LocalVideoTaskProductionStore(directory).load("task_persisted"), result);
  const persisted = JSON.parse(await readFile(join(directory, "task_persisted.json"), "utf8"));
  assert.equal(persisted.videoTask.revision, 6);
  assert.equal(persisted.stageArtifactVersions[0].id, "artifact_version_1");
  assert.equal(persisted.stageConfirmations[0].id, "confirmation_1");
});

test("a failed atomic save leaves the previously loaded aggregate unchanged", async () => {
  const original = productionRecord();
  const failingStore: VideoTaskProductionStore = {
    async load() {
      return structuredClone(original);
    },
    async save() {
      throw new Error("simulated disk failure");
    },
  };
  const runtime = new StageConfirmationRuntime(failingStore);

  await assert.rejects(
    runtime.confirmStage("task_persisted", command, session),
    /simulated disk failure/u,
  );
  assert.equal(original.videoTask.revision, 5);
  assert.equal(original.stageArtifactVersions.length, 0);
  assert.equal(original.stageConfirmations.length, 0);
});

test("store returns defensive copies so callers cannot mutate persisted versions", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-tasks", false);
  await store.save(productionRecord());
  const loaded = await store.load("task_persisted");
  assert.ok(loaded);
  loaded.videoTask.revision = 999;
  const loadedAgain = await store.load("task_persisted");
  assert.equal(loadedAgain?.videoTask.revision, 5);
});
