import SwiftUI

struct WorkspaceView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @State private var archive: ArchiveStore

    init(client: APIClient) { _archive = State(initialValue: ArchiveStore(client: client)) }

    var body: some View {
        TabView {
            Tab("时间线", systemImage: "clock") { TimelineView() }
            Tab("回顾", systemImage: "chart.bar.xaxis") { ReportsView() }
            Tab("设置", systemImage: "slider.horizontal.3") { SettingsView() }
            Tab("搜索", systemImage: "magnifyingglass", role: .search) { SearchView() }
        }
        .environment(archive)
        .task(id: archive.selectedDay) { await archive.load(session: session) }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            if archive.overview != nil { await archive.load(session: session); archive.refreshID += 1 }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                await archive.load(session: session)
                archive.refreshID += 1
            }
        }
    }
}

struct DayToolbar: ToolbarContent {
    @Environment(ArchiveStore.self) private var archive
    @Binding var showingDates: Bool
    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button("前一天", systemImage: "chevron.left") {
                archive.selectedDay = DayFormat.shift(archive.day, by: -1)
            }.disabled(archive.day.isEmpty || archive.loading)
            Button("选择日期", systemImage: "calendar") { showingDates = true }
                .accessibilityIdentifier("choose-date")
            Button("后一天", systemImage: "chevron.right") {
                archive.selectedDay = DayFormat.shift(archive.day, by: 1)
            }.disabled(archive.day.isEmpty || archive.day >= (archive.overview?.today ?? archive.day) || archive.loading)
        }
    }
}

struct DayPicker: View {
    @Environment(ArchiveStore.self) private var archive
    @Environment(\.dismiss) private var dismiss
    @State private var picked = Date()
    var body: some View {
        NavigationStack {
            List {
                DatePicker("日期", selection: $picked,
                    in: ...DayFormat.date(archive.overview?.today ?? DayFormat.key(Date())), displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
                    .onChange(of: picked) { _, date in
                        let next = DayFormat.key(date)
                        if next != archive.day { archive.selectedDay = next; dismiss() }
                    }
                Section("最近记录") {
                    ForEach(archive.overview?.availableDays ?? [], id: \.self) { day in
                        Button {
                            archive.selectedDay = day
                            dismiss()
                        } label: {
                            HStack {
                                Text(DayFormat.label(day, pattern: "yyyy年M月d日 EEEE"))
                                Spacer()
                                if day == archive.day { Image(systemName: "checkmark") }
                            }
                        }
                    }
                }
            }
            .navigationTitle("选择日期").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .onAppear { picked = DayFormat.date(archive.day.isEmpty ? DayFormat.key(Date()) : archive.day) }
        }.presentationDetents([.large])
    }
}

struct TimelineView: View {
    @Environment(ArchiveStore.self) private var archive
    @Environment(SessionStore.self) private var session
    @State private var category = ""
    @State private var showingDates = false
    @State private var activities = ActivityStore()
    private var filter: ActivityFilter {
        ActivityFilter(day: archive.day, category: category, refreshID: archive.refreshID)
    }

    var body: some View {
        NavigationStack {
            List {
                if let overview = archive.overview {
                    Section {
                        VStack(alignment: .leading, spacing: 22) {
                            HStack {
                                Text(DayFormat.label(overview.date, pattern: "yyyy年 · EEEE"))
                                Spacer()
                                if overview.date == overview.today { Text("今天").foregroundStyle(Theme.accent) }
                            }.font(.subheadline).foregroundStyle(.secondary)
                            HStack(alignment: .top, spacing: 16) {
                                Metric(label: "记录时长", value: DayFormat.duration(overview.minutes))
                                Metric(label: "活动", value: "\(overview.count) 条")
                                Metric(label: "分类", value: "\(overview.totals.count) 类")
                            }
                            if overview.minutes > 0 {
                                GeometryReader { proxy in
                                    HStack(spacing: 2) {
                                        ForEach(overview.totals) { item in
                                            Theme.color(item.category, in: overview)
                                                .frame(width: max(0, proxy.size.width - CGFloat(max(overview.totals.count - 1, 0)) * 2) * item.minutes / overview.minutes)
                                        }
                                    }.clipShape(Capsule())
                                }.frame(height: 5).accessibilityLabel("当天分类时间分布")
                            }
                        }.padding(.vertical, 12)
                    }.listRowSeparator(.hidden)
                }
                if let error = archive.error {
                    FailureView(message: error) { Task { await archive.load(session: session) } }
                }
                if archive.loading && archive.overview == nil { ProgressView("正在加载") }
                if !archive.day.isEmpty {
                    Section {
                        ActivityListContent(store: activities)
                    } header: {
                        HStack { Text("活动记录"); Spacer(); CategoryPicker(overview: archive.overview, selection: $category) }
                            .textCase(nil)
                    }
                }
            }
            .listStyle(.plain)
            .task(id: filter) {
                guard !filter.day.isEmpty else { return }
                await activities.reset(filter, client: archive.client, session: session, debounce: false)
            }
            .navigationTitle(archive.day.isEmpty ? "Dayflow" : DayFormat.label(archive.day))
            .toolbar { DayToolbar(showingDates: $showingDates) }
            .sheet(isPresented: $showingDates) { DayPicker() }
            .refreshable { await archive.load(session: session); archive.refreshID += 1 }
            .navigationDestination(for: Activity.self) { ActivityDetailView(initial: $0) }
        }
    }
}

struct SearchView: View {
    @Environment(ArchiveStore.self) private var archive
    @Environment(SessionStore.self) private var session
    @State private var query = ""
    @State private var category = ""
    @State private var includeDeleted = true
    @State private var refreshID = 0
    @State private var activities = ActivityStore()
    private var filter: ActivityFilter {
        ActivityFilter(query: query, category: category, includeDeleted: includeDeleted,
                       refreshID: archive.refreshID + refreshID)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle("包含源端已删除", isOn: $includeDeleted).font(.subheadline)
                    HStack { Text("分类"); Spacer(); CategoryPicker(overview: archive.overview, selection: $category) }
                }
                Section {
                    ActivityListContent(store: activities, isSearch: true)
                }
            }
            .listStyle(.plain)
            .navigationTitle("搜索活动")
            .task(id: filter) {
                await activities.reset(filter, client: archive.client, session: session, debounce: true)
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "标题、详情或应用")
            .onChange(of: query) { _, value in if value.count > 500 { query = String(value.prefix(500)) } }
            .refreshable { refreshID += 1 }
            .navigationDestination(for: Activity.self) { ActivityDetailView(initial: $0) }
        }
    }
}
