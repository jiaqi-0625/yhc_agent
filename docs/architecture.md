# 架构说明

## 当前目标

当前工作区已经在 Agent 框架之上完成第一条本地业务纵切：不可变车型快照、版本化卖点策略、事实校验、人工锁定、审批请求和人工决策。策略生成默认使用确定性 Mock，不宣称已经具备真实模型策略质量、脚本、分镜、视频生成或投放能力。

本地验收页的聊天会话现在由服务端绑定当前 `workId`，并装配车型与策略白名单工具；未绑定作品的 CLI/框架会话仍保持无工具模式。Mock 模型用于无费用地验收装配、会话恢复和权限链路，不会自主发起工具调用。人工批准始终只存在于后端/UI。

## 分层

```text
apps/api             HTTP/API 边界、本地作品存储、作品摘要/复制、黄金样例与人工审批命令
packages/agent       Pi Agent 装配、系统提示词、策略钩子、审计与脱敏
packages/tools       车型快照、宣传表述校验和策略草稿白名单工具
packages/domain      工作流状态机、revision 冲突和工具策略
packages/schemas     跨层 TypeBox 契约
```

依赖方向为 `api -> agent -> domain/tools -> schemas`。业务状态只由后端状态机推进，Pi 的消息历史不承担持久化业务状态职责。

## 本地 Agent 运行链路

```text
CLI / Local HTTP API
        |
        v
LocalAgentRuntime
  ├─ 配置与密钥解析（Mock / DeepSeek / 火山方舟）
  ├─ Pi Agent Core 生命周期与 AbortSignal
  ├─ 会话创建、作品绑定、恢复、重置和取消
  └─ .data/sessions 中的本地聊天记录与 workId
        |
        v
未绑定作品 -> createBaseAgent（tools=[]）
绑定作品   -> createAdvertisingAgent
              ├─ 车型快照与宣传表述校验
              ├─ 策略生成、校验与请求人工审批
              └─ 每次调用前读取最新作品状态并执行策略检查
```

聊天记录和业务产物必须分开保存。本地 JSON 会话仅用于开发调试，不作为作品、审批、车型快照或生成任务的数据源。

## 信任边界

- 身份、租户、项目、品牌范围和预算来自认证后的服务端会话，通过闭包注入工具；模型参数中不存在这些字段。
- Agent 按当前作品装配车型读取、事实校验、策略校验，以及“建议生成策略”“建议请求人工审批”白名单工具。建议工具只返回版本化操作卡片，不写入业务状态；负责人点击卡片后，由服务端/UI 使用 revision 守卫执行生成或审批请求。生产运行时不得注册 shell、文件系统、SQL、任意 HTTP、浏览器、直接状态变更或人工批准工具。
- 每次工具调用先经过 `beforeToolCall` 的角色、状态、审批通道和预算策略；未知工具默认拒绝。
- Workspace V2 的权威任务流程使用 `VideoTask.currentStage + stageStatus`：`strategy → asset_matching → script → storyboard → video_preview → delivery`。当前阶段只能从 `in_progress` 提交为 `awaiting_confirmation`，再由显式 `human_action` 确认后进入紧邻下一阶段；交付确认后任务才成为 `completed`。旧 `WorkStatus` 状态机仅供现有策略纵向链路和迁移读取，不得用于新的 V2 写路径。
- 工具结果在 `afterToolCall` 中写入审计并进行敏感字段脱敏。
- 车型快照按租户、项目、车型版本、颜色、地区和活动日期生成稳定 ID；保存和返回均使用副本，避免调用者回写历史事实。
- 审批是服务端/UI 的人工事件。模型能提示“需要审批”，但没有批准工具。
- revision 检查阻止旧 Agent 输出覆盖人工的新版本。

## 部署边界

```text
不可信边界                         受控应用边界                         数据/供应商边界
用户与模型输出  ->  HTTP/SSE API  ->  状态机 + 策略引擎  ->  领域服务端口  ->  数据库/队列/对象存储
                                        |
                                        +-> Pi Agent Core -> 已批准模型供应商

禁止路径：模型 -X-> 数据库 / 任意网络 / 审批事件 / 广告发布账户
```

API 负责认证并建立 `SessionScope`；Agent 只看到最小业务上下文。未来数据库、队列、对象存储和模型适配器放在领域服务端口之后，供应商凭据仅存在于服务端密钥系统。

## 下一条纵切

下一条纵切进入结构化脚本草稿，但先把本地文件存储替换为 PostgreSQL 适配器，并补齐命令幂等、并发写入串行化和审计查询。脚本生成必须只读取已批准策略，完成固定卖点覆盖、车型事实、禁用词和口播时长校验后停在独立人工审批点；仍不进入图片或视频生成。
