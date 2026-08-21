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
  if (stage === "script" && task.scriptInput) {
    return { enabled: true, label: "确认脚本" };
  }
  if (["storyboard", "video_preview", "delivery"].includes(stage) && view?.generatedArtifact) {
    return {
      enabled: true,
      label: stage === "storyboard" ? "确认方案并进入真实视频" : stage === "video_preview" ? "确认模拟预览" : "确认模拟交付",
    };
  }
  const active = view?.versions?.find(function (item) { return item.id === view.activeArtifactVersionId; });
  return active
    ? { enabled: true, label: "确认本阶段", artifact: active.content }
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
  if (!task.scriptInput && !version) {
    return `<div class="production-empty"><span>策略确认后由 Agent 生成脚本</span></div>`;
  }
  const script = view?.scriptAdaptation?.source === "selected_presenter"
    ? view.scriptAdaptation.script
    : task.scriptInput || [
    `开场：以${task.theme}建立画面。`,
    `主体：围绕${task.audience}呈现车型卖点。`,
      `收束：品牌与车型露出。`,
    ].join("\n");
  return `<div class="script-layout">
    <section class="production-card script-document"><header><div><h3>${version ? `脚本 v${version.version}` : "已有脚本"}${view?.scriptAdaptation ? " · 人物口播适配" : ""}</h3><span>${task.durationSeconds} 秒</span></div><span class="stage-mini-status">${task.platformTags?.[0] || "信息流"}</span></header>
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
    return {
      name: item.displayName,
      description: item.description || item.recommendationReason || "",
      tags: item.tags || [],
      category: item.reference.category,
      reference: item.reference,
    };
  });
  const temporary = (assetView.temporaryAssets || []).map(function (item) {
    return {
      name: item.fileName,
      description: item.sourceDescription || "",
      tags: [],
      category: item.category,
      reference: { ...item, assetId: item.id, source: "local_upload" },
    };
  });
  return company.concat(temporary).filter(function (item) {
    return selected.has([item.reference.source, item.reference.assetId, item.reference.version, item.reference.category].join(":"));
  });
}

export function simulatedStageActionCard(videoTaskId, stage, expectedRevision) {
  return {
    schemaVersion: 1,
    kind: "agent_action_card",
    videoTaskId,
    action: "generate_simulated_stage_artifact",
    label: "生成当前阶段模拟产物",
    summary: stage === "storyboard"
      ? "先生成可人工确认的镜头时序与素材映射；确认后在制作阶段调用真实视频模型逐镜头生成。"
      : "生成用于 WS-503 完整用户链路验收的当前阶段模拟产物。",
    expectedRevision,
    cost: { kind: "free" },
    payload: { schemaVersion: 1, stage },
  };
}

function storyboardFallbackShots(task) {
  const durations = task.durationSeconds === 10 ? [4, 3, 3]
    : task.durationSeconds === 15 ? [3, 3, 3, 3, 3]
      : [5, 5, 5, 5, 5, 5];
  let startSeconds = 0;
  return durations.map(function (durationSeconds, shotIndex) {
    const endSeconds = startSeconds + durationSeconds;
    const shot = {
      shotIndex,
      startSeconds,
      endSeconds,
      durationSeconds,
      purpose: shotIndex === 0 ? "脚本开场" : shotIndex === durations.length - 1 ? "品牌收束" : "脚本卖点演绎",
      scriptExcerpt: "未能解析脚本时间段，请返回脚本阶段修正后再确认。",
    };
    startSeconds = endSeconds;
    return shot;
  });
}

function storyboardShots(task, view) {
  return view?.storyboardPlan?.source === "confirmed_script" && Array.isArray(view.storyboardPlan.shots)
    ? view.storyboardPlan.shots
    : storyboardFallbackShots(task);
}

const storyboardAssetRules = Object.freeze([
  { script: ["后排", "空间", "座椅", "放倒", "装载", "后备箱"], asset: ["后排", "座椅", "内饰", "后备箱", "放倒"] },
  { script: ["续航", "CLTC", "电池", "仪表", "充电", "补能"], asset: ["仪表", "座舱", "中控", "充电", "电池"] },
  { script: ["前脸", "侧面", "外观", "车身", "整车", "定格", "车型名称"], asset: ["整车", "前45度", "侧面", "外观", "棚拍"] },
]);

function storyboardAssetScore(asset, shot) {
  const script = `${shot.purpose} ${shot.scriptExcerpt}`.toLocaleLowerCase("zh-CN");
  const assetText = `${asset.name} ${asset.description || ""} ${(asset.tags || []).join(" ")}`.toLocaleLowerCase("zh-CN");
  return storyboardAssetRules.reduce(function (score, rule) {
    if (!rule.script.some(function (term) { return script.includes(term.toLocaleLowerCase("zh-CN")); })) return score;
    return score + rule.asset.reduce(function (value, term) {
      return value + (assetText.includes(term.toLocaleLowerCase("zh-CN")) ? 1 : 0);
    }, 0);
  }, 0);
}

function shotVehicle(vehicles, shot) {
  return vehicles
    .map(function (asset, index) { return { asset, index, score: storyboardAssetScore(asset, shot) }; })
    .sort(function (left, right) { return right.score - left.score || left.index - right.index; })[0]?.asset || null;
}

function shotRequires(shot, category) {
  const text = shot.scriptExcerpt.toLocaleLowerCase("zh-CN");
  const terms = category === "person"
    ? ["人物", "一家", "父母", "孩子", "驾驶员", "乘员", "主持人", "主播", "口播", "出镜"]
    : ["清晨", "露营", "城市", "道路", "公路", "社区", "湖边", "夜间", "出发"];
  return terms.some(function (term) { return text.includes(term.toLocaleLowerCase("zh-CN")); });
}

function storyboardBody(task, view, assetView, adjustments, generations, shotMedia) {
  const assets = assetItems(assetView);
  const vehicles = assets.filter(function (item) { return item.category === "vehicle"; });
  const people = assets.filter(function (item) { return item.category === "person"; });
  const scenes = assets.filter(function (item) { return item.category === "scene"; });
  const shots = storyboardShots(task, view);
  const version = activeVersion(view);
  return `<div class="storyboard-toolbar"><span>${shots.length} 个真实视频目标镜头 · ${task.durationSeconds} 秒</span><span>${version ? `分镜方案 v${version.version}` : "分镜方案（不调用视频模型）"}</span></div>
    <div class="storyboard-grid">${shots.map(function (shot, index) {
      const vehicle = shotVehicle(vehicles, shot);
      const generation = latestVideoGenerationForShot(generations, index);
      const media = shotMedia.get(index);
      const personRequired = shotRequires(shot, "person");
      const sceneRequired = shotRequires(shot, "scene");
      const person = personRequired ? adjustments[index]?.person || people[index % Math.max(people.length, 1)] || null : null;
      const scene = sceneRequired ? adjustments[index]?.scene || scenes[index % Math.max(scenes.length, 1)] || null : null;
      return `<article class="storyboard-shot">
        <div class="shot-preview">${media
          ? `<video controls playsinline preload="auto" src="${escapeHtml(media.url)}" aria-label="镜头 ${index + 1} 视频预览"></video>`
          : generation?.status === "queued" || generation?.status === "running"
            ? `<div class="shot-video-loading"><svg class="icon" aria-hidden="true"><use href="#i-film" /></svg><strong>${generation.progressPercent}%</strong><small>视频生成中</small></div>`
            : generation?.status === "succeeded"
              ? '<div class="shot-video-loading"><svg class="icon" aria-hidden="true"><use href="#i-film" /></svg><small>视频载入中</small></div>'
              : '<svg class="icon" aria-hidden="true"><use href="#i-image" /></svg>'}<span>${String(index + 1).padStart(2, "0")}</span><small>${shot.startSeconds}–${shot.endSeconds}s</small></div>
        <div class="shot-body"><header><div><h3>镜头 ${index + 1}</h3><p>${escapeHtml(shot.purpose)}</p></div><div class="shot-header-actions">${media ? `<button type="button" class="shot-video-open" data-shot-video-index="${index}">完整预览</button>` : ""}${adjustments[index] ? '<span class="stage-mini-status pending">人工调整</span>' : ""}</div></header>
          <p class="storyboard-script-excerpt"><strong>对应脚本</strong>${escapeHtml(shot.scriptExcerpt)}</p>
          <div class="shot-assets">
            <div><span>车型</span><strong>${escapeHtml(vehicle?.name || "已锁定车型")}</strong><em>锁定</em></div>
            <div><span>人物</span><strong>${escapeHtml(personRequired ? person?.name || "缺少匹配人物" : "脚本未要求")}</strong>${personRequired ? `<button type="button" data-shot-adjust="person" data-shot-index="${index}" ${people.length ? "" : "disabled"}>更换</button>` : ""}</div>
            <div><span>场景</span><strong>${escapeHtml(sceneRequired ? scene?.name || "缺少匹配场景" : "脚本未要求")}</strong>${sceneRequired ? `<button type="button" data-shot-adjust="scene" data-shot-index="${index}" ${scenes.length ? "" : "disabled"}>更换</button>` : ""}</div>
          </div>
        </div>
      </article>`;
    }).join("")}</div>`;
}

export function expectedVideoShotCount(durationSeconds) {
  return ({ 10: 3, 15: 5, 30: 6 })[durationSeconds] || 0;
}

export function remainingVideoShotIndices(shotCount, generations) {
  const completed = new Set((generations || []).filter(function (item) {
    return item.audioEnabled === true && item.status === "succeeded" && item.output;
  }).map(function (item) { return item.shotIndex; }));
  return Array.from({ length: shotCount }, function (_value, shotIndex) { return shotIndex; })
    .filter(function (shotIndex) { return !completed.has(shotIndex); });
}

export function latestVideoGenerationForShot(generations, shotIndex) {
  return [...(generations || [])].reverse().find(function (item) {
    return item.shotIndex === shotIndex;
  }) || null;
}

function previewBody(task, view, project, generation, generations, mediaObjectUrl) {
  const version = activeVersion(view);
  const ratio = project?.project?.aspectRatio || "9:16";
  const composite = (generations || []).find(function (item) { return item.audioEnabled === true && item.composite; })?.composite
    || (generation?.audioEnabled === true ? generation.composite : null);
  const completedShots = new Set((generations || []).filter(function (item) {
    return item.audioEnabled === true && item.status === "succeeded" && item.output;
  }).map(function (item) { return item.shotIndex; })).size;
  const expectedShots = expectedVideoShotCount(task.durationSeconds);
  const mediaLabel = composite ? "完整广告成片" : "当前已完成镜头片段";
  const mediaDuration = composite?.durationSeconds || generation?.output?.durationSeconds || task.durationSeconds;
  return `<div class="preview-layout ratio-${ratio.replace(":", "-")}">
    <section class="preview-player ratio-${ratio.replace(":", "-")}">${mediaObjectUrl
      ? `<video controls playsinline preload="auto" src="${escapeHtml(mediaObjectUrl)}" aria-label="${mediaLabel}"></video>`
      : `<div><span class="preview-play"><svg class="icon" aria-hidden="true"><use href="#i-film" /></svg></span><strong>${generation ? "真实广告生成中" : "等待生成完整广告"}</strong><small>${generation ? `当前镜头状态：${escapeHtml(generation.status)} · ${generation.progressPercent}%` : "生成前会展示总预估费用并要求人工确认"}</small></div>`}<time>00:${String(Math.round(mediaDuration)).padStart(2, "0")}</time></section>
    <aside class="production-card preview-info"><header><h3>${version ? `预览 v${version.version}` : "预览信息"}</h3>${statusBadge(task, "video_preview")}</header><dl><div><dt>画幅</dt><dd>${escapeHtml(ratio)}</dd></div><div><dt>当前媒体</dt><dd>${mediaDuration} 秒</dd></div><div><dt>生成状态</dt><dd>${composite ? "完整广告已合成" : `已完成 ${completedShots}/${expectedShots} 个镜头`}</dd></div></dl>${mediaObjectUrl ? `<a class="button secondary" href="${escapeHtml(mediaObjectUrl)}" download="${composite ? "完整广告.mp4" : "当前镜头片段.mp4"}">下载${mediaLabel}</a>` : ""}</aside>
  </div>`;
}

function generationStatusBody(generation, generations, expectedCount) {
  if (!generation && !generations?.length) return '<p class="production-empty-copy">尚未生成真实视频。点击“生成完整广告”后将逐镜头生成并合成为成片。</p>';
  const status = { queued: "已排队", running: "生成中", succeeded: "生成完成", failed: "生成失败", cancelled: "已取消" }[generation.status] || generation.status;
  const latest = new Map();
  (generations || [generation]).forEach(function (item) { latest.set(item.shotIndex, item); });
  const cards = [...latest.values()].sort(function (left, right) { return left.shotIndex - right.shotIndex; }).map(function (item) {
    const itemStatus = { queued: "已排队", running: "生成中", succeeded: "生成完成", failed: "生成失败", cancelled: "已取消" }[item.status] || item.status;
    const failure = item.failure ? `<p class="production-error" role="alert">${escapeHtml(item.failure.message)}</p>` : "";
    const audioStatus = item.audioEnabled === true && item.status === "succeeded" && item.output ? " · 音轨已校验" : "";
    return `<article class="production-card"><header><h3>真实视频 · 第 ${item.shotIndex + 1} 镜头</h3><span class="stage-mini-status ${item.status === "succeeded" ? "success" : ""}">${escapeHtml(itemStatus)}</span></header><p>进度 ${item.progressPercent}% · 预估 ${(item.estimate.amountMinor / 100).toFixed(2)} ${escapeHtml(item.estimate.currency)}${audioStatus}</p>${failure}</article>`;
  }).join("");
  const composite = (generations || []).find(function (item) { return item.audioEnabled === true && item.composite; })?.composite
    || (generation?.audioEnabled === true ? generation.composite : null);
  const completedCount = [...latest.values()].filter(function (item) {
    return item.audioEnabled === true && item.status === "succeeded" && item.output;
  }).length;
  const progress = composite
    ? "全部镜头已合成，完整广告可在播放器中验收。"
    : completedCount < expectedCount
      ? `已完成 ${completedCount}/${expectedCount} 个镜头，完整广告尚未合成。请点击“继续生成完整广告”完成剩余镜头。`
      : `${status}；所有镜头完成后仍需合成为完整广告。`;
  return `<p class="production-empty-copy">${escapeHtml(progress)}</p><div class="delivery-grid">${cards}</div>`;
}

function deliveryBody(task, views) {
  const files = [
    ["成片 MP4", "video_preview"], ["字幕", "video_preview"], ["最终脚本", "script"],
    ["分镜", "storyboard"], ["素材清单", "asset_matching"], ["剪映草稿", "delivery"],
  ];
  return `<div class="delivery-summary"><section><span>${task.status === "completed" ? "交付完成" : "交付准备"}</span><strong>${files.filter(function (entry) { return activeVersion(views[entry[1]]); }).length} / ${files.length}</strong><small>文件就绪</small></section><p>可逐镜头调用真实视频模型，并在全部完成后合成为一条 H.264 + AAC 有声 MP4 广告。</p></div>
    <div class="delivery-grid">${files.map(function ([name, stage]) {
      const ready = Boolean(activeVersion(views[stage]));
      return `<article class="production-card"><span class="delivery-file-icon"><svg class="icon" aria-hidden="true"><use href="${name.includes("成片") ? "#i-film" : name.includes("素材") ? "#i-package" : "#i-file"}" /></svg></span><div><h3>${name}</h3><p>${ready ? "版本已确认" : "尚未生成"}</p></div><span class="stage-mini-status ${ready ? "success" : ""}">${ready ? "就绪" : "等待"}</span></article>`;
    }).join("")}</div>`;
}

function productionStatusCard(label, presentation) {
  return `<article class="production-status-card ${presentation.tone || "neutral"}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(presentation.value)}</strong><small>${escapeHtml(presentation.detail)}</small></article>`;
}

