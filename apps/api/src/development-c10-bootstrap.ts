import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import type {
  Brand,
  CompanyAssetReference,
  Vehicle,
  VehicleAssetAssociation,
  WorkspaceAccessGrant,
} from "@firefly/schemas";
import {
  LEAPMOTOR_C10_MOCK_ASSET_BINDING,
  MockCompanyAssetProvider,
  mockCompanyAssetMediaManifest,
} from "@firefly/tools";

import { parsePostgresDatabaseConfig } from "./database-config.ts";
import { loadDatabaseMigrations, verifyDatabaseSchema } from "./database-migrations.ts";
import { PostgresBatchProjectStore } from "./postgres-batch-project-store.ts";
import { createPostgresDatabase } from "./postgres-database.ts";
import { PostgresVideoTaskProductionStore } from "./postgres-video-task-store.ts";
import { PostgresWorkspaceAdminStore } from "./postgres-workspace-admin-store.ts";
import { ProjectCreationRuntime } from "./project-creation-runtime.ts";
import { VideoTaskRuntime } from "./video-task-runtime.ts";
import {
  DEFAULT_ADMIN_BRANDS,
  DEFAULT_ADMIN_VEHICLES,
  DEFAULT_VEHICLE_ASSET_ASSOCIATIONS,
} from "./workspace-admin-runtime.ts";
import {
  DEVELOPMENT_ACCOUNTS,
  DEVELOPMENT_ACCESS_GRANTS,
  type DevelopmentAccount,
} from "./workspace-session-runtime.ts";
import type { WorkspaceAdminState } from "./workspace-admin-store.ts";

const importedAt = "2026-08-21T00:00:00.000Z";
const administratorId = "account_admin";
const creatorIds = ["account_creator_a", "account_creator_b"] as const;
const c10ProjectId = "batch_project_leapmotor_c10_assets_v2";
const c10AssetPoolId = "project_asset_pool_leapmotor_c10_assets_v2";
const c10ProjectRequestId = "request_import_leapmotor_c10_assets_v2";
const c10TaskRequestId = "request_import_leapmotor_c10_acceptance_task_v2";

const c10Brand: Brand = {
  id: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId,
  tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
  name: "零跑汽车",
  status: "active",
  revision: 1,
  defaultVisualStylePresetId: "asset_style_global_clean",
  createdAt: importedAt,
  createdBy: administratorId,
  updatedAt: importedAt,
  updatedBy: administratorId,
};

const c10FactEvidence = {
  sourceName: "用户提供的 C10 策略卖点资料（本地测试）",
  sourceReference: "策略卖点.md",
  effectiveFrom: "2026-08-21",
} as const;

function c10Claim(
  id: string,
  name: string,
  statement: string,
  riskNotes: readonly string[] = [],
): Vehicle["optionalClaims"][number] {
  return {
    id,
    kind: "extended",
    name,
    statement,
    evidence: c10FactEvidence,
    requiredInVoiceover: false,
    requiredInSubtitle: false,
    mayRephrase: true,
    riskNotes: [...riskNotes, "当前资料用于本地流程测试，正式投放前须由内容管理员复核官方来源与适用配置"],
  };
}

const c10CommonClaims: Vehicle["optionalClaims"] = [
  c10Claim("claim_c10_body", "车身尺寸", "零跑 C10 车身尺寸为 4739×1900×1680mm，轴距为 2825mm，采用大五座布局。"),
  c10Claim("claim_c10_architecture", "车型架构", "零跑 C10 采用 LEAP 3.0 零跑自研架构。"),
  c10Claim("claim_c10_space", "家用空间", "零跑 C10 后排空间宽裕，后排座椅可放倒以拓展后备箱装载空间。"),
  c10Claim("claim_c10_display", "智能座舱屏幕", "零跑 C10 配备 14.6 英寸 2.5K 中控屏，并使用 Leapmotor OS 交互系统和 AI 大模型语音助手。"),
  c10Claim("claim_c10_audio", "座舱音响", "适用配置的零跑 C10 配备 18 扬声器、2088W、7.1 声道音响及主驾头枕私享音区。", ["仅可用于实际配备该音响系统的配置版本"]),
  c10Claim("claim_c10_seat", "舒适座椅", "适用配置的零跑 C10 主副驾支持通风、加热和 10 点按摩，主驾配备 4 向气动腰托。", ["不得表述为全系标配"]),
  c10Claim("claim_c10_material", "环保内饰", "零跑 C10 使用 Oeko-Tex 环保内饰面料。", ["不得把材料认证扩展为医疗、母婴安全或绝对无害承诺"]),
  c10Claim("claim_c10_body_safety", "车身与电池安全技术", "零跑 C10 采用 CTC 2.0 电池底盘一体化技术、2000MPa 热成型钢及 AI-BMS 电池热管理系统。", ["不得使用“核潜艇级”等无法独立验证的类比作为安全结论"]),
  c10Claim("claim_c10_chassis", "底盘稳定控制", "零跑 C10 采用 LMC 一体化运动融合底盘，并具备爆胎稳定控制能力。", ["不得扩展为绝对安全或零事故承诺"]),
];

