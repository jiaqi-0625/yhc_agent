import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VideoTaskProductionRecord } from "@firefly/domain";

import {
  LocalVideoTaskProductionStore,
  type VideoTaskCreationMetadata,
} from "../src/video-task-store.ts";

function record(
  id = "task_launch_hero",
  name = "首发主片",
  tenantId = "tenant_firefly",
  batchProjectId = "project_e5_launch",
): VideoTaskProductionRecord {
  return {
    schemaVersion: 4,
    videoTask: {
      id,
      tenantId,
      batchProjectId,
      name,
      ownerAccountId: "account_creator",
      status: "active",
      currentStage: "strategy",
      stageStatus: "in_progress",
      revision: 1,
      audience: "城市家庭用户",
      theme: "夏季上市",
      durationSeconds: 30,
      platformTags: ["douyin"],
      createdAt: "2026-08-19T08:00:00.000Z",
      createdBy: "account_creator",
      updatedAt: "2026-08-19T08:00:00.000Z",
      updatedBy: "account_creator",
    },
    stageArtifactVersions: [],
    stageConfirmations: [],
    activeStageArtifactVersionIds: {},
    stageRollbacks: [],
    stageArtifactInvalidations: [],
    ownershipTransfers: [],
    taskAssetSnapshots: [],
  };
}

function metadata(
  requestId = "request_create_task",
  payloadHash = "payload_hash_v1",
): VideoTaskCreationMetadata {
  return { requestId, actorAccountId: "account_creator", payloadHash };
}

function transactionLockDirectory(directory: string): string {
  const digest = createHash("sha256").update("task:task_launch_hero").digest("hex");
  return join(directory, ".locks", `${digest}.lock`);
}

test("video task store creates, scopes, sorts, and returns defensive copies", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-task-create", false);
  const first = await store.create(record(), metadata());
  const secondInput = record("task_launch_cut", "首发短片");
  await store.create(secondInput, metadata("request_create_cut"));
  await store.create(
    record("task_other_project", "其他项目", "tenant_firefly", "project_other"),
    metadata("request_other_project"),
  );
  await store.create(
    record("task_other_tenant", "其他租户", "tenant_other", "project_e5_launch"),
    metadata("request_other_tenant"),
  );

  first.videoTask.name = "attacker mutation";
  const listed = await store.list("tenant_firefly", "project_e5_launch");
  assert.deepEqual(
    listed.map(({ videoTask }) => videoTask.id),
    ["task_launch_cut", "task_launch_hero"],
  );
  listed[0]!.videoTask.name = "list mutation";
  assert.equal((await store.load("task_launch_cut"))?.videoTask.name, "首发短片");
  assert.equal((await store.list("tenant_firefly")).length, 3);
  assert.equal((await store.list("tenant_missing")).length, 0);
});

test("creation metadata makes concurrent requests replay-safe and rejects conflicts", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-task-idempotency", false);
  const firstCandidate = record("task_generated_first");
  const replayCandidate = record("task_generated_replay", "重试生成的不同名称");
  const creation = metadata("request_idempotent", "payload_hash_original");
  const [first, replay] = await Promise.all([
    store.create(firstCandidate, creation),
    store.create(replayCandidate, creation),
  ]);

  assert.deepEqual(replay, first);
  assert.equal((await store.list("tenant_firefly", "project_e5_launch")).length, 1);
  await assert.rejects(
    store.create(record("task_conflict"), metadata("request_idempotent", "different_hash")),
    /conflicts with a different payload/u,
  );
});

test("task IDs and normalized names cannot overwrite an existing aggregate", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-task-duplicates", false);
  await store.create(record(), metadata());
  await assert.rejects(
    store.create(
      record("task_launch_hero", "其他租户同 ID", "tenant_other"),
      metadata("request_cross_tenant"),
    ),
    /same ID already exists/u,
  );
  await assert.rejects(
    store.create(
      record("task_duplicate_name", "  首发主片  "),
      metadata("request_duplicate_name"),
    ),
    /same name already exists/u,
  );
  await assert.doesNotReject(
    store.create(
      record("task_same_name_other_project", "首发主片", "tenant_firefly", "project_other"),
      metadata("request_same_name_other_project"),
    ),
  );
});

