import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  ClaimValidationRequestSchema,
  VehicleSnapshotRequestSchema,
  type ClaimValidationRequest,
  type VehicleSnapshotRequest,
} from "@firefly/schemas";

import type { InMemoryVehicleService, ToolExecutionScope } from "./vehicle-service.ts";

function textResult<T>(details: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

export function createVehicleTools(
  service: InMemoryVehicleService,
  scope: ToolExecutionScope,
): readonly AgentTool[] {
  const getVehicleSnapshot: AgentTool<typeof VehicleSnapshotRequestSchema> = {
    name: "get_vehicle_snapshot",
    label: "获取车型事实快照",
    description: "为当前认证项目获取版本化车型事实快照。项目、租户和品牌权限由服务端会话注入。",
    parameters: VehicleSnapshotRequestSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: VehicleSnapshotRequest) {
      return textResult(service.createSnapshot(params, scope));
    },
  };

  const validateVehicleClaims: AgentTool<typeof ClaimValidationRequestSchema> = {
    name: "validate_vehicle_claims",
    label: "校验车型宣传表述",
    description:
      "对照当前项目的车型快照校验广告表述；支持项返回事实来源与风险备注，禁用项返回命中的具体表达，未验证内容不得作为官方事实使用。",
    parameters: ClaimValidationRequestSchema,
    async execute(_toolCallId, params: ClaimValidationRequest) {
      return textResult(service.validateClaims(params, scope));
    },
  };

  return [getVehicleSnapshot, validateVehicleClaims];
}
