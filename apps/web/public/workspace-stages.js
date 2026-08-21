const stageOrder = Object.freeze([
  "strategy", "script", "asset_matching", "storyboard", "video_preview", "delivery",
]);

const stageLabels = Object.freeze({
  strategy: "营销策略",
  script: "脚本",
  asset_matching: "资产匹配",
  storyboard: "分镜",
  video_preview: "视频预览",
  delivery: "交付",
});

const statusLabels = Object.freeze({
  in_progress: "进行中",
  awaiting_confirmation: "待确认",
  confirmed: "已确认",
});

const stageModules = Object.freeze({
  planning: ["strategy", "script"],
  storyboard: ["storyboard"],
  production: ["video_preview"],
  delivery: ["delivery"],
});

export function workspaceStageTaskStateKey(task) {
  if (!task || typeof task !== "object") return "";
  return [
    task.id || "",
    Number.isSafeInteger(task.revision) ? task.revision : "",
    task.status || "",
    task.currentStage || "",
    task.stageStatus || "",
  ].join(":");
}

export function stagePosition(task, stage) {
  if (!task || !stageOrder.includes(stage)) return "locked";
  const current = stageOrder.indexOf(task.currentStage);
  const target = stageOrder.indexOf(stage);
  if (task.status === "completed" || target < current) return "complete";
  if (target === current) return "current";
  return "locked";
}

export function rollbackImpact(stage) {
  const index = stageOrder.indexOf(stage);
  return index < 0 ? [] : stageOrder.slice(index + 1).map(function (item) { return stageLabels[item]; });
}

export function confirmationAvailability(task, stage, view) {
  if (!task || task.currentStage !== stage || task.stageStatus !== "awaiting_confirmation") {
    return { enabled: false, label: stagePosition(task, stage) === "complete" ? "已确认" : "确认本阶段" };
  }
  if (!task.ownedByCurrentAccount) return { enabled: false, label: "仅负责人确认" };
  if (stage === "strategy") {
    return view?.activeStrategyDraft && view?.confirmationRequest
      ? { enabled: true, label: "确认策略" }
      : { enabled: false, label: "等待确认请求" };
  }
  const active = view?.versions?.find(function (item) { return item.id === view.activeArtifactVersionId; });
  const artifact = view?.simulatedArtifact || active?.content;
  return artifact
    ? { enabled: true, label: "确认本阶段", artifact: artifact }
    : { enabled: false, label: "等待产物入库" };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, function (character) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character];
  });
}

function dateText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function errorText(error) {
  const messages = {
    "AIC-COST-BUDGET_EXCEEDED": "当前账号可用额度不足",
    "AIC-COST-BUDGET_NOT_CONFIGURED": "当前账号未配置制作额度",
    "AIC-CONCURRENCY-ACCOUNT_HIGH_COST_TASK_RUNNING": "当前账号已有高消耗任务在运行",
    "AIC-CONCURRENCY-RUN_LOCK_DENIED": "当前账号已有高消耗任务在运行",
    "AIC-WORKFLOW-REVISION_CONFLICT": "任务已更新，请刷新后重试",
  };
  if (messages[error?.code]) return messages[error.code];
  if (error?.status === 401) return "账号会话已失效";
  if (error?.status === 403) return "当前账号无操作权限";
  if (error?.status === 409) return "任务已更新，请刷新后重试";
  return error instanceof Error && error.message ? error.message : "操作失败，请重试";
}

function validMinorAmount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function formatMinorAmount(value, currency) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 2,
  }).format(value / 100);
}

export function workspaceBudgetPresentation(view, expectedAccountId) {
  if (view === null || view === undefined) {
    return { tone: "warning", value: "未配置", detail: "联系管理员配置制作额度" };
  }
  const balance = view.balance;
  if (
    typeof expectedAccountId !== "string" || !expectedAccountId
    || view.accountId !== expectedAccountId
    || typeof view.currency !== "string" || !/^[A-Z]{3}$/u.test(view.currency)
    || !balance || balance.currency !== view.currency
    || !validMinorAmount(balance.limitAmountMinor)
    || !validMinorAmount(balance.spentAmountMinor)
    || !validMinorAmount(balance.reservedAmountMinor)
    || !validMinorAmount(balance.availableAmountMinor)
    || balance.spentAmountMinor + balance.reservedAmountMinor + balance.availableAmountMinor !== balance.limitAmountMinor
  ) {
    throw new Error("额度数据与当前账号不一致。");
  }
  return {
    tone: balance.availableAmountMinor === 0 ? "danger" : "success",
    value: formatMinorAmount(balance.availableAmountMinor, view.currency),
    detail: balance.reservedAmountMinor > 0
      ? `已预留 ${formatMinorAmount(balance.reservedAmountMinor, view.currency)}`
      : `总额 ${formatMinorAmount(balance.limitAmountMinor, view.currency)}`,
  };
}

