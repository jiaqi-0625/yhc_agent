import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { LocalAgentRuntime, type LocalRuntimeEvent } from "@firefly/agent";

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function printEvent(event: LocalRuntimeEvent): void {
  if (event.type === "text_delta") stdout.write(event.delta);
  if (event.type === "tool_start") stdout.write(`\n[tool:start] ${event.toolName}\n`);
  if (event.type === "tool_end") stdout.write(`\n[tool:end] ${event.toolName} error=${String(event.isError)}\n`);
}

const runtime = new LocalAgentRuntime();
async function resolveInitialSessionId(): Promise<string> {
  const requested = argumentValue("session");
  if (!requested) return (await runtime.createSession()).id;
  const existing = await runtime.getSession(requested);
  if (!existing) await runtime.createSession(requested);
  return requested;
}
let sessionId: string = await resolveInitialSessionId();

const config = runtime.publicConfig();
stdout.write(`Firefly Local Agent\nprovider=${config.provider} model=${config.modelId}\nsession=${sessionId}\n`);
stdout.write("commands: /status /reset /new /exit\n\n");

const readline = createInterface({ input: stdin, output: stdout });
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) return;
  void runtime.abortSession(sessionId).then((aborted) => {
    if (aborted) stdout.write("\n[已请求取消当前生成]\n");
    else stopping = true;
  });
});

while (!stopping) {
  const input = (await readline.question("you> ")).trim();
  if (!input) continue;
  if (input === "/exit") break;
  if (input === "/status") {
    stdout.write(`${JSON.stringify(await runtime.getSession(sessionId), null, 2)}\n`);
    continue;
  }
  if (input === "/reset") {
    await runtime.resetSession(sessionId);
    stdout.write("session reset\n");
    continue;
  }
  if (input === "/new") {
    sessionId = (await runtime.createSession()).id;
    stdout.write(`session=${sessionId}\n`);
    continue;
  }

  stdout.write("agent> ");
  const result = await runtime.prompt(sessionId, input, printEvent);
  stdout.write(`\n[stop=${result.stopReason ?? "unknown"}]\n\n`);
}

readline.close();
