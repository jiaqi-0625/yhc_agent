import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { agentPanelWidthBounds, resolveAgentPanelWidth } from "../public/agent-panel.js";

test("Agent panel width preserves the desktop workspace minimums", () => {
  assert.equal(resolveAgentPanelWidth(1280, 380), 380);
  assert.equal(resolveAgentPanelWidth(1280, 560), 474);
  assert.equal(resolveAgentPanelWidth(1920, 560), 560);
  assert.equal(resolveAgentPanelWidth(1180, 560), 474);
  assert.equal(resolveAgentPanelWidth(1000, 380), 294);
  assert.deepEqual(agentPanelWidthBounds(1280), { minimum: 320, maximum: 474 });
});

test("Agent panel width clamps invalid saved widths", () => {
  assert.equal(resolveAgentPanelWidth(1920, 200), 320);
  assert.equal(resolveAgentPanelWidth(1920, 900), 560);
});
