# ADR-001：Workspace V2 使用 PostgreSQL 持久化

> 当前状态：已接受并执行。用户已撤销此前的回滚决定；按[产品规格第 12.3 节](../workspace-v2-product-spec.md#123-当前持久化边界)，PostgreSQL 继续作为 Workspace V2 生产权威持久化系统，本地文件 Store 仅用于隔离测试和旧链路兼容。

- 状态：已接受
- 日期：2026-08-19
- 决策人：产品负责人（用户确认）
- 实施任务：WS-308

## 背景

Workspace V2 的租户、权限、revision、人工确认、幂等命令、额度和审计需要跨进程事务保证。现有 `Local*Store` 使用本地 JSON 文件与进程内缓存，只适合本地演示、兼容迁移和无外部依赖测试，不能作为多实例生产环境的业务真相。

## 决策

1. PostgreSQL 是 Workspace V2 在线业务状态的权威持久化系统。
2. API 基础设施层使用一个共享连接池和显式事务；`packages/domain`、`packages/tools`、`packages/agent` 以及生产 Agent 工具面都不得暴露驱动或 SQL。
3. 首期采用“关系型作用域/约束列 + 版本化 JSONB 聚合”：租户、实体 ID、revision、规范化名称、幂等键和时间戳是可约束/索引的列，完整聚合仍通过现有版本化 schema 校验。
4. Workspace 管理状态、Workspace Session、账号额度、账号高消耗运行锁、批次项目/项目资产池、项目临时资产和视频任务接入 PostgreSQL Store。旧作品兼容链和 Agent transcript 暂保留本地，只用于兼容与对话恢复，不是 Workspace V2 业务状态来源。
5. 数据库变更使用带校验和与 advisory lock 的版本化迁移。生产 API 启动只检查连接和 schema 版本，不自动执行 DDL；部署流程显式运行迁移命令。
6. 新查询显式携带租户、项目和任务作用域。既有 `loadByProjectId`、任务 `load/transact` 与临时资产 Store 暂只有全局项目/任务 ID；迁移因此额外强制项目 ID 和任务 ID 全局唯一，并用复合外键校验其租户归属，避免兼容接口形成跨租户歧义。Workspace Session 当前依赖服务端账号目录中的全局唯一账号 ID；未来若账号改为租户内唯一，必须先给 Session Store 增加关系型 `tenant_id`。数据库约束是服务端权限和领域校验的纵深防御，不能替代认证会话、状态机、预算、幂等或人工审批规则。
7. 项目资产的跨 Store 操作由 PostgreSQL project advisory lock 覆盖整个服务操作；同一异步调用链中的嵌套 Store 事务复用根事务连接，因此该协调操作会整体提交或回滚。Store 仍负责自身行锁和 CAS。需要“预算预留 + 供应商执行记录”等新的跨域原子命令时，必须由明确的协调器建立根事务，不能把互不相干的顶层 Store 事务误认为原子提交。

## 验证要求

- 事务异常时完整回滚并释放连接；
- 旧 revision 不能覆盖新状态；
- 相同幂等键与相同载荷只执行一次，不同载荷稳定冲突；
- 项目名、任务名和作用域唯一约束在多连接竞争下只有一个成功；
- 跨租户读取和写入被查询条件与复合约束共同拒绝；
- 迁移可重复运行，已应用文件的校验和漂移会失败关闭；
- 健康检查不泄漏连接串、账号或密码；
- CI 使用真实 PostgreSQL 服务执行集成测试，不以 `pg-mem` 代替并发和约束验证。

## 后果

- 本地无 PostgreSQL 的单元测试仍可注入 Local Store；生产装配必须选择 PostgreSQL，并在配置或 schema 不完整时失败关闭。
- PostgreSQL 只替换业务持久化，不把开发账号入口变成生产身份系统。正式 identity provider 与 V2 Agent `TaskContext` resolver 接入前，生产不签发开发 Session，PG 模式也不允许认证 Agent 回退读取旧 `.data/works`。
- 已完成的 WS-305 / WS-306 领域与 API 契约保持不变，其在线权威聚合由本任务切换到 PostgreSQL；WS-307 的 PostgreSQL 正式 `apply` 依赖 WS-308 基座及尚待实现的 PostgreSQL target adapter。
- 旧 `.data` 文件导入 PostgreSQL 由 WS-307 负责，不由常规 Store 隐式迁移。当前 WS-307 协调器的目标仍是 Local V2 Store，不能直接写入本 ADR 确立的 PostgreSQL 权威 Store；正式 `apply` 前必须先注入 PostgreSQL 目标适配器，再重新执行备份、dry-run、数量/哈希校验与审批。现有开发期 plan hash 不可用于 PostgreSQL 正式迁移。
