"use strict";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export async function streamAgentMessage(path, message, options = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ message }),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    let errorMessage = "请求失败（HTTP " + response.status + "）";
    try {
      const body = await response.json();
      if (body && typeof body.message === "string") errorMessage = body.message;
    } catch {}
    throw new Error(errorMessage);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const seenEventIds = new Set();
  let lastSequence = 0;
  let buffer = "";
  let completion;

  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }).replace(/\r\n/g, "\n");
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      let eventName = "message";
      let eventId;
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("id:")) eventId = line.slice(3).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      const payload = JSON.parse(data.join("\n"));
      if (eventName === "agent") {
        const stableId = eventId || payload.eventId;
        if (typeof stableId !== "string" || seenEventIds.has(stableId)) continue;
        if (!Number.isInteger(payload.sequence) || payload.sequence < 1) {
          throw new Error("Agent 返回了无效的事件顺序。");
        }
        if (lastSequence !== 0 && payload.sequence !== lastSequence + 1) {
          throw new Error("Agent 事件流出现缺口，请重试本次消息。");
        }
        seenEventIds.add(stableId);
        lastSequence = payload.sequence;
        options.onEvent?.(payload);
      }
      if (eventName === "complete") completion = payload;
      if (eventName === "error") throw new Error(payload.message || "Agent 流式请求失败。");
    }
    if (chunk.done) break;
  }
  if (!completion) throw new Error("Agent 流在完成前意外结束。");
  return completion;
}

export function createAgentPanelLayoutController(options) {
  const { shell, panel, resizer, collapseButton } = options;
  const widthKey = "firefly.agentPanelWidth";
  const collapsedKey = "firefly.agentPanelCollapsed";
  const desktopMedia = window.matchMedia("(min-width: 981px)");
  const storedWidth = Number(localStorage.getItem(widthKey));
  let width = Number.isFinite(storedWidth) ? clamp(storedWidth, 320, 560) : 380;
  let collapsed = localStorage.getItem(collapsedKey) === "true";

  function render() {
    const effectivelyCollapsed = collapsed && desktopMedia.matches;
    shell.style.setProperty("--agent-panel-width", width + "px");
    shell.dataset.agentCollapsed = String(effectivelyCollapsed);
    panel.removeAttribute("aria-hidden");
    collapseButton.setAttribute("aria-expanded", String(!effectivelyCollapsed));
    collapseButton.setAttribute("aria-label", effectivelyCollapsed ? "展开 Agent 面板" : "折叠 Agent 面板");
    collapseButton.title = effectivelyCollapsed ? "展开 Agent 面板（Alt+Shift+A）" : "折叠 Agent 面板（Alt+Shift+A）";
  }

  function toggle() {
    collapsed = !collapsed;
    localStorage.setItem(collapsedKey, String(collapsed));
    render();
  }

  collapseButton.addEventListener("click", toggle);
  desktopMedia.addEventListener("change", render);
  document.addEventListener("keydown", function (event) {
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      toggle();
    }
  });

  resizer.addEventListener("keydown", function (event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    width = clamp(width + (event.key === "ArrowLeft" ? 20 : -20), 320, 560);
    localStorage.setItem(widthKey, String(width));
    render();
  });
  resizer.addEventListener("pointerdown", function (event) {
    if (collapsed || window.innerWidth <= 980) return;
    const startX = event.clientX;
    const startWidth = width;
    resizer.setPointerCapture(event.pointerId);
    function move(moveEvent) {
      width = clamp(startWidth + startX - moveEvent.clientX, 320, 560);
      render();
    }
    function stop() {
      localStorage.setItem(widthKey, String(width));
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", stop);
      resizer.removeEventListener("pointercancel", stop);
    }
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", stop);
    resizer.addEventListener("pointercancel", stop);
  });

  render();
  return { toggle };
}
