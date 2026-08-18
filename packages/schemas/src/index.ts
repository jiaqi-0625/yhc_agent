import { Type, type Static } from "typebox";

const NonEmptyString = Type.String({ minLength: 1 });
const Identifier = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const IsoDateTime = Type.String({ format: "date-time" });
const IsoDate = Type.String({ format: "date" });

export const RoleSchema = Type.Union([
  Type.Literal("creator"),
  Type.Literal("reviewer"),
  Type.Literal("content_admin"),
]);
export type Role = Static<typeof RoleSchema>;

export const WorkStatusSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("strategy_draft"),
  Type.Literal("awaiting_strategy_approval"),
  Type.Literal("strategy_approved"),
  Type.Literal("script_draft"),
  Type.Literal("awaiting_script_approval"),
  Type.Literal("script_approved"),
  Type.Literal("prompt_draft"),
  Type.Literal("awaiting_prompt_approval"),
  Type.Literal("prompt_approved"),
  Type.Literal("storyboard_draft"),
  Type.Literal("awaiting_storyboard_approval"),
  Type.Literal("storyboard_approved"),
  Type.Literal("rendering"),
  Type.Literal("final_review"),
  Type.Literal("export_ready"),
  Type.Literal("exported"),
]);
export type WorkStatus = Static<typeof WorkStatusSchema>;

export const ClaimEvidenceSchema = Type.Object(
  {
    sourceName: NonEmptyString,
    sourceReference: NonEmptyString,
    effectiveFrom: IsoDate,
    effectiveUntil: Type.Optional(IsoDate),
  },
  { additionalProperties: false },
);
export type ClaimEvidence = Static<typeof ClaimEvidenceSchema>;

export const ClaimSchema = Type.Object(
  {
    id: Identifier,
    kind: Type.Union([Type.Literal("fixed"), Type.Literal("extended")]),
    name: NonEmptyString,
    statement: NonEmptyString,
    value: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    unit: Type.Optional(Type.String()),
    evidence: Type.Optional(ClaimEvidenceSchema),
    requiredInVoiceover: Type.Boolean(),
    requiredInSubtitle: Type.Boolean(),
    mayRephrase: Type.Boolean(),
    riskNotes: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type Claim = Static<typeof ClaimSchema>;

export const CatalogRecordStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("archived"),
]);
export type CatalogRecordStatus = Static<typeof CatalogRecordStatusSchema>;

export const BrandSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    status: CatalogRecordStatusSchema,
    revision: Type.Integer({ minimum: 1 }),
    defaultVisualStylePresetId: Identifier,
    createdAt: IsoDateTime,
    createdBy: Identifier,
    updatedAt: IsoDateTime,
    updatedBy: Identifier,
  },
  { additionalProperties: false },
);
export type Brand = Static<typeof BrandSchema>;

export const VehicleSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    brandId: Identifier,
    version: Type.Integer({ minimum: 1 }),
    status: CatalogRecordStatusSchema,
    series: Type.String({ minLength: 1, maxLength: 120 }),
    modelYear: Type.Integer({ minimum: 2000, maximum: 2100 }),
    trim: Type.String({ minLength: 1, maxLength: 120 }),
    parameters: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
    fixedClaims: Type.Array(ClaimSchema),
    optionalClaims: Type.Array(ClaimSchema),
    prohibitedClaims: Type.Array(NonEmptyString),
    createdAt: IsoDateTime,
    createdBy: Identifier,
    updatedAt: IsoDateTime,
    updatedBy: Identifier,
  },
  { additionalProperties: false },
);
export type Vehicle = Static<typeof VehicleSchema>;

export const AspectRatioSchema = Type.String({
  minLength: 3,
  maxLength: 11,
  pattern: "^[1-9][0-9]*:[1-9][0-9]*$",
});
export type AspectRatio = Static<typeof AspectRatioSchema>;