export const c10PureElectricVehicle: Vehicle = {
  id: LEAPMOTOR_C10_MOCK_ASSET_BINDING.vehicleId,
  tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
  brandId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId,
  version: 2,
  status: "active",
  series: "零跑 C10",
  modelYear: 2026,
  trim: "2026 焕新版纯电 660km（本地资料版）",
  parameters: {},
  fixedClaims: [{
    id: "claim_leapmotor_c10_model_identity",
    kind: "fixed",
    name: "车型标识",
    statement: "本项目车型为零跑 C10 2026 焕新版纯电 660km 版本。",
    evidence: {
      sourceName: "工作区管理员车型目录",
      sourceReference: "策略卖点.md#纯电版",
      effectiveFrom: "2026-08-21",
    },
    requiredInVoiceover: false,
    requiredInSubtitle: false,
    mayRephrase: false,
    riskNotes: ["当前资料用于本地流程测试，正式投放前须复核准确的官方配置名称"],
  }],
  optionalClaims: [
    ...c10CommonClaims,
    c10Claim("claim_c10_ev_range", "纯电续航与电池", "该版本 CLTC 续航为 660km，电池容量为 81.9kWh。"),
    c10Claim("claim_c10_ev_charge", "800V 与快速充电", "该版本采用 800V 高压平台和 3C 快充，资料标注电量从 30% 充至 80% 需 16 分钟。", ["充电时间须同时保留 30% 至 80% 的测试区间"]),
    c10Claim("claim_c10_ev_power", "纯电动力", "该版本采用后置单电机，最大功率 230kW、最大扭矩 360N·m，资料标注 0 至 100km/h 加速时间为 6.02 秒。"),
    c10Claim("claim_c10_ev_adas", "高阶辅助驾驶", "仅激光雷达配置搭载 128 线禾赛激光雷达，并支持城市 NAP、高速领航、记忆泊车和遥控泊车。", ["必须明确限定为激光雷达配置，不得称为自动驾驶"]),
    c10Claim("claim_c10_ev_cockpit_chip", "高阶座舱芯片", "高阶配置搭载高通 8295 座舱芯片。", ["不得表述为全系标配"]),
  ],
  prohibitedClaims: ["自动驾驶", "全系标配", "绝对安全", "零事故", "全国最低价"],
  createdAt: importedAt,
  createdBy: administratorId,
  updatedAt: importedAt,
  updatedBy: administratorId,
};

export const c10ExtendedRangeVehicle: Vehicle = {
  ...structuredClone(c10PureElectricVehicle),
  id: "vehicle_leapmotor_c10_2026_erev_290",
  version: 1,
  trim: "2026 焕新版增程 290km（本地资料版）",
  fixedClaims: [{
    ...structuredClone(c10PureElectricVehicle.fixedClaims[0]!),
    id: "claim_c10_erev_identity",
    statement: "本项目车型为零跑 C10 2026 焕新版增程 290km 版本。",
    evidence: { ...c10FactEvidence, sourceReference: "策略卖点.md#增程版" },
  }],
  optionalClaims: [
    ...structuredClone(c10CommonClaims),
    c10Claim("claim_c10_erev_range", "增程续航", "该版本 CLTC 纯电续航为 290km，资料标注综合续航为 1300km。", ["纯电续航与综合续航必须分别表述"]),
    c10Claim("claim_c10_erev_power", "增程动力", "该版本采用 200kW 后置驱动电机，可油可电。", ["不得扩展为无续航焦虑等绝对化承诺"]),
    c10Claim("claim_c10_erev_adas", "高阶辅助驾驶", "仅激光雷达配置搭载 128 线禾赛激光雷达，并支持城市 NAP、高速领航、记忆泊车和遥控泊车。", ["必须明确限定为激光雷达配置，不得称为自动驾驶"]),
    c10Claim("claim_c10_erev_cockpit_chip", "高阶座舱芯片", "高阶配置搭载高通 8295 座舱芯片。", ["不得表述为全系标配"]),
  ],
};

