# Dayflow Archive

个人 Dayflow 云端档案：macOS 菜单栏客户端只读采集本机 Dayflow，Node.js 服务保存活动、每条活动一张截图、日报、周统计和采集状态，通过登录后的 WebUI 或只读 API 查询。

## 已实现

- 首次导入 Dayflow 当前有效的全部历史；不追溯导入源端已经删除的旧版本。
- 每 30 分钟自动检查变化；CLI 只读取变化日期，网络仅上传变化活动、文档和缺失截图。
- 重试与断点续传：服务端保存同步清单，客户端在提交前持久化待确认批次；批次 ID 保证重试幂等，版本号防止旧批次覆盖新状态。
- 源端删除后，云端保留已上传的内容和截图。默认时间线和时长统计排除该记录，搜索可勾选包含源端已删除。
- 截图从活动时间范围内选取最接近中点的可用视频帧，以 JPEG 保存；只保留首次成功上传的一张。源媒体缺失时显示暂无截图，后续同步继续补齐。
- 时间线、详情、截图放大、分类筛选、中文全文子串搜索、分页、原始日报及周统计、设备状态。
- macOS 原生菜单栏：进度、最近同步、下一次同步、立即同步、暂停、设置、开机启动。
- 单用户密码登录，HttpOnly 会话 Cookie；独立的同步令牌和可选只读 API 令牌。截图需要鉴权。

## 目录

```text
server/                  Fastify API、PostgreSQL schema、鉴权及同步协议
web/                     React WebUI
macos/                   SwiftUI 菜单栏应用及同步引擎
ios/                     iOS / iPadOS 原生 Liquid Glass 档案客户端
scripts/                 初始化、构建、密码重置、本地同步
tests/                   服务端集成测试与浏览器测试
compose.yaml             PostgreSQL + Node.js + Caddy HTTPS
```

## 本地运行

要求 Node.js 22+、PostgreSQL 17+；构建客户端还需要 macOS 14+、Xcode Command Line Tools 或 Xcode、已安装的 Dayflow CLI。

```sh
npm ci
npm run setup
```

`.env` 会生成随机管理员密码和令牌，且不会覆盖已有文件。将 `DATABASE_URL` 调整为可用的本地 PostgreSQL；默认是 `postgresql://neo@127.0.0.1:55436/dayflow`。

本项目独立的本地 PostgreSQL 可按以下方式初始化（只在第一次执行 `initdb`）：

```sh
mkdir -p .local/pgdata
initdb -D .local/pgdata -A trust --no-locale -E UTF8
pg_ctl -D .local/pgdata -l .local/postgres.log -o '-h 127.0.0.1 -p 55436 -k /tmp' start
createdb -h 127.0.0.1 -p 55436 dayflow
npm run build
npm run dev
```

打开 `http://127.0.0.1:4310`。登录账号和密码分别是 `.env` 的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。此开发数据库只监听本机；公网部署使用下面的 Compose 配置与数据库密码。

前端热更新可另开 `npm run dev:web`。此时将 `.env` 的 `PUBLIC_ORIGIN` 改为 `http://127.0.0.1:5173` 并重启 API，浏览器访问该地址。

## macOS 客户端

```sh
npm run client:build
open '.local/Dayflow Sync.app'
```

应用只显示菜单栏图标。打开「设置」，填入服务器 HTTPS 地址和 `.env.production` 中的 `SYNC_TOKEN`，保存后会自动开始同步。设备令牌保存在 macOS 钥匙串；其他设置与待确认批次在 `~/Library/Application Support/DayflowSync/`。

应用在运行期间按间隔调度；休眠不会唤醒 Mac，唤醒后恢复。网络失败后 5 分钟重试。暂停会取消当前工作，已经提交的批次仍然保留。菜单栏可以打开网页并选择开机启动。正式使用前将应用放到稳定路径，例如 `~/Applications/Dayflow Sync.app`，再开启登录项。构建产物为本机架构、临时签名，未做 Developer ID 公证。

本地端到端导入（只允许 loopback 地址）：

```sh
npm run sync:local
```

此命令使用 `.local/client-settings.json` 和 `.local/client-state/`，不会改写正式菜单栏应用设置或钥匙串。再次执行应只发送状态与期间产生的变化。

让菜单栏应用沿用本地验证的服务器和设备身份：

```sh
npm run sync:local -- --configure
open '.local/Dayflow Sync.app'
```

此配置命令将服务器与设备设置写入 `~/Library/Application Support/DayflowSync/`，令牌写入钥匙串。

也可将同一可执行文件用于脚本：

```sh
DayflowSync --inspect --config /path/to/settings.json
DayflowSync --sync-once --config /path/to/settings.json --state-dir /path/to/state --token-env DAYFLOW_DEVICE_TOKEN
```

配置格式见 `macos/Sources/DayflowSync/Support.swift` 中的 `Settings`，本地示例由 `npm run sync:local` 生成。保留同一设备 ID；更换 ID 会被视为另一台设备。

## iOS 客户端

用 Xcode 26+ 打开 `ios/Dayflow.xcodeproj`，选择 `Dayflow` Scheme，在 iOS / iPadOS 26+ 模拟器或真机运行。输入服务器地址，使用与 Web UI 相同的账号密码或只读 `READ_API_TOKEN` 登录。

支持时间线、分类筛选、中文全文搜索、分页、活动详情、截图缩放、日报、周统计及设备状态；使用原生 SwiftUI 与 Liquid Glass。密码不保存，会话与令牌存入钥匙串。运行、签名和测试说明见 [ios/README.md](ios/README.md)。

## 云服务器部署

要求 Docker Engine 与 Compose v2+，域名 A/AAAA 指向服务器，开放 TCP 80/443（UDP 443 可选）。

