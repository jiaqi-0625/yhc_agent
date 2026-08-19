import { agentApi } from "./agent-api.js";
import {
  agentActionAvailability,
  agentActionFailurePresentation,
  agentActionRequestBody,
  agentBudgetPresentation,
  bindAgentPanel,
  extractAgentActionCard,
} from "./agent-panel.js";
import { api, setWorkspaceSessionToken } from "./api-client.js";
import { authApi } from "./auth-api.js";
import { workspaceApi } from "./workspace-api.js";
import {
  bindWorkspaceShell,
  navigationBrandStorageKey,
  normalizeNavigationBrands,
  resolveNavigationBrandId,
  workSummaryMatchesNavigationBrand,
} from "./workspace-shell.js";

const state = {
  sessionId: null,
  sessionVideoTaskId: null,
  sessions: [],
  taskContext: null,
  activeRunId: null,
  lastPrompt: "",
  busy: false,
  work: null,
  workSummaries: [],
  workflowBusy: false,
  workFilter: "",
  modelReady: true,
  account: null,
  accounts: [],
  navigationBrands: [],
  navigationBrandId: null,
  navigationBrandsLoading: true,
  navigationBrandsError: null,
  workspaceHydrating: true,
};
let navigationBrandsRequest = 0;
let workspaceScopeGeneration = 0;
const elements = {
  messages: document.querySelector("#messages"),
  welcome: document.querySelector("#welcome"),
  composer: document.querySelector("#composer"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send"),
  provider: document.querySelector("#provider"),
  model: document.querySelector("#model"),
  sessionId: document.querySelector("#session-id"),
  sessionWork: document.querySelector("#session-work"),
  agentTools: document.querySelector("#agent-tools"),
  status: document.querySelector("#service-status"),
  error: document.querySelector("#error-banner"),
  newSession: document.querySelector("#new-session"),
  sessionSelect: document.querySelector("#agent-session-select"),
  resetSession: document.querySelector("#reset-session"),
  retryMessage: document.querySelector("#retry-message"),
  cancelGeneration: document.querySelector("#cancel-generation"),
  chatView: document.querySelector("#chat-view"),
  workStatus: document.querySelector("#work-status"),
  workRevision: document.querySelector("#work-revision"),
  workList: document.querySelector("#work-list"),
  newWork: document.querySelector("#new-work"),
  workflowError: document.querySelector("#workflow-error"),
  createWorkCard: document.querySelector("#create-work-card"),
  createWork: document.querySelector("#create-work"),
  activeWork: document.querySelector("#active-work"),
  stateCard: document.querySelector("#workflow-state-card"),
  stateTitle: document.querySelector("#workflow-state-title"),
  stateDescription: document.querySelector("#workflow-state-description"),
  stateNewWork: document.querySelector("#state-new-work"),
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
  copyWork: document.querySelector("#copy-work"),
  approvalNote: document.querySelector("#approval-note"),
  workSearch: document.querySelector("#work-search"),
  themeToggle: document.querySelector("#theme-toggle"),
  workspaceShell: document.querySelector("#workspace-shell"),
  topbarWorkName: document.querySelector("#topbar-work-name"),
  studioWorkTitle: document.querySelector("#studio-work-title"),
  studioWorkDescription: document.querySelector("#studio-work-description"),
  studioStatus: document.querySelector("#studio-status"),
  agentAccountSelect: document.querySelector("#agent-account-select"),
  agentAccountRole: document.querySelector("#agent-account-role"),
  accountAvatar: document.querySelector("#account-avatar"),
  brandNavigation: document.querySelector("#brand-navigation"),
  brandNavigationRetry: document.querySelector("#brand-navigation-retry"),
  brandNavigationStatus: document.querySelector("#brand-navigation-status"),
  agentContextBrand: document.querySelector("#agent-context-brand"),
  agentContextVehicle: document.querySelector("#agent-context-vehicle"),
  agentContextProject: document.querySelector("#agent-context-project"),
  agentContextTask: document.querySelector("#agent-context-task"),
  agentContextOwner: document.querySelector("#agent-context-owner"),
  agentContextStage: document.querySelector("#agent-context-stage"),
  agentContextRevision: document.querySelector("#agent-context-revision"),
  agentContextQuota: document.querySelector("#agent-context-quota"),
};

const roleLabels = {
  content_admin: "内容管理员",
  creator: "制作账号",
};

const statusLabels = {
  created: "已创建车型快照",
  strategy_draft: "策略草稿",
  awaiting_strategy_approval: "等待策略审批",
  strategy_approved: "策略已通过",
};

const statusDescriptions = {
  created: ["车型快照已创建", "设置目标人群和传播主题，然后生成第一版卖点策略。"],
  strategy_draft: ["策略草稿可编辑", "可以修改或锁定卖点；校验通过后再提交人工审批。"],
  awaiting_strategy_approval: ["等待人工审批", "策略内容已冻结，只能由审核人员通过或驳回。"],
  strategy_approved: ["策略已通过", "该版本保持只读。继续创作时，请基于同一车型新建独立作品。"],
};

const vehicleParameterLabels = {
  bodyStyle: "车身类型",
  bodyType: "车型级别",
  energyType: "能源类型",
  rangeKm: "续航里程",
  seats: "座位数",
};

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
  elements.prompt.disabled = busy || !state.modelReady || !state.sessionId;
  elements.send.disabled = busy || !state.modelReady || !state.sessionId;
  elements.send.hidden = busy;
  elements.cancelGeneration.hidden = !busy;
  elements.newSession.disabled = busy || !state.work;
  elements.sessionSelect.disabled = busy || state.sessions.length === 0;
  elements.resetSession.disabled = busy;
  elements.retryMessage.disabled = busy;
  if (elements.agentAccountSelect) elements.agentAccountSelect.disabled = busy || state.workflowBusy || state.workspaceHydrating || state.accounts.length < 2;
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
    elements.copyWork,
    elements.newWork,
    elements.stateNewWork,
  ].forEach(function (button) { button.disabled = busy; });
  elements.workList.querySelectorAll("button").forEach(function (button) { button.disabled = busy; });
  if (elements.agentAccountSelect) elements.agentAccountSelect.disabled = busy || state.busy || state.workspaceHydrating || state.accounts.length < 2;
  refreshActionProposalAvailability();
}

function captureWorkspaceScope() {
  return {
    accountId: state.account?.accountId || null,
    generation: workspaceScopeGeneration,
  };
}

function isCurrentWorkspaceScope(scope) {
  return scope.generation === workspaceScopeGeneration
    && scope.accountId === (state.account?.accountId || null);
}

function selectedNavigationBrand() {
  return state.navigationBrands.find(function (brand) { return brand.id === state.navigationBrandId; }) || null;
}

function resetWorkspaceContext() {
  state.sessionId = null;
  state.sessionVideoTaskId = null;
  state.sessions = [];
  state.taskContext = null;
  state.work = null;
  state.workSummaries = [];
  renderSessionOptions();
  clearMessages();
  renderWork(null);
  renderTaskContext(null);
  elements.sessionId.textContent = "—";
  elements.sessionWork.textContent = "未绑定";
  elements.agentTools.textContent = "未加载";
}

function shortWorkId(workId) {
  return workId.length > 18 ? workId.slice(0, 13) + "…" : workId;
}

