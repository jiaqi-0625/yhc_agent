import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CreateAccountBudgetRequestSchema,
  CreateBrandRequestSchema,
  CreateVehicleFactVersionRequestSchema,
  CreateVehicleRequestSchema,
  CreateWorkspaceAccessGrantRequestSchema,
  ReplaceVehicleAssetAssociationsRequestSchema,
  UpdateAccountBudgetRequestSchema,
  UpdateBrandRequestSchema,
  UpdateWorkspaceAccessGrantRequestSchema,
  type CreateAccountBudgetRequest,
  type AssetCategory,
  type CreateBrandRequest,
  type CreateVehicleFactVersionRequest,
  type CreateVehicleRequest,
  type CreateWorkspaceAccessGrantRequest,
  type ReplaceVehicleAssetAssociationsRequest,
  type UpdateAccountBudgetRequest,
  type UpdateBrandRequest,
  type UpdateWorkspaceAccessGrantRequest,
} from "@firefly/schemas";

import type { AccountBudgetAdministrationView } from "./account-budget-runtime.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import { readJson, sendJson, validateBody } from "./http-boundary.ts";
import type { WorkspaceAdminRuntime } from "./workspace-admin-runtime.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

const IdentifierPath = "([A-Za-z0-9_-]{1,128})";

function matchPath(pathname: string, pattern: string): RegExpExecArray | null {
  return new RegExp(`^${pattern}$`, "u").exec(pathname);
}

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^[0-9]+$/u.test(value)) return Number.NaN;
  return Number.parseInt(value, 10);
}

function assertQueryKeys(url: URL, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key)) {
      throw new BusinessRuntimeError(
        "AIC-API-QUERY_INVALID",
        `Unsupported query parameter '${key}'.`,
        400,
      );
    }
  }
}

function publicBudget(view: AccountBudgetAdministrationView | undefined) {
  if (!view) return undefined;
  const { budget, balance } = view;
  return {
    id: budget.id,
    accountId: budget.accountId,
    currency: budget.currency,
    limitAmountMinor: budget.limitAmountMinor,
    revision: budget.revision,
    createdAt: budget.createdAt,
    createdBy: budget.createdBy,
    updatedAt: budget.updatedAt,
    updatedBy: budget.updatedBy,
    balance,
  };
}

