import SwiftUI

enum Theme {
    static let accent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.37, green: 0.80, blue: 0.71, alpha: 1)
            : UIColor(red: 0.08, green: 0.48, blue: 0.43, alpha: 1)
    })
    static func color(_ name: String, in overview: Overview?) -> Color {
        guard let hex = overview?.categories.first(where: { $0.name == name })?.colorHex,
              let value = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) else { return .secondary }
        return Color(red: Double((value >> 16) & 255) / 255,
                     green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }
}

struct FailureView: View {
    let message: String
    let retry: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message, systemImage: "exclamationmark.circle").foregroundStyle(.red)
            Button("重试", systemImage: "arrow.clockwise", action: retry)
        }.font(.subheadline).padding(.vertical, 6)
    }
}

struct Metric: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct CategoryPicker: View {
    let overview: Overview?
    @Binding var selection: String
    var body: some View {
        Menu {
            Picker("分类", selection: $selection) {
                Text("全部分类").tag("")
                ForEach(overview?.categories ?? []) { category in
                    Text(category.name).tag(category.name)
                }
            }
        } label: {
            Label(selection.isEmpty ? "全部分类" : selection, systemImage: "line.3.horizontal.decrease")
                .font(.subheadline)
        }.accessibilityLabel("筛选分类").accessibilityIdentifier("category-filter")
    }
}