function renderWorkList() {
  elements.workList.replaceChildren();
  const navigationBrand = selectedNavigationBrand();
  const brandWorks = state.workSummaries.filter(function (summary) {
    return workSummaryMatchesNavigationBrand(summary, navigationBrand);
  });
  const normalizedFilter = state.workFilter.trim().toLocaleLowerCase("zh-CN");
  const visibleWorks = brandWorks.filter(function (summary) {
    if (!normalizedFilter) return true;
    const searchable = [summary.work.name, summary.work.id, summary.vehicle.brand, summary.vehicle.series, summary.vehicle.trim]
      .filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
    return searchable.includes(normalizedFilter);
  });
  if (visibleWorks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "work-list-empty";
    empty.textContent = brandWorks.length === 0
      ? navigationBrand
        ? "该品牌还没有项目，点击右上角＋开始。"
        : "还没有项目，点击右上角＋开始。"
      : "没有匹配的项目，请换个关键词。";
    elements.workList.appendChild(empty);
    return;
  }
  visibleWorks.forEach(function (summary) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "work-list-item" + (state.work && state.work.work.id === summary.work.id ? " active" : "");
    button.dataset.workId = summary.work.id;
    button.title = summary.work.name || summary.vehicle.series + " · " + summary.vehicle.trim;
    button.setAttribute("aria-label", "打开项目 " + (summary.work.name || summary.vehicle.series + " " + summary.vehicle.trim));
    const title = document.createElement("strong");
    title.textContent = summary.vehicle.series + " · " + summary.vehicle.trim;
    const meta = document.createElement("span");
    const status = document.createElement("b");
    status.textContent = statusLabels[summary.work.status] || summary.work.status;
    const revision = document.createElement("i");
    revision.textContent = "版本 " + summary.work.revision;
    meta.append(status, revision);
    button.append(title, meta);
    button.addEventListener("click", function () {
      if (state.workflowBusy || state.work?.work.id === summary.work.id) return;
      void runWorkflow(function () {
        return workspaceApi.getWork(summary.work.id);
      });
    });
    elements.workList.appendChild(button);
  });
}

function updateStages(status) {
  const stages = document.querySelectorAll("[data-stage]");
  stages.forEach(function (stage) { stage.className = ""; });
  if (!status) return;
  const snapshot = document.querySelector('[data-stage="snapshot"]');
  const strategy = document.querySelector('[data-stage="strategy"]');
  const approval = document.querySelector('[data-stage="approval"]');
  snapshot.className = status === "created" ? "active" : "completed";
  if (status === "strategy_draft") strategy.className = "active";
  if (status === "awaiting_strategy_approval") {
    strategy.className = "completed";
    approval.className = "active";
  }
  if (status === "strategy_approved") {
    strategy.className = "completed";
    approval.className = "completed";
  }
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
    localStorage.removeItem("firefly.workId");
    elements.createWorkCard.hidden = false;
    elements.activeWork.hidden = true;
    elements.workStatus.textContent = "尚未创建";
    elements.workStatus.className = "badge neutral";
    elements.workRevision.textContent = "—";
    elements.topbarWorkName.textContent = "未选择项目";
    elements.studioWorkTitle.textContent = "开始第一个汽车广告项目";
    elements.studioWorkDescription.textContent = "请选择或新建项目。";
    elements.studioStatus.textContent = "未开始";
    elements.studioStatus.className = "badge neutral";
    renderTaskContext(null);
    updateStages(null);
    renderWorkList();
    refreshActionProposalAvailability();
    return;
  }
  const work = view.work;
  const snapshot = view.vehicleSnapshot;
  const workBrand = state.navigationBrands.find(function (brand) { return brand.id === snapshot.brandId; });
  if (workBrand && state.navigationBrandId !== workBrand.id && state.account) {
    state.navigationBrandId = workBrand.id;
    localStorage.setItem(navigationBrandStorageKey(state.account.accountId), workBrand.id);
    renderNavigationBrands();
  }
  if (state.sessionVideoTaskId !== work.id) renderTaskContext(null);
  localStorage.setItem("firefly.workId", work.id);
  elements.createWorkCard.hidden = true;
  elements.activeWork.hidden = false;
  elements.workStatus.textContent = statusLabels[work.status] || work.status;
  elements.workStatus.className = "badge " + (work.status === "strategy_approved" ? "success" : work.status === "awaiting_strategy_approval" ? "pending" : "neutral");
  elements.workRevision.textContent = String(work.revision);
  const displayName = work.name || snapshot.series + " · " + snapshot.trim;
  elements.topbarWorkName.textContent = displayName;
  elements.studioWorkTitle.textContent = displayName;
  elements.studioWorkDescription.textContent = snapshot.brand + " · " + snapshot.series + " · " + snapshot.trim + " · " + snapshot.modelYear + " 年款";
  elements.studioStatus.textContent = statusLabels[work.status] || work.status;
  elements.studioStatus.className = elements.workStatus.className;
  const stateCopy = statusDescriptions[work.status] || ["当前作品", "继续完成当前阶段。"];
  elements.stateTitle.textContent = stateCopy[0];
  elements.stateDescription.textContent = stateCopy[1];
  elements.stateCard.className =
    "state-callout" +
    (work.status === "strategy_approved"
      ? " approved"
      : work.status === "awaiting_strategy_approval"
        ? " awaiting"
        : "");
  updateStages(work.status);
  elements.vehicleName.textContent = snapshot.brand + " · " + snapshot.series + " · " + snapshot.trim;
  elements.snapshotId.textContent = snapshot.id;
  elements.vehicleFacts.replaceChildren();
  appendFact(snapshot.modelYear + " 年款");
  Object.entries(snapshot.parameters).forEach(function (entry) {
    appendFact((vehicleParameterLabels[entry[0]] || "车型参数") + "：" + entry[1]);
  });
  appendFact(snapshot.fixedClaims.length + " 个固定卖点");
  appendFact(snapshot.prohibitedClaims.length + " 个禁用表达");

  const strategy = view.strategy;
  if (!strategy) {
    elements.strategySetup.hidden = false;
    elements.strategyEditor.hidden = true;
    renderWorkList();
    refreshActionProposalAvailability();
    return;
  }
  const editable = work.status === "strategy_draft";
  elements.strategySetup.hidden = work.status !== "strategy_draft";
  elements.audience.value = strategy.audience;
  elements.theme.value = strategy.theme;
  elements.strategyEditor.hidden = false;
  elements.strategyVersion.textContent = "版本 " + strategy.version + " · " + view.strategyVersionCount + " 个历史版本";
  elements.validationState.textContent = view.validation.valid ? "事实校验通过" : view.validation.issues.length + " 个校验问题";
  elements.validationState.className = "badge " + (view.validation.valid ? "success" : "invalid");
  renderStrategyItems(strategy, editable);

  elements.saveStrategy.hidden = !editable;
  elements.regenerateStrategy.hidden = !editable;
  elements.requestApproval.hidden = !editable;
  const awaiting = work.status === "awaiting_strategy_approval";
  elements.rejectStrategy.hidden = !awaiting;
  elements.approveStrategy.hidden = !awaiting;
  elements.copyWork.hidden = work.status !== "strategy_approved";
  elements.approvalNote.textContent =
    work.status === "strategy_approved"
      ? "已由人工审核通过；智能助手不能执行批准动作。"
      : awaiting
        ? "策略已冻结，等待审核人员决策。"
        : "锁定的卖点在模型重新生成时不会被覆盖。";
  renderWorkList();
  refreshActionProposalAvailability();
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

