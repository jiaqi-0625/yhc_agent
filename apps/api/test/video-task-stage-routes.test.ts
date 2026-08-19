import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import type { WorkspaceSessionScope } from "@firefly/domain";
import type {
  ConfirmVideoTaskStageRequest,
  RollbackVideoTaskStageRequest,
  VideoTaskStage,
} from "@firefly/schemas";

import { sendJson, sendRequestError } from "../src/http-boundary.ts";
import {
  handleVideoTaskStageRoute,
  matchVideoTaskStagePath,
} from "../src/video-task-stage-routes.ts";
import {
  WorkspaceSessionRuntime,
  type WorkspaceAccessGrantProvider,
} from "../src/workspace-session-runtime.ts";
import { LocalWorkspaceSessionStore } from "../src/workspace-session-store.ts";

const projectId = "project_stage_routes";
const videoTaskId = "task_stage_routes";
const basePath =
  `/v1/workspace/batch-projects/${projectId}/video-tasks/${videoTaskId}`;
const stages = [
  "strategy",
  "asset_matching",
  "script",
  "storyboard",
  "video_preview",
  "delivery",
] as const satisfies readonly VideoTaskStage[];

type RuntimeCall =
  | {
      operation: "versions";
      projectId: string;
      videoTaskId: string;
      stage: VideoTaskStage;
      scope: WorkspaceSessionScope;
    }
  | {
      operation: "audit";
      projectId: string;
      videoTaskId: string;
      scope: WorkspaceSessionScope;
    }
  | {
      operation: "confirm";
      projectId: string;
      videoTaskId: string;
      stage: VideoTaskStage;
      input: ConfirmVideoTaskStageRequest;
      scope: WorkspaceSessionScope;
    }
  | {
      operation: "rollback";
      projectId: string;
      videoTaskId: string;
      stage: VideoTaskStage;
      input: RollbackVideoTaskStageRequest;
      scope: WorkspaceSessionScope;
    };

interface RouteFixture {
  server: Server;
  baseUrl: string;
  token: string;
  calls: RuntimeCall[];
}

async function routeFixture(): Promise<RouteFixture> {
  const grants: WorkspaceAccessGrantProvider = {
    async listForAccount() {
      return [];
    },
  };
  const sessions = new WorkspaceSessionRuntime(
    new LocalWorkspaceSessionStore(".data/test-video-task-stage-route-sessions", false),
    grants,
  );
  const session = await sessions.createSession("account_creator_a");
  const calls: RuntimeCall[] = [];
  const runtime = {
    async getStageVersions(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      stage: VideoTaskStage,
      scope: WorkspaceSessionScope,
    ) {
      calls.push({
        operation: "versions",
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        stage,
        scope: structuredClone(scope),
      });
      return { operation: "versions", stage };
    },
    async getStageAudit(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      scope: WorkspaceSessionScope,
    ) {
      calls.push({
        operation: "audit",
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        scope: structuredClone(scope),
      });
      return { operation: "audit" };
    },
    async confirmStage(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      stage: VideoTaskStage,
      input: ConfirmVideoTaskStageRequest,
      scope: WorkspaceSessionScope,
    ) {
      calls.push({
        operation: "confirm",
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        stage,
        input: structuredClone(input),
        scope: structuredClone(scope),
      });
      return { operation: "confirm", stage, requestId: input.requestId };
    },
    async rollbackStage(
      requestedProjectId: string,
      requestedVideoTaskId: string,
      stage: VideoTaskStage,
      input: RollbackVideoTaskStageRequest,
      scope: WorkspaceSessionScope,
    ) {
      calls.push({
        operation: "rollback",
        projectId: requestedProjectId,
        videoTaskId: requestedVideoTaskId,
        stage,
        input: structuredClone(input),
        scope: structuredClone(scope),
      });
      return { operation: "rollback", stage, requestId: input.requestId };
    },
  } as unknown as Parameters<typeof handleVideoTaskStageRoute>[3];

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (await handleVideoTaskStageRoute(request, response, url, runtime, sessions)) return;
        sendJson(response, 404, {
          code: "AIC-API-NOT_FOUND",
          message: "Endpoint not found.",
          retryable: false,
          charged: false,
        });
      } catch (error: unknown) {
        sendRequestError(response, error);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: session.sessionId,
    calls,
  };
}

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function jsonAuthorization(token: string): {
  authorization: string;
  "content-type": string;
} {
  return { ...authorization(token), "content-type": "application/json" };
}

