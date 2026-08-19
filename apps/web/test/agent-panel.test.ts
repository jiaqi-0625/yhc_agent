import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { agentBudgetPresentation, agentPanelWidthBounds, resolveAgentPanelWidth } from "../public/agent-panel.js";

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