async function refreshWorkList(scope = captureWorkspaceScope()) {
  const result = await workspaceApi.listWorks();
  if (!isCurrentWorkspaceScope(scope)) return false;
  state.workSummaries = result.works;
  renderWorkList();
  return true;
}

async function loadWorks(scope = captureWorkspaceScope()) {
  if (!await refreshWorkList(scope)) return false;
  const navigationBrand = selectedNavigationBrand();
  const scopedWorks = state.workSummaries.filter(function (summary) {
    return workSummaryMatchesNavigationBrand(summary, navigationBrand);
  });
  if (scopedWorks.length === 0) {
    renderWork(null);
    return true;
  }
  const saved = localStorage.getItem("firefly.workId");
  const selected = scopedWorks.find(function (summary) { return summary.work.id === saved; }) || scopedWorks[0];
  const view = await workspaceApi.getWork(selected.work.id);
  if (!isCurrentWorkspaceScope(scope)) return false;
  renderWork(view);
  return true;
}

async function runWorkflow(action) {
  if (state.workflowBusy) return;
  clearWorkflowError();
  setWorkflowBusy(true);
  try {
    renderWork(await action());
    await ensureSessionForCurrentWork();
    await refreshWorkList();
  }
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

function appendInlineMarkdown(container, source) {
  const pattern = /(`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))/gu;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > cursor) container.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    if (match[2] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[2];
      container.appendChild(code);
    } else if (match[3] !== undefined || match[4] !== undefined) {
      const strong = document.createElement("strong");
      appendInlineMarkdown(strong, match[3] || match[4]);
      container.appendChild(strong);
    } else if (match[5] !== undefined) {
      const emphasis = document.createElement("em");
      appendInlineMarkdown(emphasis, match[5]);
      container.appendChild(emphasis);
    } else {
      const link = document.createElement("a");
      link.textContent = match[6];
      link.href = match[7];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      container.appendChild(link);
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
}

function tableCells(line) {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map(function (cell) { return cell.trim(); });
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
}

function isMarkdownBlockStart(lines, index) {
  const line = lines[index] || "";
  return /^\s*```/u.test(line)
    || /^\s{0,3}#{1,6}\s+/u.test(line)
    || /^\s{0,3}>\s?/u.test(line)
    || /^\s*[-+*]\s+/u.test(line)
    || /^\s*\d+[.)]\s+/u.test(line)
    || /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)
    || (line.includes("|") && isTableSeparator(lines[index + 1] || ""));
}

function renderMarkdown(container, source) {
  container.replaceChildren();
  container.classList.add("markdown-body");
  const lines = String(source || "").replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) { index += 1; continue; }
    const fence = lines[index].match(/^\s*```([^\s`]*)\s*$/u);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) code.dataset.language = fence[1];
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }
    const heading = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+)$/u);
    if (heading) {
      const node = document.createElement("h" + heading[1].length);
      appendInlineMarkdown(node, heading[2].replace(/\s+#+\s*$/u, ""));
      container.appendChild(node);
      index += 1;
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(lines[index])) {
      container.appendChild(document.createElement("hr"));
      index += 1;
      continue;
    }
    if (/^\s{0,3}>\s?/u.test(lines[index])) {
      const quote = document.createElement("blockquote");
      const quoteLines = [];
      while (index < lines.length && /^\s{0,3}>\s?/u.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/u, ""));
        index += 1;
      }
      renderMarkdown(quote, quoteLines.join("\n"));
      container.appendChild(quote);
      continue;
    }
    const unordered = lines[index].match(/^\s*[-+*]\s+(.+)$/u);
    const ordered = lines[index].match(/^\s*\d+[.)]\s+(.+)$/u);
    if (unordered || ordered) {
      const list = document.createElement(unordered ? "ul" : "ol");
      const itemPattern = unordered ? /^\s*[-+*]\s+(.+)$/u : /^\s*\d+[.)]\s+(.+)$/u;
      let item;
      while (index < lines.length && (item = lines[index].match(itemPattern))) {
        const listItem = document.createElement("li");
        appendInlineMarkdown(listItem, item[1]);
        list.appendChild(listItem);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }
    if (lines[index].includes("|") && isTableSeparator(lines[index + 1] || "")) {
      const headers = tableCells(lines[index]);
      index += 2;
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      headers.forEach(function (header) {
        const cell = document.createElement("th");
        appendInlineMarkdown(cell, header);
        headRow.appendChild(cell);
      });
      head.appendChild(headRow);
      table.appendChild(head);
      const body = document.createElement("tbody");
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const row = document.createElement("tr");
        tableCells(lines[index]).forEach(function (value) {
          const cell = document.createElement("td");
          appendInlineMarkdown(cell, value);
          row.appendChild(cell);
        });
        body.appendChild(row);
        index += 1;
      }
      table.appendChild(body);
      const wrapper = document.createElement("div");
      wrapper.className = "markdown-table-wrap";
      wrapper.appendChild(table);
      container.appendChild(wrapper);
      continue;
    }
    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && (paragraphLines.length === 0 || !isMarkdownBlockStart(lines, index))) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    paragraphLines.forEach(function (line, lineIndex) {
      if (lineIndex > 0) paragraph.appendChild(document.createElement("br"));
      appendInlineMarkdown(paragraph, line);
    });
    container.appendChild(paragraph);
  }
}

function appendMessage(role, text, pending) {
  if (elements.welcome) elements.welcome.hidden = true;
  const row = document.createElement("article");
  row.className = "message " + role + (pending ? " pending" : "");
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  if (role === "assistant" && !pending) renderMarkdown(bubble, text);
  else bubble.textContent = text;
  row.appendChild(bubble);
  elements.messages.appendChild(row);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return row;
}

const toolLabels = {
  get_vehicle_snapshot: "读取车型事实快照",
  validate_vehicle_claims: "校验车型宣传表述",
  propose_strategy_generation: "建议生成卖点策略",
  validate_strategy: "校验卖点策略",
  propose_strategy_approval: "建议提交人工审批",
};

const taskStageLabels = {
  strategy: "营销策略",
  asset_matching: "资产匹配",
  script: "脚本",
  storyboard: "分镜",
  video_preview: "视频预览",
  delivery: "交付",
};

function elapsedSeconds(startedAt) {
  return Math.max(1, Math.round((performance.now() - startedAt) / 1000));
}

function friendlyToolInput(toolName, input) {
  if (toolName === "propose_strategy_generation") {
    const audience = typeof input?.audience === "string" ? input.audience.trim() : "目标人群";
    const theme = typeof input?.theme === "string" ? input.theme.trim() : "当前主题";
    return "正在为“" + audience + "”梳理“" + theme + "”主题的卖点策略。";
  }
  const descriptions = {
    get_vehicle_snapshot: "正在读取当前车型的官方信息，确保后续内容有事实依据。",
    validate_vehicle_claims: "正在核对宣传内容是否符合车型事实与表达规范。",
    validate_strategy: "正在检查卖点策略的事实依据和表达风险。",
    propose_strategy_approval: "正在确认当前策略是否具备提交人工审核的条件。",
  };
  return descriptions[toolName] || "正在处理这一步，请稍候。";
}

function toolOutputText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const parts = [value.code, value.message, value.error]
    .filter(function (part) { return typeof part === "string"; });
  if (Array.isArray(value.content)) {
    value.content.forEach(function (part) {
      if (part && typeof part === "object" && typeof part.text === "string") parts.push(part.text);
    });
  }
  return parts.join(" ");
}

