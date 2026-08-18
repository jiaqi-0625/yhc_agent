import { randomUUID } from "node:crypto";

import { assertRevision, nextWorkStatus, validateStrategy } from "@firefly/domain";
import type {
  CreateWorkRequest,
  GenerateStrategyRequest,
  Strategy,
  StrategyApproval,
  StrategyDecisionRequest,
  StrategyValidationResult,
  UpdateStrategyRequest,
  Work,
} from "@firefly/schemas";
import {
  generateDeterministicStrategy,
  InMemoryVehicleService,
  type StrategyWorkflowPort,
} from "@firefly/tools";

import { LocalWorkStore, type LocalWorkRecord } from "./business-store.ts";
import { GOLDEN_SAMPLE_VEHICLES, LOCAL_SCOPE } from "./golden-sample.ts";

export class BusinessRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "BusinessRuntimeError";
  }
}

export interface LocalWorkView {
  work: Work;
  vehicleSnapshot: LocalWorkRecord["vehicleSnapshot"];
  strategy?: Strategy;
  strategyVersionCount: number;
  validation?: StrategyValidationResult;
  approvals: StrategyApproval[];
}

export interface LocalWorkSummary {
  work: Work;
  vehicle: {
    brand: string;
    series: string;
    trim: string;
    modelYear: number;
  };
  strategy?: {
    version: number;
    status: Strategy["status"];
    audience: string;
    theme: string;
  };
}

function activeStrategy(record: LocalWorkRecord): Strategy | undefined {
  return record.strategyVersions.at(-1);
}

function assertEditableStrategy(record: LocalWorkRecord): Strategy {
  const strategy = activeStrategy(record);
  if (!strategy) throw new BusinessRuntimeError("AIC-STRATEGY-NOT_FOUND", "当前作品还没有卖点策略。", 404);
  if (record.work.status !== "strategy_draft") {
    throw new BusinessRuntimeError("AIC-WORKFLOW-STRATEGY_NOT_EDITABLE", "当前状态不允许编辑卖点策略。", 409);
  }
  return strategy;
}

export class LocalBusinessRuntime {
  readonly #vehicles: InMemoryVehicleService;

  constructor(
    readonly store = new LocalWorkStore(),
    vehicles = new InMemoryVehicleService(GOLDEN_SAMPLE_VEHICLES),
  ) {
    this.#vehicles = vehicles;
  }

  get vehicleService(): InMemoryVehicleService {
    return this.#vehicles;
  }

  async listWorks(): Promise<LocalWorkSummary[]> {
    const records = await this.store.list();
    return records
      .sort((left, right) => right.work.updatedAt.localeCompare(left.work.updatedAt))
      .map((record) => {
        const strategy = activeStrategy(record);
        return {
          work: structuredClone(record.work),
          vehicle: {
            brand: record.vehicleSnapshot.brand,
            series: record.vehicleSnapshot.series,
            trim: record.vehicleSnapshot.trim,
            modelYear: record.vehicleSnapshot.modelYear,
          },
          ...(strategy === undefined
            ? {}
            : {
                strategy: {
                  version: strategy.version,
                  status: strategy.status,
                  audience: strategy.audience,
                  theme: strategy.theme,
                },
              }),
        };
      });
  }

  async getWork(workId: string): Promise<LocalWorkView> {
    return this.#view(await this.#record(workId));
  }

  bindStrategyWorkflow(workId: string): StrategyWorkflowPort {
    return {
      videoTaskId: workId,
      currentRevision: async () => (await this.getWork(workId)).work.revision,
      generate: async (request) => {
        const view = await this.generateStrategy(workId, request);
        if (!view.strategy || !view.validation) throw new Error("Strategy generation returned no strategy.");
        return { strategy: view.strategy, validation: view.validation };
      },
      validate: async () => {
        const view = await this.getWork(workId);
        if (!view.validation) {
          throw new BusinessRuntimeError("AIC-STRATEGY-NOT_FOUND", "当前作品还没有卖点策略。", 404);
        }
        return view.validation;
      },
      requestApproval: async (expectedRevision) => {
        const view = await this.requestStrategyApproval(workId, expectedRevision);
        if (!view.strategy) throw new Error("Strategy approval request returned no strategy.");
        return { strategy: view.strategy, revision: view.work.revision };
      },
    };
  }

  async createWork(request: CreateWorkRequest): Promise<LocalWorkView> {
    const now = new Date().toISOString();
    const id = `work_${randomUUID()}`;
    const snapshot = this.#vehicles.createSnapshot(request, LOCAL_SCOPE);
    const work: Work = {
      id,
      projectId: LOCAL_SCOPE.projectId,
      status: "created",
      revision: 1,
      vehicleSnapshotId: snapshot.id,
      createdAt: now,
      updatedAt: now,
    };
    const record: LocalWorkRecord = {
      schemaVersion: 1,
      work,
      vehicleSnapshot: snapshot,
      strategyVersions: [],
      approvals: [],
    };
    await this.store.save(record);
    return this.#view(record);
  }

  async copyApprovedWork(workId: string, expectedRevision: number): Promise<LocalWorkView> {
    const source = await this.#record(workId);
    assertRevision(expectedRevision, source.work.revision);
    if (source.work.status !== "strategy_approved") {
      throw new BusinessRuntimeError(
        "AIC-WORKFLOW-WORK_COPY_DENIED",
        "只有已通过策略审批的作品才能作为新作品的车型来源。",
        409,
      );
    }
    const now = new Date().toISOString();
    const id = `work_${randomUUID()}`;
    const record: LocalWorkRecord = {
      schemaVersion: 1,
      work: {
        id,
        projectId: source.work.projectId,
        status: "created",
        revision: 1,
        vehicleSnapshotId: source.vehicleSnapshot.id,
        createdAt: now,
        updatedAt: now,
      },
      vehicleSnapshot: structuredClone(source.vehicleSnapshot),
      strategyVersions: [],
      approvals: [],
    };
    await this.store.save(record);
    return this.#view(record);
  }

