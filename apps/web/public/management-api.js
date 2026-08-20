import { api } from "./api-client.js";

const IdentifierPattern = /^[A-Za-z0-9_-]{1,128}$/u;

function validatedIdentifier(value, label) {
  if (typeof value !== "string" || !IdentifierPattern.test(value)) {
    throw new TypeError(label + "必须是有效的标识符。");
  }
  return value;
}

function encodedIdentifier(value, label) {
  return encodeURIComponent(validatedIdentifier(value, label));
}

function jsonOptions(method, body) {
  return {
    method: method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function optionalField(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function claimEvidenceBody(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return evidence;
  const body = {
    sourceName: evidence.sourceName,
    sourceReference: evidence.sourceReference,
    effectiveFrom: evidence.effectiveFrom,
  };
  optionalField(body, "effectiveUntil", evidence.effectiveUntil);
  return body;
}

function claimBody(claim) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return claim;
  const body = {
    id: claim.id,
    kind: claim.kind,
    name: claim.name,
    statement: claim.statement,
    requiredInVoiceover: claim.requiredInVoiceover,
    requiredInSubtitle: claim.requiredInSubtitle,
    mayRephrase: claim.mayRephrase,
    riskNotes: claim.riskNotes,
  };
  optionalField(body, "value", claim.value);
  optionalField(body, "unit", claim.unit);
  if (claim.evidence !== undefined) body.evidence = claimEvidenceBody(claim.evidence);
  return body;
}

function claimsBody(claims) {
  return Array.isArray(claims) ? claims.map(claimBody) : claims;
}

function vehicleFactsBody(input) {
  return {
    status: input.status,
    series: input.series,
    modelYear: input.modelYear,
    trim: input.trim,
    parameters: input.parameters,
    fixedClaims: claimsBody(input.fixedClaims),
    optionalClaims: claimsBody(input.optionalClaims),
    prohibitedClaims: input.prohibitedClaims,
  };
}

function assetReferenceBody(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return reference;
  const body = {
    assetId: reference.assetId,
    version: reference.version,
    source: reference.source,
    sourceProvider: reference.sourceProvider,
    category: reference.category,
  };
  if (reference.category === "vehicle") body.vehicleId = reference.vehicleId;
  return body;
}

function accessScopeBody(access) {
  if (!access || typeof access !== "object" || Array.isArray(access)) return access;
  const body = {
    kind: access.kind,
    brandId: access.brandId,
  };
  if (access.kind === "vehicle_project") body.vehicleId = access.vehicleId;
  return body;
}

function appendStringValues(parameters, key, value) {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  for (const item of values) {
    if (typeof item === "string") parameters.append(key, item);
  }
}

function appendOptionalString(parameters, key, value) {
  if (typeof value === "string") parameters.set(key, value);
}

function companyAssetQuery(query) {
  const parameters = new URLSearchParams();
  appendStringValues(parameters, "category", query.categories ?? query.category);
  if (query.brandId !== undefined) {
    parameters.set("brandId", validatedIdentifier(query.brandId, "品牌 ID"));
  }
  if (query.vehicleId !== undefined) {
    parameters.set("vehicleId", validatedIdentifier(query.vehicleId, "车型 ID"));
  }
  appendOptionalString(parameters, "searchText", query.searchText);
  appendStringValues(parameters, "tag", query.tags ?? query.tag);
  appendOptionalString(parameters, "cursor", query.cursor);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  const encoded = parameters.toString();
  return encoded ? "?" + encoded : "";
}

function accessGrantQuery(query) {
  const parameters = new URLSearchParams();
  if (query.accountId !== undefined) {
    parameters.set("accountId", validatedIdentifier(query.accountId, "账号 ID"));
  }
  if (query.brandId !== undefined) {
    parameters.set("brandId", validatedIdentifier(query.brandId, "品牌 ID"));
  }
  const encoded = parameters.toString();
  return encoded ? "?" + encoded : "";
}

export const managementApi = {
  getOverview: function () {
    return api("/v1/admin/overview");
  },

  listBrands: function () {
    return api("/v1/admin/brands");
  },

  createBrand: function (input) {
    return api("/v1/admin/brands", jsonOptions("POST", {
      name: input.name,
      defaultVisualStylePresetId: input.defaultVisualStylePresetId,
    }));
  },

  updateBrand: function (brandId, input) {
    const body = { expectedRevision: input.expectedRevision };
    optionalField(body, "name", input.name);
    optionalField(body, "defaultVisualStylePresetId", input.defaultVisualStylePresetId);
    optionalField(body, "status", input.status);
    return api(
      "/v1/admin/brands/" + encodedIdentifier(brandId, "品牌 ID"),
      jsonOptions("PATCH", body),
    );
  },

  listVehicles: function (brandId) {
    return api(
      "/v1/admin/brands/" + encodedIdentifier(brandId, "品牌 ID") + "/vehicles",
    );
  },

  createVehicle: function (brandId, input) {
    return api(
      "/v1/admin/brands/" + encodedIdentifier(brandId, "品牌 ID") + "/vehicles",
      jsonOptions("POST", vehicleFactsBody(input)),
    );
  },

  listVehicleVersions: function (vehicleId) {
    return api(
      "/v1/admin/vehicles/" + encodedIdentifier(vehicleId, "车型 ID") + "/versions",
    );
  },

  createVehicleFactVersion: function (vehicleId, input) {
    return api(
      "/v1/admin/vehicles/" + encodedIdentifier(vehicleId, "车型 ID") + "/versions",
      jsonOptions("POST", {
        expectedVersion: input.expectedVersion,
        ...vehicleFactsBody(input),
      }),
    );
  },

  searchCompanyAssets: function (query = {}) {
    return api("/v1/admin/company-assets" + companyAssetQuery(query));
  },

  getVehicleAssetAssociations: function (vehicleId) {
    return api(
      "/v1/admin/vehicles/" + encodedIdentifier(vehicleId, "车型 ID") +
      "/asset-associations",
    );
  },

  replaceVehicleAssetAssociations: function (vehicleId, input) {
    return api(
      "/v1/admin/vehicles/" + encodedIdentifier(vehicleId, "车型 ID") +
      "/asset-associations",
      jsonOptions("PUT", {
        expectedRevision: input.expectedRevision,
        assets: Array.isArray(input.assets) ? input.assets.map(assetReferenceBody) : input.assets,
      }),
    );
  },

  listAccounts: function () {
    return api("/v1/admin/accounts");
  },

  listAccessGrants: function (query = {}) {
    return api("/v1/admin/access-grants" + accessGrantQuery(query));
  },

  createAccessGrant: function (input) {
    return api("/v1/admin/access-grants", jsonOptions("POST", {
      accountId: input.accountId,
      access: accessScopeBody(input.access),
    }));
  },

  updateAccessGrant: function (grantId, input) {
    return api(
      "/v1/admin/access-grants/" + encodedIdentifier(grantId, "授权 ID"),
      jsonOptions("PATCH", {
        expectedRevision: input.expectedRevision,
        status: input.status,
      }),
    );
  },

  getAccountBudget: function (accountId) {
    return api(
      "/v1/admin/accounts/" + encodedIdentifier(accountId, "账号 ID") + "/budget",
    );
  },

  createAccountBudget: function (accountId, input) {
    return api(
      "/v1/admin/accounts/" + encodedIdentifier(accountId, "账号 ID") + "/budget",
      jsonOptions("POST", {
        currency: input.currency,
        limitAmountMinor: input.limitAmountMinor,
      }),
    );
  },

  updateAccountBudget: function (accountId, input) {
    return api(
      "/v1/admin/accounts/" + encodedIdentifier(accountId, "账号 ID") + "/budget",
      jsonOptions("PATCH", {
        expectedRevision: input.expectedRevision,
        limitAmountMinor: input.limitAmountMinor,
      }),
    );
  },
};