function friendlyToolResult(toolName, event) {
  if (event.status === "cancelled") return "操作已取消，没有产生新的内容。";
  if (event.isError) {
    const output = toolOutputText(event.output);
    if (/awaiting_strategy_approval|等待策略审批/iu.test(output)) {
      return "当前策略已经进入人工审核，无需重复生成。请先完成审核，或退回修改后再重新生成。";
    }
    if (/revision|版本.{0,4}(?:冲突|过期)|stale/iu.test(output)) {
      return "任务内容已经更新，请获取最新状态后再试一次。";
    }
    if (/AIC-AUTH|permission|权限|越权/iu.test(output)) {
      return "当前账号暂时不能执行这一步，请联系任务负责人。";
    }
    if (/not found|未找到/iu.test(output)) {
      return "没有找到这一步需要的内容，请刷新任务后重试。";
    }
    if (event.status === "blocked" || /TOOL_NOT_ALLOWED|blocked|not allowed|策略.{0,8}(?:阻止|拒绝)/iu.test(output)) {
      return "当前任务状态还不能执行这一步。请先完成页面中提示的前置操作。";
    }
    return "这一步暂时没有完成，请稍后重试。";
  }
  const descriptions = {
    get_vehicle_snapshot: "车型信息已读取，后续内容将以这些官方事实为准。",
    validate_vehicle_claims: "宣传内容检查已完成，请查看智能助手说明。",
    propose_strategy_generation: "策略建议已准备好，请在下方确认后再执行。",
    validate_strategy: "策略检查已完成，请查看智能助手说明。",
    propose_strategy_approval: "提交审核的建议已准备好，请在下方确认后再执行。",
  };
  return descriptions[toolName] || "这一步已经完成。";
}

function appendTimelineEvent(turn, className) {
  const event = document.createElement("div");
  event.className = "timeline-event " + className;
  const dot = document.createElement("span");
  dot.className = "timeline-dot";
  dot.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  content.className = "timeline-content";
  event.append(dot, content);
  turn.root.appendChild(event);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return content;
}

function appendThinkingEvent(turn) {
  if (turn.thinking) return;
  const content = appendTimelineEvent(turn, "thinking-event active");
  const details = document.createElement("details");
  details.className = "thinking-details";
  const row = document.createElement("summary");
  row.className = "thinking-row";
  const spinner = document.createElement("span");
  spinner.className = "thinking-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = "正在思考…";
  row.append(spinner, label);
  const safeSummary = document.createElement("p");
  safeSummary.textContent = "模型正在规划下一步动作；隐藏思维链不会展示。";
  details.append(row, safeSummary);
  content.appendChild(details);
  turn.thinking = { content, details, label, safeSummary, startedAt: performance.now() };
}

function finishThinkingEvent(turn) {
  if (!turn.thinking) return;
  const seconds = elapsedSeconds(turn.thinking.startedAt);
  turn.thinking.label.textContent = "思考了 " + seconds + " 秒";
  turn.thinking.safeSummary.textContent = "已完成响应规划与工具选择；为保护安全与隐私，不展示隐藏思维链。";
  turn.thinking.content.parentElement.classList.remove("active");
  const spinner = turn.thinking.content.querySelector(".thinking-spinner");
  if (spinner) spinner.remove();
  turn.thinking = null;
}

function createAgentTurn(startLiveThinking) {
  if (elements.welcome) elements.welcome.hidden = true;
  const root = document.createElement("article");
  root.className = "agent-turn";
  elements.messages.appendChild(root);
  const turn = { root, thinking: null, tools: new Map() };
  if (startLiveThinking !== false) appendThinkingEvent(turn);
  return turn;
}

function appendHistoricalThinkingEvent(turn) {
  const content = appendTimelineEvent(turn, "thinking-event historical");
  const details = document.createElement("details");
  details.className = "thinking-details";
  const summary = document.createElement("summary");
  summary.className = "thinking-row";
  const label = document.createElement("span");
  label.textContent = "思考完成 · 历史记录";
  const safeSummary = document.createElement("p");
  safeSummary.textContent = "该节点由持久化会话记录重建；隐藏思维链不会展示。";
  summary.appendChild(label);
  details.append(summary, safeSummary);
  content.appendChild(details);
}

function addToolEvent(turn, event) {
  finishThinkingEvent(turn);
  const content = appendTimelineEvent(turn, "tool-event active");
  const card = document.createElement("section");
  card.className = "tool-call";
  const summary = document.createElement("div");
  summary.className = "tool-summary";
  const heading = document.createElement("span");
  heading.className = "tool-heading";
  const title = document.createElement("strong");
  title.textContent = toolLabels[event.toolName] || event.toolName;
  heading.appendChild(title);
  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent = "处理中";
  summary.append(heading, status);
  const description = document.createElement("p");
  description.className = "tool-description";
  description.textContent = friendlyToolInput(event.toolName, event.input);
  card.append(summary, description);
  content.appendChild(card);
  turn.tools.set(event.toolCallId, {
    content,
    card,
    status,
    description,
    toolName: event.toolName,
  });
}

function proposalEndpoint(proposal) {
  if (!state.work) return null;
  if (proposal.videoTaskId && proposal.videoTaskId !== state.work.work.id) return null;
  const workId = encodeURIComponent(state.work.work.id);
  return proposal.action === "generate_strategy"
    ? "/v1/works/" + workId + "/strategy/generate"
    : "/v1/works/" + workId + "/strategy/approval-request";
}

function proposalResultText(proposal, view) {
  const strategy = view.strategy;
  if (proposal.action === "generate_strategy") {
    if (!strategy) return "后端已接受操作，但尚未返回策略产物；请刷新作品后重试。";
    return "已生成策略 v" + strategy.version + "，共 " + strategy.items.length + " 条卖点，任务内容已同步更新。";
  }
  return "已提交人工审批，当前状态：" + (statusLabels[view.work.status] || view.work.status) + "。";
}

async function executeActionProposal(card, proposal) {
  const button = card.querySelector("button");
  const status = card.querySelector(".agent-action-status");
  const result = card.querySelector(".agent-action-result");
  const endpoint = proposalEndpoint(proposal);
  if (!button || !status || !result || !endpoint || !state.work) return;
  if (proposal.videoTaskId && proposal.videoTaskId !== state.work.work.id) {
    status.textContent = "任务不匹配";
    result.textContent = "该操作卡片属于其他视频任务，不能在当前任务执行。";
    result.hidden = false;
    button.disabled = true;
    card.classList.add("stale");
    return;
  }
  if (state.work.work.revision !== proposal.expectedRevision) {
    status.textContent = "已失效";
    result.textContent = "任务内容已经更新，请让智能助手基于最新状态重新建议。";
    button.disabled = true;
    card.classList.add("stale");
    return;
  }
  clearWorkflowError();
  setWorkflowBusy(true);
  button.disabled = true;
  status.textContent = "执行中…";
  result.hidden = true;
  delete card.dataset.executionBlocked;
  card.classList.remove("failed");
  try {
    const view = await api(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agentActionRequestBody(proposal)),
    });
    renderWork(view);
    await refreshWorkList();
    status.textContent = "已执行";
    result.textContent = proposalResultText(proposal, view);
    result.hidden = false;
    card.dataset.executed = "true";
    card.classList.add("completed");
    elements.messages.scrollTop = elements.messages.scrollHeight;
  } catch (error) {
    const failure = agentActionFailurePresentation(error);
    status.textContent = failure.status;
    result.textContent = failure.message;
    result.hidden = false;
    card.dataset.executionBlocked = failure.blocksCard ? "true" : "false";
    card.classList.toggle("stale", failure.stale);
    card.classList.add("failed");
    showWorkflowError(error);
    button.disabled = failure.blocksCard;
  } finally {
    setWorkflowBusy(false);
  }
}

