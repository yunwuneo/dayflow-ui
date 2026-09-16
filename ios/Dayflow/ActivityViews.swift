import SwiftUI

struct ActivityListContent: View {
    @Environment(ArchiveStore.self) private var archive
    @Environment(SessionStore.self) private var session
    let store: ActivityStore
    var isSearch = false

    var body: some View {
        Group {
            Text(isSearch ? "\(store.total) 条结果" : "共 \(store.total) 条")
                .font(.caption).foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
            ForEach(store.items) { item in
                NavigationLink(value: item) {
                    ActivityRow(item: item, showDay: isSearch)
                }.accessibilityIdentifier("activity-\(item.recordId)")
            }
            if let error = store.error {
                FailureView(message: error) { Task { await store.next(client: archive.client, session: session) } }
            }
            if store.loading { HStack { Spacer(); ProgressView("正在加载"); Spacer() }.padding() }
            if !store.loading && store.items.isEmpty && store.error == nil {
                ContentUnavailableView(isSearch ? "没有找到匹配的活动" : "当天暂无活动记录",
                    systemImage: isSearch ? "magnifyingglass" : "calendar")
            }
            if !store.loading && store.items.count < store.total && store.error == nil {
                Button {
                    Task { await store.next(client: archive.client, session: session) }
                } label: {
                    HStack {
                        Text("加载更多")
                        Spacer()
                        Text("\(store.items.count) / \(store.total)").foregroundStyle(.secondary)
                        Image(systemName: "arrow.down")
                    }
                }.accessibilityIdentifier("load-more")
            }
        }
    }
}

struct ActivityRow: View {
    @Environment(ArchiveStore.self) private var archive
    @Environment(\.dynamicTypeSize) private var typeSize
    let item: Activity
    let showDay: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Circle().fill(Theme.color(item.category, in: archive.overview)).frame(width: 6, height: 6)
                Text(item.category).lineLimit(1)
                Spacer(minLength: 4)
                Text(DayFormat.duration(item.durationMinutes)).fixedSize()
            }.font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(item.title).font(.headline).foregroundStyle(.primary).lineLimit(3)
                    if !item.summary.isEmpty {
                        Text(item.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if item.hasScreenshot && !typeSize.isAccessibilitySize {
                    ScreenshotView(item: item, mode: .thumbnail)
                        .frame(width: 76, height: 58).clipShape(RoundedRectangle(cornerRadius: 6))
                        .accessibilityHidden(true)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack { metadata; Spacer(minLength: 6); apps }
                VStack(alignment: .leading, spacing: 4) { metadata; apps }
            }.font(.caption).foregroundStyle(.secondary)
            if item.sourceDeleted {
                Label("源端已删除", systemImage: "archivebox").font(.caption2).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 12)
    }

    private var metadata: some View {
        Text((showDay ? "\(DayFormat.label(item.day)) · " : "")
             + "\(DayFormat.time(item.start, zone: archive.zone)) – \(DayFormat.time(item.end, zone: archive.zone))")
            .monospacedDigit()
    }
    private var apps: some View { Text(item.apps.prefix(2).joined(separator: " · ")).lineLimit(1) }
}

struct ActivityDetailView: View {
    @Environment(ArchiveStore.self) private var archive
    @Environment(SessionStore.self) private var session
    let initial: Activity
    @State private var updated: Activity?
    @State private var error: String?
    @State private var imageOpen = false
    private var item: Activity { updated ?? initial }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    Label(item.category + (item.subcategory.isEmpty ? "" : " · \(item.subcategory)"), systemImage: "circle.fill")
                        .font(.subheadline).foregroundStyle(Theme.color(item.category, in: archive.overview))
                    Text(item.title).font(.title2.bold()).textSelection(.enabled)
                    Text("\(DayFormat.label(item.day, pattern: "yyyy年M月d日")) · \(DayFormat.time(item.start, zone: archive.zone)) – \(DayFormat.time(item.end, zone: archive.zone))")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text(DayFormat.duration(item.durationMinutes)).font(.subheadline).foregroundStyle(.secondary)
                    if item.sourceDeleted { Label("源端已删除", systemImage: "archivebox").font(.caption).foregroundStyle(.secondary) }
                }
                if let error { FailureView(message: error) { Task { await load() } } }
                Button { imageOpen = true } label: {
                    ScreenshotView(item: item, mode: .detail)
                        .frame(maxWidth: .infinity).aspectRatio(16 / 10, contentMode: .fit)
                        .clipped().clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .bottomTrailing) {
                            if item.hasScreenshot {
                                Image(systemName: "arrow.up.left.and.arrow.down.right")
                                    .padding(10).glassEffect().padding(10)
                            }
                        }
                }.buttonStyle(.plain).disabled(!item.hasScreenshot).accessibilityLabel("放大截图")
                writeup("活动摘要", text: item.summary.isEmpty ? "暂无摘要" : item.summary)
                if !item.detailedSummary.isEmpty { writeup("详细记录", text: item.detailedSummary) }
                if !item.apps.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("相关应用").font(.headline)
                        ForEach(Array(item.apps.enumerated()), id: \.offset) { _, app in
                            Label(app, systemImage: "app").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                Text("记录 #\(item.recordId)").font(.caption).foregroundStyle(.tertiary)
            }.padding(20).frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
        }
        .navigationTitle("活动详情").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .fullScreenCover(isPresented: $imageOpen) { ScreenshotFullscreen(item: item) }
    }

    private func writeup(_ title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            Text(text).font(.body).foregroundStyle(.secondary).lineSpacing(5).textSelection(.enabled)
        }
    }

    private func load() async {
        do {
            let result: Activity = try await archive.client.get("activities/\(initial.id)")
            try Task.checkCancellation()
            updated = result
            error = nil
        } catch {
            guard !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
            self.error = error.localizedDescription
            session.handle(error)
        }
    }
}

