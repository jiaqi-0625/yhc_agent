import assert from "node:assert/strict";
import test from "node:test";

import {
  createAccessGrantRequest,
  createAssetAssociationRequest,
  createVehicleFactsRequest,
  formatMinorAmount,
  majorAmountToMinor,
  managementErrorMessage,
  minorAmountToMajor,
  resolveAssetPaginationCursor,
  resolveBrandVisualStyleOptions,
  summarizeManagedProjects,
} from "../public/management-center.js";

const vehicleFactsInput = {
  status: "active",
  series: "  萤火 E5  ",
  modelYear: "2027",
  trim: "  长续航版  ",
  parametersText: JSON.stringify({ " 座位数 ": 5, drive: "FWD", panoramicRoof: true }),
  fixedClaimsText: JSON.stringify([{
    id: "claim_range_550",
    kind: "extended",
    name: "  CLTC 纯电续航  ",
    statement: "  CLTC 纯电续航 550 公里  ",
    value: 550,
    unit: "公里",
    evidence: {
      sourceName: "  官方车型配置表  ",
      sourceReference: "  spec-2027#range  ",
      effectiveFrom: "2027-01-01",
      effectiveUntil: "2027-12-31",
      tenantId: "tenant_forged",
      actorAccountId: "account_forged",
    },
    requiredInVoiceover: true,
    requiredInSubtitle: true,
    mayRephrase: false,
    riskNotes: ["  必须保留 CLTC 测试条件  "],
    tenantId: "tenant_forged",
  }]),
  optionalClaimsText: JSON.stringify([{
    id: "claim_family_space",
    kind: "fixed",
    name: "家庭空间",
    statement: "五座布局兼顾日常乘坐与储物",
    value: "五座",
    evidence: {
      sourceName: "车型手册",
      sourceReference: "manual#space",
      effectiveFrom: "2027-01-01",
      createdBy: "account_forged",
    },
    requiredInVoiceover: false,
    requiredInSubtitle: false,
    mayRephrase: true,
    riskNotes: [],
  }]),
  prohibitedClaimsText: "  同级最大  \n\n 自动驾驶  ",
  expectedVersion: "7",
  tenantId: "tenant_forged",
  brandId: "brand_forged",
  actorAccountId: "account_forged",
  revision: 99,
};

test("vehicle fact requests preserve complete claim evidence while stripping forged scope", () => {
  const request = createVehicleFactsRequest(vehicleFactsInput);

  assert.deepEqual(request, {
    status: "active",
    series: "萤火 E5",
    modelYear: 2027,
    trim: "长续航版",
    parameters: { 座位数: 5, drive: "FWD", panoramicRoof: true },
    fixedClaims: [{
      id: "claim_range_550",
      kind: "fixed",
      name: "CLTC 纯电续航",
      statement: "CLTC 纯电续航 550 公里",
      value: 550,
      unit: "公里",
      evidence: {
        sourceName: "官方车型配置表",
        sourceReference: "spec-2027#range",
        effectiveFrom: "2027-01-01",
        effectiveUntil: "2027-12-31",
      },
      requiredInVoiceover: true,
      requiredInSubtitle: true,
      mayRephrase: false,
      riskNotes: ["必须保留 CLTC 测试条件"],
    }],
    optionalClaims: [{
      id: "claim_family_space",
      kind: "extended",
      name: "家庭空间",
      statement: "五座布局兼顾日常乘坐与储物",
      value: "五座",
      evidence: {
        sourceName: "车型手册",
        sourceReference: "manual#space",
        effectiveFrom: "2027-01-01",
      },
      requiredInVoiceover: false,
      requiredInSubtitle: false,
      mayRephrase: true,
      riskNotes: [],
    }],
    prohibitedClaims: ["同级最大", "自动驾驶"],
    expectedVersion: 7,
  });
  assert.equal("tenantId" in request, false);
  assert.equal("brandId" in request, false);
  assert.equal("actorAccountId" in request, false);
  assert.equal("tenantId" in request.fixedClaims[0]!, false);
  assert.equal("tenantId" in request.fixedClaims[0]!.evidence!, false);
});

