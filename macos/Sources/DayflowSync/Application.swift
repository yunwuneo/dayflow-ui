import SwiftUI
import ServiceManagement

@MainActor
final class AppModel: ObservableObject {
    @Published var settings: Settings
    @Published var token = ""
    @Published var syncing = false
    @Published var message = "尚未同步"
    @Published var error: String?
    @Published var report: SyncReport?
    @Published var nextSync: Date?
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled
    private let engine = SyncEngine()
    private var timer: Timer?
    private var task: Task<Void, Never>?

    init() {
        settings = (try? Settings.load()) ?? Settings()
        do { token = try Keychain.read() } catch { self.error = error.localizedDescription }
        if let data = try? Data(contentsOf: Settings.directory.appendingPathComponent("last-sync.json")) {
            let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
            report = try? decoder.decode(SyncReport.self, from: data)
            if report != nil { message = "已同步" }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        nextSync = Date().addingTimeInterval(5)
    }
    func tick() {
        guard !settings.paused, !syncing, !token.isEmpty, let nextSync, nextSync <= Date() else { return }
        synchronize()
    }
    func save(configuration: Settings, credential: String) {
        do {
            _ = try configuration.validatedURL()
            guard credential.count >= 32 else { throw SyncFailure("设备令牌至少需要 32 个字符") }
            try Keychain.save(credential)
            try configuration.save()
            settings = configuration; token = credential
            error = nil; nextSync = Date()
        } catch { self.error = error.localizedDescription }
    }
    func setPaused(_ paused: Bool) {
        settings.paused = paused
        do { try settings.save() } catch { self.error = error.localizedDescription }
        if paused { task?.cancel(); message = "同步已暂停" } else { nextSync = Date(); tick() }
    }
    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            launchAtLogin = SMAppService.mainApp.status == .enabled
            if enabled && !launchAtLogin { error = "请在系统设置的登录项中允许 Dayflow Sync" }
        } catch { self.error = error.localizedDescription; launchAtLogin = SMAppService.mainApp.status == .enabled }
    }
    func synchronize() {
        guard !syncing else { return }
        syncing = true; error = nil; message = "准备同步"
        let configuration = settings; let credential = token
        task = Task { [self] in
            do {
                let result = try await engine.run(settings: configuration, token: credential, stateDirectory: Settings.directory) { [weak self] text in
                    Task { @MainActor in self?.message = text }
                }
                report = result
                message = result.missingScreenshots > 0 ? "已同步，\(result.missingScreenshots) 条截图待补齐" : "同步完成"
                nextSync = Date().addingTimeInterval(Double(configuration.intervalMinutes) * 60)
            } catch is CancellationError {
                message = "同步已暂停"
            } catch {
                if Task.isCancelled { message = "同步已暂停" }
                else { self.error = error.localizedDescription; message = "同步失败" }
                nextSync = Date().addingTimeInterval(5 * 60)
            }
            syncing = false
        }
    }
}

