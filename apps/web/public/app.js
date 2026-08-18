import { agentApi } from "./agent-api.js";
import { bindAgentPanel } from "./agent-panel.js";
import { api } from "./api-client.js";
import { workspaceApi } from "./workspace-api.js";
import { bindWorkspaceShell } from "./workspace-shell.js";

const state = {
  sessionId: null,
  sessionWorkId: null,
  busy: false,
  work: null,
  workSummaries: [],
  workflowBusy: false,
  workFilter: "",
  modelReady: true,
};
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
  resetSession: document.querySelector("#reset-session"),
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
  agentContextName: document.querySelector("#agent-context-name"),
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
  elements.prompt.disabled = busy || !state.modelReady;
  elements.send.disabled = busy || !state.modelReady;
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
    elements.copyWork,
    elements.newWork,
    elements.stateNewWork,
  ].forEach(function (button) { button.disabled = busy; });
  elements.workList.querySelectorAll("button").forEach(function (button) { button.disabled = busy; });
  refreshActionProposalAvailability();
}

function shortWorkId(workId) {
  return workId.length > 18 ? workId.slice(0, 13) + "…" : workId;
}

function renderWorkList() {
  elements.workList.replaceChildren();
  const normalizedFilter = state.workFilter.trim().toLocaleLowerCase("zh-CN");
  const visibleWorks = state.workSummaries.filter(function (summary) {
    if (!normalizedFilter) return true;
    const searchable = [summary.work.name, summary.work.id, summary.vehicle.brand, summary.vehicle.series, summary.vehicle.trim]
      .filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
    return searchable.includes(normalizedFilter);
  });
  if (visibleWorks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "work-list-empty";
    empty.textContent = state.workSummaries.length === 0
      ? "还没有项目，点击右上角＋开始。"
      : "没有匹配的项目，请换个关键词。";
    elements.workList.appendChild(empty);
    return;
  }
  visibleWorks.forEach(function (summary) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "work-list-item" + (state.work && state.work.work.id === summary.work.id ? " active" : "");
    button.dataset.workId = summary.work.id;
    button.title = summary.work.id;
    button.setAttribute("aria-label", "打开作品 " + shortWorkId(summary.work.id));
    const title = document.createElement("strong");
    title.textContent = summary.vehicle.series + " · " + summary.vehicle.trim;
    const meta = document.createElement("span");
    const status = document.createElement("b");
    status.textContent = statusLabels[summary.work.status] || summary.work.status;
    const revision = document.createElement("i");
    revision.textContent = shortWorkId(summary.work.id) + " · r" + summary.work.revision;
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
    elements.studioWorkDescription.textContent = "从可信车型快照开始，逐步完成策略、脚本、分镜与成片。";
    elements.studioStatus.textContent = "未开始";
    elements.studioStatus.className = "badge neutral";
    elements.agentContextName.textContent = "尚未绑定项目";
    updateStages(null);
    renderWorkList();
    refreshActionProposalAvailability();
    return;
  }
  const work = view.work;
  const snapshot = view.vehicleSnapshot;
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
  elements.agentContextName.textContent = displayName;
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
  Object.entries(snapshot.parameters).forEach(function (entry) { appendFact(entry[0] + "：" + entry[1]); });
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
  elements.strategyVersion.textContent = "v" + strategy.version + " · " + view.strategyVersionCount + " 个历史版本";
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
      ? "已由人工审核通过；Agent 无法执行该批准动作。"
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

async function refreshWorkList() {
  const result = await workspaceApi.listWorks();
  state.workSummaries = result.works;
  renderWorkList();
}

async function loadWorks() {
  await refreshWorkList();
  if (state.workSummaries.length === 0) {
    renderWork(null);
    return;
  }
  const saved = localStorage.getItem("firefly.workId");
  const selected = state.workSummaries.find(function (summary) { return summary.work.id === saved; }) || state.workSummaries[0];
  const view = await workspaceApi.getWork(selected.work.id);
  renderWork(view);
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

function elapsedSeconds(startedAt) {
  return Math.max(1, Math.round((performance.now() - startedAt) / 1000));
}

function payloadText(value) {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return "[无法显示此结果]"; }
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
  const details = document.createElement("details");
  details.className = "tool-call";
  details.open = true;
  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  heading.className = "tool-heading";
  const title = document.createElement("strong");
  title.textContent = toolLabels[event.toolName] || event.toolName;
  const name = document.createElement("code");
  name.textContent = event.toolName;
  heading.append(title, name);
  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent = "运行中";
  summary.append(heading, status);
  const io = document.createElement("div");
  io.className = "tool-io";
  const inputRow = document.createElement("div");
  inputRow.className = "tool-io-row";
  const inputLabel = document.createElement("span");
  inputLabel.textContent = "IN";
  const input = document.createElement("pre");
  input.textContent = payloadText(event.input);
  inputRow.append(inputLabel, input);
  const outputRow = document.createElement("div");
  outputRow.className = "tool-io-row output";
  const outputLabel = document.createElement("span");
  outputLabel.textContent = "OUT";
  const output = document.createElement("pre");
  output.textContent = "等待工具返回…";
  outputRow.append(outputLabel, output);
  io.append(inputRow, outputRow);
  details.append(summary, io);
  content.appendChild(details);
  turn.tools.set(event.toolCallId, {
    content,
    details,
    status,
    output,
    toolName: event.toolName,
    input: event.input,
  });
}

function extractActionProposal(value) {
  const candidates = [value, value && typeof value === "object" ? value.details : undefined];
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    value.content.forEach(function (part) {
      if (!part || part.type !== "text" || typeof part.text !== "string") return;
      try { candidates.push(JSON.parse(part.text)); } catch {}
    });
  }
  return candidates.find(function (candidate) {
    return candidate
      && typeof candidate === "object"
      && candidate.schemaVersion === 1
      && candidate.kind === "action_proposal"
      && (candidate.action === "generate_strategy" || candidate.action === "request_strategy_approval")
      && Number.isInteger(candidate.expectedRevision)
      && candidate.payload
      && typeof candidate.payload === "object";
  });
}

