# WS-307 Workspace V1 → V2 迁移运行手册

本手册用于把旧 `.data/works` 中的作品迁移到“品牌 → 车型项目 → 视频任务”，并同步有任务绑定的 Agent Session。迁移器只处理本地持久化数据，不调用外部模型或供应商，也不需要任何凭据。

迁移是离线操作。`apply`、`resume` 和 `restore` 会取得独占生命周期锁；API 仍在运行时会被拒绝。即使 `plan` 本身只读，也应在同一个停机窗口中完成 `plan → 人工复核 → apply`，避免源数据或目标数据漂移。

配置示例见 [`examples/ws-307-migration.config.example.json`](./examples/ws-307-migration.config.example.json)。示例没有秘密，但其中的 ID、车型事实、账号、目录和业务默认值只是当前黄金样例基线，不能未经核对直接用于真实迁移。

## 不可跳过的 apply 前确认

由迁移执行人和业务负责人共同签字确认以下项目；任一项不确定就只运行 `plan`，不得运行 `apply`。

| 配置区域 | 必须确认的内容 |
|---|---|
| 迁移身份 | `migrationId` 全局唯一且之后不复用；`migrationOccurredAt` 是本次变更窗口；`migrationActorAccountId` 是真实执行审计账号，并在 `administration.accessGrants` 中具有目标品牌或车型项目的有效授权。 |
| 目标层级 | `tenantId`、品牌 ID/名称、车型 ID/版本、批次项目 ID、资产池 ID 均指向同一个目标层级。 |
| 车型事实 | `administration.vehicleVersions` 的车系、年款、车型款、参数、固定/扩展/禁用 claims 与所有旧 Work 的黄金样例快照逐字段一致。本次只读基线是“萤火 E5 / 长续航示例版”，2 条 fixed claims、1 条 optional claim；不能换成空 claims 的管理端默认车型。 |
| 账号与展示名 | `taskOwnerAccountId`、`taskCreatedByAccountId`、`legacySessionOwnerAccountId` 是预期账号且具有目标品牌或车型项目的有效授权。旧 V1/V2 Session 的 owner 必须等于迁移后任务 owner。`taskOwnerDisplayName` 是任务 owner 的当前展示名，用于非 owner 会话的只读归属提示。 |
| V3 Session 映射 | 盘点每个有任务绑定的旧 V3 Session 的 `scope.actorId + scope.tenantId`；每个需要改域的唯一组合在 `legacyV3SessionScopeMappings` 中有且仅有一条映射。每个 `targetAccountId` 都是真实账号，并具有目标项目有效授权。不要根据显示名猜账号。无任务绑定的 Session 保持原样。 |
| 项目设置 | `aspectRatio` 是确认后的 `9:16`、`16:9`、`1:1` 或 `4:5`；视觉风格 ID 与资产池匹配。V1 没有画幅，迁移器不会替业务方猜测。 |
| 资产 | `projectAssets` 至少包含目标车型素材和 `visualStylePresetId` 指向的视觉风格；每个引用的 provider、asset ID、version、category、vehicleId 都与 `administration.vehicleAssetAssociations` 中的记录精确一致。 |
| 任务默认值 | 核对受众、主题、时长和平台标签。`defaultAudience`、`defaultTheme` 只填补旧数据缺口；V1 没有时长和平台标签，因此 `defaultDurationSeconds`（1–600）及不超过 20 个的唯一标识符标签会进入每条任务。 |
| 数据目录 | 六个目录均为明确、互不相同的路径。相对路径以配置文件所在目录为基准，而不是以当前 shell 目录为基准。`sessions` 应指向 Agent Session，不是 Workspace 登录 Session。逐项按下表与部署环境核对。 |
| 盘点数量 | 必须先停服，再独立统计 Work 和 Agent Session 数量，把数量及盘点时间固化到变更单。开发期间已观察到源目录持续增长，因此任何停服前数字都不能作为 apply 基线。`plan` 的 Work/Session 数必须与停服后的清单精确一致。 |

`administration` 是要合并进 Workspace 管理 Store 的显式审计数据，不是提示信息。相同 ID 的已有品牌、车型事实版本、资产关联或授权若内容不同，迁移会拒绝，不会覆盖或猜测。

