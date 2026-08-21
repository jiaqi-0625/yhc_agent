import { createHash, randomUUID } from "node:crypto";

import {
  assertCanOperateVideoTask,
  assertCanViewBatchProject,
  assertCanViewVideoTask,
  confirmVideoTaskStage,
  deriveStageConfirmationDependencies,
  lockVideoTaskAssetSnapshot,
  nextVideoTaskWorkflowState,
  rollbackVideoTaskStage,
  StageConfirmationDeniedError,
  validateStrategy,
  type VideoTaskProductionRecord,
  type WorkspaceSessionScope,
} from "@firefly/domain";
import type {
  AssetReference,
  BatchProject,
  ConfirmVideoTaskStageRequest,
  ConfirmVideoTaskStageResponse,
  RollbackVideoTaskStageRequest,
  RollbackVideoTaskStageResponse,
  StageArtifactContentReference,
  StageMutationReceipt,
  VideoTaskStage,
  VideoTaskStageAuditResponse,
  VideoTaskStageVersionsResponse,
} from "@firefly/schemas";

import type { BatchProjectStore } from "./batch-project-store.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import type {
  ProjectAssetRuntime,
  TaskAssetSelectionResolver,
  TaskAssetSelectionResolverFactory,
} from "./project-asset-runtime.ts";
import type { VideoTaskProductionStore } from "./video-task-store.ts";
import type {
  WorkspaceAdminState,
  WorkspaceAdminStore,
} from "./workspace-admin-store.ts";

type StageRuntimeIdKind =
  | "artifact_version"
  | "confirmation"
  | "rollback"
  | "invalidation"
  | "project_asset_pool"
  | "task_asset_snapshot"
  | "stage_mutation_receipt";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function runtimeError(code: string, message: string, statusCode: number): BusinessRuntimeError {
  return new BusinessRuntimeError(code, message, statusCode);
}

function assetReferenceSortKey(
  asset: Readonly<AssetReference>,
): string {
  if (asset.source === "company_catalog") {
    return [asset.source, asset.sourceProvider, asset.assetId, asset.version, asset.category].join(":");
  }
  return [
    asset.source,
    asset.batchProjectId,
    asset.assetId,
    asset.version,
    asset.category,
    asset.checksumSha256.toLowerCase(),
  ].join(":");
}

function confirmationPayloadHash(
  projectId: string,
  videoTaskId: string,
  stage: VideoTaskStage,
  input: Readonly<ConfirmVideoTaskStageRequest>,
): string {
  return sha256({
    projectId,
    videoTaskId,
    stage,
    action: "confirm_stage",
    expectedTaskRevision: input.expectedTaskRevision,
    ...(input.artifact === undefined
      ? {}
      : {
          artifact: {
            ...input.artifact,
            contentHashSha256: input.artifact.contentHashSha256.toLowerCase(),
          },
        }),
    ...(input.assetSelection === undefined
      ? {}
      : {
          assetSelection: {
            expectedProjectAssetPoolRevision:
              input.assetSelection.expectedProjectAssetPoolRevision,
            selectedAssets: input.assetSelection.selectedAssets
              .map((asset) =>
                asset.source === "local_upload"
                  ? { ...asset, checksumSha256: asset.checksumSha256.toLowerCase() }
                  : asset
              )
              .sort((left, right) => assetReferenceSortKey(left).localeCompare(assetReferenceSortKey(right), "en")),
          },
        }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  });
}

function rollbackPayloadHash(
  projectId: string,
  videoTaskId: string,
  stage: VideoTaskStage,
  input: Readonly<RollbackVideoTaskStageRequest>,
): string {
  return sha256({
    projectId,
    videoTaskId,
    stage,
    action: "rollback_stage",
    expectedTaskRevision: input.expectedTaskRevision,
    targetArtifactVersionId: input.targetArtifactVersionId,
    reason: input.reason,
  });
}

function sameArtifactReference(
  left: Readonly<StageArtifactContentReference>,
  right: Readonly<StageArtifactContentReference>,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.schemaName === right.schemaName &&
    left.schemaVersion === right.schemaVersion &&
    left.contentHashSha256.toLowerCase() === right.contentHashSha256.toLowerCase()
  );
}

