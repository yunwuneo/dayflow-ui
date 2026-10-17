# Dayflow MCP OAuth 本地实现与上线手册

本轮仅修改本地代码并使用虚构数据验证。没有部署、推送、连接线上数据库、生成生产凭据或创建 ChatGPT 授权连接。

## 版本及选型

2026-10-12 已 fetch origin；开始修改时 main、origin/main 都是 `9ed52e68545673adfe9c77fe2e3b89388c87a996`，ahead/behind 为 0/0，工作区干净。

使用 `@node-oauth/oauth2-server` 5.3.0，固定版本写入 package-lock.json。库负责授权码、S256 PKCE 验证、随机码/令牌生成、OAuth 令牌协议与 access token 验证；项目负责 Fastify 路由、原生账号会话、metadata、授权界面及 PostgreSQL model。相比完整 OIDC 的 oidc-provider，本实现无需另一套账号、OIDC 会话、ID token 或签名密钥。使用库不是免除业务权限和并发持久化校验的理由。

按官方文档选择**预注册客户端**，当前一次部署仅配置一个客户端，支持 public `none`，或配置独立 secret 后的 `client_secret_basic`/`client_secret_post`。不支持 CIMD、DCR、private_key_jwt，不声明相应 metadata。没有自动抓取客户端 metadata 的 SSRF 面，也没有公开注册入口。ChatGPT 当前文档支持预注册、CIMD 和 DCR，但实际账号界面能否输入预注册 ID/secret，仍需在确认上线时核实。如果界面只提供 CIMD/DCR，不要冒充支持或放开注册，需要另行实现并验证相应注册方式。

核对的官方来源（2026-10-12）：

- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)：metadata、401 challenge、PKCE、resource、issuer identification、客户端和精确回调配置。
- [Connect a custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server)：预注册凭据及连接方式。
- [MCP 最新 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)：OAuth/resource discovery 与注册方式。
- [OAuth 库官方仓库](https://github.com/node-oauth/node-oauth2-server)、[官方 model 文档](https://node-oauthoauth2-server.readthedocs.io/en/master/model/spec.html)、[PKCE 文档](https://node-oauthoauth2-server.readthedocs.io/en/master/misc/pkce.html)。文档站显示 5.1.0；本轮还检查了安装的 5.3.0 实际授权码及刷新处理源码，特别是 PKCE 前消费码的行为。
- [oidc-provider 官方仓库](https://github.com/panva/node-oidc-provider)：比较过，未引入。

## 流程及权限

1. 未认证的 `/mcp` 返回 401，`WWW-Authenticate` 指向 `/.well-known/oauth-protected-resource/mcp`，要求 `dayflow:read`。浏览器 Cookie、同步令牌、URL/body token 均不能代替 MCP Authorization header。
2. protected-resource metadata 中 resource 为 `PUBLIC_ORIGIN + /mcp`，issuer 为 `PUBLIC_ORIGIN`。`/.well-known/oauth-authorization-server` 发布 authorize/token/revoke、S256、scope 和客户端认证方式。无路径的 protected-resource metadata 也返回相同 resource。
3. `/oauth/authorize` 严格校验预注册 client_id、精确 HTTPS redirect_uri、response_type=code、resource、scope、state、S256 challenge。错误配置/请求安全拒绝，无法确认合法回调时在本地报错，不向不受信任地址跳转。
4. 没有会话时显示原生用户名密码登录页；复用 scrypt 密码验证、users/sessions 表和 HttpOnly 原生会话 Cookie，不向客户端发送密码。密码验证及创建会话持有账号共享锁，和密码重置串行。
5. 显示服务端会话账号、配置中的客户端名称、读取范围及续期说明。只有 `MCP_OWNER_USERNAME` 指定的真实会话用户可以同意授权。授权页面 CSP 仅允许同源表单及已配置的 HTTPS 回调来源（Chrome 会检查重定向链），完整回调 URI 仍由服务端精确匹配；同源 Referrer-Policy 防止跨站泄露并保留合法表单 Origin。POST 确认依据数据库查出的会话身份，不接受前端提供的用户名；同意/拒绝均需 Origin、浏览器绑定的 interaction Cookie 和一次性持久化 CSRF 校验。
6. 同意创建持久化 grant 和短期 code；拒绝返回 access_denied，不创建 grant。成功和拒绝重定向均携带 state 和正确的 iss。授权码交换的资源必须精确匹配；库验证客户端、回调、期限和 PKCE。事务、grant 行锁及原子 UPDATE 保证并发只能消费一次；错误 PKCE 也消费码。
7. token endpoint 返回随机 opaque access token，数据库只保存 SHA-256 摘要；resource/audience、client、user、scopes、期限绑定在 grant/token 记录中。每次 MCP 请求重新查库确认用户、客户端、资源、scope、期限与撤销状态。不需要自行签 JWT 或保存授权服务器私钥。
8. 请求 `offline_access` 时发放刷新令牌；每次刷新单次消费并轮换。保留已消费 refresh 摘要直到授权删除，以识别重放；重放撤销整个 grant，使新旧 access/refresh 全部失效。授权期限是固定的绝对上限，不会因刷新无限延长。未请求 offline_access 的授权不发刷新令牌。
9. 只有 `/mcp` 接受 OAuth token。OAuth token 不能访问业务 REST API、上传或同步。SYNC_TOKEN 不能读活动或 MCP；已有 READ_API_TOKEN 仍能按原有权限访问只读 REST/MCP。

授权启用时，非所有者浏览器账号也不能读取未隔离的档案，仍可查看自身 session 和注销。固定 READ_API_TOKEN 是独立的、具有全档案权限的旧客户端凭据，不受 OAuth grant 撤销影响。这保留兼容性；如需同时停用旧凭据，另行确认并轮换/移除 READ_API_TOKEN。`/api/v1/auth/session` 现在必须有真实会话，返回该会话 username；固定只读 token 不再伪装成管理员身份。

未提供密码授权、client credentials 或隐式授权；不发布 openid/email/profile，也不提供 ID token/UserInfo（没有虚构邮箱或企业域名验证）。Casdoor 代码与现有设置保留，OAuth MCP 无需它。

## 配置（无秘密）

`.env.example` 和两个 Compose 文件已加入 OAuth 配置。默认 `MCP_OAUTH_ENABLED=false`，不改变现有固定 Bearer 功能。示例：

```dotenv
PUBLIC_ORIGIN=https://dayflow.neo7.cn
MCP_OAUTH_ENABLED=true
# 精确指定已经存在的原生账户，不能依赖前端显示名或默认管理员推断
MCP_OWNER_USERNAME=<existing-native-owner-username>
MCP_OAUTH_CLIENT_ID=<pre-registered-client-id-configured-in-ChatGPT>
MCP_OAUTH_CLIENT_NAME=ChatGPT
# 从当前 ChatGPT 连接管理界面复制完整 URI；多个精确 URI 用逗号分隔
MCP_OAUTH_REDIRECT_URIS=<exact-HTTPS-redirect-URI-from-ChatGPT>
# 空值 = public none。仅在确定使用 confidential client 后，通过受保护环境配置单独 secret。
MCP_OAUTH_CLIENT_SECRET=
MCP_OAUTH_ACCESS_TOKEN_SECONDS=3600
MCP_OAUTH_GRANT_SECONDS=2592000
MCP_OAUTH_CODE_SECONDS=120
```

尖括号值是说明，不能直接作为生产配置使用。缺少 required 值则启动拒绝。redirect 必须 HTTPS，无 wildcard、fragment 或 URL 账号密码；精确比对，不允许前缀匹配。OAuth 在生产中始终要求 HTTPS，即使普通同步服务允许内网 HTTP。开发仅允许 loopback HTTP issuer；测试客户端 redirect 仍为 HTTPS。

默认 access 1 小时、grant/refresh 最长 30 天、code 120 秒、登录/确认意图 10 分钟、原生 session 7 天。前三项可配置为正整数秒；上限分别 1 天、90 天、300 秒，grant 不短于 access。confirm 页面会说明配置的授权上限。ChatGPT 是否实际请求 offline_access 和正常续期需上线后观察；未请求时 token 过期需要重新授权。

本实现不需要生产 signing key。可选 client secret 与已有 ADMIN_PASSWORD、SYNC_TOKEN、READ_API_TOKEN 必须保存在受保护且不提交的环境配置中，不能写入示例、日志或 Git。应用请求日志只记录路径，不记录 query（授权码/state 等）；Authorization/Cookie/Set-Cookie 保持脱敏。上线前还要检查反向代理 access log：OAuth/token 路径不能记录 query、body 或认证头。

## 持久化、迁移与回滚

新增 `server/oauth-schema.sql`，启动时在原有 schema 后幂等执行（即使 OAuth 关闭，也创建空的 OAuth 表）。仅新增：

- mcp_oauth_grants：账号/客户端/资源/scopes、创建与绝对到期时间、撤销标记。
- mcp_oauth_codes：code 摘要、回调、S256 challenge、期限、消费标记。
- mcp_oauth_tokens：access/refresh 摘要、grant、scope、期限和 refresh 消费标记。
- mcp_oauth_interactions：浏览器意图摘要、CSRF 摘要、授权参数和期限。

没有修改活动、设备、原有 users/sessions 列，也不转移数据所有权。数据库权限至少需 CREATE TABLE/INDEX，以及这些表的 SELECT/INSERT/UPDATE/DELETE；迁移短暂 DDL 锁和重启会带来短暂服务中断风险。授权启用后错误的 owner/client/resource 配置会拒绝请求，不扩大读权限。

**以下为待确认上线操作，没有执行：**

1. 用现有备份策略确认数据库可恢复；空间不足时不要临时复制全量截图。确认原生 owner、客户端模式、精确回调和 HTTPS issuer。
2. 可在停止/切换应用窗口中手动执行该 SQL，或让新版本启动执行；若手工执行，应在受保护服务环境中使用数据库连接，不把连接字符串写入 shell 历史或工单。例如数据库容器中：`psql -U dayflow -d dayflow -v ON_ERROR_STOP=1 --single-transaction`，通过 stdin 输入 oauth-schema.sql。
3. 上线新应用并检查 metadata、401、原生登录/同步和固定 Bearer 回归。数据库与 app 重启不能丢弃持久卷。

优先回滚：设置 `MCP_OAUTH_ENABLED=false` 并重启当前应用，或恢复上一应用镜像。旧的原生网页登录、同步和固定 Bearer 继续工作。新表可以保留，旧代码不会读它们；不必删业务数据。如果关闭 OAuth 后再开启，未撤销/未到期授权仍可继续使用；若希望永久停用，应先显式撤销所有 grants。

若确需删除 OAuth 表，先停止 OAuth 应用，在确认不再保留授权的前提下，按 interactions → tokens → codes → grants 顺序 DROP。删除会不可逆丢失授权及重放记录；所有客户端需重新授权。该操作需要单独确认，本轮未做，也不建议以删除表作为普通回滚。

授权和 consumed refresh 摘要不是普通临时缓存，不能为省空间随意删除。expired interactions 会在 authorize 时清理；grant/code/token 不在请求路径中批量删除。后续如需定期清理，只能在 grant 绝对过期或明确撤销并确认保留策略后连同其子表清理，不能删仍有效 grant 的已消费 refresh 摘要。

## 撤销和密码重置

- 浏览器登录后打开 `/oauth/authorizations`，逐项撤销；POST 要求同一会话、Origin 和 CSRF 校验。页面显示最近 100 项授权。
- 客户端可按 RFC 7009 对 `/oauth/revoke` 发送 form-encoded token 和其客户端认证。access 或 refresh 撤销整个 grant；未知 token 返回 200，不泄露是否存在。
- 现有 `admin:password`/`scripts/reset-password.ts` 使用共同的事务函数：更新密码、删除该账号 sessions、撤销该账号所有 OAuth grants。未兑换 codes、access、refresh 都随之失效，其他账号不受影响。单纯改变环境密码不更新数据库密码。
- 密码重置仍针对 ADMIN_USERNAME。若 owner 与管理员不同，应在受保护环境中明确选择重置账号，不能误重置管理员或仅修改环境变量。本轮仅测试虚构账号重置，没有操作实际账号。
- 普通注销只撤销浏览器会话，不撤销已明确授予客户端的授权；客户端长期授权通过上述管理入口单独撤销。

## OAuth 错误排查

OAuth 错误响应包含 `error`、`error_description`、适用时的 `hint` 和 `request_id`，响应头同时提供 `X-Request-ID`。浏览器以 HTML 打开授权、登录或确认端点时，会显示相同信息的错误页；token/revoke 端点始终返回 JSON。无效回调仍在本地报错，不向未注册地址跳转。

例如 `invalid_request` 的详情会指出 `code_challenge_method: must be S256`、缺少 `state`，或 `resource` 应为 `PUBLIC_ORIGIN + /mcp`。`invalid_client` 会区分 Client ID 与回调地址不匹配。检查客户端请求与服务端配置后，从客户端重新发起授权。

启用应用日志时，按 `event=oauth_failure` 和 `request_id` 查找对应记录，可看到端点、状态码和安全错误说明。不会记录原始 query、请求正文、凭据或内部异常文本。500 错误只返回通用说明，应结合数据库与服务运行状态排查。反馈问题时提供错误代码、详情和请求编号，不要提供完整授权 URL、授权码、令牌或 Client Secret。

## 测试与本轮边界

`npm test` 和 `npm run test:ui` 都不加载 `.env`，会清除继承的数据库/认证配置，使用本机已有 PostgreSQL 工具创建 disposable cluster、仅监听临时 Unix socket，创建 dayflow_isolated_test 数据库。测试入口在连接前校验临时 URL/用户名/socket/标记，连接后复核 data_directory。原有集成测试也在这个实例中的随机 schema 运行。

UI 入口导入虚构活动和纯色 JPEG，启动 loopback app，使用已有 Google Chrome；回调由 Playwright 拦截，不访问外部测试客户端或 ChatGPT。测试结束停止 PostgreSQL/app，删除临时数据库、截图和浏览器中间产物。无需重复下载浏览器或创建环境/工作树。

覆盖原生登录与身份、登录授权/拒绝、S256 错误及缺失、非法客户端/回调/resource/scope、CSRF、非所有者与伪造身份、授权意图过期/重放、授权码并发消费、access/refresh 过期、显式撤销、刷新并发与重放撤销、应用实例重启后的 grant/code/token/session/interaction 持久化、public/confidential client、密码重置及 Cookie/SYNC_TOKEN/READ_API_TOKEN/OAuth token 的权限隔离。原有活动、截图、同步和 5 个只读工具回归使用虚构数据。

本轮通过：33 项服务端/配置测试、4 项桌面/手机浏览器测试、TypeScript noEmit、Vite 构建；桌面/手机确认页截图已作视觉检查。

本地 build 包含 TypeScript noEmit 和 Vite 构建。实际本机 Node 25、PostgreSQL 18；生产镜像为 Node 22/PostgreSQL 17，本轮未构建 Docker 镜像或测试生产运行时。应用实例关闭重建及全新 Node 进程查询验证持久化；未模拟数据库崩溃恢复或备份恢复。浏览器验证 loopback HTTP 表单流程，生产 TLS/反向代理和 ChatGPT OAuth 实际兼容性待验收。

## 待确认的部署与 ChatGPT 连接验收

1. 确认生产环境、Compose 文件名/镜像切换步骤和维护窗口；新建表和应用重启会修改线上数据库及服务，本轮没有执行权限。
2. 在 ChatGPT 当前自定义 MCP 管理界面确认可用客户端模式，MCP URL 填 `https://dayflow.neo7.cn/mcp`，选择 OAuth。选择预注册模式时配置相同 client_id；public client 无 secret，confidential client 必须匹配受保护 secret。若界面要求生成 ID/secret，先确认生产凭据创建，不要用示例凭据。
3. 复制界面显示的**完整** redirect URI 到配置。不依据文档例子猜一个稳定回调，不允许任何 https://chatgpt.com 前缀或 wildcard。当前代码返回 iss 并声明 issuer identification，但仍以实际界面展示为准。
4. 确认 scope 请求包括 dayflow:read；需要续期时检查 offline_access。客户端发送的 resource 应严格为 metadata 中的 `https://dayflow.neo7.cn/mcp`，不同值会安全失败，不能临时放宽 audience。
5. 完成上线后，检查 HTTPS 两份 metadata、无认证 401 challenge、登录/确认/拒绝和 token 交换；通过 ChatGPT Scan Tools 确认 5 个工具，再用虚构或明确授权的生产查询逐项验收。授权会向 ChatGPT/模型服务提供活动文字和截图，需用户明确创建连接和同意授权。
6. 验证 refresh 轮换、期限/重启后继续查询、浏览器撤销及客户端重新授权。记录结果时只保存状态码/工具名/时间，不记录码、token、secret 或活动内容。

**状态区分：本地测试结果见本轮交付；线上部署验收未做；ChatGPT 实际授权/工具调用未做。**