export function workspaceRunLockPresentation(status, videoTaskId) {
  if (!status || !("runLock" in status)) throw new Error("运行状态数据无效。");
  const lock = status.runLock;
  if (lock === null) return { tone: "success", value: "运行槽可用", detail: "可开始高消耗任务" };
  if (
    !lock || typeof lock.videoTaskId !== "string" || !lock.videoTaskId
    || typeof lock.batchProjectId !== "string" || !lock.batchProjectId
    || !Number.isSafeInteger(lock.taskRevision) || lock.taskRevision < 1
    || !["video_generation", "automatic_editing"].includes(lock.operation)
    || typeof lock.acquiredAt !== "string" || Number.isNaN(Date.parse(lock.acquiredAt))
  ) throw new Error("运行状态数据无效。");
  return lock.videoTaskId === videoTaskId
    ? { tone: "pending", value: "本任务运行中", detail: lock.operation === "video_generation" ? "正在生成视频" : "正在生成剪映草稿" }
    : { tone: "danger", value: "其他任务运行中", detail: "当前账号已有高消耗任务" };
}

export function workspaceProductionErrorText(error) {
  return errorText(error);
}

function requestId(prefix) {
  return prefix + "_" + globalThis.crypto.randomUUID();
}

function activeVersion(view) {
  return view?.versions?.find(function (item) { return item.id === view.activeArtifactVersionId; }) || null;
}

function stagePath(task, activeStage) {
  return `<div class="production-stage-path" aria-label="视频制作流程">${stageOrder.map(function (stage) {
    const position = stagePosition(task, stage);
    return `<span class="${stage === activeStage ? "active" : position}"><i></i>${escapeHtml(stageLabels[stage])}</span>`;
  }).join("")}</div>`;
}

function statusBadge(task, stage) {
  const position = stagePosition(task, stage);
  const label = position === "complete" ? "已确认" : position === "locked" ? "未开始" : statusLabels[task?.stageStatus] || "进行中";
  const tone = label === "已确认" ? "success" : label === "待确认" ? "pending" : "neutral";
  return `<span class="badge ${tone}">${label}</span>`;
}

function artifactSummary(view) {
  const version = activeVersion(view);
  return version ? `当前 v${version.version} · ${dateText(version.createdAt)}` : "尚无确认版本";
}

function strategyBody(task, view) {
  const draft = view?.activeStrategyDraft;
  if (!draft) {
    return `<div class="production-empty"><span>策略由 Agent 生成后在此确认</span></div>`;
  }
  const validation = draft.validation?.valid !== false;
  return `<div class="strategy-layout">
    <section class="production-card strategy-brief">
      <header><h3>传播方向</h3><span class="stage-mini-status ${validation ? "success" : "danger"}">${validation ? "事实校验通过" : "需修正"}</span></header>
      <dl><div><dt>受众</dt><dd>${escapeHtml(draft.audience)}</dd></div><div><dt>主题</dt><dd>${escapeHtml(draft.theme)}</dd></div><div><dt>时长</dt><dd>${escapeHtml(task.durationSeconds)} 秒</dd></div></dl>
    </section>
    <section class="strategy-points" aria-label="策略要点">${draft.items.map(function (item, index) {
      return `<article class="production-card"><span class="strategy-index">${String(index + 1).padStart(2, "0")}</span><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.statement)}</p></div></article>`;
    }).join("")}</section>
  </div>`;
}

function scriptBody(task, view) {
  const version = activeVersion(view);
  if (!task.scriptInput && !version && !view?.simulatedArtifact) {
    return `<div class="production-empty"><span>策略确认后由 Agent 生成脚本</span></div>`;
  }
  const script = task.scriptInput || [
    `开场：以${task.theme}建立画面。`,
    `主体：围绕${task.audience}呈现车型卖点。`,
    `收束：品牌与车型露出。`,
  ].join("\n");
  return `<div class="script-layout">
    <section class="production-card script-document"><header><div><h3>${version ? `脚本 v${version.version}` : "已有脚本"}</h3><span>${task.durationSeconds} 秒</span></div><span class="stage-mini-status">${task.platformTags?.[0] || "信息流"}</span></header>
      <div class="script-lines">${script.split(/\n+/u).filter(Boolean).map(function (line, index) {
        return `<div><time>${String(index * Math.max(1, Math.floor(task.durationSeconds / 3))).padStart(2, "0")}s</time><p>${escapeHtml(line)}</p></div>`;
      }).join("")}</div>
    </section>
    <aside class="production-card script-facts"><h3>脚本要求</h3><dl><div><dt>受众</dt><dd>${escapeHtml(task.audience)}</dd></div><div><dt>主题</dt><dd>${escapeHtml(task.theme)}</dd></div><div><dt>车型事实</dt><dd>已锁定</dd></div></dl></aside>
  </div>`;
}