struct SyncApplication: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        MenuBarExtra {
            VStack(alignment: .leading, spacing: 13) {
                HStack {
                    Image(systemName: "sun.max.fill").foregroundStyle(.green)
                    Text("Dayflow Sync").font(.headline)
                    Spacer()
                    if model.syncing { ProgressView().controlSize(.small) }
                }
                Text(model.message).font(.callout).foregroundStyle(.secondary)
                if let report = model.report {
                    LabeledContent("最近同步", value: report.completedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption)
                    Text("更新 \(report.changedActivities) 条活动 · 上传 \(report.uploadedScreenshots) 张截图").font(.caption).foregroundStyle(.secondary)
                }
                if !model.settings.paused, let next = model.nextSync, !model.syncing {
                    LabeledContent("下次同步", value: next.formatted(date: .omitted, time: .shortened)).font(.caption)
                }
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
                Divider()
                Button { model.synchronize() } label: { Label("立即同步", systemImage: "arrow.triangle.2.circlepath") }
                    .disabled(model.syncing || model.settings.paused || model.token.isEmpty)
                Toggle("暂停同步", isOn: Binding(get: { model.settings.paused }, set: model.setPaused))
                Button { if let url = try? model.settings.validatedURL() { NSWorkspace.shared.open(url) } } label: { Label("打开网页", systemImage: "globe") }
                SettingsLink { Label("设置…", systemImage: "gearshape") }
                Divider()
                Button("退出 Dayflow Sync") { NSApp.terminate(nil) }
            }.padding(18).frame(width: 320).buttonStyle(.borderless)
        } label: {
            Image(systemName: model.syncing ? "arrow.triangle.2.circlepath" : model.settings.paused ? "pause.circle" : model.error != nil ? "exclamationmark.icloud" : "sun.max")
        }.menuBarExtraStyle(.window)
        SwiftUI.Settings { SettingsView(model: model) }
    }
}

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var saved = false
    @State private var draft = Settings()
    @State private var draftToken = ""
    var body: some View {
        Form {
            Section("服务器") {
                TextField("服务器地址", text: $draft.serverURL)
                SecureField("设备令牌", text: $draftToken)
                TextField("设备名称", text: $draft.deviceName)
            }
            Section("本机 Dayflow") {
                TextField("CLI 路径", text: $draft.cliPath)
                TextField("数据库路径", text: $draft.databasePath)
            }
            Section("同步") {
                Stepper("每 \(draft.intervalMinutes) 分钟同步", value: $draft.intervalMinutes, in: 5...1440, step: 5)
                Toggle("暂停同步", isOn: Binding(get: { model.settings.paused }, set: model.setPaused))
                Toggle("开机启动", isOn: Binding(get: { model.launchAtLogin }, set: model.setLaunchAtLogin))
            }
            if let error = model.error { Text(error).foregroundStyle(.red).font(.caption) }
            HStack {
                if saved { Label("设置已保存", systemImage: "checkmark.circle").foregroundStyle(.green).font(.caption) }
                Spacer()
                Button("保存设置") { draft.paused = model.settings.paused; model.save(configuration: draft, credential: draftToken); saved = model.error == nil }.buttonStyle(.borderedProminent).disabled(model.syncing)
            }
        }.formStyle(.grouped).padding(12).frame(width: 590, height: 470)
            .onAppear { draft = model.settings; draftToken = model.token; saved = false }
    }
}

@main
enum Entrypoint {
    @MainActor
    static func main() async {
        let arguments = CommandLine.arguments
        if arguments.contains("--inspect") || arguments.contains("--sync-once") || arguments.contains("--configure") {
            do {
                func argument(_ key: String) -> String? {
                    guard let index = arguments.firstIndex(of: key), index + 1 < arguments.count else { return nil }
                    return arguments[index + 1]
                }
                let settingsURL = argument("--config").map { URL(fileURLWithPath: $0) } ?? Settings.file
                let settings = try Settings.load(from: settingsURL)
                if arguments.contains("--configure") {
                    _ = try settings.validatedURL()
                    guard let variable = argument("--token-env"), let token = ProcessInfo.processInfo.environment[variable], token.count >= 32 else {
                        throw SyncFailure("配置客户端需要通过 --token-env 提供设备令牌")
                    }
                    try Keychain.save(token)
                    try settings.save()
                    print("客户端设置已保存，设备令牌已存入钥匙串")
                } else if arguments.contains("--inspect") {
                    let snapshot = try SourceDatabase(path: settings.databasePath).snapshot()
                    print(String(data: try encodeJSON(["active_activities": snapshot.activeIDs.count, "days": snapshot.days.keys.sorted(), "daily_count": snapshot.dailyHashes.count]), encoding: .utf8)!)
                } else {
                    let token = try argument("--token-env").flatMap { ProcessInfo.processInfo.environment[$0] } ?? Keychain.read()
                    let directory = argument("--state-dir").map { URL(fileURLWithPath: $0) } ?? Settings.directory
                    let report = try await SyncEngine().run(settings: settings, token: token, stateDirectory: directory) { text in
                        FileHandle.standardError.write(Data((text + "\n").utf8))
                    }
                    let encoder = JSONEncoder(); encoder.outputFormatting = .prettyPrinted; encoder.dateEncodingStrategy = .iso8601
                    print(String(data: try encoder.encode(report), encoding: .utf8)!)
                }
            } catch {
                FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1)
            }
        } else {
            SyncApplication.main()
        }
    }
}
