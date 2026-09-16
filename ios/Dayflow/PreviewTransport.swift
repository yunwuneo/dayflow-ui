#if DEBUG
import UIKit

// Deterministic, non-personal fixtures are enabled only by the UI test launch argument.
final class PreviewTransport: URLProtocol, @unchecked Sendable {
    static func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreviewTransport.self]
        let url = URL(string: "https://preview.dayflow.invalid")!
        return APIClient(server: url, credential: Credential(server: url, kind: .bearer, secret: "test-only", username: "预览账户"), configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        guard let url = request.url else { return }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        let day = value("date") ?? "2026-09-16"
        var object: Any = ["username": "预览账户"]
        var mime = "application/json"
        var data: Data
        if url.path.hasSuffix("/overview") { object = Self.overview(day: day) }
        else if url.path.hasSuffix("/activities") {
            let page = Int(value("page") ?? "1") ?? 1
            var items = day == "2026-09-15" ? [] : (1...34).map { Self.activity($0) }
            if let query = value("q"), !query.isEmpty {
                items = items.filter { (($0["title"] as? String) ?? "").contains(query) }
            }
            if let category = value("category") { items = items.filter { ($0["category"] as? String) == category } }
            if value("include_deleted") != "true" { items = items.filter { ($0["source_deleted"] as? Bool) != true } }
            object = ["activities": Array(items.dropFirst((page - 1) * 30).prefix(30)), "total": items.count, "page": page, "limit": 30]
        } else if url.path.contains("/activities/") && !url.path.hasSuffix("/screenshot") {
            object = Self.activity(Int(url.lastPathComponent) ?? 1)
        }
        if url.path.hasSuffix("/screenshot") {
            mime = "image/jpeg"
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 960, height: 600))
            data = renderer.jpegData(withCompressionQuality: 0.8) { context in
                UIColor.systemBackground.setFill(); context.fill(CGRect(x: 0, y: 0, width: 960, height: 600))
                UIColor.secondarySystemBackground.setFill(); context.fill(CGRect(x: 0, y: 0, width: 200, height: 600))
                ("Dayflow / 项目工作区" as NSString).draw(at: CGPoint(x: 235, y: 48), withAttributes: [.font: UIFont.systemFont(ofSize: 28, weight: .semibold), .foregroundColor: UIColor.label])
                for row in 0..<7 {
                    UIColor.systemTeal.withAlphaComponent(0.10 + Double(row % 3) * 0.08).setFill()
                    context.fill(CGRect(x: 235, y: 120 + row * 58, width: 670 - (row % 3) * 80, height: 35))
                }
            }
        } else { data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data() }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": mime])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    static func activity(_ number: Int) -> [String: Any] {
        let names = ["梳理项目计划与设计细节", "实现时间线与活动搜索", "阅读产品设计与技术文档", "整理日报和后续任务"]
        let startMinute = 9 * 60 + (number - 1) * 15
        let start = String(format: "%02d:%02d", startMinute / 60, startMinute % 60)
        let end = String(format: "%02d:%02d", (startMinute + 10) / 60, (startMinute + 10) % 60)
        return ["record_id": number, "device_id": "00000000-0000-0000-0000-000000000001", "day": "2026-09-16",
            "title": names[(number - 1) % names.count], "summary": "回顾当前进展，整理关键问题，并完善下一阶段的工作安排。",
            "detailed_summary": "\(start) 开始梳理项目资料，核对界面与 API 数据结构。\n\(end) 完成当前工作，并记录后续任务。",
            "category": number % 3 == 0 ? "学习" : "工作", "subcategory": "项目", "start": "2026-09-16T\(start):00+08:00",
            "end": "2026-09-16T\(end):00+08:00", "duration_minutes": 10, "apps": ["Xcode", "Safari"],
            "source_deleted": number == 34, "has_screenshot": number % 4 != 0]
    }

    static func overview(day: String) -> [String: Any] {
        ["date": day, "today": "2026-09-16", "time_zone": "Asia/Shanghai", "day_boundary_hour": 4,
         "available_days": ["2026-09-16", "2026-09-15", "2026-09-14"],
         "categories": [["name": "工作", "color_hex": "#248C7E", "is_idle": false, "is_system": false],
                        ["name": "学习", "color_hex": "#518AC5", "is_idle": false, "is_system": false]],
         "totals": day == "2026-09-15" ? [] : [["category": "工作", "minutes": 220, "count": 22], ["category": "学习", "minutes": 110, "count": 11]],
         "daily": ["highlights": ["完成时间线与搜索功能的设计，统一数据展示方式。", "核对 API 与客户端的鉴权流程。"], "tasks": ["检查深色模式与大字体布局。"], "blockers": "等待下一批活动同步。"],
         "weekly": ["tracked_minutes": 1860, "focus_minutes": 1320, "week_start": "2026-09-14", "week_end": "2026-09-21",
                    "categories": [["name": "工作", "minutes": 1320, "share": 0.71], ["name": "学习", "minutes": 540, "share": 0.29]]],
         "devices": [["id": "00000000-0000-0000-0000-000000000001", "name": "MacBook Pro", "last_sync_at": "2026-09-16T12:30:00Z", "time_zone": "Asia/Shanghai", "revision": 42,
                      "status": ["last_capture_at": "2026-09-16T12:25:00Z", "pending_batches": 2, "failed_batches": 0]]]]
    }
}
#endif