struct ScreenshotView: View {
    enum Mode { case thumbnail, detail, fullscreen }
    @Environment(ArchiveStore.self) private var archive
    @Environment(SessionStore.self) private var session
    let item: Activity
    let mode: Mode
    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        ZStack {
            Color(uiColor: .secondarySystemBackground)
            if let image {
                if mode == .fullscreen { ZoomableImage(image: image) }
                else { Image(uiImage: image).resizable().aspectRatio(contentMode: mode == .thumbnail ? .fill : .fit) }
            } else if !item.hasScreenshot || failed {
                VStack(spacing: 10) {
                    Image(systemName: "photo")
                    if mode != .thumbnail {
                        Text(failed ? "截图不可用" : "暂无截图").font(.caption)
                        if failed && mode == .fullscreen { Button("重试", systemImage: "arrow.clockwise") { attempt += 1 } }
                    }
                }.foregroundStyle(.secondary)
            } else { ProgressView() }
        }
        .task(id: "\(item.id)-\(attempt)") {
            guard item.hasScreenshot else { return }
            failed = false
            do {
                if let cached = archive.images.object(forKey: item.id as NSString) { image = cached; return }
                let (data, _) = try await archive.client.data("activities/\(item.id)/screenshot")
                try Task.checkCancellation()
                guard let decoded = UIImage(data: data) else { throw APIError.invalidResponse }
                archive.images.setObject(decoded, forKey: item.id as NSString, cost: Int(decoded.size.width * decoded.size.height * 4))
                image = decoded
            } catch {
                guard !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
                failed = true
                if let failure = error as? APIError, failure.unauthorized { session.handle(error) }
            }
        }
    }
}

struct ScreenshotFullscreen: View {
    @Environment(\.dismiss) private var dismiss
    let item: Activity
    var body: some View {
        NavigationStack {
            ScreenshotView(item: item, mode: .fullscreen)
                .navigationTitle("活动截图").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("关闭大图", systemImage: "xmark") { dismiss() }.accessibilityIdentifier("close-image")
                    }
                }
        }
    }
}

// UIScrollView provides bounded pinch/pan and double-tap zoom with native accessibility.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    func makeUIView(context: Context) -> ImageScrollView {
        let view = ImageScrollView()
        view.imageView.image = image
        return view
    }
    func updateUIView(_ uiView: ImageScrollView, context: Context) { uiView.imageView.image = image }

    final class ImageScrollView: UIScrollView, UIScrollViewDelegate {
        let imageView = UIImageView()
        private var previousSize = CGSize.zero
        override init(frame: CGRect) {
            super.init(frame: frame)
            delegate = self
            minimumZoomScale = 1
            maximumZoomScale = 5
            showsHorizontalScrollIndicator = false
            showsVerticalScrollIndicator = false
            imageView.contentMode = .scaleAspectFit
            imageView.accessibilityLabel = "活动截图"
            imageView.isAccessibilityElement = true
            addSubview(imageView)
            let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
            doubleTap.numberOfTapsRequired = 2
            addGestureRecognizer(doubleTap)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func layoutSubviews() {
            super.layoutSubviews()
            if bounds.size != previousSize {
                previousSize = bounds.size
                setZoomScale(1, animated: false)
                imageView.frame = CGRect(origin: .zero, size: bounds.size)
                contentSize = bounds.size
            }
        }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        @objc private func toggleZoom(_ recognizer: UITapGestureRecognizer) {
            if zoomScale > 1 { setZoomScale(1, animated: true) }
            else {
                let point = recognizer.location(in: imageView)
                let size = CGSize(width: bounds.width / 2.5, height: bounds.height / 2.5)
                zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}
