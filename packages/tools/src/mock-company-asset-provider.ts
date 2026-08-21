import { createHash } from "node:crypto";

import type {
  AssetCategory,
  CompanyReusableAssetReference,
  CompanyVehicleAssetReference,
} from "@firefly/schemas";

import type {
  CompanyAssetCatalogItem,
  CompanyAssetCatalogPage,
  CompanyAssetCatalogQuery,
  CompanyAssetPreview,
  CompanyAssetProvider,
  CompanyAssetProviderRequestOptions,
  CompanyAssetProviderScope,
  CompanyAssetReference,
  CompanyAssetResolveResult,
} from "./company-asset-provider.ts";
import {
  mockCompanyAssetMediaManifest,
  mockCompanyReusableAssetMediaManifest,
  type MockCompanyAssetMediaManifestEntry,
  type MockCompanyReusableAssetMediaManifestEntry,
} from "./mock-company-asset-manifest.ts";

type ReusableAssetCategory = Exclude<AssetCategory, "vehicle">;

interface MockCompanyAssetRecordBase {
  tenantId: string;
  assetId: string;
  version: number;
  displayName: string;
  description?: string;
  brandIds: readonly string[];
  tags: readonly string[];
  preview: CompanyAssetPreview;
  updatedAt: string;
  internalSortWeight: number;
}

interface MockVehicleAssetRecord extends MockCompanyAssetRecordBase {
  category: "vehicle";
  vehicleId: string;
}

interface MockReusableAssetRecord extends MockCompanyAssetRecordBase {
  category: ReusableAssetCategory;
}

type MockCompanyAssetRecord = MockVehicleAssetRecord | MockReusableAssetRecord;

interface CatalogCursor {
  offset: number;
  fingerprint: string;
}

export class CompanyAssetCatalogQueryError extends Error {
  readonly code = "AIC-ASSET-CATALOG_QUERY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CompanyAssetCatalogQueryError";
  }
}

export class CompanyAssetCatalogAccessError extends Error {
  readonly code = "AIC-AUTH-ASSET_SCOPE_DENIED";

  constructor(message = "The company asset query is outside the authenticated scope.") {
    super(message);
    this.name = "CompanyAssetCatalogAccessError";
  }
}

export class CompanyAssetProviderAbortedError extends Error {
  readonly code = "AIC-ASSET-PROVIDER_ABORTED";

  constructor() {
    super("The company asset provider request was cancelled.");
    this.name = "CompanyAssetProviderAbortedError";
  }
}

function preview(assetId: string, width = 1920, height = 1080): CompanyAssetPreview {
  return {
    mediaType: "image/webp",
    width,
    height,
    thumbnailUrl: `/v1/mock-company-assets/${assetId}/thumbnail`,
  };
}

function mediaManifestRecord(
  entry: Readonly<MockCompanyAssetMediaManifestEntry>,
): MockVehicleAssetRecord {
  return {
    tenantId: entry.tenantId,
    assetId: entry.assetId,
    version: entry.version,
    category: "vehicle",
    vehicleId: entry.vehicleId,
    displayName: entry.displayName,
    description: `${entry.visualDescription}（文本仅描述该图可见内容，不构成官方车型事实或配置声明。）`,
    brandIds: [entry.brandId],
    tags: [...entry.tags],
    preview: {
      mediaType: entry.mediaType,
      width: entry.width,
      height: entry.height,
      thumbnailUrl: `/v1/mock-company-assets/${entry.assetId}/versions/${entry.version}/thumbnail`,
    },
    updatedAt: entry.updatedAt,
    internalSortWeight: 90,
  };
}

function reusableMediaManifestRecord(
  entry: Readonly<MockCompanyReusableAssetMediaManifestEntry>,
): MockReusableAssetRecord {
  return {
    tenantId: entry.tenantId,
    assetId: entry.assetId,
    version: entry.version,
    category: entry.category,
    displayName: entry.displayName,
    description: `${entry.visualDescription}（模拟生成素材，正式投放前需复核人物、车辆外观与使用权。）`,
    brandIds: [entry.brandId],
    tags: [...entry.tags],
    preview: {
      mediaType: entry.mediaType,
      width: entry.width,
      height: entry.height,
      thumbnailUrl: `/v1/mock-company-assets/${entry.assetId}/versions/${entry.version}/thumbnail`,
    },
    updatedAt: entry.updatedAt,
    internalSortWeight: 100,
  };
}

