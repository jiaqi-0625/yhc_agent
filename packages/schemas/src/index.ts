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