```sh
node scripts/setup-production.mjs dayflow.example.com neo
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
```

初始化脚本创建 `.env.production`，其中数据库密码、管理员密码、同步令牌和只读令牌相互独立。文件已被 Git 和 Docker build context 排除。Caddy 自动申请 HTTPS 证书；数据库和 Node.js 端口不向公网发布。客户端服务器地址为 `https://dayflow.example.com`。

数据库、截图、证书均使用持久卷。`docker compose down` 保留这些卷；不要使用 `down -v`，除非确实需要清空数据。

修改管理员密码：先更新 `.env.production` 的 `ADMIN_PASSWORD`，再执行：

```sh
docker compose --env-file .env.production run --rm app node --import tsx scripts/reset-password.ts
docker compose --env-file .env.production up -d app
```

该操作撤销已有浏览器会话。单纯修改环境变量不会改变已创建账号的密码。令牌轮换需更新环境变量、重启 app，并更新客户端设置。

备份时分别保存数据库与截图，并妥善保管生产环境文件：

```sh
docker compose --env-file .env.production exec -T db pg_dump -U dayflow -d dayflow -Fc > dayflow.dump
docker compose --env-file .env.production exec -T app tar -C /app/storage -czf - . > dayflow-screenshots.tar.gz
```

为获得精确一致的备份，可先暂停客户端同步。恢复时将数据库备份导入 PostgreSQL，并将截图归还同一个 `/app/storage` 卷。

## API

所有业务接口前缀为 `/api/v1`。浏览器使用会话 Cookie；脚本的只读请求使用 `Authorization: Bearer <READ_API_TOKEN>`。同步接口只接受 `SYNC_TOKEN`，两种令牌不能混用。

| 方法和路径 | 用途 |
| --- | --- |
| `POST /auth/login` | `{ username, password }`，需要 `X-Dayflow-Request: 1` |
| `POST /auth/logout` | 注销并撤销会话，需要相同校验头 |
| `GET /auth/session` | 当前登录状态 |
| `GET /auth/casdoor/start` | 跳转 Casdoor OAuth 授权 |
| `GET /auth/casdoor/callback` | 接收 Casdoor 授权回调；已绑定账号直接建立会话 |
| `POST /auth/casdoor/bind` | 用已有 Dayflow 账号完成一次性 Casdoor 绑定 |
| `GET /overview?date=YYYY-MM-DD` | 日期列表、当天汇总、日报、周统计和设备状态 |
| `GET /activities` | `date` / `from` / `to` / `q` / `category` / `include_deleted` / `page` / `limit` |
| `GET /activities/:device/:record` | 完整活动 |
| `GET /activities/:device/:record/screenshot` | 受保护的 JPEG |
| `GET /sync/state?device_id=UUID` | 已确认版本、日期指纹、活动内容指纹、截图状态 |
| `POST /sync/batch` | 事务性增量提交，结构见 `server/contracts.ts` |
| `PUT /sync/activities/:device/:record/screenshot` | `Content-Type: image/jpeg`，最大 3 MB |

API 日期与时间按照源设备时区和 Dayflow 的日界线处理；默认凌晨 4 点。日报和周统计展示 Dayflow 自己生成的数据，因此可能比刚产生的活动晚。搜索在标题、摘要、详细记录和应用字段中进行，支持中文与普通子串，不依赖英语分词。

Casdoor 登录通过 `CASDOOR_ORIGIN`、`CASDOOR_CLIENT_ID`、`CASDOOR_CLIENT_SECRET` 和可选的 `CASDOOR_REDIRECT_URI` 配置。首次登录不会创建 Dayflow 用户，必须用已有 Dayflow 账号密码完成一次绑定；绑定关系写入 `casdoor_accounts`，同一个 Dayflow 账号不能绑定第二个 Casdoor 身份。

## 一致性与边界

- CLI 没有变更游标，因此客户端每轮只读扫描本地活动元数据，计算日期指纹。这里的“增量”指 CLI 读取范围和网络传输量；不是零扫描的数据库变更订阅。
- 活动内容通过 `(device_id, record_id)` 定位。每个变化日期携带当前有效 ID 清单和变化活动；服务端将清单之外的已上传记录归档，不物理删除。
- 不修改 Dayflow 数据库、不上传录屏、不读取 LLM 请求日志。内部表结构改变时停止同步并报错，避免误把读取失败当成全量删除。
- CLI 与 SQLite 读取之间会复核指纹，活动在读取期间重生成时终止本轮并重试。
- 截图依赖本地媒体仍存在。首次同步前媒体已被清理的活动无法恢复截图，活动文字仍会保存。
- 服务端数据是档案，不会写回 Dayflow。当前面向单用户单 Mac；多个设备的汇总规则和跨设备去重不属于本版范围。
- 长期暂停、关机或离线期间，尚未上传就被 Dayflow 删除的活动无法保证补回。已经成功提交的数据不会因本机清理而消失。
- 单日特别大的批次超过 15 MB 时客户端会明确报错，当前不自动拆分单日清单。

## 验证

```sh
npm run build
npm test
swift test --package-path macos --disable-sandbox
npm run test:ui
npm audit
```

浏览器测试需要先执行 `npx playwright install chromium`；已有 Google Chrome 时也可运行 `PLAYWRIGHT_CHANNEL=chrome npm run test:ui`。

服务端测试在随机独立 PostgreSQL schema 内运行，结束后清理，不改动实际档案。浏览器测试需要服务端运行、已经执行本地同步，且历史中存在 2026-09-16 的记录与日报；测试在桌面和手机宽度验证时间线、截图、搜索、日报、周统计、登录注销及横向溢出。测试截图在 `test-results/`，包含个人活动内容，不提交到 Git。
