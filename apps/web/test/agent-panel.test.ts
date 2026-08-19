import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { agentActionAvailability, agentActionRequestBody, agentBudgetPresentation, agentPanelWidthBounds, extractAgentActionCard, parseAgentActionCard, resolveAgentPanelWidth } from "../public/agent-panel.js";

const generationCard = {
  schemaVersion: 1,
  kind: "agent_action_card",
  videoTaskId: "task_1",
  action: "generate_strategy",
  label: "生成卖点策略草稿",
  summary: "生成家庭出行策略。",
  expectedRevision: 3,
  cost: { kind: "free" },
  payload: { schemaVersion: 1, audience: "家庭用户", theme: "周末出行" },
};

test("Agent panel width preserves the desktop workspace minimums", () => {
  assert.equal(resolveAgentPanelWidth(1280, 380), 380);
  assert.equal(resolveAgentPanelWidth(1280, 560), 474);
  assert.equal(resolveAgentPanelWidth(1920, 560), 560);
  assert.equal(resolveAgentPanelWidth(1180, 560), 474);
  assert.equal(resolveAgentPanelWidth(1000, 380), 294);
  assert.deepEqual(agentPanelWidthBounds(1280), { minimum: 320, maximum: 474 });
});

test("Agent panel width clamps invalid saved widths", () => {
  assert.equal(resolveAgentPanelWidth(1920, 200), 320);
  assert.equal(resolveAgentPanelWidth(1920, 900), 560);
});

test("Agent quota presentation uses the authenticated account balance", () => {
  assert.deepEqual(agentBudgetPresentation({
    accountId: "account_creator_a",
    currency: "CNY",
    balance: {
      limitAmountMinor: 50_000,
      spentAmountMinor: 12_000,
      reservedAmountMinor: 3_000,
      availableAmountMinor: 35_000,
      currency: "CNY",
    },
  }, "account_creator_a"), {
    text: "可用额度 ¥350.00 · 已用 ¥120.00 · 预留 ¥30.00",
    title: "账号总额度 ¥500.00；可用 ¥350.00；已用 ¥120.00；预留 ¥30.00。",
  });
  assert.deepEqual(agentBudgetPresentation(undefined, "account_creator_a"), {
    text: "额度：当前账号未配置",
    title: "管理员尚未为当前账号配置制作额度。",
  });
});

test("Agent quota presentation rejects another account or inconsistent balances", () => {
  const budget = {
    accountId: "account_creator_b",
    currency: "CNY",
    balance: {
      limitAmountMinor: 50_000,
      spentAmountMinor: 10_000,
      reservedAmountMinor: 0,
      availableAmountMinor: 40_000,
      currency: "CNY",
    },
  };
  assert.throws(() => agentBudgetPresentation(budget, "account_creator_a"), /当前账号不一致/u);
  assert.throws(() => agentBudgetPresentation({
    ...budget,
    accountId: "account_creator_a",
    balance: { ...budget.balance, availableAmountMinor: 39_999 },
  }, "account_creator_a"), /当前账号不一致/u);
});

test("Agent action cards require the exact frozen structure before rendering", () => {
  assert.deepEqual(parseAgentActionCard(generationCard), generationCard);
  assert.deepEqual(extractAgentActionCard({
    content: [{ type: "text", text: JSON.stringify(generationCard) }],
  }), generationCard);
  for (const invalid of [
    { ...generationCard, actorAccountId: "account_forged" },
    { ...generationCard, videoTaskId: "../task_other" },
    { ...generationCard, cost: { kind: "free", amount: 0 } },
    { ...generationCard, payload: { ...generationCard.payload, tenantId: "tenant_forged" } },
    { ...generationCard, action: "approve_strategy", label: "批准策略" },
    { ...generationCard, action: "rollback_stage", label: "回退已确认阶段版本" },
  ]) {
    assert.equal(parseAgentActionCard(invalid), undefined);
  }
});

test("Agent action execution sends only allowlisted payload fields", () => {
  assert.deepEqual(agentActionRequestBody(generationCard), {
    audience: "家庭用户",
    theme: "周末出行",
    expectedRevision: 3,
  });
  assert.deepEqual(agentActionRequestBody({
    ...generationCard,
    action: "request_strategy_approval",
    payload: { schemaVersion: 1 },
  }), { expectedRevision: 3 });
});

test("Agent action cards stay disabled for missing, cross-task, stale, and busy contexts", () => {
  assert.deepEqual(agentActionAvailability(generationCard, undefined, undefined), {
    enabled: false,
    stale: true,
    reason: "当前未绑定作品。",
  });
  assert.equal(agentActionAvailability(generationCard, "task_other", 3).enabled, false);
  assert.match(agentActionAvailability(generationCard, "task_other", 3).reason ?? "", /其他视频任务/u);
  assert.equal(agentActionAvailability(generationCard, "task_1", 4).enabled, false);
  assert.match(agentActionAvailability(generationCard, "task_1", 4).reason ?? "", /已经更新/u);
  assert.deepEqual(agentActionAvailability(generationCard, "task_1", 3, true), {
    enabled: false,
    stale: false,
  });
  assert.deepEqual(agentActionAvailability(generationCard, "task_1", 3), {
    enabled: true,
    stale: false,
  });
});