const defaultCatalog: readonly MockCompanyAssetRecord[] = [
  {
    tenantId: "tenant_firefly",
    assetId: "asset_firefly_demo_e5_hero",
    version: 1,
    category: "vehicle",
    vehicleId: "vehicle_firefly_e5_2026_long_range",
    displayName: "萤火 E5 长续航版英雄图",
    description: "开发管理中心使用的白色棚拍前侧视角",
    brandIds: ["brand_firefly_demo"],
    tags: ["hero", "front", "studio"],
    preview: preview("asset_firefly_demo_e5_hero"),
    updatedAt: "2026-08-19T00:00:00.000Z",
    internalSortWeight: 120,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_style_firefly_demo_clean",
    version: 1,
    category: "visual_style",
    displayName: "萤火汽车清透科技风",
    description: "开发品牌默认视觉预设",
    brandIds: ["brand_firefly_demo"],
    tags: ["brand", "clean", "technology"],
    preview: preview("asset_style_firefly_demo_clean"),
    updatedAt: "2026-08-19T00:00:00.000Z",
    internalSortWeight: 120,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_style_global_clean",
    version: 1,
    category: "visual_style",
    displayName: "全品牌清透产品风",
    description: "可作为新品牌初始化视觉预设的通用模拟风格。",
    brandIds: [],
    tags: ["global", "clean", "product"],
    preview: preview("asset_style_global_clean"),
    updatedAt: "2026-08-19T00:00:00.000Z",
    internalSortWeight: 50,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_e5_hero",
    version: 1,
    category: "vehicle",
    vehicleId: "vehicle_e5",
    displayName: "E5 英雄前侧图（历史版）",
    description: "白色棚拍前侧视角",
    brandIds: ["brand_firefly"],
    tags: ["hero", "front", "studio"],
    preview: preview("asset_e5_hero_v1"),
    updatedAt: "2026-07-01T08:00:00.000Z",
    internalSortWeight: 80,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_e5_hero",
    version: 2,
    category: "vehicle",
    vehicleId: "vehicle_e5",
    displayName: "E5 英雄前侧图",
    description: "白色棚拍前侧视角，已更新车身高光",
    brandIds: ["brand_firefly"],
    tags: ["hero", "front", "studio"],
    preview: preview("asset_e5_hero_v2"),
    updatedAt: "2026-08-16T08:00:00.000Z",
    internalSortWeight: 100,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_e5_interior",
    version: 1,
    category: "vehicle",
    vehicleId: "vehicle_e5",
    displayName: "E5 座舱全景",
    description: "前排座舱与中控屏全景",
    brandIds: ["brand_firefly"],
    tags: ["interior", "cockpit"],
    preview: preview("asset_e5_interior"),
    updatedAt: "2026-08-12T08:00:00.000Z",
    internalSortWeight: 90,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_e6_hero",
    version: 1,
    category: "vehicle",
    vehicleId: "vehicle_e6",
    displayName: "E6 英雄图",
    brandIds: ["brand_firefly"],
    tags: ["hero", "front"],
    preview: preview("asset_e6_hero"),
    updatedAt: "2026-08-15T08:00:00.000Z",
    internalSortWeight: 100,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_person_family",
    version: 1,
    category: "person",
    displayName: "年轻家庭三人组",
    description: "适合家庭出行和周末露营主题",
    brandIds: ["brand_firefly"],
    tags: ["family", "camping", "warm"],
    preview: preview("asset_person_family", 1440, 1920),
    updatedAt: "2026-08-11T08:00:00.000Z",
    internalSortWeight: 80,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_person_young_driver",
    version: 2,
    category: "person",
    displayName: "年轻都市驾驶者",
    description: "全品牌可复用的人物形象",
    brandIds: [],
    tags: ["young", "city", "driver"],
    preview: preview("asset_person_young_driver", 1440, 1920),
    updatedAt: "2026-08-10T08:00:00.000Z",
    internalSortWeight: 70,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_scene_camping",
    version: 3,
    category: "scene",
    displayName: "湖边露营地",
    description: "傍晚湖边、帐篷和暖色灯串",
    brandIds: ["brand_firefly"],
    tags: ["camping", "lake", "sunset"],
    preview: preview("asset_scene_camping"),
    updatedAt: "2026-08-14T08:00:00.000Z",
    internalSortWeight: 95,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_scene_city_night",
    version: 1,
    category: "scene",
    displayName: "城市夜景道路",
    description: "全品牌可复用的城市夜间道路",
    brandIds: [],
    tags: ["city", "night", "road"],
    preview: preview("asset_scene_city_night"),
    updatedAt: "2026-08-09T08:00:00.000Z",
    internalSortWeight: 60,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_style_firefly_clean",
    version: 4,
    category: "visual_style",
    displayName: "萤火虫清透科技风",
    description: "品牌蓝、通透高光与克制科技线条",
    brandIds: ["brand_firefly"],
    tags: ["brand", "clean", "technology"],
    preview: preview("asset_style_firefly_clean"),
    updatedAt: "2026-08-18T08:00:00.000Z",
    internalSortWeight: 110,
  },
  {
    tenantId: "tenant_firefly",
    assetId: "asset_style_other_luxury",
    version: 1,
    category: "visual_style",
    displayName: "其他品牌豪华风",
    brandIds: ["brand_other"],
    tags: ["brand", "luxury"],
    preview: preview("asset_style_other_luxury"),
    updatedAt: "2026-08-17T08:00:00.000Z",
    internalSortWeight: 100,
  },
  {
    tenantId: "tenant_other",
    assetId: "asset_other_tenant_scene",
    version: 1,
    category: "scene",
    displayName: "其他租户场景",
    brandIds: ["brand_firefly"],
    tags: ["private"],
    preview: preview("asset_other_tenant_scene"),
    updatedAt: "2026-08-18T08:00:00.000Z",
    internalSortWeight: 999,
  },
  ...mockCompanyAssetMediaManifest.map(mediaManifestRecord),
  ...mockCompanyReusableAssetMediaManifest.map(reusableMediaManifestRecord),
];

