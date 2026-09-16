# Dayflow for iOS

原生 SwiftUI 客户端，要求 iOS / iPadOS 26+、Xcode 26+。直接调用仓库现有 `/api/v1` API，无需更改服务器。

## 运行

1. 用 Xcode 打开 `ios/Dayflow.xcodeproj`，选择 `Dayflow` Scheme。
2. 选择 iPhone / iPad 模拟器并运行。真机运行时，在 Signing & Capabilities 中选择自己的开发团队，并按需修改 Bundle Identifier。
3. 输入服务器地址，使用 Web UI 的用户名和密码，或 `READ_API_TOKEN` 登录。

服务器地址示例为 `https://dayflow.example.com`。也支持输入以 `/api/v1` 结尾的地址以及反向代理的路径前缀。生产服务器使用 HTTPS；开发时允许 localhost、`.local` 和私有 IPv4 地址的 HTTP 连接。模拟器可访问 Mac 上的 `http://127.0.0.1:4310`；真机需要可访问的 HTTPS 地址或局域网地址，真机的 localhost 指向手机自身。

项目文件已经生成并提交，不需要安装第三方运行时依赖。修改 `project.yml` 后可用 XcodeGen 重新生成：

```sh
xcodegen generate --spec ios/project.yml
```

## 功能

- 时间线：日历、最近记录、前后日期、分类筛选、当天时长和活动数量、分页。
- 活动：完整摘要、详细记录、应用、源端删除状态、受保护截图及双指/双击缩放。
- 搜索：跨日期中文搜索，覆盖标题、摘要、详情和应用，可包含源端已删除记录。
- 回顾：原始日报的亮点、后续任务和阻碍；周记录时长、专注时长、分类分布。
- 设置：服务器、访问方式、设备、最近同步/采集、分析批次、时区、日界线及退出登录。
- 下拉刷新、前台每分钟更新、加载/空/错误状态、请求取消与过期响应隔离。

使用系统 Liquid Glass 标签栏、导航控件和玻璃操作按钮，内容保持简洁。支持深色模式、动态字体、VoiceOver、iPad 和横竖屏。日期标签以 API 日期为准，活动时间按源设备时区显示，周末日期按 API 的排他结束日期处理。

## 凭据

密码仅在登录时传输，不保存。会话 Cookie 或只读令牌存于 `WhenUnlockedThisDeviceOnly` 钥匙串；服务器地址与用户名存于 UserDefaults。网络使用独立 ephemeral URLSession，不共用 Cookie 或持久化截图缓存。鉴权信息不会跟随重定向。截图仅在当前账户的内存缓存中保存，退出时随账户状态释放。401 会回到登录；网络错误保留登录状态，允许重试。

账号退出会先撤销服务端会话，失败时显示错误并允许重试；只读令牌退出删除本机凭据。App 不调用同步写入接口，不修改 Dayflow 源数据。

## 验证

查看可用模拟器后，替换以下设备名称：

```sh
xcrun simctl list devices available
xcodebuild -project ios/Dayflow.xcodeproj -scheme Dayflow \
  -destination 'platform=iOS Simulator,name=iPhone 17e' \
  -derivedDataPath ios/build -parallel-testing-enabled NO \
  -collect-test-diagnostics never test CODE_SIGNING_ALLOWED=NO
```

单元测试覆盖 API URL、鉴权头、中文查询编码、日期/时区、日报字段兼容、分页和取消请求。UI 测试使用 `DEBUG` 专用 `URLProtocol` 测试数据，验证时间线、详情、截图、日报、周统计、搜索、设备和登录页，截图附于 Xcode 测试结果。测试数据不进入 Release，正常启动始终连接配置的服务器。

本机真实 API 联调使用相同的 Swift 数据模型和网络客户端。确保 API 服务已运行，再从仓库根目录执行：

```sh
node --env-file=.env scripts/test-ios-api.mjs
```

该脚本从环境读取凭据，不输出凭据或活动正文；测试结束撤销测试会话。可用 `DAYFLOW_TEST_SERVER` 指定服务地址。构建产物和测试截图位于 Git 忽略的 `ios/build/`。

App 图标为本地生成的 PNG，重建命令为 `swift ios/tools/make-icon.swift`。真机签名、App Store Connect 配置与分发证书需使用自己的 Apple 开发者账户。
