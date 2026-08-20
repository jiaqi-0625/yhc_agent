const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const ASSET_CATEGORIES = new Set(["vehicle", "person", "scene", "visual_style"]);
const CATALOG_STATUSES = new Set(["active", "archived"]);
const SERVER_AUTHORITY_PARAMETER_KEYS = new Set([
  "tenantid",
  "actorid",
  "actoraccountid",
  "accountid",
  "role",
  "permission",
  "permissions",
  "revision",
  "createdby",
  "updatedby",
  "brandid",
  "vehicleid",
]);

export const managementSections = Object.freeze([
  {
    id: "overview",
    label: "运营概览",
    title: "管理概览",
    description: "查看当前管理范围内的目录、账号、任务与额度消耗。",
    icon: "grid",
  },
  {
    id: "catalog",
    label: "品牌与车型",
    title: "品牌与车型",
    description: "维护品牌目录，并以不可变版本管理官方车型事实。",
    icon: "car",
  },
  {
    id: "assets",
    label: "资产关联",
    title: "车型资产关联",
    description: "浏览只读公司资产，并维护车型推荐资产包。",
    icon: "package",
  },
  {
    id: "access",
    label: "账号授权",
    title: "账号授权",
    description: "授予或撤销品牌与车型项目访问范围。",
    icon: "shield",
  },
  {
    id: "budgets",
    label: "额度管理",
    title: "额度管理",
    description: "配置账号额度，并查看已用、预留与可用余额。",
    icon: "settings",
  },
]);

const categoryLabels = {
  vehicle: "车型",
  person: "人物",
  scene: "场景",
  visual_style: "视觉风格",
};

const roleLabels = {
  content_admin: "内容管理员",
  creator: "制作账号",
  reviewer: "审核账号",
};

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function identifier(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(label + "不是有效标识符。");
  }
  return normalized;
}

function text(value, label, maximum = 120) {
  const normalized = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!normalized || normalized.length > maximum) {
    throw new Error(label + "不能为空，且不能超过 " + maximum + " 个字符。");
  }
  return normalized;
}

function integer(value, label, minimum, maximum) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(label + "必须是 " + minimum + "–" + maximum + " 之间的整数。");
  }
  return parsed;
}

function parseJson(value, label, fallback) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source) return structuredClone(fallback);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(label + "不是有效 JSON。");
  }
}

function normalizePrimitiveRecord(value) {
  if (!isRecord(value)) throw new Error("车型参数必须是 JSON 对象。");
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = text(key, "车型参数名称", 120);
    if (SERVER_AUTHORITY_PARAMETER_KEYS.has(normalizedKey.toLowerCase())) {
      throw new Error("车型参数“" + normalizedKey + "”是服务端保留字段，不能由页面提交。");
    }
    if (!["string", "number", "boolean"].includes(typeof entry)) {
      throw new Error("车型参数“" + normalizedKey + "”只能使用文字、数字或布尔值。");
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new Error("车型参数“" + normalizedKey + "”不是有限数字。");
    }
    result[normalizedKey] = entry;
  }
  return result;
}

function normalizeEvidence(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("车型事实证据必须是对象。");
  const effectiveFrom = text(value.effectiveFrom, "证据生效日期", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(effectiveFrom)) {
    throw new Error("证据生效日期必须使用 YYYY-MM-DD。");
  }
  const evidence = {
    sourceName: text(value.sourceName, "证据来源", 240),
    sourceReference: text(value.sourceReference, "证据引用", 500),
    effectiveFrom,
  };
  if (value.effectiveUntil !== undefined) {
    const effectiveUntil = text(value.effectiveUntil, "证据失效日期", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(effectiveUntil)) {
      throw new Error("证据失效日期必须使用 YYYY-MM-DD。");
    }
    evidence.effectiveUntil = effectiveUntil;
  }
  return evidence;
}

function normalizeClaim(value, expectedKind, index) {
  if (!isRecord(value)) throw new Error("第 " + (index + 1) + " 条车型事实必须是对象。");
  if (!Array.isArray(value.riskNotes)) throw new Error("车型事实 riskNotes 必须是 JSON 数组。");
  for (const [field, label] of [
    ["requiredInVoiceover", "requiredInVoiceover"],
    ["requiredInSubtitle", "requiredInSubtitle"],
    ["mayRephrase", "mayRephrase"],
  ]) {
    if (typeof value[field] !== "boolean") {
      throw new Error("车型事实 " + label + " 必须是布尔值 true 或 false。");
    }
  }
  const riskNotes = value.riskNotes.map(function (entry) { return text(entry, "风险提示", 500); });
  const claim = {
    id: identifier(value.id, "车型事实 ID"),
    kind: expectedKind,
    name: text(value.name, "车型事实名称", 240),
    statement: text(value.statement, "车型事实陈述", 2000),
    requiredInVoiceover: value.requiredInVoiceover,
    requiredInSubtitle: value.requiredInSubtitle,
    mayRephrase: value.mayRephrase,
    riskNotes,
  };
  if (value.value !== undefined) {
    if (!["string", "number"].includes(typeof value.value)) {
      throw new Error("车型事实 value 只能是文字或数字。");
    }
    claim.value = value.value;
  }
  if (value.unit !== undefined) {
    if (typeof value.unit !== "string") throw new Error("车型事实 unit 必须是文字。");
    claim.unit = value.unit.normalize("NFKC").trim();
  }
  const evidence = normalizeEvidence(value.evidence);
  if (evidence) claim.evidence = evidence;
  return claim;
}

function normalizeClaims(value, kind, label) {
  if (!Array.isArray(value)) throw new Error(label + "必须是 JSON 数组。");
  const claims = value.map(function (entry, index) {
    return normalizeClaim(entry, kind, index);
  });
  const ids = new Set(claims.map(function (claim) { return claim.id; }));
  if (ids.size !== claims.length) throw new Error(label + "不能包含重复 ID。");
  return claims;
}

export function createVehicleFactsRequest(input) {
  if (!isRecord(input)) throw new Error("车型事实输入无效。");
  if (!CATALOG_STATUSES.has(input.status)) throw new Error("车型状态无效。");
  const status = input.status;
  const parameters = normalizePrimitiveRecord(parseJson(input.parametersText, "车型参数", {}));
  const fixedClaims = normalizeClaims(
    parseJson(input.fixedClaimsText, "固定事实", []),
    "fixed",
    "固定事实",
  );
  const optionalClaims = normalizeClaims(
    parseJson(input.optionalClaimsText, "扩展事实", []),
    "extended",
    "扩展事实",
  );
  const allClaims = [...fixedClaims, ...optionalClaims];
  if (allClaims.length < 1 || allClaims.length > 20) {
    throw new Error("车型事实总数必须为 1–20 条。");
  }
  if (new Set(allClaims.map(function (claim) { return claim.id; })).size !== allClaims.length) {
    throw new Error("固定事实与扩展事实不能使用重复 ID。");
  }
  const prohibitedClaims = String(input.prohibitedClaimsText || "")
    .split(/\r?\n/u)
    .map(function (entry) { return entry.normalize("NFKC").trim(); })
    .filter(Boolean);
  const result = {
    status,
    series: text(input.series, "车系"),
    modelYear: integer(input.modelYear, "年款", 2000, 2100),
    trim: text(input.trim, "车型款"),
    parameters,
    fixedClaims,
    optionalClaims,
    prohibitedClaims,
  };
  if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
    result.expectedVersion = integer(input.expectedVersion, "车型事实版本", 1, Number.MAX_SAFE_INTEGER);
  }
  return result;
}

export function assetReferenceIdentity(reference) {
  if (!isRecord(reference)) return "";
  const vehicleId = reference.category === "vehicle" ? String(reference.vehicleId || "") : "";
  return [
    reference.source,
    reference.sourceProvider,
    reference.category,
    reference.assetId,
    reference.version,
    vehicleId,
  ].join(":");
}

export function resolveAssetPaginationCursor(responseCursor, requestedCursor, seenCursors) {
  const nextCursor = typeof responseCursor === "string" && responseCursor ? responseCursor : null;
  if (!nextCursor) return { nextCursor: null, error: null };
  const seen = seenCursors instanceof Set ? seenCursors : new Set();
  if (nextCursor === requestedCursor || seen.has(nextCursor)) {
    return {
      nextCursor: null,
      error: "公司资产目录返回了重复分页游标，已停止继续加载。",
    };
  }
  if (seen.size >= 100) {
    return {
      nextCursor: null,
      error: "公司资产目录页数超出安全上限，已停止继续加载。",
    };
  }
  return { nextCursor, error: null };
}

export function resolveBrandVisualStyleOptions(styles, brand = null) {
  const brandId = typeof brand?.id === "string" ? brand.id : null;
  const currentPresetId = typeof brand?.defaultVisualStylePresetId === "string"
    ? brand.defaultVisualStylePresetId
    : null;
  const options = [];
  const seenAssetIds = new Set();
  for (const item of Array.isArray(styles) ? styles : []) {
    const assetId = typeof item?.reference?.assetId === "string" ? item.reference.assetId : "";
    const brandIds = Array.isArray(item?.brandIds) ? item.brandIds : null;
    if (!assetId || !brandIds) continue;
    const allowed = brandIds.length === 0 || (
      brandId !== null && (brandIds.includes(brandId) || assetId === currentPresetId)
    );
    if (!allowed || seenAssetIds.has(assetId)) continue;
    options.push(item);
    seenAssetIds.add(assetId);
  }
  if (brandId !== null && currentPresetId && !seenAssetIds.has(currentPresetId)) {
    options.push({
      reference: { assetId: currentPresetId, version: 1 },
      brandIds: [brandId],
      displayName: currentPresetId + "（当前设置）",
    });
  }
  return options;
}

function normalizeAssetReference(value, vehicleId) {
  if (!isRecord(value) || !ASSET_CATEGORIES.has(value.category)) {
    throw new Error("公司资产引用无效。");
  }
  const reference = {
    assetId: identifier(value.assetId, "资产 ID"),
    version: integer(value.version, "资产版本", 1, Number.MAX_SAFE_INTEGER),
    source: "company_catalog",
    sourceProvider: identifier(value.sourceProvider, "资产 Provider"),
    category: value.category,
  };
  if (value.category === "vehicle") {
    reference.vehicleId = identifier(value.vehicleId, "车型资产所属车型");
    if (reference.vehicleId !== vehicleId) {
      throw new Error("车型资产必须与当前车型严格匹配。");
    }
  }
  return reference;
}

export function createAssetAssociationRequest(expectedRevision, references, vehicleId) {
  const normalizedVehicleId = identifier(vehicleId, "车型 ID");
  if (!Array.isArray(references)) throw new Error("推荐资产包无效。");
  const assets = references.map(function (reference) {
    return normalizeAssetReference(reference, normalizedVehicleId);
  });
  const keys = assets.map(assetReferenceIdentity);
  if (new Set(keys).size !== keys.length) throw new Error("推荐资产包不能包含重复资产。");
  if (!assets.some(function (reference) {
    return reference.category === "vehicle" && reference.vehicleId === normalizedVehicleId;
  })) {
    throw new Error("推荐资产包至少需要一项当前车型资产。");
  }
  return {
    expectedRevision: integer(expectedRevision, "资产关联 revision", 0, Number.MAX_SAFE_INTEGER),
    assets,
  };
}

export function createAccessGrantRequest(input) {
  if (!isRecord(input)) throw new Error("授权输入无效。");
  const accountId = identifier(input.accountId, "账号 ID");
  const brandId = identifier(input.brandId, "品牌 ID");
  if (input.kind === "brand") {
    return { accountId, access: { kind: "brand", brandId } };
  }
  if (input.kind === "vehicle_project") {
    return {
      accountId,
      access: {
        kind: "vehicle_project",
        brandId,
        vehicleId: identifier(input.vehicleId, "车型 ID"),
      },
    };
  }
  throw new Error("授权范围无效。");
}

function normalizedCurrencyCode(currency) {
  return typeof currency === "string" && CURRENCY_PATTERN.test(currency) ? currency : "CNY";
}

function currencyMinorDigits(currency) {
  try {
    const digits = new Intl.NumberFormat("en", {
      style: "currency",
      currency: normalizedCurrencyCode(currency),
    }).resolvedOptions().maximumFractionDigits;
    return Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 2;
  } catch {
    return 2;
  }
}

export function majorAmountToMinor(value, currency = "CNY") {
  const normalized = String(value ?? "").trim();
  const digits = currencyMinorDigits(currency);
  const pattern = digits === 0
    ? /^(\d+)$/u
    : new RegExp("^(\\d+)(?:\\.(\\d{1," + digits + "}))?$", "u");
  const match = pattern.exec(normalized);
  if (!match) {
    throw new Error(digits === 0
      ? "该币种额度必须是非负整数。"
      : "该币种额度必须是最多 " + digits + " 位小数的非负金额。");
  }
  const scale = 10n ** BigInt(digits);
  const fraction = digits === 0 ? 0n : BigInt((match[2] || "").padEnd(digits, "0"));
  const minor = BigInt(match[1]) * scale + fraction;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("额度超出安全范围。");
  return Number(minor);
}