const c10References: CompanyAssetReference[] = mockCompanyAssetMediaManifest.map((entry) => ({
  assetId: entry.assetId,
  version: entry.version,
  source: "company_catalog",
  sourceProvider: "mock_company_assets",
  category: "vehicle",
  vehicleId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.vehicleId,
}));

const c10Association: VehicleAssetAssociation = {
  id: "vehicle_asset_association_leapmotor_c10_v1",
  tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
  brandId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId,
  vehicleId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.vehicleId,
  revision: 1,
  assets: [
    ...c10References,
    {
      assetId: "asset_style_global_clean",
      version: 1,
      source: "company_catalog",
      sourceProvider: "mock_company_assets",
      category: "visual_style",
    },
  ],
  createdAt: importedAt,
  createdBy: administratorId,
  updatedAt: importedAt,
  updatedBy: administratorId,
};

const c10ExtendedRangeAssociation: VehicleAssetAssociation = {
  id: "vehicle_asset_association_leapmotor_c10_erev_290_v1",
  tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
  brandId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId,
  vehicleId: c10ExtendedRangeVehicle.id,
  revision: 1,
  assets: [{
    assetId: "asset_style_global_clean",
    version: 1,
    source: "company_catalog",
    sourceProvider: "mock_company_assets",
    category: "visual_style",
  }],
  createdAt: importedAt,
  createdBy: administratorId,
  updatedAt: importedAt,
  updatedBy: administratorId,
};

const c10Grants: WorkspaceAccessGrant[] = [
  {
    id: "grant_admin_leapmotor_c10",
    tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
    accountId: administratorId,
    access: { kind: "brand", brandId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId },
    status: "active",
    revision: 1,
    createdAt: importedAt,
    createdBy: administratorId,
    updatedAt: importedAt,
    updatedBy: administratorId,
  },
  ...creatorIds.flatMap((accountId): WorkspaceAccessGrant[] => [
    {
      id: `grant_${accountId}_leapmotor_c10`,
      tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
      accountId,
      access: {
        kind: "vehicle_project",
        brandId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId,
        vehicleId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.vehicleId,
      },
      status: "active",
      revision: 1,
      createdAt: importedAt,
      createdBy: administratorId,
      updatedAt: importedAt,
      updatedBy: administratorId,
    },
    {
      id: `grant_${accountId}_leapmotor_c10_erev_290`,
      tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
      accountId,
      access: {
        kind: "vehicle_project",
        brandId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId,
        vehicleId: c10ExtendedRangeVehicle.id,
      },
      status: "active",
      revision: 1,
      createdAt: importedAt,
      createdBy: administratorId,
      updatedAt: importedAt,
      updatedBy: administratorId,
    },
  ]),
];

function mergeByIdentity<RecordType>(
  current: readonly RecordType[],
  required: readonly RecordType[],
  identity: (record: Readonly<RecordType>) => string,
): RecordType[] {
  const merged = structuredClone([...current]);
  const existing = new Map(merged.map((record) => [identity(record), record] as const));
  for (const record of required) {
    const key = identity(record);
    const found = existing.get(key);
    if (found !== undefined) {
      if (!isDeepStrictEqual(found, record)) {
        throw new Error(`Bootstrap record '${key}' already exists with different content.`);
      }
      continue;
    }
    const copy = structuredClone(record);
    merged.push(copy);
    existing.set(key, copy);
  }
  return merged;
}