function appendActionProposal(turn, proposal) {
  const content = appendTimelineEvent(turn, "action-event");
  const card = document.createElement("section");
  card.className = "agent-action-card";
  card.dataset.action = proposal.action;
  card.dataset.expectedRevision = String(proposal.expectedRevision);
  card.dataset.videoTaskId = proposal.videoTaskId || "";
  const header = document.createElement("div");
  header.className = "agent-action-header";
  const copy = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.textContent = "需要负责人确认";
  const title = document.createElement("strong");
  title.textContent = proposal.label;
  copy.append(eyebrow, title);
  const status = document.createElement("span");
  status.className = "agent-action-status";
  status.textContent = "待确认";
  header.append(copy, status);
  const summary = document.createElement("p");
  summary.textContent = proposal.summary;
  const meta = document.createElement("p");
  meta.className = "agent-action-meta";
  const costText = proposal.cost?.kind === "estimated"
    ? " · 预计 " + proposal.cost.amount + " " + proposal.cost.currency
    : proposal.cost?.kind === "estimate_required"
      ? " · 执行前需重新估价"
      : " · 免费";
  meta.textContent = "已绑定当前任务" + costText + "；点击前不会写入任何内容。";
  const result = document.createElement("p");
  result.className = "agent-action-result";
  result.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button primary agent-action-button";
  button.textContent = proposal.action === "generate_strategy" ? "确认生成策略" : "确认提交人工审批";
  button.addEventListener("click", function () { void executeActionProposal(card, proposal); });
  card.append(header, summary, meta, result, button);
  content.appendChild(card);
  refreshActionProposalAvailability();
}

function refreshActionProposalAvailability() {
  document.querySelectorAll(".agent-action-card").forEach(function (card) {
    if (card.dataset.executed === "true") return;
    const button = card.querySelector("button");
    const status = card.querySelector(".agent-action-status");
    const result = card.querySelector(".agent-action-result");
    if (!button || !status || !result) return;
    const availability = agentActionAvailability({
      videoTaskId: card.dataset.videoTaskId,
      expectedRevision: Number(card.dataset.expectedRevision),
    }, state.work?.work.id, state.work?.work.revision, state.workflowBusy, card.dataset.executionBlocked === "true");
    button.disabled = !availability.enabled;
    card.classList.toggle("stale", availability.stale);
    if (availability.stale) {
      status.textContent = "已失效";
      result.textContent = availability.reason;
      result.hidden = false;
    }
  });
}

function finishToolEvent(turn, event, resumeThinking) {
  const tool = turn.tools.get(event.toolCallId);
  if (!tool) return;
  tool.content.parentElement.classList.remove("active");
  tool.content.parentElement.classList.toggle("failed", Boolean(event.isError));
  tool.status.textContent = event.status === "blocked"
    ? "暂未执行"
    : event.status === "cancelled"
      ? "已取消"
    : event.isError
    ? "未完成"
    : event.historical
      ? "已完成"
    : event.durationMs === undefined
      ? "已完成"
      : "已完成";
  tool.description.textContent = friendlyToolResult(tool.toolName, event);
  const isProposalTool = tool.toolName === "propose_strategy_generation"
    || tool.toolName === "propose_strategy_approval";
  const proposal = event.isError || !isProposalTool ? undefined : extractAgentActionCard(event.output);
  const proposalMatchesTool = proposal
    && ((tool.toolName === "propose_strategy_generation" && proposal.action === "generate_strategy")
      || (tool.toolName === "propose_strategy_approval" && proposal.action === "request_strategy_approval"));
  if (proposalMatchesTool) appendActionProposal(turn, proposal);
  if (resumeThinking !== false) appendThinkingEvent(turn);
}

function finishAgentTurn(turn, text) {
  finishThinkingEvent(turn);
  const content = appendTimelineEvent(turn, "answer-event");
  const answer = document.createElement("div");
  answer.className = "timeline-answer";
  renderMarkdown(answer, text || "智能助手未返回内容。");
  content.appendChild(answer);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function updateStreamingAnswer(turn, liveAnswer, text) {
  let current = liveAnswer;
  if (!current) {
    finishThinkingEvent(turn);
    const content = appendTimelineEvent(turn, "answer-event active");
    const answer = document.createElement("div");
    answer.className = "timeline-answer streaming-answer";
    content.appendChild(answer);
    current = { content, answer };
  }
  current.answer.textContent = text;
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return current;
}

function completeStreamingAnswer(liveAnswer, text) {
  if (!liveAnswer) return false;
  liveAnswer.content.parentElement.classList.remove("active");
  liveAnswer.answer.classList.remove("streaming-answer");
  renderMarkdown(liveAnswer.answer, text || "智能助手未返回内容。");
  return true;
}

function failAgentTurn(turn, message) {
  finishThinkingEvent(turn);
  const content = appendTimelineEvent(turn, "failure-event failed");
  const failure = document.createElement("div");
  failure.className = "timeline-failure";
  failure.textContent = message;
  content.appendChild(failure);
}

function clearMessages() {
  elements.messages.querySelectorAll(".message, .agent-turn").forEach(function (node) { node.remove(); });
  if (elements.welcome) elements.welcome.hidden = false;
}

function assistantToolCalls(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter(function (part) {
    return part && part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string";
  });
}

function restoreTranscriptTimeline(messages) {
  clearMessages();
  let turn = null;
  messages.forEach(function (message) {
    if (message.role === "user") {
      const text = messageText(message);
      if (text) appendMessage("user", text, false);
      turn = createAgentTurn(false);
      return;
    }
    if (message.role === "assistant") {
      if (!turn) turn = createAgentTurn(false);
      const calls = assistantToolCalls(message);
      appendHistoricalThinkingEvent(turn);
      if (calls.length > 0) {
        calls.forEach(function (call) {
          addToolEvent(turn, {
            toolName: call.name,
            toolCallId: call.id,
            input: call.arguments,
            historical: true,
          });
        });
        return;
      }
      const text = messageText(message);
      if (text) finishAgentTurn(turn, text);
      turn = null;
      return;
    }
    if (message.role === "toolResult" && turn) {
      finishToolEvent(turn, {
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        output: message.details === undefined ? message.content : message.details,
        isError: Boolean(message.isError),
        historical: true,
      }, false);
    }
  });
}

function sessionStorageKey(videoTaskId) {
  return "firefly.sessionId." + (state.account?.accountId || "anonymous") + "." + (videoTaskId || "unbound");
}

function compareSessions(left, right) {
  return String(right.updatedAt).localeCompare(String(left.updatedAt))
    || String(right.createdAt).localeCompare(String(left.createdAt))
    || String(left.id).localeCompare(String(right.id));
}

function renderSessionOptions() {
  elements.sessionSelect.replaceChildren();
  state.sessions.forEach(function (session, index) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = (index === 0 ? "最近会话" : "历史会话 " + (index + 1)) + " · " + session.messageCount + " 条消息";
    option.title = session.id;
    elements.sessionSelect.appendChild(option);
  });
  if (state.sessionId && state.sessions.some(function (session) { return session.id === state.sessionId; })) {
    elements.sessionSelect.value = state.sessionId;
  }
  elements.sessionSelect.disabled = state.busy || state.sessions.length === 0;
}

