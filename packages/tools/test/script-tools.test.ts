import assert from "node:assert/strict";
import test from "node:test";

import { AgentActionCardSchema } from "@firefly/schemas";
import { Value } from "typebox/value";

import { createScriptProposalTools } from "../src/script-tools.ts";

test("script proposal tool returns one strict task-bound action card without persisting", async () => {
  let revisionReads = 0;
  const [tool] = createScriptProposalTools({
    videoTaskId: "task_script_1",
    async currentRevision() {
      revisionReads += 1;
      return 7;
    },
  });
  assert.ok(tool);
  const result = await tool.execute(
    "tool_call_script_1",
    { script: "00–05s｜画面：车辆驶出社区。\n旁白：周末，从从容出发。" },
  );
  assert.equal(revisionReads, 1);
  assert.equal(Value.Check(AgentActionCardSchema, result.details), true);
  assert.deepEqual(result.details, {
    schemaVersion: 1,
    kind: "agent_action_card",
    videoTaskId: "task_script_1",
    action: "generate_script",
    label: "生成脚本草稿",
    summary: "生成一条遵守已确认策略、车型事实和任务时长的脚本草稿，点击后才会写入任务并进入人工确认。",
    expectedRevision: 7,
    cost: { kind: "free" },
    payload: {
      schemaVersion: 1,
      script: "00–05s｜画面：车辆驶出社区。\n旁白：周末，从从容出发。",
    },
  });
});