test("vehicle fact requests reject malformed evidence dates", () => {
  assert.throws(
    () => createVehicleFactsRequest({
      ...vehicleFactsInput,
      fixedClaimsText: JSON.stringify([{
        id: "claim_invalid_evidence",
        name: "无效证据",
        statement: "日期格式无效",
        evidence: {
          sourceName: "车型手册",
          sourceReference: "manual#invalid",
          effectiveFrom: "2027/01/01",
        },
        requiredInVoiceover: false,
        requiredInSubtitle: false,
        mayRephrase: false,
        riskNotes: [],
      }]),
    }),
    /YYYY-MM-DD/u,
  );
});

test("vehicle fact requests reject type coercion and server-authority parameter keys", () => {
  const baseClaim = JSON.parse(vehicleFactsInput.fixedClaimsText)[0];
  for (const [field, value] of [
    ["requiredInVoiceover", "false"],
    ["requiredInSubtitle", 1],
    ["mayRephrase", "false"],
    ["riskNotes", "不得改写"],
    ["unit", null],
  ] as const) {
    assert.throws(
      () => createVehicleFactsRequest({
        ...vehicleFactsInput,
        fixedClaimsText: JSON.stringify([{ ...baseClaim, [field]: value }]),
      }),
      /必须|文字/u,
    );
  }

  assert.throws(
    () => createVehicleFactsRequest({
      ...vehicleFactsInput,
      parametersText: JSON.stringify({ tenantId: "tenant_forged" }),
    }),
    /服务端保留字段/u,
  );
  assert.throws(
    () => createVehicleFactsRequest({ ...vehicleFactsInput, status: "pending" }),
    /状态无效/u,
  );

  assert.throws(
    () => createVehicleFactsRequest({
      ...vehicleFactsInput,
      fixedClaimsText: "[]",
      optionalClaimsText: "[]",
    }),
    /1–20/u,
  );
  assert.throws(
    () => createVehicleFactsRequest({
      ...vehicleFactsInput,
      optionalClaimsText: JSON.stringify([{ ...baseClaim, kind: "extended" }]),
    }),
    /重复 ID/u,
  );
  assert.throws(
    () => createVehicleFactsRequest({
      ...vehicleFactsInput,
      fixedClaimsText: JSON.stringify(Array.from({ length: 21 }, (_, index) => ({
        ...baseClaim,
        id: `claim_${index}`,
      }))),
      optionalClaimsText: "[]",
    }),
    /1–20/u,
  );
});

const vehicleReference = {
  assetId: "asset_e5_hero",
  version: "3",
  source: "forged_source",
  sourceProvider: "mock_company_assets",
  category: "vehicle",
  vehicleId: "vehicle_e5",
  tenantId: "tenant_forged",
} as const;

const personReference = {
  assetId: "asset_family",
  version: 7,
  source: "company_catalog",
  sourceProvider: "mock_company_assets",
  category: "person",
  vehicleId: "vehicle_forged",
  actorAccountId: "account_forged",
} as const;

test("asset association requests retain exact versions, scope vehicle assets, and carry revision", () => {
  assert.deepEqual(
    createAssetAssociationRequest("4", [vehicleReference, personReference], "vehicle_e5"),
    {
      expectedRevision: 4,
      assets: [
        {
          assetId: "asset_e5_hero",
          version: 3,
          source: "company_catalog",
          sourceProvider: "mock_company_assets",
          category: "vehicle",
          vehicleId: "vehicle_e5",
        },
        {
          assetId: "asset_family",
          version: 7,
          source: "company_catalog",
          sourceProvider: "mock_company_assets",
          category: "person",
        },
      ],
    },
  );
});

