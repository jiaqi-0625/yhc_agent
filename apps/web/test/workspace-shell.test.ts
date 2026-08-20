import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { workspaceApi } from "../public/workspace-api.js";
// @ts-expect-error The browser module is intentionally plain JavaScript.
import { legacySelectedWorkStorageKey, migrateSelectedVideoTaskStorage, navigationBrandStorageKey, normalizeNavigationBrands, resolveNavigationBrandId, selectedVideoTaskStorageKey, workSummaryMatchesNavigationBrand } from "../public/workspace-shell.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    },
  };
}

test("workspace shell migrates the legacy selected Work key exactly once", () => {
  const state = memoryStorage({ [legacySelectedWorkStorageKey]: "work_legacy_001" });
  assert.equal(migrateSelectedVideoTaskStorage(state.storage), "work_legacy_001");
  assert.equal(state.values.get(selectedVideoTaskStorageKey), "work_legacy_001");
  assert.equal(state.values.has(legacySelectedWorkStorageKey), false);

  assert.equal(migrateSelectedVideoTaskStorage(state.storage), "work_legacy_001");
  assert.deepEqual(Object.fromEntries(state.values), {
    [selectedVideoTaskStorageKey]: "work_legacy_001",
  });
});

test("workspace shell gives the new video task key priority and always removes the old key", () => {
  const conflict = memoryStorage({
    [selectedVideoTaskStorageKey]: "video_task_current",
    [legacySelectedWorkStorageKey]: "work_stale",
  });
  assert.equal(migrateSelectedVideoTaskStorage(conflict.storage), "video_task_current");
  assert.deepEqual(Object.fromEntries(conflict.values), {
    [selectedVideoTaskStorageKey]: "video_task_current",
  });

  const empty = memoryStorage();
  assert.equal(migrateSelectedVideoTaskStorage(empty.storage), null);
  assert.deepEqual(Object.fromEntries(empty.values), {});
});

test("workspace shell normalizes only active administrator brands", () => {
  assert.deepEqual(normalizeNavigationBrands("content_admin", {
    brands: [
      { id: "brand_z", name: "  星河汽车  ", status: "active" },
      { id: "brand_archived", name: "归档品牌", status: "archived" },
      { id: "brand_a", name: "萤火汽车", status: "active" },
      { id: "brand_a", name: "重复品牌", status: "active" },
      { id: "", name: "无效品牌", status: "active" },
    ],
  }), [
    { id: "brand_z", name: "星河汽车" },
    { id: "brand_a", name: "萤火汽车" },
  ]);
});

test("workspace shell uses only creator brands returned by the authorized options API", () => {
  assert.deepEqual(normalizeNavigationBrands("creator", {
    brands: [
      { id: "brand_2", name: "云驰汽车", vehicles: [] },
      { id: "brand_1", name: "安行汽车", vehicles: [] },
    ],
  }), [
    { id: "brand_1", name: "安行汽车" },
    { id: "brand_2", name: "云驰汽车" },
  ]);
  assert.deepEqual(normalizeNavigationBrands("unknown", { brands: [{ id: "brand_1", name: "不可见" }] }), []);
});

test("workspace shell keeps brand preference isolated by account and falls back safely", () => {
  const brands = [
    { id: "brand_1", name: "安行汽车" },
    { id: "brand_2", name: "云驰汽车" },
  ];
  assert.equal(navigationBrandStorageKey("account_creator_a"), "firefly.navigationBrand.account_creator_a");
  assert.equal(navigationBrandStorageKey("../forged"), "firefly.navigationBrand.anonymous");
  assert.equal(resolveNavigationBrandId(brands, "brand_2"), "brand_2");
  assert.equal(resolveNavigationBrandId(brands, "brand_hidden"), "brand_1");
  assert.equal(resolveNavigationBrandId([], "brand_1"), null);
});

