import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";

import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { LocalWorkStore } from "../src/business-store.ts";
import { startApiServer } from "../src/server.ts";
import {
  InMemoryWorkspaceAccessGrantProvider,
  WorkspaceSessionRuntime,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";
import { WorkspaceMigrationStateStore } from "../src/workspace-migration-state.ts";

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "firefly-legacy-write-guard-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function writeManifest(
  migrationDirectory: string,
  migrationId: string,
  status: "in_progress" | "completed",
): Promise<void> {
  const state = new WorkspaceMigrationStateStore(migrationDirectory);
  const path = state.manifestPath(migrationId);
  await mkdir(join(state.directory, migrationId), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    migrationId,
    status,
  })}\n`, "utf8");
}

function agentConfig(root: string): LocalAgentConfig {
  return {
    provider: "mock",
    modelId: "mock-local",
    baseUrl: "local://mock",
    thinkingLevel: "off",
    persistSessions: false,
    dataDirectory: join(root, "agent-sessions"),
  };
}

async function startServer(
  root: string,
  business: LocalBusinessRuntime,
  migrationDirectory: string,
): Promise<Server> {
  const workspaceSessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(join(root, "workspace-sessions"), false),
    new InMemoryWorkspaceAccessGrantProvider(),
  );
  return startApiServer(
    0,
    "127.0.0.1",
    new LocalAgentRuntime(agentConfig(root)),
    business,
    undefined,
    workspaceSessions,
    true,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    migrationDirectory,
  );
}

function baseUrl(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("startApiServer fails closed while any migration manifest remains in progress", async (context) => {
  const root = await temporaryDirectory(context);
  const migrationDirectory = join(root, "migration-state");
  await writeManifest(migrationDirectory, "migration_interrupted", "in_progress");
  const business = new LocalBusinessRuntime(
    new LocalWorkStore(join(root, "legacy-works"), true),
  );

  await assert.rejects(
    startServer(root, business, migrationDirectory),
    /Workspace migration is incomplete \(migration_interrupted\)/u,
  );
});

test("a completed migration keeps legacy GETs readable and makes every legacy write return 410", async (context) => {
  const root = await temporaryDirectory(context);
  const migrationDirectory = join(root, "migration-state");
  await writeManifest(migrationDirectory, "migration_completed", "completed");
  const business = new LocalBusinessRuntime(
    new LocalWorkStore(join(root, "legacy-works"), true),
  );
  const created = await business.createWork({
    vehicleId: "vehicle_firefly_e5_2026_long_range",
    color: "萤火绿",
    region: "中国大陆",
    campaignDate: "2026-08-19",
  });
  const server = await startServer(root, business, migrationDirectory);
  context.after(async () => {
    await closeServer(server);
  });
  const url = baseUrl(server);

  const listResponse = await fetch(`${url}/v1/works`);
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()) as { works: Array<{ work: { id: string } }> };
  assert.deepEqual(list.works.map(({ work }) => work.id), [created.work.id]);

  const detailResponse = await fetch(`${url}/v1/works/${created.work.id}`);
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()) as { work: { id: string; revision: number } };
  assert.deepEqual(detail.work, { ...created.work });

  const writes: Array<{ method: string; path: string }> = [
    { method: "POST", path: "/v1/works" },
    { method: "POST", path: `/v1/works/${created.work.id}/copy` },
    { method: "POST", path: `/v1/works/${created.work.id}/strategy/generate` },
    { method: "PATCH", path: `/v1/works/${created.work.id}/strategy` },
    { method: "POST", path: `/v1/works/${created.work.id}/strategy/approval-request` },
    { method: "POST", path: `/v1/works/${created.work.id}/strategy/decision` },
    { method: "PUT", path: `/v1/works/${created.work.id}` },
    { method: "DELETE", path: `/v1/works/${created.work.id}` },
  ];
  for (const write of writes) {
    const response = await fetch(`${url}${write.path}`, {
      method: write.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 410, `${write.method} ${write.path}`);
    assert.deepEqual(await response.json(), {
      code: "AIC-LEGACY-WORK-MIGRATED_READ_ONLY",
      message: "Legacy works are read-only after the Workspace V2 migration.",
      retryable: false,
      charged: false,
    });
  }

  const unrelatedResponse = await fetch(`${url}/v1/worksheets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(unrelatedResponse.status, 404);
  assert.equal(
    ((await unrelatedResponse.json()) as { code: string }).code,
    "AIC-API-NOT_FOUND",
  );

  const after = await business.listWorks();
  assert.equal(after.length, 1);
  assert.equal(after[0]?.work.id, created.work.id);
  assert.equal(after[0]?.work.revision, created.work.revision);
});