test("asset association requests reject cross-vehicle, duplicate, and vehicle-free packages", () => {
  assert.throws(
    () => createAssetAssociationRequest(0, [{ ...vehicleReference, vehicleId: "vehicle_e6" }], "vehicle_e5"),
    /严格匹配/u,
  );
  assert.throws(
    () => createAssetAssociationRequest(0, [vehicleReference, { ...vehicleReference }], "vehicle_e5"),
    /重复资产/u,
  );
  assert.throws(
    () => createAssetAssociationRequest(0, [personReference], "vehicle_e5"),
    /至少需要一项当前车型资产/u,
  );
});

test("asset pagination cursors stop stale, repeated, cyclic, and over-limit page chains", () => {
  assert.deepEqual(resolveAssetPaginationCursor("cursor_2", "cursor_1", new Set(["cursor_1"])), {
    nextCursor: "cursor_2",
    error: null,
  });
  assert.deepEqual(resolveAssetPaginationCursor(null, "cursor_1", new Set(["cursor_1"])), {
    nextCursor: null,
    error: null,
  });
  assert.deepEqual(resolveAssetPaginationCursor("cursor_1", "cursor_1", new Set()), {
    nextCursor: null,
    error: "公司资产目录返回了重复分页游标，已停止继续加载。",
  });
  assert.deepEqual(resolveAssetPaginationCursor("cursor_1", "cursor_2", new Set(["cursor_1", "cursor_2"])), {
    nextCursor: null,
    error: "公司资产目录返回了重复分页游标，已停止继续加载。",
  });
  assert.deepEqual(
    resolveAssetPaginationCursor(
      "cursor_101",
      "cursor_100",
      new Set(Array.from({ length: 100 }, (_, index) => `cursor_${index + 1}`)),
    ),
    {
      nextCursor: null,
      error: "公司资产目录页数超出安全上限，已停止继续加载。",
    },
  );
});

test("brand visual style options enforce global creation and current-brand edit scope", () => {
  const styles = [
    {
      reference: { assetId: "style_firefly", version: 1 },
      brandIds: ["brand_firefly"],
      displayName: "萤火专属",
    },
    {
      reference: { assetId: "style_global", version: 1 },
      brandIds: [],
      displayName: "全局清爽",
    },
    {
      reference: { assetId: "style_other", version: 1 },
      brandIds: ["brand_other"],
      displayName: "其他品牌专属",
    },
  ];
  assert.deepEqual(
    resolveBrandVisualStyleOptions(styles).map((item) => item.reference?.assetId),
    ["style_global"],
  );
  assert.deepEqual(
    resolveBrandVisualStyleOptions(styles, {
      id: "brand_firefly",
      defaultVisualStylePresetId: "style_firefly",
    }).map((item) => item.reference?.assetId),
    ["style_firefly", "style_global"],
  );
  assert.deepEqual(
    resolveBrandVisualStyleOptions(styles, {
      id: "brand_firefly",
      defaultVisualStylePresetId: "style_retired",
    }).map((item) => item.reference?.assetId),
    ["style_firefly", "style_global", "style_retired"],
  );
});

test("access grant requests expose only the selected server-recognized scope", () => {
  assert.deepEqual(createAccessGrantRequest({
    accountId: " account_creator_a ",
    kind: "brand",
    brandId: " brand_firefly ",
    tenantId: "tenant_forged",
    actorAccountId: "account_forged",
    vehicleId: "vehicle_forged",
  }), {
    accountId: "account_creator_a",
    access: { kind: "brand", brandId: "brand_firefly" },
  });

  assert.deepEqual(createAccessGrantRequest({
    accountId: "account_creator_b",
    kind: "vehicle_project",
    brandId: "brand_firefly",
    vehicleId: "vehicle_e5",
    role: "content_admin",
    revision: 20,
  }), {
    accountId: "account_creator_b",
    access: {
      kind: "vehicle_project",
      brandId: "brand_firefly",
      vehicleId: "vehicle_e5",
    },
  });

  assert.throws(
    () => createAccessGrantRequest({
      accountId: "account_creator_a",
      kind: "tenant_admin",
      brandId: "brand_firefly",
    }),
    /授权范围无效/u,
  );
});

