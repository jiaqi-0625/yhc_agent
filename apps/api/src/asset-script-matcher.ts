import type { AssetCategory, AssetReference } from "@firefly/schemas";

export interface AssetScriptCandidate {
  readonly reference: AssetReference;
  readonly displayName: string;
  readonly description?: string;
  readonly tags: readonly string[];
}

export interface ScriptDrivenAssetMatch {
  readonly reference: AssetReference;
  readonly reason: string;
}

interface VisualRequirement {
  readonly label: string;
  readonly scriptTerms: readonly string[];
  readonly assetTerms: readonly string[];
}

const vehicleRequirements: readonly VisualRequirement[] = [
  {
    label: "后备箱与装载画面",
    scriptTerms: ["后备箱", "装载", "行李", "露营装备", "座椅放倒"],
    assetTerms: ["后排放倒后备箱", "rear-seat-folded", "后备箱", "trunk"],
  },
  {
    label: "后排乘坐空间画面",
    scriptTerms: ["后排", "腿部空间", "大五座", "家人落座", "孩子"],
    assetTerms: ["后排乘坐空间", "后排座椅全景", "rear-seat", "wide-view"],
  },
  {
    label: "座椅与内饰画面",
    scriptTerms: ["座椅", "内饰", "面料", "车内", "安静", "nvh"],
    assetTerms: ["前排座椅", "座舱全景", "驾驶舱", "front-seat", "cockpit"],
  },
  {
    label: "仪表与续航信息画面",
    scriptTerms: ["仪表", "续航里程", "续航", "cltc"],
    assetTerms: ["仪表屏", "instrument-display"],
  },
  {
    label: "充电与补能画面",
    scriptTerms: ["充电", "补能", "快充", "充电口"],
    assetTerms: ["充电口", "charging-port"],
  },
  {
    label: "车灯细节画面",
    scriptTerms: ["车灯", "灯带", "前灯", "大灯"],
    assetTerms: ["前组合灯", "前灯带", "headlamp", "light-bar"],
  },
  {
    label: "车辆行驶与收尾画面",
    scriptTerms: ["车辆", "行驶", "公路", "驶向", "远方", "品牌尾版"],
    assetTerms: ["整车左前45度", "整车右前45度", "整车左侧面", "full-vehicle"],
  },
];

function normalized(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replaceAll(/\s+/gu, "");
}

function itemText(item: Readonly<AssetScriptCandidate>): string {
  return normalized([
    item.displayName,
    item.description ?? "",
    ...item.tags,
  ].join(" "));
}

function requirementScore(item: Readonly<AssetScriptCandidate>, requirement: VisualRequirement): number {
  const text = itemText(item);
  return requirement.assetTerms.reduce((score, term, index) =>
    score + (text.includes(normalized(term)) ? requirement.assetTerms.length - index : 0), 0);
}

function exactIdentity(reference: Readonly<AssetReference>): string {
  return reference.source === "company_catalog"
    ? `${reference.source}:${reference.sourceProvider}:${reference.assetId}:${reference.version}:${reference.category}`
    : `${reference.source}:${reference.batchProjectId}:${reference.assetId}:${reference.version}:${reference.category}`;
}

function matchingRequirements(script: string): readonly VisualRequirement[] {
  const text = normalized(script);
  const matched = vehicleRequirements.filter((requirement) =>
    requirement.scriptTerms.some((term) => text.includes(normalized(term)))
  );
  return matched.length > 0 ? matched : [vehicleRequirements.at(-1)!];
}

function selectVehicleAssets(
  items: readonly AssetScriptCandidate[],
  script: string,
  maximum: number,
): ScriptDrivenAssetMatch[] {
  const vehicles = items.filter((item) => item.reference.category === "vehicle");
  const selected = new Set<string>();
  const matches: ScriptDrivenAssetMatch[] = [];
  for (const requirement of matchingRequirements(script)) {
    const ranked = vehicles
      .map((item, index) => ({ item, index, score: requirementScore(item, requirement) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const candidate = ranked.find(({ item }) => !selected.has(exactIdentity(item.reference)))?.item;
    if (!candidate) continue;
    selected.add(exactIdentity(candidate.reference));
    matches.push({
      reference: structuredClone(candidate.reference),
      reason: `匹配已确认脚本中的“${requirement.label}”。`,
    });
    if (matches.length >= maximum) break;
  }
  if (matches.length === 0 && vehicles[0]) {
    matches.push({
      reference: structuredClone(vehicles[0].reference),
      reason: "作为脚本所需的基础车型画面。",
    });
  }
  return matches;
}

function characterNgrams(value: string): Set<string> {
  const compact = normalized(value).replaceAll(/[^\p{Script=Han}a-z0-9]+/gu, "");
  const grams = new Set<string>();
  for (const size of [4, 3, 2]) {
    for (let index = 0; index + size <= compact.length; index += 1) {
      grams.add(compact.slice(index, index + size));
    }
  }
  return grams;
}

function reusableScore(item: Readonly<AssetScriptCandidate>, script: string): number {
  const scriptGrams = characterNgrams(script);
  let score = 0;
  for (const gram of characterNgrams(itemText(item))) {
    if (scriptGrams.has(gram)) score += gram.length;
  }
  return score;
}

function selectReusableAsset(
  items: readonly AssetScriptCandidate[],
  script: string,
  category: Extract<AssetCategory, "person" | "scene">,
): ScriptDrivenAssetMatch[] {
  const normalizedScript = normalized(script);
  const requiredTerms = category === "person"
    ? [
        "人物口播", "真人口播", "主播", "主持人", "出镜", "讲解员", "人物讲解",
        "一家三口", "一家人", "家人落座", "父母", "孩子",
      ]
    : ["清晨", "露营", "城市道路", "公路", "社区", "湖边", "夜间", "户外场景"];
  if (!requiredTerms.some((term) => normalizedScript.includes(normalized(term)))) return [];
  const ranked = items
    .map((item, index) => ({ item, index, score: reusableScore(item, script) }))
    .filter(({ item }) => item.reference.category === category)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked.find((candidate) => candidate.score > 0)?.item;
  return selected
    ? [{
        reference: structuredClone(selected.reference),
        reason: `根据已确认脚本与${category === "person" ? "人物" : "场景"}素材描述的相关度推荐。`,
      }]
    : [];
}

export function matchAssetsToConfirmedScript(
  items: readonly AssetScriptCandidate[],
  script: string,
  options: Readonly<{ maximumVehicleAssets?: number }> = {},
): readonly ScriptDrivenAssetMatch[] {
  const maximumVehicleAssets = options.maximumVehicleAssets ?? 6;
  return [
    ...selectVehicleAssets(items, script, maximumVehicleAssets),
    ...selectReusableAsset(items, script, "person"),
    ...selectReusableAsset(items, script, "scene"),
  ];
}