export const BatchProjectSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    brandId: Identifier,
    vehicleId: Identifier,
    name: Type.String({ minLength: 1, maxLength: 240 }),
    batchName: Type.String({ minLength: 1, maxLength: 120 }),
    aspectRatio: AspectRatioSchema,
    visualStylePresetId: Identifier,
    customStylePrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    assetPoolId: Identifier,
    status: CatalogRecordStatusSchema,
    revision: Type.Integer({ minimum: 1 }),
    createdAt: IsoDateTime,
    createdBy: Identifier,
    updatedAt: IsoDateTime,
    updatedBy: Identifier,
  },
  { additionalProperties: false },
);
export type BatchProject = Static<typeof BatchProjectSchema>;

export const VideoTaskStageSchema = Type.Union([
  Type.Literal("strategy"),
  Type.Literal("asset_matching"),
  Type.Literal("script"),
  Type.Literal("storyboard"),
  Type.Literal("video_preview"),
  Type.Literal("delivery"),
]);
export type VideoTaskStage = Static<typeof VideoTaskStageSchema>;

export const VideoTaskStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("archived"),
]);
export type VideoTaskStatus = Static<typeof VideoTaskStatusSchema>;

export const VideoTaskSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    batchProjectId: Identifier,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    ownerAccountId: Identifier,
    status: VideoTaskStatusSchema,
    currentStage: VideoTaskStageSchema,
    revision: Type.Integer({ minimum: 1 }),
    vehicleSnapshotId: Type.Optional(Identifier),
    assetSnapshotId: Type.Optional(Identifier),
    audience: Type.String({ minLength: 1, maxLength: 500 }),
    theme: Type.String({ minLength: 1, maxLength: 500 }),
    durationSeconds: Type.Integer({ minimum: 1, maximum: 600 }),
    scriptInput: Type.Optional(Type.String({ minLength: 1, maxLength: 20000 })),
    platformTags: Type.Array(Identifier, { maxItems: 20, uniqueItems: true }),
    createdAt: IsoDateTime,
    createdBy: Identifier,
    updatedAt: IsoDateTime,
    updatedBy: Identifier,
  },
  { additionalProperties: false },
);
export type VideoTask = Static<typeof VideoTaskSchema>;

export const AssetCategorySchema = Type.Union([
  Type.Literal("vehicle"),
  Type.Literal("person"),
  Type.Literal("scene"),
  Type.Literal("visual_style"),
]);
export type AssetCategory = Static<typeof AssetCategorySchema>;

const CompanyAssetReferenceFields = {
  assetId: Identifier,
  version: Type.Integer({ minimum: 1 }),
  source: Type.Literal("company_catalog"),
  sourceProvider: Identifier,
};

export const CompanyVehicleAssetReferenceSchema = Type.Object(
  {
    ...CompanyAssetReferenceFields,
    category: Type.Literal("vehicle"),
    vehicleId: Identifier,
  },
  { additionalProperties: false },
);
export type CompanyVehicleAssetReference = Static<typeof CompanyVehicleAssetReferenceSchema>;

export const CompanyReusableAssetReferenceSchema = Type.Object(
  {
    ...CompanyAssetReferenceFields,
    category: Type.Union([
      Type.Literal("person"),
      Type.Literal("scene"),
      Type.Literal("visual_style"),
    ]),
  },
  { additionalProperties: false },
);
export type CompanyReusableAssetReference = Static<typeof CompanyReusableAssetReferenceSchema>;