六个目录与默认 API 配置的对应关系如下：

| 迁移配置字段 | API 配置/默认值 | 注意事项 |
|---|---|---|
| `directories.works` | `LocalWorkStore` 默认 `.data/works` | 当前默认 API 组合没有对应环境变量；若部署注入了自定义 `LocalBusinessRuntime`，以实际 Store 路径为准。 |
| `directories.sessions` | `LOCAL_AGENT_DATA_DIR`，默认 `.data/sessions` | 这是 Agent 对话 Session。不要误填 `WORKSPACE_SESSION_DATA_DIRECTORY`（默认 `.data/workspace-sessions`），后者存的是登录 Session。 |
| `directories.workspaceAdmin` | `WORKSPACE_ADMIN_DATA_DIRECTORY`，默认 `.data/workspace-admin` | 必须与 API 的管理 Store 完全相同。 |
| `directories.batchProjects` | `BATCH_PROJECT_DATA_DIRECTORY`，默认 `.data/batch-projects` | 必须与 API 的批次项目 Store 完全相同。 |
| `directories.videoTasks` | `VIDEO_TASK_DATA_DIRECTORY`，默认 `.data/video-tasks` | 必须与 API 的视频任务 Store 完全相同。 |
| `directories.migrations` | `WORKSPACE_MIGRATION_DATA_DIRECTORY`，默认 `.data/workspace-migrations` | API 和迁移 CLI 必须共享此目录，生命周期租约和完成标记才会生效。 |

## 准备停机窗口

1. 从示例复制一份操作配置到受变更管理的位置，并逐项替换、复核。不要在配置中加入 token、密码、API key 或其他凭据。
2. 使用部署服务管理器停止所有 API 实例和 `dev:api`/`start:api` 进程，确认没有进程继续读写六个配置目录。不要手工删除 `.api-leases` 或 `.migration.lock`；存活进程和陈旧租约由程序校验。
3. 对六个数据目录以及操作配置做一次独立的文件系统级快照，并记录快照位置和时间。内置迁移备份是恢复机制的一部分，但不能替代运维级快照。
4. 从仓库根目录运行命令。路径包含空格时，把完整的 `--config=...` 参数放在双引号内。

以下示例使用 PowerShell：

```powershell
$migrationConfig = "D:\change-controlled\ws-307-migration.json"
npm run migrate:workspace-v2 -- status "--config=$migrationConfig"
```

首次执行时 `status` 应输出：

```json
{
  "manifest": null
}
```

如果已经存在同一 `migrationId` 的 `in_progress`、`completed` 或 `restored` manifest，不要直接开始新的 `apply`，先按“中断、重放与恢复”处理。

## 生成并复核只读计划

```powershell
npm run migrate:workspace-v2 -- plan "--config=$migrationConfig"
```

`plan` 不创建 manifest、不创建备份、不修改 Work、Session 或任何 V2 目标。它会完整解析源数据、执行迁移映射和 Store 校验，并输出：

- `planHashSha256`：本次配置、源数据和目标前像共同决定的 64 位小写 SHA-256；
- `sources`：每个 Work/Session 的文件名、大小、hash 和预定备份位置；
- `targets`：目标类型、ID、是否需要写入、前像和预期后像 hash；
- `summary`：作品、策略版本、审批、推断产物、Session 和目标写入数量。

把完整输出附到变更单，逐项核对来源数量、目标 ID、`writeRequired`、已有目标以及 summary。尤其确认 Work 数量与最新盘点一致，且没有未知 Session、目标冲突或意外 no-op。

只复制该次已获批准输出中的 `planHashSha256`。若修改配置，或任一源/目标文件发生变化，旧 hash 必须作废；重新运行 `plan` 并重新审批，不能为了通过校验而盲目接受新 hash。

## 使用精确 hash 执行

```powershell
$planHash = "<从已批准 plan 原样复制的 64 位小写 SHA-256>"
npm run migrate:workspace-v2 -- apply "--config=$migrationConfig" "--plan-hash=$planHash"
```

`apply` 会先重新生成计划并要求 hash 精确相等，然后按以下顺序执行：

