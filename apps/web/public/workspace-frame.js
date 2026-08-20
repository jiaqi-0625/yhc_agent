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

function statusClass(status) {
  return status === "awaiting_confirmation" ? "pending" : status === "confirmed" ? "success" : "neutral";
}

function setText(element, value) {
  if (element) element.textContent = value;
}

export function createWorkspaceFrame(options) {
  const { elements, getProjects, onBack } = options;
  let selection = null;
  let activeModule = "planning";

  function renderModules() {
    elements.moduleButtons.forEach(function (button) {
      const selected = button.dataset.workspaceFrameModule === activeModule;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-current", selected ? "page" : "false");
    });
    elements.modulePanels.forEach(function (panel) {
      panel.hidden = panel.dataset.workspaceFramePanel !== activeModule;
    });
    setText(elements.moduleTitle, moduleLabels[activeModule] || "工作区");
  }

  function selectTask(taskId, preserveModule) {
    if (!selection) return;
    selection = resolveWorkspaceSelection([selection.project], selection.project.project.id, taskId);
    if (!selection) return;
    if (!preserveModule) activeModule = workspaceModuleForStage(selection.task?.currentStage);
    render();
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
    tasks.forEach(function (task) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workspace-task-item" + (selection.task?.id === task.id ? " active" : "");
      button.dataset.videoTaskId = task.id;
      button.setAttribute("aria-pressed", String(selection.task?.id === task.id));
      const title = document.createElement("strong");
      title.textContent = task.name;
      title.title = task.name;
      const meta = document.createElement("span");
      meta.textContent = (stageLabels[task.currentStage] || "未开始") + " · " +
        (stageStatusLabels[task.stageStatus] || "进行中");
      button.append(title, meta);
      button.addEventListener("click", function () { selectTask(task.id, false); });
      elements.taskList.appendChild(button);
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
    setText(elements.taskName, task?.name || "未选择视频任务");
    setText(elements.taskStage, task ? (stageLabels[task.currentStage] || "未开始") : "未开始");
    elements.taskStage.className = "badge " + statusClass(task?.stageStatus);
    setText(elements.taskMeta, task ? "版本 " + task.revision + " · " + (task.ownedByCurrentAccount ? "由我负责" : "其他成员负责") : "—");
    setText(elements.agentTask, task?.name || "未选择任务");
    setText(elements.agentStage, task ? (stageLabels[task.currentStage] || "未开始") : "未开始");
    setText(elements.agentRevision, task ? "版本 " + task.revision : "—");
    setText(elements.agentOwner, task ? (task.ownedByCurrentAccount ? "当前账号" : "其他成员") : "—");
    elements.agentStatus.textContent = task ? "任务已绑定" : "未绑定任务";
    elements.agentStatus.className = "badge " + (task ? "success" : "neutral");
    elements.agentComposer.disabled = true;
    elements.agentSend.disabled = true;
    renderTasks();
    renderModules();
  }

  function open(projectId, taskId) {
    const resolved = resolveWorkspaceSelection(getProjects(), projectId, taskId);
    if (!resolved) return false;
    selection = resolved;
    activeModule = workspaceModuleForStage(selection.task?.currentStage);
    elements.library.hidden = true;
    elements.creation.hidden = true;
    elements.legacyWorkspace.hidden = true;
    elements.view.hidden = false;
    setText(elements.topbarTitle, selection.project.project.batchName);
    render();
    elements.back.focus();
    return true;
  }

  function close() {
    selection = null;
    elements.view.hidden = true;
    elements.creation.hidden = true;
    elements.legacyWorkspace.hidden = true;
    elements.library.hidden = false;
    setText(elements.topbarTitle, "项目库");
  }

  elements.back.addEventListener("click", function () {
    close();
    if (typeof onBack === "function") onBack();
  });
  elements.moduleButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      activeModule = button.dataset.workspaceFrameModule;
      renderModules();
    });
  });
  elements.projectOverview.addEventListener("click", function () {
    activeModule = "planning";
    renderModules();
  });
  elements.projectAssets.addEventListener("click", function () {
    activeModule = "assets";
    renderModules();
  });

  return { open, close };
}