function productionStatusStrip(budgetState, runLockState) {
  const estimate = { tone: "neutral", value: "生成前获取", detail: "点击真实生成后由服务端计算" };
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
  let videoGeneration = null;
  let videoGenerations = [];
  let videoGenerationError = null;
  let videoMediaObjectUrl = null;
  let videoMediaArtifactId = null;
  let storyboardShotMedia = new Map();
  let videoPollTimer = null;
  let adjustments = {};
  let contextAccountId = null;
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
    videoGeneration = null;
    videoGenerations = [];
    videoGenerationError = null;
    if (videoMediaObjectUrl) URL.revokeObjectURL(videoMediaObjectUrl);
    videoMediaObjectUrl = null;
    videoMediaArtifactId = null;
    storyboardShotMedia.forEach(function (item) { URL.revokeObjectURL(item.url); });
    storyboardShotMedia = new Map();
    if (videoPollTimer) clearTimeout(videoPollTimer);
    videoPollTimer = null;
    adjustments = {};
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

  function reset() {
    contextGeneration += 1;
    sequence += 1;
    projectId = null;
    project = null;
    task = null;
    visibleModule = null;
    contextAccountId = null;
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
    const availability = confirmationAvailability(task, stage, view);
    const canGenerateSimulation = ["storyboard", "video_preview", "delivery"].includes(stage)
      && task.currentStage === stage
      && task.stageStatus === "in_progress";
    const canGenerateRealVideo = ["video_preview", "delivery"].includes(stage)
      && task.status === "active"
      && task.ownerAccountId === options.getCurrentAccountId?.();
    const simulationLabel = stage === "storyboard" ? "生成分镜方案（不调用视频模型）"
      : stage === "video_preview" ? "生成模拟预览"
      : "准备模拟交付";
    const body = stage === "strategy" ? strategyBody(task, view)
      : stage === "script" ? scriptBody(task, view)
      : stage === "storyboard" ? storyboardBody(task, view, assetView, adjustments, videoGenerations, storyboardShotMedia)
      : stage === "video_preview" ? previewBody(task, view, project, videoGeneration, videoGenerations, videoMediaObjectUrl)
      : deliveryBody(task, stageViews);
    root.innerHTML = `<div class="production-stage-shell">
      <header class="production-stage-header"><div><div class="production-stage-title"><h2>${stageLabels[stage]}</h2>${statusBadge(task, stage)}</div><p>${notice(stage)}</p></div>
        <div class="production-stage-actions"><button class="button secondary" type="button" data-stage-history ${view?.versions?.length ? "" : "disabled"}>历史版本${view?.versions?.length ? ` (${view.versions.length})` : ""}</button>${canGenerateRealVideo ? `<button class="button primary" type="button" data-generate-real-video ${busy ? "disabled" : ""}>${videoGenerations.length ? "继续生成完整广告" : "生成完整广告"}</button>` : ""}${canGenerateSimulation ? `<button class="button secondary" type="button" data-stage-generate-simulation ${busy ? "disabled" : ""}>${simulationLabel}</button>` : ""}<button class="button primary" type="button" data-stage-confirm ${availability.enabled && !busy ? "" : "disabled"}>${availability.label}</button></div>
      </header>
      ${visibleModule === "planning" ? '<div class="planning-tabs" role="tablist" aria-label="策划阶段"><button type="button" role="tab" data-planning-stage="strategy">营销策略</button><button type="button" role="tab" data-planning-stage="script">脚本</button></div>' : ""}
      ${stagePath(task, stage)}
      <div class="production-stage-notice ${stagePosition(task, stage)}"><svg class="icon" aria-hidden="true"><use href="#i-spark" /></svg><span>${notice(stage)}</span></div>
      ${["video_preview", "delivery"].includes(stage) ? productionStatusStrip(budgetState, runLockState) : ""}
      ${["video_preview", "delivery"].includes(stage) ? generationStatusBody(videoGeneration, videoGenerations, expectedVideoShotCount(task.durationSeconds)) : ""}
      ${videoGenerationError ? `<div class="production-error" role="alert">${escapeHtml(errorText(videoGenerationError))}</div>` : ""}
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
    root.querySelector("[data-stage-generate-simulation]")?.addEventListener("click", generateSimulatedStage);
    root.querySelector("[data-generate-real-video]")?.addEventListener("click", generateRealVideo);
    root.querySelector("[data-stage-confirm]")?.addEventListener("click", confirmStage);
    root.querySelectorAll("[data-shot-video-index]").forEach(function (button) {
      button.addEventListener("click", function () { showShotVideo(Number(button.dataset.shotVideoIndex)); });
    });
    root.querySelectorAll("[data-shot-adjust]").forEach(function (button) {
      button.addEventListener("click", function () { showAssetPicker(Number(button.dataset.shotIndex), button.dataset.shotAdjust); });
    });
  }

  function scheduleVideoPoll() {
    if (videoPollTimer) clearTimeout(videoPollTimer);
    if (!["queued", "running"].includes(videoGeneration?.status)) return;
    const scheduledGeneration = contextGeneration;
    videoPollTimer = setTimeout(function () {
      if (scheduledGeneration === contextGeneration) void loadLatestVideoGeneration();
    }, 4000);
  }

  async function loadGenerationMedia() {
    const composite = videoGenerations.find(function (item) { return item.audioEnabled === true && item.composite; })?.composite
      || (videoGeneration?.audioEnabled === true ? videoGeneration.composite : null);
    const output = composite || (videoGeneration?.audioEnabled === true ? videoGeneration.output : null);
    if (!output || output.artifactId === videoMediaArtifactId) return;
    const generation = contextGeneration;
    const blob = await options.api.getVideoGenerationMedia(output.mediaUrl);
    if (generation !== contextGeneration) return;
    if (videoMediaObjectUrl) URL.revokeObjectURL(videoMediaObjectUrl);
    videoMediaObjectUrl = URL.createObjectURL(blob);
    videoMediaArtifactId = output.artifactId;
    render();
  }

  async function loadStoryboardShotMedia() {
    const generation = contextGeneration;
    try {
      const completed = videoGenerations.filter(function (item) {
        return item.audioEnabled === true && item.status === "succeeded" && item.output;
      });
      const loaded = await Promise.all(completed.map(async function (item) {
        const existing = storyboardShotMedia.get(item.shotIndex);
        if (existing?.artifactId === item.output.artifactId) return [item.shotIndex, existing];
        const blob = await options.api.getVideoGenerationMedia(item.output.mediaUrl);
        return [item.shotIndex, {
          artifactId: item.output.artifactId,
          url: URL.createObjectURL(blob),
        }];
      }));
      if (generation !== contextGeneration) {
        loaded.forEach(function ([, item]) {
          if (![...storyboardShotMedia.values()].some(function (existing) { return existing.url === item.url; })) {
            URL.revokeObjectURL(item.url);
          }
        });
        return;
      }
      const next = new Map(loaded);
      storyboardShotMedia.forEach(function (item) {
        if (![...next.values()].some(function (candidate) { return candidate.url === item.url; })) {
          URL.revokeObjectURL(item.url);
        }
      });
      storyboardShotMedia = next;
      videoGenerationError = null;
      render();
    } catch (error) {
      if (generation !== contextGeneration) return;
      videoGenerationError = error;
      render();
    }
  }

  async function loadLatestVideoGeneration() {
    const generation = contextGeneration;
    const activeProjectId = projectId;
    const activeTaskId = task?.id;
    if (!activeProjectId || !activeTaskId) return;
    try {
      const result = await options.api.getLatestVideoGeneration(activeProjectId, activeTaskId);
      if (generation !== contextGeneration || activeProjectId !== projectId || activeTaskId !== task?.id) return;
      videoGeneration = result.generation;
      videoGenerations = result.generations || (result.generation ? [result.generation] : []);
      videoGenerationError = null;
      render();
      if (visibleModule === "storyboard") await loadStoryboardShotMedia();
      else if (videoGeneration?.output) await loadGenerationMedia();
      scheduleVideoPoll();
    } catch (error) {
      if (generation !== contextGeneration) return;
      videoGenerationError = error;
      render();
    }
  }

  async function generateRealVideo() {
    if (busy || !task || !projectId) return;
    const generation = contextGeneration;
    setPanelBusy(true);
    render();
    try {
      const estimateResult = await options.api.getVideoGenerationEstimate(projectId, task.id);
      const estimate = estimateResult.estimate;
      const plan = estimateResult.plan;
      let latestResult = await options.api.getLatestVideoGeneration(projectId, task.id);
      const remainingIndices = remainingVideoShotIndices(plan.shotCount, latestResult.generations);
      const remainingDurations = remainingIndices.map(function (shotIndex) { return plan.shotDurationsSeconds[shotIndex]; });
      const remainingAmountMinor = estimate.amountMinor * remainingIndices.length;
      const generationSummary = remainingIndices.length
        ? `将调用真实视频模型生成剩余 ${remainingIndices.length} 个分镜镜头，并在全部完成后合成为完整广告。\n剩余镜头时长：${remainingDurations.join(" + ")} 秒\n本次预估费用：${(remainingAmountMinor / 100).toFixed(2)} ${estimate.currency}`
        : "全部分镜镜头均已生成，本次只进行本地完整广告合成，不再调用视频模型。";
      const confirmed = window.confirm(`${generationSummary}\n所有镜头与最终成片都必须通过音轨校验。\n\n是否继续？`);
      if (!confirmed || generation !== contextGeneration) return;
      for (let shotIndex = 0; shotIndex < plan.shotCount; shotIndex += 1) {
        if (generation !== contextGeneration) return;
        let shot = [...(latestResult.generations || [])].reverse().find(function (item) {
          return item.audioEnabled === true && item.shotIndex === shotIndex;
        });
        if (!shot || !["queued", "running", "succeeded"].includes(shot.status)) {
          const started = await options.api.startVideoGeneration(projectId, task.id, {
            requestId: requestId("video_generation_shot_audio_v1_" + shotIndex),
            expectedTaskRevision: task.revision,
            shotIndex: shotIndex,
          });
          shot = started.generation;
        }
        while (["queued", "running"].includes(shot.status)) {
          videoGeneration = shot;
          videoGenerations = [...(latestResult.generations || []).filter(function (item) { return item.shotIndex !== shotIndex; }), shot];
          render();
          await new Promise(function (resolveWait) { setTimeout(resolveWait, 4000); });
          if (generation !== contextGeneration) return;
          const polled = await options.api.getVideoGeneration(projectId, task.id, shot.id);
          shot = polled.generation;
        }
        if (shot.status !== "succeeded") throw new Error(`第 ${shotIndex + 1} 个镜头生成失败：${shot.failure?.message || "请重试"}`);
        latestResult = await options.api.getLatestVideoGeneration(projectId, task.id);
        videoGeneration = latestResult.generation;
        videoGenerations = latestResult.generations || [];
        render();
      }
      const composed = await options.api.composeVideoGeneration(projectId, task.id, {
        requestId: requestId("video_composition_audio_v1"),
        expectedTaskRevision: task.revision,
      });
      if (generation !== contextGeneration) return;
      videoGeneration = composed.generation;
      videoGenerations = composed.generations || [];
      videoGenerationError = null;
      await loadGenerationMedia();
    } catch (error) {
      if (generation === contextGeneration) {
        videoGenerationError = error;
        showMessage(errorText(error));
      }
    } finally {
      if (generation === contextGeneration) {
        setPanelBusy(false);
        render();
      }
    }
  }

  async function generateSimulatedStage() {
    const stage = currentStage();
    if (!["storyboard", "video_preview", "delivery"].includes(stage) || busy) return;
    const mutationContextGeneration = contextGeneration;
    const mutationProjectId = projectId;
    const mutationTaskId = task.id;
    const expectedRevision = task.revision;
    setPanelBusy(true);
    render();
    try {
      const result = await options.api.executeTaskCommand(mutationProjectId, mutationTaskId, {
        requestId: requestId("generate_simulated_stage"),
        card: simulatedStageActionCard(mutationTaskId, stage, expectedRevision),
      });
      if (
        mutationContextGeneration !== contextGeneration ||
        mutationProjectId !== projectId ||
        mutationTaskId !== task?.id
      ) return;
      task = { ...task, ...result.videoTask };
      options.onTaskUpdated?.(result.videoTask);
      await loadStage();
    } catch (error) {
      if (
        mutationContextGeneration === contextGeneration &&
        mutationProjectId === projectId &&
        mutationTaskId === task?.id
      ) showMessage(errorText(error));
    } finally {
      if (mutationContextGeneration === contextGeneration) {
        setPanelBusy(false);
        render();
      }
    }
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
            options.api.getLatestVideoGeneration
              ? options.api.getLatestVideoGeneration(projectId, task.id)
              : Promise.resolve({ generation: null }),
          ])
        : null;
      const storyboardGenerationPromise = stage === "storyboard" && options.api.getLatestVideoGeneration
        ? options.api.getLatestVideoGeneration(projectId, task.id).then(
            function (value) { return { value }; },
            function (error) { return { error }; },
          )
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
        if (productionResults[2].status === "fulfilled") {
          videoGeneration = productionResults[2].value.generation;
          videoGenerations = productionResults[2].value.generations || (videoGeneration ? [videoGeneration] : []);
          videoGenerationError = null;
        } else {
          videoGenerationError = productionResults[2].reason;
        }
      }
      if (storyboardGenerationPromise) {
        const generationResult = await storyboardGenerationPromise;
        if (loadSequence !== sequence || loadContextGeneration !== contextGeneration) return;
        if (generationResult.value) {
          videoGeneration = generationResult.value.generation;
          videoGenerations = generationResult.value.generations || (videoGeneration ? [videoGeneration] : []);
          videoGenerationError = null;
        } else {
          videoGenerationError = generationResult.error;
        }
      }
      task = { ...task, ...view.videoTask };
      render();
      if (stage === "storyboard" && videoGenerations.some(function (item) { return item.output; })) void loadStoryboardShotMedia();
      else if (
        (videoGeneration?.audioEnabled === true && (videoGeneration.output || videoGeneration.composite))
        || videoGenerations.some(function (item) { return item.audioEnabled === true && item.composite; })
      ) void loadGenerationMedia();
      scheduleVideoPoll();
    } catch (error) {
      if (loadSequence !== sequence || loadContextGeneration !== contextGeneration) return;
      root.innerHTML = `<div class="production-error" role="alert"><span>${escapeHtml(errorText(error))}</span><button type="button" class="text-button">重试</button></div>`;
      root.querySelector("button")?.addEventListener("click", loadStage);
    }
  }

  async function confirmStage() {
    const stage = currentStage();
    const availability = confirmationAvailability(task, stage, view);
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
      task = { ...task, ...result.videoTask };
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

  function showShotVideo(shotIndex) {
    const media = storyboardShotMedia.get(shotIndex);
    if (!media) return;
    dialog.innerHTML = `<div class="stage-dialog-card shot-video-dialog"><header><div><h2 id="stage-history-title">镜头 ${shotIndex + 1} · 完整预览</h2><p>可播放完整片段、拖动进度或全屏查看</p></div><button type="button" data-dialog-close aria-label="关闭">×</button></header><div class="shot-video-dialog-player"><video controls autoplay playsinline preload="auto" src="${escapeHtml(media.url)}" aria-label="镜头 ${shotIndex + 1} 完整视频"></video></div><footer><a class="button secondary" href="${escapeHtml(media.url)}" download="镜头-${shotIndex + 1}.mp4">下载片段</a><button type="button" class="button primary" data-dialog-close>关闭</button></footer></div>`;
    dialog.querySelectorAll("[data-dialog-close]").forEach(function (button) {
      button.addEventListener("click", function () { dialog.close(); });
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
        task = { ...task, ...result.videoTask };
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
      const accountChanged = nextAccountId !== contextAccountId;
      const resourceChanged = accountChanged
        || (nextProjectId || null) !== projectId
        || (nextTask?.id || null) !== (task?.id || null);
      const contextChanged = resourceChanged || nextVisibleModule !== visibleModule;
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
