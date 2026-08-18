import { agentApi } from "./agent-api.js";

export function bindAgentPanel(options) {
  const { elements, state, sendMessage, createSession, updateSession, clearMessages, clearError, showError, setBusy } = options;

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
      const result = await agentApi.resetSession(state.sessionId);
      updateSession(result.session);
      clearMessages();
    } catch (error) { showError(error); }
    finally { setBusy(false); elements.prompt.focus(); }
  });

  elements.cancelGeneration.addEventListener("click", async function () {
    if (!state.busy || !state.sessionId || !state.activeAbortController) return;
    elements.cancelGeneration.disabled = true;
    try {
      await agentApi.abortSession(state.sessionId);
    } catch (error) {
      showError(error);
    } finally {
      state.activeAbortController.abort();
    }
  });

  elements.retryMessage.addEventListener("click", function () {
    if (!state.lastPrompt || state.busy) return;
    void sendMessage(state.lastPrompt);
  });
}
