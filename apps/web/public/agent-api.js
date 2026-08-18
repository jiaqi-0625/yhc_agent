import { api } from "./api-client.js";

export const agentApi = {
  createSession: function (workId) {
    return api("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workId ? { workId: workId } : {}),
    });
  },
  getSession: function (sessionId) {
    return api("/v1/sessions/" + encodeURIComponent(sessionId));
  },
  getTranscript: function (sessionId) {
    return api("/v1/sessions/" + encodeURIComponent(sessionId) + "/transcript");
  },
  resetSession: function (sessionId) {
    return api("/v1/sessions/" + encodeURIComponent(sessionId) + "/reset", { method: "POST" });
  },
  streamMessage: streamAgentMessage,
};

async function streamAgentMessage(sessionId, message, onRuntimeEvent) {
  const response = await fetch("/v1/sessions/" + encodeURIComponent(sessionId) + "/messages-stream", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ message: message }),
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
  let buffer = "";
  let completion;
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }).replace(/\r\n/g, "\n");
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    frames.forEach(function (frame) {
      let eventName = "message";
      const data = [];
      frame.split("\n").forEach(function (line) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      });
      if (data.length === 0) return;
      const payload = JSON.parse(data.join("\n"));
      if (eventName === "runtime") onRuntimeEvent(payload);
      if (eventName === "complete") completion = payload;
      if (eventName === "error") throw new Error(payload.message || "Agent 流式请求失败。");
    });
    if (chunk.done) break;
  }
  if (!completion) throw new Error("Agent 流在完成前意外结束。");
  return completion;
}
