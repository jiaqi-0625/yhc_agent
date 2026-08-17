"use strict";

const state = { sessionId: null, busy: false, work: null, workflowBusy: false };
const elements = {
  messages: document.querySelector("#messages"),
  welcome: document.querySelector("#welcome"),
  composer: document.querySelector("#composer"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send"),
  provider: document.querySelector("#provider"),
  model: document.querySelector("#model"),
  sessionId: document.querySelector("#session-id"),
  status: document.querySelector("#service-status"),
  error: document.querySelector("#error-banner"),
  newSession: document.querySelector("#new-session"),
  resetSession: document.querySelector("#reset-session"),
  workStatus: document.querySelector("#work-status"),
  workRevision: document.querySelector("#work-revision"),
  workflowError: document.querySelector("#workflow-error"),
  createWorkCard: document.querySelector("#create-work-card"),
  createWork: document.querySelector("#create-work"),
  activeWork: document.querySelector("#active-work"),
  vehicleName: document.querySelector("#vehicle-name"),
  snapshotId: document.querySelector("#snapshot-id"),
  vehicleFacts: document.querySelector("#vehicle-facts"),
  strategySetup: document.querySelector("#strategy-setup"),
  audience: document.querySelector("#strategy-audience"),
  theme: document.querySelector("#strategy-theme"),
  generateStrategy: document.querySelector("#generate-strategy"),
  strategyEditor: document.querySelector("#strategy-editor"),
  strategyVersion: document.querySelector("#strategy-version"),
  validationState: document.querySelector("#validation-state"),
  strategyItems: document.querySelector("#strategy-items"),
  saveStrategy: document.querySelector("#save-strategy"),
  regenerateStrategy: document.querySelector("#regenerate-strategy"),
  requestApproval: document.querySelector("#request-approval"),
  rejectStrategy: document.querySelector("#reject-strategy"),
  approveStrategy: document.querySelector("#approve-strategy"),
  approvalNote: document.querySelector("#approval-note"),
};

const statusLabels = {
  created: "已创建车型快照",
  strategy_draft: "策略草稿",
  awaiting_strategy_approval: "等待策略审批",
  strategy_approved: "策略已通过",
};

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = "请求失败（HTTP " + response.status + "）";
    try {
      const body = await response.json();
      if (body && typeof body.message === "string") message = body.message;
    } catch {}
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function setStatus(kind, text) {
  elements.status.className = "status " + kind;
  elements.status.querySelector("span:last-child").textContent = text;
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : "发生未知错误";
  elements.error.hidden = false;
}

function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = "";
}

function showWorkflowError(error) {
  elements.workflowError.textContent = error instanceof Error ? error.message : "发生未知业务错误";
  elements.workflowError.hidden = false;
}

function clearWorkflowError() {
  elements.workflowError.hidden = true;
  elements.workflowError.textContent = "";
}

function setBusy(busy) {
  state.busy = busy;
  elements.prompt.disabled = busy;
  elements.send.disabled = busy;
  elements.newSession.disabled = busy;
  elements.resetSession.disabled = busy;
}

function setWorkflowBusy(busy) {
  state.workflowBusy = busy;
  [
    elements.createWork,
    elements.generateStrategy,
    elements.saveStrategy,
    elements.regenerateStrategy,
    elements.requestApproval,
    elements.rejectStrategy,
    elements.approveStrategy,
  ].forEach(function (button) { button.disabled = busy; });
}

function appendFact(text) {
  const pill = document.createElement("span");
  pill.textContent = text;
  elements.vehicleFacts.appendChild(pill);
}

function renderStrategyItems(strategy, editable) {
  elements.strategyItems.replaceChildren();
  strategy.items.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (item, index) {
    const card = document.createElement("article");
    card.className = "strategy-item" + (item.locked ? " locked" : "");
    card.dataset.index = String(index);

    const order = document.createElement("span");
    order.className = "item-order";
    order.textContent = String(item.order).padStart(2, "0");

    const content = document.createElement("div");
    const kind = document.createElement("span");
    kind.className = "item-kind";
    kind.textContent = item.kind === "fixed" ? "固定卖点" : "扩展卖点";
    const statement = document.createElement("textarea");
    statement.value = item.statement;
    statement.disabled = !editable;
    statement.dataset.field = "statement";
    const evidence = document.createElement("p");
    evidence.textContent = item.evidence
      ? "依据：" + item.evidence.sourceName + " · " + item.evidence.sourceReference
      : "缺少事实依据";
    content.append(kind, statement, evidence);

    const lockLabel = document.createElement("label");
    lockLabel.className = "lock-control";
    const lock = document.createElement("input");
    lock.type = "checkbox";
    lock.checked = item.locked;
    lock.disabled = !editable;
    lock.dataset.field = "locked";
    lock.addEventListener("change", function () { card.classList.toggle("locked", lock.checked); });
    lockLabel.append(lock, document.createTextNode("人工锁定"));
    card.append(order, content, lockLabel);
    elements.strategyItems.appendChild(card);
  });
}

