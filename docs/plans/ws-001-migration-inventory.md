# WS-001 现有领域对象与本地存储迁移盘点

> 盘点日期：2026-08-18  
> 实际分支：`agent/workspace-v2-foundation`  
> 依据：`docs/workspace-v2-product-spec.md`  
> 范围：`Project`、`Work`、车型快照、业务数据文件、Agent 会话和浏览器本地状态

## 1. 结论

当前代码尚未真正实现“品牌 → 车型 → 批次项目 → 视频任务”层级：

- `Project` 只有 TypeBox Schema 和类型导出，没有运行时、API 或落盘实例。
- `Work` 实际承担单条广告作品和工作流实例的职责，应迁移为 `VideoTask`，不能继续与项目混用。
- 所有业务数据按 Work 单文件保存在 `.data/works/<workId>.json`；车型快照、策略版本和审批记录内嵌其中。
- Agent 会话独立保存在 `.data/sessions/<sessionId>.json`，以可选 `workId` 绑定业务对象。
- Web 只在 `localStorage` 保存当前 Work、Session 和主题的标识，不保存权威业务状态。
- 现有 v1 数据可以保留核心策略、人工锁定和审批信息，但缺少批次名、画幅、视觉风格、资产池、任务负责人、任务级输入和成本信息，迁移时需要明确默认值或标记为“历史数据未知”。

## 2. 当前对象盘点

### 2.1 `Project`

定义位置：`packages/schemas/src/index.ts`

| 当前字段 | 当前含义 | V2 处理 |
|---|---|---|
| `id` | 项目标识 | 保留为 `BatchProject.id` |
| `tenantId` | 租户范围 | 保留 |
| `brandId` | 品牌范围 | 保留 |
| `name` | 自由项目名 | 兼容读取；V2 由品牌、车型、画幅和批次名生成 |
| `createdAt` | 创建时间 | 保留 |
| `createdBy` | 创建人 | 保留 |

现状限制：没有 `vehicleId`、画幅、批次名、视觉风格、项目资产池、revision 或更新时间；没有任何代码创建或持久化 `Project`。当前 `LOCAL_SCOPE.projectId = "project_local"` 只是固定作用域占位符。

### 2.2 `Work`

定义位置：`packages/schemas/src/index.ts`；运行时位置：`apps/api/src/business-runtime.ts`

| 当前字段 | 当前含义 | V2 处理 |
|---|---|---|
| `id` | 单条广告作品标识 | 保留为 `VideoTask.id`，避免破坏外部引用 |
| `projectId` | 固定为 `project_local` | 迁移为 `batchProjectId`；旧字段只在 v1 读取器中兼容 |
| `status` | 扁平工作流状态 | 转换为 V2 阶段状态与各阶段确认记录 |
| `revision` | 乐观锁版本 | 保留 |
| `vehicleSnapshotId` | 当前 Work 的车型快照 | 迁入任务快照引用；进入策略阶段后锁定 |
| `createdAt` | 创建时间 | 保留 |
| `updatedAt` | 更新时间 | 保留 |

`CreateWorkRequest.name` 当前没有写入 `Work`，Web 虽尝试读取 `work.name`，但该字段不属于 `WorkSchema`。因此不能把它视为可迁移数据。

### 2.3 `VehicleSnapshot`

定义位置：`packages/schemas/src/index.ts`；创建位置：`packages/tools/src/vehicle-service.ts`

可直接保留的内容：

- `id`、`vehicleId`、`vehicleVersion`、`brandId`；
- 品牌、车系、年款、配置款和颜色的快照值；
- 参数、固定事实、可选事实、禁用表达；
- 创建时间和创建人。

需要调整的内容：

| 当前字段/行为 | 问题 | V2 处理 |
|---|---|---|
| `projectId` | 绑定旧 Project 语义，不能区分任务快照 | 改为明确的 `batchProjectId`/`videoTaskId` 关联，旧值只用于迁移追溯 |
| `referenceAssetIds` | 只有 ID，没有资产版本与来源 | 迁入 WS-003 定义的版本化资产快照引用 |
| `region`、`campaignDate` | 参与快照 ID 计算但未写入快照 | 新 Schema 显式保存，旧数据标记为未知 |
| 快照存储 | 相同快照重复内嵌在多个 Work 文件 | 迁移时去重为独立快照记录，任务通过 ID 引用 |

当前 `InMemoryVehicleService` 的快照 Map 只存在于进程内；服务重启后，通过 Work 内嵌数据恢复业务页面，但无法通过 `vehicleService.getSnapshot` 恢复该快照。

