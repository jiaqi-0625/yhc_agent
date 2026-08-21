export interface StoryboardScriptShot {
  readonly shotIndex: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationSeconds: number;
  readonly purpose: string;
  readonly scriptExcerpt: string;
}

export interface StoryboardScriptPlanOptions {
  readonly presenterNarration?: boolean;
}

const fallbackDurations: Readonly<Record<number, readonly number[]>> = Object.freeze({
  10: [4, 3, 3],
  15: [3, 3, 3, 3, 3],
  30: [5, 5, 5, 5, 5, 5],
});

function cleanExcerpt(value: string): string {
  const shotOnly = value.split(
    /\n\s*(?:#+\s*)?(?:备注|表述合规说明|合规说明)(?:[（(][^)\n）]*[）)])?\s*[：:]?/u,
    1,
  )[0] ?? value;
  return shotOnly
    .replaceAll(/[*_#`]+/gu, "")
    .replaceAll(/\|/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .replace(/^[\s:：,，;；-]+/u, "")
    .trim()
    .slice(0, 2000);
}

function purpose(excerpt: string, index: number, count: number): string {
  if (/(?:品牌|车型名称|定格|收尾|尾版)/u.test(excerpt) || index === count - 1) return "品牌收束";
  if (/(?:后排|空间|座椅|放倒|装载|后备箱)/u.test(excerpt)) return "空间与装载展示";
  if (/(?:续航|CLTC|电池|仪表|充电|补能)/iu.test(excerpt)) return "续航与能源卖点";
  if (/(?:内饰|座舱|静谧|音响|屏幕)/u.test(excerpt)) return "座舱与舒适卖点";
  if (/(?:前脸|侧面|外观|车身|行驶)/u.test(excerpt)) return "车型外观展示";
  return index === 0 ? "脚本开场" : "脚本卖点演绎";
}

function fallbackPlan(durationSeconds: number): readonly StoryboardScriptShot[] {
  const durations = fallbackDurations[durationSeconds];
  if (!durations) throw new Error("The task duration is not supported by the storyboard plan.");
  let startSeconds = 0;
  return durations.map((duration, shotIndex) => {
    const endSeconds = startSeconds + duration;
    const shot: StoryboardScriptShot = {
      shotIndex,
      startSeconds,
      endSeconds,
      durationSeconds: duration,
      purpose: shotIndex === 0 ? "脚本开场" : shotIndex === durations.length - 1 ? "品牌收束" : "脚本卖点演绎",
      scriptExcerpt: "脚本未提供可解析的时间段，请在确认分镜前复核本镜头内容。",
    };
    startSeconds = endSeconds;
    return shot;
  });
}

function adaptPresenterNarration(
  shots: readonly StoryboardScriptShot[],
  enabled: boolean | undefined,
): readonly StoryboardScriptShot[] {
  if (!enabled) return shots;
  return shots.map((shot) => ({
    ...shot,
    purpose: `主播口播 · ${shot.purpose}`,
    scriptExcerpt: `人物：已选主播正面出镜口播本段旁白；车型画面按本段要求穿插展示。 ${shot.scriptExcerpt}`,
  }));
}

export function storyboardScriptPlan(
  script: string,
  durationSeconds: number,
  options: Readonly<StoryboardScriptPlanOptions> = {},
): readonly StoryboardScriptShot[] {
  const matches = [...script.matchAll(
    /(?:^|[\n|])\s*(?:【|\[)?\s*(\d{1,3})\s*(?:–|—|-|~|至)\s*(\d{1,3})\s*(?:秒|s)\s*(?:】|\])?/gimu,
  )];
  if (matches.length < 2) {
    return adaptPresenterNarration(fallbackPlan(durationSeconds), options.presenterNarration);
  }
  const candidates = matches.map((match, shotIndex) => {
    const startSeconds = Number(match[1]);
    const endSeconds = Number(match[2]);
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = matches[shotIndex + 1]?.index ?? script.length;
    return {
      shotIndex,
      startSeconds,
      endSeconds,
      durationSeconds: endSeconds - startSeconds,
      scriptExcerpt: cleanExcerpt(script.slice(contentStart, contentEnd)),
    };
  });
  const valid = candidates.length <= 12
    && candidates[0]?.startSeconds === 0
    && candidates.at(-1)?.endSeconds === durationSeconds
    && candidates.every((shot, index) =>
      Number.isSafeInteger(shot.startSeconds)
      && Number.isSafeInteger(shot.endSeconds)
      && shot.durationSeconds > 0
      && shot.scriptExcerpt.length > 0
      && (index === 0 || candidates[index - 1]!.endSeconds === shot.startSeconds));
  if (!valid) {
    return adaptPresenterNarration(fallbackPlan(durationSeconds), options.presenterNarration);
  }
  return adaptPresenterNarration(candidates.map((shot) => ({
      ...shot,
      purpose: purpose(shot.scriptExcerpt, shot.shotIndex, candidates.length),
    })), options.presenterNarration);
}

export function presenterProductionScript(shots: readonly StoryboardScriptShot[]): string {
  return shots.map((shot) => [
    `【${shot.startSeconds}–${shot.endSeconds} 秒】`,
    shot.scriptExcerpt,
  ].join("\n")).join("\n");
}
