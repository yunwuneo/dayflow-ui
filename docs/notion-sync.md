# Notion 同步接入

## 同步范围

客户端只向现有服务器上传一次。服务器将相同批次分别用于云端档案和 Notion 队列，不向客户端分发 Notion 令牌，也不让浏览器参与数据转发。

| 云端同步 | Notion 同步 | 行为 |
| --- | --- | --- |
| 开 | 关 | 原有活动、截图、日报和周报归档 |
| 开 | 开 | 同一上传事务写入云端档案与 Notion 待发送队列 |
| 关 | 开 | 仅中转活动文字、日报和周报；发送完成后清除中转正文，保留指纹和页面映射 |
| 关 | 关 | 不接收新批次；新版 macOS 客户端在读取本地数据前检测暂停，旧版收到 HTTP 423 |

Notion 是单向输出，覆盖同步记录的属性和正文。源端删除会标记「源端已删除」，保留已同步的正文；日报/周报缺失也会标记。个人笔记应放在同步数据库之外。**截图仅属于云端同步，不上传到 Notion**；仅 Notion 模式不请求客户端补传截图。

关闭同步不删除已有云端档案或 Notion 页面。暂停 Notion 后待发送正文仍保留在队列，重新开启继续。断开连接会撤销令牌、清除 Notion 队列和映射，保留已创建页面；UI 会明确确认这一操作。

## 官方文档

2026-10-15 查阅以下官方文档，固定使用 `Notion-Version: 2026-03-11`：

