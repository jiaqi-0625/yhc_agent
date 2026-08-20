import type { Claim } from "@firefly/schemas";

export function hasUsableVehicleFacts(
  input: Readonly<{
    fixedClaims: readonly Readonly<Claim>[];
    optionalClaims: readonly Readonly<Claim>[];
  }>,
): boolean {
  const claims = [...input.fixedClaims, ...input.optionalClaims];
  return claims.length >= 1 &&
    claims.length <= 20 &&
    new Set(claims.map((claim) => claim.id)).size === claims.length &&
    input.fixedClaims.every((claim) => claim.kind === "fixed") &&
    input.optionalClaims.every((claim) => claim.kind === "extended");
}