function assetItems(assetView) {
  if (!assetView) return [];
  const selected = new Set((assetView.selectedAssets || []).map(function (item) {
    return [item.source, item.assetId, item.version, item.category].join(":");
  }));
  const company = (assetView.companyAssets || []).map(function (item) {
    return { name: item.displayName, category: item.reference.category, reference: item.reference };
  });
  const temporary = (assetView.temporaryAssets || []).map(function (item) {
    return { name: item.fileName, category: item.category, reference: { ...item, assetId: item.id, source: "local_upload" } };
  });
  return company.concat(temporary).filter(function (item) {
    return selected.has([item.reference.source, item.reference.assetId, item.reference.version, item.reference.category].join(":"));
  });
}

function storyboardBody(task, view, assetView, adjustments) {
  const assets = assetItems(assetView);
  const vehicle = assets.find(function (item) { return item.category === "vehicle"; });
  const people = assets.filter(function (item) { return item.category === "person"; });
  const scenes = assets.filter(function (item) { return item.category === "scene"; });
  const count = task.durationSeconds <= 10 ? 3 : task.durationSeconds <= 15 ? 4 : 6;
  const version = activeVersion(view);
  const shotLength = Math.max(1, Math.floor(task.durationSeconds / count));
  return `<div class="storyboard-toolbar"><span>${count} 个镜头 · ${task.durationSeconds} 秒</span><span>${version ? `分镜 v${version.version}` : "分镜草稿"}</span></div>
    <div class="storyboard-grid">${Array.from({ length: count }, function (_, index) {
      const person = adjustments[index]?.person || people[index % Math.max(people.length, 1)] || null;
      const scene = adjustments[index]?.scene || scenes[index % Math.max(scenes.length, 1)] || null;
      const start = index * shotLength;
      const end = index === count - 1 ? task.durationSeconds : Math.min(task.durationSeconds, start + shotLength);
      return `<article class="storyboard-shot">
        <div class="shot-preview"><span>${String(index + 1).padStart(2, "0")}</span><svg class="icon" aria-hidden="true"><use href="#i-image" /></svg><small>${start}–${end}s</small></div>
        <div class="shot-body"><header><div><h3>镜头 ${index + 1}</h3><p>${index === 0 ? "建立场景" : index === count - 1 ? "品牌收束" : "卖点演绎"}</p></div>${adjustments[index] ? '<span class="stage-mini-status pending">人工调整</span>' : ""}</header>
          <div class="shot-assets">
            <div><span>车型</span><strong>${escapeHtml(vehicle?.name || "已锁定车型")}</strong><em>锁定</em></div>
            <div><span>人物</span><strong>${escapeHtml(person?.name || "未配置")}</strong><button type="button" data-shot-adjust="person" data-shot-index="${index}" ${people.length ? "" : "disabled"}>更换</button></div>
            <div><span>场景</span><strong>${escapeHtml(scene?.name || "未配置")}</strong><button type="button" data-shot-adjust="scene" data-shot-index="${index}" ${scenes.length ? "" : "disabled"}>更换</button></div>
          </div>
        </div>
      </article>`;
    }).join("")}</div>`;
}

function previewBody(task, view, project, productionState) {
  const version = activeVersion(view);
  const ratio = project?.project?.aspectRatio || "9:16";
  const accessUrl = productionState?.access?.access?.url;
  const player = accessUrl
    ? `<video controls playsinline preload="metadata" src="${escapeHtml(accessUrl)}"></video>`
    : `<div><span class="preview-play"><svg class="icon" aria-hidden="true"><use href="#i-film" /></svg></span><strong>${productionState?.running ? "真实视频生成中" : "等待真实视频"}</strong><small>${productionState?.running ? "正在调用 Ark 并校验产物，请勿关闭页面" : "需配置 Ark 模型与私有对象存储"}</small></div>`;
  return `<div class="preview-layout">
    <section class="preview-player ratio-${ratio.replace(":", "-")}">${player}<time>00:${String(task.durationSeconds).padStart(2, "0")}</time></section>
    <aside class="production-card preview-info"><header><h3>${version ? `预览 v${version.version}` : "预览信息"}</h3>${statusBadge(task, "video_preview")}</header><dl><div><dt>画幅</dt><dd>${escapeHtml(ratio)}</dd></div><div><dt>时长</dt><dd>${task.durationSeconds} 秒</dd></div><div><dt>生成状态</dt><dd>${version ? "已生成版本" : "等待生成"}</dd></div></dl></aside>
  </div>`;
}