- [授权、模板复制与令牌刷新](https://developers.notion.com/guides/get-started/authorization)
- [API 版本](https://developers.notion.com/reference/versioning)
- [创建数据库与 initial_data_source](https://developers.notion.com/reference/create-a-database)
- [查询 data source](https://developers.notion.com/reference/query-a-data-source)
- [API 请求限制](https://developers.notion.com/reference/request-limits)
- [撤销授权令牌](https://developers.notion.com/reference/revoke-token)

模板选项属于 Notion 公开连接的配置，需要真实的公开页面 URL，不能靠 OAuth URL 的自定义参数开启。授权返回 `duplicated_template_id` 后，Dayflow 会预选该页面供用户确认。

## 1. 生成开发者模板

准备一个空白父页面，以及有权访问父页面的临时内部连接令牌（读取、插入和更新内容权限）。令牌仅通过环境变量 `NOTION_TEMPLATE_TOKEN` 提供，不进入命令行参数或仓库；工具不会自动加载 `.env`。

先预览，无需凭据，不写入 Notion：

```sh
npm run notion:template
```

通过安全的本地环境变量注入令牌后，生成真实模板：

```sh
npm run notion:template -- --create --parent <父页面UUID>
```

创建的「Dayflow · 活动与回顾」页面包含使用说明和「Dayflow 同步记录」内联数据库，不包含真实活动。创建页面后立即输出 URL；若数据库步骤失败，可复用同一页面继续：

```sh
npm run notion:template -- --create --page <刚创建的模板UUID>
```

数据库字段：`Name`（标题）、`Dayflow ID`（富文本、同步唯一键）、`类型`（活动/日报/周报）、`日期`、`设备`、`分类`、`时长`（分钟）、`源端已删除`（复选框）。可执行定义在 `server/notion-api.ts` 中，生成工具和接入流程共用，避免模板漂移。用户可自行添加日历或筛选视图，不应删除或改变必需字段类型。

在 Notion 中发布这个**空模板**并允许复制，再复制公开 URL。发布和连接控制台配置需开发者操作，工具不会公开用户页面。

## 2. 创建公开连接

在 Notion Developer portal 创建 Public connection，配置安装范围和 Read content、Insert content、Update content 权限，无需邮箱权限。

1. 回调地址设为 `https://你的域名/api/v1/integrations/notion/callback`。
2. 在 Configuration / Basic information 的 **Notion URL for optional template** 中填写公开模板 URL。
3. 将 Client ID 和 Client Secret 配置到服务器，不提交真实值或发送到聊天中。
4. 按 Notion 控制台要求完成发布/审核步骤，使目标用户可安装。

没有模板 URL 时仍可授权已有页面，确认目标后创建标准数据库。此路径不会显示 Notion 原生的“使用开发者提供的模板”选项。

## 3. 配置服务器

```dotenv
NOTION_ENABLED=true
NOTION_CLIENT_ID=<公开连接Client ID>
NOTION_CLIENT_SECRET=<公开连接Client Secret>
NOTION_ENCRYPTION_KEY=<32字节随机值的64位十六进制表示>
NOTION_REDIRECT_URI=https://你的域名/api/v1/integrations/notion/callback
NOTION_TEMPLATE_URL=https://你的公开模板.notion.site/页面
```

用 `openssl rand -hex 32` 生成一次加密密钥。密钥需稳定保存，与数据库分别备份；替换/丢失会使旧凭据无法解密，需恢复原密钥或重新授权。不要使用 `VITE_*` 变量。两个 Compose 文件均已传递这些变量。

生产环境必须 HTTPS；开发时仅允许 localhost/127.0.0.1/::1 的 HTTP 回调。回调必须与 `PUBLIC_ORIGIN` 和 Notion 控制台完全一致。启动时验证配置，幂等创建新表，不改变原归档数据。

`NOTION_ENABLED` 控制服务端接入能力；**用户的两个同步开关保存在数据库**，在网页「同步状态」页管理。默认云端开启、Notion 关闭。当前应用是一份共享个人档案，开关按实例生效，仅档案所有者（配置 MCP OAuth 时使用其 owner，否则使用 ADMIN_USERNAME）可管理。只读 API 和设备令牌均不能管理授权或设置。

## 4. 用户接入

1. 登录网页，进入「同步状态」，点击「连接 Notion」。
2. 在 Notion 授权页使用开发者模板或选择已有页面。
3. 回到 Dayflow，确认预选模板副本；或刷新授权页面后选择目标。
4. 点击「确认同步页面」，验证或创建标准数据库。
5. 开启 Notion 同步，按需关闭云端同步。云端开启时会从现有档案补发，无需再次上传。

界面显示工作区、授权时间、目标页面、待处理/失败/已同步数量、最近成功和下次重试时间，每 10 秒更新。授权失效可重新授权；页面权限变化可在 Notion 重新共享。更换工作区或目标前需断开连接，避免旧队列误写新页面。

## 故障恢复与数据保留

- 接收批次与入队在同一 PostgreSQL 事务提交，网络失败不要求客户端重传整批。
- 队列按设备和记录 ID（或报告日期）合并，成功后清除 payload，保留映射/指纹/状态。服务器重启继续发送。
- 每 2 秒处理一条记录，API 调用间隔至少 350 ms、超时 20 秒。429 遵守 Retry-After，失败指数退避；只保存安全错误摘要。
- PostgreSQL advisory lock 串行化服务副本及授权/目标变更；版本条件避免旧任务的确认覆盖发送期间新到达的数据。
- 先按 Dayflow ID 查询，再创建并保存映射。响应丢失后可找回页面；Notion 无跨系统事务或唯一约束，极端搜索可见性延迟仍可能需要检查重复记录。
- 长正文拆分为有界富文本段落，不静默截断；失败后重新读取块并替换。发现手动添加的复杂结构会报错以避免误删。
- access/refresh token 用 AES-256-GCM 加密。401 时尝试刷新并保存轮换凭据，持续失败提示重新授权。
- OAuth state 单次使用、10 分钟有效，绑定所有者会话和 HttpOnly/SameSite=Lax nonce；退出后未完成授权失效，原登录 Cookie 保持 Strict。
- 仅 Notion 模式下正文仅在待发送时保留；设备元信息、指纹、批次 ID、页面映射持久保留。失败队列不会自动丢弃，部署方应监控数据库容量。
- 重新开启云端会更新设备 revision 并清理日期清单，使客户端重新核对；不会删除原活动、报告或截图。

## 验证边界

`npm test` 使用临时 PostgreSQL 和虚构 Notion transport，验证授权、重放、模板建表、回填、仅 Notion、长文本、删除/恢复、限流、令牌刷新及响应丢失恢复。`npm run test:ui` 使用虚构数据验证桌面与窄屏设置界面。

真实公开连接、模板发布、Notion OAuth 许可页、实际写入和生产部署，需提供凭据并完成控制台配置后另行联调。代码测试不代表已完成真实授权。
