# 依赖许可与安全基线

评估日期：2026-08-20。

- Node.js 最低版本固定为 `22.19.0`，直接依赖使用精确版本，锁文件纳入仓库。
- `@earendil-works/pi-agent-core@0.84.1` 与 `@earendil-works/pi-ai@0.84.1` 的 npm 元数据均声明 MIT 许可证。
- PostgreSQL 驱动固定为 `pg@8.22.0`；其 npm 元数据声明 MIT 许可证。驱动只在 API 基础设施层加载，不进入 Agent 工具面。
- 私有媒体对象存储适配器固定使用 `@aws-sdk/client-s3@3.1114.0` 与 `@aws-sdk/s3-request-presigner@3.1114.0`；两者 npm 元数据均声明 Apache-2.0 许可证。SDK 仅位于 API 基础设施层，不注册为 Agent 工具，也不向业务 Schema 暴露 Bucket、对象键或云厂商类型。
- 对象存储默认关闭。启用 S3-compatible 后，生产自定义端点必须使用 HTTPS；开发期 HTTP 仅允许 loopback。上传使用服务端构造的严格对象键、SHA-256 校验和与 `If-None-Match: *`，不发送对象 ACL；Bucket 私有性与最小权限 IAM 仍由部署策略强制。
- 生产优先使用云工作负载身份的 SDK 默认凭据链。可选静态凭据必须成对注入运行环境，不写入仓库；配置与 SDK 错误统一脱敏，不回显端点、Bucket、对象键或凭据值。
- 签名 GET 地址按 bearer 凭据处理，TTL 配置被限制为 60–900 秒，只在认证响应中即时返回，不得进入 PostgreSQL、业务聚合、日志、Agent transcript、提示词或工具结果。
- 安装默认启用 `ignore-scripts=true`，降低第三方安装脚本风险；若未来依赖必须运行安装脚本，需要单独评审。
- `npm run audit:prod` 使用 npm 官方安全审计端点；在网络受限环境中的离线结果不能替代 CI 的在线复核。
- `npm run security:check` 扫描仓库中的私钥及常见服务令牌模式。
- CI 在无模型凭据情况下执行类型检查、测试、凭据扫描和生产依赖审计。

该评估不是一次性结论。升级 Pi 或加入模型、数据库、队列、对象存储 SDK 时，必须更新锁文件、复跑审计并检查许可证变化。
