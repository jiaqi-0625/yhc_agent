import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assetReferenceIdentity,
  createAssetMatchingPanel,
  selectionWithManualPriority,
} from "../public/asset-matching.js";

const vehicle = {
  assetId: "asset_vehicle",
  version: 2,
  category: "vehicle",
  source: "company_catalog",
  sourceProvider: "mock_company_assets",
  vehicleId: "vehicle_e5",
} as const;
const person = {
  assetId: "asset_person",
  version: 1,
  category: "person",
  source: "company_catalog",
  sourceProvider: "mock_company_assets",
} as const;
const scene = {
  assetId: "asset_scene",
  version: 3,
  category: "scene",
  source: "company_catalog",
  sourceProvider: "mock_company_assets",
} as const;
const temporaryStyle = {
  assetId: "temporary_visual_style",
  version: 1,
  category: "visual_style",
  source: "local_upload",
  batchProjectId: "project_asset_matching",
  checksumSha256: "a".repeat(64),
} as const;

type FakeListener = (event: { preventDefault(): void }) => unknown;

class FakeClassList {
  readonly values = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) this.values.add(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  textContent = "";
  hidden = false;
  disabled = false;
  className = "";
  open = false;
  value = "";
  checked = false;
  files: unknown[] = [];
  dataset: Record<string, string | undefined> = {};
  queryResult: FakeElement | null = null;
  children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, FakeListener[]>();

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    const event = { preventDefault() {} };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click(): void {
    if (!this.disabled) this.dispatch("click");
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  querySelector(): FakeElement | null {
    return this.queryResult;
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  focus(): void {}

  reset(): void {}
}

function panelElements() {
  const notice = new FakeElement();
  notice.queryResult = new FakeElement();
  return {
    error: new FakeElement(),
    grid: new FakeElement(),
    uploadOpen: new FakeElement(),
    confirm: new FakeElement(),
    gate: new FakeElement(),
    notice,
    count: new FakeElement(),
    tabs: [] as FakeElement[],
    dialog: new FakeElement(),
    uploadError: new FakeElement(),
    uploadForm: new FakeElement(),
    file: new FakeElement(),
    uploadCategory: new FakeElement(),
    uploadDescription: new FakeElement(),
    uploadRights: new FakeElement(),
    uploadRightsConfirmed: new FakeElement(),
    uploadSubmit: new FakeElement(),
    uploadClose: new FakeElement(),
    uploadCancel: new FakeElement(),
    fileLabel: new FakeElement(),
  };
}

function installFakeDocument(context: { after(callback: () => void): void }): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement() {
        return new FakeElement();
      },
      createElementNS() {
        return new FakeElement();
      },
    },
  });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete (globalThis as unknown as Record<string, unknown>).document;
  });
}