test("creation idempotency and internal metadata survive restart and later transactions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-create-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const input = record();
  const creation = metadata("request_restart", "payload_hash_restart");
  await new LocalVideoTaskProductionStore(directory).create(input, creation);

  const raw = JSON.parse(await readFile(join(directory, `${input.videoTask.id}.json`), "utf8")) as {
    _creation?: VideoTaskCreationMetadata;
  };
  assert.deepEqual(raw._creation, creation);
  const restarted = new LocalVideoTaskProductionStore(directory);
  assert.deepEqual(
    await restarted.create(record("task_retry_after_restart"), creation),
    input,
  );
  await restarted.transact(input.videoTask.id, (current) => {
    assert.ok(current);
    return {
      ...current,
      videoTask: { ...current.videoTask, revision: 2 },
    };
  });
  const afterTransaction = JSON.parse(
    await readFile(join(directory, `${input.videoTask.id}.json`), "utf8"),
  ) as { _creation?: VideoTaskCreationMetadata };
  assert.deepEqual(afterTransaction._creation, creation);
  assert.equal((await restarted.load(input.videoTask.id))?.videoTask.revision, 2);
  assert.equal("_creation" in (await restarted.load(input.videoTask.id))!, false);
});

test("independent store instances atomically allow only one create for the same task ID", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-exclusive-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const attempts = await Promise.allSettled([
    new LocalVideoTaskProductionStore(directory).create(record(), metadata("request_first")),
    new LocalVideoTaskProductionStore(directory).create(record(), metadata("request_second")),
  ]);

  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(
    (await new LocalVideoTaskProductionStore(directory).list("tenant_firefly")).length,
    1,
  );
});

test("independent store instances replay one deterministic task for the same creation request", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-cross-store-replay-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const creation = metadata("request_shared", "payload_hash_shared");
  const attempts = await Promise.all([
    new LocalVideoTaskProductionStore(directory).create(record(), creation),
    new LocalVideoTaskProductionStore(directory).create(record(), creation),
  ]);

  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(
    (await new LocalVideoTaskProductionStore(directory).list("tenant_firefly")).length,
    1,
  );
});

test("independent store instances reject a conflicting payload for the same request", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-cross-store-conflict-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const attempts = await Promise.allSettled([
    new LocalVideoTaskProductionStore(directory).create(
      record(),
      metadata("request_shared", "payload_hash_first"),
    ),
    new LocalVideoTaskProductionStore(directory).create(
      record(),
      metadata("request_shared", "payload_hash_second"),
    ),
  ]);

  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = attempts.find(({ status }) => status === "rejected");
  assert.equal(rejected?.status, "rejected");
  assert.match(String(rejected.reason), /conflicts with a different payload/u);
  assert.equal(
    (await new LocalVideoTaskProductionStore(directory).list("tenant_firefly")).length,
    1,
  );
});

test("independent store transactions serialize one revision and preserve its ownership audit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-cross-store-transaction-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await new LocalVideoTaskProductionStore(directory).create(record(), metadata());
  const firstStore = new LocalVideoTaskProductionStore(directory);
  const secondStore = new LocalVideoTaskProductionStore(directory);
  await Promise.all([
    firstStore.load("task_launch_hero"),
    secondStore.load("task_launch_hero"),
  ]);
  const updateOwner = (actor: string) => {
    const selectedStore = actor === "account_first" ? firstStore : secondStore;
    return selectedStore.transact(
      "task_launch_hero",
      (current) => {
        assert.ok(current);
        if (current.videoTask.revision !== 1) throw new Error("revision conflict");
        return {
          ...current,
          videoTask: {
            ...current.videoTask,
            ownerAccountId: actor,
            revision: 2,
            updatedBy: actor,
          },
          ownershipTransfers: [
            ...current.ownershipTransfers,
            {
              id: `transfer_${actor}`,
              tenantId: current.videoTask.tenantId,
              batchProjectId: current.videoTask.batchProjectId,
              videoTaskId: current.videoTask.id,
              fromOwnerAccountId: current.videoTask.ownerAccountId,
              toOwnerAccountId: actor,
              expectedTaskRevision: 1,
              reason: "concurrent assignment",
              source: "human_action" as const,
              actorAccountId: actor,
              occurredAt: "2026-08-19T09:00:00.000Z",
            },
          ],
        };
      },
    );
  };
  const attempts = await Promise.allSettled([
    updateOwner("account_first"),
    updateOwner("account_second"),
  ]);

  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const persisted = await new LocalVideoTaskProductionStore(directory).load("task_launch_hero");
  assert.equal(persisted?.videoTask.revision, 2);
  assert.equal(persisted?.ownershipTransfers.length, 1);
  assert.equal(persisted?.ownershipTransfers[0]?.toOwnerAccountId, persisted?.videoTask.ownerAccountId);
});