function deliveryBody(task, views) {
  const files = [
    ["成片 MP4", "video_preview"], ["字幕", "video_preview"], ["最终脚本", "script"],
    ["分镜", "storyboard"], ["素材清单", "asset_matching"], ["剪映草稿", "delivery"],
  ];
  return `<div class="delivery-summary"><section><span>${task.status === "completed" ? "交付完成" : "交付准备"}</span><strong>${files.filter(function (entry) { return activeVersion(views[entry[1]]); }).length} / ${files.length}</strong><small>文件就绪</small></section><p>真实成片与剪映草稿将在生成服务接入后提供。</p></div>
    <div class="delivery-grid">${files.map(function ([name, stage]) {
      const ready = Boolean(activeVersion(views[stage]));
      return `<article class="production-card"><span class="delivery-file-icon"><svg class="icon" aria-hidden="true"><use href="${name.includes("成片") ? "#i-film" : name.includes("素材") ? "#i-package" : "#i-file"}" /></svg></span><div><h3>${name}</h3><p>${ready ? "版本已确认" : "尚未生成"}</p></div><span class="stage-mini-status ${ready ? "success" : ""}">${ready ? "就绪" : "等待"}</span></article>`;
    }).join("")}</div>`;
}

function productionStatusCard(label, presentation) {
  return `<article class="production-status-card ${presentation.tone || "neutral"}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(presentation.value)}</strong><small>${escapeHtml(presentation.detail)}</small></article>`;
}

function productionStatusStrip(budgetState, runLockState, productionState) {
  const estimate = productionState?.estimate
    ? { tone: "success", value: `${(productionState.estimate.amountMinor / 100).toFixed(2)} ${productionState.estimate.currency}`, detail: "服务端报价，提交时重新校验" }
    : { tone: productionState?.estimateError ? "danger" : "neutral", value: productionState?.estimateError ? "不可用" : "读取中", detail: productionState?.estimateError ? errorText(productionState.estimateError) : "正在获取服务端报价" };
  const budget = budgetState?.presentation || {
    tone: budgetState?.error ? "danger" : "neutral",
    value: budgetState?.error ? "读取失败" : "读取中",
    detail: budgetState?.error ? errorText(budgetState.error) : "正在读取账号额度",
  };
  const runLock = runLockState?.presentation || {
    tone: runLockState?.error ? "danger" : "neutral",
    value: runLockState?.error ? "读取失败" : "读取中",
    detail: runLockState?.error ? errorText(runLockState.error) : "正在读取运行状态",
  };
  return `<section class="production-status-strip" aria-label="制作资源状态">
    ${productionStatusCard("预估费用", estimate)}
    ${productionStatusCard("可用额度", budget)}
    ${productionStatusCard("运行状态", runLock)}
    <p>执行前由服务端重新估价、校验额度并获取运行锁。</p>
  </section>`;
}