  async generateStrategy(workId: string, request: GenerateStrategyRequest): Promise<LocalWorkView> {
    const record = await this.#record(workId);
    assertRevision(request.expectedRevision, record.work.revision);
    if (record.work.status !== "created" && record.work.status !== "strategy_draft") {
      throw new BusinessRuntimeError("AIC-WORKFLOW-STRATEGY_GENERATION_DENIED", "当前状态不允许生成卖点策略。", 409);
    }
    const previous = activeStrategy(record);
    const strategy = generateDeterministicStrategy({
      ...request,
      workId,
      snapshot: record.vehicleSnapshot,
      version: record.strategyVersions.length + 1,
      actorId: LOCAL_SCOPE.actorId,
      ...(previous === undefined ? {} : { previousStrategy: previous }),
    });
    const validation = validateStrategy(strategy, record.vehicleSnapshot);
    if (!validation.valid) {
      throw new BusinessRuntimeError("AIC-STRATEGY-GENERATED_INVALID", "生成的卖点策略未通过事实校验。", 422);
    }
    const now = new Date().toISOString();
    record.strategyVersions.push(strategy);
    record.work.status = nextWorkStatus(
      record.work.status,
      record.work.status === "created" ? "strategy_generated" : "strategy_regenerated",
    );
    record.work.revision += 1;
    record.work.updatedAt = now;
    await this.store.save(record);
    return this.#view(record);
  }

  async updateStrategy(workId: string, request: UpdateStrategyRequest): Promise<LocalWorkView> {
    const record = await this.#record(workId);
    assertRevision(request.expectedRevision, record.work.revision);
    const previous = assertEditableStrategy(record);
    const now = new Date().toISOString();
    const strategy: Strategy = {
      ...previous,
      id: `strategy_${record.strategyVersions.length + 1}_${workId}`,
      version: record.strategyVersions.length + 1,
      status: "draft",
      audience: request.audience,
      theme: request.theme,
      items: structuredClone(request.items),
      model: "human-edit",
      templateVersion: previous.templateVersion,
      createdAt: now,
      createdBy: LOCAL_SCOPE.actorId,
      updatedAt: now,
    };
    record.strategyVersions.push(strategy);
    record.work.revision += 1;
    record.work.updatedAt = now;
    await this.store.save(record);
    return this.#view(record);
  }

  async requestStrategyApproval(workId: string, expectedRevision: number): Promise<LocalWorkView> {
    const record = await this.#record(workId);
    assertRevision(expectedRevision, record.work.revision);
    const strategy = assertEditableStrategy(record);
    const validation = validateStrategy(strategy, record.vehicleSnapshot);
    if (!validation.valid) {
      throw new BusinessRuntimeError("AIC-STRATEGY-VALIDATION_FAILED", "策略校验未通过，不能提交审批。", 422);
    }
    const now = new Date().toISOString();
    strategy.status = "awaiting_approval";
    strategy.updatedAt = now;
    record.work.status = nextWorkStatus(record.work.status, "strategy_approval_requested");
    record.work.revision += 1;
    record.work.updatedAt = now;
    await this.store.save(record);
    return this.#view(record);
  }

  async decideStrategy(workId: string, request: StrategyDecisionRequest): Promise<LocalWorkView> {
    const record = await this.#record(workId);
    assertRevision(request.expectedRevision, record.work.revision);
    const strategy = activeStrategy(record);
    if (!strategy || record.work.status !== "awaiting_strategy_approval") {
      throw new BusinessRuntimeError("AIC-WORKFLOW-STRATEGY_DECISION_DENIED", "当前没有等待人工审批的策略。", 409);
    }
    const now = new Date().toISOString();
    strategy.status = request.decision;
    strategy.updatedAt = now;
    record.work.status = nextWorkStatus(
      record.work.status,
      request.decision === "approved" ? "strategy_approved" : "strategy_rejected",
    );
    record.work.revision += 1;
    record.work.updatedAt = now;
    record.approvals.push({
      id: `approval_${record.work.revision}_${workId}`,
      workId,
      strategyId: strategy.id,
      decision: request.decision,
      ...(request.comment === undefined ? {} : { comment: request.comment }),
      actorId: "reviewer_local",
      occurredAt: now,
    });
    await this.store.save(record);
    return this.#view(record);
  }

  async #record(workId: string): Promise<LocalWorkRecord> {
    const record = await this.store.load(workId);
    if (!record) throw new BusinessRuntimeError("AIC-DATA-WORK_NOT_FOUND", `作品 '${workId}' 不存在。`, 404);
    return record;
  }

  #view(record: LocalWorkRecord): LocalWorkView {
    const strategy = activeStrategy(record);
    return {
      work: structuredClone(record.work),
      vehicleSnapshot: structuredClone(record.vehicleSnapshot),
      ...(strategy === undefined
        ? {}
        : {
            strategy: structuredClone(strategy),
            validation: validateStrategy(strategy, record.vehicleSnapshot),
          }),
      strategyVersionCount: record.strategyVersions.length,
      approvals: structuredClone(record.approvals),
    };
  }
}
