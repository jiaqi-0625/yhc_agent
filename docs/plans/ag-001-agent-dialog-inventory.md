# AG-001 会话、流式时间线与作品绑定盘点

> 盘点日期：2026-08-18
> 实际分支：`agent/task-agent-panel`
> 基线：`main` / `58c7a6b`
> 对照开发线：`origin/agent/workspace-v2-foundation` / `768689c`

## 1. 结论

当前实现已经具备可复用的本地会话生命周期、消息持久化、运行时事件归一化、SSE 输出、时间线重建、工具结果脱敏和人工操作卡片雏形，但业务作用域仍是单一 `workId`：

- 会话记录、运行时工厂、API 请求、浏览器状态和界面提示都直接保存或传递 `workId`。
- 固定的 `LOCAL_AGENT_SCOPE` 提供 actor、tenant、project、role 和预算，未从认证会话及当前任务解析，也没有会话所有权校验。
- 流式事件只是 TypeScript 联合类型和临时 SSE 帧，没有共享、版本化 Schema、事件 ID、顺序号或恢复游标。
- 浏览器实时展示工具开始/结束，但不消费 `text_delta`；最终文本依赖 `complete` 帧一次性渲染。
- 历史时间线由持久化的 Pi 消息推断，不能完整重建原始运行时事件顺序、耗时、失败详情或操作卡片执行状态。

因此 AG-101 不能把 `workId` 机械改名为 `videoTaskId`。应先由 AG-002/AG-003 与工作区线冻结服务端解析的 `TaskContext`，再迁移会话存储、路由和前端恢复逻辑。

## 2. 当前链路

```text
浏览器选中 Work
  -> POST /v1/sessions { workId }
  -> API 仅确认 Work 存在
  -> LocalAgentRuntime 保存 session -> workId
  -> workAgentFactory 按 workId 装配领域 Agent
  -> Agent 读取固定 LOCAL_AGENT_SCOPE，并按 Work 状态校验工具
  -> runtime 归一化 Pi 事件
  -> SSE: runtime* -> complete | error
  -> Web 时间线显示工具事件，并从 complete 显示最终回答
```

权威业务状态来自 `LocalBusinessRuntime`，没有从对话历史重建，这一点符合产品边界；但会话与业务对象之间缺少租户、账号、品牌、批次项目和视频任务的完整服务端作用域。

## 3. 会话实现盘点

### 3.1 存储与恢复

实现位置：

- `packages/agent/src/session-store.ts`
- `packages/agent/src/local-runtime.ts`

当前 `PersistedLocalSession` 为 `schemaVersion: 1`，包含：

| 字段 | 现状 | V2 处理 |
|---|---|---|
| `id` | 文件名和内存 Map 主键 | 保留；继续限制字符和长度 |
| `workId?` | 唯一业务绑定 | 兼容读取，V2 写入改为 `videoTaskId` 和不可伪造的服务端作用域引用 |
| `createdAt` / `updatedAt` | 会话时间 | 保留 |
| `provider` / `modelId` | 创建会话时的模型配置 | 保留为审计元数据，不参与权限决定 |
| `messages` | 完整 Pi 消息 | 保留用于对话恢复，不得作为业务状态来源 |

可复用能力：

- 会话 ID 白名单和路径逃逸防护；
- 内存活动会话与磁盘恢复；
- 新建、读取摘要、读取 transcript、reset、abort 和 delete；
- 恢复消息后通过工厂重新装配 Agent；
- 同一进程内拒绝同一会话并发 prompt；
- 返回 transcript 前移除隐藏 thinking，并对工具参数、结果和敏感字段脱敏。

需要迁移或补强：

- `isPersistedSession` 仅做浅层手写校验，尚无版本化共享 Schema；
- `save` 直接覆盖 JSON 文件，没有临时文件加 rename 的原子替换；
- store 没有按 tenant/account/project/task 查询或校验的能力；
- `getSession`、`getTranscript`、prompt、reset、abort、delete 只凭 `sessionId`，没有调用者作用域；
- 会话没有 active owner、审计记录、事件游标或已执行操作的幂等键；
- 未绑定会话可存在，应继续只用于诊断，不能自动获得任务工具。

### 3.2 生命周期 API

实现位置：`apps/api/src/server.ts`

| 方法与路径 | 当前行为 | 缺口 |
|---|---|---|
| `POST /v1/sessions` | 接受可选客户端 `id`、`workId`，检查 Work 存在后创建 | 请求无共享 Schema；客户端可提议业务绑定；没有认证作用域与可见性校验 |
| `GET /v1/sessions/:id` | 返回会话摘要 | 没有账号/租户/任务隔离 |
| `GET /v1/sessions/:id/transcript` | 返回脱敏消息 | 没有隔离；历史事件信息不完整 |
| `POST /v1/sessions/:id/messages` | 非流式 prompt | 与流式接口重复；客户端断开触发 abort |
| `POST /v1/sessions/:id/messages-stream` | 输出 SSE runtime、complete、error | 无事件 ID、重放、心跳和断线恢复 |
| `POST /v1/sessions/:id/reset` | 中止后清空消息 | 保留业务绑定；没有审计或幂等契约 |
| `POST /v1/sessions/:id/abort` | 中止当前模型请求 | 可复用；仅返回布尔值 |
| `DELETE /v1/sessions/:id` | 中止并删除内存/磁盘记录 | 没有调用者权限与删除审计 |

