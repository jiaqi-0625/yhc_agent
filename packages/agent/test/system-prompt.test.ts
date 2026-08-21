import assert from "node:assert/strict";
import test from "node:test";

import { ADVERTISING_AGENT_SYSTEM_PROMPT } from "../src/system-prompt.ts";

test("Agent distinguishes its execution boundary from delivery-stage video availability", () => {
  assert.match(ADVERTISING_AGENT_SYSTEM_PROMPT, /交付阶段不代表视频生成被禁止/u);
  assert.match(ADVERTISING_AGENT_SYSTEM_PROMPT, /不能把“Agent 不能执行”表述成“项目不能生成”/u);
  assert.match(ADVERTISING_AGENT_SYSTEM_PROMPT, /“制作”模块/u);
});

test("Agent treats script generation as a stage-scoped capability instead of a permanent session limitation", () => {
  assert.match(ADVERTISING_AGENT_SYSTEM_PROMPT, /业务能力会随服务端权威任务阶段动态装配/u);
  assert.match(ADVERTISING_AGENT_SYSTEM_PROMPT, /不得把“当前阶段尚未开放脚本生成”表述成“本次会话永久没有脚本生成能力”/u);
  assert.match(ADVERTISING_AGENT_SYSTEM_PROMPT, /已经进入脚本阶段.*必须使用本次运行已注册的脚本生成提案能力/u);
});
