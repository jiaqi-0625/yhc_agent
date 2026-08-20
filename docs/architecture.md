# Firefly Ad Agent 架构

## 当前能力与边界

当前仓库已实现任务级 Agent 对话纵切：认证账号与一条 `VideoTask` 绑定会话，服务端装配只读任务上下文和领域白名单工具，通过可恢复 SSE 传输运行事件，并把模型建议转换为需要人工点击的操作卡片。业务状态机、权限、预算、负责人、revision、幂等和人工确认仍由服务端负责；聊天记录不是业务状态来源。

已覆盖车型事实、策略、任务素材快照，以及脚本、分镜和交付阶段的只读建议上下文。WS-305 已提供认证工作区统一命令 API，但当前 Agent 面板的操作卡片仍通过既有兼容命令入口执行，等待 AG-403 切换。完整三栏 Workspace 接入和端到端交付链路仍依赖 WS-404、WS-503，依赖完成前不宣称 Agent 操作闭环或最终联调完成。

## 分层与依赖

```text
apps/web             账号与任务切换、Agent 面板、SSE 客户端、人工操作卡片
apps/api             HTTP/SSE、认证解析、TaskContext 装配、PostgreSQL 适配器、统一/兼容命令边界
packages/agent       Pi Agent 生命周期、会话/运行存储、事件日志、审计与脱敏
packages/tools       车型、资产、阶段建议和策略领域工具
packages/domain      工作流状态机、工具策略、权限/revision/版本规则
packages/schemas     TaskContext、事件、卡片及业务共享契约
```

依赖方向是 `web -> api -> agent/tools/domain -> schemas`。PostgreSQL 驱动和 SQL 只存在于 API 基础设施适配器；API 可以把业务服务端口注入 Agent，但 Agent 不得直接访问数据库、文件系统、任意网络或审批接口。

## PostgreSQL 持久化

Workspace V2 在线权威状态使用 PostgreSQL，决定记录见 [ADR-001](./decisions/adr-001-postgresql-persistence.md)。API 进程共享一个连接池，Store 通过同一连接执行显式 `BEGIN`/`COMMIT`/`ROLLBACK`，并始终释放连接。生产启动只执行连接与 schema 版本检查；DDL 由部署阶段的显式迁移命令执行。

首期表使用关系型信封列保存 `tenant_id`、实体 ID、revision、规范化名称、幂等元数据与时间戳，版本化业务聚合存入 JSONB 并继续通过共享 schema 校验。数据库唯一约束、行锁和 revision 条件用于抵御跨实例竞争，但认证身份、权限、状态机、人工确认和预算规则仍由服务端领域层重新校验。

七个在线 Store 使用 PostgreSQL：Workspace 管理状态、Workspace Session、账号额度、账号高消耗运行锁、批次项目/项目资产池、项目临时资产和视频任务。项目资产的跨 Store 服务操作由根事务和 PostgreSQL advisory lock 跨实例串行，同一异步调用链的嵌套 Store 复用该连接并整体提交或回滚；需要新的跨聚合原子写入命令时仍须由显式协调器建立根事务。旧 `.data/works` 只可由 WS-307 显式迁移读取，不能用来恢复或推断 Workspace V2 业务状态；Agent transcript 继续是隔离的本地对话存储。

`GET /health` 仅报告进程存活；`GET /ready` 执行无敏感信息的数据库与 schema readiness 检查。关闭 API 时先停止接收请求，再关闭连接池。开发 Docker 数据库只绑定 loopback；生产账号签发仍等待正式 identity provider，开发账号入口在 `NODE_ENV=production` 下保持关闭。

WS-307 的 V2 `TaskContext` resolver 与 Web 项目/任务选择正在与 PostgreSQL 装配进行集成验收。该工作不得以 legacy `.data/works` 回退来规避失败；验收未完成前不把 Agent 会话端到端可用性等同于数据库 readiness。

## 权威状态与上下文

系统将三类状态严格分开：

| 状态 | 权威来源 | Agent 用途 |
| --- | --- | --- |
| 身份与授权范围 | Bearer workspace session | 服务端解析 `actorId`、`tenantId`，不接受模型或浏览器声明 |
| 任务与阶段版本 | 领域聚合与工作流状态机 | 每次装配/执行前重新读取，确认和回退产生不可变版本 |
| 对话与运行事件 | Agent session/run store | 恢复消息与 SSE，不作为任务、审批、预算或素材事实来源 |

`TaskContext` 只包含品牌、车型、批次项目、视频任务和制作简报摘要。账号、租户、权限、额度、运行锁、凭据和供应商私有字段被有意排除。会话另存服务端解析的 `AgentSessionScope`，包含 `actorId`、`tenantId`、`projectId` 和 `videoTaskId`；所有读取、恢复、重置、删除和运行操作都必须重新通过该范围授权。

切换账号时，Web 先清空旧会话 ID、任务上下文和列表，再加载新账号的额度、项目、任务及会话，避免旧账号上下文残留。

## 会话与运行链路

```text
认证账号选择任务
  -> POST /v1/sessions { videoTaskId }
  -> API 解析 TaskContext + AgentSessionScope
  -> Runtime 按当前任务装配领域工具
  -> POST /v1/sessions/:sessionId/runs { message, requestId }
  -> 202 返回稳定 runId
  -> GET /v1/sessions/:sessionId/runs/:runId/events?videoTaskId=...
  -> SSE 按 eventId/sequence 推送并保存事件日志
  -> 断线后携带 Last-Event-ID 重连，仅重放其后的事件
  -> 完成、错误或显式 abort
```