function proposalEndpoint(proposal) {
  if (!state.work) return null;
  const workId = encodeURIComponent(state.work.work.id);
  return proposal.action === "generate_strategy"
    ? "/v1/works/" + workId + "/strategy/generate"
    : "/v1/works/" + workId + "/strategy/approval-request";
}

function proposalResultText(proposal, view) {
  const strategy = view.strategy;
  if (proposal.action === "generate_strategy") {
    if (!strategy) return "后端已接受操作，但尚未返回策略产物；请刷新作品后重试。";
    return "已生成策略 v" + strategy.version + " · " + strategy.items.length + " 条卖点 · 作品 revision " + view.work.revision;
  }
  return "已提交人工审批 · 当前状态 " + (statusLabels[view.work.status] || view.work.status) + " · 作品 revision " + view.work.revision;
}

async function executeActionProposal(card, proposal) {
  const button = card.querySelector("button");
  const status = card.querySelector(".agent-action-status");
  const result = card.querySelector(".agent-action-result");
  const endpoint = proposalEndpoint(proposal);
  if (!button || !status || !result || !endpoint || !state.work) return;
  if (state.work.work.revision !== proposal.expectedRevision) {
    status.textContent = "已失效";
    result.textContent = "作品已更新到 revision " + state.work.work.revision + "，请让 Agent 基于最新状态重新建议。";
    button.disabled = true;
    card.classList.add("stale");
    return;
  }
  clearWorkflowError();
  setWorkflowBusy(true);
  button.disabled = true;
  status.textContent = "执行中…";
  try {
    const view = await api(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposal.payload),
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
    status.textContent = "执行失败";
    result.textContent = error instanceof Error ? error.message : "操作执行失败。";
    result.hidden = false;
    card.classList.add("failed");
    showWorkflowError(error);
    button.disabled = false;
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
  meta.textContent = "基于作品 revision " + proposal.expectedRevision + "；点击前不会写入任何产物。";
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
    const expectedRevision = Number(card.dataset.expectedRevision);
    const currentRevision = state.work?.work.revision;
    const stale = currentRevision === undefined || currentRevision !== expectedRevision;
    button.disabled = stale || state.workflowBusy;
    card.classList.toggle("stale", stale);
    if (stale) {
      status.textContent = "已失效";
      result.textContent = currentRevision === undefined
        ? "当前未绑定作品。"
        : "作品当前为 revision " + currentRevision + "，请重新获取操作建议。";
      result.hidden = false;
    }
  });
}

