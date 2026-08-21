import assert from "node:assert/strict";
import test from "node:test";

import type {
  BatchProject,
  ProjectAssetPool,
  TaskContext,
  TemporaryAsset,
  WorkspaceAccessGrant,
} from "@firefly/schemas";
import {
  StageSuggestionContextAccessError,
  type CompanyAssetCatalogItem,
  type CompanyAssetProvider,
} from "@firefly/tools";

import {
  createAgentAssetMatchingCandidateReader,
  createCurrentProjectAssetPoolReader,
} from "../src/agent-asset-matching-candidates.ts";

const occurredAt = "2026-08-20T05:00:00.000Z";
const taskContext: TaskContext = {
  schemaVersion: 1,
  kind: "task_context",
  brand: { id: "brand_1", name: "品牌一" },
  vehicle: { id: "vehicle_1", displayName: "车型一", version: 2 },
  batchProject: { id: "project_1", name: "项目一", aspectRatio: "9:16" },
  videoTask: {
    id: "task_1",
    name: "任务一",
    status: "active",
    currentStage: "asset_matching",
    stageStatus: "in_progress",
    revision: 9,
    vehicleSnapshotId: "vehicle_snapshot_1",
    ownership: { state: "owned_by_current_account" },
  },
  productionBrief: {
    audience: "家庭用户",
    theme: "周末露营",
    durationSeconds: 30,
    platformTags: ["douyin"],
  },
};

const companyPerson = {
  source: "company_catalog" as const,
  sourceProvider: "mock-company-assets",
  assetId: "person_family",
  version: 3,
  category: "person" as const,
};
const companyVehicle = {
  source: "company_catalog" as const,
  sourceProvider: "mock-company-assets",
  assetId: "vehicle_hero",
  version: 4,
  category: "vehicle" as const,
  vehicleId: "vehicle_1",
};
const localScene = {
  source: "local_upload" as const,
  batchProjectId: "project_1",
  assetId: "local_scene",
  version: 2,
  category: "scene" as const,
  checksumSha256: "b".repeat(64),
};

const project: BatchProject = {
  id: "project_1",
  tenantId: "tenant_1",
  brandId: "brand_1",
  vehicleId: "vehicle_1",
  vehicleVersion: 2,
  name: "项目一",
  batchName: "批次一",
  aspectRatio: "9:16",
  visualStylePresetId: "style_1",
  assetPoolId: "pool_1",
  status: "active",
  revision: 1,
  createdAt: occurredAt,
  createdBy: "account_1",
  updatedAt: occurredAt,
  updatedBy: "account_1",
};

const accessGrant: WorkspaceAccessGrant = {
  id: "grant_1",
  tenantId: "tenant_1",
  accountId: "account_1",
  access: { kind: "vehicle_project", brandId: "brand_1", vehicleId: "vehicle_1" },
  status: "active",
  revision: 1,
  createdAt: occurredAt,
  createdBy: "account_admin",
  updatedAt: occurredAt,
  updatedBy: "account_admin",
};

function projectPool(overrides: Partial<ProjectAssetPool> = {}): ProjectAssetPool {
  return {
    id: "pool_1",
    tenantId: "tenant_1",
    batchProjectId: "project_1",
    vehicleId: "vehicle_1",
    revision: 7,
    assets: [
      companyVehicle,
      companyPerson,
      localScene,
    ],
    createdAt: occurredAt,
    createdBy: "account_1",
    updatedAt: occurredAt,
    updatedBy: "account_1",
    ...overrides,
  };
}

function temporaryAsset(overrides: Partial<TemporaryAsset> = {}): TemporaryAsset {
  return {
    id: "local_scene",
    tenantId: "tenant_1",
    batchProjectId: "project_1",
    vehicleId: "vehicle_1",
    version: 2,
    revision: 3,
    category: "scene",
    fileName: "湖畔露营.webp",
    mediaType: "image/webp",
    byteSize: 1024,
    width: 1440,
    height: 1920,
    checksumSha256: "b".repeat(64),
    sourceDescription: "湖畔草地、暖色帐篷和家庭互动",
    rightsDeclaration: "项目自有拍摄素材",
    rightsConfirmed: true,
    validationStatus: "valid",
    validationIssues: [],
    createdAt: occurredAt,
    createdBy: "account_1",
    updatedAt: occurredAt,
    updatedBy: "account_1",
    ...overrides,
  };
}

