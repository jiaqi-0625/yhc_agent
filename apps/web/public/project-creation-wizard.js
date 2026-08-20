const supportedAspectRatios = ["9:16", "16:9", "1:1", "4:5"];
export const projectDurationOptions = [10, 15, 30];
export const projectCreativeTypes = [
  { id: "creative_effects", label: "创意特效型" },
  { id: "scenario", label: "情景演绎" },
  { id: "voiceover", label: "常规口播" },
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeReference(value) {
  if (!isRecord(value)) return null;
  const assetId = stringValue(value.assetId);
  const sourceProvider = stringValue(value.sourceProvider);
  const version = positiveInteger(value.version);
  if (!assetId || !sourceProvider || !version || value.source !== "company_catalog") return null;
  if (!["vehicle", "person", "scene", "visual_style"].includes(value.category)) return null;
  if (value.category === "vehicle") {
    const vehicleId = stringValue(value.vehicleId);
    if (!vehicleId) return null;
    return { assetId, version, source: "company_catalog", sourceProvider, category: "vehicle", vehicleId };
  }
  return { assetId, version, source: "company_catalog", sourceProvider, category: value.category };
}

function normalizeAsset(value) {
  if (!isRecord(value)) return null;
  const reference = normalizeReference(value.reference);
  const displayName = stringValue(value.displayName);
  if (!reference || !displayName || !isRecord(value.preview)) return null;
  const thumbnailUrl = stringValue(value.preview.thumbnailUrl);
  return {
    reference,
    displayName,
    description: stringValue(value.description) || "",
    preview: {
      mediaType: stringValue(value.preview.mediaType) || "",
      width: positiveInteger(value.preview.width) || 0,
      height: positiveInteger(value.preview.height) || 0,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    },
  };
}

export function normalizeProjectCreationOptions(response) {
  if (!isRecord(response) || !Array.isArray(response.brands)) return { brands: [], aspectRatios: [] };
  const seenBrands = new Set();
  const brands = response.brands.map(function (value) {
    if (!isRecord(value) || !Array.isArray(value.vehicles)) return null;
    const id = stringValue(value.id);
    const name = stringValue(value.name);
    const revision = positiveInteger(value.revision);
    if (!id || !name || !revision || seenBrands.has(id)) return null;
    seenBrands.add(id);
    const seenVehicles = new Set();
    const vehicles = value.vehicles.map(function (vehicle) {
      if (!isRecord(vehicle)) return null;
      const vehicleId = stringValue(vehicle.id);
      const displayName = stringValue(vehicle.displayName);
      const series = stringValue(vehicle.series);
      const trim = stringValue(vehicle.trim);
      const version = positiveInteger(vehicle.version);
      if (
        !vehicleId || !displayName || !series || !trim || !version ||
        stringValue(vehicle.brandId) !== id || !Number.isInteger(vehicle.modelYear) || seenVehicles.has(vehicleId)
      ) return null;
      seenVehicles.add(vehicleId);
      return {
        id: vehicleId,
        brandId: id,
        version,
        series,
        modelYear: vehicle.modelYear,
        trim,
        displayName,
      };
    }).filter(Boolean);
    return { id, name, revision, vehicles };
  }).filter(Boolean);
  const aspectRatios = Array.isArray(response.aspectRatios)
    ? response.aspectRatios.filter(function (ratio, index, values) {
      return supportedAspectRatios.includes(ratio) && values.indexOf(ratio) === index;
    })
    : [];
  return { brands, aspectRatios };
}

export function normalizeProjectAssetPackage(response, vehicleId) {
  if (
    !isRecord(response) || !isRecord(response.brand) || !isRecord(response.vehicle) ||
    stringValue(response.vehicle.id) !== vehicleId || !Array.isArray(response.recommendedAssets)
  ) return null;
  const associationRevision = positiveInteger(response.associationRevision);
  const brandId = stringValue(response.brand.id);
  const brandName = stringValue(response.brand.name);
  const assets = response.recommendedAssets.map(normalizeAsset).filter(Boolean);
  if (!associationRevision || !brandId || !brandName || !assets.some(function (asset) {
    return asset.reference.category === "vehicle" && asset.reference.vehicleId === vehicleId;
  })) return null;
  return { brandId, brandName, associationRevision, assets };
}

export function normalizeProjectConfiguration(response) {
  if (!isRecord(response)) return null;
  const brandRevision = positiveInteger(response.brandRevision);
  const vehicleVersion = positiveInteger(response.vehicleVersion);
  const associationRevision = positiveInteger(response.associationRevision);
  const defaultVisualStyle = normalizeAsset(response.defaultVisualStyle);
  const aspectRatios = Array.isArray(response.aspectRatios)
    ? response.aspectRatios.filter(function (ratio, index, values) {
      return supportedAspectRatios.includes(ratio) && values.indexOf(ratio) === index;
    })
    : [];
  if (
    !brandRevision || !vehicleVersion || !associationRevision ||
    defaultVisualStyle?.reference.category !== "visual_style" || !aspectRatios.includes("9:16")
  ) return null;
  return { brandRevision, vehicleVersion, associationRevision, defaultVisualStyle, aspectRatios };
}

export function createProjectRequest(input) {
  const batchName = stringValue(input.batchName);
  if (
    !stringValue(input.requestId) || !stringValue(input.vehicleId) || !batchName || batchName.length > 120 ||
    !positiveInteger(input.expectedBrandRevision) || !positiveInteger(input.expectedVehicleVersion) ||
    !positiveInteger(input.expectedAssetAssociationRevision) || input.aspectRatio !== "9:16" ||
    !Array.isArray(input.selectedAssets)
  ) return null;
  const selectedAssets = input.selectedAssets.map(function (asset) {
    return normalizeReference(asset?.reference || asset);
  });
  if (selectedAssets.some(function (reference) { return !reference; }) || !selectedAssets.some(function (reference) {
    return reference.category === "vehicle";
  })) return null;
  return {
    requestId: input.requestId,
    vehicleId: input.vehicleId,
    expectedBrandRevision: input.expectedBrandRevision,
    expectedVehicleVersion: input.expectedVehicleVersion,
    expectedAssetAssociationRevision: input.expectedAssetAssociationRevision,
    selectedAssets,
    aspectRatio: "9:16",
    batchName,
  };
}

export function createInitialVideoTaskRequest(input) {
  const creativeType = projectCreativeTypes.find(function (candidate) { return candidate.id === input.creativeTypeId; });
  if (!stringValue(input.requestId) || !creativeType || !projectDurationOptions.includes(input.durationSeconds)) return null;
  return {
    requestId: input.requestId,
    name: creativeType.label + " · " + input.durationSeconds + "秒",
    audience: "由 Agent 基于品牌、车型与资产描述确定",
    theme: creativeType.label,
    durationSeconds: input.durationSeconds,
    platformTags: [],
  };
}

export function projectBatchName(creativeTypeId, now = new Date()) {
  const creativeType = projectCreativeTypes.find(function (candidate) { return candidate.id === creativeTypeId; });
  if (!creativeType || !(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const value = function (type) { return parts.find(function (part) { return part.type === type; })?.value || "00"; };
  return creativeType.label + " " + value("month") + value("day") + "-" + value("hour") + value("minute") + value("second");
}

function makeRequestId(prefix) {
  if (globalThis.crypto?.randomUUID) return prefix + globalThis.crypto.randomUUID().replaceAll("-", "");
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function errorMessage(error, fallback) {
  if (error?.status === 401) return "账号会话已失效，请重新切换账号。";
  if (error?.status === 403) return "当前账号不能新建项目。";
  if (error?.code === "AIC-PROJECT-CREATION-CATALOG_STALE") return "车型配置已更新，请重新提交。";
  if (error?.code === "AIC-PROJECT-CREATION-CONFLICT") return "项目名称冲突，请重新提交。";
  return fallback;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(value, text, disabled = false) {
  const node = element("option", "", text);
  node.value = value;
  node.disabled = disabled;
  return node;
}

export function createProjectCreationWizard(options) {
  const { elements, api, getAccount, getSelectedBrandId, onCreated } = options;
  const initialState = function () {
    return {
      open: false,
      loading: false,
      submitting: false,
      error: "",
      options: { brands: [], aspectRatios: [] },
      brandId: "",
      vehicleId: "",
      durationSeconds: 15,
      creativeTypeId: "scenario",
      projectRequestId: "",
      taskRequestId: "",
      batchName: "",
      createdProject: null,
    };
  };
  let state = initialState();
  let generation = 0;

  function selectedBrand() {
    return state.options.brands.find(function (brand) { return brand.id === state.brandId; }) || null;
  }

  function selectedVehicle() {
    return selectedBrand()?.vehicles.find(function (vehicle) { return vehicle.id === state.vehicleId; }) || null;
  }

  function field(labelText, control) {
    const label = element("label", "project-creation-field");
    label.append(element("span", "", labelText), control);
    return label;
  }

  function choiceField(labelText, name, choices, selected, onChange) {
    const fieldset = element("fieldset", "project-choice-field");
    fieldset.append(element("legend", "", labelText));
    const group = element("div", "project-choice-group");
    choices.forEach(function (choice) {
      const label = element("label", "project-choice" + (selected === choice.value ? " selected" : ""));
      const input = element("input");
      input.type = "radio";
      input.name = name;
      input.value = String(choice.value);
      input.checked = selected === choice.value;
      input.disabled = state.submitting;
      input.addEventListener("change", function () { onChange(choice.value); });
      label.append(input, element("span", "", choice.label));
      group.append(label);
    });
    fieldset.append(group);
    return fieldset;
  }

  function renderForm() {
    const form = element("div", "project-creation-card");
    const grid = element("div", "project-creation-grid");
    const brandSelect = element("select");
    brandSelect.id = "new-project-brand";
    brandSelect.append(option("", "请选择品牌", true));
    state.options.brands.forEach(function (brand) { brandSelect.append(option(brand.id, brand.name)); });
    brandSelect.value = state.brandId;
    brandSelect.disabled = state.submitting;
    brandSelect.addEventListener("change", function () {
      state.brandId = brandSelect.value;
      state.vehicleId = "";
      state.error = "";
      render();
    });
    const vehicleSelect = element("select");
    vehicleSelect.id = "new-project-vehicle";
    vehicleSelect.append(option("", state.brandId ? "请选择车型" : "请先选择品牌", true));
    (selectedBrand()?.vehicles || []).forEach(function (vehicle) {
      vehicleSelect.append(option(vehicle.id, vehicle.displayName));
    });
    vehicleSelect.value = state.vehicleId;
    vehicleSelect.disabled = state.submitting || !state.brandId;
    vehicleSelect.addEventListener("change", function () {
      state.vehicleId = vehicleSelect.value;
      state.error = "";
      renderSubmit();
    });
    grid.append(field("品牌", brandSelect), field("车型", vehicleSelect));
    form.append(grid);
    form.append(choiceField(
      "时长",
      "project-duration",
      projectDurationOptions.map(function (duration) { return { value: duration, label: duration + "秒" }; }),
      state.durationSeconds,
      function (value) { state.durationSeconds = value; state.error = ""; render(); },
    ));
    form.append(choiceField(
      "类型",
      "project-creative-type",
      projectCreativeTypes.map(function (type) { return { value: type.id, label: type.label }; }),
      state.creativeTypeId,
      function (value) { state.creativeTypeId = value; state.error = ""; render(); },
    ));
    return form;
  }

  function renderSubmit() {
    elements.submit.disabled = state.submitting || !selectedVehicle();
    elements.submit.textContent = state.submitting ? "正在创建…" : "创建项目";
    elements.back.disabled = state.submitting;
  }

  function render() {
    elements.error.hidden = !state.error;
    elements.errorMessage.textContent = state.error;
    elements.body.replaceChildren();
    if (state.loading) {
      elements.body.append(element("p", "project-creation-loading", "正在加载品牌与车型…"));
    } else if (state.options.brands.length === 0) {
      const empty = element("div", "project-creation-empty");
      empty.append(element("p", "", "品牌与车型暂不可用"));
      const retry = element("button", "button secondary", "重试");
      retry.type = "button";
      retry.addEventListener("click", function () { void loadOptions(); });
      empty.append(retry);
      elements.body.append(empty);
    } else {
      elements.body.append(renderForm());
    }
    elements.view.setAttribute("aria-busy", String(state.loading || state.submitting));
    renderSubmit();
  }

  async function loadOptions() {
    const request = ++generation;
    state.loading = true;
    state.error = "";
    render();
    try {
      const normalized = normalizeProjectCreationOptions(await api.getProjectCreationOptions());
      if (request !== generation || !state.open) return;
      if (normalized.brands.length === 0) throw new Error("no brands");
      state.options = normalized;
      const preferred = getSelectedBrandId();
      state.brandId = normalized.brands.some(function (brand) { return brand.id === preferred; })
        ? preferred
        : normalized.brands[0].id;
    } catch (error) {
      if (request !== generation || !state.open) return;
      state.error = errorMessage(error, "品牌与车型加载失败，请重试。");
    } finally {
      if (request !== generation || !state.open) return;
      state.loading = false;
      render();
    }
  }

  async function submit() {
    if (state.submitting || !selectedVehicle()) return;
    if (!state.projectRequestId) state.projectRequestId = makeRequestId("request_project_");
    if (!state.taskRequestId) state.taskRequestId = makeRequestId("request_task_");
    if (!state.batchName) state.batchName = projectBatchName(state.creativeTypeId) || "信息流广告";
    const requestGeneration = generation;
    state.submitting = true;
    state.error = "";
    render();
    try {
      if (!state.createdProject) {
        const [packageResponse, configurationResponse] = await Promise.all([
          api.getProjectAssetPackage(state.vehicleId),
          api.getProjectConfiguration(state.vehicleId),
        ]);
        if (requestGeneration !== generation || !state.open) return;
        const assetPackage = normalizeProjectAssetPackage(packageResponse, state.vehicleId);
        const configuration = normalizeProjectConfiguration(configurationResponse);
        const brand = selectedBrand();
        const vehicle = selectedVehicle();
        if (
          !assetPackage || !configuration || !brand || !vehicle || assetPackage.brandId !== brand.id ||
          configuration.brandRevision !== brand.revision || configuration.vehicleVersion !== vehicle.version ||
          configuration.associationRevision !== assetPackage.associationRevision
        ) throw new Error("invalid project configuration");
        const projectRequest = createProjectRequest({
          requestId: state.projectRequestId,
          vehicleId: state.vehicleId,
          expectedBrandRevision: configuration.brandRevision,
          expectedVehicleVersion: configuration.vehicleVersion,
          expectedAssetAssociationRevision: assetPackage.associationRevision,
          selectedAssets: assetPackage.assets,
          aspectRatio: "9:16",
          batchName: state.batchName,
        });
        if (!projectRequest) throw new Error("invalid project request");
        state.createdProject = await api.createBatchProject(projectRequest);
      }
      if (requestGeneration !== generation || !state.open) return;
      const projectId = stringValue(state.createdProject?.project?.id);
      const taskRequest = createInitialVideoTaskRequest({
        requestId: state.taskRequestId,
        creativeTypeId: state.creativeTypeId,
        durationSeconds: state.durationSeconds,
      });
      if (!projectId || !taskRequest) throw new Error("invalid task request");
      await api.createVideoTask(projectId, taskRequest);
      if (requestGeneration !== generation || !state.open) return;
      const projectName = state.createdProject?.project?.name || state.batchName;
      const createdProject = state.createdProject;
      state.submitting = false;
      close();
      elements.success.textContent = "项目“" + projectName + "”已创建";
      elements.success.hidden = false;
      globalThis.setTimeout(function () { elements.success.hidden = true; }, 5000);
      await onCreated(createdProject);
    } catch (error) {
      if (requestGeneration !== generation || !state.open) return;
      state.error = state.createdProject
        ? "项目已创建，首条任务创建失败，请重试。"
        : errorMessage(error, "项目创建失败，请重试。");
      state.submitting = false;
      render();
    }
  }

  function open() {
    if (getAccount()?.role !== "creator" || state.open) return;
    generation += 1;
    state = initialState();
    state.open = true;
    elements.library.hidden = true;
    elements.view.hidden = false;
    elements.topbarTitle.textContent = "新建项目";
    render();
    void loadOptions();
  }

  function close() {
    if (state.submitting) return;
    generation += 1;
    state = initialState();
    elements.view.hidden = true;
    elements.library.hidden = false;
    elements.topbarTitle.textContent = "项目库";
  }

  function resetForAccount() {
    generation += 1;
    state = initialState();
    elements.view.hidden = true;
    elements.library.hidden = false;
    elements.topbarTitle.textContent = "项目库";
    syncAvailability();
  }

  function syncAvailability() {
    const creator = getAccount()?.role === "creator";
    elements.open.disabled = !creator;
    elements.open.title = creator ? "新建项目" : "仅制作账号可新建项目";
    elements.open.setAttribute("aria-disabled", String(!creator));
  }

  elements.open.addEventListener("click", open);
  elements.back.addEventListener("click", close);
  elements.submit.addEventListener("click", function () { void submit(); });
  syncAvailability();
  return { open, close, resetForAccount, syncAvailability };
}