function renderAccount() {
  elements.agentAccountSelect.replaceChildren();
  state.accounts.forEach(function (account) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.textContent = account.displayName;
    option.title = account.displayName + " · " + (roleLabels[account.role] || "未知角色");
    elements.agentAccountSelect.appendChild(option);
  });
  if (state.accounts.length === 0) {
    const option = document.createElement("option");
    option.textContent = "账号不可用";
    elements.agentAccountSelect.appendChild(option);
  }
  if (state.account) elements.agentAccountSelect.value = state.account.accountId;
  elements.agentAccountSelect.disabled = state.busy || state.workflowBusy || state.workspaceHydrating || state.accounts.length < 2;
  elements.agentAccountRole.textContent = state.account ? roleLabels[state.account.role] || "未知角色" : "—";
  const displayName = state.account?.displayName || "";
  elements.accountAvatar.textContent = Array.from(displayName.trim())[0] || "账";
}

function renderNavigationBrands() {
  elements.brandNavigation.replaceChildren();
  elements.brandNavigation.setAttribute("aria-busy", String(state.navigationBrandsLoading));
  elements.brandNavigationRetry.hidden = !state.navigationBrandsError;
  elements.brandNavigationStatus.hidden = true;
  elements.brandNavigationStatus.textContent = "";

  if (state.navigationBrandsLoading) {
    const option = document.createElement("option");
    option.textContent = "品牌加载中";
    elements.brandNavigation.appendChild(option);
    elements.brandNavigation.disabled = true;
    return;
  }

  if (state.navigationBrandsError || state.navigationBrands.length === 0) {
    const message = state.navigationBrandsError || "暂无可访问品牌";
    const option = document.createElement("option");
    option.textContent = message;
    elements.brandNavigation.appendChild(option);
    elements.brandNavigation.disabled = true;
    elements.brandNavigationStatus.textContent = message;
    elements.brandNavigationStatus.hidden = false;
    return;
  }

  state.navigationBrands.forEach(function (brand) {
    const option = document.createElement("option");
    option.value = brand.id;
    option.textContent = brand.name;
    elements.brandNavigation.appendChild(option);
  });
  elements.brandNavigation.value = state.navigationBrandId || "";
  elements.brandNavigation.disabled = state.busy || state.workflowBusy || state.workspaceHydrating;
}

function clearNavigationBrands() {
  navigationBrandsRequest += 1;
  state.navigationBrands = [];
  state.navigationBrandId = null;
  state.navigationBrandsLoading = true;
  state.navigationBrandsError = null;
  renderNavigationBrands();
}

function navigationBrandsFailureMessage(error) {
  if (error && error.status === 401) return "账号会话已失效";
  if (error && error.status === 403) return "当前账号无品牌访问权限";
  return "品牌加载失败";
}

async function loadNavigationBrands() {
  const account = state.account;
  const request = ++navigationBrandsRequest;
  state.navigationBrands = [];
  state.navigationBrandId = null;
  state.navigationBrandsLoading = true;
  state.navigationBrandsError = null;
  renderNavigationBrands();
  if (!account) {
    state.navigationBrandsLoading = false;
    state.navigationBrandsError = "账号不可用";
    renderNavigationBrands();
    return;
  }

  try {
    const response = account.role === "content_admin"
      ? await workspaceApi.listAdminBrands()
      : account.role === "creator"
        ? await workspaceApi.getProjectCreationOptions()
        : { brands: [] };
    if (request !== navigationBrandsRequest || state.account?.accountId !== account.accountId) return;
    state.navigationBrands = normalizeNavigationBrands(account.role, response);
    const preferredBrandId = localStorage.getItem(navigationBrandStorageKey(account.accountId));
    state.navigationBrandId = resolveNavigationBrandId(state.navigationBrands, preferredBrandId);
    if (state.navigationBrandId) {
      localStorage.setItem(navigationBrandStorageKey(account.accountId), state.navigationBrandId);
    }
  } catch (error) {
    if (request !== navigationBrandsRequest || state.account?.accountId !== account.accountId) return;
    state.navigationBrandsError = navigationBrandsFailureMessage(error);
  } finally {
    if (request !== navigationBrandsRequest || state.account?.accountId !== account.accountId) return;
    state.navigationBrandsLoading = false;
    renderNavigationBrands();
  }
}

async function selectNavigationBrand(brandId) {
  if (state.navigationBrandsLoading || !state.account || state.busy || state.workflowBusy || state.workspaceHydrating) return;
  if (!state.navigationBrands.some(function (brand) { return brand.id === brandId; })) return;
  if (state.navigationBrandId === brandId) return;
  clearError();
  clearWorkflowError();
  state.workspaceHydrating = true;
  workspaceScopeGeneration += 1;
  state.navigationBrandId = brandId;
  localStorage.setItem(navigationBrandStorageKey(state.account.accountId), brandId);
  const scope = captureWorkspaceScope();
  setBusy(true);
  setWorkflowBusy(true);
  resetWorkspaceContext();
  renderNavigationBrands();
  try {
    if (!await loadWorks(scope) || !isCurrentWorkspaceScope(scope)) return;
    await restoreSession(scope);
  } catch (error) {
    if (isCurrentWorkspaceScope(scope)) showError(error);
  } finally {
    if (isCurrentWorkspaceScope(scope)) {
      state.workspaceHydrating = false;
      setWorkflowBusy(false);
      setBusy(false);
      renderAccount();
      renderNavigationBrands();
    }
  }
}

function retryNavigationBrands() {
  if (state.busy || state.workflowBusy) return;
  void loadNavigationBrands();
}

function renderAgentBudget(presentation) {
  elements.agentContextQuota.textContent = presentation.text;
  elements.agentContextQuota.title = presentation.title || "";
}

async function refreshAgentBudget() {
  const accountId = state.account?.accountId;
  if (!accountId) {
    renderAgentBudget({ text: "额度：—", title: "" });
    return;
  }
  renderAgentBudget({ text: "额度：正在读取…", title: "" });
  try {
    const body = await agentApi.getOwnBudget();
    if (state.account?.accountId !== accountId) return;
    renderAgentBudget(agentBudgetPresentation(body.budget, accountId));
  } catch {
    if (state.account?.accountId !== accountId) return;
    renderAgentBudget({
      text: "额度：暂时无法读取",
      title: "额度查询失败，请稍后重试。高消耗操作仍以后端校验结果为准。",
    });
  }
}

