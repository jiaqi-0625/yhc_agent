import type {
  GenerateStrategyRequest,
  Strategy,
  StrategyItem,
  StrategyValidationResult,
  VehicleSnapshot,
} from "@firefly/schemas";
import { preserveLockedStrategyItems, validateStrategy } from "@firefly/domain";

export interface StrategyGenerationInput extends GenerateStrategyRequest {
  workId: string;
  snapshot: VehicleSnapshot;
  version: number;
  actorId: string;
  previousStrategy?: Strategy;
  now?: string;
}

function generatedItem(
  claim: VehicleSnapshot["fixedClaims"][number],
  workId: string,
  version: number,
  order: number,
): StrategyItem {
  return {
    id: `strategy_item_${version}_${order}_${workId}`,
    claimId: claim.id,
    kind: claim.kind,
    title: claim.name,
    statement: claim.statement,
    rationale:
      claim.kind === "fixed"
        ? "官方固定卖点，作为本条广告的核心事实表达。"
        : "基于车型快照中的可选卖点，用于补充目标人群的使用价值。",
    order,
    locked: false,
    ...(claim.evidence === undefined ? {} : { evidence: structuredClone(claim.evidence) }),
  };
}

export function generateDeterministicStrategy(input: StrategyGenerationInput): Strategy {
  const now = input.now ?? new Date().toISOString();
  const candidateClaims = [...input.snapshot.fixedClaims, ...input.snapshot.optionalClaims].slice(0, 6);
  const generated = candidateClaims.map((claim, index) => generatedItem(claim, input.workId, input.version, index + 1));
  const items = preserveLockedStrategyItems(generated, input.previousStrategy?.items ?? []).map((item, index) => ({
    ...item,
    order: index + 1,
  }));
  return {
    id: `strategy_${input.version}_${input.workId}`,
    workId: input.workId,
    vehicleSnapshotId: input.snapshot.id,
    version: input.version,
    status: "draft",
    audience: input.audience,
    theme: input.theme,
    items,
    model: "mock-strategy-v1",
    templateVersion: "strategy-template-v1",
    createdAt: now,
    createdBy: input.actorId,
    updatedAt: now,
  };
}

export interface StrategyWorkflowPort {
  generate(request: GenerateStrategyRequest): Promise<{ strategy: Strategy; validation: StrategyValidationResult }>;
  validate(): Promise<StrategyValidationResult>;
  requestApproval(expectedRevision: number): Promise<{ strategy: Strategy; revision: number }>;
}

export { validateStrategy };