export class VideoTaskStageRuntime {
  constructor(
    private readonly administration: WorkspaceAdminStore,
    private readonly projects: BatchProjectStore,
    private readonly tasks: VideoTaskProductionStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: (kind: StageRuntimeIdKind) => string =
      (kind) => `${kind}_${randomUUID()}`,
    private readonly projectAssets?: ProjectAssetRuntime,
  ) {}

  #currentScope(
    session: Readonly<WorkspaceSessionScope>,
    state: Readonly<WorkspaceAdminState>,
  ): WorkspaceSessionScope {
    return {
      actorAccountId: session.actorAccountId,
      tenantId: session.tenantId,
      role: session.role,
      accessGrants: state.accessGrants.filter(
        (grant) => grant.accountId === session.actorAccountId,
      ),
    };
  }

  #assertCreator(scope: Readonly<WorkspaceSessionScope>): void {
    if (scope.role !== "creator") {
      throw runtimeError(
        "AIC-AUTH-ROLE_DENIED",
        "Only an authorized production account can change video task stages.",
        403,
      );
    }
  }

  async #project(tenantId: string, projectId: string): Promise<BatchProject> {
    const aggregate = await this.projects.load(tenantId, projectId);
    if (!aggregate) {
      throw runtimeError(
        "AIC-STAGE-PROJECT_NOT_FOUND",
        `Batch project '${projectId}' was not found.`,
        404,
      );
    }
    return aggregate.project;
  }

  #assertTaskBelongsToProject(
    record: Readonly<VideoTaskProductionRecord>,
    project: Readonly<BatchProject>,
    videoTaskId: string,
  ): void {
    if (
      record.videoTask.tenantId !== project.tenantId ||
      record.videoTask.batchProjectId !== project.id
    ) {
      throw runtimeError(
        "AIC-STAGE-TASK_NOT_FOUND",
        `Video task '${videoTaskId}' was not found.`,
        404,
      );
    }
  }

  async #readAuthorized(
    projectId: string,
    videoTaskId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VideoTaskProductionRecord> {
    return this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = this.#currentScope(session, state);
      const project = await this.#project(scope.tenantId, projectId);
      assertCanViewBatchProject(scope, project);
      const record = await this.tasks.load(videoTaskId);
      if (!record) {
        throw runtimeError(
          "AIC-STAGE-TASK_NOT_FOUND",
          `Video task '${videoTaskId}' was not found.`,
          404,
        );
      }
      this.#assertTaskBelongsToProject(record, project, videoTaskId);
      assertCanViewVideoTask(scope, project, record.videoTask);
      return structuredClone(record);
    });
  }

  async getStageVersions(
    projectId: string,
    videoTaskId: string,
    stage: VideoTaskStage,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VideoTaskStageVersionsResponse> {
    const record = await this.#readAuthorized(projectId, videoTaskId, session);
    const activeArtifactVersionId = record.activeStageArtifactVersionIds[stage];
    const selectedStrategyArtifact = stage === "strategy"
      ? record.stageArtifactVersions.find(
          (version) =>
            version.id === activeArtifactVersionId &&
            version.stage === "strategy" &&
            version.content.schemaName === "video_task_strategy_draft",
        )
      : undefined;
    const selectedStrategyDraft = selectedStrategyArtifact === undefined
      ? undefined
      : record.strategyDrafts.find(
          (draft) => draft.id === selectedStrategyArtifact.content.artifactId,
        );
    const currentStrategyDraft = stage === "strategy"
      ? record.strategyDrafts.find((draft) => draft.id === record.activeStrategyDraftId)
      : undefined;
    const activeStrategyDraft = record.videoTask.currentStage === "strategy"
      ? currentStrategyDraft ?? selectedStrategyDraft
      : selectedStrategyDraft ?? currentStrategyDraft;
    const confirmationRequest = activeStrategyDraft === undefined
      ? undefined
      : [...record.stageConfirmationRequests].reverse().find(
          (request) => request.strategyDraftId === activeStrategyDraft.id,
        );
    const generatedArtifact = stage === "storyboard" || stage === "video_preview" || stage === "delivery"
      ? this.#simulatedStageArtifact(record, stage, undefined)
      : undefined;
    return {
      videoTask: structuredClone(record.videoTask),
      ...(activeArtifactVersionId === undefined ? {} : { activeArtifactVersionId }),
      versions: record.stageArtifactVersions
        .filter((version) => version.stage === stage)
        .sort((left, right) => left.version - right.version || left.id.localeCompare(right.id, "en"))
        .map((version) => structuredClone(version)),
      confirmations: record.stageConfirmations
        .filter((confirmation) => confirmation.stage === stage)
        .sort((left, right) =>
          left.occurredAt.localeCompare(right.occurredAt, "en") ||
          left.id.localeCompare(right.id, "en"))
        .map((confirmation) => structuredClone(confirmation)),
      rollbacks: record.stageRollbacks
        .filter((rollback) => rollback.stage === stage)
        .map((rollback) => structuredClone(rollback)),
      invalidations: record.stageArtifactInvalidations
        .filter((invalidation) => invalidation.stage === stage)
        .map((invalidation) => structuredClone(invalidation)),
      ...(stage === "strategy"
        ? {
            strategyDrafts: [...record.strategyDrafts]
              .sort((left, right) =>
                left.version - right.version || left.id.localeCompare(right.id, "en"))
              .map((draft) => structuredClone(draft)),
          }
        : {}),
      ...(activeStrategyDraft === undefined
        ? {}
        : { activeStrategyDraft: structuredClone(activeStrategyDraft) }),
      ...(confirmationRequest === undefined
        ? {}
        : { confirmationRequest: structuredClone(confirmationRequest) }),
      ...(generatedArtifact === undefined
        ? {}
        : { generatedArtifact: structuredClone(generatedArtifact) }),
    };
  }

  async getStageAudit(
    projectId: string,
    videoTaskId: string,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<VideoTaskStageAuditResponse> {
    const record = await this.#readAuthorized(projectId, videoTaskId, session);
    return {
      videoTask: structuredClone(record.videoTask),
      rollbacks: structuredClone(record.stageRollbacks),
      invalidations: structuredClone(record.stageArtifactInvalidations),
    };
  }

  #strategyArtifact(
    record: Readonly<VideoTaskProductionRecord>,
    proposed: Readonly<StageArtifactContentReference> | undefined,
  ): StageArtifactContentReference {
    const draft = record.strategyDrafts.find(
      (candidate) =>
        candidate.id === record.activeStrategyDraftId &&
        candidate.status === "awaiting_confirmation",
    );
    if (!draft) {
      throw runtimeError(
        "AIC-STAGE-STRATEGY_DRAFT_NOT_FOUND",
        "The task has no active strategy draft awaiting human confirmation.",
        409,
      );
    }
    const request = record.stageConfirmationRequests.find(
      (candidate) => candidate.strategyDraftId === draft.id,
    );
    if (!request && draft.generation.kind !== "legacy_migration") {
      throw runtimeError(
        "AIC-STAGE-CONFIRMATION_REQUEST_NOT_FOUND",
        "The active strategy draft has no persisted human confirmation request.",
        409,
      );
    }
    const vehicleSnapshot = record.taskVehicleSnapshots.find(
      (snapshot) => snapshot.id === draft.vehicleSnapshotId,
    );
    if (!vehicleSnapshot) {
      throw runtimeError(
        "AIC-STAGE-SNAPSHOT_MIGRATION_REQUIRED",
        "The strategy draft's locked vehicle facts require an explicit snapshot migration.",
        409,
      );
    }
    if (!validateStrategy(draft, vehicleSnapshot).valid) {
      throw runtimeError(
        "AIC-STAGE-STRATEGY_INVALID",
        "The active strategy draft no longer validates against its locked vehicle facts.",
        409,
      );
    }
    const derived: StageArtifactContentReference = {
      artifactId: draft.id,
      schemaName: "video_task_strategy_draft",
      schemaVersion: draft.schemaVersion,
      contentHashSha256: sha256(draft),
    };
    if (proposed !== undefined && !sameArtifactReference(proposed, derived)) {
      throw runtimeError(
        "AIC-STAGE-STRATEGY_ARTIFACT_MISMATCH",
        "The proposed strategy artifact does not match the active server draft.",
        409,
      );
    }
    return derived;
  }

  #scriptArtifact(
    record: Readonly<VideoTaskProductionRecord>,
    proposed: Readonly<StageArtifactContentReference> | undefined,
  ): StageArtifactContentReference | undefined {
    if (proposed !== undefined) return structuredClone(proposed);
    const script = record.videoTask.scriptInput;
    if (script === undefined || record.videoTask.currentStage !== "script") return undefined;
    const contentHashSha256 = createHash("sha256").update(script).digest("hex");
    const generated = [...record.commandReceipts].reverse().find(
      (receipt) =>
        receipt.action === "generate_script" &&
        receipt.result.kind === "script_generated" &&
        receipt.result.scriptContentHashSha256 === contentHashSha256 &&
        receipt.resultingTaskRevision <= record.videoTask.revision,
    );
    if (generated === undefined) {
      throw runtimeError(
        "AIC-STAGE-SCRIPT_DRAFT_NOT_FOUND",
        "The task has no server-persisted generated script awaiting human confirmation.",
        409,
      );
    }
    return {
      artifactId: `script_draft_${contentHashSha256.slice(0, 48)}`,
      schemaName: "video_task_script_draft",
      schemaVersion: 1,
      contentHashSha256,
    };
  }

  #simulatedStageArtifact(
    record: Readonly<VideoTaskProductionRecord>,
    stage: Extract<VideoTaskStage, "storyboard" | "video_preview" | "delivery">,
    proposed: Readonly<StageArtifactContentReference> | undefined,
  ): StageArtifactContentReference | undefined {
    if (proposed !== undefined) return structuredClone(proposed);
    const generated = [...record.commandReceipts].reverse().find(
      (receipt) =>
        receipt.action === "generate_simulated_stage_artifact" &&
        receipt.result.kind === "simulated_stage_artifact_generated" &&
        receipt.result.stage === stage &&
        receipt.resultingTaskRevision <= record.videoTask.revision,
    );
    if (generated?.result.kind !== "simulated_stage_artifact_generated") return undefined;
    const contentHashSha256 = generated.result.artifactContentHashSha256;
    return {
      artifactId: `ws503_${stage}_${contentHashSha256.slice(0, 40)}`,
      schemaName: `ws503_simulated_${stage}`,
      schemaVersion: 1,
      contentHashSha256,
    };
  }

  #receiptCollision(
    record: Readonly<VideoTaskProductionRecord>,
    actorAccountId: string,
    requestId: string,
  ): boolean {
    return record.commandReceipts.some(
      (receipt) =>
        receipt.actorAccountId === actorAccountId && receipt.requestId === requestId,
    );
  }

  #stageReceipt(
    record: Readonly<VideoTaskProductionRecord>,
    actorAccountId: string,
    requestId: string,
  ): StageMutationReceipt | undefined {
    return record.stageMutationReceipts.find(
      (receipt) =>
        receipt.actorAccountId === actorAccountId && receipt.requestId === requestId,
    );
  }

  async confirmStage(
    projectId: string,
    videoTaskId: string,
    stage: VideoTaskStage,
    input: Readonly<ConfirmVideoTaskStageRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<ConfirmVideoTaskStageResponse> {
    this.#assertCreator(session);
    if (stage === "asset_matching") {
      if (input.assetSelection === undefined) {
        throw runtimeError(
          "AIC-STAGE-ASSET-SELECTION-REQUIRED",
          "Asset matching confirmation requires an exact project asset selection.",
          409,
        );
      }
      if (input.artifact !== undefined) {
        throw runtimeError(
          "AIC-STAGE-ASSET-ARTIFACT-SERVER-OWNED",
          "The asset matching artifact is derived from the server-locked task snapshot.",
          409,
        );
      }
      if (this.projectAssets === undefined) {
        throw runtimeError(
          "AIC-STAGE-ASSET-SELECTION-UNAVAILABLE",
          "Task asset selection is not configured for this workspace runtime.",
          503,
        );
      }
    } else if (input.assetSelection !== undefined) {
      throw runtimeError(
        "AIC-STAGE-ASSET-SELECTION-NOT-ALLOWED",
        "Only asset matching confirmation accepts a task asset selection.",
        409,
      );
    }
    const payloadHash = confirmationPayloadHash(projectId, videoTaskId, stage, input);
    let replayed = false;
    const execute = (createSelectionResolver?: TaskAssetSelectionResolverFactory) =>
      this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = this.#currentScope(session, state);
      this.#assertCreator(scope);
      const project = await this.#project(scope.tenantId, projectId);
      assertCanViewBatchProject(scope, project);
      const occurredAt = this.now();
      const transact = (resolveSelection?: TaskAssetSelectionResolver) =>
        this.tasks.transact(videoTaskId, async (current) => {
        if (!current) {
          throw runtimeError(
            "AIC-STAGE-TASK_NOT_FOUND",
            `Video task '${videoTaskId}' was not found.`,
            404,
          );
        }
        this.#assertTaskBelongsToProject(current, project, videoTaskId);
        assertCanViewVideoTask(scope, project, current.videoTask);
        const existing = this.#stageReceipt(current, scope.actorAccountId, input.requestId);
        if (existing) {
          if (
            existing.action !== "confirm_stage" ||
            existing.result.stage !== stage ||
            existing.payloadHash !== payloadHash
          ) {
            throw runtimeError(
              "AIC-STAGE-IDEMPOTENCY_CONFLICT",
              "The stage request ID was already used with different business input.",
              409,
            );
          }
          replayed = true;
          return structuredClone(current);
        }
        if (this.#receiptCollision(current, scope.actorAccountId, input.requestId)) {
          throw runtimeError(
            "AIC-STAGE-IDEMPOTENCY_CONFLICT",
            "The stage request ID was already used by another task command.",
            409,
          );
        }
        if (project.status !== "active") {
          throw runtimeError(
            "AIC-STAGE-PROJECT_INACTIVE",
            "Stage confirmations can only change an active batch project.",
            409,
          );
        }
        assertCanOperateVideoTask(scope, project, current.videoTask);
        let confirmationRecord = current;
        let artifact: StageArtifactContentReference | undefined;
        if (stage === "asset_matching") {
          if (resolveSelection === undefined) {
            throw new Error("Asset matching confirmation is missing its coordinated selection resolver.");
          }
          const task = current.videoTask;
          const confirmsEditableSelection =
            task.status === "active" &&
            task.currentStage === "asset_matching" &&
            task.stageStatus === "in_progress";
          const confirmsSubmittedSelection =
            task.status === "active" &&
            task.currentStage === "asset_matching" &&
            task.stageStatus === "awaiting_confirmation";
          if (!confirmsEditableSelection && !confirmsSubmittedSelection) {
            throw new StageConfirmationDeniedError(
              "Only the current editable or awaiting asset selection can be confirmed.",
            );
          }
          if (confirmsEditableSelection) {
            const submitted = nextVideoTaskWorkflowState(
              {
                taskStatus: task.status,
                currentStage: task.currentStage,
                stageStatus: task.stageStatus,
              },
              { type: "stage_confirmation_requested", stage: "asset_matching" },
            );
            confirmationRecord = {
              ...structuredClone(current),
              videoTask: {
                ...structuredClone(task),
                status: submitted.taskStatus,
                currentStage: submitted.currentStage,
                stageStatus: submitted.stageStatus,
              },
            };
          }
          const selectedPool = await resolveSelection();
          confirmationRecord = lockVideoTaskAssetSnapshot(
            confirmationRecord,
            project,
            selectedPool,
            input.expectedTaskRevision,
            {
              tenantId: scope.tenantId,
              actorAccountId: scope.actorAccountId,
              occurredAt,
              createId: (kind) => this.createId(kind),
            },
            {
              advanceTaskRevision: false,
              replaceExistingAssetSnapshot: true,
            },
          );
          const snapshot = confirmationRecord.taskAssetSnapshots.at(-1);
          if (snapshot === undefined || confirmationRecord.videoTask.assetSnapshotId !== snapshot.id) {
            throw new Error("Asset matching confirmation did not append its task snapshot.");
          }
          artifact = {
            artifactId: snapshot.id,
            schemaName: "task_asset_snapshot",
            schemaVersion: 1,
            contentHashSha256: sha256(snapshot),
          };
        } else {
          artifact = stage === "strategy"
            ? this.#strategyArtifact(current, input.artifact)
            : stage === "script"
              ? this.#scriptArtifact(current, input.artifact)
              : stage === "storyboard" || stage === "video_preview" || stage === "delivery"
                ? this.#simulatedStageArtifact(current, stage, input.artifact)
                : input.artifact;
        }
        if (artifact === undefined) {
          throw runtimeError(
            "AIC-STAGE-ARTIFACT_REQUIRED",
            "A non-strategy stage confirmation requires a persisted artifact reference.",
            409,
          );
        }
        const confirmed = confirmVideoTaskStage(
          confirmationRecord,
          {
            expectedTaskRevision: input.expectedTaskRevision,
            stage,
            artifact,
            dependencies: deriveStageConfirmationDependencies(confirmationRecord, stage),
            ...(input.comment === undefined ? {} : { comment: input.comment }),
          },
          {
            tenantId: scope.tenantId,
            batchProjectId: project.id,
            actorAccountId: scope.actorAccountId,
            occurredAt,
            createId: this.createId,
          },
        );
        const confirmation = confirmed.stageConfirmations.at(-1);
        const artifactVersion = confirmed.stageArtifactVersions.at(-1);
        if (!confirmation || !artifactVersion || confirmation.artifactVersionId !== artifactVersion.id) {
          throw new Error("Stage confirmation did not append its linked audit records.");
        }
        const receipt: StageMutationReceipt = {
          schemaVersion: 1,
          id: this.createId("stage_mutation_receipt"),
          tenantId: current.videoTask.tenantId,
          batchProjectId: current.videoTask.batchProjectId,
          videoTaskId: current.videoTask.id,
          actorAccountId: scope.actorAccountId,
          requestId: input.requestId,
          payloadHash,
          action: "confirm_stage",
          expectedTaskRevision: input.expectedTaskRevision,
          resultingTaskRevision: confirmed.videoTask.revision,
          result: {
            kind: "stage_confirmed",
            stage,
            confirmationId: confirmation.id,
            artifactVersionId: artifactVersion.id,
          },
          occurredAt,
        };
        return {
          ...confirmed,
          stageMutationReceipts: [...structuredClone(confirmed.stageMutationReceipts), receipt],
        };
      });
      if (stage !== "asset_matching") return transact();
      const selection = input.assetSelection!;
      if (createSelectionResolver === undefined) {
        throw new Error("Asset matching confirmation did not acquire the project asset coordinator.");
      }
      return transact(createSelectionResolver(
        project,
        selection.expectedProjectAssetPoolRevision,
        selection.selectedAssets,
        scope,
      ));
    });
    const record = stage === "asset_matching"
      ? await this.projectAssets!.coordinateTaskAssetSelection(projectId, execute)
      : await execute();
    const receipt = this.#stageReceipt(record, session.actorAccountId, input.requestId);
    if (!receipt || receipt.action !== "confirm_stage") {
      throw new Error("Stage confirmation did not persist its idempotency receipt.");
    }
    const confirmation = record.stageConfirmations.find(
      (candidate) => candidate.id === receipt.result.confirmationId,
    );
    const artifactVersion = record.stageArtifactVersions.find(
      (candidate) => candidate.id === receipt.result.artifactVersionId,
    );
    if (!confirmation || !artifactVersion) {
      throw new Error("Stage confirmation receipt points to missing audit records.");
    }
    return {
      replayed,
      receipt: structuredClone(receipt),
      videoTask: structuredClone(record.videoTask),
      confirmation: structuredClone(confirmation),
      artifactVersion: structuredClone(artifactVersion),
    };
  }

  async rollbackStage(
    projectId: string,
    videoTaskId: string,
    stage: VideoTaskStage,
    input: Readonly<RollbackVideoTaskStageRequest>,
    session: Readonly<WorkspaceSessionScope>,
  ): Promise<RollbackVideoTaskStageResponse> {
    this.#assertCreator(session);
    const payloadHash = rollbackPayloadHash(projectId, videoTaskId, stage, input);
    let replayed = false;
    const record = await this.administration.withSnapshot(session.tenantId, async (state) => {
      const scope = this.#currentScope(session, state);
      this.#assertCreator(scope);
      const project = await this.#project(scope.tenantId, projectId);
      assertCanViewBatchProject(scope, project);
      return this.tasks.transact(videoTaskId, (current) => {
        if (!current) {
          throw runtimeError(
            "AIC-STAGE-TASK_NOT_FOUND",
            `Video task '${videoTaskId}' was not found.`,
            404,
          );
        }
        this.#assertTaskBelongsToProject(current, project, videoTaskId);
        assertCanViewVideoTask(scope, project, current.videoTask);
        const existing = this.#stageReceipt(current, scope.actorAccountId, input.requestId);
        if (existing) {
          if (
            existing.action !== "rollback_stage" ||
            existing.result.stage !== stage ||
            existing.payloadHash !== payloadHash
          ) {
            throw runtimeError(
              "AIC-STAGE-IDEMPOTENCY_CONFLICT",
              "The stage request ID was already used with different business input.",
              409,
            );
          }
          replayed = true;
          return structuredClone(current);
        }
        if (this.#receiptCollision(current, scope.actorAccountId, input.requestId)) {
          throw runtimeError(
            "AIC-STAGE-IDEMPOTENCY_CONFLICT",
            "The stage request ID was already used by another task command.",
            409,
          );
        }
        if (project.status !== "active") {
          throw runtimeError(
            "AIC-STAGE-PROJECT_INACTIVE",
            "Stage rollbacks can only change an active batch project.",
            409,
          );
        }
        assertCanOperateVideoTask(scope, project, current.videoTask);
        const occurredAt = this.now();
        const rolledBack = rollbackVideoTaskStage(
          current,
          {
            expectedTaskRevision: input.expectedTaskRevision,
            stage,
            targetArtifactVersionId: input.targetArtifactVersionId,
            reason: input.reason,
          },
          {
            tenantId: scope.tenantId,
            batchProjectId: project.id,
            actorAccountId: scope.actorAccountId,
            occurredAt,
            createId: this.createId,
          },
        );
        const rollback = rolledBack.stageRollbacks.at(-1);
        if (!rollback) throw new Error("Stage rollback did not append its audit record.");
        const receipt: StageMutationReceipt = {
          schemaVersion: 1,
          id: this.createId("stage_mutation_receipt"),
          tenantId: current.videoTask.tenantId,
          batchProjectId: current.videoTask.batchProjectId,
          videoTaskId: current.videoTask.id,
          actorAccountId: scope.actorAccountId,
          requestId: input.requestId,
          payloadHash,
          action: "rollback_stage",
          expectedTaskRevision: input.expectedTaskRevision,
          resultingTaskRevision: rolledBack.videoTask.revision,
          result: {
            kind: "stage_rolled_back",
            stage,
            stageRollbackId: rollback.id,
            invalidationIds: structuredClone(rollback.invalidationIds),
          },
          occurredAt,
        };
        return {
          ...rolledBack,
          stageMutationReceipts: [...structuredClone(rolledBack.stageMutationReceipts), receipt],
        };
      });
    });
    const receipt = this.#stageReceipt(record, session.actorAccountId, input.requestId);
    if (!receipt || receipt.action !== "rollback_stage") {
      throw new Error("Stage rollback did not persist its idempotency receipt.");
    }
    const rollback = record.stageRollbacks.find(
      (candidate) => candidate.id === receipt.result.stageRollbackId,
    );
    if (!rollback) throw new Error("Stage rollback receipt points to a missing audit record.");
    const invalidations = receipt.result.invalidationIds.map((invalidationId) => {
      const invalidation = record.stageArtifactInvalidations.find(
        (candidate) => candidate.id === invalidationId,
      );
      if (!invalidation) {
        throw new Error("Stage rollback receipt points to a missing invalidation record.");
      }
      return structuredClone(invalidation);
    });
    return {
      replayed,
      receipt: structuredClone(receipt),
      videoTask: structuredClone(record.videoTask),
      rollback: structuredClone(rollback),
      invalidations,
    };
  }
}