test("stage route matcher accepts exactly the four frozen paths and all six stages", () => {
  for (const stage of stages) {
    assert.deepEqual(
      matchVideoTaskStagePath(`${basePath}/stages/${stage}/versions`),
      { kind: "versions", projectId, videoTaskId, stage },
    );
    assert.deepEqual(
      matchVideoTaskStagePath(`${basePath}/stages/${stage}/confirmations`),
      { kind: "confirmations", projectId, videoTaskId, stage },
    );
    assert.deepEqual(
      matchVideoTaskStagePath(`${basePath}/stages/${stage}/rollbacks`),
      { kind: "rollbacks", projectId, videoTaskId, stage },
    );
  }
  assert.deepEqual(matchVideoTaskStagePath(`${basePath}/stage-invalidations`), {
    kind: "audit",
    projectId,
    videoTaskId,
  });

  for (const pathname of [
    `${basePath}/stages/prompt/versions`,
    `${basePath}/stages/Strategy/versions`,
    `${basePath}/stages/strategy/version`,
    `${basePath}/stage-invalidations/extra`,
    `${basePath}/stages/strategy/confirmations/`,
  ]) {
    assert.equal(matchVideoTaskStagePath(pathname), undefined);
  }
});

test("stage queries require Bearer auth, reject query parameters, and forward exact scopes", async (context) => {
  const fixture = await routeFixture();
  context.after(() => fixture.server.close());
  const strategyVersions = `${fixture.baseUrl}${basePath}/stages/strategy/versions`;

  assert.equal((await fetch(strategyVersions)).status, 401);
  assert.equal(fixture.calls.length, 0);

  const queried = await fetch(`${strategyVersions}?tenantId=tenant_attacker`, {
    headers: authorization(fixture.token),
  });
  assert.equal(queried.status, 400);
  assert.equal(((await queried.json()) as { code: string }).code, "AIC-API-QUERY_INVALID");
  assert.equal(fixture.calls.length, 0);

  for (const stage of stages) {
    const response = await fetch(`${fixture.baseUrl}${basePath}/stages/${stage}/versions`, {
      headers: authorization(fixture.token),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { operation: "versions", stage });
  }
  const audit = await fetch(`${fixture.baseUrl}${basePath}/stage-invalidations`, {
    headers: authorization(fixture.token),
  });
  assert.equal(audit.status, 200);
  assert.deepEqual(await audit.json(), { operation: "audit" });

  assert.equal(fixture.calls.length, stages.length + 1);
  for (const [index, stage] of stages.entries()) {
    const call = fixture.calls[index];
    assert.ok(call && call.operation === "versions");
    assert.equal(call.projectId, projectId);
    assert.equal(call.videoTaskId, videoTaskId);
    assert.equal(call.stage, stage);
    assert.equal(call.scope.actorAccountId, "account_creator_a");
  }
  const auditCall = fixture.calls.at(-1);
  assert.ok(auditCall && auditCall.operation === "audit");
  assert.equal(auditCall.projectId, projectId);
  assert.equal(auditCall.videoTaskId, videoTaskId);
  assert.equal(auditCall.scope.actorAccountId, "account_creator_a");

  const invalidStage = await fetch(
    `${fixture.baseUrl}${basePath}/stages/prompt/versions`,
    { headers: authorization(fixture.token) },
  );
  assert.equal(invalidStage.status, 404);
  assert.equal(fixture.calls.length, stages.length + 1);
});

test("stage writes validate strict bodies and forward only path scope plus session identity", async (context) => {
  const fixture = await routeFixture();
  context.after(() => fixture.server.close());
  const confirmationUrl =
    `${fixture.baseUrl}${basePath}/stages/strategy/confirmations`;
  const rollbackUrl = `${fixture.baseUrl}${basePath}/stages/strategy/rollbacks`;
  const confirmInput = {
    requestId: "request_confirm_strategy",
    expectedTaskRevision: 7,
    comment: "人工验收通过。",
  } satisfies ConfirmVideoTaskStageRequest;
  const rollbackInput = {
    requestId: "request_rollback_strategy",
    expectedTaskRevision: 8,
    targetArtifactVersionId: "artifact_strategy_v1",
    reason: "恢复已审核的策略版本。",
  } satisfies RollbackVideoTaskStageRequest;

  assert.equal((await fetch(confirmationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmInput),
  })).status, 401);
  assert.equal(fixture.calls.length, 0);

  const confirmed = await fetch(confirmationUrl, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify(confirmInput),
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), {
    operation: "confirm",
    stage: "strategy",
    requestId: confirmInput.requestId,
  });

  const rolledBack = await fetch(rollbackUrl, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify(rollbackInput),
  });
  assert.equal(rolledBack.status, 200);
  assert.deepEqual(await rolledBack.json(), {
    operation: "rollback",
    stage: "strategy",
    requestId: rollbackInput.requestId,
  });

  assert.equal(fixture.calls.length, 2);
  const confirmCall = fixture.calls[0];
  assert.ok(confirmCall && confirmCall.operation === "confirm");
  assert.equal(confirmCall.projectId, projectId);
  assert.equal(confirmCall.videoTaskId, videoTaskId);
  assert.equal(confirmCall.stage, "strategy");
  assert.deepEqual(confirmCall.input, confirmInput);
  assert.equal(confirmCall.scope.actorAccountId, "account_creator_a");
  const rollbackCall = fixture.calls[1];
  assert.ok(rollbackCall && rollbackCall.operation === "rollback");
  assert.equal(rollbackCall.projectId, projectId);
  assert.equal(rollbackCall.videoTaskId, videoTaskId);
  assert.equal(rollbackCall.stage, "strategy");
  assert.deepEqual(rollbackCall.input, rollbackInput);
  assert.equal(rollbackCall.scope.actorAccountId, "account_creator_a");

  const forgedConfirmationFields = [
    { actorAccountId: "account_attacker" },
    { tenantId: "tenant_attacker" },
    { stage: "strategy" },
    { dependencies: [{ kind: "vehicle_snapshot", vehicleSnapshotId: "snapshot_forged" }] },
    { invalidationIds: ["invalidation_forged"] },
  ];
  for (const forged of forgedConfirmationFields) {
    const response = await fetch(confirmationUrl, {
      method: "POST",
      headers: jsonAuthorization(fixture.token),
      body: JSON.stringify({ ...confirmInput, ...forged }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, "AIC-API-SCHEMA_INVALID");
  }

  const forgedRollbackFields = [
    { actorAccountId: "account_attacker" },
    { tenantId: "tenant_attacker" },
    { stage: "strategy" },
    { dependencies: [{ kind: "stage_artifact", artifactVersionId: "artifact_forged" }] },
    { invalidationIds: ["invalidation_forged"] },
  ];
  for (const forged of forgedRollbackFields) {
    const response = await fetch(rollbackUrl, {
      method: "POST",
      headers: jsonAuthorization(fixture.token),
      body: JSON.stringify({ ...rollbackInput, ...forged }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, "AIC-API-SCHEMA_INVALID");
  }
  assert.equal(fixture.calls.length, 2);

  assert.equal((await fetch(`${rollbackUrl}?stage=delivery`, {
    method: "POST",
    headers: jsonAuthorization(fixture.token),
    body: JSON.stringify(rollbackInput),
  })).status, 400);
  assert.equal(fixture.calls.length, 2);
});
