import { isDeepStrictEqual } from "node:util";

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
const c10ProjectId = "batch_project_leapmotor_c10_assets_v1";
const c10AssetPoolId = "project_asset_pool_leapmotor_c10_assets_v1";
const c10ProjectRequestId = "request_import_leapmotor_c10_assets_v1";
const c10TaskRequestId = "request_import_leapmotor_c10_acceptance_task_v1";

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

const c10Vehicle: Vehicle = {
  id: LEAPMOTOR_C10_MOCK_ASSET_BINDING.vehicleId,
  tenantId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.tenantId,
  brandId: LEAPMOTOR_C10_MOCK_ASSET_BINDING.brandId,
  version: 1,
  status: "active",
  series: "零跑 C10",
  modelYear: 2026,
  trim: "素材测试版",
  parameters: {
    factCompleteness: "pending_admin_verification",
  },
  fixedClaims: [{
    id: "claim_leapmotor_c10_model_identity",
    kind: "fixed",
    name: "车型标识",
    statement: "本项目车型标识为零跑 C10",
    evidence: {
      sourceName: "工作区管理员车型目录",
      sourceReference: "workspace-admin/vehicle_leapmotor_c10_demo#identity",
      effectiveFrom: "2026-08-21",
    },
    requiredInVoiceover: false,
    requiredInSubtitle: false,
    mayRephrase: false,
    riskNotes: ["除车型标识外，任何参数或卖点均须由管理员补充官方证据后使用"],
  }],
  optionalClaims: [],
  prohibitedClaims: ["不得根据图片推断配置、性能、续航、价格、安全或排名"],
  createdAt: importedAt,
  createdBy: administratorId,
  updatedAt: importedAt,
  updatedBy: administratorId,
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
  ...creatorIds.map((accountId): WorkspaceAccessGrant => ({
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
  })),
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
      [...DEFAULT_ADMIN_VEHICLES, c10Vehicle],
      (record) => `${record.id}:${record.version}`,
    ),
    vehicleAssetAssociations: mergeByIdentity(
      current.vehicleAssetAssociations,
      [...DEFAULT_VEHICLE_ASSET_ASSOCIATIONS, c10Association],
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
        vehicleId: c10Vehicle.id,
        expectedBrandRevision: c10Brand.revision,
        expectedVehicleVersion: c10Vehicle.version,
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
      vehicleId: c10Vehicle.id,
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

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : "C10 bootstrap failed.") + "\n");
  process.exitCode = 1;
});
