const contextMismatchMessage = "助手会话上下文与当前任务不一致，已拒绝显示。";

function failContextBinding() {
  throw new Error(contextMismatchMessage);
}

export function workspaceAgentTaskBinding(projects, videoTaskId) {
  if (!Array.isArray(projects) || typeof videoTaskId !== "string") return null;
  const matches = projects.filter(function (entry) {
    return Array.isArray(entry?.tasks) && entry.tasks.some(function (task) {
      return task?.id === videoTaskId;
    });
  });
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (
    typeof match?.project?.id !== "string" ||
    typeof match?.brand?.id !== "string" ||
    typeof match?.vehicle?.id !== "string" ||
    !Number.isInteger(match?.vehicle?.version)
  ) return null;
  return {
    projectId: match.project.id,
    brandId: match.brand.id,
    vehicleId: match.vehicle.id,
    vehicleVersion: match.vehicle.version,
  };
}

export function assertWorkspaceAgentSession(summary, videoTaskId, projects) {
  const expectedTaskId = videoTaskId || null;
  if (!summary || typeof summary !== "object" || (summary.videoTaskId || null) !== expectedTaskId) {
    failContextBinding();
  }
  if (expectedTaskId === null) {
    if (summary.taskContext !== undefined && summary.taskContext !== null) failContextBinding();
    return summary;
  }
  const binding = workspaceAgentTaskBinding(projects, expectedTaskId);
  const context = summary.taskContext;
  if (
    !binding ||
    context?.videoTask?.id !== expectedTaskId ||
    context?.batchProject?.id !== binding.projectId ||
    context?.brand?.id !== binding.brandId ||
    context?.vehicle?.id !== binding.vehicleId ||
    context?.vehicle?.version !== binding.vehicleVersion
  ) failContextBinding();
  return summary;
}