export function minorAmountToMajor(value, currency = "CNY") {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("额度最小单位无效。");
  const digits = currencyMinorDigits(currency);
  const minor = BigInt(value);
  const scale = 10n ** BigInt(digits);
  const major = String(minor / scale);
  return digits === 0
    ? major
    : major + "." + String(minor % scale).padStart(digits, "0");
}

export function formatMinorAmount(value, currency = "CNY") {
  const minor = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const normalizedCurrency = normalizedCurrencyCode(currency);
  const digits = currencyMinorDigits(normalizedCurrency);
  try {
    const currencyFormatter = new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: normalizedCurrency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    const sampleParts = currencyFormatter.formatToParts(0);
    const firstNumberPart = sampleParts.findIndex(function (part) { return part.type === "integer"; });
    const lastNumberPart = sampleParts.findLastIndex(function (part) {
      return part.type === "integer" || part.type === "group" || part.type === "decimal" || part.type === "fraction";
    });
    const scale = 10n ** BigInt(digits);
    const major = BigInt(minor) / scale;
    const fraction = digits === 0 ? "" : String(BigInt(minor) % scale).padStart(digits, "0");
    const decimal = sampleParts.find(function (part) { return part.type === "decimal"; })?.value || ".";
    const groupedMajor = new Intl.NumberFormat("zh-CN", {
      useGrouping: true,
      maximumFractionDigits: 0,
    }).format(major);
    return sampleParts.slice(0, firstNumberPart).map(function (part) { return part.value; }).join("") +
      groupedMajor + (digits === 0 ? "" : decimal + fraction) +
      sampleParts.slice(lastNumberPart + 1).map(function (part) { return part.value; }).join("");
  } catch {
    return normalizedCurrency + " " + minorAmountToMajor(minor, normalizedCurrency);
  }
}

export function summarizeManagedProjects(projects) {
  const summaries = Array.isArray(projects) ? projects : [];
  const tasks = summaries.flatMap(function (summary) {
    return Array.isArray(summary?.tasks) ? summary.tasks : [];
  });
  return {
    projects: summaries.length,
    activeProjects: summaries.filter(function (summary) {
      return summary?.project?.status === "active";
    }).length,
    tasks: tasks.length,
    activeTasks: tasks.filter(function (task) { return task?.status === "active"; }).length,
    pendingTasks: tasks.filter(function (task) {
      return task?.stageStatus === "awaiting_confirmation";
    }).length,
  };
}

const errorMessages = {
  "AIC-AUTH-UNAUTHENTICATED": "账号会话已失效，请重新切换账号。",
  "AIC-AUTH-ACCESS_DENIED": "当前账号没有管理该资源的权限。",
  "AIC-ADMIN-BRAND_ALREADY_EXISTS": "已存在同名品牌，请修改名称。",
  "AIC-ADMIN-VEHICLE_ALREADY_EXISTS": "该品牌下已存在相同车系、年款与车型款。",
  "AIC-ADMIN-VEHICLE_FACTS_INVALID": "车型事实必须包含 1–20 条全局唯一的固定或扩展事实。",
  "AIC-ADMIN-VISUAL-STYLE_UNAVAILABLE": "所选视觉风格在当前管理范围内不可用。",
  "AIC-ADMIN-GRANT_ALREADY_EXISTS": "该账号已经拥有相同的有效授权。",
  "AIC-ADMIN-GRANT_SCOPE_ARCHIVED": "已归档的品牌或车型不能新增或恢复授权。",
  "AIC-ADMIN-ASSET_ASSOCIATION_UNAVAILABLE": "部分资产已失效或超出当前品牌、车型范围，请刷新后重试。",
  "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_MISMATCH": "车型资产不能跨车型关联。",
  "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_REQUIRED": "推荐资产包至少需要一项当前车型资产。",
  "AIC-WORKFLOW-REVISION_CONFLICT": "数据已被其他操作更新，页面将刷新到最新版本。",
  "AIC-COST-BUDGET_LIMIT_TOO_LOW": "新额度不能低于已使用与已预留金额之和。",
  "AIC-COST-BUDGET_ALREADY_CONFIGURED": "该账号额度已经配置，请刷新后修改。",
  "AIC-COST-BUDGET_AGGREGATE_OVERFLOW": "额度汇总超出安全显示范围，请调整单账号额度后重试。",
};

