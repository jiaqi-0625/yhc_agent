# AG-002 TaskContext 与 Agent 交互契约

> 状态：已采用 WS-005 在 `a8e13b2` 冻结的共享契约，并复用 `packages/schemas/test/fixtures/workspace-v2.ts`。

## 目标

对话会话只绑定一条 `VideoTask`。身份、权限、预算、任务归属和运行锁由服务端认证会话及领域策略解析，浏览器和模型提交的同类声明均不可信。

## `TaskContext` v1

共享结构由以下只读摘要组成：

- `schemaVersion: 1` 与 `kind: "task_context"`；
- `brand`：品牌 ID 和名称；
- `vehicle`：车型 ID、展示名称和事实版本；
- `batchProject`：批次项目 ID、名称和画幅；
- `videoTask`：任务 ID、名称、状态、当前阶段、revision、负责人状态，以及可选的车型/资产快照 ID；
- `productionBrief`：任务级受众、主题、时长和平台标签。

契约明确排除 tenant、账号/操作者 ID、角色、权限、额度、运行锁、Provider 私有字段、下载地址和凭据。负责人字段只表达当前认证账号相对任务的只读状态，不能作为授权凭据。

## `AgentActionCard` v1

共享卡片包含 `schemaVersion`、`kind`、`videoTaskId`、`action`、`expectedRevision`、`label`、`summary`、结构化 `cost` 和版本化 `payload`。冻结动作包括策略生成、策略确认请求和阶段回退请求。

卡片只是建议，不授予执行或审批权限。用户明确点击后，统一命令 API 仍须重新校验认证身份、任务归属、负责人、状态、revision、预算和服务端幂等性；卡片本身不携带客户端自定义的权限或幂等键。

## `AgentStreamEvent` v1

这是对话线在冻结业务契约之上的流式传输契约。每个事件包含稳定 `eventId`、单次运行内递增的 `sequence`、`sessionId`、`runId`、可选 `videoTaskId` 和时间戳。事件覆盖运行开始、思考状态、消息开始/增量/完成、工具状态、计划、操作卡片、错误和运行完成。SSE 使用 `id:` 传输稳定 ID，前端按 ID 去重，并在序号断档时进入可重试错误态。

## 兼容与待完成项

- 旧 `workId` 只在兼容入口接受，由服务端解析为 `videoTaskId` 和共享 `TaskContext`；新会话不再把旧作品对象作为业务状态来源。
- 当前旧作品 API 仍是本地垂直切片适配器。真正的跨账号隔离依赖 WS-301/WS-304 的 `SessionScope` 和 `VideoTask` API。
- 统一命令执行、服务端幂等、实际成本和权限错误卡片依赖 WS-305/WS-107；这些依赖完成前，不宣称操作卡片执行闭环完成。