const catalogItem: CompanyAssetCatalogItem = {
  reference: companyPerson,
  displayName: "年轻家庭三人组",
  description: "适合家庭周末露营和后备箱空间展示",
  brandIds: ["brand_1"],
  tags: ["家庭", "露营"],
  preview: { mediaType: "image/webp", width: 1440, height: 1920 },
  updatedAt: occurredAt,
};
const vehicleCatalogItem: CompanyAssetCatalogItem = {
  reference: companyVehicle,
  displayName: "车型一整车左前视角",
  description: "项目车型外观画面",
  brandIds: ["brand_1"],
  tags: ["整车", "外观"],
  preview: { mediaType: "image/webp", width: 1920, height: 1080 },
  updatedAt: occurredAt,
};

function provider(resolve: CompanyAssetProvider["resolveAssets"]): CompanyAssetProvider {
  return {
    providerId: "mock-company-assets",
    async searchAssets() {
      throw new Error("AG-307 must not search the whole company catalog.");
    },
    resolveAssets: resolve,
  };
}

function reader(options: {
  pool?: ProjectAssetPool;
  temporary?: TemporaryAsset[];
  companyProvider?: CompanyAssetProvider;
} = {}) {
  return createAgentAssetMatchingCandidateReader({
    taskContext,
    currentProjectAssetPool: {
      batchProjectId: "project_1",
      async read() { return structuredClone(options.pool ?? projectPool()); },
    },
    temporaryAssets: {
      async loadProject() { return structuredClone(options.temporary ?? [temporaryAsset()]); },
      async transactProject() { throw new Error("not used"); },
    },
    companyAssets: options.companyProvider ?? provider(async (references) => {
      assert.deepEqual(references, [companyVehicle, companyPerson]);
      return {
        items: [structuredClone(vehicleCatalogItem), structuredClone(catalogItem)],
        missingReferences: [],
      };
    }),
    companyAssetScope: {
      tenantId: "tenant_1",
      actorAccountId: "account_1",
      allowedBrandIds: ["brand_1"],
      allowedVehicleIds: ["vehicle_1"],
    },
    now: () => occurredAt,
  });
}

test("Agent asset matching candidates come only from the exact project pool versions", async () => {
  const result = await reader().read();
  assert.equal(result.projectAssetPoolRevision, 7);
  assert.deepEqual(
    result.companyCandidates.map((item) => item.reference),
    [companyVehicle, companyPerson],
  );
  assert.equal(result.companyCandidates[1]?.description, "适合家庭周末露营和后备箱空间展示");
  assert.deepEqual(result.localCandidates, [{
    reference: localScene,
    displayName: "湖畔露营.webp",
    description: "湖畔草地、暖色帐篷和家庭互动",
    sourceStatus: "requires_manual_review",
  }]);
});

test("Agent candidate pool refresh uses the current authorized project runtime", async () => {
  let observedScope: unknown;
  const currentPool = createCurrentProjectAssetPoolReader({
    taskContext,
    administration: {
      async withSnapshot(tenantId, inspect) {
        assert.equal(tenantId, "tenant_1");
        return inspect({
          schemaVersion: 1,
          tenantId,
          brands: [],
          vehicleVersions: [],
          vehicleAssetAssociations: [],
          accessGrants: [accessGrant],
        });
      },
    },
    projects: {
      async load(tenantId, projectId) {
        assert.equal(tenantId, "tenant_1");
        assert.equal(projectId, "project_1");
        return {
          requestId: "request_1",
          actorAccountId: "account_1",
          payloadHash: "hash_1",
          project,
          assetPool: projectPool(),
        };
      },
    },
    projectAssets: {
      async getCurrentPool(receivedProject, scope) {
        assert.deepEqual(receivedProject, project);
        observedScope = structuredClone(scope);
        return projectPool({ revision: 8 });
      },
    },
    actor: { tenantId: "tenant_1", accountId: "account_1", role: "creator" },
  });

  assert.equal((await currentPool.read()).revision, 8);
  assert.deepEqual(observedScope, {
    tenantId: "tenant_1",
    actorAccountId: "account_1",
    role: "creator",
    accessGrants: [accessGrant],
  });
});

test("Agent asset matching candidates fail closed for stale catalog and local project assets", async () => {
  const missingCompany = reader({
    companyProvider: provider(async (references) => ({
      items: [],
      missingReferences: structuredClone(references),
    })),
  });
  const invalidLocal = reader({
    temporary: [temporaryAsset({ validationStatus: "needs_review" })],
  });
  const wrongTenant = reader({ pool: projectPool({ tenantId: "tenant_other" }) });
  const missingDescription = reader({
    companyProvider: provider(async () => {
      const { description: _description, ...withoutDescription } = structuredClone(catalogItem);
      return { items: [withoutDescription], missingReferences: [] };
    }),
  });

  for (const candidateReader of [missingCompany, invalidLocal, wrongTenant, missingDescription]) {
    await assert.rejects(
      () => candidateReader.read(),
      StageSuggestionContextAccessError,
    );
  }
});