export function managementErrorMessage(error, fallback = "操作失败，请稍后重试。") {
  if (error?.status === 401) return "账号会话已失效，请重新切换账号。";
  if (error?.status === 403) return "当前账号没有管理该资源的权限。";
  return errorMessages[error?.code] || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function icon(name) {
  return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '" /></svg>';
}

function statusBadge(status) {
  const active = status === "active";
  return '<span class="management-badge ' + (active ? "success" : "muted") + '">' +
    (active ? "可用" : status === "revoked" ? "已撤销" : "已归档") + "</span>";
}

function shortDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function button(label, action, options = {}) {
  const variant = options.variant || "secondary";
  const disabled = options.disabled ? " disabled" : "";
  const value = options.value === undefined
    ? ""
    : ' data-admin-value="' + escapeHtml(options.value) + '"';
  const iconMarkup = options.icon ? icon(options.icon) : "";
  return '<button class="management-button ' + variant + '" type="button" data-admin-action="' +
    action + '"' + value + disabled + ">" + iconMarkup + "<span>" + escapeHtml(label) + "</span></button>";
}

function emptyState(title, description, actionMarkup = "") {
  return '<section class="management-empty">' + icon("spark") +
    "<h3>" + escapeHtml(title) + "</h3><p>" + escapeHtml(description) + "</p>" +
    actionMarkup + "</section>";
}

function skeletonRows(count = 4) {
  return '<div class="management-skeleton-list">' +
    Array.from({ length: count }, function () {
      return '<span class="management-skeleton-row"></span>';
    }).join("") + "</div>";
}

function normalizeList(value, key) {
  return Array.isArray(value?.[key]) ? value[key].filter(isRecord) : [];
}

function freshState(account) {
  return {
    account,
    open: false,
    section: "overview",
    loading: false,
    sectionLoading: false,
    saving: false,
    error: null,
    overview: null,
    brands: [],
    accounts: [],
    selectedBrandId: null,
    selectedVehicleId: null,
    vehiclesByBrand: new Map(),
    versionsByVehicle: new Map(),
    styleCatalog: null,
    assetPackage: null,
    assetCatalog: [],
    assetNextCursor: null,
    assetSeenCursors: new Set(),
    assetQuerySignature: null,
    assetCategory: "all",
    assetSearch: "",
    assetSelection: new Map(),
    initialAssetKeys: new Set(),
    missingAssetKeys: new Set(),
    assetConflictDraft: null,
    assetConflictReloadFailed: false,
    assetAuthoritativeReloadRequired: false,
    assetContextVehicleId: null,
    assetLoading: false,
    accessAccountId: "all",
  };
}

export function createManagementCenter(options) {
  if (!isRecord(options) || !isRecord(options.api)) {
    throw new TypeError("管理中心需要管理 API。");
  }
  const api = options.api;
  const mount = options.mount || document.querySelector(".platform-main");
  const topbarActions = options.topbarActions || document.querySelector(".topbar-actions");
  const topbarTitle = options.topbarTitle || document.querySelector("#topbar-work-name");
  if (!mount || !topbarActions || !topbarTitle) {
    throw new Error("管理中心挂载点不可用。");
  }

  const entry = document.createElement("button");
  entry.id = "management-center-entry";
  entry.className = "management-entry";
  entry.type = "button";
  entry.hidden = true;
  entry.setAttribute("aria-label", "打开管理中心");
  entry.setAttribute("aria-controls", "management-center-view");
  entry.innerHTML = icon("settings") + "<span>管理中心</span>";
  const serviceStatus = topbarActions.querySelector("#service-status");
  topbarActions.insertBefore(entry, serviceStatus || topbarActions.firstChild);

  const view = document.createElement("main");
  view.id = "management-center-view";
  view.className = "management-center-page";
  view.hidden = true;
  view.setAttribute("aria-labelledby", "management-center-title");
  view.innerHTML =
    '<aside class="management-sidebar" aria-label="管理中心导航">' +
      '<div class="management-sidebar-brand">' +
        '<span class="management-sidebar-mark">' + icon("settings") + "</span>" +
        '<div><strong>管理中心</strong><span>Workspace Admin</span></div>' +
      "</div>" +
      '<nav class="management-navigation">' +
        managementSections.map(function (section) {
          return '<button type="button" data-admin-section="' + section.id + '">' +
            icon(section.icon) + "<span>" + section.label + "</span></button>";
        }).join("") +
      "</nav>" +
      '<div class="management-security-note">' + icon("shield") +
        "<div><strong>服务端安全边界</strong><span>身份、租户、权限与 revision 会在每次请求时重新校验。</span></div>" +
      "</div>" +
    "</aside>" +
    '<section class="management-workbench">' +
      '<header class="management-page-header">' +
        '<button class="management-back" type="button" data-admin-action="close">' +
          '<span aria-hidden="true">←</span><span>返回项目库</span>' +
        "</button>" +
        '<div class="management-heading">' +
          '<p class="management-eyebrow">WORKSPACE ADMINISTRATION</p>' +
          '<div><h1 id="management-center-title"></h1><p id="management-center-description"></p></div>' +
        "</div>" +
        '<div class="management-header-actions"></div>' +
      "</header>" +
      '<div class="management-alert" role="alert" hidden></div>' +
      '<div class="management-content" aria-live="polite"></div>' +
    "</section>";
  mount.appendChild(view);

  const dialog = document.createElement("dialog");
  dialog.className = "management-dialog";
  dialog.setAttribute("aria-labelledby", "management-dialog-title");
  document.body.appendChild(dialog);

  const toast = document.createElement("p");
  toast.className = "management-toast";
  toast.hidden = true;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  document.body.appendChild(toast);

  const content = view.querySelector(".management-content");
  const alert = view.querySelector(".management-alert");
  const heading = view.querySelector("#management-center-title");
  const description = view.querySelector("#management-center-description");
  const headerActions = view.querySelector(".management-header-actions");
  const navigation = Array.from(view.querySelectorAll("[data-admin-section]"));
  let state = freshState(null);
  let scopeGeneration = 0;
  let baseRequest = 0;
  const vehicleRequests = new Map();
  const versionRequests = new Map();
  const loadingVehicleBrands = new Set();
  const loadingDialogIntents = new Set();
  let assetRequest = 0;
  let styleRequest = 0;
  let dialogIntent = 0;
  let dialogState = null;
  let toastTimer = null;

  function isCurrentAdminScope(generation, accountId) {
    return generation === scopeGeneration &&
      state.open &&
      state.account?.role === "content_admin" &&
      state.account.accountId === accountId;
  }

  function isCurrentDialogIntent(intent, generation, accountId, section) {
    return intent === dialogIntent &&
      state.section === section &&
      isCurrentAdminScope(generation, accountId);
  }

  function syncSectionLoading() {
    state.sectionLoading = loadingVehicleBrands.size > 0 || loadingDialogIntents.size > 0;
  }

  function managementUrlIsActive() {
    return new URL(globalThis.location.href).searchParams.get("management") === "center";
  }

  function managementUrl(active) {
    const url = new URL(globalThis.location.href);
    if (active) url.searchParams.set("management", "center");
    else url.searchParams.delete("management");
    return url.pathname + url.search + url.hash;
  }

  function currentSection() {
    return managementSections.find(function (section) {
      return section.id === state.section;
    }) || managementSections[0];
  }

  function setToast(message) {
    if (toastTimer) globalThis.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = globalThis.setTimeout(function () {
      toast.hidden = true;
    }, 4200);
  }

  function clearManagementDom() {
    dialogIntent += 1;
    loadingVehicleBrands.clear();
    loadingDialogIntents.clear();
    state.sectionLoading = false;
    if (toastTimer) globalThis.clearTimeout(toastTimer);
    toastTimer = null;
    toast.hidden = true;
    toast.textContent = "";
    if (dialog.open) dialog.close();
    dialogState = null;
    dialog.replaceChildren();
    heading.textContent = "";
    description.textContent = "";
    alert.hidden = true;
    alert.replaceChildren();
    headerActions.replaceChildren();
    content.replaceChildren();
  }

  function managedProjects() {
    return typeof options.getProjects === "function" ? options.getProjects() : [];
  }

  function selectedBrand() {
    return state.brands.find(function (brand) {
      return brand.id === state.selectedBrandId;
    }) || null;
  }

  function vehiclesForBrand(brandId = state.selectedBrandId) {
    return state.vehiclesByBrand.get(brandId) || [];
  }

  function selectedVehicle() {
    return vehiclesForBrand().find(function (vehicle) {
      return vehicle.id === state.selectedVehicleId;
    }) || null;
  }

  function allVehicles() {
    return state.brands.flatMap(function (brand) {
      return state.vehiclesByBrand.get(brand.id) || [];
    });
  }

  function brandName(brandId) {
    return state.brands.find(function (brand) { return brand.id === brandId; })?.name || brandId;
  }

  function vehicleName(vehicleId) {
    const vehicle = allVehicles().find(function (entry) { return entry.id === vehicleId; });
    return vehicle ? vehicle.series + " " + vehicle.modelYear + " " + vehicle.trim : vehicleId;
  }

  function renderHeaderActions() {
    if (state.section === "catalog") {
      headerActions.innerHTML = button("新建品牌", "new-brand", {
        variant: "primary",
        icon: "plus",
        disabled: state.saving,
      });
      return;
    }
    if (state.section === "assets") {
      const issue = assetSelectionIssue();
      headerActions.innerHTML = button(state.saving ? "正在保存" : "保存关联", "save-assets", {
        variant: "primary",
        icon: "shield",
        disabled: Boolean(issue) || state.saving || state.assetLoading,
      });
      return;
    }
    if (state.section === "access") {
      headerActions.innerHTML = button("新增授权", "new-grant", {
        variant: "primary",
        icon: "plus",
        disabled: state.brands.length === 0 || state.saving,
      });
      return;
    }
    headerActions.innerHTML = button("刷新数据", "refresh", {
      icon: "rotate",
      disabled: state.loading || state.sectionLoading,
    });
  }

  function renderOverview() {
    const counts = isRecord(state.overview?.counts) ? state.overview.counts : {};
    const taskSummary = summarizeManagedProjects(managedProjects());
    const metrics = [
      ["品牌", counts.brands || 0, (counts.activeBrands || 0) + " 个可用", "building"],
      ["车型", counts.vehicles || 0, (counts.activeVehicles || 0) + " 个可用", "car"],
      ["账号", counts.accounts || state.accounts.length, (counts.activeAccessGrants || 0) + " 项有效授权", "shield"],
      ["额度", counts.configuredBudgets || 0, "已配置账号", "settings"],
    ];
    const consumption = Array.isArray(state.overview?.consumptionByCurrency)
      ? state.overview.consumptionByCurrency
      : [];
    return '<section class="management-metric-grid" aria-label="管理数据概览">' +
      metrics.map(function (metric) {
        return '<article class="management-metric-card">' +
          '<span class="management-metric-icon">' + icon(metric[3]) + "</span>" +
          "<div><span>" + metric[0] + "</span><strong>" + metric[1] + "</strong><small>" +
            escapeHtml(metric[2]) + "</small></div></article>";
      }).join("") +
      "</section>" +
      '<div class="management-overview-grid">' +
        '<section class="management-card management-consumption-card">' +
          '<header class="management-card-header"><div><h2>额度与消耗</h2><p>服务端汇总当前管理范围内的预算余额。</p></div></header>' +
          (consumption.length
            ? '<div class="management-consumption-list">' + consumption.map(function (entry) {
                const limit = Number(entry.limitAmountMinor) || 0;
                const spent = Number(entry.spentAmountMinor) || 0;
                const reserved = Number(entry.reservedAmountMinor) || 0;
                const usedPercent = limit > 0 ? Math.min(100, Math.round(((spent + reserved) / limit) * 100)) : 0;
                return '<article><header><div><strong>' + escapeHtml(entry.currency) +
                  '</strong><span>已使用 ' + formatMinorAmount(spent, entry.currency) + " · 预留 " +
                  formatMinorAmount(reserved, entry.currency) + '</span></div><b>' +
                  formatMinorAmount(entry.availableAmountMinor, entry.currency) + ' 可用</b></header>' +
                  '<div class="management-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
                  usedPercent + '"><span style="width:' + usedPercent + '%"></span></div>' +
                  '<footer><span>额度 ' + formatMinorAmount(limit, entry.currency) + '</span><span>' +
                  usedPercent + "% 已占用</span></footer></article>";
              }).join("") + "</div>"
            : emptyState("尚未配置额度", "前往额度管理为制作账号设置可用额度。")) +
        "</section>" +
        '<section class="management-card management-task-overview">' +
          '<header class="management-card-header"><div><h2>任务概览</h2><p>来自当前会话授权范围内的项目库只读汇总。</p></div>' +
            '<span class="management-source-badge">' + icon("shield") + "服务端作用域</span></header>" +
          '<dl class="management-task-metrics">' +
            "<div><dt>项目</dt><dd>" + taskSummary.projects + "</dd><span>" + taskSummary.activeProjects + " 个进行中</span></div>" +
            "<div><dt>视频任务</dt><dd>" + taskSummary.tasks + "</dd><span>" + taskSummary.activeTasks + " 个进行中</span></div>" +
            "<div><dt>待人工确认</dt><dd>" + taskSummary.pendingTasks + "</dd><span>需制作成员处理</span></div>" +
          "</dl>" +
          '<div class="management-boundary-callout">' + icon("shield") +
            "<p><strong>页面不声明身份范围</strong><span>租户、角色和授权由 Bearer Session 在服务端重新装配；所有写入仍会再次校验。</span></p></div>" +
        "</section>" +
      "</div>";
  }

  function renderCatalog() {
    if (state.brands.length === 0) {
      return emptyState(
        "还没有品牌",
        "先建立品牌并选择默认视觉风格，随后即可维护车型事实。",
        button("新建品牌", "new-brand", { variant: "primary", icon: "plus" }),
      );
    }
    const brand = selectedBrand();
    const vehicles = vehiclesForBrand();
    const vehicle = selectedVehicle();
    const versions = vehicle ? state.versionsByVehicle.get(vehicle.id) || [] : [];
    const parameters = vehicle && isRecord(vehicle.parameters) ? Object.entries(vehicle.parameters) : [];
    const brandList = state.brands.map(function (entry) {
      const selected = entry.id === state.selectedBrandId;
      return '<button class="management-master-row ' + (selected ? "selected" : "") +
        '" type="button" data-admin-action="select-brand" data-admin-value="' + escapeHtml(entry.id) +
        '" aria-pressed="' + selected + '">' +
        '<span class="management-master-avatar">' + escapeHtml(Array.from(entry.name || "品")[0] || "品") + "</span>" +
        '<span class="management-master-copy"><strong>' + escapeHtml(entry.name) +
        "</strong><small>revision " + escapeHtml(entry.revision) + "</small></span>" +
        statusBadge(entry.status) + "</button>";
    }).join("");
    const vehicleRows = state.sectionLoading && !state.vehiclesByBrand.has(state.selectedBrandId)
      ? '<tr><td colspan="5">' + skeletonRows(3) + "</td></tr>"
      : vehicles.length
        ? vehicles.map(function (entry) {
            const active = entry.id === state.selectedVehicleId;
            return '<tr class="' + (active ? "selected" : "") + '">' +
              '<td><button class="management-table-link" type="button" data-admin-action="select-vehicle" data-admin-value="' +
                escapeHtml(entry.id) + '"><strong>' + escapeHtml(entry.series) + "</strong><span>" +
                escapeHtml(entry.trim) + "</span></button></td>" +
              "<td>" + escapeHtml(entry.modelYear) + "</td>" +
              "<td>v" + escapeHtml(entry.version) + "</td>" +
              "<td>" + statusBadge(entry.status) + "</td>" +
              "<td><time>" + shortDate(entry.updatedAt) + "</time></td></tr>";
          }).join("")
        : '<tr><td colspan="5">' + emptyState("暂无车型", "为该品牌建立第一条官方车型事实。") + "</td></tr>";
    const brandDetail = brand
      ? '<section class="management-card management-brand-summary">' +
          '<header><div><span class="management-kicker">当前品牌</span><h2>' + escapeHtml(brand.name) +
          '</h2></div><div class="management-inline-actions">' +
          button("编辑品牌", "edit-brand", { value: brand.id }) +
          button(brand.status === "active" ? "归档" : "恢复", "toggle-brand-status", {
            value: brand.id,
            variant: brand.status === "active" ? "danger-ghost" : "secondary",
          }) + "</div></header>" +
          '<dl class="management-summary-facts">' +
            "<div><dt>状态</dt><dd>" + statusBadge(brand.status) + "</dd></div>" +
            "<div><dt>目录版本</dt><dd>revision " + escapeHtml(brand.revision) + "</dd></div>" +
            '<div class="wide"><dt>默认视觉预设</dt><dd><code>' +
              escapeHtml(brand.defaultVisualStylePresetId) + "</code></dd></div>" +
          "</dl></section>"
      : "";
    const vehicleDetail = vehicle
      ? '<section class="management-card management-vehicle-detail">' +
          '<header class="management-card-header"><div><span class="management-kicker">最新官方事实</span><h2>' +
            escapeHtml(vehicle.series + " " + vehicle.modelYear + " " + vehicle.trim) +
            '</h2><p>当前 v' + escapeHtml(vehicle.version) + "，历史版本保持只读且可追溯。</p></div>" +
            button("新建事实版本", "new-vehicle-version", {
              value: vehicle.id,
              variant: "primary",
              icon: "plus",
              disabled: brand?.status !== "active",
            }) + "</header>" +
          '<div class="management-fact-layout">' +
            '<section><h3>车型参数</h3>' +
              (parameters.length
                ? '<dl class="management-parameter-list">' + parameters.map(function (entry) {
                    return "<div><dt>" + escapeHtml(entry[0]) + "</dt><dd>" +
                      escapeHtml(entry[1]) + "</dd></div>";
                  }).join("") + "</dl>"
                : '<p class="management-muted-copy">未录入车型参数</p>') +
            "</section>" +
            '<section><h3>事实约束</h3><dl class="management-claim-counts">' +
              "<div><dt>固定事实</dt><dd>" + (Array.isArray(vehicle.fixedClaims) ? vehicle.fixedClaims.length : 0) + "</dd></div>" +
              "<div><dt>扩展事实</dt><dd>" + (Array.isArray(vehicle.optionalClaims) ? vehicle.optionalClaims.length : 0) + "</dd></div>" +
              "<div><dt>禁用表述</dt><dd>" + (Array.isArray(vehicle.prohibitedClaims) ? vehicle.prohibitedClaims.length : 0) + "</dd></div>" +
            "</dl></section>" +
          "</div>" +
          '<section class="management-version-history"><header><h3>事实版本历史</h3><span>' +
            versions.length + " 个版本</span></header>" +
            (versions.length
              ? '<ol>' + versions.map(function (entry, index) {
                  return '<li class="' + (index === 0 ? "current" : "") + '"><span class="management-version-dot"></span>' +
                    "<div><strong>v" + escapeHtml(entry.version) + " · " +
                    escapeHtml(entry.series + " " + entry.modelYear + " " + entry.trim) +
                    "</strong><small>" + shortDate(entry.createdAt) + " · " +
                    (entry.status === "active" ? "可用" : "已归档") + "</small></div>" +
                    '<span class="management-version-actions">' +
                      (index === 0 ? '<span class="management-badge success">当前</span>' : "") +
                      button("查看", "view-vehicle-version", { value: entry.version, variant: "ghost" }) +
                    "</span></li>";
                }).join("") + "</ol>"
              : skeletonRows(3)) +
          "</section></section>"
      : emptyState("选择或新增车型", "选择车型后可查看最新事实与完整版本历史。");
    return '<div class="management-master-detail">' +
      '<aside class="management-master-panel"><header><div><h2>品牌目录</h2><span>' +
        state.brands.length + " 个</span></div></header><div>" + brandList + "</div></aside>" +
      '<div class="management-detail-stack">' + brandDetail +
        '<section class="management-card management-vehicle-table-card">' +
          '<header class="management-card-header"><div><h2>车型目录</h2><p>车型事实通过追加新版本更新，不修改历史。</p></div>' +
          button("新增车型", "new-vehicle", {
            icon: "plus",
            disabled: !brand || brand.status !== "active",
          }) + "</header>" +
          '<div class="management-table-wrap"><table class="management-table"><thead><tr>' +
            "<th>车型</th><th>年款</th><th>事实版本</th><th>状态</th><th>最近更新</th>" +
          "</tr></thead><tbody>" + vehicleRows + "</tbody></table></div>" +
        "</section>" + vehicleDetail + "</div></div>";
  }

  function assetSelectionIssue() {
    if (!state.selectedVehicleId) return "请先选择车型。";
    if (state.assetAuthoritativeReloadRequired) return "请先重新加载服务端最新关联数据。";
    if (state.assetConflictDraft) return "请先处理关联 revision 冲突。";
    if ([...state.missingAssetKeys].some(function (key) {
      return state.assetSelection.has(key);
    })) return "请先移除已失效的资产引用。";
    const references = [...state.assetSelection.values()];
    if (!references.some(function (reference) {
      return reference.category === "vehicle" && reference.vehicleId === state.selectedVehicleId;
    })) {
      return "推荐资产包至少需要一项当前车型资产。";
    }
    const currentKeys = new Set(state.assetSelection.keys());
    if (currentKeys.size === state.initialAssetKeys.size &&
      [...currentKeys].every(function (key) { return state.initialAssetKeys.has(key); })) {
      return "当前关联没有变更。";
    }
    return "";
  }

  function renderAssetCard(item) {
    const reference = item.reference;
    const key = assetReferenceIdentity(reference);
    const selected = state.assetSelection.has(key);
    const thumbnail = item.preview?.thumbnailUrl
      ? '<img src="' + escapeHtml(item.preview.thumbnailUrl) + '" alt="" loading="lazy" />'
      : icon(categoryLabels[reference.category] === "车型" ? "car" : "image");
    return '<label class="management-asset-card ' + (selected ? "selected" : "") + '">' +
      '<span class="management-asset-preview">' + thumbnail +
        '<span class="management-asset-category">' + escapeHtml(categoryLabels[reference.category]) + "</span></span>" +
      '<span class="management-asset-copy"><strong>' + escapeHtml(item.displayName) + "</strong><span>" +
        escapeHtml(item.description || "暂无资产描述") + "</span><small>v" + escapeHtml(reference.version) +
        " · " + escapeHtml((item.tags || []).slice(0, 3).join(" / ") || "无标签") + "</small></span>" +
      '<input type="checkbox" data-admin-asset-key="' + escapeHtml(key) + '"' +
        (selected ? " checked" : "") +
        (state.saving || state.assetAuthoritativeReloadRequired ? " disabled" : "") +
        ' aria-label="关联 ' + escapeHtml(item.displayName) + '" />' +
      '<span class="management-checkmark" aria-hidden="true">✓</span></label>';
  }

  function renderAssets() {
    if (state.brands.length === 0) {
      return emptyState("请先建立品牌", "资产关联必须落在服务端授权的品牌与车型范围内。");
    }
    const brandOptions = state.brands.map(function (brand) {
      return '<option value="' + escapeHtml(brand.id) + '"' +
        (brand.id === state.selectedBrandId ? " selected" : "") + ">" +
        escapeHtml(brand.name) + "</option>";
    }).join("");
    const vehicleOptions = vehiclesForBrand().map(function (vehicle) {
      return '<option value="' + escapeHtml(vehicle.id) + '"' +
        (vehicle.id === state.selectedVehicleId ? " selected" : "") + ">" +
        escapeHtml(vehicle.series + " " + vehicle.modelYear + " " + vehicle.trim) + "</option>";
    }).join("");
    const associationRevision = state.assetPackage?.association?.revision || 0;
    const selectedCount = state.assetSelection.size;
    const assetEditingBlocked = state.saving || state.assetAuthoritativeReloadRequired;
    const issue = assetSelectionIssue();
    const missing = Array.isArray(state.assetPackage?.missingReferences)
      ? state.assetPackage.missingReferences.filter(function (reference) {
          const key = assetReferenceIdentity(reference);
          return state.missingAssetKeys.has(key) && state.assetSelection.has(key);
        })
      : [];
    const assetCards = state.assetLoading
      ? skeletonRows(6)
      : state.assetCatalog.length
        ? '<div class="management-asset-grid">' + state.assetCatalog.map(renderAssetCard).join("") + "</div>"
        : emptyState("没有匹配资产", "调整分类或搜索关键词后重试。", button("清除筛选", "clear-asset-filters"));
    return (state.assetAuthoritativeReloadRequired
      ? '<section class="management-alert-card conflict"><header>' + icon("rotate") +
          '<div><strong>关联已保存，正在等待权威数据刷新</strong><span>' +
          "保存命令已成功，但最新 revision 尚未读取。重新加载前不能继续编辑或保存。" +
          '</span></div></header><div class="management-inline-actions">' +
          button("重新加载最新关联", "reload-asset-authority", { variant: "primary" }) +
          "</div></section>"
      : "") +
      (state.assetConflictDraft
      ? '<section class="management-alert-card conflict"><header>' + icon("rotate") +
          "<div><strong>关联数据已被其他操作更新</strong><span>" +
          (state.assetConflictReloadFailed
            ? "最新 revision 刷新失败；你的选择草稿仍保留，重新加载前不能继续保存。"
            : "已读取最新 revision，并保留了你的选择草稿。请明确选择要继续使用的版本。") +
          "</span></div></header>" +
          '<div class="management-inline-actions">' +
            (state.assetConflictReloadFailed
              ? button("重新加载最新版本", "retry-asset-conflict", { variant: "primary" })
              : button("采用服务端版本", "resolve-asset-conflict-server") +
                button("保留我的选择", "resolve-asset-conflict-draft", { variant: "primary" })) +
          "</div></section>"
      : "") +
      '<section class="management-card management-asset-context">' +
      '<header class="management-card-header"><div><h2>关联范围</h2><p>车型资产严格绑定车型；人物、场景与视觉风格来自只读公司目录。</p></div>' +
        '<span class="management-revision-badge">association revision ' + escapeHtml(associationRevision) + "</span></header>" +
      '<div class="management-context-selectors">' +
        '<label><span>品牌</span><select data-admin-control="asset-brand"' +
          (state.saving ? " disabled" : "") + ">" + brandOptions + "</select></label>" +
        '<label><span>车型</span><select data-admin-control="asset-vehicle"' +
          (vehicleOptions && !state.saving ? "" : " disabled") + ">" +
          (vehicleOptions || "<option>暂无车型</option>") + "</select></label>" +
        '<div class="management-selection-summary"><span>' + icon("package") +
          "</span><div><strong>" + selectedCount + " 项已选</strong><small>" +
          (issue ? escapeHtml(issue) : "资产包满足创建项目的车型约束") + "</small></div></div>" +
      "</div></section>" +
      (missing.length
        ? '<section class="management-alert-card"><header>' + icon("shield") +
            "<div><strong>发现 " + missing.length + " 项失效引用</strong><span>保存前必须移除，避免以过期版本覆盖服务端数据。</span></div></header>" +
            '<div class="management-missing-assets">' + missing.map(function (reference) {
              const key = assetReferenceIdentity(reference);
              return '<span><code>' + escapeHtml(reference.assetId) + " · v" + escapeHtml(reference.version) +
                '</code><button type="button" data-admin-action="remove-missing-asset" data-admin-value="' +
                escapeHtml(key) + '"' +
                (state.saving || state.assetAuthoritativeReloadRequired ? " disabled" : "") +
                ">移除</button></span>";
            }).join("") + "</div></section>"
        : "") +
      '<section class="management-card management-asset-browser">' +
        '<header class="management-card-header"><div><h2>公司资产目录</h2><p>目录内容只读；这里只维护版本化引用关系。</p></div></header>' +
        '<form class="management-filterbar" data-admin-form="asset-search">' +
          '<label class="management-search"><span class="sr-only">搜索公司资产</span>' + icon("image") +
            '<input name="searchText" type="search" value="' + escapeHtml(state.assetSearch) +
            '" placeholder="搜索资产名称、描述或标签" autocomplete="off"' +
            (assetEditingBlocked ? " disabled" : "") + " /></label>" +
          '<label class="management-compact-field"><span>分类</span><select data-admin-control="asset-category"' +
            (assetEditingBlocked ? " disabled" : "") + ">" +
            '<option value="all"' + (state.assetCategory === "all" ? " selected" : "") + ">全部分类</option>" +
            Object.entries(categoryLabels).map(function (entry) {
              return '<option value="' + entry[0] + '"' +
                (state.assetCategory === entry[0] ? " selected" : "") + ">" + entry[1] + "</option>";
            }).join("") + "</select></label>" +
          '<button class="management-button secondary" type="submit"' +
            (assetEditingBlocked ? " disabled" : "") + ">" + icon("rotate") + "<span>筛选</span></button>" +
        "</form>" + assetCards +
        (!state.assetLoading && state.assetNextCursor
          ? '<div class="management-inline-actions">' +
            button("加载更多资产", "load-more-assets", { disabled: assetEditingBlocked }) + "</div>"
          : "") + "</section>";
  }

  function accessScopeLabel(grant) {
    if (grant.access?.kind === "vehicle_project") {
      return brandName(grant.access.brandId) + " / " + vehicleName(grant.access.vehicleId) + " 项目";
    }
    return brandName(grant.access?.brandId) + " / 品牌";
  }

  function renderAccess() {
    const accountOptions = ['<option value="all">全部账号</option>'].concat(
      state.accounts.map(function (entry) {
        return '<option value="' + escapeHtml(entry.account.accountId) + '"' +
          (entry.account.accountId === state.accessAccountId ? " selected" : "") + ">" +
          escapeHtml(entry.account.displayName) + "</option>";
      }),
    ).join("");
    const rows = state.accounts
      .filter(function (entry) {
        return state.accessAccountId === "all" || entry.account.accountId === state.accessAccountId;
      })
      .flatMap(function (entry) {
        return (entry.accessGrants || []).map(function (grant) {
          return { account: entry.account, grant };
        });
      });
    const tableRows = rows.length
      ? rows.map(function (entry) {
          const grant = entry.grant;
          const protectsCurrentAdministrator = grant.status === "active" &&
            grant.accountId === state.account?.accountId && grant.access?.kind === "brand";
          const nextStatus = grant.status === "active" ? "revoked" : "active";
          return "<tr><td><div class=\"management-account-cell\"><span>" +
            escapeHtml(Array.from(entry.account.displayName || "账")[0] || "账") +
            "</span><div><strong>" + escapeHtml(entry.account.displayName) + "</strong><small>" +
            escapeHtml(roleLabels[entry.account.role] || entry.account.role) + "</small></div></div></td>" +
            "<td><strong>" + escapeHtml(accessScopeLabel(grant)) + "</strong><small>" +
            (grant.access?.kind === "brand" ? "品牌管理范围" : "车型项目访问") + "</small></td>" +
            "<td>" + statusBadge(grant.status) + "</td><td>revision " + escapeHtml(grant.revision) + "</td>" +
            '<td class="management-row-action">' +
              button(nextStatus === "revoked" ? "撤销" : "恢复", "toggle-grant", {
                value: grant.id,
                variant: nextStatus === "revoked" ? "danger-ghost" : "secondary",
                disabled: protectsCurrentAdministrator,
              }) +
              (protectsCurrentAdministrator ? '<span title="为避免锁定当前管理员，页面不允许撤销自身品牌授权。">保留自身授权</span>' : "") +
            "</td></tr>";
        }).join("")
      : '<tr><td colspan="5">' + emptyState("暂无授权记录", "为账号添加品牌或车型项目访问范围。") + "</td></tr>";
    return '<section class="management-card management-access-card">' +
      '<header class="management-card-header"><div><h2>授权目录</h2><p>授权变更在下一次服务端会话解析时立即生效。</p></div>' +
        '<label class="management-compact-field"><span>账号筛选</span><select data-admin-control="access-account">' +
          accountOptions + "</select></label></header>" +
      '<div class="management-table-wrap"><table class="management-table management-access-table">' +
        "<thead><tr><th>账号</th><th>授权范围</th><th>状态</th><th>版本</th><th>操作</th></tr></thead>" +
        "<tbody>" + tableRows + "</tbody></table></div></section>" +
      '<section class="management-boundary-banner">' + icon("shield") +
        "<div><strong>权限由服务端判定</strong><span>页面只提交目标账号与业务范围，不提交当前操作者、租户或角色；旧 revision 会被拒绝。</span></div></section>";
  }

  function renderBudgets() {
    if (state.accounts.length === 0) {
      return emptyState("暂无账号", "当前租户账号目录为空。");
    }
    const cards = state.accounts.map(function (entry) {
      const account = entry.account;
      const budget = entry.budget;
      const balance = budget?.balance;
      const limit = Number(balance?.limitAmountMinor) || 0;
      const spent = Number(balance?.spentAmountMinor) || 0;
      const reserved = Number(balance?.reservedAmountMinor) || 0;
      const available = Number(balance?.availableAmountMinor) || 0;
      const percent = limit > 0 ? Math.min(100, Math.round(((spent + reserved) / limit) * 100)) : 0;
      return '<article class="management-budget-card">' +
        '<header><div class="management-account-cell"><span>' +
          escapeHtml(Array.from(account.displayName || "账")[0] || "账") +
          "</span><div><strong>" + escapeHtml(account.displayName) + "</strong><small>" +
          escapeHtml(roleLabels[account.role] || account.role) + "</small></div></div>" +
          (budget ? '<span class="management-revision-badge">revision ' + escapeHtml(budget.revision) + "</span>" : "") +
        "</header>" +
        (budget
          ? '<div class="management-budget-amount"><span>可用额度</span><strong>' +
              formatMinorAmount(available, balance.currency) + "</strong><small>总额 " +
              formatMinorAmount(limit, balance.currency) + "</small></div>" +
            '<div class="management-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
              percent + '"><span style="width:' + percent + '%"></span></div>' +
            '<dl><div><dt>已使用</dt><dd>' + formatMinorAmount(spent, balance.currency) +
              "</dd></div><div><dt>已预留</dt><dd>" + formatMinorAmount(reserved, balance.currency) +
              "</dd></div></dl>" +
            button("调整额度", "edit-budget", { value: account.accountId })
          : '<div class="management-budget-empty"><span>尚未配置额度</span><p>高消耗操作将由服务端按未配置策略拒绝。</p></div>' +
            button("配置额度", "edit-budget", {
              value: account.accountId,
              variant: "primary",
              icon: "plus",
            })) +
      "</article>";
    }).join("");
    return '<section class="management-budget-intro"><div><span class="management-kicker">ACCOUNT BUDGETS</span>' +
      "<h2>账号额度</h2><p>金额以最小货币单位写入；已用与预留来自服务端账本的只读余额视图。</p></div>" +
      '<span class="management-source-badge">' + icon("shield") + "服务端强制执行</span></section>" +
      '<div class="management-budget-grid">' + cards + "</div>";
  }

  function render() {
    entry.hidden = state.account?.role !== "content_admin";
    entry.setAttribute("aria-expanded", String(state.open));
    view.hidden = !state.open;
    if (!state.open) return;
    const section = currentSection();
    heading.textContent = section.title;
    description.textContent = section.description;
    navigation.forEach(function (item) {
      const active = item.dataset.adminSection === state.section;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    alert.hidden = !state.error;
    alert.innerHTML = state.error
      ? '<span>' + icon("shield") + escapeHtml(state.error) + '</span>' +
        button("重试", "refresh", { variant: "ghost" })
      : "";
    renderHeaderActions();
    if (state.loading) {
      content.innerHTML = '<div class="management-loading" aria-label="正在加载管理数据">' +
        '<span class="management-spinner"></span><strong>正在装配管理范围</strong><p>读取品牌、账号与服务端额度概览…</p></div>';
      return;
    }
    if (state.section === "overview") content.innerHTML = renderOverview();
    else if (state.section === "catalog") content.innerHTML = renderCatalog();
    else if (state.section === "assets") content.innerHTML = renderAssets();
    else if (state.section === "access") content.innerHTML = renderAccess();
    else content.innerHTML = renderBudgets();
  }

  async function loadBase(optionsForLoad = {}) {
    const generation = scopeGeneration;
    const request = ++baseRequest;
    const preserveBrandId = state.selectedBrandId;
    const preserveVehicleId = state.selectedVehicleId;
    if (!optionsForLoad.silent) {
      state.loading = true;
      state.error = null;
      render();
    }
    try {
      const responses = await Promise.all([
        api.getOverview(),
        api.listBrands(),
        api.listAccounts(),
      ]);
      if (generation !== scopeGeneration || request !== baseRequest || !state.open) return false;
      state.overview = isRecord(responses[0]) ? responses[0] : {};
      state.brands = normalizeList(responses[1], "brands");
      state.accounts = normalizeList(responses[2], "accounts");
      state.selectedBrandId = state.brands.some(function (brand) { return brand.id === preserveBrandId; })
        ? preserveBrandId
        : state.brands.find(function (brand) { return brand.status === "active"; })?.id || state.brands[0]?.id || null;
      state.selectedVehicleId = preserveVehicleId;
      state.error = null;
      return true;
    } catch (error) {
      if (generation !== scopeGeneration || request !== baseRequest || !state.open) return false;
      state.error = managementErrorMessage(error, "管理数据加载失败，请稍后重试。");
      return false;
    } finally {
      if (generation === scopeGeneration && request === baseRequest && state.open) {
        state.loading = false;
        render();
      }
    }
  }

  async function ensureVehicles(brandId, force = false) {
    if (!brandId) return [];
    if (!force && state.vehiclesByBrand.has(brandId)) return state.vehiclesByBrand.get(brandId);
    const generation = scopeGeneration;
    const request = (vehicleRequests.get(brandId) || 0) + 1;
    vehicleRequests.set(brandId, request);
    loadingVehicleBrands.add(brandId);
    syncSectionLoading();
    render();
    try {
      const response = await api.listVehicles(brandId);
      if (generation !== scopeGeneration || request !== vehicleRequests.get(brandId) || !state.open) return [];
      const vehicles = normalizeList(response, "vehicles");
      state.vehiclesByBrand.set(brandId, vehicles);
      if (state.selectedBrandId === brandId) {
        state.selectedVehicleId = vehicles.some(function (vehicle) {
          return vehicle.id === state.selectedVehicleId;
        })
          ? state.selectedVehicleId
          : vehicles.find(function (vehicle) { return vehicle.status === "active"; })?.id || vehicles[0]?.id || null;
      }
      return vehicles;
    } catch (error) {
      if (generation === scopeGeneration && request === vehicleRequests.get(brandId) && state.open) {
        state.error = managementErrorMessage(error, "车型目录加载失败，请稍后重试。");
      }
      return [];
    } finally {
      if (generation === scopeGeneration && request === vehicleRequests.get(brandId) && state.open) {
        loadingVehicleBrands.delete(brandId);
        syncSectionLoading();
        render();
      }
    }
  }

  async function ensureAllVehicles(force = false) {
    const results = await Promise.all(state.brands.map(function (brand) {
      return ensureVehicles(brand.id, force);
    }));
    return results.flat();
  }

  async function ensureVersions(vehicleId, force = false) {
    if (!vehicleId) return [];
    if (!force && state.versionsByVehicle.has(vehicleId)) return state.versionsByVehicle.get(vehicleId);
    const generation = scopeGeneration;
    const request = (versionRequests.get(vehicleId) || 0) + 1;
    versionRequests.set(vehicleId, request);
    try {
      const response = await api.listVehicleVersions(vehicleId);
      if (
        generation !== scopeGeneration ||
        request !== versionRequests.get(vehicleId) ||
        !state.open
      ) return [];
      const versions = normalizeList(response, "versions").sort(function (left, right) {
        return Number(right.version) - Number(left.version);
      });
      state.versionsByVehicle.set(vehicleId, versions);
      render();
      return versions;
    } catch (error) {
      if (
        generation === scopeGeneration &&
        request === versionRequests.get(vehicleId) &&
        state.open
      ) {
        state.error = managementErrorMessage(error, "车型事实历史加载失败。");
        render();
      }
      return [];
    }
  }

  function assetSearchQuery(cursor) {
    const query = {
      brandId: state.selectedBrandId,
      vehicleId: state.selectedVehicleId,
      searchText: state.assetSearch || undefined,
      limit: 100,
    };
    if (cursor) query.cursor = cursor;
    if (state.assetCategory !== "all") query.categories = [state.assetCategory];
    return query;
  }

  function clearAssetContextData() {
    assetRequest += 1;
    state.assetPackage = null;
    state.assetCatalog = [];
    state.assetNextCursor = null;
    state.assetSeenCursors = new Set();
    state.assetQuerySignature = null;
    state.assetSelection = new Map();
    state.initialAssetKeys = new Set();
    state.missingAssetKeys = new Set();
    state.assetConflictDraft = null;
    state.assetConflictReloadFailed = false;
    state.assetAuthoritativeReloadRequired = false;
    state.assetContextVehicleId = null;
    state.assetLoading = false;
  }

  function currentAssetQuerySignature() {
    return JSON.stringify([
      state.selectedBrandId,
      state.selectedVehicleId,
      state.assetCategory,
      state.assetSearch,
    ]);
  }

  async function loadAssetContext(loadOptions = {}) {
    if (!state.selectedBrandId || !state.selectedVehicleId) {
      clearAssetContextData();
      render();
      return false;
    }
    const generation = scopeGeneration;
    const request = ++assetRequest;
    const vehicleId = state.selectedVehicleId;
    const appendCatalog = loadOptions.appendCatalog === true;
    const requestedCursor = appendCatalog && typeof loadOptions.cursor === "string"
      ? loadOptions.cursor
      : null;
    const querySignature = currentAssetQuerySignature();
    if (!appendCatalog) {
      state.assetCatalog = [];
      state.assetNextCursor = null;
      state.assetSeenCursors = new Set();
      state.assetQuerySignature = querySignature;
    } else if (
      !requestedCursor ||
      state.assetQuerySignature !== querySignature ||
      state.assetSeenCursors.has(requestedCursor)
    ) {
      state.assetNextCursor = null;
      state.error = "资产目录分页状态已失效，已停止继续加载，请重新筛选。";
      render();
      return false;
    }
    state.assetLoading = true;
    state.error = null;
    render();
    try {
      const shouldLoadPackage = !loadOptions.catalogOnly ||
        state.assetContextVehicleId !== vehicleId ||
        !state.assetPackage;
      const responses = await Promise.all([
        shouldLoadPackage ? api.getVehicleAssetAssociations(vehicleId) : Promise.resolve(null),
        api.searchCompanyAssets(assetSearchQuery(loadOptions.cursor)),
      ]);
      if (
        generation !== scopeGeneration ||
        request !== assetRequest ||
        !state.open ||
        state.selectedVehicleId !== vehicleId
      ) return false;
      const packageView = shouldLoadPackage && isRecord(responses[0]) ? responses[0] : state.assetPackage;
      const catalogItems = normalizeList(responses[1], "items");
      const nextCursor = typeof responses[1]?.nextCursor === "string" && responses[1].nextCursor
        ? responses[1].nextCursor
        : null;
      if (appendCatalog) state.assetSeenCursors.add(requestedCursor);
      state.assetPackage = packageView;
      state.assetCatalog = appendCatalog
        ? [...new Map([...state.assetCatalog, ...catalogItems].map(function (item) {
            return [assetReferenceIdentity(item.reference), item];
          })).values()]
        : catalogItems;
      const cursorDecision = resolveAssetPaginationCursor(
        nextCursor,
        requestedCursor,
        state.assetSeenCursors,
      );
      state.assetNextCursor = cursorDecision.nextCursor;
      if (cursorDecision.error) state.error = cursorDecision.error;
      if (
        shouldLoadPackage &&
        (loadOptions.resetSelection || state.assetContextVehicleId !== vehicleId)
      ) {
        const references = Array.isArray(packageView?.association?.assets)
          ? packageView.association.assets
          : [];
        state.assetSelection = new Map(references.map(function (reference) {
          return [assetReferenceIdentity(reference), structuredClone(reference)];
        }));
        state.initialAssetKeys = new Set(state.assetSelection.keys());
        state.missingAssetKeys = new Set(
          (packageView?.missingReferences || []).map(assetReferenceIdentity),
        );
        state.assetConflictDraft = null;
        state.assetConflictReloadFailed = false;
        state.assetAuthoritativeReloadRequired = false;
        state.assetContextVehicleId = vehicleId;
      }
      return true;
    } catch (error) {
      if (generation === scopeGeneration && request === assetRequest && state.open) {
        state.error = managementErrorMessage(error, "公司资产目录加载失败，请稍后重试。");
      }
      return false;
    } finally {
      if (generation === scopeGeneration && request === assetRequest && state.open) {
        state.assetLoading = false;
        render();
      }
    }
  }

  async function ensureStyleCatalog(force = false) {
    const generation = scopeGeneration;
    const accountId = state.account?.accountId;
    if (!isCurrentAdminScope(generation, accountId)) return [];
    if (!force && Array.isArray(state.styleCatalog)) return state.styleCatalog;
    const request = ++styleRequest;
    const items = [];
    const seenCursors = new Set();
    let cursor;
    do {
      const response = await api.searchCompanyAssets({
        categories: ["visual_style"],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!isCurrentAdminScope(generation, accountId) || request !== styleRequest) return [];
      items.push(...normalizeList(response, "items"));
      const nextCursor = typeof response?.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : null;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error("视觉预设目录返回了重复游标，已停止加载。");
      }
      if (nextCursor) seenCursors.add(nextCursor);
      if (seenCursors.size > 100) throw new Error("视觉预设目录页数超出安全上限。");
      cursor = nextCursor;
    } while (cursor);
    state.styleCatalog = [...new Map(items.map(function (item) {
      return [assetReferenceIdentity(item.reference), item];
    })).values()];
    return state.styleCatalog;
  }

  function openDialog(configuration, intent = null) {
    if (intent === null) dialogIntent += 1;
    else if (intent !== dialogIntent) return false;
    dialogState = configuration.state;
    dialog.classList.toggle("wide", Boolean(configuration.wide));
    dialog.innerHTML =
      '<form class="management-dialog-shell" data-management-dialog-form="' +
        escapeHtml(configuration.state.kind) + '">' +
        '<header><div><span class="management-kicker">WORKSPACE ADMIN</span>' +
          '<h2 id="management-dialog-title">' + escapeHtml(configuration.title) +
          "</h2><p>" + escapeHtml(configuration.description) + "</p></div>" +
          '<button class="management-dialog-close" type="button" data-dialog-action="close" aria-label="关闭">×</button></header>' +
        '<div class="management-dialog-error" role="alert" hidden></div>' +
        '<div class="management-dialog-body">' + configuration.body + "</div>" +
        '<footer><button class="management-button secondary" type="button" data-dialog-action="close"><span>' +
          (configuration.readOnly ? "关闭" : "取消") + "</span></button>" +
          (configuration.readOnly
            ? ""
            : '<button class="management-button ' + (configuration.destructive ? "danger" : "primary") +
              '" type="submit"><span>' + escapeHtml(configuration.submitLabel || "保存") + "</span></button>") +
        "</footer>" +
      "</form>";
    dialog.showModal();
    globalThis.setTimeout(function () {
      const focusTarget = dialog.querySelector(
        ".management-dialog-body input:not([type=hidden]), " +
        ".management-dialog-body select, .management-dialog-body textarea",
      ) || dialog.querySelector('button[type="submit"], [data-dialog-action="close"]');
      focusTarget?.focus();
    }, 0);
    return true;
  }

  function closeDialog(force = false) {
    if (state.saving && !force) return;
    dialogIntent += 1;
    dialogState = null;
    if (dialog.open) dialog.close();
  }

  function setDialogBusy(busy, label) {
    state.saving = busy;
    const form = dialog.querySelector("form");
    if (!form) return;
    form.querySelectorAll("input, select, textarea, button").forEach(function (control) {
      control.disabled = busy;
    });
    const submit = form.querySelector('button[type="submit"] span');
    if (submit) {
      submit.dataset.idleLabel ||= submit.textContent;
      submit.textContent = busy ? label || "正在保存…" : submit.dataset.idleLabel;
    }
    renderHeaderActions();
  }

  function setDialogError(message) {
    const error = dialog.querySelector(".management-dialog-error");
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  }

  function field(label, control, hint = "") {
    return '<label class="management-field"><span>' + escapeHtml(label) + "</span>" +
      control + (hint ? "<small>" + escapeHtml(hint) + "</small>" : "") + "</label>";
  }

  async function openBrandForm(brand = null) {
    const generation = scopeGeneration;
    const accountId = state.account?.accountId;
    const section = state.section;
    const intent = ++dialogIntent;
    const brandId = brand?.id || null;
    const intentIsCurrent = function () {
      return isCurrentDialogIntent(intent, generation, accountId, section) &&
        (brandId === null || state.selectedBrandId === brandId);
    };
    if (!isCurrentAdminScope(generation, accountId)) return;
    loadingDialogIntents.add(intent);
    syncSectionLoading();
    render();
    try {
      const styles = await ensureStyleCatalog();
      if (!intentIsCurrent()) return;
      const availableStyles = resolveBrandVisualStyleOptions(styles, brand);
      const styleOptions = availableStyles.map(function (item) {
        const assetId = item.reference?.assetId;
        return '<option value="' + escapeHtml(assetId) + '"' +
          (assetId === brand?.defaultVisualStylePresetId ? " selected" : "") + ">" +
          escapeHtml(item.displayName) + " · " + escapeHtml(assetId) + "</option>";
      }).join("");
      const noStyles = styleOptions.length === 0;
      openDialog({
        state: { kind: brand ? "brand-edit" : "brand-create", brand },
        title: brand ? "编辑品牌" : "新建品牌",
        description: "品牌名称与视觉预设会由服务端在当前租户和管理范围内校验。",
        submitLabel: brand ? "保存品牌" : "建立品牌",
        body: '<div class="management-form-grid">' +
          field(
            "品牌名称",
            '<input name="name" maxlength="120" required value="' + escapeHtml(brand?.name || "") +
              '" placeholder="例如：萤火汽车" autocomplete="off" />',
          ) +
          field(
            "默认视觉预设",
            '<select name="defaultVisualStylePresetId" required' + (noStyles ? " disabled" : "") + ">" +
              (styleOptions || "<option>当前范围内没有可用视觉预设</option>") + "</select>",
            "公司资产保持只读，品牌仅保存精确的预设 ID。",
          ) +
          (noStyles
            ? '<div class="management-form-callout">' + icon("shield") +
              "<p>当前管理范围未发现可用于品牌初始化的全局视觉预设，暂时不能建立品牌。</p></div>"
            : "") +
        "</div>",
      }, intent);
      if (noStyles) dialog.querySelector('button[type="submit"]').disabled = true;
    } catch (error) {
      if (!intentIsCurrent()) return;
      state.error = managementErrorMessage(error, "视觉预设加载失败，请稍后重试。");
      render();
    } finally {
      if (generation === scopeGeneration && state.account?.accountId === accountId) {
        loadingDialogIntents.delete(intent);
        syncSectionLoading();
        if (state.open) render();
      }
    }
  }

  function openBrandStatusDialog(brand) {
    const nextStatus = brand.status === "active" ? "archived" : "active";
    openDialog({
      state: { kind: "brand-status", brand, nextStatus },
      title: nextStatus === "archived" ? "归档品牌" : "恢复品牌",
      description: nextStatus === "archived"
        ? "归档后不能在该品牌下新增车型、资产关联或授权；已有事实与审计记录会保留。"
        : "恢复后可继续维护目录，但既有授权不会由页面自动恢复。",
      submitLabel: nextStatus === "archived" ? "确认归档" : "确认恢复",
      destructive: nextStatus === "archived",
      body: '<div class="management-confirmation"><span>' + icon("building") +
        "</span><div><strong>" + escapeHtml(brand.name) + "</strong><p>当前 revision " +
        escapeHtml(brand.revision) + "，服务端会拒绝过期版本。</p></div></div>",
    });
  }

  function vehicleFormBody(vehicle) {
    const currentYear = new Date().getFullYear();
    const parameters = JSON.stringify(vehicle?.parameters || {}, null, 2);
    const fixedClaims = JSON.stringify(vehicle?.fixedClaims || [], null, 2);
    const optionalClaims = JSON.stringify(vehicle?.optionalClaims || [], null, 2);
    const prohibitedClaims = Array.isArray(vehicle?.prohibitedClaims)
      ? vehicle.prohibitedClaims.join("\n")
      : "";
    return '<div class="management-form-grid two-columns">' +
      field(
        "车系",
        '<input name="series" maxlength="120" required value="' + escapeHtml(vehicle?.series || "") +
          '" placeholder="例如：萤火 E5" />',
      ) +
      field(
        "年款",
        '<input name="modelYear" type="number" min="2000" max="2100" required value="' +
          escapeHtml(vehicle?.modelYear || currentYear) + '" />',
      ) +
      field(
        "车型款",
        '<input name="trim" maxlength="120" required value="' + escapeHtml(vehicle?.trim || "") +
          '" placeholder="例如：长续航版" />',
      ) +
      field(
        "目录状态",
        '<select name="status"><option value="active"' +
          (vehicle?.status !== "archived" ? " selected" : "") +
          '>可用</option><option value="archived"' +
          (vehicle?.status === "archived" ? " selected" : "") + ">已归档</option></select>",
      ) +
      '<div class="management-json-fields">' +
        field(
          "车型参数（JSON 对象）",
          '<textarea name="parametersText" rows="8" spellcheck="false">' +
            escapeHtml(parameters) + "</textarea>",
          "仅允许文字、数字和布尔值；不会接受身份或租户字段。",
        ) +
        field(
          "固定事实（JSON 数组）",
          '<textarea name="fixedClaimsText" rows="12" spellcheck="false">' +
            escapeHtml(fixedClaims) + "</textarea>",
          "事实 ID、官方陈述、证据和配音/字幕约束会完整写入新版本。",
        ) +
        field(
          "扩展事实（JSON 数组）",
          '<textarea name="optionalClaimsText" rows="12" spellcheck="false">' +
            escapeHtml(optionalClaims) + "</textarea>",
          "新条目的 kind 会固定为 extended，历史字段不会被静默丢弃。",
        ) +
        field(
          "禁止表述（每行一条）",
          '<textarea name="prohibitedClaimsText" rows="8">' +
            escapeHtml(prohibitedClaims) + "</textarea>",
          "模型生成内容不能成为官方事实，禁止表述由人工维护。",
        ) +
      "</div></div>";
  }

  function openVehicleForm(vehicle = null) {
    const brand = selectedBrand();
    if (!brand) return;
    openDialog({
      state: {
        kind: vehicle ? "vehicle-version" : "vehicle-create",
        brand,
        vehicle,
      },
      title: vehicle ? "新建车型事实版本" : "新增车型",
      description: vehicle
        ? "将基于当前 v" + vehicle.version + " 追加不可变版本；历史事实不会被修改。"
        : "建立首个官方车型事实版本。后续更新只能继续追加版本。",
      submitLabel: vehicle ? "创建 v" + (Number(vehicle.version) + 1) : "建立车型",
      wide: true,
      body: vehicleFormBody(vehicle),
    });
  }

  function openVehicleVersionView(vehicle) {
    const facts = {
      parameters: vehicle.parameters || {},
      fixedClaims: vehicle.fixedClaims || [],
      optionalClaims: vehicle.optionalClaims || [],
      prohibitedClaims: vehicle.prohibitedClaims || [],
    };
    openDialog({
      state: { kind: "vehicle-view", vehicle },
      title: vehicle.series + " " + vehicle.modelYear + " " + vehicle.trim + " · v" + vehicle.version,
      description: "该车型事实版本不可变；以下内容仅供审计查看。",
      readOnly: true,
      wide: true,
      body: '<div class="management-version-readonly">' +
        '<dl class="management-summary-facts">' +
          "<div><dt>状态</dt><dd>" + statusBadge(vehicle.status) + "</dd></div>" +
          "<div><dt>创建时间</dt><dd>" + shortDate(vehicle.createdAt) + "</dd></div>" +
          '<div class="wide"><dt>车型</dt><dd>' +
            escapeHtml(vehicle.series + " / " + vehicle.modelYear + " / " + vehicle.trim) + "</dd></div>" +
        "</dl>" +
        '<section><h3>完整事实快照</h3><pre>' +
          escapeHtml(JSON.stringify(facts, null, 2)) + "</pre></section></div>",
    });
  }

  function grantOptions() {
    const accounts = state.accounts.map(function (entry) {
      return '<option value="' + escapeHtml(entry.account.accountId) + '">' +
        escapeHtml(entry.account.displayName) + " · " +
        escapeHtml(roleLabels[entry.account.role] || entry.account.role) + "</option>";
    }).join("");
    const brands = state.brands.filter(function (brand) {
      return brand.status === "active";
    }).map(function (brand) {
      return '<option value="' + escapeHtml(brand.id) + '">' + escapeHtml(brand.name) + "</option>";
    }).join("");
    return { accounts, brands };
  }

  async function openGrantForm() {
    const generation = scopeGeneration;
    const accountId = state.account?.accountId;
    const section = state.section;
    const intent = ++dialogIntent;
    if (!isCurrentAdminScope(generation, accountId)) return;
    loadingDialogIntents.add(intent);
    syncSectionLoading();
    render();
    try {
      await ensureAllVehicles();
      if (!isCurrentDialogIntent(intent, generation, accountId, section)) return;
      const choices = grantOptions();
      openDialog({
        state: { kind: "grant-create" },
        title: "新增账号授权",
        description: "目标账号、品牌与车型归属会由服务端重新校验。",
        submitLabel: "授予访问权",
        body: '<div class="management-form-grid">' +
          field("目标账号", '<select name="accountId" data-dialog-control="grant-account">' +
            choices.accounts + "</select>") +
          field("授权类型", '<select name="kind" data-dialog-control="grant-kind">' +
            '<option value="vehicle_project">车型项目访问</option><option value="brand">品牌范围</option></select>') +
          field("品牌", '<select name="brandId" data-dialog-control="grant-brand">' +
            choices.brands + "</select>") +
          '<div data-dialog-region="grant-vehicle">' +
            field("车型", '<select name="vehicleId" data-dialog-control="grant-vehicle"></select>') +
          "</div>" +
          '<div class="management-form-callout" data-dialog-region="grant-note">' + icon("shield") +
            "<p>车型项目访问仅可授予制作账号；品牌范围适用于品牌级管理或访问策略。</p></div>" +
        "</div>",
      }, intent);
      syncGrantDialog();
    } catch (error) {
      if (!isCurrentDialogIntent(intent, generation, accountId, section)) return;
      state.error = managementErrorMessage(error, "账号授权选项加载失败，请稍后重试。");
    } finally {
      if (generation === scopeGeneration && state.account?.accountId === accountId) {
        loadingDialogIntents.delete(intent);
        syncSectionLoading();
        if (state.open) render();
      }
    }
  }

  function syncGrantDialog() {
    if (dialogState?.kind !== "grant-create") return;
    const form = dialog.querySelector("form");
    const accountId = form?.elements.accountId?.value;
    const kind = form?.elements.kind?.value;
    const brandId = form?.elements.brandId?.value;
    const account = state.accounts.find(function (entry) {
      return entry.account.accountId === accountId;
    })?.account;
    const vehicleRegion = form?.querySelector('[data-dialog-region="grant-vehicle"]');
    const vehicleSelect = form?.elements.vehicleId;
    const submit = form?.querySelector('button[type="submit"]');
    if (!vehicleRegion || !vehicleSelect || !submit) return;
    vehicleRegion.hidden = kind !== "vehicle_project";
    if (kind === "vehicle_project") {
      const vehicles = (state.vehiclesByBrand.get(brandId) || []).filter(function (vehicle) {
        return vehicle.status === "active";
      });
      vehicleSelect.replaceChildren(...vehicles.map(function (vehicle) {
        const option = document.createElement("option");
        option.value = vehicle.id;
        option.textContent = vehicle.series + " " + vehicle.modelYear + " " + vehicle.trim;
        return option;
      }));
      submit.disabled = account?.role !== "creator" || vehicles.length === 0;
    } else {
      submit.disabled = !brandId;
    }
  }

  function findGrant(grantId) {
    for (const entry of state.accounts) {
      const grant = (entry.accessGrants || []).find(function (candidate) {
        return candidate.id === grantId;
      });
      if (grant) return { grant, account: entry.account };
    }
    return null;
  }

  function openGrantStatusDialog(entry) {
    const nextStatus = entry.grant.status === "active" ? "revoked" : "active";
    openDialog({
      state: {
        kind: "grant-status",
        grant: entry.grant,
        account: entry.account,
        nextStatus,
      },
      title: nextStatus === "revoked" ? "撤销账号授权" : "恢复账号授权",
      description: nextStatus === "revoked"
        ? "撤销后，目标账号下一次请求会从服务端会话范围中移除此访问权。"
        : "服务端会重新验证账号角色以及品牌、车型的当前状态。",
      submitLabel: nextStatus === "revoked" ? "确认撤销" : "确认恢复",
      destructive: nextStatus === "revoked",
      body: '<div class="management-confirmation"><span>' + icon("shield") +
        "</span><div><strong>" + escapeHtml(entry.account.displayName) + "</strong><p>" +
        escapeHtml(accessScopeLabel(entry.grant)) + " · revision " +
        escapeHtml(entry.grant.revision) + "</p></div></div>",
    });
  }

  function findAccount(accountId) {
    return state.accounts.find(function (entry) {
      return entry.account.accountId === accountId;
    }) || null;
  }

  function openBudgetForm(entry) {
    if (!entry) return;
    const budget = entry.budget;
    const balance = budget?.balance;
    const minimumMinor = budget
      ? Number(balance.spentAmountMinor || 0) + Number(balance.reservedAmountMinor || 0)
      : 0;
    const currency = budget?.currency || "CNY";
    const minorDigits = currencyMinorDigits(currency);
    const amountPattern = minorDigits === 0
      ? "\\d+"
      : "\\d+(\\.\\d{1," + minorDigits + "})?";
    const amountPlaceholder = minorDigits === 0 ? "例如：5000" : "例如：5000." + "0".repeat(minorDigits);
    const value = budget ? minorAmountToMajor(budget.limitAmountMinor, currency) : "";
    openDialog({
      state: { kind: "budget", entry },
      title: budget ? "调整账号额度" : "配置账号额度",
      description: budget
        ? "额度不能低于已使用与已预留金额之和，币种配置后不可修改。"
        : "当前演示以人民币录入，并以整数最小货币单位写入服务端。",
      submitLabel: budget ? "保存额度" : "配置额度",
      body: '<div class="management-budget-dialog-summary"><span>' +
        escapeHtml(Array.from(entry.account.displayName || "账")[0] || "账") +
        "</span><div><strong>" + escapeHtml(entry.account.displayName) + "</strong><small>" +
        escapeHtml(roleLabels[entry.account.role] || entry.account.role) + "</small></div></div>" +
        '<div class="management-form-grid two-columns">' +
          field(
            "币种",
            budget
              ? '<input name="currency" value="' + escapeHtml(budget.currency) + '" readonly />'
              : '<select name="currency"><option value="CNY">CNY · 人民币</option></select>',
          ) +
          field(
            "额度（" + currency + "）",
            '<input name="limitAmount" inputmode="decimal" pattern="' + amountPattern + '" required value="' +
              escapeHtml(value) + '" placeholder="' + amountPlaceholder + '" />',
            minimumMinor > 0
              ? "当前最低可设 " + formatMinorAmount(minimumMinor, budget.currency)
              : (minorDigits === 0 ? "仅支持整数" : "最多 " + minorDigits + " 位小数") +
                "；服务端以整数最小货币单位保存。",
          ) +
        "</div>",
    });
  }

  async function reloadAfterMutation(message, changeKind, operation) {
    const generation = operation.generation;
    const accountId = operation.accountId;
    if (!isCurrentAdminScope(generation, accountId)) return false;
    const preservedBrandId = state.selectedBrandId;
    const preservedVehicleId = state.selectedVehicleId;
    const loaded = await loadBase({ silent: true });
    if (!isCurrentAdminScope(generation, accountId)) return false;
    if (!loaded) {
      state.error = "更改已由服务端保存，但最新管理数据刷新失败。请手动刷新后核对结果。";
      render();
      return false;
    }
    if (preservedBrandId && state.brands.some(function (brand) { return brand.id === preservedBrandId; })) {
      state.selectedBrandId = preservedBrandId;
    }
    if (changeKind === "catalog") {
      state.vehiclesByBrand.delete(state.selectedBrandId);
      await ensureVehicles(state.selectedBrandId, true);
      if (!isCurrentAdminScope(generation, accountId)) return false;
      if (state.error) {
        state.error = "更改已由服务端保存，但车型目录刷新失败。请手动刷新后核对结果。";
        render();
        return false;
      }
      if (preservedVehicleId && vehiclesForBrand().some(function (vehicle) {
        return vehicle.id === preservedVehicleId;
      })) {
        state.selectedVehicleId = preservedVehicleId;
      }
      state.versionsByVehicle.delete(state.selectedVehicleId);
      await ensureVersions(state.selectedVehicleId, true);
      if (!isCurrentAdminScope(generation, accountId)) return false;
      if (state.error) {
        state.error = "更改已由服务端保存，但车型事实历史刷新失败。请手动刷新后核对结果。";
        render();
        return false;
      }
      state.styleCatalog = null;
      if (typeof options.onCatalogChanged === "function") {
        try {
          await options.onCatalogChanged();
        } catch {
          if (isCurrentAdminScope(generation, accountId)) {
            state.error = "更改已由服务端保存，但项目库同步刷新失败。请手动刷新后核对结果。";
            render();
          }
          return false;
        }
        if (!isCurrentAdminScope(generation, accountId)) return false;
      }
    } else if (changeKind === "access") {
      await ensureAllVehicles();
      if (!isCurrentAdminScope(generation, accountId)) return false;
      if (state.error) {
        state.error = "更改已由服务端保存，但授权范围刷新失败。请手动刷新后核对结果。";
        render();
        return false;
      }
    }
    state.error = null;
    render();
    setToast(message);
    return true;
  }

  async function refreshDialogConflict(submission, operation) {
    const loaded = await loadBase({ silent: true });
    if (!loaded || !isCurrentAdminScope(operation.generation, operation.accountId)) return false;
    if (submission.kind === "vehicle-version") {
      await ensureVehicles(submission.vehicle.brandId, true);
      if (!isCurrentAdminScope(operation.generation, operation.accountId)) return false;
      await ensureVersions(submission.vehicle.id, true);
      if (!isCurrentAdminScope(operation.generation, operation.accountId)) return false;
    }
    return true;
  }

  async function submitDialog(event) {
    event.preventDefault();
    if (!dialogState || state.saving) return;
    const submission = dialogState;
    const form = event.target;
    const formData = new FormData(form);
    const operation = {
      generation: scopeGeneration,
      accountId: state.account?.accountId,
    };
    const operationIsCurrent = function () {
      return isCurrentAdminScope(operation.generation, operation.accountId) &&
        dialog.open && dialogState === submission;
    };
    setDialogError("");
    setDialogBusy(true);
    try {
      if (submission.kind === "brand-create") {
        const response = await api.createBrand({
          name: formData.get("name"),
          defaultVisualStylePresetId: formData.get("defaultVisualStylePresetId"),
        });
        if (!operationIsCurrent()) return;
        const newBrandId = response?.brand?.id;
        closeDialog(true);
        if (newBrandId) state.selectedBrandId = newBrandId;
        await reloadAfterMutation("品牌已建立，管理员范围已由服务端更新。", "catalog", operation);
      } else if (submission.kind === "brand-edit") {
        const brand = submission.brand;
        await api.updateBrand(brand.id, {
          expectedRevision: brand.revision,
          name: formData.get("name"),
          defaultVisualStylePresetId: formData.get("defaultVisualStylePresetId"),
        });
        if (!operationIsCurrent()) return;
        closeDialog(true);
        await reloadAfterMutation("品牌设置已更新。", "catalog", operation);
      } else if (submission.kind === "brand-status") {
        const brand = submission.brand;
        await api.updateBrand(brand.id, {
          expectedRevision: brand.revision,
          status: submission.nextStatus,
        });
        if (!operationIsCurrent()) return;
        closeDialog(true);
        await reloadAfterMutation(
          submission.nextStatus === "archived" ? "品牌已归档。" : "品牌已恢复。",
          "catalog",
          operation,
        );
      } else if (submission.kind === "vehicle-create" || submission.kind === "vehicle-version") {
        const facts = createVehicleFactsRequest({
          status: formData.get("status"),
          series: formData.get("series"),
          modelYear: formData.get("modelYear"),
          trim: formData.get("trim"),
          parametersText: formData.get("parametersText"),
          fixedClaimsText: formData.get("fixedClaimsText"),
          optionalClaimsText: formData.get("optionalClaimsText"),
          prohibitedClaimsText: formData.get("prohibitedClaimsText"),
          ...(submission.vehicle ? { expectedVersion: submission.vehicle.version } : {}),
        });
        const response = submission.vehicle
          ? await api.createVehicleFactVersion(submission.vehicle.id, facts)
          : await api.createVehicle(submission.brand.id, facts);
        if (!operationIsCurrent()) return;
        const vehicleId = response?.vehicle?.id || submission.vehicle?.id;
        closeDialog(true);
        if (vehicleId) state.selectedVehicleId = vehicleId;
        await reloadAfterMutation(
          submission.kind === "vehicle-create" ? "车型已建立。" : "新的车型事实版本已建立。",
          "catalog",
          operation,
        );
      } else if (submission.kind === "grant-create") {
        const request = createAccessGrantRequest({
          accountId: formData.get("accountId"),
          kind: formData.get("kind"),
          brandId: formData.get("brandId"),
          vehicleId: formData.get("vehicleId"),
        });
        await api.createAccessGrant(request);
        if (!operationIsCurrent()) return;
        closeDialog(true);
        await reloadAfterMutation("账号授权已生效。", "access", operation);
      } else if (submission.kind === "grant-status") {
        await api.updateAccessGrant(submission.grant.id, {
          expectedRevision: submission.grant.revision,
          status: submission.nextStatus,
        });
        if (!operationIsCurrent()) return;
        const restored = submission.nextStatus === "active";
        closeDialog(true);
        await reloadAfterMutation(restored ? "账号授权已恢复。" : "账号授权已撤销。", "access", operation);
      } else if (submission.kind === "budget") {
        const entry = submission.entry;
        const currency = entry.budget?.currency || String(formData.get("currency") || "CNY").toUpperCase();
        const limitAmountMinor = majorAmountToMinor(formData.get("limitAmount"), currency);
        if (entry.budget) {
          const balance = entry.budget.balance;
          const minimum = Number(balance.spentAmountMinor || 0) + Number(balance.reservedAmountMinor || 0);
          if (limitAmountMinor < minimum) {
            throw new Error("额度不能低于 " + formatMinorAmount(minimum, entry.budget.currency) + "。");
          }
          await api.updateAccountBudget(entry.account.accountId, {
            expectedRevision: entry.budget.revision,
            limitAmountMinor,
          });
        } else {
          await api.createAccountBudget(entry.account.accountId, {
            currency,
            limitAmountMinor,
          });
        }
        if (!operationIsCurrent()) return;
        closeDialog(true);
        await reloadAfterMutation("账号额度已更新。", "budget", operation);
      }
    } catch (error) {
      if (!operationIsCurrent()) return;
      setDialogBusy(false);
      const message = managementErrorMessage(error, error?.message || "保存失败，请检查输入后重试。");
      setDialogError(message);
      if (error?.code === "AIC-WORKFLOW-REVISION_CONFLICT") {
        form.querySelector('button[type="submit"]')?.setAttribute("disabled", "");
        const refreshed = await refreshDialogConflict(submission, operation);
        if (!operationIsCurrent()) return;
        setDialogError(refreshed
          ? "数据已被其他操作更新，服务端最新版本已刷新。当前草稿仅供参考，请关闭后重新编辑。"
          : "数据已被其他操作更新，但最新版本刷新失败。当前草稿仅供参考，请关闭后重试。");
      }
    } finally {
      if (isCurrentAdminScope(operation.generation, operation.accountId) && !dialog.open) {
        state.saving = false;
        render();
      }
    }
  }

  async function saveAssetAssociations() {
    if (state.saving || state.assetLoading) return;
    const issue = assetSelectionIssue();
    if (issue) {
      state.error = issue;
      render();
      return;
    }
    const operation = {
      generation: scopeGeneration,
      accountId: state.account?.accountId,
      vehicleId: state.selectedVehicleId,
    };
    const operationIsCurrent = function () {
      return isCurrentAdminScope(operation.generation, operation.accountId) &&
        state.selectedVehicleId === operation.vehicleId;
    };
    if (!operationIsCurrent()) return;
    state.saving = true;
    state.error = null;
    render();
    try {
      const request = createAssetAssociationRequest(
        state.assetPackage?.association?.revision || 0,
        [...state.assetSelection.values()],
        operation.vehicleId,
      );
      await api.replaceVehicleAssetAssociations(operation.vehicleId, request);
      if (!operationIsCurrent()) return;
      state.assetAuthoritativeReloadRequired = true;
      const loaded = await loadAssetContext({ resetSelection: true });
      if (!operationIsCurrent()) return;
      if (!loaded) {
        state.error = "资产关联已保存，但最新 revision 刷新失败。重新加载权威数据前不能继续编辑或保存。";
        return;
      }
      setToast("车型推荐资产关联已保存。");
    } catch (error) {
      if (!operationIsCurrent()) return;
      state.error = managementErrorMessage(error, error?.message || "资产关联保存失败。");
      if (error?.code === "AIC-WORKFLOW-REVISION_CONFLICT") {
        const draft = new Map([...state.assetSelection.entries()].map(function (entry) {
          return [entry[0], structuredClone(entry[1])];
        }));
        const loaded = await loadAssetContext({ resetSelection: true });
        if (!operationIsCurrent()) return;
        state.assetConflictDraft = draft;
        state.assetConflictReloadFailed = !loaded;
        state.error = loaded
          ? "关联数据已更新：服务端最新版本已读取，你的选择草稿仍保留，需人工确认后才能再次保存。"
          : "关联数据已更新，但服务端最新版本刷新失败。你的选择草稿仍保留，重新加载前不能再次保存。";
      }
    } finally {
      if (isCurrentAdminScope(operation.generation, operation.accountId)) {
        state.saving = false;
        render();
      }
    }
  }

  async function retryAssetConflict() {
    if (!state.assetConflictDraft || state.assetLoading) return;
    const operation = {
      generation: scopeGeneration,
      accountId: state.account?.accountId,
      vehicleId: state.selectedVehicleId,
    };
    const draft = new Map([...state.assetConflictDraft.entries()].map(function (entry) {
      return [entry[0], structuredClone(entry[1])];
    }));
    const loaded = await loadAssetContext({ resetSelection: true });
    if (!isCurrentAdminScope(operation.generation, operation.accountId) ||
      state.selectedVehicleId !== operation.vehicleId) return;
    state.assetConflictDraft = draft;
    state.assetConflictReloadFailed = !loaded;
    state.error = loaded
      ? "服务端最新版本已读取。请选择采用服务端版本或保留你的选择。"
      : "服务端最新版本仍无法读取，你的选择草稿继续保留。";
    render();
  }

  async function reloadAuthoritativeAssetContext() {
    if (!state.assetAuthoritativeReloadRequired || state.assetLoading || state.saving) return;
    const operation = {
      generation: scopeGeneration,
      accountId: state.account?.accountId,
      vehicleId: state.selectedVehicleId,
    };
    const loaded = await loadAssetContext({ resetSelection: true });
    if (
      !isCurrentAdminScope(operation.generation, operation.accountId) ||
      state.selectedVehicleId !== operation.vehicleId
    ) return;
    state.error = loaded
      ? null
      : "最新资产关联仍无法读取；页面继续阻断编辑和保存，请稍后重试。";
    render();
  }

  async function loadMoreAssets() {
    if (!state.assetNextCursor || state.assetLoading || state.saving) return;
    await loadAssetContext({
      catalogOnly: true,
      appendCatalog: true,
      cursor: state.assetNextCursor,
    });
  }

  async function ensureSectionData(force = false) {
    if (state.section === "catalog") {
      await ensureVehicles(state.selectedBrandId, force);
      await ensureVersions(state.selectedVehicleId, force);
    } else if (state.section === "assets") {
      await ensureVehicles(state.selectedBrandId, force);
      if (state.selectedVehicleId) await loadAssetContext({ resetSelection: true });
    } else if (state.section === "access") {
      await ensureAllVehicles(force);
    }
  }

  async function refresh() {
    const generation = scopeGeneration;
    const accountId = state.account?.accountId;
    const loaded = await loadBase();
    if (loaded && isCurrentAdminScope(generation, accountId)) await ensureSectionData(true);
  }

  async function selectSection(sectionId) {
    if (!managementSections.some(function (section) { return section.id === sectionId; })) return;
    const generation = scopeGeneration;
    const accountId = state.account?.accountId;
    if (!isCurrentAdminScope(generation, accountId)) return;
    dialogIntent += 1;
    state.section = sectionId;
    state.error = null;
    render();
    await ensureSectionData();
    if (!isCurrentAdminScope(generation, accountId)) return;
  }

  function open(openOptions = {}) {
    if (state.account?.role !== "content_admin" || state.open) return;
    if (typeof options.onBeforeOpen === "function") options.onBeforeOpen();
    state.open = true;
    state.error = null;
    view.hidden = false;
    topbarTitle.textContent = "管理中心";
    if (openOptions?.historyMode !== "none" && !managementUrlIsActive()) {
      globalThis.history.pushState({ managementCenter: true }, "", managementUrl(true));
    }
    render();
    void refresh();
  }

  function close(reason = "user") {
    if (!state.open) return;
    if (
      reason === "user" &&
      managementUrlIsActive() &&
      globalThis.history.state?.managementCenter === true
    ) {
      globalThis.history.back();
      return;
    }
    scopeGeneration += 1;
    state.open = false;
    state.saving = false;
    loadingVehicleBrands.clear();
    loadingDialogIntents.clear();
    state.sectionLoading = false;
    if (dialog.open) dialog.close();
    dialogState = null;
    view.hidden = true;
    if ((reason === "account" || reason === "user") && managementUrlIsActive()) {
      globalThis.history.replaceState(globalThis.history.state, "", managementUrl(false));
    }
    topbarTitle.textContent = "项目库";
    render();
    if (typeof options.onAfterClose === "function") options.onAfterClose({ reason });
    if (reason !== "account" && !entry.hidden) {
      globalThis.setTimeout(function () { entry.focus(); }, 0);
    }
  }

  function setAccount(account, disabled = false) {
    const previousAccountId = state.account?.accountId || null;
    const nextAccountId = account?.accountId || null;
    if (previousAccountId !== nextAccountId) {
      if (state.open) close("account");
      scopeGeneration += 1;
      vehicleRequests.clear();
      versionRequests.clear();
      loadingVehicleBrands.clear();
      state = freshState(account || null);
      clearManagementDom();
    } else {
      state.account = account || null;
    }
    entry.hidden = state.account?.role !== "content_admin";
    entry.disabled = disabled || entry.hidden;
    view.inert = Boolean(disabled);
    view.setAttribute("aria-busy", String(Boolean(disabled)));
    if (entry.hidden) {
      if (state.open) close("account");
      else if (state.account && !disabled && managementUrlIsActive()) {
        globalThis.history.replaceState(globalThis.history.state, "", managementUrl(false));
      }
    } else if (!disabled && managementUrlIsActive() && !state.open) {
      open({ historyMode: "none" });
    }
  }

  view.addEventListener("submit", function (event) {
    const form = event.target.closest("[data-admin-form]");
    if (!form) return;
    event.preventDefault();
    if (form.dataset.adminForm === "asset-search") {
      if (state.saving || state.assetAuthoritativeReloadRequired) return;
      state.assetSearch = String(new FormData(form).get("searchText") || "").trim();
      void loadAssetContext({ catalogOnly: true });
    }
  });

  view.addEventListener("change", function (event) {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) return;
    if ((state.saving || state.assetAuthoritativeReloadRequired) &&
      (control.dataset.adminControl?.startsWith("asset-") || control.dataset.adminAssetKey)) return;
    if (control.dataset.adminControl === "asset-brand") {
      const generation = scopeGeneration;
      const accountId = state.account?.accountId;
      const brandId = control.value;
      state.selectedBrandId = brandId;
      state.selectedVehicleId = null;
      clearAssetContextData();
      state.error = null;
      render();
      void ensureVehicles(brandId).then(function () {
        if (isCurrentAdminScope(generation, accountId) &&
          state.selectedBrandId === brandId && state.selectedVehicleId) {
          void loadAssetContext({ resetSelection: true });
        }
      });
      return;
    }
    if (control.dataset.adminControl === "asset-vehicle") {
      state.selectedVehicleId = control.value;
      clearAssetContextData();
      state.error = null;
      render();
      void loadAssetContext({ resetSelection: true });
      return;
    }
    if (control.dataset.adminControl === "asset-category") {
      state.assetCategory = ASSET_CATEGORIES.has(control.value) ? control.value : "all";
      void loadAssetContext({ catalogOnly: true });
      return;
    }
    if (control.dataset.adminControl === "access-account") {
      state.accessAccountId = control.value;
      render();
      return;
    }
    const assetKey = control.dataset.adminAssetKey;
    if (assetKey) {
      const item = state.assetCatalog.find(function (candidate) {
        return assetReferenceIdentity(candidate.reference) === assetKey;
      });
      if (!item) return;
      if (control.checked) state.assetSelection.set(assetKey, structuredClone(item.reference));
      else state.assetSelection.delete(assetKey);
      render();
    }
  });

  view.addEventListener("click", function (event) {
    const action = event.target.closest("[data-admin-action]");
    if (!action || action.disabled) return;
    const value = action.dataset.adminValue;
    if (action.dataset.adminAction === "close") {
      close();
    } else if (action.dataset.adminAction === "refresh") {
      void refresh();
    } else if (action.dataset.adminAction === "new-brand") {
      void openBrandForm();
    } else if (action.dataset.adminAction === "edit-brand") {
      const brand = state.brands.find(function (entry) { return entry.id === value; });
      if (brand) void openBrandForm(brand);
    } else if (action.dataset.adminAction === "toggle-brand-status") {
      const brand = state.brands.find(function (entry) { return entry.id === value; });
      if (brand) openBrandStatusDialog(brand);
    } else if (action.dataset.adminAction === "select-brand") {
      const generation = scopeGeneration;
      const accountId = state.account?.accountId;
      const brandId = value;
      state.selectedBrandId = brandId;
      state.selectedVehicleId = null;
      state.error = null;
      render();
      void ensureVehicles(brandId).then(function () {
        if (isCurrentAdminScope(generation, accountId) &&
          state.selectedBrandId === brandId && state.selectedVehicleId) {
          void ensureVersions(state.selectedVehicleId);
        }
      });
    } else if (action.dataset.adminAction === "select-vehicle") {
      state.selectedVehicleId = value;
      state.error = null;
      render();
      void ensureVersions(value);
    } else if (action.dataset.adminAction === "new-vehicle") {
      openVehicleForm();
    } else if (action.dataset.adminAction === "new-vehicle-version") {
      const vehicle = vehiclesForBrand().find(function (entry) { return entry.id === value; });
      if (vehicle) openVehicleForm(vehicle);
    } else if (action.dataset.adminAction === "view-vehicle-version") {
      const version = Number(value);
      const vehicle = (state.versionsByVehicle.get(state.selectedVehicleId) || []).find(function (entry) {
        return entry.version === version;
      });
      if (vehicle) openVehicleVersionView(vehicle);
    } else if (action.dataset.adminAction === "save-assets") {
      void saveAssetAssociations();
    } else if (action.dataset.adminAction === "remove-missing-asset") {
      state.assetSelection.delete(value);
      state.missingAssetKeys.delete(value);
      render();
    } else if (action.dataset.adminAction === "resolve-asset-conflict-server") {
      state.assetConflictDraft = null;
      state.assetConflictReloadFailed = false;
      state.error = null;
      render();
    } else if (action.dataset.adminAction === "resolve-asset-conflict-draft") {
      state.assetSelection = new Map(state.assetConflictDraft || []);
      state.assetConflictDraft = null;
      state.assetConflictReloadFailed = false;
      state.error = null;
      render();
    } else if (action.dataset.adminAction === "retry-asset-conflict") {
      void retryAssetConflict();
    } else if (action.dataset.adminAction === "reload-asset-authority") {
      void reloadAuthoritativeAssetContext();
    } else if (action.dataset.adminAction === "clear-asset-filters") {
      state.assetCategory = "all";
      state.assetSearch = "";
      void loadAssetContext({ catalogOnly: true });
    } else if (action.dataset.adminAction === "load-more-assets") {
      void loadMoreAssets();
    } else if (action.dataset.adminAction === "new-grant") {
      void openGrantForm();
    } else if (action.dataset.adminAction === "toggle-grant") {
      const grant = findGrant(value);
      if (grant) openGrantStatusDialog(grant);
    } else if (action.dataset.adminAction === "edit-budget") {
      openBudgetForm(findAccount(value));
    }
  });

  dialog.addEventListener("click", function (event) {
    const action = event.target.closest("[data-dialog-action]");
    if (action?.dataset.dialogAction === "close") closeDialog();
  });

  dialog.addEventListener("cancel", function (event) {
    if (state.saving) event.preventDefault();
    else dialogState = null;
  });

  dialog.addEventListener("change", function () {
    syncGrantDialog();
  });

  dialog.addEventListener("submit", function (event) {
    void submitDialog(event);
  });

  globalThis.addEventListener("popstate", function () {
    if (managementUrlIsActive()) {
      if (!state.open) open({ historyMode: "none" });
    } else if (state.open) {
      close("history");
    }
  });

  entry.addEventListener("click", open);
  navigation.forEach(function (item) {
    item.addEventListener("click", function () {
      void selectSection(item.dataset.adminSection);
    });
  });

  return {
    open,
    close,
    setAccount,
    refresh,
  };
}