`requestId` 使同一次启动请求幂等；断开 SSE 订阅不会取消后台运行。客户端校验 `sessionId`、`runId`、任务范围和严格递增的 `sequence`，按 `eventId` 去重。`Last-Event-ID` 与 `afterEventId` 同时出现时必须一致，否则服务端拒绝请求。

旧 `messages-stream` 与 `workId` 只保留本地兼容读取；认证会话必须提供 `videoTaskId`。持久化会话格式当前为 v3，并可迁移读取 v1 `workId` 与 v2 `TaskContext` 记录。会话 ID 和落盘路径都经过约束，不能用于目录穿越。

## Agent 事件协议

`AgentStreamEvent` v1 的每个事件都包含稳定 `eventId`、单次运行内递增的 `sequence`、`sessionId`、`runId`、时间戳及可选 `videoTaskId`。

| 事件 | 含义 |
| --- | --- |
| `run_started` | 运行已受理并绑定会话/任务 |
| `thinking_status` | 可公开的阶段状态；不传输隐藏推理 |
| `message_started` / `text_delta` / `message_completed` | 助手消息生命周期 |
| `tool_status` | 领域工具开始、完成或失败的可展示摘要 |
| `plan_updated` | 结构化计划更新，契约已冻结 |
| `action_card` | 结构化建议卡片，必须人工点击且再次服务端校验 |
| `run_error` / `run_completed` | 运行终态 |

工具参数、结果、审计摘要和持久化消息在进入对话时间线前执行敏感字段脱敏与大小限制；Bearer、密钥、token、cookie、密码和隐藏思考不会透传给前端。

## 领域工具白名单

当前按任务状态和可用服务端口动态装配以下工具：

- `get_vehicle_snapshot`、`validate_vehicle_claims`：读取版本化车型事实并校验宣传表述。
- `get_task_asset_snapshot`：读取任务开始策略工作时锁定的不可变素材快照；车型素材不可跨车型替换，人物/场景可推荐，视觉风格不参与替换，本地素材保留人工复核风险。
- `get_current_stage_suggestion_context`：仅为脚本、分镜、交付阶段读取精确且未失效的已确认上游版本链。
- `propose_strategy_generation`、`validate_strategy`、`propose_strategy_approval`：生成/校验策略建议并提出人工确认请求。

所有动态工具必须同时存在于领域策略表；未知工具默认拒绝。生产 Agent 禁止注册 shell、通用文件系统、SQL、任意 HTTP、浏览器、直接批准、发布或媒介投放工具。

## 操作卡片与人工确认

卡片是建议，不是命令授权。前端只接受精确版本的 `AgentActionCard` 结构和动作白名单，并在跨任务、revision 过期、非负责人或运行繁忙时禁用。用户点击后，服务端仍须重新检查认证身份、任务范围、负责人、工作流状态、revision、预算、并发锁和幂等。

WS-305 统一命令边界在每次执行时重新校验认证会话、最新授权、项目/任务作用域、当前负责人、revision 和工作流状态，并返回服务端权威成本与持久化 receipt。前端仍需通过 AG-403 从兼容入口切换到该 API。模型可以请求人工确认，但不能确认自己的产物。

## 工作流和版本

Workspace V2 产品权威目标流程为：

```text
strategy -> script -> asset_matching -> storyboard -> video_preview -> delivery
```

当前 Schema、领域转换和既有数据仍实现旧的 `strategy -> asset_matching -> script` 前缀，处于 WS-108 迁移前的过渡状态；它不能覆盖上述产品决定，也不能作为新功能继续依赖的权威顺序。WS-108 必须同步迁移状态转换、版本依赖、回退失效、持久化升级和 Agent 上下文。

每个阶段从 `in_progress` 提交到 `awaiting_confirmation`，只有显式 `human_action` 才能确认并进入相邻下一阶段。每次确认持久化不可变版本。回退会沿依赖图递归失效所有下游产物、清除受影响的当前版本指针并重置任务阶段；Agent 只能建议目标版本和原因。

项目素材池跟随目录最新数据；任务在策略开始时锁定车型事实版本，在资产匹配确认时才锁定所选素材版本。脚本、资产匹配、分镜与交付建议只能引用当前选中、已确认、未失效的精确上游版本，不能从聊天内容重建事实。

## 部署与供应商边界

```text
用户/模型输出 -> HTTP/SSE API -> 状态机与策略 -> 领域服务端口 -> 数据库/队列/对象存储
                                      |
                                      +-> Pi Agent Core -> 已批准模型供应商

禁止：模型 -> 数据库 / 任意网络 / 审批事件 / 广告发布账户
```

自动化测试使用 Mock Provider，不消耗真实模型额度。真实模型凭据仅从服务端环境读取，不进入仓库、日志、提示词、工具结果或测试夹具。调试方法见 [Agent 对话区调试指南](./agent-dialog-debugging.md)。

## 尚待依赖

- AG-403 / AG-405：在 WS-305 已提供的统一命令 API 上完成前端切换、错误展示和结果时间线闭环。
- WS-404：三栏 Workspace 到位后完成 Agent 面板最终嵌入与布局验收。
- WS-503：真实交付链路到位后完成交付阶段联调。
- 上述依赖完成后执行 AG-504 Workspace 上下文联调、AG-505 操作卡片完整链路联调、AG-506 最终桌面浏览器验收与质量门禁，再将 AG-507 标记完成。
