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
import type { WorkStatus } from "@firefly/schemas";
import type {
  StageSuggestionContextReader,
  StrategyDraftReader,
  TaskAssetSnapshotReader,
  VehicleServicePort,
} from "@firefly/tools";

import { BusinessRuntimeError, LocalBusinessRuntime } from "./business-runtime.ts";
import { LOCAL_SCOPE } from "./golden-sample.ts";
import { resolveLocalTaskContext } from "./task-context.ts";

const LOCAL_AGENT_SCOPE: SessionScope = {
  ...LOCAL_SCOPE,
  role: "creator",
  budgetRemaining: 100,
  hasInteractiveApprovalChannel: true,
};

const migrationSafeBusinessAgentRuntimes = new WeakSet<LocalAgentRuntime>();

export function isMigrationSafeAgentRuntime(runtime: Readonly<LocalAgentRuntime>): boolean {
  return migrationSafeBusinessAgentRuntimes.has(runtime as LocalAgentRuntime) ||
    (!runtime.domainToolsAvailable && !runtime.legacyTaskResolutionAvailable);
}

export interface BusinessAgentRuntimeOptions {
  /** Completed V1 -> V2 migrations must not assemble tools backed by the V1 Work store. */
  disableLegacyStrategyTools?: boolean;
  resolveWorkStatus?: (
    taskContext: Readonly<TaskContext>,
    sessionScope: Readonly<AgentSessionScope>,
  ) => WorkStatus | Promise<WorkStatus>;
  resolveVehicleService?: (
    taskContext: Readonly<TaskContext>,
    sessionScope: Readonly<AgentSessionScope>,
  ) => VehicleServicePort;
  resolveTaskAssetReader?: (
    taskContext: Readonly<TaskContext>,
    sessionScope: Readonly<AgentSessionScope>,
  ) => TaskAssetSnapshotReader | undefined;
  resolveStageSuggestionReader?: (
    taskContext: Readonly<TaskContext>,
    sessionScope: Readonly<AgentSessionScope>,
  ) => StageSuggestionContextReader | undefined;
  resolveStrategyDraftReader?: (
    taskContext: Readonly<TaskContext>,
    sessionScope: Readonly<AgentSessionScope>,
  ) => StrategyDraftReader | undefined;
}

export function createBusinessAgentRuntime(
  business: LocalBusinessRuntime,
  config: LocalAgentConfig = loadLocalAgentConfig(),
  options: BusinessAgentRuntimeOptions = {},
): LocalAgentRuntime {
  if (
    options.disableLegacyStrategyTools &&
    (options.resolveWorkStatus === undefined || options.resolveVehicleService === undefined)
  ) {
    throw new BusinessRuntimeError(
      "AIC-AGENT-TASK_CONTEXT_RUNTIME_NOT_CONFIGURED",
      "Migrated Agent tools require explicit V2 status and locked vehicle snapshot readers.",
      503,
    );
  }
  const modelRuntime = createLocalModelRuntime(config);
  const store = new LocalSessionStore(config.dataDirectory, config.persistSessions);
  const runtime = new LocalAgentRuntime(
    config,
    modelRuntime,
    store,
    (context) => {
      const taskAssetReader = options.resolveTaskAssetReader?.(
        context.taskContext,
        context.sessionScope,
      );
      const stageSuggestionReader = options.resolveStageSuggestionReader?.(
        context.taskContext,
        context.sessionScope,
      );
      const strategyDraftReader = options.resolveStrategyDraftReader?.(
        context.taskContext,
        context.sessionScope,
      );
      const vehicleService = options.resolveVehicleService?.(
        context.taskContext,
        context.sessionScope,
      );
      if (vehicleService === undefined && options.disableLegacyStrategyTools) {
        throw new BusinessRuntimeError(
          "AIC-AGENT-TASK_CONTEXT_RUNTIME_NOT_CONFIGURED",
          "Migrated Agent vehicle tools cannot fall back to the V1 vehicle service.",
          503,
        );
      }
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
          allowedBrandIds: [context.taskContext.brand.id],
        },
        taskContext: context.taskContext,
        getWorkStatus: options.resolveWorkStatus === undefined
          ? async () => (await business.getWork(context.taskContext.videoTask.id)).work.status
          : () => options.resolveWorkStatus!(context.taskContext, context.sessionScope),
        vehicleService: vehicleService ?? business.vehicleService,
        ...(options.disableLegacyStrategyTools
          ? {
              strategyProposal: {
                videoTaskId: context.taskContext.videoTask.id,
                currentRevision: () => context.taskContext.videoTask.revision,
              },
            }
          : { strategyService: business.bindStrategyWorkflow(context.taskContext.videoTask.id) }),
        ...(taskAssetReader === undefined ? {} : { taskAssetReader }),
        ...(stageSuggestionReader === undefined ? {} : { stageSuggestionReader }),
        ...(strategyDraftReader === undefined ? {} : { strategyDraftReader }),
      });
    },
    options.disableLegacyStrategyTools
      ? undefined
      : (legacyWorkId) => resolveLocalTaskContext(business, legacyWorkId),
    options.disableLegacyStrategyTools
      ? undefined
      : (taskContext) => ({
          actorId: LOCAL_SCOPE.actorId,
          tenantId: LOCAL_SCOPE.tenantId,
          projectId: taskContext.batchProject.id,
          videoTaskId: taskContext.videoTask.id,
        }),
  );
  if (options.disableLegacyStrategyTools) {
    migrationSafeBusinessAgentRuntimes.add(runtime);
  }
  return runtime;
}