function renderWork(view) {
  state.work = view;
  if (!view) {
    elements.createWorkCard.hidden = false;
    elements.activeWork.hidden = true;
    elements.workStatus.textContent = "尚未创建";
    elements.workRevision.textContent = "—";
    return;
  }
  const work = view.work;
  const snapshot = view.vehicleSnapshot;
  elements.createWorkCard.hidden = true;
  elements.activeWork.hidden = false;
  elements.workStatus.textContent = statusLabels[work.status] || work.status;
  elements.workRevision.textContent = String(work.revision);
  elements.vehicleName.textContent = snapshot.brand + " · " + snapshot.series + " · " + snapshot.trim;
  elements.snapshotId.textContent = snapshot.id;
  elements.vehicleFacts.replaceChildren();
  appendFact(snapshot.modelYear + " 年款");
  Object.entries(snapshot.parameters).forEach(function (entry) { appendFact(entry[0] + "：" + entry[1]); });
  appendFact(snapshot.fixedClaims.length + " 个固定卖点");
  appendFact(snapshot.prohibitedClaims.length + " 个禁用表达");

  const strategy = view.strategy;
  if (!strategy) {
    elements.strategySetup.hidden = false;
    elements.strategyEditor.hidden = true;
    return;
  }
  const editable = work.status === "strategy_draft";
  elements.strategySetup.hidden = work.status !== "strategy_draft";
  elements.audience.value = strategy.audience;
  elements.theme.value = strategy.theme;
  elements.strategyEditor.hidden = false;
  elements.strategyVersion.textContent = "v" + strategy.version + " · " + view.strategyVersionCount + " 个历史版本";
  elements.validationState.textContent = view.validation.valid ? "事实校验通过" : view.validation.issues.length + " 个校验问题";
  elements.validationState.className = "validation-state" + (view.validation.valid ? "" : " invalid");
  renderStrategyItems(strategy, editable);

  elements.saveStrategy.hidden = !editable;
  elements.regenerateStrategy.hidden = !editable;
  elements.requestApproval.hidden = !editable;
  const awaiting = work.status === "awaiting_strategy_approval";
  elements.rejectStrategy.hidden = !awaiting;
  elements.approveStrategy.hidden = !awaiting;
  elements.approvalNote.textContent =
    work.status === "strategy_approved"
      ? "已由人工审核通过；Agent 无法执行该批准动作。"
      : awaiting
        ? "策略已冻结，等待审核人员决策。"
        : "锁定的卖点在模型重新生成时不会被覆盖。";
}

function collectStrategyItems() {
  return state.work.strategy.items.slice().sort(function (a, b) { return a.order - b.order; }).map(function (item, index) {
    const card = elements.strategyItems.querySelector('[data-index="' + index + '"]');
    return {
      ...item,
      statement: card.querySelector('[data-field="statement"]').value.trim(),
      locked: card.querySelector('[data-field="locked"]').checked,
    };
  });
}

async function loadWorks() {
  const result = await api("/v1/works");
  renderWork(result.works[0] || null);
}

async function runWorkflow(action) {
  if (state.workflowBusy) return;
  clearWorkflowError();
  setWorkflowBusy(true);
  try { renderWork(await action()); }
  catch (error) { showWorkflowError(error); }
  finally { setWorkflowBusy(false); }
}

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(function (part) { return part && part.type === "text" && typeof part.text === "string"; })
    .map(function (part) { return part.text; })
    .join("\n");
}

function appendMessage(role, text, pending) {
  if (elements.welcome) elements.welcome.hidden = true;
  const row = document.createElement("article");
  row.className = "message " + role + (pending ? " pending" : "");
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = text;
  row.appendChild(bubble);
  elements.messages.appendChild(row);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return row;
}

function clearMessages() {
  elements.messages.querySelectorAll(".message").forEach(function (node) { node.remove(); });
  if (elements.welcome) elements.welcome.hidden = false;
}