function matchingView(stageStatus: "in_progress" | "awaiting_confirmation") {
  return {
    project: {
      id: "project_asset_matching",
      brandId: "brand_firefly",
      vehicleId: "vehicle_e5",
      name: "萤火 E5 项目",
      aspectRatio: "9:16",
    },
    videoTask: {
      id: "task_asset_matching",
      name: "素材匹配任务",
      status: "active",
      currentStage: "asset_matching",
      stageStatus,
      revision: 11,
    },
    matchingReady: true,
    confirmationReady: true,
    matchingLocked: false,
    gateMessage: stageStatus === "awaiting_confirmation" ? "等待人工确认" : "正在选材",
    poolRevision: 7,
    companyAssets: [
      {
        reference: vehicle,
        displayName: "萤火 E5",
        description: "项目固定车型",
        tags: [],
        selected: true,
        recommended: true,
        replacementAllowed: false,
      },
      {
        reference: person,
        displayName: "年轻驾驶员",
        description: "人物候选",
        tags: [],
        selected: true,
        recommended: true,
        replacementAllowed: true,
      },
      {
        reference: scene,
        displayName: "城市场景",
        description: "场景候选",
        tags: [],
        selected: true,
        recommended: true,
        replacementAllowed: true,
      },
    ],
    temporaryAssets: [{
      id: temporaryStyle.assetId,
      version: temporaryStyle.version,
      category: temporaryStyle.category,
      batchProjectId: temporaryStyle.batchProjectId,
      checksumSha256: temporaryStyle.checksumSha256,
      fileName: "temporary-style.png",
      sourceDescription: "不可替换项目视觉风格",
      validationStatus: "valid",
      selected: true,
      recommended: false,
    }],
    selectedAssets: [vehicle, person, scene, temporaryStyle],
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("asset reference identity includes source and exact version", () => {
  assert.notEqual(
    assetReferenceIdentity(vehicle),
    assetReferenceIdentity({ ...vehicle, version: 3 }),
  );
  assert.notEqual(assetReferenceIdentity(vehicle), assetReferenceIdentity(person));
});

test("manual asset selection always takes priority over a later Agent recommendation", () => {
  const recommended = selectionWithManualPriority([vehicle, person], null);
  const manual = new Set([assetReferenceIdentity(vehicle)]);
  const afterRecommendationRefresh = selectionWithManualPriority(
    [{ ...person, version: 2 }],
    manual,
  );
  assert.deepEqual(afterRecommendationRefresh, manual);
  assert.equal(afterRecommendationRefresh.has(assetReferenceIdentity(person)), false);
  assert.equal(recommended.has(assetReferenceIdentity(person)), true);
});

test("asset confirmation refreshes the workspace task and Agent context", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const panelStart = source.indexOf("assetMatchingPanel = createAssetMatchingPanel({");
  const start = source.indexOf("onTaskUpdated: function (updatedTask)", panelStart);
  const callbackSource = source.slice(start).replaceAll("\r\n", "\n");
  const callbackEnd = callbackSource.indexOf("\n  },\n});");
  assert.ok(panelStart >= 0 && start >= panelStart && callbackEnd > 0);
  const updateWiring = callbackSource.slice(0, callbackEnd);
  assert.match(updateWiring, /task\.revision = updatedTask\.revision/u);
  assert.match(updateWiring, /task\.currentStage = updatedTask\.currentStage/u);
  assert.match(updateWiring, /workspaceFrame\.open\(updatedProjectId, updatedTask\.id/u);
  assert.match(updateWiring, /historyMode: "replace"/u);
});

test("confirmation locks an editable selection and retries a stable person/scene-only request", async (context) => {
  installFakeDocument(context);
  const elements = panelElements();
  let currentView = matchingView("in_progress");
  let getCalls = 0;
  const requests: Array<{
    requestId: string;
    expectedTaskRevision: number;
    expectedProjectAssetPoolRevision: number;
    selectedAssets: Array<{ category: string }>;
  }> = [];
  const lockedView = {
    ...matchingView("awaiting_confirmation"),
    videoTask: {
      ...matchingView("awaiting_confirmation").videoTask,
      currentStage: "storyboard",
      stageStatus: "in_progress",
      revision: 12,
      assetSnapshotId: "asset_snapshot_server_composed",
    },
    confirmationReady: false,
    matchingLocked: true,
  };
  const api = {
    async getAssetMatching() {
      getCalls += 1;
      return structuredClone(currentView);
    },
    async lockAssetSelection(
      _projectId: string,
      _taskId: string,
      request: {
        requestId: string;
        expectedTaskRevision: number;
        expectedProjectAssetPoolRevision: number;
        selectedAssets: Array<{ category: string }>;
      },
    ) {
      requests.push(structuredClone(request));
      if (requests.length === 1) throw new Error("simulated retryable transport failure");
      return structuredClone(lockedView);
    },
    async uploadTemporaryAsset() {
      throw new Error("upload is outside this test");
    },
  };
  const panel = createAssetMatchingPanel({ elements, api });
  panel.setContext(
    "project_asset_matching",
    { id: "task_asset_matching" },
    true,
  );
  await waitFor(() => getCalls === 1, "initial asset-matching view");

  assert.equal(elements.confirm.disabled, false);
  const temporaryStyleCard = elements.grid.children.find(
    (card) => card.getAttribute("aria-label")?.includes("temporary-style.png") ?? false,
  );
  assert.ok(temporaryStyleCard);
  assert.equal(temporaryStyleCard.disabled, true, "temporary visual_style cannot be replaced");

  elements.confirm.click();
  await waitFor(
    () => requests.length === 1 && elements.confirm.disabled === false,
    "failed confirmation to become retryable",
  );
  elements.confirm.click();
  await waitFor(() => requests.length === 2, "retried asset confirmation");

  assert.match(requests[0]!.requestId, /^asset_confirmation_[A-Za-z0-9]+$/u);
  assert.equal(requests[1]!.requestId, requests[0]!.requestId);
  for (const request of requests) {
    assert.equal(request.expectedTaskRevision, 11);
    assert.equal(request.expectedProjectAssetPoolRevision, 7);
    assert.deepEqual(
      request.selectedAssets.map(({ category }) => category),
      ["person", "scene"],
    );
  }
  assert.equal(elements.confirm.disabled, true);
});
