import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidVideoTaskTransitionError,
  InvalidTransitionError,
  RevisionConflictError,
  allowedVideoTaskEvents,
  allowedEvents,
  assertRevision,
  initialVideoTaskWorkflowState,
  nextVideoTaskWorkflowState,
  nextWorkStatus,
  videoTaskStageOrder,
  type VideoTaskWorkflowEvent,
  type VideoTaskWorkflowState,
} from "../src/workflow.ts";

test("workspace v2 workflow advances through all six stages only after human confirmation", () => {
  assert.deepEqual(videoTaskStageOrder, [
    "strategy",
    "script",
    "asset_matching",
    "storyboard",
    "video_preview",
    "delivery",
  ]);
  let state: VideoTaskWorkflowState = { ...initialVideoTaskWorkflowState };

  for (const stage of videoTaskStageOrder) {
    assert.equal(state.taskStatus, "active");
    assert.equal(state.currentStage, stage);
    assert.equal(state.stageStatus, "in_progress");
    state = nextVideoTaskWorkflowState(state, { type: "stage_confirmation_requested", stage });
    assert.equal(state.stageStatus, "awaiting_confirmation");
    state = nextVideoTaskWorkflowState(state, { type: "stage_confirmed", stage, source: "human_action" });
  }

  assert.deepEqual(state, {
    taskStatus: "completed",
    currentStage: "delivery",
    stageStatus: "confirmed",
  });
  assert.deepEqual(allowedVideoTaskEvents(state), []);
});

test("workspace v2 workflow exposes only events valid for the current stage state", () => {
  assert.deepEqual(allowedVideoTaskEvents(initialVideoTaskWorkflowState), [
    "stage_revised",
    "stage_confirmation_requested",
  ]);
  const awaiting = nextVideoTaskWorkflowState(initialVideoTaskWorkflowState, {
    type: "stage_confirmation_requested",
    stage: "strategy",
  });
  assert.deepEqual(allowedVideoTaskEvents(awaiting), ["stage_confirmation_rejected", "stage_confirmed"]);
  assert.deepEqual(allowedVideoTaskEvents({ ...awaiting, taskStatus: "cancelled" }), []);
});

test("workspace v2 workflow rejects skipped, stale, model-confirmed, and terminal transitions", () => {
  assert.throws(
    () =>
      nextVideoTaskWorkflowState(initialVideoTaskWorkflowState, {
        type: "stage_confirmed",
        stage: "strategy",
        source: "human_action",
      }),
    InvalidVideoTaskTransitionError,
  );
  assert.throws(
    () =>
      nextVideoTaskWorkflowState(initialVideoTaskWorkflowState, {
        type: "stage_confirmation_requested",
        stage: "script",
      }),
    InvalidVideoTaskTransitionError,
  );

  const awaiting = nextVideoTaskWorkflowState(initialVideoTaskWorkflowState, {
    type: "stage_confirmation_requested",
    stage: "strategy",
  });
  const modelConfirmation = {
    type: "stage_confirmed",
    stage: "strategy",
    source: "agent",
  } as unknown as VideoTaskWorkflowEvent;
  assert.throws(
    () => nextVideoTaskWorkflowState(awaiting, modelConfirmation),
    InvalidVideoTaskTransitionError,
  );
  assert.throws(
    () =>
      nextVideoTaskWorkflowState(
        { taskStatus: "completed", currentStage: "delivery", stageStatus: "confirmed" },
        { type: "stage_revised", stage: "delivery" },
      ),
    InvalidVideoTaskTransitionError,
  );
});

test("workspace v2 human rejection returns only the current stage to work in progress", () => {
  const awaiting = nextVideoTaskWorkflowState(initialVideoTaskWorkflowState, {
    type: "stage_confirmation_requested",
    stage: "strategy",
  });
  assert.deepEqual(
    nextVideoTaskWorkflowState(awaiting, {
      type: "stage_confirmation_rejected",
      stage: "strategy",
      source: "human_action",
    }),
    initialVideoTaskWorkflowState,
  );
});

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
