import {
  createAdvertisingAgent,
  createLocalModelRuntime,
  loadLocalAgentConfig,
  LocalAgentRuntime,
  LocalSessionStore,
  type LocalAgentConfig,
} from "@firefly/agent";
import type { SessionScope } from "@firefly/domain";

import { LocalBusinessRuntime } from "./business-runtime.ts";
import { LOCAL_SCOPE } from "./golden-sample.ts";
import { resolveLocalTaskContext } from "./task-context.ts";

const LOCAL_AGENT_SCOPE: SessionScope = {
  ...LOCAL_SCOPE,
  role: "creator",
  budgetRemaining: 100,
  hasInteractiveApprovalChannel: true,
};

export function createBusinessAgentRuntime(
  business: LocalBusinessRuntime,
  config: LocalAgentConfig = loadLocalAgentConfig(),
): LocalAgentRuntime {
  const modelRuntime = createLocalModelRuntime(config);
  const store = new LocalSessionStore(config.dataDirectory, config.persistSessions);
  return new LocalAgentRuntime(
    config,
    modelRuntime,
    store,
    (context) =>
      createAdvertisingAgent({
        model: context.model,
        streamFn: context.streamFn,
        messages: context.messages,
        sessionId: context.sessionId,
        ...(context.getApiKey === undefined ? {} : { getApiKey: context.getApiKey }),
        scope: LOCAL_AGENT_SCOPE,
        taskContext: context.taskContext,
        getWorkStatus: async () => (await business.getWork(context.taskContext.videoTaskId)).work.status,
        vehicleService: business.vehicleService,
        strategyService: business.bindStrategyWorkflow(context.taskContext.videoTaskId),
      }),
    (legacyWorkId) => resolveLocalTaskContext(business, legacyWorkId),
  );
}