export const TemporaryAssetReferenceSchema = Type.Object(
  {
    assetId: Identifier,
    version: Type.Integer({ minimum: 1 }),
    category: AssetCategorySchema,
    source: Type.Literal("local_upload"),
    batchProjectId: Identifier,
    checksumSha256: Type.String({ pattern: "^[A-Fa-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);
export type TemporaryAssetReference = Static<typeof TemporaryAssetReferenceSchema>;

export const AssetReferenceSchema = Type.Union([
  CompanyVehicleAssetReferenceSchema,
  CompanyReusableAssetReferenceSchema,
  TemporaryAssetReferenceSchema,
]);
export type AssetReference = Static<typeof AssetReferenceSchema>;

export const ProjectAssetPoolSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    batchProjectId: Identifier,
    vehicleId: Identifier,
    revision: Type.Integer({ minimum: 1 }),
    assets: Type.Array(AssetReferenceSchema, { minItems: 1, maxItems: 500 }),
    createdAt: IsoDateTime,
    createdBy: Identifier,
    updatedAt: IsoDateTime,
    updatedBy: Identifier,
  },
  { additionalProperties: false },
);
export type ProjectAssetPool = Static<typeof ProjectAssetPoolSchema>;

export const TaskAssetSnapshotSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    batchProjectId: Identifier,
    videoTaskId: Identifier,
    version: Type.Integer({ minimum: 1 }),
    sourceProjectAssetPoolRevision: Type.Integer({ minimum: 1 }),
    vehicleSnapshotId: Identifier,
    assets: Type.Array(AssetReferenceSchema, { minItems: 1, maxItems: 500 }),
    createdAt: IsoDateTime,
    createdBy: Identifier,
  },
  { additionalProperties: false },
);
export type TaskAssetSnapshot = Static<typeof TaskAssetSnapshotSchema>;

export const TemporaryAssetValidationStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("valid"),
  Type.Literal("needs_review"),
  Type.Literal("rejected"),
]);
export type TemporaryAssetValidationStatus = Static<typeof TemporaryAssetValidationStatusSchema>;

export const TemporaryAssetValidationIssueSchema = Type.Object(
  {
    code: Type.String({ pattern: "^AIC-ASSET-[A-Z0-9_-]+$" }),
    message: NonEmptyString,
  },
  { additionalProperties: false },
);
export type TemporaryAssetValidationIssue = Static<typeof TemporaryAssetValidationIssueSchema>;

export const TemporaryAssetSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    batchProjectId: Identifier,
    vehicleId: Identifier,
    version: Type.Integer({ minimum: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    category: AssetCategorySchema,
    fileName: Type.String({ minLength: 1, maxLength: 255, pattern: "^[^\\\\/\\r\\n]+$" }),
    mediaType: Type.String({ pattern: "^(image|video)/[A-Za-z0-9.+-]+$" }),
    byteSize: Type.Integer({ minimum: 1, maximum: 5000000000 }),
    width: Type.Integer({ minimum: 1, maximum: 32768 }),
    height: Type.Integer({ minimum: 1, maximum: 32768 }),
    checksumSha256: Type.String({ pattern: "^[A-Fa-f0-9]{64}$" }),
    sourceDescription: Type.String({ minLength: 1, maxLength: 2000 }),
    rightsDeclaration: Type.String({ minLength: 1, maxLength: 2000 }),
    rightsConfirmed: Type.Boolean(),
    validationStatus: TemporaryAssetValidationStatusSchema,
    validationIssues: Type.Array(TemporaryAssetValidationIssueSchema, { maxItems: 100 }),
    duplicateOfAssetId: Type.Optional(Identifier),
    expiresAt: Type.Optional(IsoDateTime),
    createdAt: IsoDateTime,
    createdBy: Identifier,
    updatedAt: IsoDateTime,
    updatedBy: Identifier,
  },
  { additionalProperties: false },
);
export type TemporaryAsset = Static<typeof TemporaryAssetSchema>;

export const StageArtifactContentReferenceSchema = Type.Object(
  {
    artifactId: Identifier,
    schemaName: Identifier,
    schemaVersion: Type.Integer({ minimum: 1 }),
    contentHashSha256: Type.String({ pattern: "^[A-Fa-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);
export type StageArtifactContentReference = Static<typeof StageArtifactContentReferenceSchema>;

export const StageArtifactDependencySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("stage_artifact"),
      stage: VideoTaskStageSchema,
      artifactVersionId: Identifier,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("vehicle_snapshot"),
      vehicleSnapshotId: Identifier,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("asset_snapshot"),
      assetSnapshotId: Identifier,
    },
    { additionalProperties: false },
  ),
]);
export type StageArtifactDependency = Static<typeof StageArtifactDependencySchema>;