## 4. 作品绑定与工具装配

实现位置：

- `apps/api/src/business-agent-runtime.ts`
- `packages/agent/src/local-runtime.ts`
- `packages/agent/src/factory.ts`
- `packages/domain/src/policy.ts`

当前绑定路径为 `session.workId -> LocalWorkAgentFactoryContext.workId -> business.getWork/bindStrategyWorkflow(workId)`。领域工具读取绑定 Work 的状态和策略端口，模型不需要提供 `workId`，这是可保留的安全模式。

主要耦合和风险：

- `LOCAL_AGENT_SCOPE` 是所有会话共用的固定 actor、tenant、project、role、品牌权限和预算；
- scope 没有 `videoTaskId`、`batchProjectId`、任务 owner 或快照版本；
- `SessionScope.projectId` 仍指向旧单项目占位符；
- 工具策略基于旧 `WorkStatus`，与 V2 六阶段尚未对齐；
- 工厂依赖具体的 `InMemoryVehicleService`，尚未面向版本化任务快照和可替换公司资产 Provider；
- 工具审计事件已有 actor/tenant/project，但没有 session、batch project、video task、快照版本、费用和幂等键；
- 操作建议从当前 Work revision 生成，但前端执行时使用“当前选中的 Work”拼接 URL，卡片自身没有可信业务绑定。

应保留的原则：

- 由服务端根据已认证会话和任务绑定装配工具，不接受模型提供身份、权限或对象作用域；
- 未注册工具默认拒绝，通用工具和批准工具显式拒绝；
- 工具调用前重新读取权威工作流状态并执行策略；
- 工具调用后统一脱敏和记录审计；
- Agent 只生成 proposal，实际写入必须由明确的人类操作触发并由后端复核。

## 5. 流式事件盘点

### 5.1 当前运行时事件

`LocalRuntimeEvent` 当前能产生：

| 事件 | 字段 | Web 实时消费 | V2 处理 |
|---|---|---|---|
| `agent_start` / `agent_end` | `occurredAt` | 否 | 可折叠为明确的 run 生命周期事件 |
| `turn_start` / `turn_end` | `occurredAt` | 否 | 保留语义并增加稳定 ID/顺序号 |
| `message_start` / `message_end` | `occurredAt` | 否 | 与版本化消息事件对齐 |
| `text_delta` | `delta`, `occurredAt` | 否 | 必须实时渲染并可按 message ID 去重 |
| `tool_start` | tool 名称、call ID、脱敏 input、时间 | 是 | 迁移为版本化工具状态事件 |
| `tool_end` | tool 名称、call ID、脱敏 output、错误、耗时、时间 | 是 | 区分成功、策略拒绝、执行错误和取消 |

SSE 外层另有：

- `runtime`：承载上述运行时事件；
- `complete`：承载会话摘要、最终文本、usage 和 stop reason，不重复 events；
- `error`：承载 code、message、retryable、charged。

### 5.2 必须迁移或新增的事件

为满足 AG-201，至少需要版本化覆盖：

- run/turn/message 生命周期；
- assistant 文本增量与最终消息；
- 安全的 thinking 摘要状态，而非隐藏思维链；
- 工具 queued/running/succeeded/failed/blocked/cancelled；
- Agent 计划及步骤状态；
- 结构化 `AgentActionCard` proposal；
- 用户执行卡片后的命令结果；
- 可恢复错误、不可恢复错误、取消和完成；
- usage、成本估算/实际费用的安全摘要。

每个事件需要 `schemaVersion`、`eventId`、`sequence`、`sessionId`、`videoTaskId`、`runId`、`occurredAt` 和类型化 payload。服务端必须支持基于最后事件 ID 的重放或明确返回无法恢复，客户端按 event ID 去重，不能仅依赖到达顺序。

当前缺口：

- 没有共享 TypeBox Schema 和运行时校验；
- 没有持久化事件日志，只有最终 Pi messages；
- 没有重连游标、事件去重、心跳或 backpressure 策略；
- `error` 总是 `retryable: false`、`charged: false`，未反映真实分类；
- 客户端 SSE 解析器不处理多行注释、`id`、`retry`，帧内 JSON 解析错误会直接终止；
- 连接中断后当前 turn 只显示失败，不能恢复遗漏增量；
- abort 后是否持久化部分消息取决于 Pi Agent 行为，尚无明确事件契约测试。

## 6. Web 时间线和会话选择

实现位置：`apps/web/public/app.js`、`apps/web/public/index.html`、`apps/web/public/app.css`

可复用能力：

