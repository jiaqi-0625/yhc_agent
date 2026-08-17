import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";

const emptyUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function lastUserText(context: Context): string {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function messageFor(model: Model<Api>, content: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: content ? [{ type: "text", text: content }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage,
    stopReason,
    timestamp: Date.now(),
  };
}

export const mockStreamFn: StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (options?.signal?.aborted) {
      const aborted = { ...messageFor(model, "", "aborted"), errorMessage: "Request aborted." };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      return;
    }

    const input = lastUserText(context).trim();
    const text = input
      ? `本地 Mock Agent 已收到：${input}\n\n当前模型链路、会话和事件框架运行正常；尚未装配具体广告工作流工具。`
      : "本地 Mock Agent 运行正常；尚未装配具体广告工作流工具。";
    const start = messageFor(model, "", "pending");
    const partial = messageFor(model, text, "pending");
    const completed = messageFor(model, text, "stop");
    stream.push({ type: "start", partial: start });
    stream.push({ type: "text_start", contentIndex: 0, partial: start });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
    stream.push({ type: "done", reason: "stop", message: completed });
  });
  return stream;
};
