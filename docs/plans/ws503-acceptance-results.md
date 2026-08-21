# WS-503 验收记录

> 日期：2026-08-20；真实链路补充验收：2026-08-21
> 范围：项目创建至模拟交付
> 基础验收环境：PostgreSQL 权威 Store、真实 DeepSeek Agent、Mock 公司资产；未调用真实视频生成或自动剪辑服务

## 验收结果

| 序号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| 1 | 通过 | `workspace-admin-routes.test.ts`、`workspace-admin-runtime.test.ts`、`management-center.test.ts` | 管理员可维护品牌、车型、资产关联和账号授权。 |
| 2 | 通过 | `project-creation-routes.test.ts`、`project-creation-wizard.test.ts`、`configured-local-v2-runtime.test.ts` | 单页创建项目和首条任务；本地配置启动后 Agent 正确绑定新任务。 |
| 3 | 通过 | `asset-matching-routes.test.ts`、`video-task-stage-runtime.test.ts`、`asset-matching.test.ts`、`workspace-stages.test.ts` | 策略和脚本确认后选材；分镜展示引用，人物、场景可换，支持临时素材。 |
| 4 | 通过 | `video-task-routes.test.ts`、`video-task-runtime.test.ts` | 同项目支持多任务、分配和接管负责人。 |
| 5 | 通过 | `video-task-stage-runtime.test.ts` 中 WS-503 真实命令链路、PostgreSQL 浏览器验收、`workflow.test.ts` | 策略、真实脚本、素材以及服务端模拟分镜/预览/交付逐项生成和人工确认，交付确认后任务完成。 |
| 6 | 通过 | `stage-rollback.test.ts`、`stage-confirmation-runtime.test.ts` | 回退按依赖图递归失效下游产物。 |
| 7 | 通过 | `account-run-lock-runtime.test.ts`、`account-run-lock.test.ts` | 同账号第二条高消耗任务拒绝，不同账号互不占用。 |
| 8 | 通过 | `account-budget-runtime.test.ts`、`account-budget.test.ts` | 服务端重新估价，额度不足在执行前拒绝且不扣费。 |
| 9 | 通过 | `agent-action-command-routes.test.ts`、`agent-action-command-runtime.test.ts`、`agent-panel.test.ts` | Agent 只提出卡片；统一命令和阶段确认均由用户触发。 |
| 10 | 按更新范围通过 | `automatic-editing-provider.test.ts`、`video-generation-provider.test.ts`、`workspace-stages.js` | 原“模拟自动剪辑任务”标准已被规格 12.2 和 WS-205/206 范围决定取代。当前只保留 Provider 端口，页面明确服务未接入，不伪造任务、状态或草稿。 |
| 11 | 通过 | `legacy-work-migration*.test.ts` | 迁移保留策略、人工锁定、确认、版本和 revision，迁移后仍可读取。 |
| 12 | 通过 | `npm run check` | 610 项中 609 项通过；1 项真实 PostgreSQL 集成测试因未配置 `TEST_DATABASE_URL` 按设计跳过。类型检查和凭据扫描通过；真实 DeepSeek 只生成文本，零视频/剪辑供应商费用。 |

## PostgreSQL 与 DeepSeek 补充验收

- 功能提交：`872e717`。继续使用现有 `PostgresVideoTaskProductionStore` 与 PostgreSQL 运行时装配，不新增 ORM、第二套访问层、Agent SQL 权限或通用文件系统权限。
- 运行配置：`PERSISTENCE_BACKEND=postgres`、`AGENT_PROVIDER=deepseek`、`AGENT_MODEL=deepseek-v4-flash`；数据库 Schema v1 校验通过。密钥只从被忽略的服务端 `.env` 加载，未输出、未提交。
- 现有管理 API 核实 C10 车型 `vehicle_leapmotor_c10_demo`：3 条固定卖点、15 条扩展卖点、56 项资产关联；C10 项目资产池锁定 55 个车型素材，品牌默认视觉样式仍由服务端单独继承。
- PostgreSQL 验收项目：`batch_project_59fcad20-202f-4599-85ae-352252601da1`；视频任务：`video_task_e4e67b376c3719f490db8cab104772e3dbd2f439bfc003e7`。
- DeepSeek 首先只提出“生成卖点策略草稿”卡片，没有自行执行。人工点击后服务端生成草稿、锁定车型事实快照，任务 revision 从 1 更新为 2。
- 新增的任务只读能力让 DeepSeek 读取当前服务端权威草稿、草稿校验结果及锁定车型快照；不返回租户、项目、创建人、生成来源或时间戳等非必要内部字段，也不能修改草稿、提交审批或批准策略。
- DeepSeek 实际确认快照含 3 条固定卖点和 15 条扩展卖点，草稿 18 条与快照逐项对应；独立宣传表述校验全部有事实支持，并保留纯电/增程/激光雷达版本适用范围、CLTC 口径、智驾监督责任和禁止绝对化表述等风险边界。
- 最终只提出“提交卖点策略人工审批”卡片并保持待确认；未点击提交、未发生 Agent 自批。资产匹配仍严格位于已确认策略和脚本之后。
- 真实脚本链路项目：`batch_project_b14e3c28-4527-473c-9b40-8fa4173720ba`；任务：`video_task_2e694bf4c5a661eae5d4ba66ee0334ff630a5db95107fa8c`。DeepSeek 在脚本阶段读取已人工确认策略与阶段依据，生成完整 15 秒脚本并返回严格操作卡片；负责人点击后脚本正文写入 PostgreSQL，revision 4 → 5，状态进入脚本待确认。
- 负责人确认脚本后 revision 5 → 6；确认人物/场景资产选择并锁定精确素材版本后 revision 6 → 7。页面随后通过统一命令生成可审计的服务端模拟分镜、模拟预览和模拟交付，每项先进入待确认再由负责人确认，最终 revision 13、交付已确认、6/6 文件就绪。
- 服务重启后重新进入同一任务，仍显示交付已确认、revision 13 和 6/6 文件就绪，证明本轮终态来自 PostgreSQL 持久化而非浏览器内存或测试注入。
- 最终 `npm run check` 共 610 项：609 通过、1 项按安全门跳过；TypeScript 与凭据扫描通过。`db:ping` 健康、Schema v1 校验通过。真实 PostgreSQL 集成测试脚本拒绝把当前业务库当作可清理测试库（要求独立 `TEST_DATABASE_URL` 且库名以 `_test` 结尾），未绕过该保护。

## 浏览器验收

- 1280px、1920px 桌面布局正常，1279px 显示桌面端提示。
- 明暗主题正常，无横向溢出。
- 创建项目并进入三栏工作区后，Agent 会话绑定当前 V2 视频任务，不再回退查询旧作品。
- 真实脚本正文可在脚本页查看并由负责人确认；脚本操作卡片的执行结果显示权威任务 revision。
- 分镜、预览和交付的模拟产物均通过页面按钮调用服务端统一命令生成，不再依赖测试代码直接修改任务状态；每阶段仍经过独立人工确认。
- 交付区明确提示真实成片与剪辑草稿将在生成服务接入后提供。
- 控制台无 warning/error。

## 范围说明

脚本是 DeepSeek 生成并由统一命令写入 PostgreSQL 的真实任务正文。分镜、视频预览和交付仍是 WS-503 范围内明确标识的服务端模拟产物，用于在未接入 Seedance/自动剪辑 Provider 时完成真实用户操作、统一命令、持久化、人工确认和审计链路；它们不伪造供应商任务、真实成片或剪辑草稿。