function recordsForScope(
  scope: Readonly<CompanyAssetProviderScope>,
): readonly MockCompanyAssetRecord[] {
  const catalogVehicleIds = new Set(
    defaultCatalog
      .filter(
        (record) => record.tenantId === scope.tenantId && record.category === "vehicle",
      )
      .map((record) => record.category === "vehicle" ? record.vehicleId : ""),
  );
  const syntheticVehicles: MockVehicleAssetRecord[] = scope.allowedVehicleIds
    .filter((vehicleId) => !catalogVehicleIds.has(vehicleId))
    .map((vehicleId) => {
      const fingerprint = createHash("sha256").update(`${scope.tenantId}:${vehicleId}`).digest("hex").slice(0, 24);
      const assetId = `asset_mock_vehicle_${fingerprint}`;
      return {
        tenantId: scope.tenantId,
        assetId,
        version: 1,
        category: "vehicle",
        vehicleId,
        displayName: `模拟车型参考图 ${vehicleId}`,
        description: "为管理中心新建车型提供的确定性模拟公司资产。",
        brandIds: [],
        tags: ["vehicle", "mock", "reference"],
        preview: preview(assetId),
        updatedAt: "2026-08-19T00:00:00.000Z",
        internalSortWeight: 10,
      };
    });
  return [...defaultCatalog, ...syntheticVehicles];
}

