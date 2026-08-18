export function bindWorkspaceShell(options) {
  const { elements, state, renderWorkList } = options;

  document.querySelectorAll("[data-workspace-view]").forEach(function (button) {
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

  elements.workSearch.addEventListener("input", function () {
    state.workFilter = elements.workSearch.value;
    renderWorkList();
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
