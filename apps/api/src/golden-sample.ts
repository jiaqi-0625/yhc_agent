import type { VehicleCatalogEntry } from "@firefly/tools";

export const LOCAL_SCOPE = {
  actorId: "creator_local",
  tenantId: "tenant_local",
  projectId: "project_local",
  allowedBrandIds: ["brand_firefly_demo"],
} as const;

export const GOLDEN_SAMPLE_VEHICLE_ID = "vehicle_firefly_e5_2026_long_range";

export const GOLDEN_SAMPLE_VEHICLES: readonly VehicleCatalogEntry[] = [
  {
    tenantId: LOCAL_SCOPE.tenantId,
    vehicleId: GOLDEN_SAMPLE_VEHICLE_ID,
    vehicleVersion: 1,
    brandId: "brand_firefly_demo",
    brand: "萤火示例汽车",
    series: "萤火 E5",
    modelYear: 2026,
    trim: "长续航示例版",
    parameters: { seats: 5, bodyStyle: "SUV", energyType: "纯电" },
    fixedClaims: [
      {
        id: "claim_cltc_range_550",
        kind: "fixed",
        name: "CLTC 纯电续航",
        statement: "CLTC 纯电续航 550 公里",
        value: 550,
        unit: "公里",
        evidence: {
          sourceName: "黄金样例车型配置表",
          sourceReference: "golden-vehicle-spec-v1#range",
          effectiveFrom: "2026-08-01",
        },
        requiredInVoiceover: true,
        requiredInSubtitle: true,
        mayRephrase: false,
        riskNotes: ["必须保留 CLTC 测试条件"],
      },
      {
        id: "claim_trunk_520",
        kind: "fixed",
        name: "后备厢空间",
        statement: "后备厢标准容积 520 升",
        value: 520,
        unit: "升",
        evidence: {
          sourceName: "黄金样例车型配置表",
          sourceReference: "golden-vehicle-spec-v1#trunk",
          effectiveFrom: "2026-08-01",
        },
        requiredInVoiceover: false,
        requiredInSubtitle: true,
        mayRephrase: false,
        riskNotes: [],
      },
    ],
    optionalClaims: [
      {
        id: "claim_family_space",
        kind: "extended",
        name: "家庭出行空间体验",
        statement: "五座布局兼顾家庭日常乘坐与储物需求",
        evidence: {
          sourceName: "黄金样例车型配置表",
          sourceReference: "golden-vehicle-spec-v1#seats-trunk",
          effectiveFrom: "2026-08-01",
        },
        requiredInVoiceover: false,
        requiredInSubtitle: false,
        mayRephrase: true,
        riskNotes: ["不得扩展为同级最大空间"],
      },
    ],
    prohibitedClaims: ["自动驾驶", "全国最低价", "同级第一", "零风险"],
    referenceAssetIds: ["asset_vehicle_front_001", "asset_vehicle_side_001", "asset_vehicle_rear_001"],
  },
];
