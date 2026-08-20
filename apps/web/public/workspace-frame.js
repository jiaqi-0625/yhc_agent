import { selectedVideoTaskStorageKey } from "./workspace-shell.js";

const moduleLabels = Object.freeze({
  planning: "策划",
  assets: "资产",
  storyboard: "分镜",
  production: "制作",
  delivery: "交付",
});

const stageLabels = Object.freeze({
  strategy: "营销策略",
  script: "脚本",
  asset_matching: "资产匹配",
  storyboard: "分镜",
  video_preview: "视频预览",
  delivery: "交付",
});

const stageStatusLabels = Object.freeze({
  in_progress: "进行中",
  awaiting_confirmation: "待确认",
  confirmed: "已确认",
});

const taskStatusLabels = Object.freeze({
  active: "进行中",
  completed: "已完成",
  cancelled: "已取消",
  archived: "已归档",
});

const workspaceProjectQueryKey = "projectId";
const workspaceTaskQueryKey = "videoTaskId";
const workspaceModuleQueryKey = "workspaceModule";
const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/u;

export const workspaceTaskContextEventName = "firefly:workspace-task-context-change";

function validIdentifier(value) {
  return typeof value === "string" && identifierPattern.test(value) ? value : null;
}

function validModule(value) {
  return typeof value === "string" && Object.hasOwn(moduleLabels, value) ? value : null;
}

export function workspaceModuleForStage(stage) {
  if (stage === "asset_matching") return "assets";
  if (stage === "storyboard") return "storyboard";
  if (stage === "video_preview") return "production";
  if (stage === "delivery") return "delivery";
  return "planning";
}

export function resolveWorkspaceSelection(projects, projectId, taskId) {
  if (!Array.isArray(projects) || typeof projectId !== "string") return null;
  const project = projects.find(function (entry) { return entry?.project?.id === projectId; });
  if (!project) return null;
  const tasks = Array.isArray(project.tasks) ? project.tasks : [];
  const requestedTask = tasks.find(function (task) { return task.id === taskId; });
  const activeTask = tasks.find(function (task) { return task.status === "active"; });
  return { project, task: requestedTask || activeTask || tasks[0] || null };
}

export function readWorkspaceUrlState(href) {
  try {
    const url = new URL(href, "http://localhost/");
    const projectId = validIdentifier(url.searchParams.get(workspaceProjectQueryKey));
    if (!projectId) return null;
    return {
      projectId,
      videoTaskId: validIdentifier(url.searchParams.get(workspaceTaskQueryKey)),
      module: validModule(url.searchParams.get(workspaceModuleQueryKey)),
    };
  } catch {
    return null;
  }
}

export function workspaceUrlForState(href, state) {
  const url = new URL(href, "http://localhost/");
  url.searchParams.delete(workspaceProjectQueryKey);
  url.searchParams.delete(workspaceTaskQueryKey);
  url.searchParams.delete(workspaceModuleQueryKey);
  const projectId = validIdentifier(state?.projectId);
  if (projectId) {
    url.searchParams.set(workspaceProjectQueryKey, projectId);
    const videoTaskId = validIdentifier(state?.videoTaskId);
    const module = validModule(state?.module);
    if (videoTaskId) url.searchParams.set(workspaceTaskQueryKey, videoTaskId);
    if (module) url.searchParams.set(workspaceModuleQueryKey, module);
  }
  return url.pathname + url.search + url.hash;
}

export function workspaceOwnerLabel(task) {
  return task?.ownedByCurrentAccount ? "当前账号" : "其他制作成员";
}

export function summarizeWorkspaceProject(summary) {
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  return {
    total: tasks.length,
    active: tasks.filter(function (task) { return task.status === "active"; }).length,
    pending: tasks.filter(function (task) { return task.stageStatus === "awaiting_confirmation"; }).length,
    mine: tasks.filter(function (task) { return task.ownedByCurrentAccount; }).length,
  };
}

