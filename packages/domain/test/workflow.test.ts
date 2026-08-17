import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidTransitionError,
  RevisionConflictError,
  allowedEvents,
  assertRevision,
  nextWorkStatus,
} from "../src/workflow.ts";

test("workflow follows strategy approval gate", () => {
  assert.equal(nextWorkStatus("created", "strategy_generated"), "strategy_draft");
  assert.equal(nextWorkStatus("strategy_draft", "strategy_approval_requested"), "awaiting_strategy_approval");
  assert.equal(nextWorkStatus("awaiting_strategy_approval", "strategy_approved"), "strategy_approved");
});

test("strategy draft can be regenerated without bypassing its approval gate", () => {
  assert.equal(nextWorkStatus("strategy_draft", "strategy_regenerated"), "strategy_draft");
  assert.throws(() => nextWorkStatus("awaiting_strategy_approval", "strategy_regenerated"), InvalidTransitionError);
});

test("workflow blocks skipping human approval", () => {
  assert.throws(() => nextWorkStatus("strategy_draft", "script_generated"), InvalidTransitionError);
  assert.deepEqual(allowedEvents("strategy_draft"), ["strategy_regenerated", "strategy_approval_requested"]);
});

test("workflow rejection returns to editable draft", () => {
  assert.equal(nextWorkStatus("awaiting_script_approval", "script_rejected"), "script_draft");
  assert.equal(nextWorkStatus("final_review", "review_rejected"), "storyboard_draft");
});

test("revision guard prevents stale model output from overwriting human changes", () => {
  assert.doesNotThrow(() => assertRevision(4, 4));
  assert.throws(() => assertRevision(3, 4), RevisionConflictError);
  assert.throws(() => assertRevision(0, 4), RangeError);
});
