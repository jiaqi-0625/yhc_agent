"use strict";

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
