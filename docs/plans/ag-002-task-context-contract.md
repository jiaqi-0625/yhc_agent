# AG-002 TaskContext 与 Agent 交互契约提案

> 状态：已在 `agent/task-agent-panel` 实现并通过本线测试，等待工作区负责人按 WS-005 共同评审后冻结。

## 目标

对话会话只绑定一条 `VideoTask`，所有身份、权限、预算和运行锁均由服务端认证会话及领域策略解析，不能由浏览器或模型声明。

## `TaskContext` v1

必填字段：

- `schemaVersion`：当前固定为 `1`；
- `videoTaskId`、`batchProjectId`、`brandId`、`vehicleId`：任务及其只读业务归属；
- `taskStatus`、`currentStage`、`taskRevision`：操作卡片展示和乐观锁所需状态；
- `brandName`、`vehicleName`、`batchProjectName`、`videoTaskName`：对话区显式上下文提示；
- `brief`：任务级受众、主题、时长、脚本输入和平台标签。

可选字段：

- `vehicleSnapshotId`：策略开始后锁定的车型事实快照；
- `assetSnapshotId`：素材匹配开始后锁定的任务资产快照。

明确排除：`tenantId`、账号/操作者 ID、角色、权限、额度、运行锁、Provider 私有字段、下载地址和凭据。前四类信息仍存在于服务端 `SessionScope`，但不进入模型可见上下文。

## `AgentActionCard` v1

所有卡片必须包含 `id`、`idempotencyKey`、`videoTaskId`、`expectedRevision`、`action`、`label`、`summary` 和可选成本预估。当前只允许 `generate_strategy` 与 `request_strategy_approval` 两种建议；卡片本身不授予执行或审批权限，用户点击后仍由工作区命令 API 重新校验任务、负责人、状态、revision、预算和幂等键。

## `AgentStreamEvent` v1

每个事件包含稳定 `eventId`、单次运行内递增的 `sequence`、`sessionId`、`runId`、可选 `videoTaskId` 和时间戳。事件覆盖运行开始、思考状态、消息开始/增量/完成、工具状态、计划、操作卡片、错误和运行完成。SSE 使用 `id:` 传输同一稳定 ID，前端按 ID 去重并在序号断档时进入可重试错误态。

## 兼容与待冻结项

- 已有持久化会话 `schemaVersion: 1 + workId` 首次读取时由服务端解析为 `TaskContext`，随后原子回写为 v2；新会话不再写入 `workId`。
- 当前旧作品 API 仅作为本地垂直切片适配器，把 `workId` 映射为 `videoTaskId`。真正跨账号隔离依赖 WS-301/WS-304 的服务端 SessionScope 和 VideoTask API。
- 统一命令执行与成本/权限错误卡片依赖 WS-305/WS-107；在这些依赖完成前，本线不宣称操作卡片闭环已冻结。
