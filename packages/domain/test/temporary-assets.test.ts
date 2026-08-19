import assert from "node:assert/strict";
import test from "node:test";

import type {
  BatchProject,
  CompanyVehicleAssetReference,
  ProjectAssetPool,
  TemporaryAsset,
} from "@firefly/schemas";

import {
  addTemporaryAssetToProjectPool,
  registerTemporaryAsset,
  TemporaryAssetError,
  type RegisterTemporaryAssetCommand,
  type TemporaryAssetErrorCode,
  type TemporaryAssetMutationContext,
  updateTemporaryAssetDeclaration,
  validateTemporaryAsset,
} from "../src/temporary-assets.ts";
import { RevisionConflictError } from "../src/workflow.ts";

const project: BatchProject = {
  id: "project_launch",
  tenantId: "tenant_firefly",
  brandId: "brand_firefly",
  vehicleId: "vehicle_e5",
  vehicleVersion: 1,
  name: "萤火 E5 9:16 上市",
  batchName: "上市",
  aspectRatio: "9:16",
  visualStylePresetId: "style_default",
  assetPoolId: "asset_pool_e5",
  status: "active",
  revision: 1,
  createdAt: "2026-08-18T08:00:00.000Z",
  createdBy: "account_owner",
  updatedAt: "2026-08-18T08:00:00.000Z",
  updatedBy: "account_owner",
};

function context(
  overrides: Partial<TemporaryAssetMutationContext> = {},
): TemporaryAssetMutationContext {
  return {
    tenantId: project.tenantId,
    actorAccountId: "account_uploader",
    occurredAt: "2026-08-19T08:00:00.000Z",
    createId: () => "temporary_asset_1",
    ...overrides,
  };
}

function command(
  overrides: Partial<RegisterTemporaryAssetCommand> = {},
): RegisterTemporaryAssetCommand {
  return {
    category: "scene",
    fileName: "camping.png",
    mediaType: "image/png",
    byteSize: 2_048_000,
    width: 1920,
    height: 1080,
    checksumSha256: "A".repeat(64),
    sourceDescription: " 项目成员拍摄 ",
    rightsDeclaration: " 已取得本项目广告使用授权 ",
    rightsConfirmed: true,
    ...overrides,
  };
}

function temporaryAsset(
  overrides: Partial<TemporaryAsset> = {},
): TemporaryAsset {
  return {
    id: "temporary_asset_1",
    tenantId: project.tenantId,
    batchProjectId: project.id,
    vehicleId: project.vehicleId,
    version: 1,
    revision: 1,
    category: "scene",
    fileName: "camping.png",
    mediaType: "image/png",
    byteSize: 2_048_000,
    width: 1920,
    height: 1080,
    checksumSha256: "a".repeat(64),
    sourceDescription: "项目成员拍摄",
    rightsDeclaration: "已取得本项目广告使用授权",
    rightsConfirmed: true,
    validationStatus: "pending",
    validationIssues: [],
    createdAt: "2026-08-19T08:00:00.000Z",
    createdBy: "account_uploader",
    updatedAt: "2026-08-19T08:00:00.000Z",
    updatedBy: "account_uploader",
    ...overrides,
  };
}

const vehicleReference: CompanyVehicleAssetReference = {
  assetId: "asset_vehicle_e5",
  version: 1,
  source: "company_catalog",
  sourceProvider: "mock_company_assets",
  category: "vehicle",
  vehicleId: project.vehicleId,
};

function pool(overrides: Partial<ProjectAssetPool> = {}): ProjectAssetPool {
  return {
    id: "asset_pool_e5",
    tenantId: project.tenantId,
    batchProjectId: project.id,
    vehicleId: project.vehicleId,
    revision: 3,
    assets: [vehicleReference],
    createdAt: "2026-08-18T08:00:00.000Z",
    createdBy: "account_owner",
    updatedAt: "2026-08-18T09:00:00.000Z",
    updatedBy: "account_owner",
    ...overrides,
  };
}

function temporaryAssetError(code: TemporaryAssetErrorCode): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof TemporaryAssetError);
    assert.equal(error.code, code);
    return true;
  };
}