function renderTaskContext(context) {
  elements.agentContextBrand.textContent = context?.brand.name || "—";
  elements.agentContextVehicle.textContent = context?.vehicle.displayName || "—";
  elements.agentContextProject.textContent = context?.batchProject.name || "—";
  elements.agentContextTask.textContent = context?.videoTask.name || "—";
  elements.agentContextBrand.title = context?.brand.name || "";
  elements.agentContextVehicle.title = context?.vehicle.displayName || "";
  elements.agentContextProject.title = context?.batchProject.name || "";
  elements.agentContextTask.title = context?.videoTask.name || "";
  if (!context) {
    elements.agentContextOwner.textContent = "负责人：—";
    elements.agentContextStage.textContent = "未开始";
    elements.agentContextRevision.textContent = "—";
    return;
  }
  const ownership = context.videoTask.ownership;
  if (ownership.state === "owned_by_current_account") {
    elements.agentContextOwner.textContent = "负责人：当前账号" + (state.account ? "（" + state.account.displayName + "）" : "");
  } else if (ownership.state === "owned_by_other_account") {
    elements.agentContextOwner.textContent = "负责人：" + ownership.ownerDisplayName;
  } else {
    elements.agentContextOwner.textContent = "负责人：待分配";
  }
  elements.agentContextStage.textContent = taskStageLabels[context.videoTask.currentStage] || context.videoTask.currentStage;
  elements.agentContextRevision.textContent = "任务版本 " + context.videoTask.revision;
}

function updateSession(summary) {
  state.sessionId = summary.id;
  state.sessionVideoTaskId = summary.videoTaskId || null;
  state.taskContext = summary.taskContext || null;
  localStorage.setItem("firefly.sessionId", summary.id);
  localStorage.setItem(sessionStorageKey(summary.videoTaskId || null), summary.id);
  state.sessions = [summary].concat(state.sessions.filter(function (session) {
    return session.id !== summary.id && (session.videoTaskId || null) === (summary.videoTaskId || null);
  })).sort(compareSessions);
  renderSessionOptions();
  elements.sessionId.textContent = summary.id;
  elements.sessionWork.textContent = summary.videoTaskId ? shortWorkId(summary.videoTaskId) : "未绑定";
  elements.sessionWork.title = summary.videoTaskId || "";
  renderTaskContext(summary.taskContext || null);
  const toolNames = Array.isArray(summary.toolNames) ? summary.toolNames : [];
  elements.agentTools.textContent = summary.domainToolsLoaded ? toolNames.length + " 个已加载" : "未加载";
  elements.agentTools.title = toolNames.join("、");
}

async function createSession(videoTaskId, scope = captureWorkspaceScope()) {
  const selectedVideoTaskId = videoTaskId === undefined ? state.work?.work.id : videoTaskId;
  const body = await agentApi.createSession(selectedVideoTaskId);
  if (!isCurrentWorkspaceScope(scope) || (state.work?.work.id || null) !== (selectedVideoTaskId || null)) return false;
  updateSession(body.session);
  clearMessages();
  return true;
}

async function loadTaskSessions(videoTaskId, scope = captureWorkspaceScope()) {
  const body = await agentApi.listSessions(videoTaskId);
  if (!isCurrentWorkspaceScope(scope) || state.work?.work.id !== videoTaskId) return false;
  state.sessions = Array.isArray(body.sessions) ? body.sessions.slice().sort(compareSessions) : [];
  renderSessionOptions();
  return true;
}

async function activateSession(sessionId, scope = captureWorkspaceScope()) {
  const selectedVideoTaskId = state.work?.work.id || null;
  const body = await agentApi.getSession(sessionId, selectedVideoTaskId);
  if (!isCurrentWorkspaceScope(scope) || (state.work?.work.id || null) !== selectedVideoTaskId) return false;
  if ((body.session.videoTaskId || null) !== selectedVideoTaskId) {
    throw new Error("该助手会话不属于当前任务，已拒绝切换。");
  }
  updateSession(body.session);
  const transcript = await agentApi.getTranscript(sessionId, selectedVideoTaskId);
  if (!isCurrentWorkspaceScope(scope) || state.sessionId !== sessionId || (state.work?.work.id || null) !== selectedVideoTaskId) return false;
  restoreTranscriptTimeline(transcript.messages);
  return true;
}

async function selectSession(sessionId) {
  if (state.busy || !sessionId || sessionId === state.sessionId) return;
  clearError();
  setBusy(true);
  try {
    await activateSession(sessionId);
    state.lastPrompt = "";
    elements.retryMessage.hidden = true;
  } catch (error) {
    showError(error);
    renderSessionOptions();
  } finally {
    setBusy(false);
    elements.prompt.focus();
  }
}

async function restoreSessionForCurrentWork(scope = captureWorkspaceScope()) {
  const videoTaskId = state.work?.work.id || null;
  if (!videoTaskId) {
    if (!isCurrentWorkspaceScope(scope)) return false;
    state.sessions = [];
    renderSessionOptions();
    clearMessages();
    setBusy(state.busy);
    return true;
  }
  if (!await loadTaskSessions(videoTaskId, scope)) return false;
  const taskSaved = localStorage.getItem(sessionStorageKey(videoTaskId));
  const legacySaved = localStorage.getItem("firefly.sessionId");
  const selected = state.sessions.find(function (session) { return session.id === taskSaved; })
    || state.sessions.find(function (session) { return session.id === legacySaved; })
    || state.sessions[0];
  if (selected) return activateSession(selected.id, scope);
  return createSession(videoTaskId, scope);
}

async function ensureSessionForCurrentWork() {
  const videoTaskId = state.work?.work.id || null;
  if (state.sessionId && state.sessionVideoTaskId === videoTaskId) return;
  await restoreSession();
}

async function restoreSession(scope = captureWorkspaceScope()) {
  try {
    return await restoreSessionForCurrentWork(scope);
  } catch {
    if (!isCurrentWorkspaceScope(scope)) return false;
    const videoTaskId = state.work?.work.id || null;
    localStorage.removeItem(sessionStorageKey(videoTaskId));
    state.sessions = [];
    return createSession(videoTaskId || undefined, scope);
  }
}

function applyWorkspaceSession(session) {
  if (session.token) {
    setWorkspaceSessionToken(session.token);
    sessionStorage.setItem("firefly.workspaceSession", session.token);
  }
  state.account = session.account;
  workspaceScopeGeneration += 1;
  localStorage.setItem("firefly.accountId", session.account.accountId);
  renderAccount();
}

async function initializeWorkspaceAccount() {
  let accountsBody;
  try {
    accountsBody = await authApi.listDevelopmentAccounts();
  } catch {
    state.accounts = [];
    state.account = null;
    renderAccount();
    throw new Error("开发账号切换暂不可用。");
  }
  state.accounts = Array.isArray(accountsBody.accounts) ? accountsBody.accounts : [];
  if (state.accounts.length === 0) throw new Error("当前没有可用的工作区账号。");
  const storedToken = sessionStorage.getItem("firefly.workspaceSession");
  if (storedToken) {
    setWorkspaceSessionToken(storedToken);
    try {
      applyWorkspaceSession((await authApi.getSession()).session);
      await refreshAgentBudget();
      return;
    } catch {
      setWorkspaceSessionToken(null);
      sessionStorage.removeItem("firefly.workspaceSession");
    }
  }
  const savedAccountId = localStorage.getItem("firefly.accountId");
  const selected = state.accounts.find(function (account) { return account.accountId === savedAccountId; })
    || state.accounts.find(function (account) { return account.role === "creator"; })
    || state.accounts[0];
  applyWorkspaceSession((await authApi.createOrSwitchSession(selected.accountId)).session);
  await refreshAgentBudget();
}

