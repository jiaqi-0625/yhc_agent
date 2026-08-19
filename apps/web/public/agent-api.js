import { api } from "./api-client.js";

class AgentStreamProtocolError extends Error {}
class AgentStreamTransportError extends Error {}

class AgentStreamServerError extends Error {
  constructor(payload, status) {
    super(payload && typeof payload.message === "string" ? payload.message : "Agent 流式请求失败。");
    this.code = payload && typeof payload.code === "string" ? payload.code : "AIC-AGENT-STREAM_FAILED";
    this.status = status;
    this.retryable = Boolean(payload && payload.retryable);
  }
}

function newRunRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return "request_" + globalThis.crypto.randomUUID();
  }
  return "request_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
}

function waitForRetry(delayMs, signal) {
  return new Promise(function (resolve, reject) {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", function () {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function responseError(response) {
  let payload;
  try { payload = await response.json(); } catch {}
  return new AgentStreamServerError(payload, response.status);
}

async function startAgentRun(sessionId, message, requestId, options = {}) {
  const maximumAttempts = options.startAttempts ?? 4;
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch("/v1/sessions/" + encodeURIComponent(sessionId) + "/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: message, requestId: requestId }),
        signal: options.signal,
      });
      if (!response.ok) throw await responseError(response);
      const body = await response.json();
      if (!body || !body.run || typeof body.run.runId !== "string") {
        throw new AgentStreamProtocolError("Agent 未返回有效的运行标识。");
      }
      return body.run;
    } catch (error) {
      if (error instanceof AgentStreamServerError || error instanceof AgentStreamProtocolError) throw error;
      if (options.signal?.aborted) throw error;
      attempt += 1;
      if (attempt >= maximumAttempts) throw new AgentStreamTransportError("无法启动 Agent 运行，请检查连接后重试。");
      options.onConnectionState?.("reconnecting");
      await waitForRetry(Math.min(250 * (2 ** (attempt - 1)), 2_000), options.signal);
    }
  }
}

function parseFrames(buffer, onFrame) {
  const frames = buffer.split("\n\n");
  const remainder = frames.pop() || "";
  frames.forEach(function (frame) {
    let eventName = "message";
    let eventId;
    const data = [];
    frame.split("\n").forEach(function (line) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("id:")) eventId = line.slice(3).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    });
    if (data.length === 0) return;
    let payload;
    try { payload = JSON.parse(data.join("\n")); }
    catch { throw new AgentStreamProtocolError("Agent 返回了无法解析的事件。"); }
    onFrame(eventName, eventId, payload);
  });
  return remainder;
}

async function readRunStream(response, sessionId, runId, state, options) {
  if (!response.body) throw new AgentStreamTransportError("Agent 事件流没有可读取的响应体。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completion;
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }).replace(/\r\n/g, "\n");
    buffer = parseFrames(buffer, function (eventName, eventId, payload) {
      if (eventName === "agent") {
        const stableId = eventId || payload.eventId;
        if (typeof stableId !== "string") throw new AgentStreamProtocolError("Agent 返回了缺少标识的事件。");
        if (state.seenEventIds.has(stableId)) return;
        if (payload.sessionId !== sessionId || payload.runId !== runId) {
          throw new AgentStreamProtocolError("Agent 返回了不属于当前运行的事件。");
        }
        if (!Number.isInteger(payload.sequence) || payload.sequence !== state.lastSequence + 1) {
          throw new AgentStreamProtocolError("Agent 事件流出现缺口，无法安全续传。");
        }
        state.seenEventIds.add(stableId);
        state.lastSequence = payload.sequence;
        state.lastEventId = stableId;
        options.onEvent?.(payload);
      }
      if (eventName === "complete") completion = payload;
      if (eventName === "error") throw new AgentStreamServerError(payload, 200);
    });
    if (completion !== undefined) return completion;
    if (chunk.done) throw new AgentStreamTransportError("Agent 连接在完成前中断。");
  }
}

async function streamRunEvents(sessionId, runId, options = {}) {
  const state = options.streamState || { seenEventIds: new Set(), lastSequence: 0, lastEventId: null };
  const maximumReconnects = options.maximumReconnects ?? 6;
  let reconnects = 0;
  while (true) {
    try {
      options.onConnectionState?.(reconnects === 0 ? "connecting" : "reconnecting");
      const headers = { accept: "text/event-stream" };
      if (state.lastEventId) headers["last-event-id"] = state.lastEventId;
      const response = await fetch(
        "/v1/sessions/" + encodeURIComponent(sessionId) + "/runs/" + encodeURIComponent(runId) + "/events",
        { method: "GET", headers: headers, signal: options.signal },
      );
      if (!response.ok) throw await responseError(response);
      options.onConnectionState?.("connected");
      return await readRunStream(response, sessionId, runId, state, options);
    } catch (error) {
      if (error instanceof AgentStreamServerError || error instanceof AgentStreamProtocolError) throw error;
      if (options.signal?.aborted) throw error;
      reconnects += 1;
      if (reconnects > maximumReconnects) {
        const failure = new AgentStreamTransportError("Agent 连接多次中断，运行可能仍在服务端继续。");
        failure.runId = runId;
        failure.streamState = state;
        throw failure;
      }
      options.onConnectionState?.("reconnecting");
      await waitForRetry(Math.min(250 * (2 ** (reconnects - 1)), 5_000), options.signal);
    }
  }
}

async function streamAgentMessage(sessionId, message, options = {}) {
  const requestId = options.requestId || newRunRequestId();
  const run = await startAgentRun(sessionId, message, requestId, options);
  options.onRunStarted?.(run, requestId);
  const completion = await streamRunEvents(sessionId, run.runId, options);
  return { ...completion, requestId: requestId };
}

export const agentApi = {
  createSession: function (videoTaskId) {
    return api("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(videoTaskId ? { videoTaskId: videoTaskId } : {}),
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
  abortSession: function (sessionId) {
    return api("/v1/sessions/" + encodeURIComponent(sessionId) + "/abort", { method: "POST" });
  },
  abortRun: function (sessionId, runId) {
    return api(
      "/v1/sessions/" + encodeURIComponent(sessionId) + "/runs/" + encodeURIComponent(runId) + "/abort",
      { method: "POST" },
    );
  },
  startRun: startAgentRun,
  streamRunEvents: streamRunEvents,
  streamMessage: streamAgentMessage,
};
