import { agentApi } from "./agent-api.js";

const panelMinimumWidth = 320;
const panelMaximumWidth = 560;
const panelResizerWidth = 6;
const compactDesktopMaximum = 1180;
const mobileMaximum = 980;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function agentPanelWidthBounds(shellWidth) {
  const sidebarWidth = shellWidth <= compactDesktopMaximum ? 220 : 260;
  const studioMinimumWidth = shellWidth <= compactDesktopMaximum ? 480 : 540;
  const availableWidth = Math.max(0, shellWidth - sidebarWidth - studioMinimumWidth - panelResizerWidth);
  return {
    minimum: Math.min(panelMinimumWidth, availableWidth),
    maximum: Math.min(panelMaximumWidth, availableWidth),
  };
}

export function resolveAgentPanelWidth(shellWidth, requestedWidth) {
  const bounds = agentPanelWidthBounds(shellWidth);
  return clamp(requestedWidth, bounds.minimum, bounds.maximum);
}

export function createAgentPanelLayoutController(options) {
  const { shell, panel, resizer, collapseButton, prompt } = options;
  const widthKey = "firefly.agentPanelWidth";
  const collapsedKey = "firefly.agentPanelCollapsed";
  const desktopMedia = window.matchMedia(`(min-width: ${mobileMaximum + 1}px)`);
  const storedWidth = Number(localStorage.getItem(widthKey));
  let requestedWidth = Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : 380;
  let collapsed = localStorage.getItem(collapsedKey) === "true";

  function effectiveWidth() {
    return resolveAgentPanelWidth(shell.clientWidth || window.innerWidth, requestedWidth);
  }

  function persist(key, value) {
    try { localStorage.setItem(key, String(value)); } catch {}
  }

  function render() {
    const effectivelyCollapsed = collapsed && desktopMedia.matches;
    const shellWidth = shell.clientWidth || window.innerWidth;
    const width = resolveAgentPanelWidth(shellWidth, requestedWidth);
    const bounds = agentPanelWidthBounds(shellWidth);
    shell.style.setProperty("--agent-panel-width", width + "px");
    shell.dataset.agentCollapsed = String(effectivelyCollapsed);
    panel.removeAttribute("aria-hidden");
    resizer.setAttribute("aria-valuemin", String(bounds.minimum));
    resizer.setAttribute("aria-valuemax", String(bounds.maximum));
    resizer.setAttribute("aria-valuenow", String(Math.round(width)));
    collapseButton.setAttribute("aria-expanded", String(!effectivelyCollapsed));
    collapseButton.setAttribute("aria-label", effectivelyCollapsed ? "展开 Agent 面板" : "折叠 Agent 面板");
    collapseButton.title = effectivelyCollapsed ? "展开 Agent 面板（Alt+Shift+A）" : "折叠 Agent 面板（Alt+Shift+A）";
  }

  function toggle() {
    collapsed = !collapsed;
    persist(collapsedKey, collapsed);
    render();
    if (collapsed && panel.contains(document.activeElement)) collapseButton.focus();
    if (!collapsed) prompt.focus();
  }

  function setRequestedWidth(nextWidth, persistChange = true) {
    requestedWidth = clamp(nextWidth, panelMinimumWidth, panelMaximumWidth);
    if (persistChange) persist(widthKey, requestedWidth);
    render();
  }

  collapseButton.addEventListener("click", toggle);
  desktopMedia.addEventListener("change", render);
  window.addEventListener("resize", render);
  document.addEventListener("keydown", function (event) {
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      toggle();
    }
  });

  resizer.addEventListener("keydown", function (event) {
    const step = event.shiftKey ? 40 : 20;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") setRequestedWidth(panelMinimumWidth);
    else if (event.key === "End") setRequestedWidth(panelMaximumWidth);
    else setRequestedWidth(requestedWidth + (event.key === "ArrowLeft" ? step : -step));
  });
  resizer.addEventListener("pointerdown", function (event) {
    if (collapsed || !desktopMedia.matches) return;
    const startX = event.clientX;
    const startWidth = effectiveWidth();
    resizer.dataset.resizing = "true";
    resizer.setPointerCapture(event.pointerId);
    function move(moveEvent) {
      setRequestedWidth(startWidth + startX - moveEvent.clientX, false);
    }
    function stop() {
      persist(widthKey, requestedWidth);
      delete resizer.dataset.resizing;
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", stop);
      resizer.removeEventListener("pointercancel", stop);
    }
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", stop);
    resizer.addEventListener("pointercancel", stop);
  });

  render();
  return { render, toggle };
}

export function bindAgentPanel(options) {
  const { elements, state, sendMessage, createSession, selectSession, updateSession, clearMessages, clearError, showError, setBusy } = options;

  elements.composer.addEventListener("submit", function (event) {
    event.preventDefault();
    void sendMessage(elements.prompt.value);
  });

  elements.prompt.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });

  elements.prompt.addEventListener("input", function () {
    elements.prompt.style.height = "auto";
    elements.prompt.style.height = Math.min(elements.prompt.scrollHeight, 180) + "px";
  });

  document.querySelectorAll("[data-prompt]").forEach(function (button) {
    button.addEventListener("click", function () {
      elements.prompt.value = button.dataset.prompt || "";
      elements.prompt.focus();
    });
  });

  elements.newSession.addEventListener("click", async function () {
    if (state.busy) return;
    clearError();
    setBusy(true);
    try { await createSession(); } catch (error) { showError(error); }
    finally { setBusy(false); elements.prompt.focus(); }
  });

  elements.resetSession.addEventListener("click", async function () {
    if (state.busy || !state.sessionId) return;
    if (!window.confirm("确认清空当前会话记录？此操作不可撤销。")) return;
    clearError();
    setBusy(true);
    try {
      const result = await agentApi.resetSession(state.sessionId, state.sessionVideoTaskId);
      updateSession(result.session);
      clearMessages();
    } catch (error) { showError(error); }
    finally { setBusy(false); elements.prompt.focus(); }
  });

  elements.cancelGeneration.addEventListener("click", async function () {
    if (!state.busy || !state.sessionId || !state.activeRunId) return;
    elements.cancelGeneration.disabled = true;
    try {
      await agentApi.abortRun(state.sessionId, state.activeRunId, state.sessionVideoTaskId);
    } catch (error) {
      showError(error);
      elements.cancelGeneration.disabled = false;
    }
  });

  elements.sessionSelect.addEventListener("change", function () {
    if (state.busy || !elements.sessionSelect.value || elements.sessionSelect.value === state.sessionId) return;
    void selectSession(elements.sessionSelect.value);
  });

  elements.retryMessage.addEventListener("click", function () {
    if (!state.lastPrompt || state.busy) return;
    void sendMessage(state.lastPrompt);
  });

  createAgentPanelLayoutController({
    shell: elements.workspaceShell,
    panel: elements.chatView,
    resizer: document.querySelector("#agent-resizer"),
    collapseButton: document.querySelector("#collapse-agent"),
    prompt: elements.prompt,
  });
}
