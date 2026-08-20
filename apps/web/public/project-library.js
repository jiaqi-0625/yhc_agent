function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestampEpoch(value) {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

function compareTimestampDescending(left, right) {
  const leftEpoch = timestampEpoch(left);
  const rightEpoch = timestampEpoch(right);
  if (leftEpoch === null || rightEpoch === null) return 0;
  return rightEpoch < leftEpoch ? -1 : rightEpoch > leftEpoch ? 1 : 0;
}

function normalizeTask(value) {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  const updatedAt = nonEmptyString(value.updatedAt);
  if (
    !id || !name || !updatedAt || timestampEpoch(updatedAt) === null ||
    typeof value.ownedByCurrentAccount !== "boolean"
  ) return null;
  if (!["active", "completed", "cancelled", "archived"].includes(value.status)) return null;
  if (!["strategy", "asset_matching", "script", "storyboard", "video_preview", "delivery"].includes(value.currentStage)) return null;
  if (!["in_progress", "awaiting_confirmation", "confirmed"].includes(value.stageStatus)) return null;
  if (!Number.isInteger(value.revision) || value.revision < 1) return null;
  return {
    id,
    name,
    status: value.status,
    currentStage: value.currentStage,
    stageStatus: value.stageStatus,
    revision: value.revision,
    ownedByCurrentAccount: value.ownedByCurrentAccount,
    updatedAt,
  };
}

function normalizeProject(value) {
  if (!isRecord(value) || !isRecord(value.project) || !isRecord(value.brand) || !isRecord(value.vehicle)) return null;
  const projectId = nonEmptyString(value.project.id);
  const brandId = nonEmptyString(value.brand.id);
  const brandName = nonEmptyString(value.brand.name);
  const vehicleId = nonEmptyString(value.vehicle.id);
  const vehicleSeries = nonEmptyString(value.vehicle.series);
  const vehicleTrim = nonEmptyString(value.vehicle.trim);
  const vehicleDisplayName = nonEmptyString(value.vehicle.displayName);
  const projectName = nonEmptyString(value.project.name);
  const batchName = nonEmptyString(value.project.batchName);
  const aspectRatio = nonEmptyString(value.project.aspectRatio);
  const createdAt = nonEmptyString(value.project.createdAt);
  const updatedAt = nonEmptyString(value.project.updatedAt);
  const latestActivityAt = nonEmptyString(value.latestActivityAt);
  if (
    !projectId || !brandId || !brandName || !vehicleId || !vehicleSeries || !vehicleTrim ||
    !vehicleDisplayName || !projectName || !batchName || !aspectRatio || !createdAt ||
    !updatedAt || !latestActivityAt || timestampEpoch(createdAt) === null ||
    timestampEpoch(updatedAt) === null || timestampEpoch(latestActivityAt) === null ||
    !Array.isArray(value.tasks)
  ) return null;
  if (
    nonEmptyString(value.project.brandId) !== brandId ||
    nonEmptyString(value.project.vehicleId) !== vehicleId ||
    value.project.vehicleVersion !== value.vehicle.version
  ) return null;
  if (!["active", "archived"].includes(value.project.status)) return null;
  if (
    !Number.isInteger(value.project.vehicleVersion) || value.project.vehicleVersion < 1 ||
    !Number.isInteger(value.project.revision) || value.project.revision < 1 ||
    !Number.isInteger(value.vehicle.version) || value.vehicle.version < 1 ||
    !Number.isInteger(value.vehicle.modelYear)
  ) return null;
  const seenTasks = new Set();
  const tasks = value.tasks.map(normalizeTask).filter(function (task) {
    if (!task || seenTasks.has(task.id)) return false;
    seenTasks.add(task.id);
    return true;
  });
  return {
    project: {
      id: projectId,
      brandId,
      vehicleId,
      vehicleVersion: value.project.vehicleVersion,
      name: projectName,
      batchName,
      aspectRatio,
      status: value.project.status,
      revision: value.project.revision,
      createdAt,
      updatedAt,
    },
    brand: { id: brandId, name: brandName },
    vehicle: {
      id: vehicleId,
      version: value.vehicle.version,
      series: vehicleSeries,
      modelYear: value.vehicle.modelYear,
      trim: vehicleTrim,
      displayName: vehicleDisplayName,
    },
    tasks,
    latestActivityAt,
  };
}

export function normalizeProjectLibrary(response) {
  if (!isRecord(response) || !Array.isArray(response.projects)) return [];
  const seen = new Set();
  return response.projects.map(normalizeProject).filter(function (project) {
    if (!project || seen.has(project.project.id)) return false;
    seen.add(project.project.id);
    return true;
  });
}

export function normalizeProjectSearch(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

export function filterProjectLibrary(projects, filters = {}) {
  const search = normalizeProjectSearch(filters.search);
  return projects.filter(function (summary) {
    if (filters.brandId && summary.brand.id !== filters.brandId) return false;
    if (filters.vehicleId && filters.vehicleId !== "all" && summary.vehicle.id !== filters.vehicleId) return false;
    if (filters.status && filters.status !== "all" && summary.project.status !== filters.status) return false;
    if (!search) return true;
    return normalizeProjectSearch([
      summary.project.name,
      summary.project.batchName,
      summary.brand.name,
      summary.vehicle.series,
      summary.vehicle.trim,
      summary.vehicle.displayName,
    ].join(" ")).includes(search);
  });
}

export function sortProjectLibrary(projects, sort = "recent") {
  return projects.slice().sort(function (left, right) {
    if (sort === "name") {
      return left.project.name.localeCompare(right.project.name, "zh-CN") ||
        left.project.id.localeCompare(right.project.id, "en");
    }
    return compareTimestampDescending(left.latestActivityAt, right.latestActivityAt) ||
      left.project.id.localeCompare(right.project.id, "en");
  });
}

export function collectMyActiveTasks(projects) {
  return projects.flatMap(function (summary) {
    return summary.tasks.filter(function (task) {
      return task.ownedByCurrentAccount && task.status === "active";
    }).map(function (task) {
      return {
        task,
        project: summary.project,
        brand: summary.brand,
        vehicle: summary.vehicle,
      };
    });
  }).sort(function (left, right) {
    return compareTimestampDescending(left.task.updatedAt, right.task.updatedAt) ||
      left.task.id.localeCompare(right.task.id, "en");
  });
}

export function projectVehicleOptions(projects) {
  const vehicles = new Map();
  projects.forEach(function (summary) {
    if (!vehicles.has(summary.vehicle.id)) {
      vehicles.set(summary.vehicle.id, {
        id: summary.vehicle.id,
        label: summary.vehicle.displayName,
      });
    }
  });
  return [...vehicles.values()].sort(function (left, right) {
    return left.label.localeCompare(right.label, "zh-CN") || left.id.localeCompare(right.id, "en");
  });
}

const stageLabels = {
  strategy: "营销策略",
  asset_matching: "资产匹配",
  script: "脚本",
  storyboard: "分镜",
  video_preview: "视频预览",
  delivery: "交付",
};

const stageStatusLabels = {
  in_progress: "进行中",
  awaiting_confirmation: "待确认",
  confirmed: "已确认",
};

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

function emptyNode(title, actionLabel, onAction) {
  const wrapper = document.createElement("div");
  wrapper.className = "library-empty";
  const heading = document.createElement("strong");
  heading.textContent = title;
  wrapper.appendChild(heading);
  if (actionLabel && onAction) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = actionLabel;
    button.addEventListener("click", onAction);
    wrapper.appendChild(button);
  }
  return wrapper;
}

function renderTaskCards(container, tasks, onOpenTask) {
  container.replaceChildren();
  if (tasks.length === 0) {
    container.appendChild(emptyNode("暂无进行中的任务"));
    return;
  }
  tasks.forEach(function (entry) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "my-task-card";
    card.setAttribute("aria-label", "打开任务 " + entry.task.name);
    const top = document.createElement("div");
    top.className = "my-task-topline";
    const stage = document.createElement("span");
    stage.className = "badge " + (entry.task.stageStatus === "awaiting_confirmation" ? "pending" : "neutral");
    stage.textContent = (stageLabels[entry.task.currentStage] || "处理中") +
      " · " + (stageStatusLabels[entry.task.stageStatus] || "进行中");
    const time = document.createElement("time");
    time.dateTime = entry.task.updatedAt;
    time.textContent = activityText(entry.task.updatedAt);
    top.append(stage, time);
    const title = document.createElement("h3");
    title.textContent = entry.task.name;
    title.title = entry.task.name;
    const project = document.createElement("p");
    project.textContent = entry.project.name;
    project.title = entry.project.name;
    const vehicle = document.createElement("span");
    vehicle.className = "task-vehicle";
    vehicle.textContent = entry.brand.name + " · " + entry.vehicle.displayName;
    card.append(top, title, project, vehicle);
    if (typeof onOpenTask === "function") {
      card.addEventListener("click", function () { onOpenTask(entry.project.id, entry.task.id); });
    }
    container.appendChild(card);
  });
}

