import {
  createAdvertisingAgent,
  createLocalModelRuntime,
  loadLocalAgentConfig,
  LocalAgentRuntime,
  LocalSessionStore,
  type AgentSessionScope,
  type LocalAgentConfig,
} from "@firefly/agent";
import type { SessionScope } from "@firefly/domain";
import type { TaskContext } from "@firefly/schemas";
import type { TaskAssetSnapshotReader } from "@firefly/tools";

import { LocalBusinessRuntime } from "./business-runtime.ts";
import { LOCAL_SCOPE } from "./golden-sample.ts";
import { resolveLocalTaskContext } from "./task-context.ts";

const LOCAL_AGENT_SCOPE: SessionScope = {
  ...LOCAL_SCOPE,
  role: "creator",
  budgetRemaining: 100,
  hasInteractiveApprovalChannel: true,
};

export interface BusinessAgentRuntimeOptions {
  resolveTaskAssetReader?: (
    taskContext: Readonly<TaskContext>,
    sessionScope: Readonly<AgentSessionScope>,
  ) => TaskAssetSnapshotReader | undefined;
}

export function createBusinessAgentRuntime(
  business: LocalBusinessRuntime,
  config: LocalAgentConfig = loadLocalAgentConfig(),
  options: BusinessAgentRuntimeOptions = {},
): LocalAgentRuntime {
  const modelRuntime = createLocalModelRuntime(config);
  const store = new LocalSessionStore(config.dataDirectory, config.persistSessions);
  return new LocalAgentRuntime(
    config,
    modelRuntime,
    store,
    (context) => {
      const taskAssetReader = options.resolveTaskAssetReader?.(
        context.taskContext,
        context.sessionScope,
      );
      return createAdvertisingAgent({
        model: context.model,
        streamFn: context.streamFn,
        messages: context.messages,
        sessionId: context.sessionId,
        ...(context.getApiKey === undefined ? {} : { getApiKey: context.getApiKey }),
        scope: {
          ...LOCAL_AGENT_SCOPE,
          actorId: context.sessionScope.actorId,
          tenantId: context.sessionScope.tenantId,
          projectId: context.sessionScope.projectId,
        },
        taskContext: context.taskContext,
        getWorkStatus: async () => (await business.getWork(context.taskContext.videoTask.id)).work.status,
        vehicleService: business.vehicleService,
        strategyService: business.bindStrategyWorkflow(context.taskContext.videoTask.id),
        ...(taskAssetReader === undefined ? {} : { taskAssetReader }),
      });
    },
    (legacyWorkId) => resolveLocalTaskContext(business, legacyWorkId),
    (taskContext) => ({
      actorId: LOCAL_SCOPE.actorId,
      tenantId: LOCAL_SCOPE.tenantId,
      projectId: taskContext.batchProject.id,
      videoTaskId: taskContext.videoTask.id,
    }),
  );
}
