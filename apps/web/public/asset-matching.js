const categoryLabels = Object.freeze({ vehicle: "车型", person: "人物", scene: "场景", visual_style: "风格" });

export function assetReferenceIdentity(reference) {
  if (!reference || typeof reference !== "object") return "";
  return reference.source === "company_catalog"
    ? [reference.source, reference.sourceProvider, reference.assetId, reference.version, reference.category].join(":")
    : [reference.source, reference.batchProjectId, reference.assetId, reference.version, reference.category].join(":");
}

export function selectionWithManualPriority(recommendations, manualSelection) {
  return manualSelection === null
    ? new Set((recommendations || []).map(assetReferenceIdentity))
    : new Set(manualSelection);
}

function createConfirmationRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return "asset_confirmation_" + globalThis.crypto.randomUUID().replaceAll("-", "");
  }
  return "asset_confirmation_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function iconUse(symbol) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", symbol);
  svg.appendChild(use);
  return svg;
}

function fileBase64(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onerror = function () { reject(new Error("无法读取素材文件")); };
    reader.onload = function () {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

function errorText(error) {
  if (error?.status === 401) return "账号会话已失效";
  if (error?.status === 403) return "当前账号无操作权限";
  if (error?.status === 409) return "任务或素材已更新，请刷新后重试";
  return error instanceof Error && error.message ? error.message : "操作失败，请重试";
}

export function createAssetMatchingPanel(options) {
  const elements = options.elements;
  let projectId = null;
  let taskId = null;
  let contextKey = "";
  let view = null;
  let category = "all";
  let manualSelection = null;
  let confirmationRequestId = null;
  let busy = false;
  let requestSequence = 0;

  function allItems() {
    if (!view) return [];
    const company = view.companyAssets.map(function (item) {
      return {
        reference: item.reference,
        name: item.displayName,
        description: item.description || item.recommendationReason || "公司素材",
        tags: item.tags || [],
        category: item.reference.category,
        recommended: item.recommended,
        replacementAllowed: item.replacementAllowed,
        source: "company",
      };
    });
    const temporary = view.temporaryAssets
      .filter(function (item) { return item.validationStatus === "valid"; })
      .map(function (item) {
        return {
          reference: {
            assetId: item.id,
            version: item.version,
            category: item.category,
            source: "local_upload",
            batchProjectId: item.batchProjectId,
            checksumSha256: item.checksumSha256,
          },
          name: item.fileName,
          description: item.sourceDescription,
          tags: ["临时素材"],
          category: item.category,
          recommended: item.recommended,
          replacementAllowed: item.category === "person" || item.category === "scene",
          source: "temporary",
        };
      });
    return company.concat(temporary);
  }

  function selectedSet() {
    return selectionWithManualPriority(view?.selectedAssets || [], manualSelection);
  }

  function selectedReferences() {
    const selected = selectedSet();
    return allItems()
      .filter(function (item) { return selected.has(assetReferenceIdentity(item.reference)); })
      .map(function (item) { return item.reference; });
  }

  function setError(message) {
    elements.error.textContent = message || "";
    elements.error.hidden = !message;
  }

  function renderEmpty(text) {
    const empty = document.createElement("div");
    empty.className = "asset-matching-empty";
    empty.append(iconUse("#i-package"));
    const label = document.createElement("span");
    label.textContent = text;
    empty.append(label);
    elements.grid.replaceChildren(empty);
  }

  function renderCard(item) {
    const identity = assetReferenceIdentity(item.reference);
    const selected = selectedSet().has(identity);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "asset-card" + (selected ? " selected" : "") +
      (!item.replacementAllowed || view.matchingLocked ? " locked" : "");
    card.setAttribute("aria-pressed", String(selected));
    card.setAttribute("aria-label", (selected ? "取消选择 " : "选择 ") + item.name);
    card.disabled = busy || !view.matchingReady || view.matchingLocked || !item.replacementAllowed;

    const preview = document.createElement("span");
    preview.className = "asset-card-preview " + item.category;
    preview.append(iconUse(item.category === "vehicle" ? "#i-car" : item.category === "person" ? "#i-message" : "#i-image"));
    const body = document.createElement("span");
    body.className = "asset-card-body";
    const title = document.createElement("span");
    title.className = "asset-card-title";
    const strong = document.createElement("strong");
    strong.textContent = item.name;
    strong.title = item.name;
    title.append(strong);
    if (item.recommended) {
      const recommended = document.createElement("span");
      recommended.textContent = "Agent 推荐";
      title.append(recommended);
    }
    const description = document.createElement("p");
    description.className = "asset-card-description";
    description.textContent = item.description;
    const tags = document.createElement("span");
    tags.className = "asset-card-tags";
    [categoryLabels[item.category], ...item.tags].filter(Boolean).slice(0, 3).forEach(function (value) {
      const tag = document.createElement("span");
      tag.textContent = value;
      tags.append(tag);
    });
    body.append(title, description, tags);
    if (!item.replacementAllowed) {
      const locked = document.createElement("span");
      locked.className = "asset-card-lock";
      locked.textContent = "车型已锁定";
      body.append(locked);
    }
    const check = document.createElement("span");
    check.className = "asset-card-check";
    check.textContent = "✓";
    card.append(preview, body, check);
    card.addEventListener("click", function () {
      if (!view.matchingReady || view.matchingLocked || !item.replacementAllowed) return;
      const next = selectedSet();
      if (next.has(identity)) next.delete(identity); else next.add(identity);
      manualSelection = next;
      render();
    });
    return card;
  }

  function render() {
    const available = Boolean(view);
    elements.uploadOpen.disabled = busy || !available;
    elements.confirm.disabled = busy || !view?.confirmationReady || view?.matchingLocked ||
      selectedReferences().length === 0;
    elements.gate.textContent = view?.gateMessage || (taskId ? "正在读取素材" : "请选择视频任务");
    elements.notice.className = "asset-matching-notice " +
      (view?.matchingLocked ? "locked" : view?.confirmationReady ? "ready" : "neutral");
    elements.notice.querySelector("span").textContent = elements.gate.textContent;
    elements.count.textContent = selectedReferences().length + " 项已选";
    elements.tabs.forEach(function (tab) {
      const active = tab.dataset.assetCategory === category;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    if (!view) {
      renderEmpty(taskId ? "正在加载素材" : "选择任务后查看素材");
      return;
    }
    const items = allItems().filter(function (item) {
      return category === "all" || item.category === category;
    });
    if (items.length === 0) {
      renderEmpty("暂无" + (categoryLabels[category] || "可用") + "素材");
      return;
    }
    elements.grid.replaceChildren(...items.map(renderCard));
  }

  async function load() {
    const sequence = ++requestSequence;
    view = null;
    manualSelection = null;
    setError("");
    render();
    if (!projectId || !taskId) return;
    try {
      const result = await options.api.getAssetMatching(projectId, taskId);
      if (sequence !== requestSequence) return;
      view = result;
    } catch (error) {
      if (sequence !== requestSequence) return;
      setError(errorText(error));
    }
    render();
  }

  async function confirmSelection() {
    if (!view?.confirmationReady || view.matchingLocked || busy) return;
    busy = true;
    setError("");
    render();
    try {
      confirmationRequestId ||= createConfirmationRequestId();
      view = await options.api.lockAssetSelection(projectId, taskId, {
        requestId: confirmationRequestId,
        expectedTaskRevision: view.videoTask.revision,
        expectedProjectAssetPoolRevision: view.poolRevision,
        selectedAssets: selectedReferences().filter(function (reference) {
          return reference.category === "person" || reference.category === "scene";
        }),
      });
      confirmationRequestId = null;
      manualSelection = new Set(view.selectedAssets.map(assetReferenceIdentity));
      options.onTaskUpdated?.(view.videoTask);
    } catch (error) {
      setError(errorText(error));
    } finally {
      busy = false;
      render();
    }
  }

  function closeUpload() {
    if (elements.dialog.open) elements.dialog.close();
    elements.uploadError.hidden = true;
    elements.uploadError.textContent = "";
  }

  async function submitUpload(event) {
    event.preventDefault();
    const file = elements.file.files?.[0];
    if (!file || !projectId || busy) return;
    busy = true;
    elements.uploadSubmit.disabled = true;
    elements.uploadError.hidden = true;
    try {
      const result = await options.api.uploadTemporaryAsset(projectId, {
        fileName: file.name,
        fileBase64: await fileBase64(file),
        category: elements.uploadCategory.value,
        sourceDescription: elements.uploadDescription.value,
        rightsDeclaration: elements.uploadRights.value,
        rightsConfirmed: elements.uploadRightsConfirmed.checked,
      });
      if (result.asset?.validationStatus !== "valid") {
        const issue = result.asset?.validationIssues?.[0]?.message || "素材未通过校验";
        throw new Error(issue);
      }
      closeUpload();
      elements.uploadForm.reset();
      elements.fileLabel.textContent = "选择图片";
      const manual = selectedSet();
      const uploadedIdentity = assetReferenceIdentity({
        assetId: result.asset.id,
        version: result.asset.version,
        category: result.asset.category,
        source: "local_upload",
        batchProjectId: result.asset.batchProjectId,
        checksumSha256: result.asset.checksumSha256,
      });
      manual.add(uploadedIdentity);
      manualSelection = manual;
      view = await options.api.getAssetMatching(projectId, taskId);
    } catch (error) {
      elements.uploadError.textContent = errorText(error);
      elements.uploadError.hidden = false;
    } finally {
      busy = false;
      elements.uploadSubmit.disabled = false;
      render();
    }
  }

  elements.tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      category = tab.dataset.assetCategory || "all";
      render();
    });
  });
  elements.confirm.addEventListener("click", confirmSelection);
  elements.uploadOpen.addEventListener("click", function () {
    if (!view || busy) return;
    elements.dialog.showModal();
    elements.file.focus();
  });
  elements.uploadClose.addEventListener("click", closeUpload);
  elements.uploadCancel.addEventListener("click", closeUpload);
  elements.uploadForm.addEventListener("submit", submitUpload);
  elements.file.addEventListener("change", function () {
    elements.fileLabel.textContent = elements.file.files?.[0]?.name || "选择图片";
  });
  elements.dialog.addEventListener("cancel", function (event) {
    event.preventDefault();
    closeUpload();
  });

  return {
    setContext(nextProjectId, task, visible) {
      const nextTaskId = visible ? task?.id || null : null;
      const nextKey = [nextProjectId || "", nextTaskId || ""].join(":");
      projectId = nextProjectId || null;
      taskId = nextTaskId;
      if (nextKey === contextKey) return;
      contextKey = nextKey;
      confirmationRequestId = null;
      void load();
    },
    refresh: load,
  };
}