async function switchWorkspaceAccount(accountId) {
  if (!accountId || accountId === state.account?.accountId || state.busy || state.workflowBusy || state.workspaceHydrating) return;
  const previousNavigation = {
    brands: state.navigationBrands,
    brandId: state.navigationBrandId,
    loading: state.navigationBrandsLoading,
    error: state.navigationBrandsError,
  };
  let sessionSwitched = false;
  clearError();
  clearWorkflowError();
  state.workspaceHydrating = true;
  workspaceScopeGeneration += 1;
  setBusy(true);
  setWorkflowBusy(true);
  renderAccount();
  clearNavigationBrands();
  let scope = captureWorkspaceScope();
  try {
    applyWorkspaceSession((await authApi.createOrSwitchSession(accountId)).session);
    scope = captureWorkspaceScope();
    sessionSwitched = true;
    resetWorkspaceContext();
    await Promise.all([refreshAgentBudget(), loadNavigationBrands()]);
    if (!await loadWorks(scope) || !isCurrentWorkspaceScope(scope)) return;
    await restoreSession(scope);
  } catch (error) {
    if (isCurrentWorkspaceScope(scope)) showError(error);
    renderAccount();
    if (!sessionSwitched) {
      state.navigationBrands = previousNavigation.brands;
      state.navigationBrandId = previousNavigation.brandId;
      state.navigationBrandsLoading = previousNavigation.loading;
      state.navigationBrandsError = previousNavigation.error;
      renderNavigationBrands();
    }
  } finally {
    if (isCurrentWorkspaceScope(scope)) {
      state.workspaceHydrating = false;
      setWorkflowBusy(false);
      setBusy(false);
      renderAccount();
      renderNavigationBrands();
    }
  }
}

async function initialize() {
  state.workspaceHydrating = true;
  renderAccount();
  try {
    const meta = await api("/v1/meta");
    if (!Array.isArray(meta.capabilities) || !meta.capabilities.includes("task_context_v1")) {
      throw new Error("服务版本较旧，请重启服务后刷新页面。");
    }
    elements.provider.textContent = meta.model.provider;
    elements.model.textContent = meta.model.modelId;
    state.modelReady = Boolean(meta.model.credentialsConfigured);
    await initializeWorkspaceAccount();
    await loadNavigationBrands();
    const scope = captureWorkspaceScope();
    if (!await loadWorks(scope) || !isCurrentWorkspaceScope(scope)) return;
    await restoreSession(scope);
    if (state.modelReady) {
      setStatus("online", "服务正常");
      elements.prompt.focus();
    } else {
      setStatus("warning", "等待模型密钥");
      elements.prompt.placeholder = "请先配置模型服务";
      setBusy(false);
      showError(new Error("模型服务尚未配置，请配置后重启服务。"));
    }
  } catch (error) {
    setStatus("error", "连接失败");
    showError(error);
  } finally {
    state.workspaceHydrating = false;
    renderAccount();
    renderNavigationBrands();
  }
}

async function sendMessage(text) {
  const message = text.trim();
  if (!message || state.busy || !state.sessionId) return;
  state.lastPrompt = message;
  elements.retryMessage.hidden = true;
  clearError();
  setBusy(true);
  appendMessage("user", message, false);
  elements.prompt.value = "";
  elements.prompt.style.height = "auto";
  const turn = createAgentTurn();
  let streamedText = "";
  let liveAnswer = null;
  try {
    const result = await agentApi.streamMessage(
      state.sessionId,
      message,
      {
        videoTaskId: state.sessionVideoTaskId,
        onRunStarted: function (run) {
          state.activeRunId = run.runId;
        },
        onConnectionState: function (connectionState) {
          if (connectionState === "reconnecting") setStatus("warning", "正在恢复连接");
          if (connectionState === "connected") setStatus("online", "服务正常");
        },
        onEvent: function (event) {
          if (event.type === "thinking_status" && event.status === "completed") finishThinkingEvent(turn);
          if (event.type === "text_delta") {
            streamedText += event.delta;
            liveAnswer = updateStreamingAnswer(turn, liveAnswer, streamedText);
          }
          if (event.type === "tool_status" && event.status === "running") addToolEvent(turn, event);
          if (event.type === "tool_status" && event.status !== "running") {
            finishToolEvent(turn, {
              ...event,
              isError: event.status !== "succeeded",
            });
          }
          if (event.type === "action_card") appendActionProposal(turn, event.card);
        },
      },
    );
    if (result.stopReason === "aborted") {
      failAgentTurn(turn, "已取消当前生成。");
    } else if (!completeStreamingAnswer(liveAnswer, result.assistantText)) {
      finishAgentTurn(turn, result.assistantText);
    }
    updateSession(result.session);
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    const messageText = cancelled ? "已取消当前生成。" : error instanceof Error ? error.message : "智能助手请求失败。";
    failAgentTurn(turn, messageText);
    if (!cancelled) {
      showError(error);
      elements.retryMessage.hidden = false;
    }
  } finally {
    state.activeRunId = null;
    elements.cancelGeneration.disabled = false;
    setBusy(false);
    elements.prompt.focus();
  }
}

bindAgentPanel({
  elements,
  state,
  sendMessage,
  createSession,
  selectSession,
  updateSession,
  clearMessages,
  clearError,
  showError,
  setBusy,
});

bindWorkspaceShell({
  elements,
  state,
  renderWorkList,
  selectNavigationBrand,
  retryNavigationBrands,
});

elements.agentAccountSelect.addEventListener("change", function () {
  void switchWorkspaceAccount(elements.agentAccountSelect.value);
});

function createGoldenWork() {
  return workspaceApi.createWork({
    vehicleId: "vehicle_firefly_e5_2026_long_range",
    color: "萤火绿",
    region: "中国大陆",
    campaignDate: new Date().toISOString().slice(0, 10),
    name: "黄金样例家庭出行广告",
  });
}

function startNewWork() {
  void runWorkflow(createGoldenWork);
}

elements.createWork.addEventListener("click", startNewWork);
elements.newWork.addEventListener("click", startNewWork);
elements.stateNewWork.addEventListener("click", startNewWork);

function generateStrategy() {
  return workspaceApi.generateStrategy(state.work.work.id, {
    expectedRevision: state.work.work.revision,
    audience: elements.audience.value.trim(),
    theme: elements.theme.value.trim(),
  });
}

elements.generateStrategy.addEventListener("click", function () { void runWorkflow(generateStrategy); });
elements.regenerateStrategy.addEventListener("click", function () { void runWorkflow(generateStrategy); });

elements.saveStrategy.addEventListener("click", function () {
  void runWorkflow(function () {
    return workspaceApi.updateStrategy(state.work.work.id, {
      expectedRevision: state.work.work.revision,
      audience: elements.audience.value.trim(),
      theme: elements.theme.value.trim(),
      items: collectStrategyItems(),
    });
  });
});

elements.requestApproval.addEventListener("click", function () {
  void runWorkflow(function () {
    return workspaceApi.requestStrategyApproval(state.work.work.id, { expectedRevision: state.work.work.revision });
  });
});

function decideStrategy(decision) {
  return workspaceApi.decideStrategy(state.work.work.id, {
    expectedRevision: state.work.work.revision,
    decision: decision,
    comment: decision === "approved" ? "本地竖切人工验收通过" : "请修改后重新提交",
  });
}

elements.approveStrategy.addEventListener("click", function () { void runWorkflow(function () { return decideStrategy("approved"); }); });
elements.rejectStrategy.addEventListener("click", function () { void runWorkflow(function () { return decideStrategy("rejected"); }); });
elements.copyWork.addEventListener("click", function () {
  if (!state.work) return;
  void runWorkflow(function () {
    return workspaceApi.copyWork(state.work.work.id, { expectedRevision: state.work.work.revision });
  });
});

void initialize();