test("registerTemporaryAsset creates a project-scoped pending record from server identity", () => {
  const result = registerTemporaryAsset(project, command(), context());

  assert.equal(result.id, "temporary_asset_1");
  assert.equal(result.tenantId, project.tenantId);
  assert.equal(result.batchProjectId, project.id);
  assert.equal(result.vehicleId, project.vehicleId);
  assert.equal(result.createdBy, "account_uploader");
  assert.equal(result.updatedBy, "account_uploader");
  assert.equal(result.version, 1);
  assert.equal(result.revision, 1);
  assert.equal(result.validationStatus, "pending");
  assert.deepEqual(result.validationIssues, []);
  assert.equal(result.checksumSha256, "a".repeat(64));
  assert.equal(result.sourceDescription, "项目成员拍摄");
  assert.equal(result.rightsDeclaration, "已取得本项目广告使用授权");
});

test("registerTemporaryAsset rejects foreign tenant scope and structurally invalid metadata", () => {
  assert.throws(
    () => registerTemporaryAsset(project, command(), context({ tenantId: "tenant_other" })),
    temporaryAssetError("AIC-ASSET-TEMPORARY_SCOPE_INVALID"),
  );
  assert.throws(
    () =>
      registerTemporaryAsset(
        { ...project, status: "archived" },
        command(),
        context(),
      ),
    temporaryAssetError("AIC-ASSET-TEMPORARY_SCOPE_INVALID"),
  );
  for (const invalid of [
    command({ fileName: "../escape.png" }),
    command({ checksumSha256: "bad" }),
    command({ width: 0 }),
    command({ sourceDescription: " " }),
    command({ rightsDeclaration: " " }),
  ]) {
    assert.throws(
      () => registerTemporaryAsset(project, invalid, context()),
      temporaryAssetError("AIC-ASSET-TEMPORARY_METADATA_INVALID"),
    );
  }
  assert.throws(
    () =>
      registerTemporaryAsset(
        project,
        command({ expiresAt: "2026-08-19T07:59:59.000Z" }),
        context(),
      ),
    temporaryAssetError("AIC-ASSET-TEMPORARY_METADATA_INVALID"),
  );
  assert.throws(
    () => registerTemporaryAsset(project, command(), context({ occurredAt: "not-a-date" })),
    temporaryAssetError("AIC-ASSET-TEMPORARY_METADATA_INVALID"),
  );
});

test("validateTemporaryAsset accepts the supported image and video format-extension pairs", () => {
  const formats = [
    ["photo.jpg", "image/jpeg"],
    ["photo.JPEG", "image/jpeg"],
    ["photo.png", "image/png"],
    ["photo.webp", "image/webp"],
    ["clip.mp4", "video/mp4"],
    ["clip.webm", "video/webm"],
  ] as const;

  for (const [fileName, mediaType] of formats) {
    const current = temporaryAsset({ fileName, mediaType });
    const result = validateTemporaryAsset(current, project, [current], 1, context());
    assert.equal(result.validationStatus, "valid", `${mediaType} ${fileName}`);
    assert.deepEqual(result.validationIssues, []);
  }
});

test("validateTemporaryAsset rejects unsupported, mismatched, oversized, or undersized media", () => {
  const current = temporaryAsset({
    fileName: "clip.png",
    mediaType: "video/mp4",
    byteSize: 500_000_001,
    width: 1280,
    height: 719,
  });
  const result = validateTemporaryAsset(current, project, [], 1, context());

  assert.equal(result.validationStatus, "rejected");
  assert.deepEqual(
    result.validationIssues.map(({ code }) => code),
    [
      "AIC-ASSET-EXTENSION_MISMATCH",
      "AIC-ASSET-FILE_TOO_LARGE",
      "AIC-ASSET-DIMENSIONS_TOO_SMALL",
    ],
  );
  assert.equal(current.validationStatus, "pending");

  const unsupported = validateTemporaryAsset(
    temporaryAsset({ fileName: "animation.gif", mediaType: "image/gif" }),
    project,
    [],
    1,
    context(),
  );
  assert.equal(unsupported.validationStatus, "rejected");
  assert.equal(unsupported.validationIssues[0]?.code, "AIC-ASSET-FORMAT_UNSUPPORTED");

  const expired = validateTemporaryAsset(
    temporaryAsset({ expiresAt: "2026-08-19T07:59:59.000Z" }),
    project,
    [],
    1,
    context(),
  );
  assert.equal(expired.validationStatus, "rejected");
  assert.equal(expired.validationIssues[0]?.code, "AIC-ASSET-EXPIRED");
});