test("major amounts convert to integer minor units without floating-point rounding", () => {
  assert.equal(majorAmountToMinor("0"), 0);
  assert.equal(majorAmountToMinor(" 12.3 "), 1_230);
  assert.equal(majorAmountToMinor("001.05"), 105);
  assert.equal(majorAmountToMinor("90071992547409.91"), Number.MAX_SAFE_INTEGER);

  for (const invalid of ["-1", "1.001", "1e3", ".25", "90071992547409.92"]) {
    assert.throws(() => majorAmountToMinor(invalid));
  }

  assert.equal(minorAmountToMajor(Number.MAX_SAFE_INTEGER), "90071992547409.91");
  assert.equal(majorAmountToMinor(minorAmountToMajor(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.match(formatMinorAmount(Number.MAX_SAFE_INTEGER, "CNY"), /90,071,992,547,409\.91/u);
});

test("budget amounts honor each currency's integer minor-unit exponent", () => {
  assert.equal(majorAmountToMinor("123", "JPY"), 123);
  assert.equal(minorAmountToMajor(123, "JPY"), "123");
  assert.match(formatMinorAmount(123, "JPY"), /123/u);
  assert.doesNotMatch(formatMinorAmount(123, "JPY"), /1\.23/u);
  assert.throws(() => majorAmountToMinor("123.4", "JPY"), /整数/u);

  assert.equal(majorAmountToMinor("1.234", "KWD"), 1_234);
  assert.equal(minorAmountToMajor(1_234, "KWD"), "1.234");
  assert.match(formatMinorAmount(1_234, "KWD"), /1\.234/u);
  assert.throws(() => majorAmountToMinor("1.2345", "KWD"), /3 位小数/u);
});

test("managed project summaries count projects, tasks, active records, and confirmation waits", () => {
  assert.deepEqual(summarizeManagedProjects([
    {
      project: { status: "active" },
      tasks: [
        { status: "active", stageStatus: "awaiting_confirmation" },
        { status: "archived", stageStatus: "in_progress" },
      ],
    },
    {
      project: { status: "archived" },
      tasks: [{ status: "active", stageStatus: "in_progress" }],
    },
  ]), {
    projects: 2,
    activeProjects: 1,
    tasks: 3,
    activeTasks: 2,
    pendingTasks: 1,
  });
  assert.deepEqual(summarizeManagedProjects(undefined), {
    projects: 0,
    activeProjects: 0,
    tasks: 0,
    activeTasks: 0,
    pendingTasks: 0,
  });
});

test("management errors prioritize authentication status, map business codes, and preserve fallback", () => {
  assert.equal(
    managementErrorMessage({ status: 401, code: "AIC-ADMIN-BRAND_ALREADY_EXISTS" }),
    "账号会话已失效，请重新切换账号。",
  );
  assert.equal(
    managementErrorMessage({ status: 403 }),
    "当前账号没有管理该资源的权限。",
  );
  assert.equal(
    managementErrorMessage({ code: "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_MISMATCH" }),
    "车型资产不能跨车型关联。",
  );
  assert.equal(
    managementErrorMessage({ code: "AIC-ADMIN-ASSET_ASSOCIATION_VEHICLE_REQUIRED" }),
    "推荐资产包至少需要一项当前车型资产。",
  );
  assert.equal(
    managementErrorMessage({ code: "AIC-WORKFLOW-REVISION_CONFLICT" }),
    "数据已被其他操作更新，页面将刷新到最新版本。",
  );
  assert.equal(managementErrorMessage({ code: "UNKNOWN" }, "请刷新后重试。"), "请刷新后重试。");
  assert.equal(managementErrorMessage(undefined), "操作失败，请稍后重试。");
});
