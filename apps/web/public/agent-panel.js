import { agentApi } from "./agent-api.js";

const supportedActionLabels = {
  generate_strategy: "生成卖点策略草稿",
  request_strategy_approval: "提交卖点策略人工审批",
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isActionCost(value) {
  if (!isRecord(value)) return false;
  if (value.kind === "free" || value.kind === "estimate_required") {
    return hasExactKeys(value, ["kind"]);
  }
  return value.kind === "estimated"
    && hasExactKeys(value, ["kind", "amount", "currency"])
    && typeof value.amount === "number"
    && Number.isFinite(value.amount)
    && value.amount >= 0
    && typeof value.currency === "string"
    && /^[A-Z]{3}$/u.test(value.currency);
}

function isSupportedPayload(action, payload) {
  if (action === "generate_strategy") {
    return hasExactKeys(payload, ["schemaVersion", "audience", "theme"])
      && payload.schemaVersion === 1
      && typeof payload.audience === "string"
      && payload.audience.trim().length > 0
      && typeof payload.theme === "string"
      && payload.theme.trim().length > 0;
  }
  return action === "request_strategy_approval"
    && hasExactKeys(payload, ["schemaVersion"])
    && payload.schemaVersion === 1;
}

export function parseAgentActionCard(candidate) {
  if (
    !hasExactKeys(candidate, [
      "schemaVersion",
      "kind",
      "videoTaskId",
      "action",
      "label",
      "summary",
      "expectedRevision",
      "cost",
      "payload",
    ])
    || candidate.schemaVersion !== 1
    || candidate.kind !== "agent_action_card"
    || !isIdentifier(candidate.videoTaskId)
    || supportedActionLabels[candidate.action] !== candidate.label
    || typeof candidate.summary !== "string"
    || candidate.summary.length < 1
    || candidate.summary.length > 2_000
    || !Number.isSafeInteger(candidate.expectedRevision)
    || candidate.expectedRevision < 1
    || !isActionCost(candidate.cost)
    || !isSupportedPayload(candidate.action, candidate.payload)
  ) return undefined;
  return structuredClone(candidate);
}

export function extractAgentActionCard(value) {
  const candidates = [value, isRecord(value) ? value.details : undefined];
  if (isRecord(value) && Array.isArray(value.content)) {
    value.content.forEach(function (part) {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return;
      try { candidates.push(JSON.parse(part.text)); } catch {}
    });
  }
  for (const candidate of candidates) {
    const parsed = parseAgentActionCard(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

export function createAgentActionRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return "agent_action_" + globalThis.crypto.randomUUID();
  }
  return "agent_action_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function createStableAgentActionRequestId(sessionId, sourceId, proposal) {
  const card = parseAgentActionCard(proposal);
  if (
    !isIdentifier(sessionId)
    || !isIdentifier(sourceId)
    || !card
    || !globalThis.crypto?.subtle
    || typeof globalThis.TextEncoder !== "function"
  ) {
    throw new Error("无法为这张智能助手操作卡片生成稳定请求标识。");
  }
  const bytes = new TextEncoder().encode(canonicalJson({
    sessionId,
    sourceId,
    videoTaskId: card.videoTaskId,
    action: card.action,
    expectedRevision: card.expectedRevision,
    payload: card.payload,
  }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return `agent_action_${hex}`;
}

export function agentActionRequestBody(proposal, requestId) {
  const card = parseAgentActionCard(proposal);
  if (!card || !isIdentifier(requestId)) {
    throw new Error("无法安全执行这张智能助手操作卡片。");
  }
  return { requestId, card };
}

function uncertainCommandResponse() {
  const error = new Error("服务端返回的操作结果无法安全核验。");
  error.mayHaveExecuted = true;
  return error;
}

function matchesCommandResult(action, result) {
  if (!isRecord(result)) return false;
  if (action === "generate_strategy") {
    return hasExactKeys(result, ["kind", "strategyDraftId"])
      && result.kind === "strategy_generated"
      && isIdentifier(result.strategyDraftId);
  }
  return action === "request_strategy_approval"
    && hasExactKeys(result, ["kind", "strategyDraftId", "stageConfirmationRequestId"])
    && result.kind === "strategy_confirmation_requested"
    && isIdentifier(result.strategyDraftId)
    && isIdentifier(result.stageConfirmationRequestId);
}

function isIsoDateTime(value) {
  return typeof value === "string"
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function agentActionSuccessPresentation(proposal, requestId, projectId, accountId, response) {
  const parsedCard = parseAgentActionCard(proposal);
  const receipt = isRecord(response) ? response.receipt : undefined;
  const videoTask = isRecord(response) ? response.videoTask : undefined;
  if (
    !parsedCard
    || !isIdentifier(requestId)
    || !isIdentifier(projectId)
    || !isIdentifier(accountId)
    || !hasExactKeys(response, ["receipt", "replayed", "videoTask"])
    || !isRecord(receipt)
    || !isRecord(videoTask)
    || typeof response.replayed !== "boolean"
    || !hasExactKeys(receipt, [
      "schemaVersion",
      "id",
      "tenantId",
      "batchProjectId",
      "videoTaskId",
      "actorAccountId",
      "requestId",
      "payloadHash",
      "action",
      "expectedTaskRevision",
      "resultingTaskRevision",
      "cost",
      "result",
      "occurredAt",
    ])
    || receipt.schemaVersion !== 1
    || !isIdentifier(receipt.id)
    || !isIdentifier(receipt.tenantId)
    || receipt.actorAccountId !== accountId
    || receipt.requestId !== requestId
    || receipt.batchProjectId !== projectId
    || receipt.videoTaskId !== parsedCard.videoTaskId
    || receipt.action !== parsedCard.action
    || receipt.expectedTaskRevision !== parsedCard.expectedRevision
    || receipt.resultingTaskRevision !== parsedCard.expectedRevision + 1
    || typeof receipt.payloadHash !== "string"
    || !/^[A-Fa-f0-9]{64}$/u.test(receipt.payloadHash)
    || !isIsoDateTime(receipt.occurredAt)
    || !isRecord(receipt.cost)
    || !hasExactKeys(receipt.cost, ["kind", "amountMinor", "charged"])
    || receipt.cost.kind !== "free"
    || receipt.cost.amountMinor !== 0
    || receipt.cost.charged !== false
    || !matchesCommandResult(parsedCard.action, receipt.result)
    || videoTask.id !== parsedCard.videoTaskId
    || videoTask.batchProjectId !== projectId
    || videoTask.tenantId !== receipt.tenantId
    || !Number.isSafeInteger(videoTask.revision)
    || videoTask.revision < receipt.resultingTaskRevision
  ) {
    throw uncertainCommandResponse();
  }
  const replayPrefix = response.replayed ? "已恢复此前操作结果，未重复执行。" : "操作已由服务端执行。";
  if (parsedCard.action === "generate_strategy") {
    return {
      status: response.replayed ? "已恢复" : "已执行",
      message: replayPrefix + "策略草稿已生成，任务版本更新至 " + receipt.resultingTaskRevision + "。",
      receiptId: receipt.id,
      resultingRevision: videoTask.revision,
      replayed: response.replayed,
    };
  }
  return {
    status: response.replayed ? "已恢复" : "已提交",
    message: replayPrefix + "人工确认请求已提交，当前阶段尚未确认；任务版本更新至 " + receipt.resultingTaskRevision + "。",
    receiptId: receipt.id,
    resultingRevision: videoTask.revision,
    replayed: response.replayed,
  };
}

export function agentActionAvailability(
  proposal,
  currentVideoTaskId,
  currentRevision,
  busy = false,
  executionBlocked = false,
) {
  if (!currentVideoTaskId || !Number.isSafeInteger(currentRevision)) {
    return { enabled: false, stale: true, reason: "当前未绑定作品。" };
  }
  if (proposal.videoTaskId !== currentVideoTaskId) {
    return { enabled: false, stale: true, reason: "该卡片属于其他视频任务，请切回对应任务或重新获取建议。" };
  }
  if (proposal.expectedRevision !== currentRevision) {
    return { enabled: false, stale: true, reason: "任务内容已经更新，请重新获取操作建议。" };
  }
  if (executionBlocked) {
    return { enabled: false, stale: false, reason: "该卡片已被服务端拒绝，请按提示处理后重新获取建议。" };
  }
  return { enabled: !busy, stale: false };
}

export function unavailableAgentTaskMessage(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  if (
    error?.status !== 404 ||
    ![
      "AIC-DATA-WORK_NOT_FOUND",
      "AIC-AGENT-VIDEO-TASK_NOT_FOUND",
    ].includes(code)
  ) return undefined;
  return "当前视频任务暂时无法由智能助手读取，已返回项目概览。请刷新项目库后重试；若任务仍存在，请检查工作区与助手是否使用同一数据源。";
}

export function agentActionFailurePresentation(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  const charged = Boolean(error && error.charged);
  if (error && error.mayHaveExecuted) {
    return {
      status: "结果待确认",
      message: "服务端已返回结果，但页面无法安全核验。为避免重复执行，请刷新任务并核对最新状态。",
      blocksCard: true,
      stale: false,
    };
  }
  const invalidSessionCodes = new Set([
    "AIC-AUTH-SESSION_REQUIRED",
    "AIC-AUTH-SESSION_HEADER_INVALID",
    "AIC-AUTH-SESSION_INVALID",
    "AIC-AUTH-DEVELOPMENT_ACCOUNT_NOT_FOUND",
  ]);
  const mismatchedSessionCodes = new Set([
    "AIC-AUTH-SESSION_SCOPE_REQUIRED",
    "AIC-AUTH-SESSION_SCOPE_DENIED",
  ]);
  const unavailableTaskCodes = new Set([
    "AIC-AGENT-COMMAND-SCOPE_INVALID",
    "AIC-AGENT-COMMAND-PROJECT_NOT_FOUND",
    "AIC-AGENT-COMMAND-TASK_NOT_FOUND",
  ]);
  const invalidSnapshotCodes = new Set([
    "AIC-AGENT-COMMAND-SNAPSHOT_INVALID",
    "AIC-AGENT-COMMAND-ASSET_SNAPSHOT_INVALID",
    "AIC-AGENT-COMMAND-SNAPSHOT_MIGRATION_REQUIRED",
  ]);
  const invalidStrategyCodes = new Set([
    "AIC-AGENT-COMMAND-STRATEGY_FACTS_INVALID",
    "AIC-AGENT-COMMAND-STRATEGY_DRAFT_NOT_FOUND",
    "AIC-AGENT-COMMAND-STRATEGY_VALIDATION_FAILED",
  ]);
  if (code === "AIC-WORKFLOW-REVISION_CONFLICT") {
    return {
      status: "已失效",
      message: "任务内容已经更新，请刷新任务并让智能助手基于最新状态重新建议。",
      blocksCard: true,
      stale: true,
    };
  }
  if (code.endsWith("-IDEMPOTENCY_CONFLICT")) {
    return {
      status: "请求冲突",
      message: "同一次请求已用于另一项操作，请先核对原操作结果，不要更换请求标识重复提交。",
      blocksCard: true,
      stale: false,
    };
  }
  if (invalidSessionCodes.has(code)) {
    return {
      status: "登录已失效",
      message: "当前登录已失效，请重新登录或切换到正确账号后再获取操作建议。",
      blocksCard: true,
      stale: false,
    };
  }
  if (mismatchedSessionCodes.has(code)) {
    return {
      status: "会话不匹配",
      message: "当前账号与任务会话不一致，请切换到有权限的账号并重新打开该任务。",
      blocksCard: true,
      stale: false,
    };
  }
  if (code === "AIC-AUTH-TASK_OWNER_REQUIRED") {
    return {
      status: "无执行权限",
      message: "当前账号不是该任务的可执行负责人，请先确认任务归属或完成接管。",
      blocksCard: true,
      stale: false,
    };
  }
  if (code.startsWith("AIC-AUTH-")) {
    return {
      status: "权限不足",
      message: "当前账号没有执行这项任务操作的权限，请切换到有权限的账号或联系管理员。",
      blocksCard: true,
      stale: false,
    };
  }
  if (code === "AIC-COST-BUDGET_EXCEEDED") {
    return {
      status: "额度不足",
      message: "当前账号可用额度不足，请调整额度后重新获取操作建议。",
      blocksCard: true,
      stale: false,
    };
  }
  if (code === "AIC-CONCURRENCY-ACCOUNT_HIGH_COST_TASK_RUNNING") {
    return {
      status: "任务繁忙",
      message: "当前账号已有高消耗制作任务在运行，请等待其结束后重新获取操作建议。",
      blocksCard: true,
      stale: false,
    };
  }
  if (unavailableTaskCodes.has(code)) {
    return {
      status: "任务不可用",
      message: "当前项目或任务已不可访问，请刷新任务列表并重新获取操作建议。",
      blocksCard: true,
      stale: true,
    };
  }
  if (invalidSnapshotCodes.has(code)) {
    return {
      status: "任务数据需刷新",
      message: "任务锁定的数据已失效或需要升级，请刷新任务；仍无法继续时请联系管理员处理数据迁移。",
      blocksCard: true,
      stale: true,
    };
  }
  if (invalidStrategyCodes.has(code) || code.startsWith("AIC-STRATEGY-")) {
    return {
      status: "策略需重新检查",
      message: "当前策略内容或依据已发生变化，请刷新任务并重新生成或检查策略建议。",
      blocksCard: true,
      stale: true,
    };
  }
  if (code === "AIC-STAGE-ROLLBACK-DENIED") {
    return {
      status: "回退不可执行",
      message: "当前阶段或目标版本已不允许回退，请刷新任务后重新选择可用版本。",
      blocksCard: true,
      stale: true,
    };
  }
  if (code.startsWith("AIC-WORKFLOW-") || code.endsWith("_CONFLICT")) {
    return {
      status: "状态冲突",
      message: "任务当前状态不再允许执行这项操作，请刷新任务后重新获取建议。",
      blocksCard: true,
      stale: true,
    };
  }
  if (charged) {
    return {
      status: "结果待确认",
      message: "服务端提示本次操作可能已产生费用。为避免重复执行，请先刷新任务并核对结果。",
      blocksCard: true,
      stale: false,
    };
  }
  if (code.startsWith("AIC-")) {
    return {
      status: "操作未完成",
      message: "服务端未能完成这项操作，请刷新任务并按最新状态重新获取建议。",
      blocksCard: true,
      stale: false,
    };
  }
  return {
    status: "执行失败",
    message: "网络或服务暂时不可用，请稍后手动重试。",
    blocksCard: false,
    stale: false,
  };
}

const panelMinimumWidth = 320;
const panelMaximumWidth = 560;
const panelResizerWidth = 6;
const projectRailWidth = 240;
const studioMinimumWidth = 480;
const desktopMinimum = 1280;

function validMinorAmount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function formatMinorAmount(amountMinor, currency) {
  const formatter = new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currency,
    currencyDisplay: "symbol",
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
  return formatter.format(amountMinor / (10 ** fractionDigits));
}

export function agentBudgetPresentation(view, expectedAccountId) {
  if (view === undefined || view === null) {
    return {
      text: "额度：当前账号未配置",
      title: "管理员尚未为当前账号配置制作额度。",
    };
  }
  const balance = view.balance;
  if (
    typeof view.accountId !== "string"
    || view.accountId !== expectedAccountId
    || typeof view.currency !== "string"
    || !/^[A-Z]{3}$/u.test(view.currency)
    || !balance
    || balance.currency !== view.currency
    || !validMinorAmount(balance.limitAmountMinor)
    || !validMinorAmount(balance.spentAmountMinor)
    || !validMinorAmount(balance.reservedAmountMinor)
    || !validMinorAmount(balance.availableAmountMinor)
    || balance.spentAmountMinor + balance.reservedAmountMinor + balance.availableAmountMinor !== balance.limitAmountMinor
  ) {
    throw new Error("额度数据与当前账号不一致。");
  }
  const available = formatMinorAmount(balance.availableAmountMinor, view.currency);
  const spent = formatMinorAmount(balance.spentAmountMinor, view.currency);
  const reserved = formatMinorAmount(balance.reservedAmountMinor, view.currency);
  const limit = formatMinorAmount(balance.limitAmountMinor, view.currency);
  return {
    text: `可用额度 ${available} · 已用 ${spent}` + (balance.reservedAmountMinor > 0 ? ` · 预留 ${reserved}` : ""),
    title: `账号总额度 ${limit}；可用 ${available}；已用 ${spent}；预留 ${reserved}。`,
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function agentPanelWidthBounds(shellWidth) {
  const availableWidth = Math.max(0, shellWidth - projectRailWidth - studioMinimumWidth - panelResizerWidth);
  return {
    minimum: Math.min(panelMinimumWidth, availableWidth),
    maximum: Math.min(panelMaximumWidth, availableWidth),
  };
}

export function resolveAgentPanelWidth(shellWidth, requestedWidth) {
  const bounds = agentPanelWidthBounds(shellWidth);
  return clamp(requestedWidth, bounds.minimum, bounds.maximum);
}

export function createAgentPanelLayoutController(options) {
  const { shell, panel, resizer, collapseButton, prompt } = options;
  const widthKey = "firefly.agentPanelWidth";
  const collapsedKey = "firefly.agentPanelCollapsed";
  const desktopMedia = window.matchMedia(`(min-width: ${desktopMinimum}px)`);
  const storedWidth = Number(localStorage.getItem(widthKey));
  let requestedWidth = Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : 380;
  let collapsed = localStorage.getItem(collapsedKey) === "true";

  function effectiveWidth() {
    return resolveAgentPanelWidth(shell.clientWidth || window.innerWidth, requestedWidth);
  }

  function persist(key, value) {
    try { localStorage.setItem(key, String(value)); } catch {}
  }

  function render() {
    const effectivelyCollapsed = collapsed && desktopMedia.matches;
    const shellWidth = shell.clientWidth || window.innerWidth;
    const width = resolveAgentPanelWidth(shellWidth, requestedWidth);
    const bounds = agentPanelWidthBounds(shellWidth);
    shell.style.setProperty("--agent-panel-width", width + "px");
    shell.dataset.agentCollapsed = String(effectivelyCollapsed);
    panel.removeAttribute("aria-hidden");
    resizer.setAttribute("aria-valuemin", String(bounds.minimum));
    resizer.setAttribute("aria-valuemax", String(bounds.maximum));
    resizer.setAttribute("aria-valuenow", String(Math.round(width)));
    collapseButton.setAttribute("aria-expanded", String(!effectivelyCollapsed));
    collapseButton.setAttribute("aria-label", effectivelyCollapsed ? "展开智能助手" : "折叠智能助手");
    collapseButton.title = effectivelyCollapsed ? "展开智能助手（Alt+Shift+A）" : "折叠智能助手（Alt+Shift+A）";
  }

  function toggle() {
    collapsed = !collapsed;
    persist(collapsedKey, collapsed);
    render();
    if (collapsed && panel.contains(document.activeElement)) collapseButton.focus();
    if (!collapsed) prompt.focus();
  }

  function setRequestedWidth(nextWidth, persistChange = true) {
    requestedWidth = clamp(nextWidth, panelMinimumWidth, panelMaximumWidth);
    if (persistChange) persist(widthKey, requestedWidth);
    render();
  }

  collapseButton.addEventListener("click", toggle);
  desktopMedia.addEventListener("change", render);
  window.addEventListener("resize", render);
  document.addEventListener("keydown", function (event) {
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      toggle();
    }
  });

  resizer.addEventListener("keydown", function (event) {
    const step = event.shiftKey ? 40 : 20;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") setRequestedWidth(panelMinimumWidth);
    else if (event.key === "End") setRequestedWidth(panelMaximumWidth);
    else setRequestedWidth(requestedWidth + (event.key === "ArrowLeft" ? step : -step));
  });
  resizer.addEventListener("pointerdown", function (event) {
    if (collapsed || !desktopMedia.matches) return;
    const startX = event.clientX;
    const startWidth = effectiveWidth();
    resizer.dataset.resizing = "true";
    resizer.setPointerCapture(event.pointerId);
    function move(moveEvent) {
      setRequestedWidth(startWidth + startX - moveEvent.clientX, false);
    }
    function stop() {
      persist(widthKey, requestedWidth);
      delete resizer.dataset.resizing;
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", stop);
      resizer.removeEventListener("pointercancel", stop);
    }
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", stop);
    resizer.addEventListener("pointercancel", stop);
  });

  render();
  return { render, toggle };
}

export function bindAgentPanel(options) {
  const { elements, state, sendMessage, createSession, selectSession, updateSession, clearMessages, clearError, showError, setBusy } = options;

  elements.composer.addEventListener("submit", function (event) {
    event.preventDefault();
    void sendMessage(elements.prompt.value);
  });

  elements.prompt.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });

  elements.prompt.addEventListener("input", function () {
    elements.prompt.style.height = "auto";
    elements.prompt.style.height = Math.min(elements.prompt.scrollHeight, 180) + "px";
  });

  document.querySelectorAll("[data-prompt]").forEach(function (button) {
    button.addEventListener("click", function () {
      elements.prompt.value = button.dataset.prompt || "";
      elements.prompt.focus();
    });
  });

  elements.newSession.addEventListener("click", async function () {
    if (state.busy) return;
    clearError();
    setBusy(true);
    try { await createSession(); } catch (error) { showError(error); }
    finally { setBusy(false); elements.prompt.focus(); }
  });

  elements.resetSession.addEventListener("click", async function () {
    if (state.busy || !state.sessionId) return;
    if (!window.confirm("确认清空当前会话记录？此操作不可撤销。")) return;
    clearError();
    setBusy(true);
    try {
      const result = await agentApi.resetSession(state.sessionId, state.sessionVideoTaskId);
      updateSession(result.session);
      clearMessages();
    } catch (error) { showError(error); }
    finally { setBusy(false); elements.prompt.focus(); }
  });

  elements.cancelGeneration.addEventListener("click", async function () {
    if (!state.busy || !state.sessionId || !state.activeRunId) return;
    elements.cancelGeneration.disabled = true;
    try {
      await agentApi.abortRun(state.sessionId, state.activeRunId, state.sessionVideoTaskId);
    } catch (error) {
      showError(error);
      elements.cancelGeneration.disabled = false;
    }
  });

  elements.sessionSelect.addEventListener("change", function () {
    if (state.busy || !elements.sessionSelect.value || elements.sessionSelect.value === state.sessionId) return;
    void selectSession(elements.sessionSelect.value);
  });

  elements.retryMessage.addEventListener("click", function () {
    if (!state.lastPrompt || state.busy) return;
    void sendMessage(state.lastPrompt);
  });

  createAgentPanelLayoutController({
    shell: elements.agentLayoutShell,
    panel: elements.chatView,
    resizer: document.querySelector("#agent-resizer"),
    collapseButton: document.querySelector("#collapse-agent"),
    prompt: elements.prompt,
  });
}