function assertNotAborted(options?: Readonly<CompanyAssetProviderRequestOptions>): void {
  if (options?.signal?.aborted) throw new CompanyAssetProviderAbortedError();
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function validateScope(scope: Readonly<CompanyAssetProviderScope>): void {
  if (
    !isIdentifier(scope.tenantId) ||
    !isIdentifier(scope.actorAccountId) ||
    scope.allowedBrandIds.some((id) => !isIdentifier(id)) ||
    scope.allowedVehicleIds.some((id) => !isIdentifier(id))
  ) {
    throw new CompanyAssetCatalogAccessError("The server-resolved company asset scope is invalid.");
  }
}

function validateQuery(
  query: Readonly<CompanyAssetCatalogQuery>,
  scope: Readonly<CompanyAssetProviderScope>,
): void {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
    throw new CompanyAssetCatalogQueryError("Asset page size must be an integer from 1 to 100.");
  }
  const validCategories: readonly AssetCategory[] = [
    "vehicle",
    "person",
    "scene",
    "visual_style",
  ];
  if (
    query.categories?.some((category) => !validCategories.includes(category)) ||
    (query.brandId !== undefined && !isIdentifier(query.brandId)) ||
    (query.vehicleId !== undefined && !isIdentifier(query.vehicleId)) ||
    (query.searchText !== undefined && (query.searchText.length < 1 || query.searchText.length > 200)) ||
    (query.tags !== undefined &&
      (query.tags.length > 20 || query.tags.some((tag) => tag.length < 1 || tag.length > 80)))
  ) {
    throw new CompanyAssetCatalogQueryError("The company asset catalog filters are invalid.");
  }
  if (query.brandId !== undefined && !scope.allowedBrandIds.includes(query.brandId)) {
    throw new CompanyAssetCatalogAccessError();
  }
  if (query.vehicleId !== undefined && !scope.allowedVehicleIds.includes(query.vehicleId)) {
    throw new CompanyAssetCatalogAccessError();
  }
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function toPublicItem(record: Readonly<MockCompanyAssetRecord>): CompanyAssetCatalogItem {
  const commonReference = {
    assetId: record.assetId,
    version: record.version,
    source: "company_catalog" as const,
    sourceProvider: "mock_company_assets",
  };
  const reference: CompanyAssetReference =
    record.category === "vehicle"
      ? ({
          ...commonReference,
          category: "vehicle",
          vehicleId: record.vehicleId,
        } satisfies CompanyVehicleAssetReference)
      : ({
          ...commonReference,
          category: record.category,
        } satisfies CompanyReusableAssetReference);
  return {
    reference,
    displayName: record.displayName,
    ...(record.description === undefined ? {} : { description: record.description }),
    brandIds: [...record.brandIds],
    tags: [...record.tags],
    preview: structuredClone(record.preview),
    updatedAt: record.updatedAt,
  };
}

function recordVisible(
  record: Readonly<MockCompanyAssetRecord>,
  scope: Readonly<CompanyAssetProviderScope>,
): boolean {
  if (record.tenantId !== scope.tenantId) return false;
  if (scope.allowedBrandIds.length === 0) return false;
  if (
    record.brandIds.length > 0 &&
    !record.brandIds.some((brandId) => scope.allowedBrandIds.includes(brandId))
  ) {
    return false;
  }
  return record.category !== "vehicle" || scope.allowedVehicleIds.includes(record.vehicleId);
}

function latestRecords(records: readonly MockCompanyAssetRecord[]): MockCompanyAssetRecord[] {
  const latest = new Map<string, MockCompanyAssetRecord>();
  for (const record of records) {
    const current = latest.get(record.assetId);
    if (!current || record.version > current.version) latest.set(record.assetId, record);
  }
  return [...latest.values()];
}

function queryFingerprint(
  query: Readonly<CompanyAssetCatalogQuery>,
  scope: Readonly<CompanyAssetProviderScope>,
): string {
  const source = JSON.stringify({
    tenantId: scope.tenantId,
    allowedBrandIds: [...scope.allowedBrandIds].sort(),
    allowedVehicleIds: [...scope.allowedVehicleIds].sort(),
    categories: query.categories === undefined ? null : [...query.categories].sort(),
    brandId: query.brandId ?? null,
    vehicleId: query.vehicleId ?? null,
    searchText: query.searchText === undefined ? null : normalizeSearch(query.searchText),
    tags: query.tags === undefined ? null : [...query.tags].map(normalizeSearch).sort(),
    limit: query.limit,
  });
  return createHash("sha256").update(source).digest("hex").slice(0, 24);
}

function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, fingerprint: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CatalogCursor>;
    if (
      !Number.isInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      parsed.fingerprint !== fingerprint
    ) {
      throw new Error("invalid cursor");
    }
    return parsed.offset ?? 0;
  } catch {
    throw new CompanyAssetCatalogQueryError("The company asset catalog cursor is invalid.");
  }
}

