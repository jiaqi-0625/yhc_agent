import assert from "node:assert/strict";
import test from "node:test";

import { storyboardScriptPlan } from "../src/storyboard-script-plan.ts";

test("storyboard plan preserves confirmed script time ranges and shot content", () => {
  const script = `
| 时间 | 画面（9:16 竖屏） | 旁白/字幕 |
| 0–4 秒 | 车身前脸与侧面线条特写，过渡至后排空间展示 | 采用大五座布局，后排腿部空间宽裕，后排可放倒拓展装载空间。 |
| 4–8 秒 | 内饰细节与整车侧面展示 | 纯电版 CLTC 续航 660km，电池容量 81.9kWh。 |
| 8–10 秒 | 整车收尾定格，品牌与车型名称呈现 | 零跑 C10 焕新版。 |
`;
  const plan = storyboardScriptPlan(script, 10);
  assert.deepEqual(plan.map((shot) => [shot.startSeconds, shot.endSeconds, shot.durationSeconds]), [
    [0, 4, 4], [4, 8, 4], [8, 10, 2],
  ]);
  assert.match(plan[0]!.scriptExcerpt, /后排空间展示/u);
  assert.equal(plan[0]!.purpose, "空间与装载展示");
  assert.match(plan[1]!.scriptExcerpt, /CLTC 续航 660km/u);
  assert.equal(plan[1]!.purpose, "续航与能源卖点");
  assert.equal(plan[2]!.purpose, "品牌收束");
});

test("storyboard plan parses the persisted bracketed script format and excludes compliance notes", () => {
  const script = `【脚本】零跑 C10 焕新版 · 10 秒常规口播（9:16 竖屏）
依据：已确认策略（策略草稿版本 1，human_confirmation）+ 锁定车型快照；未提前选取人物或场景素材。
【0–4 秒】
画面：车身前脸与侧面线条特写，过渡至后排空间展示，画面留白供字幕展示。
旁白：采用大五座布局，后排腿部空间宽裕，后排可放倒拓展装载空间。
字幕：大五座 · 后排腿部空间宽裕 · 可放倒拓展装载
【4–8 秒】
画面：车辆内饰细节与整车侧面展示。
旁白：纯电版 CLTC 续航 660km，电池容量 81.9kWh。
字幕：纯电版 CLTC 续航 660km · 电池容量 81.9kWh
【8–10 秒】
画面：整车收尾定格，品牌与车型名称呈现。
旁白：零跑 C10 焕新版。
字幕：零跑 C10 焕新版
备注（表述合规说明）：
1. 不得扩展为绝对化表述。`;

  const plan = storyboardScriptPlan(script, 10);
  assert.deepEqual(plan.map((shot) => shot.durationSeconds), [4, 4, 2]);
  assert.equal(plan[0]!.purpose, "空间与装载展示");
  assert.equal(plan[1]!.purpose, "续航与能源卖点");
  assert.equal(plan[2]!.purpose, "品牌收束");
  assert.match(plan[2]!.scriptExcerpt, /整车收尾定格/u);
  assert.doesNotMatch(plan[2]!.scriptExcerpt, /绝对化/u);
});

test("storyboard plan derives presenter narration without changing timing or confirmed copy", () => {
  const script = `【0–4 秒】
画面：车身前脸与后排空间展示。
旁白：采用大五座布局，后排腿部空间宽裕。
【4–8 秒】
画面：仪表与内饰。
旁白：纯电版 CLTC 续航 660km。
【8–10 秒】
画面：整车收尾定格。
旁白：零跑 C10 焕新版。`;

  const plan = storyboardScriptPlan(script, 10, { presenterNarration: true });

  assert.deepEqual(plan.map((shot) => shot.durationSeconds), [4, 4, 2]);
  assert.ok(plan.every((shot) => shot.purpose.startsWith("主播口播 · ")));
  assert.ok(plan.every((shot) => /已选主播正面出镜口播本段旁白/u.test(shot.scriptExcerpt)));
  assert.match(plan[0]!.scriptExcerpt, /采用大五座布局/u);
  assert.match(plan[1]!.scriptExcerpt, /CLTC 续航 660km/u);
  assert.match(plan[2]!.scriptExcerpt, /零跑 C10 焕新版/u);
});

test("storyboard plan fails visibly to a bounded plan when script timing cannot be parsed", () => {
  const plan = storyboardScriptPlan("只有未分段的脚本文本。", 10);
  assert.deepEqual(plan.map((shot) => shot.durationSeconds), [4, 3, 3]);
  assert.ok(plan.every((shot) => /未提供可解析的时间段/u.test(shot.scriptExcerpt)));
});
