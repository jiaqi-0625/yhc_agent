# WS-503 验收记录

> 日期：2026-08-20；真实链路补充验收：2026-08-21
> 范围：项目创建至模拟交付  
> 基础验收环境：本地文件 Store、Mock Agent、Mock 公司资产；未调用真实模型、视频生成或自动剪辑服务

## 验收结果

| 序号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| 1 | 通过 | `workspace-admin-routes.test.ts`、`workspace-admin-runtime.test.ts`、`management-center.test.ts` | 管理员可维护品牌、车型、资产关联和账号授权。 |
| 2 | 通过 | `project-creation-routes.test.ts`、`project-creation-wizard.test.ts`、`configured-local-v2-runtime.test.ts` | 单页创建项目和首条任务；本地配置启动后 Agent 正确绑定新任务。 |
| 3 | 通过 | `asset-matching-routes.test.ts`、`video-task-stage-runtime.test.ts`、`asset-matching.test.ts`、`workspace-stages.test.ts` | 策略和脚本确认后选材；分镜展示引用，人物、场景可换，支持临时素材。 |
| 4 | 通过 | `video-task-routes.test.ts`、`video-task-runtime.test.ts` | 同项目支持多任务、分配和接管负责人。 |
| 5 | 通过 | `video-task-stage-runtime.test.ts` 中 WS-503 黄金链路、`workflow.test.ts` | 六阶段逐项人工确认，交付确认后任务完成。 |
| 6 | 通过 | `stage-rollback.test.ts`、`stage-confirmation-runtime.test.ts` | 回退按依赖图递归失效下游产物。 |
| 7 | 通过 | `account-run-lock-runtime.test.ts`、`account-run-lock.test.ts` | 同账号第二条高消耗任务拒绝，不同账号互不占用。 |
| 8 | 通过 | `account-budget-runtime.test.ts`、`account-budget.test.ts` | 服务端重新估价，额度不足在执行前拒绝且不扣费。 |
| 9 | 通过 | `agent-action-command-routes.test.ts`、`agent-action-command-runtime.test.ts`、`agent-panel.test.ts` | Agent 只提出卡片；统一命令和阶段确认均由用户触发。 |
| 10 | 按更新范围通过 | `automatic-editing-provider.test.ts`、`video-generation-provider.test.ts`、`workspace-stages.js` | 原“模拟自动剪辑任务”标准已被规格 12.2 和 WS-205/206 范围决定取代。当前只保留 Provider 端口，页面明确服务未接入，不伪造任务、状态或草稿。 |
| 11 | 通过 | `legacy-work-migration*.test.ts` | 迁移保留策略、人工锁定、确认、版本和 revision，迁移后仍可读取。 |
| 12 | 通过 | `npm run check` | 586 项中 585 项通过；1 项真实 PostgreSQL 集成测试因未配置 `TEST_DATABASE_URL` 按设计跳过。类型检查和凭据扫描通过；全程 Mock，零真实供应商费用。 |

## PostgreSQL 与 DeepSeek 补充验收

- 功能提交：`872e717`。继续使用现有 `PostgresVideoTaskProductionStore` 与 PostgreSQL 运行时装配，不新增 ORM、第二套访问层、Agent SQL 权限或通用文件系统权限。
- 运行配置：`PERSISTENCE_BACKEND=postgres`、`AGENT_PROVIDER=deepseek`、`AGENT_MODEL=deepseek-v4-flash`；数据库 Schema v1 校验通过。密钥只从被忽略的服务端 `.env` 加载，未输出、未提交。
- 现有管理 API 核实 C10 车型 `vehicle_leapmotor_c10_demo`：3 条固定卖点、15 条扩展卖点、56 项资产关联；C10 项目资产池锁定 55 个车型素材，品牌默认视觉样式仍由服务端单独继承。
- PostgreSQL 验收项目：`batch_project_59fcad20-202f-4599-85ae-352252601da1`；视频任务：`video_task_e4e67b376c3719f490db8cab104772e3dbd2f439bfc003e7`。
- DeepSeek 首先只提出“生成卖点策略草稿”卡片，没有自行执行。人工点击后服务端生成草稿、锁定车型事实快照，任务 revision 从 1 更新为 2。
- 新增的任务只读能力让 DeepSeek 读取当前服务端权威草稿、草稿校验结果及锁定车型快照；不返回租户、项目、创建人、生成来源或时间戳等非必要内部字段，也不能修改草稿、提交审批或批准策略。
- DeepSeek 实际确认快照含 3 条固定卖点和 15 条扩展卖点，草稿 18 条与快照逐项对应；独立宣传表述校验全部有事实支持，并保留纯电/增程/激光雷达版本适用范围、CLTC 口径、智驾监督责任和禁止绝对化表述等风险边界。
- 最终只提出“提交卖点策略人工审批”卡片并保持待确认；未点击提交、未发生 Agent 自批。资产匹配仍严格位于已确认策略和脚本之后。
- 浏览器控制台无 warning/error。最终 `npm run check` 共 605 项：604 通过、1 项按安全门跳过；TypeScript 与凭据扫描通过。真实 PostgreSQL 集成测试脚本拒绝把当前业务库当作可清理测试库（要求库名以 `_test` 结尾），未绕过该保护；本轮使用 Schema 校验、现有管理/项目/任务 API 与真实浏览器链路完成非破坏性验收。

## 浏览器验收

- 1280px、1920px 桌面布局正常，1279px 显示桌面端提示。
- 明暗主题正常，无横向溢出。
- 创建项目并进入三栏工作区后，Agent 会话绑定当前 V2 视频任务，不再回退查询旧作品。
- 交付区明确提示真实成片与剪辑草稿将在生成服务接入后提供。
- 控制台无 warning/error。

## 范围说明

自动化中的脚本、分镜、视频预览和交付引用是测试专用模拟产物，只用于验证六阶段人工确认、不可变版本和最终完成状态；产品 UI 与生产实现不会伪造 Provider 任务或剪辑草稿。