function sameReference(
  reference: Readonly<CompanyAssetReference>,
  record: Readonly<MockCompanyAssetRecord>,
): boolean {
  if (
    reference.sourceProvider !== "mock_company_assets" ||
    reference.assetId !== record.assetId ||
    reference.version !== record.version ||
    reference.category !== record.category
  ) {
    return false;
  }
  return reference.category !== "vehicle" ||
    record.category !== "vehicle" ||
    reference.vehicleId === record.vehicleId;
}

export class MockCompanyAssetProvider implements CompanyAssetProvider {
  readonly providerId = "mock_company_assets";

  async searchAssets(
    query: Readonly<CompanyAssetCatalogQuery>,
    scope: Readonly<CompanyAssetProviderScope>,
    options?: Readonly<CompanyAssetProviderRequestOptions>,
  ): Promise<CompanyAssetCatalogPage> {
    assertNotAborted(options);
    validateScope(scope);
    validateQuery(query, scope);
    const fingerprint = queryFingerprint(query, scope);
    const offset = query.cursor === undefined ? 0 : decodeCursor(query.cursor, fingerprint);
    const normalizedSearch = query.searchText === undefined ? undefined : normalizeSearch(query.searchText);
    const normalizedTags = query.tags?.map(normalizeSearch);
    const filtered = latestRecords(recordsForScope(scope).filter((record) => recordVisible(record, scope)))
      .filter(
        (record) => query.categories === undefined || query.categories.includes(record.category),
      )
      .filter(
        (record) =>
          query.brandId === undefined ||
          record.brandIds.length === 0 ||
          record.brandIds.includes(query.brandId),
      )
      .filter(
        (record) =>
          query.vehicleId === undefined ||
          record.category !== "vehicle" ||
          record.vehicleId === query.vehicleId,
      )
      .filter((record) => {
        if (normalizedSearch === undefined) return true;
        return normalizeSearch(
          [record.displayName, record.description ?? "", ...record.tags].join(" "),
        ).includes(normalizedSearch);
      })
      .filter((record) => {
        if (normalizedTags === undefined) return true;
        const tags = record.tags.map(normalizeSearch);
        return normalizedTags.every((tag) => tags.includes(tag));
      })
      .sort(
        (left, right) =>
          right.internalSortWeight - left.internalSortWeight ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.assetId.localeCompare(right.assetId),
      );
    if (offset > filtered.length) {
      throw new CompanyAssetCatalogQueryError("The company asset catalog cursor is out of range.");
    }
    const pageRecords = filtered.slice(offset, offset + query.limit);
    const nextOffset = offset + pageRecords.length;
    assertNotAborted(options);
    return {
      items: pageRecords.map(toPublicItem),
      ...(nextOffset < filtered.length
        ? { nextCursor: encodeCursor({ offset: nextOffset, fingerprint }) }
        : {}),
    };
  }

  async resolveAssets(
    references: readonly CompanyAssetReference[],
    scope: Readonly<CompanyAssetProviderScope>,
    options?: Readonly<CompanyAssetProviderRequestOptions>,
  ): Promise<CompanyAssetResolveResult> {
    assertNotAborted(options);
    validateScope(scope);
    if (references.length > 500) {
      throw new CompanyAssetCatalogQueryError("At most 500 company assets can be resolved at once.");
    }
    const items: CompanyAssetCatalogItem[] = [];
    const missingReferences: CompanyAssetReference[] = [];
    for (const reference of references) {
      const record = recordsForScope(scope).find(
        (candidate) =>
          recordVisible(candidate, scope) && sameReference(reference, candidate),
      );
      if (record) items.push(toPublicItem(record));
      else missingReferences.push(structuredClone(reference));
    }
    assertNotAborted(options);
    return { items, missingReferences };
  }
}
