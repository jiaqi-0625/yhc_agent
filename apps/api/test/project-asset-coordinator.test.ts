import assert from "node:assert/strict";
import test from "node:test";

import { LocalProjectAssetCoordinator } from "../src/project-asset-coordinator.ts";

test("project asset operations are serialized within one project", async () => {
  const coordinator = new LocalProjectAssetCoordinator();
  const events: string[] = [];
  let releaseFirst = (): void => undefined;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered = (): void => undefined;
  const firstDidEnter = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });

  const first = coordinator.runExclusive("project_a", async () => {
    events.push("first:start");
    firstEntered();
    await firstMayFinish;
    events.push("first:end");
  });
  await firstDidEnter;
  const second = coordinator.runExclusive("project_a", () => {
    events.push("second");
  });
  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("different projects do not share one coordinator slot", async () => {
  const coordinator = new LocalProjectAssetCoordinator();
  let release = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstEntered = (): void => undefined;
  const firstDidEnter = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const first = coordinator.runExclusive("project_a", async () => {
    firstEntered();
    await blocked;
  });
  await firstDidEnter;
  const second = await coordinator.runExclusive("project_b", () => "completed");
  assert.equal(second, "completed");
  release();
  await first;
});