export const StageArtifactProvenanceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("human_confirmation"),
      confirmationId: Identifier,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("migrated_confirmation"),
      legacyApprovalId: Identifier,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("legacy_inferred"),
      migrationId: Identifier,
      note: Type.String({ minLength: 1, maxLength: 2000 }),
    },
    { additionalProperties: false },
  ),
]);
export type StageArtifactProvenance = Static<typeof StageArtifactProvenanceSchema>;

export const StageArtifactVersionSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    batchProjectId: Identifier,
    videoTaskId: Identifier,
    stage: VideoTaskStageSchema,
    version: Type.Integer({ minimum: 1 }),
    content: StageArtifactContentReferenceSchema,
    dependencies: Type.Array(StageArtifactDependencySchema, { minItems: 1, maxItems: 500 }),
    provenance: StageArtifactProvenanceSchema,
    createdAt: IsoDateTime,
    createdBy: Identifier,
  },
  { additionalProperties: false },
);
export type StageArtifactVersion = Static<typeof StageArtifactVersionSchema>;

export const StageConfirmationSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    batchProjectId: Identifier,
    videoTaskId: Identifier,
    stage: VideoTaskStageSchema,
    artifactVersionId: Identifier,
    decision: Type.Literal("confirmed"),
    source: Type.Literal("human_action"),
    expectedTaskRevision: Type.Integer({ minimum: 1 }),
    actorAccountId: Identifier,
    comment: Type.Optional(Type.String({ maxLength: 2000 })),
    occurredAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type StageConfirmation = Static<typeof StageConfirmationSchema>;

export const RollbackStageRequestSchema = Type.Object(
  {
    expectedTaskRevision: Type.Integer({ minimum: 1 }),
    stage: VideoTaskStageSchema,
    targetArtifactVersionId: Identifier,
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export type RollbackStageRequest = Static<typeof RollbackStageRequestSchema>;

export const StageRollbackRecordSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    batchProjectId: Identifier,
    videoTaskId: Identifier,
    stage: VideoTaskStageSchema,
    fromArtifactVersionId: Identifier,
    toArtifactVersionId: Identifier,
    expectedTaskRevision: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
    requestedBy: Identifier,
    invalidationIds: Type.Array(Identifier, { maxItems: 500, uniqueItems: true }),
    occurredAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type StageRollbackRecord = Static<typeof StageRollbackRecordSchema>;

export const StageArtifactInvalidationReasonSchema = Type.Union([
  Type.Literal("upstream_rollback"),
  Type.Literal("upstream_invalidation"),
]);
export type StageArtifactInvalidationReason = Static<typeof StageArtifactInvalidationReasonSchema>;

export const StageArtifactInvalidationCauseSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("rollback"),
      reasonCode: Type.Literal("upstream_rollback"),
      rollbackId: Identifier,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("upstream_invalidation"),
      reasonCode: Type.Literal("upstream_invalidation"),
      invalidationId: Identifier,
    },
    { additionalProperties: false },
  ),
]);
export type StageArtifactInvalidationCause = Static<typeof StageArtifactInvalidationCauseSchema>;

export const StageArtifactInvalidationSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    batchProjectId: Identifier,
    videoTaskId: Identifier,
    stage: VideoTaskStageSchema,
    artifactVersionId: Identifier,
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
    invalidatedDependency: StageArtifactDependencySchema,
    cause: StageArtifactInvalidationCauseSchema,
    occurredAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type StageArtifactInvalidation = Static<typeof StageArtifactInvalidationSchema>;