test("concurrent stores safely recover empty, damaged, and expired-owner lock directories", async () => {
  const lockOptions = {
    timeoutMilliseconds: 2_000,
    leaseMilliseconds: 200,
    heartbeatMilliseconds: 50,
  };
  for (const staleKind of ["empty", "damaged", "expired_owner"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `firefly-video-task-${staleKind}-lock-`));
    try {
      await new LocalVideoTaskProductionStore(directory, true, lockOptions).create(
        record(),
        metadata(),
      );
      const lockDirectory = transactionLockDirectory(directory);
      await mkdir(lockDirectory, { recursive: true });
      if (staleKind === "damaged") {
        await writeFile(join(lockDirectory, "damaged.owner"), "broken", "utf8");
      }
      if (staleKind === "expired_owner") {
        const ownerPath = join(
          lockDirectory,
          `${process.pid}.00000000-0000-4000-8000-000000000001.owner`,
        );
        await writeFile(ownerPath, "", "utf8");
        const expired = new Date(Date.now() - 5_000);
        await utimes(ownerPath, expired, expired);
      }
      const stores = [
        new LocalVideoTaskProductionStore(directory, true, lockOptions),
        new LocalVideoTaskProductionStore(directory, true, lockOptions),
      ];
      const attempts = await Promise.allSettled(
        stores.map((store, index) =>
          store.transact("task_launch_hero", (current) => {
            assert.ok(current);
            if (current.videoTask.revision !== 1) throw new Error("revision conflict");
            return {
              ...current,
              videoTask: {
                ...current.videoTask,
                revision: 2,
                updatedBy: `account_${index}`,
              },
            };
          }),
        ),
      );
      assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
      assert.equal(
        (await new LocalVideoTaskProductionStore(directory).load("task_launch_hero"))?.videoTask
          .revision,
        2,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("an active owner heartbeat prevents lease theft during a long transaction", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-heartbeat-lock-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const lockOptions = {
    timeoutMilliseconds: 2_000,
    leaseMilliseconds: 200,
    heartbeatMilliseconds: 50,
  };
  await new LocalVideoTaskProductionStore(directory, true, lockOptions).create(
    record(),
    metadata(),
  );
  const firstStore = new LocalVideoTaskProductionStore(directory, true, lockOptions);
  const secondStore = new LocalVideoTaskProductionStore(directory, true, lockOptions);
  let releaseFirst = (): void => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let enteredFirst = (): void => undefined;
  const firstEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  const first = firstStore.transact("task_launch_hero", async (current) => {
    assert.ok(current);
    enteredFirst();
    await firstGate;
    return { ...current, videoTask: { ...current.videoTask, revision: 2 } };
  });
  await firstEntered;
  const lockDirectory = transactionLockDirectory(directory);
  const [ownerName] = await readdir(lockDirectory);
  assert.ok(ownerName);
  const ownerPath = join(lockDirectory, ownerName);
  const initialMtime = (await stat(ownerPath)).mtimeMs;
  let secondSettled = false;
  const second = secondStore
    .transact("task_launch_hero", (current) => {
      assert.ok(current);
      if (current.videoTask.revision !== 1) throw new Error("revision conflict");
      return { ...current, videoTask: { ...current.videoTask, revision: 2 } };
    })
    .finally(() => {
      secondSettled = true;
    });
  await new Promise<void>((resolve) => setTimeout(resolve, 320));
  assert.equal(secondSettled, false);
  assert.ok((await stat(ownerPath)).mtimeMs > initialMtime);
  releaseFirst();
  const attempts = await Promise.allSettled([first, second]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
});

test("a transaction that loses its owner token is fenced before persistence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-lost-lock-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const lockOptions = {
    timeoutMilliseconds: 2_000,
    leaseMilliseconds: 200,
    heartbeatMilliseconds: 50,
  };
  await new LocalVideoTaskProductionStore(directory, true, lockOptions).create(
    record(),
    metadata(),
  );
  const staleStore = new LocalVideoTaskProductionStore(directory, true, lockOptions);
  const winnerStore = new LocalVideoTaskProductionStore(directory, true, lockOptions);
  let releaseStale = (): void => undefined;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  let enteredStale = (): void => undefined;
  const staleEntered = new Promise<void>((resolve) => {
    enteredStale = resolve;
  });
  const stale = staleStore.transact("task_launch_hero", async (current) => {
    assert.ok(current);
    enteredStale();
    await staleGate;
    return {
      ...current,
      videoTask: { ...current.videoTask, revision: 2, updatedBy: "account_stale" },
    };
  });
  await staleEntered;

  // Simulate a reaper taking the expired lease while the original callback is paused.
  await rm(transactionLockDirectory(directory), { recursive: true, force: true });
  const winner = await winnerStore.transact("task_launch_hero", (current) => {
    assert.ok(current);
    return {
      ...current,
      videoTask: { ...current.videoTask, revision: 2, updatedBy: "account_winner" },
    };
  });
  assert.equal(winner.videoTask.updatedBy, "account_winner");

  releaseStale();
  await assert.rejects(stale, /transaction lock was lost/u);
  const persisted = await new LocalVideoTaskProductionStore(directory).load("task_launch_hero");
  assert.equal(persisted?.videoTask.revision, 2);
  assert.equal(persisted?.videoTask.updatedBy, "account_winner");
});

test("listing ignores temporary and non-JSON files but fails closed on invalid persisted scope", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-video-task-list-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new LocalVideoTaskProductionStore(directory);
  await store.create(record(), metadata());
  await writeFile(join(directory, "orphan.json.123.tmp"), "not json", "utf8");
  await writeFile(join(directory, "README.txt"), "not json", "utf8");
  assert.equal((await new LocalVideoTaskProductionStore(directory).list("tenant_firefly")).length, 1);

  const invalid = record("task_invalid_scope");
  invalid.stageArtifactVersions.push({
    id: "artifact_strategy_1",
    tenantId: "tenant_attacker",
    batchProjectId: invalid.videoTask.batchProjectId,
    videoTaskId: invalid.videoTask.id,
    stage: "strategy",
    version: 1,
    content: {
      artifactId: "strategy_content_1",
      schemaName: "marketing_strategy",
      schemaVersion: 1,
      contentHashSha256: "a".repeat(64),
    },
    dependencies: [{ kind: "vehicle_snapshot", vehicleSnapshotId: "vehicle_snapshot_1" }],
    provenance: { kind: "legacy_inferred", migrationId: "migration_1", note: "fixture" },
    createdAt: "2026-08-19T08:00:00.000Z",
    createdBy: "account_creator",
  });
  await writeFile(
    join(directory, "task_invalid_scope.json"),
    `${JSON.stringify(invalid)}\n`,
    "utf8",
  );
  await assert.rejects(
    new LocalVideoTaskProductionStore(directory).list("tenant_firefly"),
    /invalid format or scope/u,
  );
});

test("save and transact preserve task identity and tenant/project scope", async () => {
  const store = new LocalVideoTaskProductionStore(".data/test-video-task-scope", false);
  await store.create(record(), metadata());
  await assert.rejects(
    store.save(record("task_launch_hero", "cross tenant", "tenant_attacker")),
    /cannot change the aggregate scope/u,
  );
  await assert.rejects(
    store.transact("task_launch_hero", (current) => ({
      ...current!,
      videoTask: { ...current!.videoTask, batchProjectId: "project_attacker" },
    })),
    /cannot change the aggregate scope/u,
  );
  await assert.rejects(
    store.transact("task_launch_hero", (current) => ({
      ...current!,
      videoTask: { ...current!.videoTask, id: "task_attacker" },
    })),
    /cannot change the aggregate identity/u,
  );
});
