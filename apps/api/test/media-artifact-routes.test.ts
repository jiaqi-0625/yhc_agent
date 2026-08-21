import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";

import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { sendJson, sendRequestError } from "../src/http-boundary.ts";
import { handleMediaArtifactRoute } from "../src/media-artifact-routes.ts";
import {
  MediaArtifactRuntimeError,
  type MediaArtifactRuntime,
} from "../src/media-artifact-runtime.ts";
import { startApiServer } from "../src/server.ts";
import {
  WorkspaceSessionRuntime,
  type WorkspaceAccessGrantProvider,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const projectId = "project_media_route";
const videoTaskId = "task_media_route";
const artifactId = "artifact_media_route";
const path =
  `/v1/workspace/batch-projects/${projectId}/video-tasks/${videoTaskId}` +
  `/media-artifacts/${artifactId}/access`;

const agentConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-media-route-agent",
};

function baseUrl(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function sessions(suffix: string): Promise<{
  runtime: WorkspaceSessionRuntime;
  token: string;
}> {
  const grants: WorkspaceAccessGrantProvider = {
    async listForAccount() {
      return [];
    },
  };
  const runtime = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(`.data/test-media-route-sessions-${suffix}`, false),
    grants,
  );
  const session = await runtime.createSession("account_creator_a");
  return { runtime, token: session.sessionId };
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

test("media access route requires Bearer, validates a strict body, and returns no-store", async (context) => {
  const auth = await sessions("strict");
  let accessCount = 0;
  const runtime = {
    async createAccess(
      receivedProjectId: string,
      receivedTaskId: string,
      receivedArtifactId: string,
      purpose: string,
    ) {
      accessCount += 1;
      assert.deepEqual(
        [receivedProjectId, receivedTaskId, receivedArtifactId, purpose],
        [projectId, videoTaskId, artifactId, "playback"],
      );
      return {
        artifact: {
          schemaVersion: 1,
          id: artifactId,
          tenantId: "tenant_firefly",
          batchProjectId: projectId,
          videoTaskId,
          stage: "video_preview",
          role: "preview",
          version: 1,
          mediaType: "video/mp4",
          byteSize: 4096,
          checksumSha256: "a".repeat(64),
          width: 1920,
          height: 1080,
          durationMs: 30_000,
          createdAt: "2026-08-20T09:00:00.000Z",
          createdBy: "account_creator_a",
        },
        access: {
          method: "GET",
          url: "https://media.example.test/object?signature=temporary",
          expiresAt: "2026-08-20T09:05:00.000Z",
        },
      };
    },
  } as unknown as MediaArtifactRuntime;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    void handleMediaArtifactRoute(request, response, url, runtime, auth.runtime)
      .then((handled) => {
        if (!handled) sendJson(response, 404, { code: "not_found" });
      })
      .catch((error: unknown) => sendRequestError(response, error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => closeServer(server));
  const url = baseUrl(server);

  const anonymous = await fetch(`${url}${path}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ purpose: "playback" }),
  });
  assert.equal(anonymous.status, 401);
  assert.equal(accessCount, 0);

  for (const body of [
    {},
    { purpose: "stream" },
    { purpose: "playback", tenantId: "tenant_other" },
  ]) {
    const invalid = await fetch(`${url}${path}`, {
      method: "POST",
      headers: jsonHeaders(auth.token),
      body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
  }
  assert.equal(accessCount, 0);

  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: jsonHeaders(auth.token),
    body: JSON.stringify({ purpose: "playback" }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as Record<string, unknown>;
  assert.equal(accessCount, 1);
  const serialized = JSON.stringify(body);
  assert.match(serialized, /"method":"GET"/u);
  assert.doesNotMatch(serialized, /bucket|objectKey|objectVersion/iu);

  const query = await fetch(`${url}${path}?tenantId=tenant_other`, {
    method: "POST",
    headers: jsonHeaders(auth.token),
    body: JSON.stringify({ purpose: "playback" }),
  });
  assert.equal(query.status, 400);
  assert.equal(accessCount, 1);
});

test("media runtime errors keep storage provider details out of HTTP responses", async (context) => {
  const auth = await sessions("sanitized");
  const runtime = {
    async createAccess() {
      throw new MediaArtifactRuntimeError(
        "AIC-MEDIA-ARTIFACT-ACCESS_UNAVAILABLE",
        "Media artifact access is temporarily unavailable.",
        503,
        true,
      );
    },
  } as unknown as MediaArtifactRuntime;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    void handleMediaArtifactRoute(request, response, url, runtime, auth.runtime)
      .catch((error: unknown) => sendRequestError(response, error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => closeServer(server));

  const response = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: jsonHeaders(auth.token),
    body: JSON.stringify({ purpose: "download" }),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.match(body, /AIC-MEDIA-ARTIFACT-ACCESS_UNAVAILABLE/u);
  assert.match(body, /"retryable":true/u);
  assert.doesNotMatch(body, /bucket|object|credential|endpoint|signature/iu);
});

test("matched media access path fails closed when object storage runtime is disabled", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-media-route-disabled-"));
  const auth = await sessions("disabled");
  const server = await startApiServer(
    0,
    "127.0.0.1",
    new LocalAgentRuntime(agentConfig),
    new LocalBusinessRuntime(),
    undefined,
    auth.runtime,
    true,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    join(directory, "migrations"),
  );
  context.after(async () => {
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: jsonHeaders(auth.token),
    body: JSON.stringify({ purpose: "playback" }),
  });
  assert.equal(response.status, 503);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "AIC-MEDIA-ARTIFACT-RUNTIME_NOT_CONFIGURED",
  );
});
