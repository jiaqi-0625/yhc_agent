# Agent 对话区调试指南

## 安全启动

使用 Node.js 22.19 或更新版本。日常调试和自动化验收优先使用 Mock Provider，避免消耗真实模型额度：

```powershell
$env:AGENT_PROVIDER = "mock"
npm run start:api
```

开发热重载可改用 `npm run dev:api`。不要把 token、模型密钥或真实凭据写入 `.env` 示例、命令输出、截图、日志、测试和夹具。验证版本与服务状态：

```powershell
Invoke-RestMethod http://127.0.0.1:3100/health
Invoke-RestMethod http://127.0.0.1:3100/v1/meta
```

浏览器打开 `http://127.0.0.1:3100/`。本机非生产环境会提供开发账号入口；生产模式默认关闭该入口，也不允许无认证的本地兼容访问。

## 推荐排查顺序

1. 确认 `/health` 正常，并检查 `/v1/meta` 的版本、模型配置和安全边界。
2. 创建或切换开发账号，确认当前账号与额度已刷新。不要在调试记录中复制 Bearer token。
3. 选择批次项目和视频任务，确认 Agent 标题区显示的品牌、车型、任务、负责人和阶段一致。
4. 新建或恢复 Agent 会话；认证会话必须绑定 `videoTaskId`。
5. 发送消息，确认启动请求返回 `runId`，随后 SSE 事件的 `sessionId`、`runId`、`videoTaskId` 与当前界面一致。
6. 模拟断线时用最后一个 `eventId` 续传，确认事件不重复且 `sequence` 连续递增。
7. 检查操作卡片是否只在当前任务、当前 revision、当前负责人且非忙碌状态下可点击。
8. 最后运行 `npm run check`，确认类型检查、全部测试和凭据扫描通过。

## SSE 诊断要点

- 启动：`POST /v1/sessions/:sessionId/runs?videoTaskId=...`，请求体包含 `message` 和稳定的客户端 `requestId`。
- 订阅：`GET /v1/sessions/:sessionId/runs/:runId/events?videoTaskId=...`。
- 续传：使用 `Last-Event-ID` 或 `afterEventId`；同时提供时二者必须相同。
- 取消：`POST /v1/sessions/:sessionId/runs/:runId/abort?videoTaskId=...`，只能取消精确运行。
- 浏览器断开订阅不会自动取消运行；重新订阅应只收到游标之后的事件。

若前端提示序号断档，不要跳过校验继续拼接文本。先核对服务端事件日志是否含该序号，再检查客户端是否用了错误任务、会话、运行或旧游标。

## 常见症状

| 症状 | 重点检查 |
| --- | --- |
| `AIC-AUTH-SESSION_REQUIRED` | 缺少、过期或格式错误的 workspace Bearer session |
| `AIC-AUTH-SESSION_SCOPE_REQUIRED` | 认证 Agent 请求缺少 `videoTaskId` |
| `AIC-AUTH-SESSION_SCOPE_DENIED` | 当前账号/租户/项目/任务与持久化会话范围不一致；账号切换后不要复用旧 session ID |
| `AIC-AGENT-REPLAY_CURSOR_CONFLICT` | `Last-Event-ID` 与 `afterEventId` 不一致 |
| 操作卡片不可点击 | 任务不一致、revision 过期、非负责人、已有运行或动作未在白名单 |
| 工具被策略拒绝 | 工具不在领域白名单，或当前角色/阶段/状态不允许执行 |
| Mock 只回复装配摘要 | 属于预期行为；Mock 验证装配和事件链路，不模拟真实模型自主工具调用 |
| 真实 Provider 启动失败 | 只检查服务端环境变量是否配置；不要打印密钥值 |

## 数据与隐私

本地 Agent 会话默认保存在 `.data/sessions`，workspace 登录会话保存在 `.data/workspace-sessions`。这些文件仅供本地开发恢复，不是业务任务、审批、预算或素材的权威来源，不应手工编辑或提交到 Git。

工具调用前由领域策略执行角色、状态和范围检查；调用后对结果和审计信息脱敏。发现通用 shell、文件系统、SQL、任意 HTTP、浏览器、直接审批或发布工具被装配时，应视为阻断问题。

## 当前已知联调缺口

- WS-305 后端统一命令 API 已可用，但 AG-403 尚未将 Agent 面板从兼容入口切换过去；切换前不能验收完整的操作卡片、标准错误结果和服务端幂等链路。
- WS-404 未完成：可以验收独立 Agent 面板，但不能完成三栏 Workspace 最终嵌入验收。
- WS-503 未完成：可验证交付建议上下文的版本约束，不能完成真实交付链路闭环。

这些缺口不应通过前端模拟状态、复用聊天历史或增加通用工具绕过。