export const VehicleSnapshotSchema = Type.Object(
  {
    id: Identifier,
    projectId: Identifier,
    vehicleId: Identifier,
    vehicleVersion: Type.Integer({ minimum: 1 }),
    brandId: Identifier,
    brand: NonEmptyString,
    series: NonEmptyString,
    modelYear: Type.Integer({ minimum: 2000, maximum: 2100 }),
    trim: NonEmptyString,
    color: Type.Optional(NonEmptyString),
    parameters: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
    fixedClaims: Type.Array(ClaimSchema),
    optionalClaims: Type.Array(ClaimSchema),
    prohibitedClaims: Type.Array(NonEmptyString),
    referenceAssetIds: Type.Array(Identifier),
    createdAt: IsoDateTime,
    createdBy: Identifier,
  },
  { additionalProperties: false },
);
export type VehicleSnapshot = Static<typeof VehicleSnapshotSchema>;

/** @deprecated Use BatchProjectSchema for Workspace V2 writes. */
export const ProjectSchema = Type.Object(
  {
    id: Identifier,
    tenantId: Identifier,
    brandId: Identifier,
    name: NonEmptyString,
    createdAt: IsoDateTime,
    createdBy: Identifier,
  },
  { additionalProperties: false },
);
export type Project = Static<typeof ProjectSchema>;

