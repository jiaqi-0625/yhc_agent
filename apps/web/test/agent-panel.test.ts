import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { agentActionAvailability, agentActionFailurePresentation, agentActionRequestBody, agentActionSuccessPresentation, agentActionTimelineEvent, agentBudgetPresentation, agentPanelWidthBounds, createAgentActionRequestId, createStableAgentActionRequestId, executeAgentActionCommand, extractAgentActionCard, parseAgentActionCard, reloadAgentWorkspaceConversation, reloadAgentWorkspaceSession, resolveAgentPanelWidth, strategyApprovalContinuationCard, unavailableAgentTaskMessage } from "../public/agent-panel.js";

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
  assert.equal(resolveAgentPanelWidth(1084, 380), 358);
  assert.equal(resolveAgentPanelWidth(1224, 560), 498);
  assert.equal(resolveAgentPanelWidth(1704, 560), 560);
  assert.equal(resolveAgentPanelWidth(1000, 380), 274);
  assert.deepEqual(agentPanelWidthBounds(1084), { minimum: 320, maximum: 358 });
});

test("Agent panel width clamps invalid saved widths", () => {
  assert.equal(resolveAgentPanelWidth(1704, 200), 320);
  assert.equal(resolveAgentPanelWidth(1704, 900), 560);
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

test("Agent task-not-found errors recover with a scoped workspace message", () => {
  const expected = "当前视频任务暂时无法由智能助手读取，已返回项目概览。请刷新项目库后重试；若任务仍存在，请检查工作区与助手是否使用同一数据源。";
  assert.equal(unavailableAgentTaskMessage({
    status: 404,
    code: "AIC-DATA-WORK_NOT_FOUND",
  }), expected);
  assert.equal(unavailableAgentTaskMessage({
    status: 404,
    code: "AIC-AGENT-VIDEO-TASK_NOT_FOUND",
  }), expected);
  assert.equal(unavailableAgentTaskMessage({
    status: 404,
    code: "AIC-API-NOT_FOUND",
  }), undefined);
  assert.equal(unavailableAgentTaskMessage({
    status: 409,
    code: "AIC-AGENT-VIDEO-TASK_NOT_FOUND",
  }), undefined);
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

test("Agent action execution sends only a request ID and the validated frozen card", () => {
  assert.match(createAgentActionRequestId(), /^agent_action_[A-Za-z0-9_-]+$/u);
  assert.deepEqual(agentActionRequestBody(generationCard, "agent_action_request_1"), {
    requestId: "agent_action_request_1",
    card: generationCard,
  });
  const approvalCard = {
    ...generationCard,
    action: "request_strategy_approval",
    label: "提交卖点策略人工审批",
    payload: { schemaVersion: 1 },
  };
  assert.deepEqual(agentActionRequestBody(approvalCard, "agent_action_request_2"), {
    requestId: "agent_action_request_2",
    card: approvalCard,
  });
  assert.throws(
    () => agentActionRequestBody({ ...generationCard, accountId: "account_forged" }, "agent_action_request_3"),
    /无法安全执行/u,
  );
  assert.throws(() => agentActionRequestBody(generationCard, "../request"), /无法安全执行/u);
});

test("Agent action request IDs remain stable when a task transcript is rebuilt", async () => {
  const first = await createStableAgentActionRequestId(
    "session_task_1",
    "tool_call_strategy_1",
    generationCard,
  );
  const rebuilt = await createStableAgentActionRequestId(
    "session_task_1",
    "tool_call_strategy_1",
    {
      payload: { theme: "周末出行", audience: "家庭用户", schemaVersion: 1 },
      cost: { kind: "free" },
      expectedRevision: 3,
      summary: "生成家庭出行策略。",
      label: "生成卖点策略草稿",
      action: "generate_strategy",
      videoTaskId: "task_1",
      kind: "agent_action_card",
      schemaVersion: 1,
    },
  );
  assert.equal(first, rebuilt);
  assert.match(first, /^agent_action_[a-f0-9]{64}$/u);
  assert.notEqual(
    first,
    await createStableAgentActionRequestId("session_task_2", "tool_call_strategy_1", generationCard),
  );
  assert.notEqual(
    first,
    await createStableAgentActionRequestId("session_task_1", "tool_call_strategy_2", generationCard),
  );
  assert.notEqual(
    first,
    await createStableAgentActionRequestId(
      "session_task_1",
      "tool_call_strategy_1",
      { ...generationCard, expectedRevision: 4 },
    ),
  );
});

test("Agent action command responses preserve replay and human-confirmation boundaries", () => {
  const response = {
    receipt: {
      schemaVersion: 1,
      id: "command_receipt_1",
      tenantId: "tenant_1",
      batchProjectId: "project_1",
      videoTaskId: "task_1",
      actorAccountId: "account_creator_a",
      requestId: "agent_action_request_1",
      payloadHash: "a".repeat(64),
      action: "generate_strategy",
      expectedTaskRevision: 3,
      resultingTaskRevision: 4,
      cost: { kind: "free", amountMinor: 0, charged: false },
      result: { kind: "strategy_generated", strategyDraftId: "strategy_draft_1" },
      occurredAt: "2026-08-20T00:00:00.000Z",
    },
    replayed: false,
    videoTask: { id: "task_1", tenantId: "tenant_1", batchProjectId: "project_1", revision: 4 },
  };
  assert.deepEqual(
    agentActionSuccessPresentation(
      generationCard,
      "agent_action_request_1",
      "project_1",
      "account_creator_a",
      response,
    ),
    {
      status: "已执行",
      message: "操作已由服务端执行。策略草稿已生成，任务版本更新至 4。",
      receiptId: "command_receipt_1",
      resultingRevision: 4,
      occurredAt: "2026-08-20T00:00:00.000Z",
      replayed: false,
    },
  );
  const approvalCard = {
    ...generationCard,
    action: "request_strategy_approval",
    label: "提交卖点策略人工审批",
    payload: { schemaVersion: 1 },
  };
  const replay = {
    ...response,
    replayed: true,
    receipt: {
      ...response.receipt,
      id: "command_receipt_2",
      requestId: "agent_action_request_2",
      action: "request_strategy_approval",
      result: {
        kind: "strategy_confirmation_requested",
        strategyDraftId: "strategy_draft_1",
        stageConfirmationRequestId: "confirmation_request_1",
      },
    },
  };
  const presentation = agentActionSuccessPresentation(
    approvalCard,
    "agent_action_request_2",
    "project_1",
    "account_creator_a",
    replay,
  );
  assert.equal(presentation.status, "已恢复");
  assert.match(presentation.message, /未重复执行/u);
  assert.match(presentation.message, /尚未确认/u);
  assert.doesNotMatch(presentation.message, /已确认/u);
});

test("Agent action success creates a stable non-authoritative timeline result event", () => {
  const event = agentActionTimelineEvent(generationCard, {
    status: "已执行",
    message: "操作已由服务端执行。策略草稿已生成，任务版本更新至 4。",
    receiptId: "command_receipt_1",
    resultingRevision: 4,
    occurredAt: "2026-08-20T00:00:00.000Z",
    replayed: false,
  });
  assert.deepEqual(event, {
    schemaVersion: 1,
    eventId: "action_result_command_receipt_1",
    type: "action_result",
    videoTaskId: "task_1",
    action: "generate_strategy",
    receiptId: "command_receipt_1",
    resultingRevision: 4,
    occurredAt: "2026-08-20T00:00:00.000Z",
    replayed: false,
    title: "策略草稿已生成",
    status: "执行成功",
    message: "操作已由服务端执行。策略草稿已生成，任务版本更新至 4。",
  });
  assert.throws(
    () => agentActionTimelineEvent(generationCard, { ...event, receiptId: "../forged" }),
    (error: unknown) => Boolean((error as { mayHaveExecuted?: boolean }).mayHaveExecuted),
  );
});

test("Agent action execution returns the validated timeline event with the command result", async () => {
  const response = {
    receipt: {
      schemaVersion: 1,
      id: "command_receipt_timeline_1",
      tenantId: "tenant_1",
      batchProjectId: "project_1",
      videoTaskId: "task_1",
      actorAccountId: "account_creator_a",
      requestId: "agent_action_timeline_1",
      payloadHash: "b".repeat(64),
      action: "generate_strategy",
      expectedTaskRevision: 3,
      resultingTaskRevision: 4,
      cost: { kind: "free", amountMinor: 0, charged: false },
      result: { kind: "strategy_generated", strategyDraftId: "strategy_draft_timeline_1" },
      occurredAt: "2026-08-20T01:00:00.000Z",
    },
    replayed: false,
    videoTask: { id: "task_1", tenantId: "tenant_1", batchProjectId: "project_1", revision: 4 },
  };
  const execution = await executeAgentActionCommand(
    generationCard,
    {
      projectId: "project_1",
      videoTaskId: "task_1",
      accountId: "account_creator_a",
    },
    "agent_action_timeline_1",
    false,
    async () => response,
  );
  assert.equal(execution.kind, "success");
  if (execution.kind !== "success") return;
  assert.equal(execution.timelineEvent.eventId, "action_result_command_receipt_timeline_1");
  assert.equal(execution.timelineEvent.type, "action_result");
  assert.equal(execution.timelineEvent.resultingRevision, 4);
  assert.match(execution.timelineEvent.message, /策略草稿已生成/u);
});

test("Agent action command responses reject mismatched receipts without inviting a duplicate", () => {
  assert.throws(
    () => agentActionSuccessPresentation(
      generationCard,
      "agent_action_request_1",
      "project_1",
      "account_creator_a",
      {
        receipt: {
          schemaVersion: 1,
          id: "command_receipt_1",
          tenantId: "tenant_1",
          batchProjectId: "project_other",
          videoTaskId: "task_1",
          actorAccountId: "account_creator_a",
          requestId: "agent_action_request_1",
          payloadHash: "a".repeat(64),
          action: "generate_strategy",
          expectedTaskRevision: 3,
          resultingTaskRevision: 4,
          cost: { kind: "free", amountMinor: 0, charged: false },
          result: { kind: "strategy_generated", strategyDraftId: "strategy_draft_1" },
          occurredAt: "2026-08-20T00:00:00.000Z",
        },
        replayed: false,
        videoTask: { id: "task_1", tenantId: "tenant_1", batchProjectId: "project_1", revision: 4 },
      },
    ),
    (error: unknown) => Boolean((error as { mayHaveExecuted?: boolean }).mayHaveExecuted),
  );
});

test("Agent action command responses bind receipt metadata to the current account and tenant", () => {
  const valid = {
    receipt: {
      schemaVersion: 1,
      id: "command_receipt_1",
      tenantId: "tenant_1",
      batchProjectId: "project_1",
      videoTaskId: "task_1",
      actorAccountId: "account_creator_a",
      requestId: "agent_action_request_1",
      payloadHash: "a".repeat(64),
      action: "generate_strategy",
      expectedTaskRevision: 3,
      resultingTaskRevision: 4,
      cost: { kind: "free", amountMinor: 0, charged: false },
      result: { kind: "strategy_generated", strategyDraftId: "strategy_draft_1" },
      occurredAt: "2026-08-20T00:00:00.000Z",
    },
    replayed: false,
    videoTask: { id: "task_1", tenantId: "tenant_1", batchProjectId: "project_1", revision: 4 },
  };
  for (const invalid of [
    { ...valid, receipt: { ...valid.receipt, actorAccountId: "account_other" } },
    { ...valid, videoTask: { ...valid.videoTask, tenantId: "tenant_other" } },
    { ...valid, receipt: { ...valid.receipt, payloadHash: "not-a-hash" } },
    { ...valid, receipt: { ...valid.receipt, occurredAt: "not-a-date" } },
    { ...valid, receipt: { ...valid.receipt, internalDetail: "should-not-exist" } },
  ]) {
    assert.throws(
      () => agentActionSuccessPresentation(
        generationCard,
        "agent_action_request_1",
        "project_1",
        "account_creator_a",
        invalid,
      ),
      (error: unknown) => Boolean((error as { mayHaveExecuted?: boolean }).mayHaveExecuted),
    );
  }
});

test("workspace conversation reload reads session context and transcript together", async () => {
  const calls: string[] = [];
  const session = { id: "agent_session_sync", taskContext: { videoTask: { id: "task_sync" } } };
  const messages = [{ role: "assistant", content: "下一步内容" }];
  const result = await reloadAgentWorkspaceConversation({
    async getSession(sessionId: string, videoTaskId: string) {
      calls.push(`session:${sessionId}:${videoTaskId}`);
      return { session };
    },
    async getTranscript(sessionId: string, videoTaskId: string) {
      calls.push(`transcript:${sessionId}:${videoTaskId}`);
      return { messages };
    },
  }, "agent_session_sync", "task_sync");
  assert.deepEqual(calls.sort(), [
    "session:agent_session_sync:task_sync",
    "transcript:agent_session_sync:task_sync",
  ]);
  assert.equal(result.session, session);
  assert.equal(result.messages, messages);
});

test("workspace session reload avoids repainting an unchanged transcript", async () => {
  let transcriptCalls = 0;
  const session = { id: "agent_session_sync", taskContext: { videoTask: { id: "task_sync" } } };
  const result = await reloadAgentWorkspaceSession({
    getSession: async () => ({ session }),
    getTranscript: async () => { transcriptCalls += 1; return { messages: [] }; },
  }, "agent_session_sync", "task_sync");
  assert.equal(result, session);
  assert.equal(transcriptCalls, 0);
});

test("a server-visible strategy draft produces the next approval card without another user message", () => {
  const task = {
    id: "task_sync", revision: 2, currentStage: "strategy", stageStatus: "in_progress",
  };
  const card = strategyApprovalContinuationCard(task, {
    activeStrategyDraft: { id: "strategy_draft_1" },
  });
  assert.equal(parseAgentActionCard(card)?.action, "request_strategy_approval");
  assert.equal(card?.expectedRevision, 2);
  assert.equal(strategyApprovalContinuationCard(task, {
    activeStrategyDraft: { id: "strategy_draft_1" },
    confirmationRequest: { id: "confirmation_request_1" },
  }), null);
  assert.equal(strategyApprovalContinuationCard({ ...task, currentStage: "script" }, {
    activeStrategyDraft: { id: "strategy_draft_1" },
  }), null);
});

test("application wiring keeps action commands task-scoped and disabled during Agent runs", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function currentAgentActionContext()");
  const end = source.indexOf("function appendActionProposal(", start);
  assert.ok(start >= 0 && end > start);
  const commandWiring = source.slice(start, end);
  assert.match(commandWiring, /currentSelectedVideoTaskId\(\) !== context\.videoTask\.id/u);
  assert.match(commandWiring, /state\.busy[\s\S]*\|\| state\.workflowBusy/u);
  assert.match(commandWiring, /context\.scopeGeneration !== expectedContext\.scopeGeneration/u);
  assert.match(commandWiring, /function isCurrentAgentActionContext\(expectedContext\)/u);
  assert.match(commandWiring, /if \(!isCurrentAgentActionContext\(context\)\) return;/u);
  assert.match(commandWiring, /createStableAgentActionRequestId/u);
  assert.match(commandWiring, /if \(activeAgentActionExecution === execution\)/u);
  assert.match(commandWiring, /response\.videoTask\.revision < context\.revision/u);
  assert.match(commandWiring, /executeAgentActionCommand/u);
  assert.match(commandWiring, /appendActionResultTimelineEvent\(card, commandExecution\.timelineEvent\)/u);
  assert.match(commandWiring, /card\.dataset\.executionBlocked === "true"/u);
  assert.match(commandWiring, /card\.dataset\.executed === "true"/u);
  assert.doesNotMatch(commandWiring, /\/v1\/works\//u);
  assert.match(source, /state\.busy \|\| state\.workflowBusy, card\.dataset\.executionBlocked/u);
  assert.match(source, /appendActionProposal\(turn, proposal, event\.toolCallId\)/u);
  assert.match(source, /appendActionProposal\(turn, event\.card, event\.eventId\)/u);

  const controlsStart = source.indexOf("function refreshAgentInteractionControls()");
  const controlsEnd = source.indexOf("function captureWorkspaceScope()", controlsStart);
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart);
  const interactionWiring = source.slice(controlsStart, controlsEnd);
  assert.match(
    interactionWiring,
    /const interactionBusy = state\.busy \|\| state\.workflowBusy \|\| workspaceStagesPanel\?\.isBusy\(\);/u,
  );
  assert.match(interactionWiring, /elements\.prompt\.disabled = interactionBusy/u);
  assert.match(interactionWiring, /elements\.send\.disabled = interactionBusy/u);
  assert.match(interactionWiring, /elements\.newSession\.disabled = interactionBusy/u);
  assert.match(interactionWiring, /elements\.sessionSelect\.disabled = interactionBusy/u);
  assert.match(interactionWiring, /"正在准备任务会话"/u);
  assert.match(interactionWiring, /"输入消息，与当前视频任务协作"/u);
  assert.equal(interactionWiring.match(/refreshAgentInteractionControls\(\);/gu)?.length, 2);

  const sendStart = source.indexOf("async function sendMessage(");
  const sendEnd = source.indexOf("bindAgentPanel({", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart);
  assert.match(
    source.slice(sendStart, sendEnd),
    /if \(!message \|\| state\.busy \|\| state\.workflowBusy \|\| !state\.sessionId\) return;/u,
  );
  const messageWiring = source.slice(sendStart, sendEnd);
  assert.match(messageWiring, /const scope = captureWorkspaceScope\(\)/u);
  assert.match(messageWiring, /const sessionId = state\.sessionId/u);
  assert.match(messageWiring, /const videoTaskId = state\.sessionVideoTaskId/u);
  assert.match(messageWiring, /if \(!isCurrentTurn\(\)\) return;/u);
  assert.match(messageWiring, /assertWorkspaceAgentSession\(result\.session, videoTaskId, state\.projectLibrary\)/u);

  const syncStart = source.indexOf("async function synchronizeAgentWorkspaceSelection(");
  const syncEnd = source.indexOf("function applyWorkspaceSession(", syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart);
  const workspaceSync = source.slice(syncStart, syncEnd);
  assert.match(workspaceSync, /workspaceScopeGeneration \+= 1/u);
  assert.match(workspaceSync, /state\.sessionId = null/u);
  assert.match(workspaceSync, /state\.taskContext = null/u);
  assert.match(workspaceSync, /restoreSessionForCurrentWork\(scope\)/u);
  assert.match(workspaceSync, /refreshAgentContextForWorkspaceTask\(selection\.task\)/u);
  assert.match(workspaceSync, /reloadAgentWorkspaceSession\(agentApi, sessionId, task\.id\)/u);
  assert.match(workspaceSync, /appendWorkspaceTaskSyncEvent\(task\)/u);
  assert.match(source, /synchronizeAgentWorkflowContinuation\(body\.session\.taskContext\?\.videoTask\)/u);
  assert.match(source, /await synchronizeAgentWorkflowContinuation\(state\.taskContext\?\.videoTask\)/u);
  assert.match(source, /无需再向 Agent 发送“已确认”/u);
  assert.doesNotMatch(workspaceSync, /restoreTranscriptTimeline\(refreshed\.messages\)/u);
  assert.match(workspaceSync, /refreshed\.taskContext\.videoTask\.revision < task\.revision/u);
  assert.match(source, /void synchronizeAgentWorkspaceSelection\(selection\)/u);
  assert.match(
    source,
    /isSelectionLocked: function \(\) \{ return state\.busy \|\| state\.workflowBusy \|\| workspaceStagesPanel\?\.isBusy\(\); \}/u,
  );
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
  assert.deepEqual(agentActionAvailability(generationCard, "task_1", 3, false, true), {
    enabled: false,
    stale: false,
    reason: "该卡片已被服务端拒绝，请按提示处理后重新获取建议。",
  });
});

test("Agent action failures give recoverable business guidance and block stale resubmission", () => {
  const cases: Array<[string, string, RegExp, boolean, boolean]> = [
    ["AIC-WORKFLOW-REVISION_CONFLICT", "已失效", /刷新任务/u, true, true],
    ["AIC-AUTH-TASK_OWNER_REQUIRED", "无执行权限", /任务归属|接管/u, true, false],
    ["AIC-COST-BUDGET_EXCEEDED", "额度不足", /调整额度/u, true, false],
    ["AIC-CONCURRENCY-ACCOUNT_HIGH_COST_TASK_RUNNING", "任务繁忙", /等待/u, true, false],
    ["AIC-WORKFLOW-STAGE_CONFLICT", "状态冲突", /重新获取建议/u, true, true],
  ];
  for (const [code, status, message, blocksCard, stale] of cases) {
    const presentation = agentActionFailurePresentation({ code });
    assert.equal(presentation.status, status);
    assert.match(presentation.message, message);
    assert.equal(presentation.blocksCard, blocksCard);
    assert.equal(presentation.stale, stale);
    assert.doesNotMatch(presentation.message, /AIC-/u);
  }
});

test("Agent action authentication failures distinguish login, session scope, ownership, and grants", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["AIC-AUTH-SESSION_REQUIRED", "登录已失效", /重新登录|切换/u],
    ["AIC-AUTH-SESSION_HEADER_INVALID", "登录已失效", /重新登录|切换/u],
    ["AIC-AUTH-SESSION_INVALID", "登录已失效", /重新登录|切换/u],
    ["AIC-AUTH-SESSION_SCOPE_REQUIRED", "会话不匹配", /账号.*任务会话/u],
    ["AIC-AUTH-SESSION_SCOPE_DENIED", "会话不匹配", /账号.*任务会话/u],
    ["AIC-AUTH-TASK_OWNER_REQUIRED", "无执行权限", /任务归属|接管/u],
    ["AIC-AUTH-PROJECT_SCOPE_DENIED", "权限不足", /有权限的账号|管理员/u],
    ["AIC-AUTH-ROLE_DENIED", "权限不足", /有权限的账号|管理员/u],
  ];
  for (const [code, status, message] of cases) {
    const presentation = agentActionFailurePresentation({ code, message: "raw server detail" });
    assert.equal(presentation.status, status);
    assert.match(presentation.message, message);
    assert.equal(presentation.blocksCard, true);
    assert.equal(presentation.stale, false);
    assert.doesNotMatch(presentation.message, /AIC-|raw server detail/u);
  }
});

test("Agent action command failures block deterministic retries without exposing technical details", () => {
  const cases: Array<[string, string, RegExp, boolean]> = [
    ["AIC-AGENT-COMMAND-IDEMPOTENCY_CONFLICT", "请求冲突", /核对原操作结果.*不要.*重复提交/u, false],
    ["AIC-AGENT-COMMAND-SCOPE_INVALID", "任务不可用", /刷新任务列表/u, true],
    ["AIC-AGENT-COMMAND-PROJECT_NOT_FOUND", "任务不可用", /刷新任务列表/u, true],
    ["AIC-AGENT-COMMAND-TASK_NOT_FOUND", "任务不可用", /刷新任务列表/u, true],
    ["AIC-AGENT-COMMAND-STATE_CONFLICT", "状态冲突", /重新获取建议/u, true],
    ["AIC-AGENT-COMMAND-SNAPSHOT_INVALID", "任务数据需刷新", /刷新任务/u, true],
    ["AIC-AGENT-COMMAND-ASSET_SNAPSHOT_INVALID", "任务数据需刷新", /刷新任务/u, true],
    ["AIC-AGENT-COMMAND-SNAPSHOT_MIGRATION_REQUIRED", "任务数据需刷新", /数据迁移/u, true],
    ["AIC-AGENT-COMMAND-STRATEGY_FACTS_INVALID", "策略需重新检查", /重新生成|检查策略/u, true],
    ["AIC-AGENT-COMMAND-STRATEGY_DRAFT_NOT_FOUND", "策略需重新检查", /重新生成|检查策略/u, true],
    ["AIC-AGENT-COMMAND-STRATEGY_VALIDATION_FAILED", "策略需重新检查", /重新生成|检查策略/u, true],
    ["AIC-STAGE-ROLLBACK-DENIED", "回退不可执行", /重新选择/u, true],
  ];
  for (const [code, status, message, stale] of cases) {
    const presentation = agentActionFailurePresentation({ code, message: "internal raw failure" });
    assert.equal(presentation.status, status);
    assert.match(presentation.message, message);
    assert.equal(presentation.blocksCard, true);
    assert.equal(presentation.stale, stale);
    assert.doesNotMatch(presentation.message, /AIC-|internal raw failure|JSON/u);
  }
});

test("Agent action failures never invite a duplicate when the server reports a charge", () => {
  assert.deepEqual(agentActionFailurePresentation({ mayHaveExecuted: true }), {
    status: "结果待确认",
    message: "服务端已返回结果，但页面无法安全核验。为避免重复执行，请刷新任务并核对最新状态。",
    blocksCard: true,
    stale: false,
  });
  assert.deepEqual(agentActionFailurePresentation({
    code: "AIC-PROVIDER-UNKNOWN_RESULT",
    charged: true,
  }), {
    status: "结果待确认",
    message: "服务端提示本次操作可能已产生费用。为避免重复执行，请先刷新任务并核对结果。",
    blocksCard: true,
    stale: false,
  });
  assert.deepEqual(agentActionFailurePresentation(new Error("fetch failed")), {
    status: "执行失败",
    message: "网络或服务暂时不可用，请稍后手动重试。",
    blocksCard: false,
    stale: false,
  });
  assert.deepEqual(agentActionFailurePresentation({
    code: "AIC-AGENT-COMMAND-RUNTIME_NOT_CONFIGURED",
    message: "internal runtime detail",
  }), {
    status: "操作未完成",
    message: "服务端未能完成这项操作，请刷新任务并按最新状态重新获取建议。",
    blocksCard: true,
    stale: false,
  });
});

test("Agent action HTTP business failures surface card states and block a second command", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const actionContext = {
    projectId: "project_1",
    videoTaskId: "task_1",
    accountId: "account_creator_a",
  };
  const cases: Array<[string, string]> = [
    ["AIC-WORKFLOW-REVISION_CONFLICT", "已失效"],
    ["AIC-AUTH-TASK_OWNER_REQUIRED", "无执行权限"],
    ["AIC-COST-BUDGET_EXCEEDED", "额度不足"],
    ["AIC-AGENT-COMMAND-STATE_CONFLICT", "状态冲突"],
  ];
  for (const [code, expectedStatus] of cases) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({
        code,
        message: "internal server detail",
        retryable: false,
        charged: false,
      }, { status: 409 });
    }) as typeof fetch;
    const first = await executeAgentActionCommand(
      generationCard,
      actionContext,
      "agent_action_http_failure",
    );
    assert.equal(first.kind, "failure");
    if (first.kind !== "failure") continue;
    assert.equal(first.presentation.status, expectedStatus);
    assert.equal(first.presentation.blocksCard, true);
    assert.doesNotMatch(first.presentation.message, /AIC-|internal server detail/u);

    const second = await executeAgentActionCommand(
      generationCard,
      actionContext,
      first.requestId,
      first.presentation.blocksCard,
    );
    assert.deepEqual(second, {
      kind: "blocked",
      requestId: "agent_action_http_failure",
    });
    assert.equal(calls, 1);
  }
});

test("Agent action transport failure retries only explicitly and reuses its request ID", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestIds: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    requestIds.push((JSON.parse(String(init?.body)) as { requestId: string }).requestId);
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const actionContext = {
    projectId: "project_1",
    videoTaskId: "task_1",
    accountId: "account_creator_a",
  };
  const first = await executeAgentActionCommand(
    generationCard,
    actionContext,
    "agent_action_transport_retry",
  );
  assert.equal(first.kind, "failure");
  if (first.kind !== "failure") return;
  assert.equal(first.presentation.blocksCard, false);
  assert.equal(requestIds.length, 1);

  const explicitRetry = await executeAgentActionCommand(
    generationCard,
    actionContext,
    first.requestId,
    first.presentation.blocksCard,
  );
  assert.equal(explicitRetry.kind, "failure");
  assert.deepEqual(requestIds, [
    "agent_action_transport_retry",
    "agent_action_transport_retry",
  ]);
});