export function createWorkspaceContextDetail(summary, task) {
  if (!summary?.project?.id) return null;
  return {
    schemaVersion: 1,
    kind: "workspace_task_context_change",
    batchProject: {
      id: summary.project.id,
      name: summary.project.name,
      status: summary.project.status,
    },
    videoTask: task ? {
      id: task.id,
      name: task.name,
      status: task.status,
      currentStage: task.currentStage,
      stageStatus: task.stageStatus,
      revision: task.revision,
      ownership: task.ownedByCurrentAccount ? "owned_by_current_account" : "owned_by_other_account",
    } : null,
  };
}

function statusClass(status) {
  return status === "awaiting_confirmation" ? "pending" : status === "confirmed" ? "success" : "neutral";
}

function taskStatusClass(status) {
  if (status === "completed") return "success";
  if (status === "cancelled") return "invalid";
  return "neutral";
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function activityText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function query(view, selector) {
  return view?.querySelector(selector) ?? null;
}

export function createWorkspaceFrame(options) {
  const { getProjects, onBack } = options;
  const elements = {
    ...options.elements,
    overviewPanel: options.elements.overviewPanel || query(options.elements.view, "#workspace-frame-overview-panel"),
    overviewName: options.elements.overviewName || query(options.elements.view, "#workspace-frame-overview-name"),
    overviewStatus: options.elements.overviewStatus || query(options.elements.view, "#workspace-frame-overview-status"),
    overviewBrand: options.elements.overviewBrand || query(options.elements.view, "#workspace-frame-overview-brand"),
    overviewVehicle: options.elements.overviewVehicle || query(options.elements.view, "#workspace-frame-overview-vehicle"),
    overviewRatio: options.elements.overviewRatio || query(options.elements.view, "#workspace-frame-overview-ratio"),
    overviewVehicleVersion: options.elements.overviewVehicleVersion || query(options.elements.view, "#workspace-frame-overview-vehicle-version"),
    overviewTaskTotal: options.elements.overviewTaskTotal || query(options.elements.view, "#workspace-frame-overview-task-total"),
    overviewTaskActive: options.elements.overviewTaskActive || query(options.elements.view, "#workspace-frame-overview-task-active"),
    overviewTaskPending: options.elements.overviewTaskPending || query(options.elements.view, "#workspace-frame-overview-task-pending"),
    overviewTaskMine: options.elements.overviewTaskMine || query(options.elements.view, "#workspace-frame-overview-task-mine"),
    overviewUpdated: options.elements.overviewUpdated || query(options.elements.view, "#workspace-frame-overview-updated"),
    overviewTaskList: options.elements.overviewTaskList || query(options.elements.view, "#workspace-frame-overview-task-list"),
  };
  const browserWindow = options.window || globalThis.window;
  const browserHistory = options.history || browserWindow?.history;
  const browserLocation = options.location || browserWindow?.location;
  const storage = options.storage || browserWindow?.localStorage;
  let selection = null;
  let activeModule = "planning";
  let activeView = "overview";
  let initialRouteRestored = false;

  function selectionLocked() {
    return Boolean(options.isSelectionLocked?.());
  }

  function refreshSelectionControls() {
    const locked = selectionLocked();
    elements.back.disabled = locked;
    elements.projectOverview.disabled = locked && selection?.task !== null;
    elements.projectAssets.disabled = locked;
    elements.taskList.querySelectorAll("button[data-video-task-id]").forEach(function (button) {
      button.disabled = locked && button.dataset.videoTaskId !== selection?.task?.id;
    });
    elements.overviewTaskList?.querySelectorAll("button[data-video-task-id]").forEach(function (button) {
      button.disabled = locked && button.dataset.videoTaskId !== selection?.task?.id;
    });
  }

  function routeState() {
    if (!selection) return null;
    return {
      projectId: selection.project.project.id,
      videoTaskId: selection.task?.id || null,
      module: activeView === "module" ? activeModule : null,
    };
  }

  function writeRoute(mode) {
    if (!browserHistory || !browserLocation) return;
    const current = browserLocation.pathname + browserLocation.search + browserLocation.hash;
    const next = workspaceUrlForState(browserLocation.href, routeState());
    if (current === next) return;
    const method = mode === "replace" ? "replaceState" : "pushState";
    browserHistory[method]({ fireflyWorkspace: true }, "", next);
  }

  function writeSelectionStorage() {
    try {
      if (selection?.task?.id) storage?.setItem(selectedVideoTaskStorageKey, selection.task.id);
      else storage?.removeItem(selectedVideoTaskStorageKey);
    } catch {}
  }

  function dispatchTaskContext() {
    if (!browserWindow?.dispatchEvent || !browserWindow.CustomEvent) return;
    const detail = selection
      ? createWorkspaceContextDetail(selection.project, selection.task)
      : null;
    browserWindow.dispatchEvent(new browserWindow.CustomEvent(workspaceTaskContextEventName, { detail }));
  }

  function synchronize(mode) {
    writeSelectionStorage();
    writeRoute(mode);
    dispatchTaskContext();
  }

  function renderModules() {
    elements.moduleButtons.forEach(function (button) {
      const selected = activeView === "module" && button.dataset.workspaceFrameModule === activeModule;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-current", selected ? "page" : "false");
    });
    elements.modulePanels.forEach(function (panel) {
      panel.hidden = activeView !== "module" || panel.dataset.workspaceFramePanel !== activeModule;
    });
    if (elements.overviewPanel) elements.overviewPanel.hidden = activeView !== "overview";
    elements.projectOverview.classList.toggle("active", activeView === "overview");
    elements.projectOverview.setAttribute("aria-current", activeView === "overview" ? "page" : "false");
    const projectAssetsSelected = activeView === "module" && activeModule === "assets" && !selection?.task;
    elements.projectAssets.classList.toggle("active", projectAssetsSelected);
    elements.projectAssets.setAttribute("aria-current", projectAssetsSelected ? "page" : "false");
    setText(elements.moduleTitle, moduleLabels[activeModule] || "工作区");
  }

  function selectTask(taskId, module, historyMode = "push") {
    if (!selection) return false;
    if (selectionLocked() && taskId !== selection.task?.id) return false;
    const resolved = resolveWorkspaceSelection([selection.project], selection.project.project.id, taskId);
    if (!resolved?.task) return false;
    selection = resolved;
    activeView = "module";
    activeModule = validModule(module) || workspaceModuleForStage(selection.task.currentStage);
    render();
    synchronize(historyMode);
    return true;
  }

  function renderTaskButton(task) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-task-item" + (selection.task?.id === task.id ? " active" : "");
    button.dataset.videoTaskId = task.id;
    button.disabled = selectionLocked() && selection.task?.id !== task.id;
    button.setAttribute("aria-pressed", String(selection.task?.id === task.id));
    button.setAttribute("aria-label", "打开任务 " + task.name);
    const title = document.createElement("strong");
    title.textContent = task.name;
    title.title = task.name;
    const meta = document.createElement("span");
    meta.className = "workspace-task-stage";
    meta.textContent = (stageLabels[task.currentStage] || "未开始") + " · " +
      (stageStatusLabels[task.stageStatus] || "进行中");
    const footer = document.createElement("span");
    footer.className = "workspace-task-owner";
    footer.textContent = workspaceOwnerLabel(task) + " · " + (taskStatusLabels[task.status] || "未知状态");
    button.append(title, meta, footer);
    button.addEventListener("click", function () { selectTask(task.id); });
    return button;
  }

  function renderTasks() {
    elements.taskList.replaceChildren();
    const tasks = selection.project.tasks;
    setText(elements.taskCount, tasks.length + " 个");
    if (tasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "workspace-frame-empty-text";
      empty.textContent = "暂无视频任务";
      elements.taskList.appendChild(empty);
      return;
    }
    tasks.forEach(function (task) { elements.taskList.appendChild(renderTaskButton(task)); });
  }

  function overviewTaskRow(task) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-overview-task-row";
    button.dataset.videoTaskId = task.id;
    button.disabled = selectionLocked() && selection.task?.id !== task.id;
    button.setAttribute("aria-label", "打开任务 " + task.name);
    const name = document.createElement("strong");
    name.textContent = task.name;
    name.title = task.name;
    const stage = document.createElement("span");
    stage.textContent = stageLabels[task.currentStage] || "未开始";
    const status = document.createElement("span");
    status.className = "badge " + (task.status === "active" ? statusClass(task.stageStatus) : taskStatusClass(task.status));
    status.textContent = task.status === "active"
      ? (stageStatusLabels[task.stageStatus] || "进行中")
      : (taskStatusLabels[task.status] || "未知状态");
    const owner = document.createElement("span");
    owner.textContent = workspaceOwnerLabel(task);
    const updated = document.createElement("time");
    updated.dateTime = task.updatedAt;
    updated.textContent = activityText(task.updatedAt);
    button.append(name, stage, status, owner, updated);
    button.addEventListener("click", function () { selectTask(task.id); });
    return button;
  }

  function renderOverview() {
    const summary = selection.project;
    const metrics = summarizeWorkspaceProject(summary);
    setText(elements.overviewName, summary.project.name);
    setText(elements.overviewStatus, summary.project.status === "active" ? "可用" : "已归档");
    elements.overviewStatus.className = "badge " + (summary.project.status === "active" ? "success" : "neutral");
    setText(elements.overviewBrand, summary.brand.name);
    setText(elements.overviewVehicle, summary.vehicle.displayName);
    setText(elements.overviewRatio, summary.project.aspectRatio);
    setText(elements.overviewVehicleVersion, "版本 " + summary.vehicle.version);
    setText(elements.overviewTaskTotal, String(metrics.total));
    setText(elements.overviewTaskActive, String(metrics.active));
    setText(elements.overviewTaskPending, String(metrics.pending));
    setText(elements.overviewTaskMine, String(metrics.mine));
    setText(elements.overviewUpdated, "最近更新 " + activityText(summary.latestActivityAt));
    elements.overviewTaskList.replaceChildren();
    if (summary.tasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "workspace-overview-empty";
      empty.textContent = "暂无视频任务";
      elements.overviewTaskList.appendChild(empty);
      return;
    }
    summary.tasks.forEach(function (task) {
      elements.overviewTaskList.appendChild(overviewTaskRow(task));
    });
  }

  function render() {
    if (!selection) return;
    const summary = selection.project;
    const task = selection.task;
    setText(elements.projectName, summary.project.batchName);
    setText(elements.projectContext, summary.brand.name + " · " + summary.vehicle.displayName);
    setText(elements.projectMeta, summary.project.aspectRatio + " · 事实版本 " + summary.vehicle.version);
    setText(elements.projectStatus, summary.project.status === "active" ? "可用" : "已归档");
    elements.projectStatus.className = "badge " + (summary.project.status === "active" ? "success" : "neutral");
    setText(elements.taskName, task?.name || (activeView === "overview" ? "项目概览" : "未选择视频任务"));
    setText(elements.taskStage, task ? (stageLabels[task.currentStage] || "未开始") : "项目级");
    elements.taskStage.className = "badge " + (task ? statusClass(task.stageStatus) : "neutral");
    setText(elements.taskMeta, task
      ? (stageStatusLabels[task.stageStatus] || "进行中") + " · 版本 " + task.revision + " · " + workspaceOwnerLabel(task)
      : summary.project.name);
    renderTasks();
    renderOverview();
    renderModules();
    refreshSelectionControls();
    options.onSelectionChange?.({
      project: summary,
      task,
      activeView,
      activeModule,
    });
  }

  function revealWorkspace() {
    elements.library.hidden = true;
    elements.creation.hidden = true;
    elements.legacyWorkspace.hidden = true;
    elements.view.hidden = false;
    setText(elements.topbarTitle, selection.project.project.batchName);
  }

  function open(projectId, taskId, behavior = {}) {
    const resolved = resolveWorkspaceSelection(getProjects(), projectId, taskId);
    if (!resolved) return false;
    const explicitTask = typeof taskId === "string" && taskId.length > 0;
    if (
      selectionLocked() &&
      (explicitTask ? resolved.task?.id || null : null) !== (selection?.task?.id || null)
    ) return false;
    selection = { project: resolved.project, task: explicitTask ? resolved.task : null };
    activeView = explicitTask ? "module" : "overview";
    activeModule = validModule(behavior.module) || workspaceModuleForStage(selection.task?.currentStage);
    revealWorkspace();
    render();
    if (behavior.synchronize !== false) synchronize(behavior.historyMode || "push");
    else {
      writeSelectionStorage();
      dispatchTaskContext();
    }
    initialRouteRestored = true;
    if (behavior.focus !== false) elements.back.focus();
    return true;
  }

  function close(behavior = {}) {
    selection = null;
    activeView = "overview";
    elements.view.hidden = true;
    elements.creation.hidden = true;
    elements.legacyWorkspace.hidden = true;
    elements.library.hidden = false;
    setText(elements.topbarTitle, "项目库");
    if (behavior.synchronize !== false) synchronize(behavior.historyMode || "push");
    else {
      writeSelectionStorage();
      dispatchTaskContext();
    }
  }

  function restoreFromLocation() {
    if (!browserLocation) return false;
    const route = readWorkspaceUrlState(browserLocation.href);
    if (!route) {
      close({ synchronize: false });
      return true;
    }
    return open(route.projectId, route.videoTaskId || undefined, {
      module: route.module || undefined,
      synchronize: false,
      focus: false,
    });
  }

  function restoreInitialRoute() {
    if (initialRouteRestored) return;
    const route = browserLocation ? readWorkspaceUrlState(browserLocation.href) : null;
    if (!route) {
      initialRouteRestored = true;
      return;
    }
    if (restoreFromLocation()) initialRouteRestored = true;
  }

  elements.back.addEventListener("click", function () {
    if (selectionLocked()) return;
    close();
    if (typeof onBack === "function") onBack();
  });
  elements.moduleButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      const module = validModule(button.dataset.workspaceFrameModule);
      if (!module || !selection) return;
      if (!selection.task) {
        const resolved = resolveWorkspaceSelection([selection.project], selection.project.project.id);
        if (resolved?.task) selection = resolved;
      }
      activeView = "module";
      activeModule = module;
      render();
      synchronize("push");
    });
  });
  elements.projectOverview.addEventListener("click", function () {
    if (!selection) return;
    if (selectionLocked() && selection.task !== null) return;
    selection = { project: selection.project, task: null };
    activeView = "overview";
    render();
    synchronize("push");
  });
  elements.projectAssets.addEventListener("click", function () {
    if (!selection || selectionLocked()) return;
    const resolved = resolveWorkspaceSelection([selection.project], selection.project.project.id);
    selection = { project: selection.project, task: resolved?.task || null };
    activeView = "module";
    activeModule = "assets";
    render();
    synchronize("push");
  });
  browserWindow?.addEventListener?.("popstate", restoreFromLocation);
  if (browserWindow?.MutationObserver && elements.library) {
    const observer = new browserWindow.MutationObserver(restoreInitialRoute);
    observer.observe(elements.library, { attributes: true, attributeFilter: ["aria-busy"] });
  }
  browserWindow?.queueMicrotask?.(restoreInitialRoute);

  return { open, close, restore: restoreFromLocation, refreshSelectionControls };
}