### 2.4 策略版本和审批

`LocalWorkRecord.strategyVersions` 保存完整 `Strategy[]`，`approvals` 保存 `StrategyApproval[]`：

- `Strategy.workId` 和 `StrategyApproval.workId` 应迁移为 `videoTaskId`。
- 数组最后一项被当作活动策略，没有显式 `activeVersionId`。
- 人工编辑和锁定保存在 `StrategyItem.locked`，必须原样保留。
- 审批的决定、评审人、时间和备注必须原样保留。
- 当前审批会原地修改活动 Strategy 的 `status` 和 `updatedAt`，所以历史数组并非完全不可变；V2 应把确认事件和不可变产物版本分开保存。

## 3. 当前存储盘点

### 3.1 业务数据

默认目录：`.data/works`；实现：`apps/api/src/business-store.ts`

当前格式：

```text
LocalWorkRecord v1
├─ work
├─ vehicleSnapshot
├─ strategyVersions[]
└─ approvals[]
```

行为与风险：

- 每个 Work 一个 JSON 文件，文件名必须等于 `work.id`。
- 写入采用临时文件加 rename，单文件替换是原子的。
- `load` 只检查 `schemaVersion === 1` 和文件内 Work ID，没有使用共享 TypeBox Schema 校验完整内容。
- `list` 将全部文件加载到内存，没有项目、租户或品牌级索引。
- 业务状态和 Agent 对话已分离，符合 V2 边界。

2026-08-18 本地样例数据基线：

| 指标 | 数量/值 |
|---|---|
| v1 Work 文件 | 13 |
| 项目标识 | 仅 `project_local` |
| 车型 | 仅 `vehicle_firefly_e5_2026_long_range` |
| 唯一车型快照 | 1 |
| `created` | 7 |
| `strategy_draft` | 1 |
| `strategy_approved` | 5 |
| 策略版本总数 | 8 |
| 审批记录总数 | 5 |

`.data` 已被 Git 忽略；这些数字只用于迁移验证，不应把本地数据文件提交到仓库。

### 3.2 Agent 会话

默认目录：`.data/sessions`；实现：`packages/agent/src/session-store.ts`

- v1 Session 以可选 `workId` 绑定业务对象。
- 迁移后改为 `videoTaskId`；读取期可兼容 `workId`，写入只使用新字段。
- 对话消息可以保留用于用户追溯，但不得用于重建任务状态或阶段版本。
- 未绑定 Work 的诊断会话保持未绑定，不应被自动归入某个任务。

### 3.3 浏览器本地状态

实现位置：`apps/web/public/app.js`

| Key | 当前用途 | V2 处理 |
|---|---|---|
| `firefly.workId` | 当前选中的 Work | 一次性迁移到 `firefly.videoTaskId`，随后删除旧 key |
| `firefly.sessionId` | 当前 Agent 会话 | 保留；恢复时必须校验会话绑定的任务 |
| `firefly.theme` | 明暗主题 | 原样保留 |

这些 key 只用于恢复界面选择，不是权限、负责人、revision 或工作流状态的可信来源。

## 4. Work 状态迁移规则

WS-004/WS-101 将冻结最终枚举；WS-001 先固定语义映射，避免丢失现有状态。

| v1 `Work.status` | V2 迁移语义 |
|---|---|
| `created` | 视频任务已创建，营销策略待开始 |
| `strategy_draft` | 营销策略进行中，保留最新草稿和全部版本 |
| `awaiting_strategy_approval` | 营销策略待人工确认 |
| `strategy_approved` | 营销策略已确认，资产匹配待开始 |
| `script_draft` | 脚本进行中 |
| `awaiting_script_approval` | 脚本待人工确认 |
| `script_approved` | 脚本已确认，分镜待开始 |
| `prompt_draft` | 保留为旧 Prompt 产物；不作为 V2 独立阶段，分镜待开始 |
| `awaiting_prompt_approval` | 保留旧确认状态并标记需人工复核；不自动视为 V2 阶段确认 |
| `prompt_approved` | 保留旧确认记录，分镜待开始 |
| `storyboard_draft` | 分镜进行中 |
| `awaiting_storyboard_approval` | 分镜待人工确认 |
| `storyboard_approved` | 分镜已确认，视频预览待开始 |
| `rendering` | 视频预览生成中 |
| `final_review` | 视频预览待人工确认 |
| `export_ready` | 视频预览已确认，交付待执行 |
| `exported` | 交付完成 |

