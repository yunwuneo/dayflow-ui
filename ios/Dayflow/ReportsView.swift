import SwiftUI
import Charts

struct ReportsView: View {
    @Environment(ArchiveStore.self) private var archive
    @Environment(SessionStore.self) private var session
    @State private var weekly = false
    @State private var showingDates = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("回顾范围", selection: $weekly) {
                        Text("日报").tag(false)
                        Text("周统计").tag(true)
                    }.pickerStyle(.segmented).listRowSeparator(.hidden)
                    if !archive.day.isEmpty {
                        Text(DayFormat.label(archive.day, pattern: "yyyy年M月d日 EEEE"))
                            .font(.subheadline).foregroundStyle(.secondary).listRowSeparator(.hidden)
                    }
                }
                if let error = archive.error {
                    FailureView(message: error) { Task { await archive.load(session: session) } }
                }
                if archive.loading && archive.overview == nil { ProgressView("正在加载") }
                else if weekly {
                    if let data = archive.overview?.weekly { WeeklyContent(data: data) }
                    else if archive.error == nil { ContentUnavailableView("本周暂无统计", systemImage: "chart.bar.xaxis") }
                } else {
                    if let data = archive.overview?.daily {
                        dailySection("工作亮点", symbol: "sparkle", color: Theme.accent, items: data.highlights, empty: "暂无工作亮点")
                        dailySection("后续任务", symbol: "square", color: .blue, items: data.tasks, empty: "暂无后续任务")
                        dailySection("阻碍与待解决", symbol: "exclamationmark.circle", color: .orange, items: data.blockers, empty: "暂无阻碍")
                    } else if archive.error == nil { ContentUnavailableView("当天暂无日报", systemImage: "doc.text") }
                }
            }
            .listStyle(.plain)
            .navigationTitle(weekly ? "本周时间分配" : "每日回顾")
            .toolbar { DayToolbar(showingDates: $showingDates) }
            .sheet(isPresented: $showingDates) { DayPicker() }
            .refreshable { await archive.load(session: session) }
        }
    }

    private func dailySection(_ title: String, symbol: String, color: Color, items: [String], empty: String) -> some View {
        Section {
            if items.isEmpty { Text(empty).foregroundStyle(.secondary) }
            ForEach(Array(items.enumerated()), id: \.offset) { _, text in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: symbol).foregroundStyle(color).frame(width: 20).padding(.top, 3)
                    Text(text).lineSpacing(5).textSelection(.enabled)
                }.padding(.vertical, 10)
            }
        } header: { Text(title).font(.headline).foregroundStyle(.primary).textCase(nil).padding(.vertical, 8) }
    }
}

struct WeeklyContent: View {
    @Environment(ArchiveStore.self) private var archive
    let data: Weekly
    var body: some View {
        Section {
            Text("\(DayFormat.label(data.weekStart)) – \(DayFormat.label(DayFormat.shift(String(data.weekEnd.prefix(10)), by: -1)))")
                .font(.subheadline).foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 24) {
                Metric(label: "记录时长", value: DayFormat.duration(data.trackedMinutes))
                Metric(label: "专注时长", value: DayFormat.duration(data.focusMinutes))
            }.padding(.vertical, 16)
            if data.categories.contains(where: { $0.minutes > 0 }) {
                Chart(data.categories) { category in
                    SectorMark(angle: .value("分钟", max(0, category.minutes)), innerRadius: .ratio(0.76), angularInset: 2)
                        .foregroundStyle(Theme.color(category.name, in: archive.overview))
                        .accessibilityLabel(category.name)
                        .accessibilityValue(DayFormat.duration(category.minutes))
                }
                .chartLegend(.hidden)
                .frame(height: 210)
                .chartBackground { _ in
                    VStack(spacing: 6) {
                        Text("本周记录").font(.caption).foregroundStyle(.secondary)
                        Text(DayFormat.duration(data.trackedMinutes)).font(.headline)
                    }.frame(maxWidth: 150)
                }
                .padding(.vertical, 12)
            }
        }.listRowSeparator(.hidden)
        Section("分类分布") {
            ForEach(data.categories) { category in
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Circle().fill(Theme.color(category.name, in: archive.overview)).frame(width: 8, height: 8)
                        Text(category.name)
                        Spacer()
                        Text("\(Int((category.share * 100).rounded()))%").foregroundStyle(.secondary).monospacedDigit()
                    }
                    ProgressView(value: min(1, max(0, category.share)))
                        .tint(Theme.color(category.name, in: archive.overview))
                    Text(DayFormat.duration(category.minutes)).font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 10)
            }
        }
    }
}

struct SettingsView: View {
    @Environment(ArchiveStore.self) private var archive
    @Environment(SessionStore.self) private var session
    @State private var confirmLogout = false

    var body: some View {
        NavigationStack {
            List {
                Section("个人档案") {
                    LabeledContent("账户", value: archive.client.credential?.username ?? "只读访问")
                    LabeledContent("服务器", value: archive.client.server.absoluteString)
                    LabeledContent("访问方式", value: archive.client.credential?.kind == .cookie ? "账号登录" : "只读 API")
                }
                if let error = archive.error {
                    FailureView(message: error) { Task { await archive.load(session: session) } }
                }
                if let overview = archive.overview {
                    if overview.devices.isEmpty {
                        ContentUnavailableView("等待客户端首次同步", systemImage: "icloud.slash")
                    }
                    ForEach(overview.devices) { device in
                        Section {
                            Label(device.name, systemImage: "desktopcomputer").font(.headline).padding(.vertical, 6)
                            LabeledContent("最近同步", value: DayFormat.time(device.lastSyncAt, zone: device.timeZone, full: true))
                            LabeledContent("最近采集", value: DayFormat.time(device.status.lastCaptureAt, zone: device.timeZone, full: true))
                            LabeledContent("等待分析", value: "\(device.status.pendingBatches ?? 0) 批次")
                            LabeledContent("分析失败", value: "\(device.status.failedBatches ?? 0) 批次")
                            LabeledContent("已确认同步批次", value: String(device.revision))
                            LabeledContent("时区", value: device.timeZone)
                            LabeledContent("日期分界", value: String(format: "%02d:00", overview.dayBoundaryHour))
                            VStack(alignment: .leading, spacing: 8) {
                                Text("设备 ID")
                                Text(device.id).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        } header: { Text("同步状态") }
                    }
                } else if archive.loading { ProgressView("正在加载设备状态") }
                Section {
                    if let error = session.error, error != archive.error { Text(error).foregroundStyle(.red) }
                    Button(role: .destructive) { confirmLogout = true } label: {
                        Label(session.busy ? "正在退出" : "退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                    }.disabled(session.busy).accessibilityIdentifier("sign-out")
                }
            }
            .navigationTitle("设置")
            .refreshable { await archive.load(session: session) }
            .confirmationDialog("退出当前账户？", isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("退出登录", role: .destructive) { Task { await session.signOut() } }
            }
        }
    }
}