- Agent turn、thinking 占位、工具输入/输出、失败和最终回答的时间线 UI；
- 使用 `textContent` 展示工具载荷，并对最终文本走受控 Markdown 渲染；
- transcript 可重建用户消息、assistant 工具调用、toolResult 和回答；
- 操作建议有显式按钮、revision 过期提示、执行中/完成/失败状态；
- Work 切换时会确保会话绑定一致，不会把当前页面继续接到明显不同的 `workId` 会话。

需要迁移或补强：

- 全部状态与逻辑集中在 `app.js`，样式和 DOM 也与工作区单体文件共享；
- `firefly.sessionId` 全局只保存一个会话，任务没有会话列表或明确选择器；
- Work 切换会创建新会话，但旧会话除了恰好保存在 localStorage 外不可发现；
- 恢复失败会吞掉具体错误并自动创建新会话，不利于区分越权、已删除和损坏；
- 只在内存中维护 `busy`，刷新后无法判断服务端仍运行的 run；
- 没有可见的取消按钮、断线状态、重试或续传；
- `text_delta` 未呈现，用户只能在 complete 后看到答案；
- 历史 thinking 是 UI 推断，历史工具耗时缺失；操作卡片执行结果未作为会话事件持久化；
- 卡片只比较当前 Work revision，没有校验 task ID、owner、tenant、命令幂等键或成本；
- `firefly.workId` 和 `sessionWorkId` 需要按 WS-001 的迁移规则改为任务级键，但浏览器状态仍不得作为权限依据。

## 7. 测试覆盖与缺口

已有自动化覆盖：

- 会话创建、非流式 prompt 和 transcript；
- SSE 包含生命周期、文本增量和 complete，且 complete 不重复 events；
- 多轮消息跨 runtime 持久化恢复；
- Work 绑定跨 runtime 恢复并重新装配 Agent；
- session ID 路径逃逸拒绝；
- runtime abort 可中止活动模型请求；
- transcript 移除 thinking、截断超大工具载荷并脱敏；
- 工具白名单、状态/角色/预算策略和操作 proposal 边界。

尚缺：

- tenant/account/project/task 级会话隔离和越权 API 测试；
- 同一任务多会话列表、选择和稳定恢复顺序；
- SSE 事件 Schema 校验、严格顺序、事件 ID、断线重放与去重；
- 客户端断线、显式取消、reset/delete 竞态与副作用幂等；
- 工具调用中断后的持久化和费用结果；
- 操作卡片跨任务、旧 revision、越权、额度不足和重复点击；
- 浏览器端 transcript 恢复、实时文本、卡片状态和任务切换联调。

## 8. 对后续任务的输入

### AG-002：`TaskContext` 最小字段需求

从本盘点可确定至少需要表达：任务、批次项目、品牌、车型、车型快照版本、当前阶段、任务 revision 和任务 owner 的只读展示/工具上下文。actor、tenant、role、品牌授权、预算和运行锁必须由认证 SessionScope 在服务端解析和执行，不应成为模型或客户端可声明的可信字段。最终字段仍需与 WS-003/WS-005 评审冻结。

### AG-003：共享契约

- 不创建与 WS-002 `VideoTask` 平行的任务类型；
- `AgentActionCard` 必须绑定 `videoTaskId`、action、expectedRevision、摘要、预计成本和幂等标识；
- Schema 需区分模型 proposal 与后端可执行命令，卡片本身不是授权凭证。

### AG-004：模块边界

建议拆分边界：

- API：Agent session 路由、SSE 编码/恢复、工作区路由；
- Web：Agent session client、stream client、timeline renderer、action-card renderer；
- 共享文件只保留应用壳和明确插槽。

### AG-101 / AG-201

- Session v2 读取期兼容 `workId`，写入只使用 `videoTaskId`；迁移必须验证服务端作用域。
- 先建立事件 Schema 和事件日志，再实现重连；不能用 transcript 推断替代事件重放。

## 9. 依赖与共享契约状态

截至盘点时：

- 工作区线 `WS-001` 提交 `d50f47a`，记录了 v1 Work、Agent Session 和浏览器键迁移规则；未合并。
- 工作区线 `WS-002` 提交 `2464daf`，定义 `Brand`、`Vehicle`、`BatchProject`、`VideoTask`；未合并。
- 工作区线最新账本提交为 `768689c`，当前无 PR。
- `WS-003` 尚未开始，因此 `WS-005` 和 `AG-003` 的最终共享契约冻结条件未满足。
- AG-001 不修改共享 Schema、领域状态或 API 契约，不给工作区线产生代码合并依赖。

## 10. AG-001 验收检查

- [x] 盘点会话存储、生命周期 API 和恢复行为。
- [x] 盘点 Work 绑定、SessionScope、工具装配和操作 proposal。
- [x] 列出现有运行时/SSE 事件及必须迁移的事件。
- [x] 记录 Web 时间线可复用能力、单体耦合和恢复缺口。
- [x] 记录现有测试覆盖与 AG-002/AG-003/AG-004/AG-101/AG-201 输入。
- [ ] 合并到 `main` 并完成浏览器联调后，按账本规则将 AG-001 标记为 `已完成`。
