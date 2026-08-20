import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkspaceAgentSession, workspaceAgentTaskBinding } from "../public/workspace-agent-context.js";

const project = {
  project: { id: "project_e5" },
  brand: { id: "brand_firefly" },
  vehicle: { id: "vehicle_e5", version: 3 },
  tasks: [{ id: "task_e5" }],
};

const context = {
  brand: { id: "brand_firefly" },
  vehicle: { id: "vehicle_e5", version: 3 },
  batchProject: { id: "project_e5" },
  videoTask: { id: "task_e5" },
};

const session = {
  id: "session_e5",
  videoTaskId: "task_e5",
  taskContext: context,
};

test("workspace Agent context resolves one exact project binding", () => {
  assert.deepEqual(workspaceAgentTaskBinding([project], "task_e5"), {
    projectId: "project_e5",
    brandId: "brand_firefly",
    vehicleId: "vehicle_e5",
    vehicleVersion: 3,
  });
  assert.equal(assertWorkspaceAgentSession(session, "task_e5", [project]), session);
});

test("workspace Agent context rejects every cross-task and cross-project mismatch", () => {
  const invalid = [
    { ...session, videoTaskId: "task_other" },
    { ...session, taskContext: { ...context, videoTask: { id: "task_other" } } },
    { ...session, taskContext: { ...context, batchProject: { id: "project_other" } } },
    { ...session, taskContext: { ...context, brand: { id: "brand_other" } } },
    { ...session, taskContext: { ...context, vehicle: { id: "vehicle_other", version: 3 } } },
    { ...session, taskContext: { ...context, vehicle: { id: "vehicle_e5", version: 2 } } },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => assertWorkspaceAgentSession(candidate, "task_e5", [project]),
      /上下文与当前任务不一致/u,
    );
  }
});

test("workspace Agent context fails closed for missing or ambiguous task ownership", () => {
  const duplicate = { ...project, project: { id: "project_copy" } };
  assert.equal(workspaceAgentTaskBinding([], "task_e5"), null);
  assert.equal(workspaceAgentTaskBinding([project, duplicate], "task_e5"), null);
  assert.throws(() => assertWorkspaceAgentSession(session, "task_e5", []), /已拒绝显示/u);
  assert.throws(() => assertWorkspaceAgentSession(session, "task_e5", [project, duplicate]), /已拒绝显示/u);
});

test("unbound Agent sessions cannot smuggle a task context into the project view", () => {
  const unbound = { id: "session_unbound" };
  assert.equal(assertWorkspaceAgentSession(unbound, null, []), unbound);
  assert.throws(
    () => assertWorkspaceAgentSession({ ...unbound, taskContext: context }, null, []),
    /已拒绝显示/u,
  );
});

