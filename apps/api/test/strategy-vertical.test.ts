import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";

import { LocalBusinessRuntime } from "../src/business-runtime.ts";
import { createBusinessAgentRuntime } from "../src/business-agent-runtime.ts";
import { LocalWorkStore } from "../src/business-store.ts";
import { startApiServer } from "../src/server.ts";

const testConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-sessions",
};

async function json(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

async function startBusinessApi(store = new LocalWorkStore(".data/test-works", false)) {
  const business = new LocalBusinessRuntime(store);
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(testConfig), business);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { business, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function createWork(baseUrl: string) {
  const response = await fetch(`${baseUrl}/v1/works`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      vehicleId: "vehicle_firefly_e5_2026_long_range",
      color: "萤火绿",
      region: "中国大陆",
      campaignDate: "2026-08-17",
    }),
  });
  assert.equal(response.status, 201);
  return json(response);
}

test("strategy vertical slice preserves human locks and requires a human approval decision", async (context) => {
  const { server, baseUrl } = await startBusinessApi();
  context.after(() => server.close());
  const created = await createWork(baseUrl);
  assert.equal(created.work.status, "created");
  assert.equal(created.work.revision, 1);
  assert.match(created.vehicleSnapshot.id, /^vs_/u);

  const generatedResponse = await fetch(`${baseUrl}/v1/works/${created.work.id}/strategy/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, audience: "有孩家庭", theme: "周末出行" }),
  });
  assert.equal(generatedResponse.status, 200);
  const generated = await json(generatedResponse);
  assert.equal(generated.work.status, "strategy_draft");
  assert.equal(generated.validation.valid, true);
  assert.ok(generated.strategy.items.some((item: { kind: string }) => item.kind === "fixed"));
  assert.ok(generated.strategy.items.some((item: { kind: string }) => item.kind === "extended"));

  const lockedItems = structuredClone(generated.strategy.items);
  lockedItems[0].locked = true;
  const savedResponse = await fetch(`${baseUrl}/v1/works/${created.work.id}/strategy`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: generated.work.revision,
      audience: generated.strategy.audience,
      theme: generated.strategy.theme,
      items: lockedItems,
    }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await json(savedResponse);
  assert.equal(saved.strategy.items[0].locked, true);

  const regeneratedResponse = await fetch(`${baseUrl}/v1/works/${created.work.id}/strategy/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: saved.work.revision, audience: "有孩家庭", theme: "露营出行" }),
  });
  assert.equal(regeneratedResponse.status, 200);
  const regenerated = await json(regeneratedResponse);
  assert.equal(regenerated.strategy.items[0].id, saved.strategy.items[0].id);
  assert.equal(regenerated.strategy.items[0].locked, true);
  assert.equal(regenerated.strategyVersionCount, 3);

  const staleResponse = await fetch(`${baseUrl}/v1/works/${created.work.id}/strategy/approval-request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await json(staleResponse)).code, "AIC-WORKFLOW-REVISION_CONFLICT");

  const requestResponse = await fetch(`${baseUrl}/v1/works/${created.work.id}/strategy/approval-request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: regenerated.work.revision }),
  });
  assert.equal(requestResponse.status, 200);
  const awaiting = await json(requestResponse);
  assert.equal(awaiting.work.status, "awaiting_strategy_approval");

  const blockedGeneration = await fetch(`${baseUrl}/v1/works/${created.work.id}/strategy/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: awaiting.work.revision, audience: "其他", theme: "其他" }),
  });
  assert.equal(blockedGeneration.status, 409);

  const decisionResponse = await fetch(`${baseUrl}/v1/works/${created.work.id}/strategy/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: awaiting.work.revision,
      decision: "approved",
      comment: "人工验收通过",
    }),
  });
  assert.equal(decisionResponse.status, 200);
  const approved = await json(decisionResponse);
  assert.equal(approved.work.status, "strategy_approved");
  assert.equal(approved.approvals[0].actorId, "reviewer_local");
  assert.equal(approved.approvals[0].decision, "approved");

  const listResponse = await fetch(`${baseUrl}/v1/works`);
  assert.equal(listResponse.status, 200);
  const listed = await json(listResponse);
  assert.equal(listed.works.length, 1);
  assert.equal(listed.works[0].work.id, created.work.id);
  assert.equal(listed.works[0].vehicle.series, "萤火 E5");
  assert.equal(listed.works[0].strategy.status, "approved");
  assert.equal("vehicleSnapshot" in listed.works[0], false);

  const copyResponse = await fetch(`${baseUrl}/v1/works/${created.work.id}/copy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: approved.work.revision }),
  });
  assert.equal(copyResponse.status, 201);
  const copied = await json(copyResponse);
  assert.notEqual(copied.work.id, created.work.id);
  assert.equal(copied.work.status, "created");
  assert.equal(copied.work.revision, 1);
  assert.equal(copied.vehicleSnapshot.id, approved.vehicleSnapshot.id);
  assert.equal(copied.strategyVersionCount, 0);

  const copiedList = await json(await fetch(`${baseUrl}/v1/works`));
  assert.equal(copiedList.works.length, 2);
  assert.equal(copiedList.works[0].work.id, copied.work.id);
});

test("copying is rejected for a work that has not passed strategy approval", async (context) => {
  const { server, baseUrl } = await startBusinessApi();
  context.after(() => server.close());
  const created = await createWork(baseUrl);
  const response = await fetch(`${baseUrl}/v1/works/${created.work.id}/copy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: created.work.revision }),
  });
  assert.equal(response.status, 409);
  assert.equal((await json(response)).code, "AIC-WORKFLOW-WORK_COPY_DENIED");
});