1. 校验源文件和目标前像未变化；
2. 复制并校验所有源备份和需要覆盖的目标前像；
3. 写入 `in_progress` manifest；
4. 依次写入 Workspace 管理数据、批次项目、视频任务和 Agent Session，每写一个目标就原子更新 manifest；
5. 使用全新的 Store 实例重载所有目标并核对 hash；
6. 将 manifest 标记为 `completed`。

重复使用同一配置和同一 hash 对已完成迁移执行 `apply` 是只读重放，结果中会返回 `replayed: true`；它不会重写业务数据。不要使用不同 hash 重放同一 `migrationId`。

## 状态与完成后检查

```powershell
npm run migrate:workspace-v2 -- status "--config=$migrationConfig"
```

只有 `manifest.status` 为 `completed` 才能结束停机窗口。确认：

- `completedAt` 存在，所有 `writeRequired: true` 的 target 都有与预期后像一致的 `appliedSha256`；
- 内置备份和 manifest 均已复制到受保护的审计存储，但原目录仍保留且不被改写；
- 配置、已批准 plan、命令输出和运维快照已关联到同一变更单；
- API 重启后能读取目标项目和任务，且不存在 `in_progress` migration。

成功迁移不会删除旧 Work。API 在看到 `completed` manifest 后仍允许读取 V1 作品，但所有 V1 写接口固定返回 HTTP `410 Gone`；新的业务写入只能走 V2 项目/任务接口。这个开关在 API 启动时读取，因此必须在迁移完成后重新启动 API，不能让停机前的进程继续服务。

## 内置备份与 manifest

对于配置中的 `<migrations>` 和 `<migrationId>`，审计文件位于：

```text
<migrations>/<migrationId>/manifest.json
<migrations>/<migrationId>/backup/source-works/*.json
<migrations>/<migrationId>/backup/source-sessions/*.json
<migrations>/<migrationId>/backup/target-preimages/workspace-admin/*.json
<migrations>/<migrationId>/backup/target-preimages/batch-projects/<tenantId>/*.json
<migrations>/<migrationId>/backup/target-preimages/video-tasks/*.json
```

Session 的源备份同时就是它被覆盖前的前像。新建目标没有前像文件；未变化目标不会被重复备份。manifest 记录每个源、前像和后像的大小及 SHA-256，`resume`/`restore` 都会重新验证。

不要编辑、移动或删除 manifest、备份、源文件或已写目标，也不要把另一个迁移 ID 的备份混入当前目录。即使状态已是 `completed` 或 `restored`，仍应保留整个目录作为审计记录。

## 中断、重放与恢复

迁移命令失败后保持 API 离线，先运行 `status`：

- `manifest: null`：失败发生在 manifest 提交前。查明并消除原因；源、目标或配置有变化时重新 `plan`、重新审批，再用批准的 hash 执行 `apply`。
- `status: in_progress`：API 会持续 fail-closed。保持配置、hash、备份和目标不变，执行：

  ```powershell
  npm run migrate:workspace-v2 -- resume "--config=$migrationConfig" "--plan-hash=$planHash"
  ```

  `resume` 从已校验的备份重建计划，跳过已正确写入的目标，并继续剩余步骤。配置漂移、备份损坏或目标被人工修改都会被拒绝；不要绕过这些检查。

- `status: completed`：迁移已经完成。同一配置和 hash 的 `apply`/`resume` 只会返回安全重放结果。
- `status: restored`：该 `migrationId` 永久关闭，不能复用。如业务仍决定迁移，使用新的 ID，从新的 `plan` 和审批开始。

只有需要撤销尚未被正常业务继续修改的迁移结果时，才运行：

```powershell
npm run migrate:workspace-v2 -- restore "--config=$migrationConfig"
```

`restore` 不接收 plan hash，但要求配置 fingerprint 与 manifest 完全一致。它按写入的逆序恢复已有目标前像并删除由迁移新建的目标。只要任一目标已在迁移后被正常业务推进或被人工改动，整次 restore 会在写回前拒绝，避免覆盖新数据；此时必须走人工事件恢复方案，不能修改 manifest 或文件来强行回滚。

restore 也必须在 API 离线时执行。成功后确认状态为 `restored`，再重启 API 并完成 V1/V2 可读写边界复核。