export function applyProjectLibraryTaskUpdate(projects, value) {
  if (!Array.isArray(projects) || !isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const updatedAt = nonEmptyString(value.updatedAt);
  if (
    !id || !updatedAt || timestampEpoch(updatedAt) === null ||
    !["active", "completed", "cancelled", "archived"].includes(value.status) ||
    !["strategy", "asset_matching", "script", "storyboard", "video_preview", "delivery"].includes(value.currentStage) ||
    !["in_progress", "awaiting_confirmation", "confirmed"].includes(value.stageStatus) ||
    !Number.isInteger(value.revision) || value.revision < 1
  ) return null;
  for (const summary of projects) {
    const task = summary?.tasks?.find(function (candidate) { return candidate.id === id; });
    if (!task) continue;
    Object.assign(task, {
      status: value.status,
      currentStage: value.currentStage,
      stageStatus: value.stageStatus,
      revision: value.revision,
      updatedAt,
    });
    summary.latestActivityAt = updatedAt;
    return summary.project?.id || null;
  }
  return null;
}

function projectStatusBadge(status) {
  const badge = document.createElement("span");
  badge.className = "badge " + (status === "active" ? "success" : "neutral");
  badge.textContent = status === "active" ? "可用" : "已归档";
  return badge;
}

function renderProjectRows(container, projects, hasAnyProjects, resetFilters, onOpenProject) {
  container.replaceChildren();
  if (projects.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.appendChild(emptyNode(
      hasAnyProjects ? "未找到匹配项目" : "暂无项目",
      hasAnyProjects ? "清除筛选" : null,
      hasAnyProjects ? resetFilters : null,
    ));
    row.appendChild(cell);
    container.appendChild(row);
    return;
  }
  projects.forEach(function (summary) {
    const row = document.createElement("tr");
    if (summary.project.status === "archived") row.className = "archived";
    const identity = document.createElement("td");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "project-open-button";
    open.setAttribute("aria-label", "打开项目 " + summary.project.name);
    const name = document.createElement("strong");
    name.textContent = summary.project.name;
    name.title = summary.project.name;
    const brand = document.createElement("span");
    brand.textContent = summary.brand.name + " · " + summary.project.batchName;
    open.append(name, brand);
    if (typeof onOpenProject === "function") {
      open.addEventListener("click", function () { onOpenProject(summary.project.id); });
    }
    identity.appendChild(open);

    const vehicle = document.createElement("td");
    const vehicleName = document.createElement("strong");
    vehicleName.textContent = summary.vehicle.displayName;
    vehicleName.title = summary.vehicle.displayName;
    const vehicleVersion = document.createElement("span");
    vehicleVersion.textContent = "事实版本 " + summary.vehicle.version;
    vehicle.append(vehicleName, vehicleVersion);

    const taskCount = document.createElement("td");
    const activeCount = summary.tasks.filter(function (task) { return task.status === "active"; }).length;
    const taskTotal = document.createElement("strong");
    taskTotal.textContent = summary.tasks.length + " 个";
    const taskActive = document.createElement("span");
    taskActive.textContent = activeCount + " 个进行中";
    taskCount.append(taskTotal, taskActive);

    const aspectRatio = document.createElement("td");
    aspectRatio.textContent = summary.project.aspectRatio;
    const status = document.createElement("td");
    status.appendChild(projectStatusBadge(summary.project.status));
    const activity = document.createElement("td");
    const time = document.createElement("time");
    time.dateTime = summary.latestActivityAt;
    time.textContent = activityText(summary.latestActivityAt);
    activity.appendChild(time);
    row.append(identity, vehicle, taskCount, aspectRatio, status, activity);
    container.appendChild(row);
  });
}

function renderProjectMessage(container, title) {
  container.replaceChildren();
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 6;
  cell.appendChild(emptyNode(title));
  row.appendChild(cell);
  container.appendChild(row);
}

function renderSkeletons(elements, showMyTasks) {
  elements.projectList.replaceChildren();
  for (let index = 0; index < 4; index += 1) {
    const row = document.createElement("tr");
    row.className = "library-skeleton-row";
    for (let cellIndex = 0; cellIndex < 6; cellIndex += 1) {
      const cell = document.createElement("td");
      cell.appendChild(document.createElement("span"));
      row.appendChild(cell);
    }
    elements.projectList.appendChild(row);
  }
  elements.myTaskList.replaceChildren();
  if (showMyTasks) {
    for (let index = 0; index < 3; index += 1) {
      const skeleton = document.createElement("span");
      skeleton.className = "my-task-skeleton";
      elements.myTaskList.appendChild(skeleton);
    }
  }
}

function renderVehicleFilter(elements, state, brandProjects) {
  const options = projectVehicleOptions(brandProjects);
  if (state.projectLibraryVehicleId !== "all" && !options.some(function (option) {
    return option.id === state.projectLibraryVehicleId;
  })) state.projectLibraryVehicleId = "all";
  elements.vehicleFilter.replaceChildren();
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "全部车型";
  elements.vehicleFilter.appendChild(all);
  options.forEach(function (vehicle) {
    const option = document.createElement("option");
    option.value = vehicle.id;
    option.textContent = vehicle.label;
    elements.vehicleFilter.appendChild(option);
  });
  elements.vehicleFilter.value = state.projectLibraryVehicleId;
}

function renderVehiclePlaceholder(elements, label) {
  elements.vehicleFilter.replaceChildren();
  const option = document.createElement("option");
  option.value = "all";
  option.textContent = label;
  elements.vehicleFilter.appendChild(option);
  elements.vehicleFilter.value = "all";
}

export function renderProjectLibrary(options) {
  const { elements, state } = options;
  const isCreator = state.account?.role === "creator";
  const selectedBrandAvailable = Boolean(
    state.navigationBrandId && state.navigationBrands.some(function (brand) {
      return brand.id === state.navigationBrandId;
    }),
  );
  const initializationError = Boolean(
    state.projectLibraryInitializationError && state.projectLibraryError,
  );
  const loading = !initializationError && (
    state.navigationBrandsLoading || state.projectLibraryLoading
  );
  elements.libraryView.setAttribute("aria-busy", String(loading));
  elements.search.value = state.workFilter;
  elements.statusFilter.value = state.projectLibraryStatus;
  elements.sort.value = state.projectLibrarySort;
  [elements.search, elements.vehicleFilter, elements.statusFilter, elements.sort].forEach(function (control) {
    control.disabled = true;
  });
  elements.libraryError.hidden = true;
  elements.libraryErrorMessage.textContent = "";
  elements.libraryRetry.disabled = loading;

  if (loading) {
    elements.myTasksSection.hidden = !isCreator;
    renderVehiclePlaceholder(elements, "车型加载中");
    elements.projectCount.textContent = "正在加载";
    elements.myTaskCount.textContent = "—";
    renderSkeletons(elements, isCreator);
    return;
  }

  if (initializationError) {
    elements.myTasksSection.hidden = true;
    renderVehiclePlaceholder(elements, "全部车型");
    elements.libraryError.hidden = false;
    elements.libraryErrorMessage.textContent = state.projectLibraryError;
    elements.projectCount.textContent = "加载失败";
    elements.myTaskCount.textContent = "—";
    renderProjectMessage(elements.projectList, "工作区暂时无法初始化");
    elements.myTaskList.replaceChildren();
    return;
  }

  if (!selectedBrandAvailable) {
    elements.myTasksSection.hidden = true;
    renderVehiclePlaceholder(elements, "全部车型");
    elements.projectCount.textContent = state.navigationBrandsError ? "品牌不可用" : "0 个项目";
    elements.myTaskCount.textContent = "—";
    renderProjectMessage(
      elements.projectList,
      state.navigationBrandsError
        ? state.navigationBrandsError + "，请在顶部重试"
        : "暂无可访问品牌",
    );
    elements.myTaskList.replaceChildren();
    return;
  }

  if (state.projectLibraryError) {
    elements.myTasksSection.hidden = true;
    renderVehiclePlaceholder(elements, "全部车型");
    elements.libraryError.hidden = false;
    elements.libraryErrorMessage.textContent = state.projectLibraryError;
    elements.projectCount.textContent = "加载失败";
    elements.myTaskCount.textContent = "—";
    renderProjectMessage(elements.projectList, "项目暂时无法加载");
    elements.myTaskList.replaceChildren();
    return;
  }

  elements.myTasksSection.hidden = !isCreator;
  [elements.search, elements.vehicleFilter, elements.statusFilter, elements.sort].forEach(function (control) {
    control.disabled = false;
  });
  const brandProjects = filterProjectLibrary(state.projectLibrary, {
    brandId: state.navigationBrandId,
  });
  renderVehicleFilter(elements, state, brandProjects);
  const visibleProjects = sortProjectLibrary(filterProjectLibrary(brandProjects, {
    search: state.workFilter,
    vehicleId: state.projectLibraryVehicleId,
    status: state.projectLibraryStatus,
  }), state.projectLibrarySort);
  const myTasks = collectMyActiveTasks(brandProjects);
  elements.projectCount.textContent = visibleProjects.length + " 个项目";
  elements.myTaskCount.textContent = myTasks.length + " 个任务";
  if (isCreator) renderTaskCards(elements.myTaskList, myTasks, options.openTask);
  renderProjectRows(elements.projectList, visibleProjects, brandProjects.length > 0, function () {
    state.workFilter = "";
    state.projectLibraryVehicleId = "all";
    state.projectLibraryStatus = "all";
    elements.search.value = "";
    renderProjectLibrary(options);
  }, options.openProject);
}

export function bindProjectLibrary(options) {
  const { elements, state, retry } = options;
  elements.search.addEventListener("input", function () {
    state.workFilter = elements.search.value;
    renderProjectLibrary(options);
  });
  elements.vehicleFilter.addEventListener("change", function () {
    state.projectLibraryVehicleId = elements.vehicleFilter.value;
    renderProjectLibrary(options);
  });
  elements.statusFilter.addEventListener("change", function () {
    state.projectLibraryStatus = elements.statusFilter.value;
    renderProjectLibrary(options);
  });
  elements.sort.addEventListener("change", function () {
    state.projectLibrarySort = elements.sort.value;
    renderProjectLibrary(options);
  });
  elements.libraryRetry.addEventListener("click", retry);
}