function bootstrapAdministration(current: Readonly<WorkspaceAdminState>): WorkspaceAdminState {
  return {
    ...structuredClone(current),
    brands: mergeByIdentity(
      current.brands,
      [...DEFAULT_ADMIN_BRANDS, c10Brand],
      (record) => record.id,
    ),
    vehicleVersions: mergeByIdentity(
      current.vehicleVersions,
      [...DEFAULT_ADMIN_VEHICLES, c10PureElectricVehicle, c10ExtendedRangeVehicle],
      (record) => `${record.id}:${record.version}`,
    ),
    vehicleAssetAssociations: mergeByIdentity(
      current.vehicleAssetAssociations,
      [...DEFAULT_VEHICLE_ASSET_ASSOCIATIONS, c10Association, c10ExtendedRangeAssociation],
      (record) => record.vehicleId,
    ),
    accessGrants: mergeByIdentity(
      current.accessGrants,
      [...DEVELOPMENT_ACCESS_GRANTS, ...c10Grants],
      (record) => record.id,
    ),
  };
}

async function main(): Promise<void> {
  if (mockCompanyAssetMediaManifest.length !== 55) {
    throw new Error("The C10 media manifest must contain exactly 55 assets.");
  }
  const database = createPostgresDatabase(parsePostgresDatabaseConfig(process.env));
  try {
    await verifyDatabaseSchema(database, await loadDatabaseMigrations());
    const administration = new PostgresWorkspaceAdminStore(database);
    const projects = new PostgresBatchProjectStore(database);
    const tasks = new PostgresVideoTaskProductionStore(database);
    const state = await administration.transact(
      LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
      bootstrapAdministration,
    );
    const creatorAccount: DevelopmentAccount = {
      accountId: creatorIds[0],
      tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
      displayName: "制作账号 A",
      role: "creator",
    };
    const projectCreation = new ProjectCreationRuntime(
      administration,
      projects,
      new MockCompanyAssetProvider(),
      () => importedAt,
      (kind) => kind === "batch_project" ? c10ProjectId : c10AssetPoolId,
    );
    const project = await projectCreation.create(
      {
        requestId: c10ProjectRequestId,
        vehicleId: c10PureElectricVehicle.id,
        expectedBrandRevision: c10Brand.revision,
        expectedVehicleVersion: c10PureElectricVehicle.version,
        expectedAssetAssociationRevision: c10Association.revision,
        selectedAssets: c10References,
        aspectRatio: "9:16",
        batchName: "C10 素材池导入",
      },
      {
        actorAccountId: creatorAccount.accountId,
        tenantId: creatorAccount.tenantId,
        role: creatorAccount.role,
        accessGrants: state.accessGrants.filter(
          (grant) => grant.accountId === creatorAccount.accountId,
        ),
      },
    );
    const taskOwner = DEVELOPMENT_ACCOUNTS.find(
      (account) => account.accountId === creatorIds[1],
    );
    if (taskOwner === undefined) throw new Error("The C10 acceptance task owner is unavailable.");
    const videoTasks = new VideoTaskRuntime(
      administration,
      projects,
      tasks,
      () => DEVELOPMENT_ACCOUNTS,
      () => importedAt,
    );
    const task = await videoTasks.create(
      project.project.id,
      {
        requestId: c10TaskRequestId,
        name: "C10 素材与 Agent 验收",
        audience: "本地开发验收人员",
        theme: "验证 C10 项目素材池与任务级 Agent 对话",
        durationSeconds: 15,
        platformTags: ["local_acceptance"],
        ownerAccountId: taskOwner.accountId,
      },
      {
        actorAccountId: taskOwner.accountId,
        tenantId: taskOwner.tenantId,
        role: taskOwner.role,
        accessGrants: state.accessGrants.filter(
          (grant) => grant.accountId === taskOwner.accountId,
        ),
      },
    );
    process.stdout.write(JSON.stringify({
      tenantId: state.tenantId,
      brandId: c10Brand.id,
      vehicleId: c10PureElectricVehicle.id,
      availableVehicleVersions: [
        { vehicleId: c10PureElectricVehicle.id, version: c10PureElectricVehicle.version, trim: c10PureElectricVehicle.trim },
        { vehicleId: c10ExtendedRangeVehicle.id, version: c10ExtendedRangeVehicle.version, trim: c10ExtendedRangeVehicle.trim },
      ],
      projectId: project.project.id,
      projectName: project.project.name,
      importedC10Assets: c10References.length,
      projectAssetPoolEntries: project.assetPool.assets.length,
      projectReplayed: project.replayed,
      taskId: task.record.videoTask.id,
      taskReplayed: task.replayed,
    }) + "\n");
  } finally {
    await database.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : "C10 bootstrap failed.") + "\n");
    process.exitCode = 1;
  });
}
