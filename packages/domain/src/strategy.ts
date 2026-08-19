import type {
  Claim,
  Strategy,
  StrategyItem,
  StrategyValidationIssue,
  StrategyValidationResult,
  VehicleSnapshot,
} from "@firefly/schemas";

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/[\s，。！？、；：,.!?;:]/gu, "").toLocaleLowerCase("zh-CN");
}

function issue(
  code: string,
  message: string,
  details: { itemId?: string; claimId?: string } = {},
): StrategyValidationIssue {
  return { code: `AIC-STRATEGY-${code}`, severity: "error", message, ...details };
}

export function validateStrategy(
  strategy: Readonly<Pick<Strategy, "items">>,
  snapshot: Readonly<VehicleSnapshot>,
): StrategyValidationResult {
  const issues: StrategyValidationIssue[] = [];
  const claims = new Map<string, Claim>(
    [...snapshot.fixedClaims, ...snapshot.optionalClaims].map((claim) => [claim.id, claim]),
  );
  const seenClaims = new Set<string>();
  const seenOrders = new Set<number>();

  for (const item of strategy.items) {
    const claim = claims.get(item.claimId);
    if (!claim) {
      issues.push(issue("UNKNOWN_CLAIM", `策略项“${item.title}”没有对应的车型事实。`, { itemId: item.id }));
      continue;
    }
    if (seenClaims.has(item.claimId)) {
      issues.push(issue("DUPLICATE_CLAIM", `卖点“${claim.name}”被重复使用。`, { itemId: item.id, claimId: claim.id }));
    }
    seenClaims.add(item.claimId);
    if (seenOrders.has(item.order)) {
      issues.push(issue("DUPLICATE_ORDER", `策略排序 ${item.order} 重复。`, { itemId: item.id }));
    }
    seenOrders.add(item.order);
    if (item.kind !== claim.kind) {
      issues.push(issue("KIND_MISMATCH", `卖点“${claim.name}”的固定/扩展类型被改变。`, { itemId: item.id, claimId: claim.id }));
    }
    if (!item.evidence) {
      issues.push(issue("EVIDENCE_REQUIRED", `卖点“${claim.name}”缺少事实依据。`, { itemId: item.id, claimId: claim.id }));
    }
    if (!claim.mayRephrase && normalize(item.statement) !== normalize(claim.statement)) {
      issues.push(issue("FACT_CHANGED", `卖点“${claim.name}”不允许改写。`, { itemId: item.id, claimId: claim.id }));
    }
    const prohibited = snapshot.prohibitedClaims.find((term) => normalize(item.statement).includes(normalize(term)));
    if (prohibited) {
      issues.push(issue("PROHIBITED_EXPRESSION", `策略项包含禁用表达“${prohibited}”。`, { itemId: item.id }));
    }
  }

  for (const claim of snapshot.fixedClaims) {
    if (!seenClaims.has(claim.id)) {
      issues.push(issue("FIXED_CLAIM_MISSING", `固定卖点“${claim.name}”不得遗漏。`, { claimId: claim.id }));
    }
  }

  return { valid: issues.length === 0, issues };
}

export function preserveLockedStrategyItems(
  generatedItems: readonly StrategyItem[],
  previousItems: readonly StrategyItem[],
): StrategyItem[] {
  const lockedByClaim = new Map(previousItems.filter((item) => item.locked).map((item) => [item.claimId, item]));
  return generatedItems.map((item) => structuredClone(lockedByClaim.get(item.claimId) ?? item));
}
