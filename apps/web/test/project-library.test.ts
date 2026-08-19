import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { collectMyActiveTasks, filterProjectLibrary, normalizeProjectLibrary, normalizeProjectSearch, projectVehicleOptions, sortProjectLibrary } from "../public/project-library.js";

function summary(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  const vehicleId = String(overrides.vehicleId ?? "vehicle_e5");
  const brandId = String(overrides.brandId ?? "brand_firefly");
  return {
    project: {
      id,
      brandId,
      vehicleId,
      vehicleVersion: 1,
      name: String(overrides.name ?? `萤火汽车 E5 16:9 ${id}`),
      batchName: String(overrides.batchName ?? id),
      aspectRatio: "16:9",
      status: overrides.status ?? "active",
      revision: 1,
      createdAt: "2026-08-19T09:00:00.000Z",
      updatedAt: "2026-08-19T09:00:00.000Z",
    },
    brand: { id: brandId, name: String(overrides.brandName ?? "萤火汽车") },
    vehicle: {
      id: vehicleId,
      version: 1,
      series: String(overrides.series ?? "萤火 E5"),
      modelYear: 2026,
      trim: String(overrides.trim ?? "长续航版"),
      displayName: String(overrides.vehicleName ?? "萤火 E5 2026 长续航版"),
    },
    tasks: overrides.tasks ?? [],
    latestActivityAt: String(overrides.latestActivityAt ?? "2026-08-19T12:00:00.000Z"),
  };
}

function task(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: String(overrides.name ?? id),
    status: overrides.status ?? "active",
    currentStage: overrides.currentStage ?? "strategy",
    stageStatus: overrides.stageStatus ?? "in_progress",
    revision: 1,
    ownedByCurrentAccount: overrides.ownedByCurrentAccount ?? true,
    updatedAt: String(overrides.updatedAt ?? "2026-08-19T13:00:00.000Z"),
  };
}

test("project library normalizes, deduplicates, and searches Chinese display fields", () => {
  const projects = normalizeProjectLibrary({
    projects: [
      summary("project_a", { name: "萤火汽车 Ｅ５  春季焕新" }),
      summary("project_a", { name: "重复项目" }),
      { project: { id: "invalid" } },
    ],
  });
  assert.equal(projects.length, 1);
  assert.equal(normalizeProjectSearch("  Ｅ５　春季  "), "e5 春季");
  assert.deepEqual(filterProjectLibrary(projects, { search: "e5 春季" }).map((item: any) => item.project.id), ["project_a"]);
  assert.deepEqual(filterProjectLibrary(projects, { search: "内部编号" }), []);
});

test("project library combines brand, vehicle, status filters and stable sorting", () => {
  const projects = normalizeProjectLibrary({ projects: [
    summary("project_b", { latestActivityAt: "2026-08-19T23:00:00+08:00" }),
    summary("project_a", { latestActivityAt: "2026-08-19T15:30:00.000Z" }),
    summary("project_archived", {
      vehicleId: "vehicle_s7",
      vehicleName: "萤火 S7 2026 四驱版",
      series: "萤火 S7",
      trim: "四驱版",
      status: "archived",
      latestActivityAt: "2026-08-19T14:00:00.000Z",
    }),
    summary("project_other_brand", { brandId: "brand_other", brandName: "星河汽车" }),
  ] });
  const filtered = filterProjectLibrary(projects, {
    brandId: "brand_firefly",
    vehicleId: "vehicle_s7",
    status: "archived",
  });
  assert.deepEqual(filtered.map((item: any) => item.project.id), ["project_archived"]);
  assert.deepEqual(sortProjectLibrary(projects.slice(0, 2), "recent").map((item: any) => item.project.id), ["project_a", "project_b"]);
  assert.deepEqual(projectVehicleOptions(filterProjectLibrary(projects, { brandId: "brand_firefly" })), [
    { id: "vehicle_e5", label: "萤火 E5 2026 长续航版" },
    { id: "vehicle_s7", label: "萤火 S7 2026 四驱版" },
  ]);
});

test("my in-progress tasks use current ownership and active task status", () => {
  const projects = normalizeProjectLibrary({ projects: [summary("project_a", { tasks: [
    task("mine_active", { updatedAt: "2026-08-19T15:00:00.000Z" }),
    task("mine_active_offset", { updatedAt: "2026-08-19T22:00:00+08:00" }),
    task("other_active", { ownedByCurrentAccount: false, updatedAt: "2026-08-19T16:00:00.000Z" }),
    task("mine_completed", { status: "completed", updatedAt: "2026-08-19T17:00:00.000Z" }),
  ] })] });
  assert.deepEqual(collectMyActiveTasks(projects).map((entry: any) => entry.task.id), [
    "mine_active",
    "mine_active_offset",
  ]);
});