旧流程没有“资产匹配”确认点。只有 `strategy_approved` 及更后状态的历史任务可创建一个明确标记为 `legacy_inferred` 的资产匹配版本；不能伪造成人工确认。其他任务应停在资产匹配待确认状态。

## 5. V1 → V2 聚合迁移映射

产品规格要求迁移到“示例品牌 → 示例车型项目 → 原广告作品对应的视频任务”。建议使用以下确定性流程：

1. 建立或复用 `brand_firefly_demo` 品牌和黄金样例车型。
2. 按 `tenantId + brandId + vehicleId + aspectRatio` 对 v1 Work 分组并创建 `BatchProject`。
3. 当前 v1 不含画幅，迁移器必须使用显式配置的默认画幅，不能在代码深处静默猜测。
4. 每个 Work 生成一个 `VideoTask`，保留原 `work_<uuid>` 作为任务 ID。
5. 车型快照按快照 ID 去重后独立保存；任务锁定该快照。
6. 策略版本和审批记录转换 ID 外键后原样导入，并记录 `migratedFromSchemaVersion: 1`。
7. 根据上表转换阶段进度；任何推断产生的记录带 `legacy_inferred` 来源。
8. 更新有 `workId` 的 Agent Session 绑定；无绑定 Session 不变。
9. 首次加载 Web 时迁移 `firefly.workId`，服务端仍重新校验任务可见性和负责人权限。

## 6. 兼容字段、废弃字段和新增缺口

### 6.1 兼容保留

- 所有已有实体 ID；
- 租户、品牌、车型和创建审计字段；
- Work revision 与时间戳；
- 完整车型事实快照；
- 策略版本、人工编辑、锁定项和审批记录；
- Agent Session ID 与消息历史；
- 浏览器主题设置。

### 6.2 废弃或仅限迁移读取

- 类型名 `Project`、`Work`；
- 外键名 `projectId`（在 Work/快照中的旧语义）、`workId`；
- API 路径 `/v1/works`；
- `CreateWorkRequest`、`CopyWorkRequest` 及前端“复制作品”入口；
- `WorkStatus` 中独立 Prompt 阶段；
- `LocalWorkRecord` v1 和 `.data/works/<workId>.json` 作为长期写入格式；
- `firefly.workId`；
- 固定身份与范围 `LOCAL_SCOPE`。

废弃项在 V2 写路径中不得继续产生；如需平滑升级，仅在带版本号的迁移读取器或临时兼容 API 中存在。

### 6.3 V2 必须新增且 v1 无法恢复

- `Brand`、正式 `Vehicle` 记录及其管理版本；
- 批次项目的 `vehicleId`、画幅、批次名、生成名称、视觉风格和资产池；
- 视频任务的负责人、受众、主题、时长、脚本入口、平台标签；
- 项目资产池与任务资产快照；
- 每阶段不可变产物、确认记录、依赖和失效原因；
- 任务接管审计、账号运行锁、额度、成本和扣减记录；
- SessionScope 对租户、账号、品牌、项目和任务的服务端解析。

迁移时，这些值应来自明确的迁移配置或使用带来源的 `unknown`/待补全状态；不得伪造历史人工操作。

## 7. 后续任务输入

- WS-002：先新增 `Brand`、`Vehicle`、`BatchProject`、`VideoTask` Schema；保留独立 v1 类型只供迁移测试使用。
- WS-003：用版本化资产引用替换 `referenceAssetIds: string[]`。
- WS-004：定义阶段进度、不可变产物、确认事件、来源和下游失效结构，并承接第 4 节语义映射。
- WS-301/WS-307：实现显式 `v1 -> v2` 迁移器、幂等标记、迁移前备份和汇总校验；不要让常规 V2 Store 隐式改写旧文件。
- AG 对话线：`TaskContext` 使用 `videoTaskId`，Session 兼容读取旧 `workId`，业务状态始终来自 V2 Store。

## 8. WS-001 验收检查

- [x] 找到 `Project`、`Work`、`VehicleSnapshot` 的全部定义和主要引用。
- [x] 盘点业务文件、Agent Session 和浏览器本地状态。
- [x] 给出字段级兼容、废弃和缺失清单。
- [x] 给出全部 v1 Work 状态的迁移语义。
- [x] 记录本地 v1 样例数据基线，供后续迁移测试核对。
- [ ] PR 合并到 `main` 后，按实时账本规则将 WS-001 标记为 `已完成`。