export function createWorkspaceStagesPanel(options) {
  const roots = options.roots;
  let projectId = null;
  let project = null;
  let task = null;
  let visibleModule = null;
  let planningStage = "strategy";
  let view = null;
  let assetView = null;
  let stageViews = {};
  let budgetState = null;
  let runLockState = null;
  let adjustments = {};
  let simulatedArtifact = null;
  let productionState = null;
  let contextAccountId = null;
  let contextTaskStateKey = "";
  let contextGeneration = 0;
  let busy = false;
  let sequence = 0;

  const dialog = document.createElement("dialog");
  dialog.className = "stage-history-dialog";
  dialog.setAttribute("aria-labelledby", "stage-history-title");
  document.body.append(dialog);

  function currentStage() {
    return visibleModule === "planning" ? planningStage : stageModules[visibleModule]?.[0];
  }

  function clearCachedState() {
    view = null;
    assetView = null;
    stageViews = {};
    budgetState = null;
    runLockState = null;
    adjustments = {};
    simulatedArtifact = null;
    productionState = null;
  }

  function clearRoots() {
    Object.values(roots).forEach(function (root) {
      if (root) root.innerHTML = "";
    });
  }

  function setPanelBusy(nextBusy) {
    if (busy === nextBusy) return;
    busy = nextBusy;
    options.onBusyChange?.(busy);
  }

  function adoptTaskUpdate(updatedTask) {
    task = { ...task, ...updatedTask };
    contextTaskStateKey = workspaceStageTaskStateKey(task);
  }

  function reset() {
    contextGeneration += 1;
    sequence += 1;
    projectId = null;
    project = null;
    task = null;
    visibleModule = null;
    contextAccountId = null;
    contextTaskStateKey = "";
    setPanelBusy(false);
    clearCachedState();
    clearRoots();
    if (dialog.open) dialog.close();
  }

  function renderLoading(root) {
    root.innerHTML = `<div class="production-loading"><span></span><span></span><span></span></div>`;
  }

  function notice(stage) {
    if (stage === "storyboard" && Object.keys(adjustments).length > 0) {
      return "人工调整待写入新分镜版本";
    }
    const position = stagePosition(task, stage);
    if (position === "locked") return `完成${stageLabels[stageOrder[stageOrder.indexOf(stage) - 1]]}后开始`;
    if (task.currentStage === stage && task.stageStatus === "awaiting_confirmation") return "产物待负责人确认";
    if (position === "complete") return artifactSummary(view);
    return "Agent 正在处理当前阶段";
  }

  function render() {
    const root = roots[visibleModule];
    const stage = currentStage();
    if (!root || !stage || !task) return;
    const availability = confirmationAvailability(task, stage, {
      ...view,
      ...(simulatedArtifact ? { simulatedArtifact: simulatedArtifact } : {}),
    });
    const canSimulate = Boolean(
      typeof options.api.simulateStage === "function" &&
      task.ownedByCurrentAccount &&
      task.status === "active" &&
      task.currentStage === stage &&
      ["script", "storyboard", "delivery"].includes(stage) &&
      ["in_progress", "awaiting_confirmation"].includes(task.stageStatus),
    );
    const renderView = simulatedArtifact ? { ...view, simulatedArtifact } : view;
    const body = stage === "strategy" ? strategyBody(task, view)
      : stage === "script" ? scriptBody(task, renderView)
      : stage === "storyboard" ? storyboardBody(task, view, assetView, adjustments)
      : stage === "video_preview" ? previewBody(task, view, project, productionState)
      : deliveryBody(task, stageViews);
    root.innerHTML = `<div class="production-stage-shell">
      <header class="production-stage-header"><div><div class="production-stage-title"><h2>${stageLabels[stage]}</h2>${statusBadge(task, stage)}</div><p>${notice(stage)}</p></div>
        <div class="production-stage-actions">${canSimulate ? `<button class="button secondary" type="button" data-stage-simulate ${busy ? "disabled" : ""}>${task.stageStatus === "awaiting_confirmation" ? "恢复阶段产物" : "生成阶段产物"}</button>` : ""}${stage === "video_preview" && task.ownedByCurrentAccount && task.stageStatus === "in_progress" ? `<button class="button primary" type="button" data-video-produce ${busy ? "disabled" : ""}>${productionState?.running ? "真实生成中…" : "生成真实视频"}</button>` : ""}<button class="button secondary" type="button" data-stage-history ${view?.versions?.length ? "" : "disabled"}>历史版本${view?.versions?.length ? ` (${view.versions.length})` : ""}</button><button class="button primary" type="button" data-stage-confirm ${availability.enabled && !busy ? "" : "disabled"}>${availability.label}</button></div>
      </header>
      ${visibleModule === "planning" ? '<div class="planning-tabs" role="tablist" aria-label="策划阶段"><button type="button" role="tab" data-planning-stage="strategy">营销策略</button><button type="button" role="tab" data-planning-stage="script">脚本</button></div>' : ""}
      ${stagePath(task, stage)}
      <div class="production-stage-notice ${stagePosition(task, stage)}"><svg class="icon" aria-hidden="true"><use href="#i-spark" /></svg><span>${notice(stage)}</span></div>
      ${["video_preview", "delivery"].includes(stage) ? productionStatusStrip(budgetState, runLockState, productionState) : ""}
      <div class="production-stage-body">${body}</div>
    </div>`;
    root.querySelectorAll("[data-planning-stage]").forEach(function (button) {
      const selected = button.dataset.planningStage === planningStage;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.addEventListener("click", function () {
        planningStage = button.dataset.planningStage;
        void loadStage();
      });
    });
    root.querySelector("[data-stage-history]")?.addEventListener("click", showHistory);
    root.querySelector("[data-stage-simulate]")?.addEventListener("click", simulateStage);
    root.querySelector("[data-video-produce]")?.addEventListener("click", produceVideo);
    root.querySelector("[data-stage-confirm]")?.addEventListener("click", confirmStage);
    root.querySelectorAll("[data-shot-adjust]").forEach(function (button) {
      button.addEventListener("click", function () { showAssetPicker(Number(button.dataset.shotIndex), button.dataset.shotAdjust); });
    });
  }

  async function loadStage() {
    const root = roots[visibleModule];
    const stage = currentStage();
    const loadSequence = ++sequence;
    const loadContextGeneration = contextGeneration;
    if (!root || !stage || !projectId || !task) return;
    renderLoading(root);
    try {
      const productionStatusPromise = ["video_preview", "delivery"].includes(stage)
        ? Promise.allSettled([
            options.api.getOwnBudget(),
            options.api.getProductionStatus(),
            stage === "video_preview" && typeof options.api.estimateVideoProduction === "function"
              ? options.api.estimateVideoProduction(projectId, task.id)
              : Promise.resolve(null),
            stage === "video_preview" && typeof options.api.getVideoProduction === "function"
              ? options.api.getVideoProduction(projectId, task.id)
              : Promise.resolve(null),
          ])
        : null;
      if (stage === "delivery") {
        const results = await Promise.all(stageOrder.map(function (item) { return options.api.getStageVersions(projectId, task.id, item); }));
        if (loadSequence !== sequence || loadContextGeneration !== contextGeneration) return;
        stageViews = Object.fromEntries(stageOrder.map(function (item, index) { return [item, results[index]]; }));
        view = stageViews.delivery;
      } else {
        const requests = [options.api.getStageVersions(projectId, task.id, stage)];
        if (stage === "storyboard") requests.push(options.api.getAssetMatching(projectId, task.id));
        const results = await Promise.all(requests);
        if (loadSequence !== sequence || loadContextGeneration !== contextGeneration) return;
        view = results[0];
        if (stage === "storyboard") assetView = results[1];
      }
      if (productionStatusPromise) {
        const productionResults = await productionStatusPromise;
        if (loadSequence !== sequence) return;
        try {
          budgetState = productionResults[0].status === "fulfilled"
            ? { presentation: workspaceBudgetPresentation(productionResults[0].value.budget, options.getCurrentAccountId?.()) }
            : { error: productionResults[0].reason };
        } catch (error) { budgetState = { error: error }; }
        try {
          runLockState = productionResults[1].status === "fulfilled"
            ? { presentation: workspaceRunLockPresentation(productionResults[1].value, task.id) }
            : { error: productionResults[1].reason };
        } catch (error) { runLockState = { error: error }; }
        if (stage === "video_preview") {
          productionState = {
            ...(productionState || {}),
            ...(productionResults[2].status === "fulfilled"
              ? { estimate: productionResults[2].value, estimateError: null }
              : { estimateError: productionResults[2].reason }),
          };
          if (productionResults[3].status === "fulfilled" && productionResults[3].value?.artifact) {
            simulatedArtifact = productionResults[3].value.artifact;
            productionState = {
              ...productionState,
              access: productionResults[3].value.access,
              mediaArtifact: productionResults[3].value.mediaArtifact,
            };
          }
        }
      }
      task = { ...task, ...view.videoTask };
      render();
    } catch (error) {
      if (loadSequence !== sequence || loadContextGeneration !== contextGeneration) return;
      root.innerHTML = `<div class="production-error" role="alert"><span>${escapeHtml(errorText(error))}</span><button type="button" class="text-button">重试</button></div>`;
      root.querySelector("button")?.addEventListener("click", loadStage);
    }
  }

  async function confirmStage() {
    const stage = currentStage();
    const availability = confirmationAvailability(task, stage, {
      ...view,
      ...(simulatedArtifact ? { simulatedArtifact: simulatedArtifact } : {}),
    });
    if (!availability.enabled || busy) return;
    const mutationContextGeneration = contextGeneration;
    const mutationProjectId = projectId;
    const mutationTaskId = task.id;
    const expectedTaskRevision = task.revision;
    setPanelBusy(true);
    render();
    try {
      const result = await options.api.confirmStage(mutationProjectId, mutationTaskId, stage, {
        requestId: requestId("confirm_stage"),
        expectedTaskRevision,
        ...(availability.artifact ? { artifact: availability.artifact } : {}),
      });
      if (
        mutationContextGeneration !== contextGeneration
        || mutationProjectId !== projectId
        || mutationTaskId !== task?.id
      ) return;
      adoptTaskUpdate(result.videoTask);
      simulatedArtifact = null;
      options.onTaskUpdated?.(result.videoTask);
      await loadStage();
    } catch (error) {
      if (
        mutationContextGeneration === contextGeneration
        && mutationProjectId === projectId
        && mutationTaskId === task?.id
      ) showMessage(errorText(error));
    } finally {
      if (
        mutationContextGeneration === contextGeneration
        && mutationProjectId === projectId
        && mutationTaskId === task?.id
      ) {
        setPanelBusy(false);
        render();
      }
    }
  }

  async function simulateStage() {
    const stage = currentStage();
    if (!stage || busy || typeof options.api.simulateStage !== "function") return;
    setPanelBusy(true);
    render();
    try {
      const result = await options.api.simulateStage(projectId, task.id, stage);
      adoptTaskUpdate(result.videoTask);
      simulatedArtifact = result.artifact;
      options.onTaskUpdated?.(result.videoTask);
    } catch (error) {
      showMessage(errorText(error));
    } finally {
      setPanelBusy(false);
      render();
    }
  }

  async function produceVideo() {
    if (busy || !task || typeof options.api.startVideoProduction !== "function") return;
    const mutationContextGeneration = contextGeneration;
    const mutationProjectId = projectId;
    const mutationTaskId = task.id;
    setPanelBusy(true);
    productionState = { ...(productionState || {}), running: true };
    render();
    try {
      const result = await options.api.startVideoProduction(mutationProjectId, mutationTaskId, {
        requestId: requestId("video_generation"),
        expectedTaskRevision: task.revision,
      });
      if (mutationContextGeneration !== contextGeneration || mutationTaskId !== task?.id) return;
      adoptTaskUpdate(result.videoTask);
      simulatedArtifact = result.artifact;
      const access = await options.api.getMediaArtifactAccess(
        mutationProjectId,
        mutationTaskId,
        result.mediaArtifactId,
        "playback",
      );
      productionState = { ...(productionState || {}), running: false, result: result, access: access };
      options.onTaskUpdated?.(result.videoTask);
    } catch (error) {
      if (mutationContextGeneration === contextGeneration) {
        productionState = { ...(productionState || {}), running: false, error: error };
        showMessage(errorText(error));
      }
    } finally {
      if (mutationContextGeneration === contextGeneration) {
        setPanelBusy(false);
        render();
      }
    }
  }

  function showMessage(message) {
    dialog.innerHTML = `<form method="dialog" class="stage-dialog-card"><header><h2 id="stage-history-title">提示</h2><button value="close" aria-label="关闭">×</button></header><p class="stage-dialog-message">${escapeHtml(message)}</p><footer><button class="button primary" value="close">知道了</button></footer></form>`;
    dialog.showModal();
  }

  function showHistory() {
    const stage = currentStage();
    const invalid = new Set((view.invalidations || []).map(function (item) { return item.artifactVersionId; }));
    dialog.innerHTML = `<div class="stage-dialog-card"><header><div><h2 id="stage-history-title">${stageLabels[stage]}版本</h2><p>${view.versions.length} 个确认版本</p></div><button type="button" data-dialog-close aria-label="关闭">×</button></header><div class="stage-version-list">${[...view.versions].reverse().map(function (version) {
      const active = version.id === view.activeArtifactVersionId;
      const invalidated = invalid.has(version.id);
      return `<article><span class="stage-version-number">v${version.version}</span><div><strong>${active ? "当前版本" : invalidated ? "已失效" : "历史版本"}</strong><small>${dateText(version.createdAt)}</small></div>${!active && !invalidated && task.ownedByCurrentAccount ? `<button type="button" class="text-button" data-rollback-version="${escapeHtml(version.id)}">回退</button>` : ""}</article>`;
    }).join("")}</div></div>`;
    dialog.querySelector("[data-dialog-close]")?.addEventListener("click", function () { dialog.close(); });
    dialog.querySelectorAll("[data-rollback-version]").forEach(function (button) {
      button.addEventListener("click", function () { showRollback(button.dataset.rollbackVersion); });
    });
    dialog.showModal();
  }

  function showRollback(versionId) {
    const stage = currentStage();
    const version = view.versions.find(function (item) { return item.id === versionId; });
    const affected = rollbackImpact(stage);
    dialog.innerHTML = `<form class="stage-dialog-card" data-rollback-form><header><div><h2 id="stage-history-title">回退到 v${version?.version || "—"}</h2><p>${stageLabels[stage]}</p></div><button type="button" data-dialog-close aria-label="关闭">×</button></header>
      <div class="rollback-warning"><strong>下游版本将失效</strong><p>${affected.length ? affected.join("、") : "当前为最终阶段"}</p></div>
      <label class="rollback-reason"><span>回退原因</span><textarea required minlength="1" maxlength="2000" placeholder="填写原因"></textarea></label>
      <footer><button type="button" class="button secondary" data-dialog-close>取消</button><button class="button primary" type="submit">确认回退</button></footer></form>`;
    dialog.querySelectorAll("[data-dialog-close]").forEach(function (button) { button.addEventListener("click", function () { dialog.close(); }); });
    dialog.querySelector("[data-rollback-form]")?.addEventListener("submit", async function (event) {
      event.preventDefault();
      const reason = event.currentTarget.querySelector("textarea").value.trim();
      if (!reason || busy) return;
      const mutationContextGeneration = contextGeneration;
      const mutationProjectId = projectId;
      const mutationTaskId = task.id;
      const expectedTaskRevision = task.revision;
      setPanelBusy(true);
      try {
        const result = await options.api.rollbackStage(mutationProjectId, mutationTaskId, stage, {
          requestId: requestId("rollback_stage"), expectedTaskRevision,
          targetArtifactVersionId: versionId, reason,
        });
        if (
          mutationContextGeneration !== contextGeneration
          || mutationProjectId !== projectId
          || mutationTaskId !== task?.id
        ) return;
        adoptTaskUpdate(result.videoTask);
        options.onTaskUpdated?.(result.videoTask);
        dialog.close();
        await loadStage();
      } catch (error) {
        if (
          mutationContextGeneration === contextGeneration
          && mutationProjectId === projectId
          && mutationTaskId === task?.id
        ) {
          dialog.close();
          showMessage(errorText(error));
        }
      } finally {
        if (
          mutationContextGeneration === contextGeneration
          && mutationProjectId === projectId
          && mutationTaskId === task?.id
        ) setPanelBusy(false);
      }
    });
  }

  function showAssetPicker(shotIndex, category) {
    const candidates = assetItems(assetView).filter(function (item) { return item.category === category; });
    dialog.innerHTML = `<div class="stage-dialog-card"><header><div><h2 id="stage-history-title">更换${category === "person" ? "人物" : "场景"}</h2><p>镜头 ${shotIndex + 1}</p></div><button type="button" data-dialog-close aria-label="关闭">×</button></header><div class="stage-asset-picker">${candidates.map(function (item, index) {
      return `<button type="button" data-pick-asset="${index}"><span><svg class="icon" aria-hidden="true"><use href="${category === "person" ? "#i-message" : "#i-image"}" /></svg></span><strong>${escapeHtml(item.name)}</strong></button>`;
    }).join("")}</div></div>`;
    dialog.querySelector("[data-dialog-close]")?.addEventListener("click", function () { dialog.close(); });
    dialog.querySelectorAll("[data-pick-asset]").forEach(function (button) {
      button.addEventListener("click", function () {
        adjustments[shotIndex] = { ...(adjustments[shotIndex] || {}), [category]: candidates[Number(button.dataset.pickAsset)] };
        dialog.close();
        render();
      });
    });
    dialog.showModal();
  }

  return {
    setContext(nextProjectId, nextProject, nextTask, activeModule) {
      const isVisible = Boolean(stageModules[activeModule]);
      const nextAccountId = options.getCurrentAccountId?.() || null;
      const nextVisibleModule = isVisible ? activeModule : null;
      const nextTaskStateKey = workspaceStageTaskStateKey(nextTask);
      const accountChanged = nextAccountId !== contextAccountId;
      const resourceChanged = accountChanged
        || (nextProjectId || null) !== projectId
        || (nextTask?.id || null) !== (task?.id || null);
      const taskStateChanged = nextTaskStateKey !== contextTaskStateKey;
      const contextChanged = resourceChanged || taskStateChanged || nextVisibleModule !== visibleModule;
      if (contextChanged) {
        sequence += 1;
        clearCachedState();
        if (dialog.open) dialog.close();
        dialog.innerHTML = "";
      }
      if (resourceChanged) {
        contextGeneration += 1;
        setPanelBusy(false);
      }
      if (accountChanged) {
        clearRoots();
      }
      contextAccountId = nextAccountId;
      contextTaskStateKey = nextTaskStateKey;
      projectId = nextProjectId || null;
      project = nextProject || null;
      task = nextTask || null;
      visibleModule = nextVisibleModule;
      if (!visibleModule || !task || !contextAccountId || !contextChanged) return;
      if (visibleModule === "planning") planningStage = ["strategy", "script"].includes(task.currentStage) ? task.currentStage : planningStage;
      void loadStage();
    },
    refresh: loadStage,
    reset,
    isBusy() { return busy; },
  };
}
