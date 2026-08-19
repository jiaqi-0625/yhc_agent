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

export function agentActionRequestBody(proposal) {
  if (proposal.action === "generate_strategy") {
    return {
      audience: proposal.payload.audience,
      theme: proposal.payload.theme,
      expectedRevision: proposal.expectedRevision,
    };
  }
  if (proposal.action === "request_strategy_approval") {
    return { expectedRevision: proposal.expectedRevision };
  }
  throw new Error("Unsupported Agent action card.");
}

export function agentActionAvailability(proposal, currentVideoTaskId, currentRevision, busy = false) {
  if (!currentVideoTaskId || !Number.isSafeInteger(currentRevision)) {
    return { enabled: false, stale: true, reason: "当前未绑定作品。" };
  }
  if (proposal.videoTaskId !== currentVideoTaskId) {
    return { enabled: false, stale: true, reason: "该卡片属于其他视频任务，请切回对应任务或重新获取建议。" };
  }
  if (proposal.expectedRevision !== currentRevision) {
    return { enabled: false, stale: true, reason: "任务内容已经更新，请重新获取操作建议。" };
  }
  return { enabled: !busy, stale: false };
}

const panelMinimumWidth = 320;
const panelMaximumWidth = 560;
const panelResizerWidth = 6;
const compactDesktopMaximum = 1180;
const mobileMaximum = 980;

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
  const sidebarWidth = shellWidth <= compactDesktopMaximum ? 220 : 260;
  const studioMinimumWidth = shellWidth <= compactDesktopMaximum ? 480 : 540;
  const availableWidth = Math.max(0, shellWidth - sidebarWidth - studioMinimumWidth - panelResizerWidth);
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
  const desktopMedia = window.matchMedia(`(min-width: ${mobileMaximum + 1}px)`);
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
    collapseButton.setAttribute("aria-label", effectivelyCollapsed ? "展开 Agent 面板" : "折叠 Agent 面板");
    collapseButton.title = effectivelyCollapsed ? "展开 Agent 面板（Alt+Shift+A）" : "折叠 Agent 面板（Alt+Shift+A）";
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
    shell: elements.workspaceShell,
    panel: elements.chatView,
    resizer: document.querySelector("#agent-resizer"),
    collapseButton: document.querySelector("#collapse-agent"),
    prompt: elements.prompt,
  });
}
