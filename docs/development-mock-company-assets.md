# 开发期 Mock 公司资产媒体

公司资产目录通过可替换的只读 Provider 接入，不依赖 PostgreSQL。PostgreSQL 仍只负责 Workspace V2 的管理、项目池、任务快照等权威业务状态。

## C10 清单

- 版本化清单位于 `packages/tools/src/mock-company-asset-manifest.ts`。
- 逐图配套文本位于 `packages/tools/src/mock-company-asset-descriptions.ts`；55 个资产 ID 各有一条独立、基于可见画面的 `visualDescription`，Provider 将其白名单映射为公共 `description`。
- 当前包固定包含 55 张 C10 图片：13 张 JPEG、42 张 WebP，均为 2508×1672。
- 业务身份由清单中的 `assetId + version + sourceProvider` 决定；文件名只是存储路径和人工说明，不能作为主键。
- 清单保留真实 MIME、字节数和 SHA-256。读取时任何路径、格式、大小或校验和不一致都会拒绝返回。
- 描述只记录画面中的主体、视角、构图、环境和可辨屏幕信息，不推断官方年款、配置、功能效果或营销卖点；公开描述统一提示其不构成车型事实。
- C10 使用独立的开发作用域 `brand_leapmotor_demo / vehicle_leapmotor_c10_demo`，不会与现有萤火 E5 资产交叉绑定。管理员确认正式车型年款、配置和事实快照前，不应把这组素材加入 E5 的默认关联。

默认开发种子目前没有上述 C10 品牌、车型和账号授权，因此这 55 条会安全休眠，不能在当前 UI 中浏览。管理员确认 C10 年款、配置和事实后，应使用上述固定 ID 增加服务端车型种子、资产关联和账号授权；这不需要改变文件名、资产 ID 或 PostgreSQL Schema。

## 本机媒体目录

图片二进制不进入 Git。默认根目录为：

```text
.data/mock-company-assets/
└── leapmotor-c10/
    └── v1/
        ├── 金属黑/
        ├── 曦露紫/
        ├── 珍珠白/
        ├── 紫空间/
        ├── 紫内饰/
        ├── 棕空间/
        └── 棕内饰/
```

将已重命名图片复制到上述目录并保留分组结构。需要使用其他位置时，可在被忽略的 `.env` 中设置 `MOCK_COMPANY_ASSET_MEDIA_DIRECTORY`；不要把个人绝对路径提交到仓库。

## HTTP 读取边界

开发路由为：

```text
GET|HEAD /v1/mock-company-assets/{assetId}/versions/{version}/thumbnail
```

路由只接受稳定资产 ID 和精确版本，不接受文件名、相对路径或身份查询参数。请求必须携带当前 Workspace Bearer Session，并通过服务端最新授权检查：管理员需要对应品牌授权，制作账号需要对应品牌与车型项目授权。缺失版本和越权访问统一返回 404。

路由在 production 中始终关闭；非回环地址还需显式设置 `FIREFLY_ENABLE_DEVELOPMENT_ASSET_MEDIA=true`。响应使用私有重新验证缓存、强 ETag、`nosniff` 和同源资源策略。当前网页若要展示图片，应以带 Bearer 的二进制请求创建临时 Blob URL，不要把 token 放进 URL。


