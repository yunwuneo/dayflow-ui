import Foundation

struct Activity: Decodable, Identifiable, Hashable, Sendable {
    let recordId: Int64
    let deviceId: String
    let day: String
    let title: String
    let summary: String
    let detailedSummary: String
    let category: String
    let subcategory: String
    let start: String
    let end: String
    let durationMinutes: Double
    let apps: [String]
    let sourceDeleted: Bool
    let hasScreenshot: Bool
    var id: String { "\(deviceId)/\(recordId)" }
}

struct ActivityPage: Decodable, Sendable {
    let activities: [Activity]
    let total: Int
    let page: Int
    let limit: Int
}

struct Overview: Decodable, Sendable {
    let date: String
    let today: String
    let timeZone: String
    let dayBoundaryHour: Int
    let availableDays: [String]
    let categories: [Category]
    let totals: [CategoryTotal]
    let devices: [Device]
    let daily: Daily?
    let weekly: Weekly?
    var minutes: Double { totals.reduce(0) { $0 + $1.minutes } }
    var count: Int { totals.reduce(0) { $0 + $1.count } }
}

struct Category: Decodable, Identifiable, Sendable {
    let name: String
    let colorHex: String
    let isIdle: Bool
    let isSystem: Bool
    var id: String { name }
}

struct CategoryTotal: Decodable, Identifiable, Sendable {
    let category: String
    let minutes: Double
    let count: Int
    var id: String { category }
}

struct Device: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let lastSyncAt: String?
    let timeZone: String
    let revision: Int
    let status: Status
    struct Status: Decodable, Sendable {
        let lastCaptureAt: String?
        let pendingBatches: Int?
        let failedBatches: Int?
    }
}

struct Daily: Decodable, Sendable {
    let highlights: [String]
    let tasks: [String]
    let blockers: [String]

    private enum CodingKeys: String, CodingKey { case highlights, tasks, blockers }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        highlights = try values.decodeIfPresent([String].self, forKey: .highlights) ?? []
        tasks = try values.decodeIfPresent([String].self, forKey: .tasks) ?? []
        if let list = try? values.decode([String].self, forKey: .blockers) {
            blockers = list
        } else {
            let text = try values.decodeIfPresent(String.self, forKey: .blockers) ?? ""
            blockers = text.isEmpty ? [] : [text]
        }
    }
}

struct Weekly: Decodable, Sendable {
    let trackedMinutes: Double
    let focusMinutes: Double
    let weekStart: String
    let weekEnd: String
    let categories: [Share]
    struct Share: Decodable, Identifiable, Sendable {
        let name: String
        let minutes: Double
        let share: Double
        var id: String { name }
    }
}

enum DayFormat {
    static func date(_ day: String) -> Date {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(secondsFromGMT: 0)
        format.dateFormat = "yyyy-MM-dd"
        return format.date(from: String(day.prefix(10))) ?? Date(timeIntervalSince1970: 0)
    }

    static func key(_ date: Date) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(secondsFromGMT: 0)
        format.dateFormat = "yyyy-MM-dd"
        return format.string(from: date)
    }

    static func shift(_ day: String, by offset: Int) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return key(calendar.date(byAdding: .day, value: offset, to: date(day))!)
    }

    static func label(_ day: String, pattern: String = "M月d日") -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "zh_CN")
        format.timeZone = TimeZone(secondsFromGMT: 0)
        format.dateFormat = pattern
        return format.string(from: date(day))
    }

    static func instant(_ value: String) -> Date? {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func time(_ value: String?, zone: String, full: Bool = false) -> String {
        guard let value, let date = instant(value) else { return "暂无" }
        let format = DateFormatter()
        format.locale = Locale(identifier: "zh_CN")
        format.timeZone = TimeZone(identifier: zone) ?? TimeZone(secondsFromGMT: 0)
        format.dateFormat = full ? "yyyy年M月d日 HH:mm" : "HH:mm"
        return format.string(from: date)
    }

    static func duration(_ minutes: Double) -> String {
        let total = max(0, Int(minutes.rounded()))
        if total < 60 { return "\(total)分钟" }
        return total % 60 == 0 ? "\(total / 60)小时" : "\(total / 60)小时 \(total % 60)分"
    }
}