test("validateTemporaryAsset sends duplicates and unconfirmed rights to review", () => {
  const current = temporaryAsset({ rightsConfirmed: false });
  const duplicate = temporaryAsset({
    id: "temporary_asset_existing",
    checksumSha256: current.checksumSha256.toUpperCase(),
    createdAt: "2026-08-19T07:59:00.000Z",
  });
  const result = validateTemporaryAsset(current, project, [current, duplicate], 1, context());

  assert.equal(result.validationStatus, "needs_review");
  assert.equal(result.duplicateOfAssetId, duplicate.id);
  assert.deepEqual(
    result.validationIssues.map(({ code }) => code),
    ["AIC-ASSET-DUPLICATE", "AIC-ASSET-RIGHTS_UNCONFIRMED"],
  );
});

test("duplicate validation keeps the earliest registration canonical", () => {
  const earliest = temporaryAsset({
    id: "temporary_asset_earliest",
    createdAt: "2026-08-19T07:00:00.000Z",
  });
  const later = temporaryAsset({
    id: "temporary_asset_later",
    createdAt: "2026-08-19T09:00:00.000Z",
  });

  assert.equal(
    validateTemporaryAsset(earliest, project, [later], 1, context()).validationStatus,
    "valid",
  );
  const laterResult = validateTemporaryAsset(later, project, [earliest], 1, context());
  assert.equal(laterResult.validationStatus, "needs_review");
  assert.equal(laterResult.duplicateOfAssetId, earliest.id);
});

test("validateTemporaryAsset ignores same checksums outside the current project", () => {
  const current = temporaryAsset();
  const foreign = temporaryAsset({
    id: "temporary_asset_foreign",
    batchProjectId: "project_other",
  });
  const result = validateTemporaryAsset(current, project, [foreign], 1, context());
  assert.equal(result.validationStatus, "valid");
  assert.equal(result.duplicateOfAssetId, undefined);
});

test("updateTemporaryAssetDeclaration uses expected revision and returns to pending", () => {
  const current = temporaryAsset({
    revision: 2,
    validationStatus: "needs_review",
    validationIssues: [{ code: "AIC-ASSET-RIGHTS_UNCONFIRMED", message: "Confirm rights." }],
    duplicateOfAssetId: "temporary_asset_existing",
    expiresAt: "2026-09-01T00:00:00.000Z",
  });
  const result = updateTemporaryAssetDeclaration(
    current,
    project,
    {
      sourceDescription: " 新来源说明 ",
      rightsDeclaration: " 新授权声明 ",
      rightsConfirmed: true,
    },
    2,
    context({ actorAccountId: "account_reviewer", occurredAt: "2026-08-19T09:00:00.000Z" }),
  );

  assert.equal(result.revision, 3);
  assert.equal(result.version, 1);
  assert.equal(result.validationStatus, "pending");
  assert.deepEqual(result.validationIssues, []);
  assert.equal(result.duplicateOfAssetId, undefined);
  assert.equal(result.expiresAt, undefined);
  assert.equal(result.sourceDescription, "新来源说明");
  assert.equal(result.rightsConfirmed, true);
  assert.equal(result.updatedBy, "account_reviewer");
  assert.equal(current.revision, 2);
  assert.equal(current.validationStatus, "needs_review");
});

test("declaration update and validation reject stale revisions or cross-project assets", () => {
  const current = temporaryAsset({ revision: 2 });
  assert.throws(
    () =>
      updateTemporaryAssetDeclaration(
        current,
        project,
        command(),
        1,
        context(),
      ),
    RevisionConflictError,
  );
  assert.throws(
    () => validateTemporaryAsset(current, project, [], 1, context()),
    RevisionConflictError,
  );
  assert.throws(
    () => validateTemporaryAsset(temporaryAsset({ batchProjectId: "project_other" }), project, [], 1, context()),
    temporaryAssetError("AIC-ASSET-TEMPORARY_SCOPE_INVALID"),
  );
});

test("valid and rejected binary versions are terminal for validation and declaration edits", () => {
  const valid = temporaryAsset({ validationStatus: "valid" });
  const rejected = temporaryAsset({
    validationStatus: "rejected",
    validationIssues: [{ code: "AIC-ASSET-FORMAT_UNSUPPORTED", message: "Unsupported." }],
  });
  for (const terminal of [valid, rejected]) {
    assert.throws(
      () => validateTemporaryAsset(terminal, project, [], 1, context()),
      temporaryAssetError("AIC-ASSET-TEMPORARY_STATE_INVALID"),
    );
    assert.throws(
      () =>
        updateTemporaryAssetDeclaration(
          terminal,
          project,
          {
            sourceDescription: "新来源",
            rightsDeclaration: "新声明",
            rightsConfirmed: true,
          },
          1,
          context(),
        ),
      temporaryAssetError("AIC-ASSET-TEMPORARY_STATE_INVALID"),
    );
  }
});