function updateSession(summary) {
  state.sessionId = summary.id;
  localStorage.setItem("firefly.sessionId", summary.id);
  elements.sessionId.textContent = summary.id;
}

async function createSession() {
  const body = await api("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  updateSession(body.session);
  clearMessages();
}

async function restoreSession() {
  const saved = localStorage.getItem("firefly.sessionId");
  if (!saved) {
    await createSession();
    return;
  }
  try {
    const session = await api("/v1/sessions/" + encodeURIComponent(saved));
    updateSession(session.session);
    const transcript = await api("/v1/sessions/" + encodeURIComponent(saved) + "/transcript");
    clearMessages();
    transcript.messages.forEach(function (message) {
      if (message.role === "user" || message.role === "assistant") {
        const text = messageText(message);
        if (text) appendMessage(message.role, text, false);
      }
    });
  } catch {
    localStorage.removeItem("firefly.sessionId");
    await createSession();
  }
}

async function initialize() {
  try {
    const meta = await api("/v1/meta");
    elements.provider.textContent = meta.model.provider;
    elements.model.textContent = meta.model.modelId;
    await Promise.all([restoreSession(), loadWorks()]);
    setStatus("online", "服务正常");
    elements.prompt.focus();
  } catch (error) {
    setStatus("error", "连接失败");
    showError(error);
  }
}

async function sendMessage(text) {
  const message = text.trim();
  if (!message || state.busy || !state.sessionId) return;
  clearError();
  setBusy(true);
  appendMessage("user", message, false);
  elements.prompt.value = "";
  elements.prompt.style.height = "auto";
  const pending = appendMessage("assistant", "Agent 正在处理…", true);
  try {
    const result = await api("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: message }),
    });
    pending.remove();
    appendMessage("assistant", result.assistantText || "Agent 未返回文本内容。", false);
    updateSession(result.session);
  } catch (error) {
    pending.remove();
    showError(error);
  } finally {
    setBusy(false);
    elements.prompt.focus();
  }
}

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
    const result = await api("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/reset", { method: "POST" });
    updateSession(result.session);
    clearMessages();
  } catch (error) { showError(error); }
  finally { setBusy(false); elements.prompt.focus(); }
});

document.querySelectorAll("[data-view]").forEach(function (button) {
  button.addEventListener("click", function () {
    document.querySelectorAll("[data-view]").forEach(function (candidate) {
      candidate.classList.toggle("active", candidate === button);
    });
    document.querySelectorAll(".view").forEach(function (view) {
      view.hidden = view.id !== button.dataset.view + "-view";
    });
  });
});

elements.createWork.addEventListener("click", function () {
  void runWorkflow(function () {
    return api("/v1/works", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vehicleId: "vehicle_firefly_e5_2026_long_range",
        color: "萤火绿",
        region: "中国大陆",
        campaignDate: new Date().toISOString().slice(0, 10),
        name: "黄金样例家庭出行广告",
      }),
    });
  });
});

function generateStrategy() {
  return api("/v1/works/" + encodeURIComponent(state.work.work.id) + "/strategy/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: state.work.work.revision,
      audience: elements.audience.value.trim(),
      theme: elements.theme.value.trim(),
    }),
  });
}

elements.generateStrategy.addEventListener("click", function () { void runWorkflow(generateStrategy); });
elements.regenerateStrategy.addEventListener("click", function () { void runWorkflow(generateStrategy); });

elements.saveStrategy.addEventListener("click", function () {
  void runWorkflow(function () {
    return api("/v1/works/" + encodeURIComponent(state.work.work.id) + "/strategy", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: state.work.work.revision,
        audience: elements.audience.value.trim(),
        theme: elements.theme.value.trim(),
        items: collectStrategyItems(),
      }),
    });
  });
});

elements.requestApproval.addEventListener("click", function () {
  void runWorkflow(function () {
    return api("/v1/works/" + encodeURIComponent(state.work.work.id) + "/strategy/approval-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: state.work.work.revision }),
    });
  });
});

function decideStrategy(decision) {
  return api("/v1/works/" + encodeURIComponent(state.work.work.id) + "/strategy/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: state.work.work.revision,
      decision: decision,
      comment: decision === "approved" ? "本地竖切人工验收通过" : "请修改后重新提交",
    }),
  });
}

elements.approveStrategy.addEventListener("click", function () { void runWorkflow(function () { return decideStrategy("approved"); }); });
elements.rejectStrategy.addEventListener("click", function () { void runWorkflow(function () { return decideStrategy("rejected"); }); });

void initialize();