test("workspace shell scopes project summaries to the selected brand", () => {
  const selected = { id: "brand_1", name: "安行汽车" };
  assert.equal(workSummaryMatchesNavigationBrand({ vehicle: { brandId: "brand_1", brand: "旧名称" } }, selected), true);
  assert.equal(workSummaryMatchesNavigationBrand({ vehicle: { brandId: "brand_2", brand: "安行汽车" } }, selected), false);
  assert.equal(workSummaryMatchesNavigationBrand({ vehicle: { brand: "安行汽车" } }, selected), true);
  assert.equal(workSummaryMatchesNavigationBrand({ vehicle: { brandId: "brand_2", brand: "云驰汽车" } }, null), true);
  assert.equal(workSummaryMatchesNavigationBrand({ vehicle: {} }, selected), false);
});

test("workspace brand API uses the role-specific server endpoints", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({ brands: [] });
  }) as typeof fetch;

  await workspaceApi.listAdminBrands();
  await workspaceApi.getProjectCreationOptions();
  await workspaceApi.getProjectAssetPackage("vehicle/e5");
  await workspaceApi.getProjectConfiguration("vehicle/e5");
  await workspaceApi.searchProjectCompanyAssets("vehicle/e5", {
    category: "person",
    searchText: "都市 驾驶者",
    limit: 20,
  });
  await workspaceApi.createBatchProject({ requestId: "request_ws403" });
  await workspaceApi.createVideoTask("project/e5", { requestId: "request_task_ws403" });
  await workspaceApi.getProjectLibrary();
  assert.deepEqual(requests, [
    "/v1/admin/brands",
    "/v1/workspace/project-creation/options",
    "/v1/workspace/project-creation/vehicles/vehicle%2Fe5/asset-package",
    "/v1/workspace/project-creation/vehicles/vehicle%2Fe5/configuration",
    "/v1/workspace/project-creation/vehicles/vehicle%2Fe5/company-assets?category=person&searchText=%E9%83%BD%E5%B8%82+%E9%A9%BE%E9%A9%B6%E8%80%85&limit=20",
    "/v1/workspace/batch-projects",
    "/v1/workspace/batch-projects/project%2Fe5/video-tasks",
    "/v1/workspace/project-library",
  ]);
});

test("workspace shell markup is Chinese-first, embed-ready, and declares its desktop boundary", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /platform-sidebar/u);
  assert.match(page, /<select id="brand-navigation" aria-label="切换品牌"/u);
  assert.match(page, /id="agent-account-select" aria-label="切换当前账号"/u);
  assert.match(page, /id="project-library-view"[^>]*aria-labelledby="project-library-title"/u);
  assert.match(page, /id="my-tasks-title">我的进行中任务</u);
  assert.match(page, /id="project-vehicle-filter"[^>]*aria-label="按车型筛选"/u);
  assert.match(page, /id="project-status-filter"[^>]*aria-label="按项目状态筛选"/u);
  assert.match(page, /id="project-sort"[^>]*aria-label="项目排序"/u);
  assert.match(page, /id="new-project"[^>]*>[^<]*<svg[^>]*>.*新建项目/su);
  assert.match(page, /id="project-creation-view"[^>]*aria-labelledby="new-project-title"[^>]*hidden/u);
  assert.match(page, /id="new-project-back"[^>]*>← 返回项目库<\/button>/u);
  assert.match(page, /id="new-project-submit"[^>]*>创建项目<\/button>/u);
  assert.match(page, /id="workspace-shell"[^>]*hidden/u);
  assert.match(page, /请使用桌面端打开/u);
  assert.doesNotMatch(page, />[^<]*(?:Projects|Current work|Strategy workspace|Agent)[^<]*</u);
  assert.doesNotMatch(styles, /--platform-sidebar-width:/u);
  assert.match(styles, /@media not all and \(min-width: 1280px\)/u);
  assert.match(styles, /\.app-shell \{ display: none; \}/u);
  assert.match(page, /id="brand-navigation-status"[^>]*role="status"[^>]*aria-live="polite"/u);
});