test("addTemporaryAssetToProjectPool atomically creates a reference and advances a defensive pool copy", () => {
  const current = temporaryAsset({ revision: 2, validationStatus: "valid" });
  const sourcePool = pool();
  const result = addTemporaryAssetToProjectPool(current, project, sourcePool, 2, 3, context());

  assert.deepEqual(result.reference, {
    assetId: current.id,
    version: current.version,
    category: current.category,
    source: "local_upload",
    batchProjectId: project.id,
    checksumSha256: current.checksumSha256,
  });
  assert.equal(result.pool.revision, 4);
  assert.deepEqual(result.pool.assets, [vehicleReference, result.reference]);
  assert.equal(result.pool.updatedBy, "account_uploader");
  assert.equal(sourcePool.revision, 3);
  assert.equal(sourcePool.assets.length, 1);
  assert.notStrictEqual(result.pool, sourcePool);
  assert.notStrictEqual(result.pool.assets, sourcePool.assets);
  assert.notStrictEqual(result.pool.assets[1], result.reference);
  sourcePool.assets[0] = { ...vehicleReference, version: 9 };
  assert.equal(result.pool.assets[0]?.version, 1);
});

test("pool insertion rejects unusable, duplicate, cross-project, full, and stale inputs", () => {
  const valid = temporaryAsset({ validationStatus: "valid" });
  assert.throws(
    () => addTemporaryAssetToProjectPool(temporaryAsset(), project, pool(), 1, 3, context()),
    temporaryAssetError("AIC-ASSET-TEMPORARY_NOT_USABLE"),
  );
  assert.throws(
    () =>
      addTemporaryAssetToProjectPool(
        { ...valid, validationIssues: [{ code: "AIC-ASSET-RIGHTS_UNCONFIRMED", message: "Review." }] },
        project,
        pool(),
        1,
        3,
        context(),
      ),
    temporaryAssetError("AIC-ASSET-TEMPORARY_NOT_USABLE"),
  );
  assert.throws(
    () =>
      addTemporaryAssetToProjectPool(
        { ...valid, expiresAt: "2026-08-19T08:00:00.000Z" },
        project,
        pool(),
        1,
        3,
        context(),
      ),
    temporaryAssetError("AIC-ASSET-TEMPORARY_NOT_USABLE"),
  );
  const duplicatePool = pool({
    assets: [
      vehicleReference,
      {
        assetId: "temporary_asset_other",
        version: 1,
        category: "scene",
        source: "local_upload",
        batchProjectId: project.id,
        checksumSha256: valid.checksumSha256,
      },
    ],
  });
  assert.throws(
    () => addTemporaryAssetToProjectPool(valid, project, duplicatePool, 1, 3, context()),
    temporaryAssetError("AIC-ASSET-TEMPORARY_POOL_DUPLICATE"),
  );
  assert.throws(
    () => addTemporaryAssetToProjectPool(valid, project, pool({ batchProjectId: "project_other" }), 1, 3, context()),
    temporaryAssetError("AIC-ASSET-TEMPORARY_SCOPE_INVALID"),
  );
  assert.throws(
    () => addTemporaryAssetToProjectPool(valid, project, pool({ id: "asset_pool_other" }), 1, 3, context()),
    temporaryAssetError("AIC-ASSET-TEMPORARY_SCOPE_INVALID"),
  );
  assert.throws(
    () =>
      addTemporaryAssetToProjectPool(
        valid,
        { ...project, status: "archived" },
        pool(),
        1,
        3,
        context(),
      ),
    temporaryAssetError("AIC-ASSET-TEMPORARY_SCOPE_INVALID"),
  );
  const fullPool = pool({
    assets: [
      vehicleReference,
      ...Array.from({ length: 499 }, (_, index) => ({
        assetId: `asset_scene_${index}`,
        version: 1,
        source: "company_catalog" as const,
        sourceProvider: "mock_company_assets",
        category: "scene" as const,
      })),
    ],
  });
  assert.throws(
    () => addTemporaryAssetToProjectPool(valid, project, fullPool, 1, 3, context()),
    temporaryAssetError("AIC-ASSET-TEMPORARY_POOL_FULL"),
  );
  assert.throws(
    () => addTemporaryAssetToProjectPool(valid, project, pool(), 2, 3, context()),
    RevisionConflictError,
  );
  assert.throws(
    () => addTemporaryAssetToProjectPool(valid, project, pool(), 1, 2, context()),
    RevisionConflictError,
  );
});