/** @deprecated Use VideoTaskSchema for Workspace V2 writes. */
export const WorkSchema = Type.Object(
  {
    id: Identifier,
    projectId: Identifier,
    status: WorkStatusSchema,
    revision: Type.Integer({ minimum: 1 }),
    vehicleSnapshotId: Type.Optional(Identifier),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type Work = Static<typeof WorkSchema>;

export const StrategyItemSchema = Type.Object(
  {
    id: Identifier,
    claimId: Identifier,
    kind: Type.Union([Type.Literal("fixed"), Type.Literal("extended")]),
    title: NonEmptyString,
    statement: NonEmptyString,
    rationale: NonEmptyString,
    order: Type.Integer({ minimum: 1 }),
    locked: Type.Boolean(),
    evidence: Type.Optional(ClaimEvidenceSchema),
  },
  { additionalProperties: false },
);
export type StrategyItem = Static<typeof StrategyItemSchema>;

export const StrategyStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("awaiting_approval"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
]);
export type StrategyStatus = Static<typeof StrategyStatusSchema>;

export const StrategySchema = Type.Object(
  {
    id: Identifier,
    workId: Identifier,
    vehicleSnapshotId: Identifier,
    version: Type.Integer({ minimum: 1 }),
    status: StrategyStatusSchema,
    audience: NonEmptyString,
    theme: NonEmptyString,
    items: Type.Array(StrategyItemSchema, { minItems: 1, maxItems: 20 }),
    model: NonEmptyString,
    templateVersion: NonEmptyString,
    createdAt: IsoDateTime,
    createdBy: Identifier,
    updatedAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type Strategy = Static<typeof StrategySchema>;

export const StrategyValidationIssueSchema = Type.Object(
  {
    code: Type.String({ pattern: "^AIC-STRATEGY-[A-Z0-9_-]+$" }),
    severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
    message: NonEmptyString,
    itemId: Type.Optional(Identifier),
    claimId: Type.Optional(Identifier),
  },
  { additionalProperties: false },
);
export type StrategyValidationIssue = Static<typeof StrategyValidationIssueSchema>;

export const StrategyValidationResultSchema = Type.Object(
  {
    valid: Type.Boolean(),
    issues: Type.Array(StrategyValidationIssueSchema),
  },
  { additionalProperties: false },
);
export type StrategyValidationResult = Static<typeof StrategyValidationResultSchema>;

export const StrategyApprovalSchema = Type.Object(
  {
    id: Identifier,
    workId: Identifier,
    strategyId: Identifier,
    decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
    comment: Type.Optional(Type.String({ maxLength: 2000 })),
    actorId: Identifier,
    occurredAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type StrategyApproval = Static<typeof StrategyApprovalSchema>;

export const GenerateStrategyRequestSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    audience: NonEmptyString,
    theme: NonEmptyString,
  },
  { additionalProperties: false },
);
export type GenerateStrategyRequest = Static<typeof GenerateStrategyRequestSchema>;

export const UpdateStrategyRequestSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    audience: NonEmptyString,
    theme: NonEmptyString,
    items: Type.Array(StrategyItemSchema, { minItems: 1, maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type UpdateStrategyRequest = Static<typeof UpdateStrategyRequestSchema>;

export const StrategyApprovalRequestSchema = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type StrategyApprovalRequest = Static<typeof StrategyApprovalRequestSchema>;

export const ProposeStrategyGenerationRequestSchema = Type.Object(
  {
    audience: NonEmptyString,
    theme: NonEmptyString,
  },
  { additionalProperties: false },
);
export type ProposeStrategyGenerationRequest = Static<typeof ProposeStrategyGenerationRequestSchema>;

export const ProposeStrategyApprovalRequestSchema = Type.Object({}, { additionalProperties: false });
export type ProposeStrategyApprovalRequest = Static<typeof ProposeStrategyApprovalRequestSchema>;

export const TaskContextOwnershipSchema = Type.Union([
  Type.Object(
    { state: Type.Literal("owned_by_current_account") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal("owned_by_other_account"),
      ownerDisplayName: Type.String({ minLength: 1, maxLength: 120 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { state: Type.Literal("unassigned") },
    { additionalProperties: false },
  ),
]);
export type TaskContextOwnership = Static<typeof TaskContextOwnershipSchema>;

/**
 * Server-resolved, read-only context for an Agent turn.
 *
 * This is display and generation context only. Authorization, account identity,
 * tenant scope, credentials, allowed actions, and budget authority must be
 * resolved again by the command API and are intentionally absent here.
 */
export const TaskContextSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("task_context"),
    brand: Type.Object(
      {
        id: Identifier,
        name: Type.String({ minLength: 1, maxLength: 120 }),
      },
      { additionalProperties: false },
    ),
    vehicle: Type.Object(
      {
        id: Identifier,
        displayName: Type.String({ minLength: 1, maxLength: 240 }),
        version: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    batchProject: Type.Object(
      {
        id: Identifier,
        name: Type.String({ minLength: 1, maxLength: 240 }),
        aspectRatio: AspectRatioSchema,
      },
      { additionalProperties: false },
    ),
    videoTask: Type.Object(
      {
        id: Identifier,
        name: Type.String({ minLength: 1, maxLength: 160 }),
        status: VideoTaskStatusSchema,
        currentStage: VideoTaskStageSchema,
        revision: Type.Integer({ minimum: 1 }),
        vehicleSnapshotId: Type.Optional(Identifier),
        assetSnapshotId: Type.Optional(Identifier),
        ownership: TaskContextOwnershipSchema,
      },
      { additionalProperties: false },
    ),
    productionBrief: Type.Object(
      {
        audience: Type.String({ minLength: 1, maxLength: 500 }),
        theme: Type.String({ minLength: 1, maxLength: 500 }),
        durationSeconds: Type.Integer({ minimum: 1, maximum: 600 }),
        platformTags: Type.Array(Identifier, { maxItems: 20, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type TaskContext = Static<typeof TaskContextSchema>;

export const AgentActionCostSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("free") },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("estimate_required") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("estimated"),
      amount: Type.Number({ minimum: 0 }),
      currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    },
    { additionalProperties: false },
  ),
]);
export type AgentActionCost = Static<typeof AgentActionCostSchema>;

const AgentActionCardFields = {
  schemaVersion: Type.Literal(1),
  kind: Type.Literal("agent_action_card"),
  videoTaskId: Identifier,
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  expectedRevision: Type.Integer({ minimum: 1 }),
  cost: AgentActionCostSchema,
};

export const GenerateStrategyActionPayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    audience: NonEmptyString,
    theme: NonEmptyString,
  },
  { additionalProperties: false },
);
export type GenerateStrategyActionPayload = Static<typeof GenerateStrategyActionPayloadSchema>;

export const RequestStrategyApprovalActionPayloadSchema = Type.Object(
  { schemaVersion: Type.Literal(1) },
  { additionalProperties: false },
);
export type RequestStrategyApprovalActionPayload = Static<typeof RequestStrategyApprovalActionPayloadSchema>;

export const RollbackStageActionPayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    stage: VideoTaskStageSchema,
    targetArtifactVersionId: Identifier,
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export type RollbackStageActionPayload = Static<typeof RollbackStageActionPayloadSchema>;

/**
 * A proposal rendered for a human. It is never an approval or authorization.
 * The command API must recalculate ownership, permissions, state, revision, and
 * billable cost before executing it.
 */
export const AgentActionCardSchema = Type.Union([
  Type.Object(
    {
      ...AgentActionCardFields,
      action: Type.Literal("generate_strategy"),
      label: Type.Literal("生成卖点策略草稿"),
      payload: GenerateStrategyActionPayloadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentActionCardFields,
      action: Type.Literal("request_strategy_approval"),
      label: Type.Literal("提交卖点策略人工审批"),
      payload: RequestStrategyApprovalActionPayloadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentActionCardFields,
      action: Type.Literal("rollback_stage"),
      label: Type.Literal("回退已确认阶段版本"),
      payload: RollbackStageActionPayloadSchema,
    },
    { additionalProperties: false },
  ),
]);
export type AgentActionCard = Static<typeof AgentActionCardSchema>;

/** @deprecated Compatibility contract; migrate producers to AgentActionCardSchema. */
export const StrategyActionProposalSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      kind: Type.Literal("action_proposal"),
      action: Type.Literal("generate_strategy"),
      label: Type.Literal("生成卖点策略草稿"),
      summary: NonEmptyString,
      expectedRevision: Type.Integer({ minimum: 1 }),
      payload: GenerateStrategyRequestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      kind: Type.Literal("action_proposal"),
      action: Type.Literal("request_strategy_approval"),
      label: Type.Literal("提交卖点策略人工审批"),
      summary: NonEmptyString,
      expectedRevision: Type.Integer({ minimum: 1 }),
      payload: StrategyApprovalRequestSchema,
    },
    { additionalProperties: false },
  ),
]);
export type StrategyActionProposal = Static<typeof StrategyActionProposalSchema>;

export const ValidateStrategyRequestSchema = Type.Object({}, { additionalProperties: false });
export type ValidateStrategyRequest = Static<typeof ValidateStrategyRequestSchema>;

export const StrategyDecisionRequestSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
    comment: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type StrategyDecisionRequest = Static<typeof StrategyDecisionRequestSchema>;

export const ErrorResponseSchema = Type.Object(
  {
    code: Type.String({ pattern: "^AIC-[A-Z]+-[A-Z0-9_-]+$" }),
    message: NonEmptyString,
    requestId: Identifier,
    retryable: Type.Boolean(),
    charged: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export const VehicleSnapshotRequestSchema = Type.Object(
  {
    vehicleId: Identifier,
    color: Type.Optional(NonEmptyString),
    region: Type.Optional(NonEmptyString),
    campaignDate: IsoDate,
  },
  { additionalProperties: false },
);
export type VehicleSnapshotRequest = Static<typeof VehicleSnapshotRequestSchema>;

export const CreateWorkRequestSchema = Type.Object(
  {
    vehicleId: Identifier,
    color: Type.Optional(NonEmptyString),
    region: Type.Optional(NonEmptyString),
    campaignDate: IsoDate,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);
export type CreateWorkRequest = Static<typeof CreateWorkRequestSchema>;

export const CopyWorkRequestSchema = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type CopyWorkRequest = Static<typeof CopyWorkRequestSchema>;

export const ClaimValidationRequestSchema = Type.Object(
  {
    snapshotId: Identifier,
    statements: Type.Array(NonEmptyString, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type ClaimValidationRequest = Static<typeof ClaimValidationRequestSchema>;