test("business work is restored independently from the Agent transcript", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "firefly-work-store-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const first = await startBusinessApi(new LocalWorkStore(directory, true));
  const created = await createWork(first.baseUrl);
  await new Promise<void>((resolve) => first.server.close(() => resolve()));

  const second = await startBusinessApi(new LocalWorkStore(directory, true));
  context.after(() => second.server.close());
  const response = await fetch(`${second.baseUrl}/v1/works/${created.work.id}`);
  assert.equal(response.status, 200);
  const restored = await json(response);
  assert.equal(restored.work.id, created.work.id);
  assert.equal(restored.vehicleSnapshot.id, created.vehicleSnapshot.id);
});

test("work-bound Agent sessions load only the advertising domain tools", async (context) => {
  const business = new LocalBusinessRuntime(new LocalWorkStore(".data/test-works", false));
  const runtime = createBusinessAgentRuntime(business, testConfig);
  const server = await startApiServer(0, "127.0.0.1", runtime, business);
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const created = await createWork(baseUrl);

  const missingResponse = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoTaskId: "work_missing" }),
  });
  assert.equal(missingResponse.status, 404);

  const createResponse = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "session_business_agent", videoTaskId: created.work.id }),
  });
  assert.equal(createResponse.status, 201);
  const sessionBody = await json(createResponse);
  assert.equal(sessionBody.session.videoTaskId, created.work.id);
  assert.equal(sessionBody.session.taskContext.videoTask.id, created.work.id);
  assert.equal(sessionBody.session.taskContext.videoTask.stageStatus, "in_progress");
  assert.equal("actorId" in sessionBody.session.taskContext, false);
  assert.equal("budgetRemaining" in sessionBody.session.taskContext, false);
  assert.equal(sessionBody.session.domainToolsLoaded, true);
  assert.deepEqual(sessionBody.session.toolNames, [
    "get_vehicle_snapshot",
    "validate_vehicle_claims",
    "propose_strategy_generation",
    "validate_strategy",
    "propose_strategy_approval",
  ]);
  assert.doesNotMatch(sessionBody.session.toolNames.join(","), /bash|shell|http|browser|approve_strategy/u);

  const promptResponse = await fetch(`${baseUrl}/v1/sessions/session_business_agent/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "检查当前作品工具" }),
  });
  assert.equal(promptResponse.status, 200);
  const prompt = await json(promptResponse);
  assert.match(prompt.assistantText, /已装配当前作品的 5 个受控业务工具/u);

  const meta = await json(await fetch(`${baseUrl}/v1/meta`));
  assert.equal(meta.agentDomainToolsLoaded, true);
});