export async function handleWorkspaceAdminRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: WorkspaceAdminRuntime,
  sessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/v1/workspace/me/budget") {
    assertQueryKeys(url, []);
    const session = await resolveWorkspaceSession(request, sessions);
    sendJson(response, 200, {
      budget: publicBudget(await runtime.getOwnAccountBudget(session.scope)),
    });
    return true;
  }
  if (!url.pathname.startsWith("/v1/admin/")) return false;
  const session = await resolveWorkspaceSession(request, sessions);

  if (request.method === "GET" && url.pathname === "/v1/admin/brands") {
    assertQueryKeys(url, []);
    sendJson(response, 200, { brands: await runtime.listBrands(session.scope) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/admin/brands") {
    const input = validateBody<CreateBrandRequest>(
      CreateBrandRequestSchema,
      await readJson(request),
    );
    sendJson(response, 201, await runtime.createBrand(input, session.scope));
    return true;
  }

  const brandMatch = matchPath(url.pathname, `/v1/admin/brands/${IdentifierPath}`);
  if (request.method === "PATCH" && brandMatch?.[1]) {
    const input = validateBody<UpdateBrandRequest>(UpdateBrandRequestSchema, await readJson(request));
    sendJson(response, 200, { brand: await runtime.updateBrand(brandMatch[1], input, session.scope) });
    return true;
  }

  const brandVehiclesMatch = matchPath(
    url.pathname,
    `/v1/admin/brands/${IdentifierPath}/vehicles`,
  );
  if (brandVehiclesMatch?.[1] && request.method === "GET") {
    assertQueryKeys(url, []);
    sendJson(response, 200, {
      vehicles: await runtime.listVehicles(brandVehiclesMatch[1], session.scope),
    });
    return true;
  }
  if (brandVehiclesMatch?.[1] && request.method === "POST") {
    const input = validateBody<CreateVehicleRequest>(
      CreateVehicleRequestSchema,
      await readJson(request),
    );
    sendJson(response, 201, {
      vehicle: await runtime.createVehicle(brandVehiclesMatch[1], input, session.scope),
    });
    return true;
  }

  const vehicleVersionsMatch = matchPath(
    url.pathname,
    `/v1/admin/vehicles/${IdentifierPath}/versions`,
  );
  if (vehicleVersionsMatch?.[1] && request.method === "GET") {
    assertQueryKeys(url, []);
    sendJson(response, 200, {
      versions: await runtime.listVehicleVersions(vehicleVersionsMatch[1], session.scope),
    });
    return true;
  }
  if (vehicleVersionsMatch?.[1] && request.method === "POST") {
    const input = validateBody<CreateVehicleFactVersionRequest>(
      CreateVehicleFactVersionRequestSchema,
      await readJson(request),
    );
    sendJson(response, 201, {
      vehicle: await runtime.createVehicleFactVersion(
        vehicleVersionsMatch[1],
        input,
        session.scope,
      ),
    });
    return true;
  }

  const vehicleAssetsMatch = matchPath(
    url.pathname,
    `/v1/admin/vehicles/${IdentifierPath}/asset-associations`,
  );
  if (vehicleAssetsMatch?.[1] && request.method === "GET") {
    assertQueryKeys(url, []);
    sendJson(response, 200, await runtime.getVehicleAssetPackage(vehicleAssetsMatch[1], session.scope));
    return true;
  }
  if (vehicleAssetsMatch?.[1] && request.method === "PUT") {
    const input = validateBody<ReplaceVehicleAssetAssociationsRequest>(
      ReplaceVehicleAssetAssociationsRequestSchema,
      await readJson(request),
    );
    sendJson(response, 200, {
      association: await runtime.replaceVehicleAssetAssociations(
        vehicleAssetsMatch[1],
        input,
        session.scope,
      ),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/company-assets") {
    assertQueryKeys(url, [
      "category",
      "brandId",
      "vehicleId",
      "searchText",
      "tag",
      "cursor",
      "limit",
    ]);
    const categories = url.searchParams.getAll("category");
    const tags = url.searchParams.getAll("tag");
    const brandId = url.searchParams.get("brandId") ?? undefined;
    const vehicleId = url.searchParams.get("vehicleId") ?? undefined;
    const searchText = url.searchParams.get("searchText") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = parseLimit(url.searchParams.get("limit"));
    const page = await runtime.searchCompanyAssets(
      {
        ...(categories.length === 0 ? {} : { categories: categories as AssetCategory[] }),
        ...(brandId === undefined ? {} : { brandId }),
        ...(vehicleId === undefined ? {} : { vehicleId }),
        ...(searchText === undefined ? {} : { searchText }),
        ...(tags.length === 0 ? {} : { tags }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      },
      session.scope,
    );
    sendJson(response, 200, page);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/access-grants") {
    assertQueryKeys(url, ["accountId", "brandId"]);
    const accountId = url.searchParams.get("accountId") ?? undefined;
    const brandId = url.searchParams.get("brandId") ?? undefined;
    sendJson(response, 200, {
      accessGrants: await runtime.listAccessGrants(session.scope, {
        ...(accountId === undefined ? {} : { accountId }),
        ...(brandId === undefined ? {} : { brandId }),
      }),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/admin/access-grants") {
    const input = validateBody<CreateWorkspaceAccessGrantRequest>(
      CreateWorkspaceAccessGrantRequestSchema,
      await readJson(request),
    );
    sendJson(response, 201, {
      accessGrant: await runtime.createAccessGrant(input.accountId, input.access, session.scope),
    });
    return true;
  }

  const grantMatch = matchPath(url.pathname, `/v1/admin/access-grants/${IdentifierPath}`);
  if (request.method === "PATCH" && grantMatch?.[1]) {
    const input = validateBody<UpdateWorkspaceAccessGrantRequest>(
      UpdateWorkspaceAccessGrantRequestSchema,
      await readJson(request),
    );
    sendJson(response, 200, {
      accessGrant: await runtime.updateAccessGrant(
        grantMatch[1],
        input.expectedRevision,
        input.status,
        session.scope,
      ),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/accounts") {
    assertQueryKeys(url, []);
    const accounts = await runtime.listAccountsWithAdministration(session.scope);
    sendJson(response, 200, {
      accounts: accounts.map((entry) => ({
        account: entry.account,
        accessGrants: entry.accessGrants,
        budget: publicBudget(entry.budget),
      })),
    });
    return true;
  }

  const accountBudgetMatch = matchPath(
    url.pathname,
    `/v1/admin/accounts/${IdentifierPath}/budget`,
  );
  if (accountBudgetMatch?.[1] && request.method === "GET") {
    assertQueryKeys(url, []);
    sendJson(response, 200, {
      budget: publicBudget(await runtime.getAccountBudget(accountBudgetMatch[1], session.scope)),
    });
    return true;
  }
  if (accountBudgetMatch?.[1] && request.method === "POST") {
    const input = validateBody<CreateAccountBudgetRequest>(
      CreateAccountBudgetRequestSchema,
      await readJson(request),
    );
    const budget = await runtime.createAccountBudget(
      accountBudgetMatch[1],
      input.currency,
      input.limitAmountMinor,
      session.scope,
    );
    sendJson(response, 201, {
      budget: publicBudget(await runtime.getAccountBudget(budget.accountId, session.scope)),
    });
    return true;
  }
  if (accountBudgetMatch?.[1] && request.method === "PATCH") {
    const input = validateBody<UpdateAccountBudgetRequest>(
      UpdateAccountBudgetRequestSchema,
      await readJson(request),
    );
    const budget = await runtime.updateAccountBudget(
      accountBudgetMatch[1],
      input.expectedRevision,
      input.limitAmountMinor,
      session.scope,
    );
    sendJson(response, 200, {
      budget: publicBudget(await runtime.getAccountBudget(budget.accountId, session.scope)),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/overview") {
    assertQueryKeys(url, []);
    sendJson(response, 200, await runtime.getOverview(session.scope));
    return true;
  }

  return false;
}