function finishToolEvent(turn, event, resumeThinking) {
  const tool = turn.tools.get(event.toolCallId);
  if (!tool) return;
  tool.content.parentElement.classList.remove("active");
  tool.content.parentElement.classList.toggle("failed", Boolean(event.isError));
  const outputText = payloadText(event.output);
  const errorStatus = /(?:POLICY|策略.{0,8}(?:阻止|拒绝)|blocked|not allowed)/iu.test(outputText)
    ? "被策略阻止"
    : /(?:not found|未找到)/iu.test(outputText)
      ? "未找到"
      : "失败";
  tool.status.textContent = event.isError
    ? errorStatus
    : event.historical
      ? "已完成 · 历史"
    : event.durationMs === undefined
      ? "完成"
      : (event.durationMs / 1000).toFixed(1) + "s";
  tool.output.textContent = outputText;
  if (!event.isError) tool.details.open = false;
  const isProposalTool = tool.toolName === "propose_strategy_generation"
    || tool.toolName === "propose_strategy_approval";
  const proposal = event.isError || !isProposalTool ? undefined : extractActionProposal(event.output);
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
  renderMarkdown(answer, text || "Agent 未返回文本内容。");
  content.appendChild(answer);
  elements.messages.scrollTop = elements.messages.scrollHeight;
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

function updateSession(summary) {
  state.sessionId = summary.id;
  state.sessionWorkId = summary.workId || null;
  localStorage.setItem("firefly.sessionId", summary.id);
  elements.sessionId.textContent = summary.id;
  elements.sessionWork.textContent = summary.workId ? shortWorkId(summary.workId) : "未绑定";
  elements.sessionWork.title = summary.workId || "";
  const toolNames = Array.isArray(summary.toolNames) ? summary.toolNames : [];
  elements.agentTools.textContent = summary.domainToolsLoaded ? toolNames.length + " 个已加载" : "未加载";
  elements.agentTools.title = toolNames.join("、");
}

async function createSession(workId) {
  const selectedWorkId = workId === undefined ? state.work?.work.id : workId;
  const body = await agentApi.createSession(selectedWorkId);
  updateSession(body.session);
  clearMessages();
}

async function ensureSessionForCurrentWork() {
  const workId = state.work?.work.id || null;
  if (state.sessionId && state.sessionWorkId === workId) return;
  await createSession(workId || undefined);
}

async function restoreSession() {
  const saved = localStorage.getItem("firefly.sessionId");
  if (!saved) {
    await createSession();
    return;
  }
  try {
    const session = await agentApi.getSession(saved);
    const selectedWorkId = state.work?.work.id || null;
    if ((session.session.workId || null) !== selectedWorkId) {
      await createSession(selectedWorkId || undefined);
      return;
    }
    updateSession(session.session);
    const transcript = await agentApi.getTranscript(saved);
    restoreTranscriptTimeline(transcript.messages);
  } catch {
    localStorage.removeItem("firefly.sessionId");
    await createSession();
  }
}

async function initialize() {
  try {
    const meta = await api("/v1/meta");
    if (!Array.isArray(meta.capabilities) || !meta.capabilities.includes("work_bound_agent")) {
      throw new Error("当前后端进程版本过旧，请重启 npm run dev:api 后刷新页面。");
    }
    elements.provider.textContent = meta.model.provider;
    elements.model.textContent = meta.model.modelId;
    state.modelReady = Boolean(meta.model.credentialsConfigured);
    await loadWorks();
    await restoreSession();
    if (state.modelReady) {
      setStatus("online", "服务正常");
      elements.prompt.focus();
    } else {
      setStatus("warning", "等待模型密钥");
      elements.prompt.placeholder = "请先在服务端配置 DEEPSEEK_API_KEY";
      setBusy(false);
      showError(new Error("DeepSeek 已设为主 Agent；请在项目 .env 中配置 DEEPSEEK_API_KEY 后重启服务。"));
    }
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
  const turn = createAgentTurn();
  try {
    const result = await agentApi.streamMessage(
      state.sessionId,
      message,
      function (event) {
        if (event.type === "tool_start") addToolEvent(turn, event);
        if (event.type === "tool_end") finishToolEvent(turn, event);
      },
    );
    finishAgentTurn(turn, result.assistantText);
    updateSession(result.session);
  } catch (error) {
    failAgentTurn(turn, error instanceof Error ? error.message : "Agent 请求失败。");
    showError(error);
  } finally {
    setBusy(false);
    elements.prompt.focus();
  }
}

bindAgentPanel({
  elements,
  state,
  sendMessage,
  createSession,
  updateSession,
  clearMessages,
  clearError,
  showError,
  setBusy,
});

bindWorkspaceShell({ elements, state, renderWorkList });

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
