import SwiftUI

@main
struct DayflowApp: App {
    @State private var session = SessionStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ZStack {
                if session.restoring {
                    ProgressView("正在连接").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let client = session.client {
                    WorkspaceView(client: client).id(ObjectIdentifier(client))
                } else {
                    LoginView()
                }
                if scenePhase == .background {
                    Color(uiColor: .systemBackground).ignoresSafeArea()
                    Label("Dayflow", systemImage: "sun.max").font(.title2)
                }
            }
            .tint(Theme.accent)
            .environment(session)
            .task {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
                    session.client = PreviewTransport.client()
                    session.restoring = false
                    return
                }
                if ProcessInfo.processInfo.arguments.contains("--ui-login") {
                    session.restoring = false
                    return
                }
                #endif
                await session.restore()
            }
        }
    }
}

struct LoginView: View {
    @Environment(SessionStore.self) private var session
    @State private var useToken = false
    @State private var password = ""
    @State private var token = ""

    var body: some View {
        @Bindable var session = session
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "sun.max.fill").font(.system(size: 38)).foregroundStyle(Theme.accent)
                        Text("Dayflow").font(.largeTitle.bold())
                        Text("个人活动档案").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 20)
                    .listRowBackground(Color.clear)
                }
                Section("服务器") {
                    TextField("https://dayflow.example.com", text: $session.serverText)
                        .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never)
                        .autocorrectionDisabled().accessibilityLabel("服务器地址")
                        .accessibilityIdentifier("server-address")
                }
                Section {
                    Picker("登录方式", selection: $useToken) {
                        Text("账号").tag(false)
                        Text("API 令牌").tag(true)
                    }.pickerStyle(.segmented)
                    if useToken {
                        SecureField("只读 API 令牌", text: $token)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    } else {
                        TextField("用户名", text: $session.username).textContentType(.username)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("密码", text: $password).textContentType(.password)
                    }
                }
                if let error = session.error {
                    Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("login-error") }
                }
                Section {
                    Button {
                        Task { await session.connect(password: password, token: token, useToken: useToken) }
                    } label: {
                        HStack {
                            Spacer()
                            if session.busy { ProgressView() }
                            else { Label("登录", systemImage: "arrow.right") }
                            Spacer()
                        }.padding(.vertical, 6)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(session.busy || session.serverText.isEmpty || (useToken ? token.isEmpty : password.isEmpty || session.username.isEmpty))
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("connect")
                    if session.canRestore {
                        Button("重新连接已保存的账户", systemImage: "arrow.clockwise") {
                            Task { await session.restore() }
                        }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("登录个人空间").navigationBarTitleDisplayMode(.inline)
        }
    }
}
