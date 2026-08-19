function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function navigationBrand(value, requireActiveStatus) {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  if (requireActiveStatus && value.status !== "active") return null;
  const id = value.id.trim();
  const name = value.name.trim();
  if (!id || !name) return null;
  return { id, name };
}

export function normalizeNavigationBrands(role, response) {
  if (!isRecord(response) || !Array.isArray(response.brands)) return [];
  const requireActiveStatus = role === "content_admin";
  if (!requireActiveStatus && role !== "creator") return [];
  const seen = new Set();
  return response.brands
    .map(function (value) { return navigationBrand(value, requireActiveStatus); })
    .filter(function (brand) {
      if (!brand || seen.has(brand.id)) return false;
      seen.add(brand.id);
      return true;
    })
    .sort(function (left, right) {
      return left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id);
    });
}

export function navigationBrandStorageKey(accountId) {
  const accountScope = typeof accountId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(accountId)
    ? accountId
    : "anonymous";
  return "firefly.navigationBrand." + accountScope;
}

export function resolveNavigationBrandId(brands, preferredBrandId) {
  if (!Array.isArray(brands) || brands.length === 0) return null;
  const preferred = brands.find(function (brand) { return brand.id === preferredBrandId; });
  return (preferred || brands[0]).id;
}

export function workSummaryMatchesNavigationBrand(summary, brand) {
  if (!brand) return true;
  if (!isRecord(summary) || !isRecord(summary.vehicle)) return false;
  if (typeof summary.vehicle.brandId === "string") return summary.vehicle.brandId.trim() === brand.id;
  return typeof summary.vehicle.brand === "string" && summary.vehicle.brand.trim() === brand.name;
}

export function bindWorkspaceShell(options) {
  const { elements, selectNavigationBrand, retryNavigationBrands } = options;

  document.querySelectorAll("[data-workspace-view]").forEach(function (button) {
    button.setAttribute("aria-current", button.classList.contains("active") ? "page" : "false");
    button.addEventListener("click", function () {
      document.querySelectorAll("[data-workspace-view]").forEach(function (candidate) {
        candidate.classList.toggle("active", candidate === button);
        candidate.setAttribute("aria-current", candidate === button ? "page" : "false");
      });
      document.querySelectorAll("[data-workspace-panel]").forEach(function (view) {
        view.hidden = view.dataset.workspacePanel !== button.dataset.workspaceView;
      });
    });
  });

  document.querySelectorAll("[data-mobile-target]").forEach(function (button) {
    button.addEventListener("click", function () {
      elements.workspaceShell.dataset.mobilePane = button.dataset.mobileTarget;
      document.querySelectorAll("[data-mobile-target]").forEach(function (candidate) {
        candidate.classList.toggle("active", candidate === button);
      });
    });
  });

  elements.brandNavigation.addEventListener("change", function () {
    if (elements.brandNavigation.disabled) return;
    void selectNavigationBrand(elements.brandNavigation.value);
  });

  elements.brandNavigationRetry.addEventListener("click", function () {
    retryNavigationBrands();
  });

  function applyTheme(theme) {
    const resolved = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
    localStorage.setItem("firefly.theme", resolved);
    elements.themeToggle.setAttribute("aria-label", resolved === "dark" ? "切换到浅色主题" : "切换到深色主题");
    elements.themeToggle.title = resolved === "dark" ? "切换到浅色主题" : "切换到深色主题";
  }

  applyTheme(localStorage.getItem("firefly.theme") || "light");
  elements.themeToggle.addEventListener("click", function () {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}
