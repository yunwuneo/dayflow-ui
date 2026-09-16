import Foundation
import Darwin

struct HTTPFailure: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { "\(message) (HTTP \(status))" }
}
final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct SyncReport: Codable {
    var completedAt = Date()
    var changedActivities = 0
    var uploadedScreenshots = 0
    var missingScreenshots = 0
    var changedDays = 0
    var revision = 0
}

actor SyncEngine {
    private var running = false
    func run(settings: Settings, token: String, stateDirectory: URL,
             progress: @escaping @Sendable (String) -> Void) async throws -> SyncReport {
        guard !running else { throw SyncFailure("同步正在进行") }
        running = true; defer { running = false }
        let baseURL = try settings.validatedURL()
        guard token.count >= 32 else { throw SyncFailure("请在设置中填写有效的设备令牌") }
        try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        let namespace = try fingerprint(["server": baseURL.absoluteString, "device": settings.deviceID])
        let lockURL = stateDirectory.appendingPathComponent("\(namespace).lock")
        let fd = open(lockURL.path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { throw SyncFailure("无法创建同步锁") }
        defer { close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw SyncFailure("另一客户端正在同步此设备") }
        defer { flock(fd, LOCK_UN) }
        let pendingURL = stateDirectory.appendingPathComponent("\(namespace).pending.json")
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.timeoutIntervalForRequest = 30
        sessionConfiguration.timeoutIntervalForResource = 60
        let session = URLSession(configuration: sessionConfiguration, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        func request(_ route: String, method: String = "GET", data: Data? = nil, contentType: String = "application/json") async throws -> JSON {
            try Task.checkCancellation()
            let url = URL(string: "api/v1/\(route)", relativeTo: baseURL.appendingPathComponent("/"))!.absoluteURL
            var req = URLRequest(url: url)
            req.httpMethod = method; req.httpBody = data
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
            for attempt in 0..<3 {
                do {
                    let (body, response) = try await session.data(for: req)
                    guard let http = response as? HTTPURLResponse else { throw SyncFailure("服务器响应无效") }
                    guard (200..<300).contains(http.statusCode) else {
                        let message = (try? parseJSON(body))?["error"] as? String ?? "服务器请求失败"
                        if http.statusCode >= 500 && attempt < 2 { try await Task.sleep(nanoseconds: UInt64(attempt + 1) * 1_000_000_000); continue }
                        throw HTTPFailure(status: http.statusCode, message: message)
                    }
                    return try parseJSON(body)
                } catch let error as URLError where attempt < 2 && error.code != .cancelled {
                    try await Task.sleep(nanoseconds: UInt64(attempt + 1) * 1_000_000_000)
                }
            }
            throw SyncFailure("无法连接服务器")
        }
        if FileManager.default.fileExists(atPath: pendingURL.path) {
            progress("恢复上次未确认的同步批次")
            do { _ = try await request("sync/batch", method: "POST", data: Data(contentsOf: pendingURL)) }
            catch let error as HTTPFailure where error.status == 409 {
                // A different confirmed revision requires a fresh authoritative snapshot.
            }
            try FileManager.default.removeItem(at: pendingURL)
        }
        progress("核对服务端同步清单")
        let manifest = try await request("sync/state?device_id=\(settings.deviceID)")
        var revision = manifest["revision"] as? Int ?? 0
        var remoteDays: [String: String] = [:]
        for item in manifest["days"] as? [JSON] ?? [] { if let day = item["day"] as? String { remoteDays[day] = item["source_hash"] as? String } }
        var remoteDailies: [String: String] = [:]; var remoteWeeks: [String: String] = [:]
        for item in manifest["documents"] as? [JSON] ?? [] {
            guard let day = item["day"] as? String, let hash = item["source_hash"] as? String else { continue }
            if item["kind"] as? String == "daily" { remoteDailies[day] = hash } else { remoteWeeks[day] = hash }
        }
        var remoteActivities: [Int: JSON] = [:]
        for item in manifest["activities"] as? [JSON] ?? [] { if let id = item["record_id"] as? Int { remoteActivities[id] = item } }
        progress("读取 Dayflow 活动与日期索引")
        let database = try SourceDatabase(path: settings.databasePath)
        let snapshot = try database.snapshot()
        guard let status = try dayflow(settings, ["status"]), let categoriesResponse = try dayflow(settings, ["categories"]),
              let categories = categoriesResponse["categories"] as? [JSON], let zone = status["time_zone"] as? String,
              let boundary = status["day_boundary_hour"] as? Int else { throw SyncFailure("Dayflow 状态或分类数据不完整") }
        let emptyHash = try fingerprint([JSON]())
        let missingDailyHash = try fingerprint(["missing": true])
        let dates = Set(snapshot.dayHashes.keys).union(remoteDays.keys).union(snapshot.dailyHashes.keys).union(remoteDailies.keys).sorted()
        let changedDays = dates.filter { (snapshot.dayHashes[$0] ?? emptyHash) != remoteDays[$0] }
        let changedDailies = dates.filter { (snapshot.dailyHashes[$0] ?? missingDailyHash) != remoteDailies[$0] }
        let weeks = Set(dates.map(mondayFor)).union(remoteWeeks.keys).sorted()
        var weekHashes: [String: String] = [:]
        for week in weeks {
            weekHashes[week] = try fingerprint([
                "days": snapshot.dayHashes.filter { mondayFor($0.key) == week }, "categories": categories,
                "goals": snapshot.goals.filter { mondayFor($0["day"] as? String ?? "") == week },
                "goal_categories": snapshot.goalCategories.filter { mondayFor($0["day"] as? String ?? "") == week }
            ])
        }
        let changedWeeks = weeks.filter { weekHashes[$0] != remoteWeeks[$0] }
        var report = SyncReport()
        var batchDays: [JSON] = []; var batchDailies: [JSON] = []; var batchWeeks: [JSON] = []
        let categoriesHash = try fingerprint(categories)

        func sendBatch() async throws {
            // CLI and SQLite are independent readers. Do not acknowledge a snapshot that changed while reading.
            let current = try database.snapshot()
            for item in batchDays {
                let date = item["date"] as! String
                guard (current.dayHashes[date] ?? emptyHash) == (snapshot.dayHashes[date] ?? emptyHash) else {
                    throw SyncFailure("Dayflow 正在更新活动，下次同步将自动重试")
                }
            }
            for item in batchDailies {
                let date = item["date"] as! String
                guard current.dailyHashes[date] == snapshot.dailyHashes[date] else { throw SyncFailure("Dayflow 日报正在更新，下次同步将自动重试") }
            }
            if !batchWeeks.isEmpty {
                guard current.dayHashes == snapshot.dayHashes,
                      try fingerprint(current.goals) == fingerprint(snapshot.goals),
                      try fingerprint(current.goalCategories) == fingerprint(snapshot.goalCategories) else {
                    throw SyncFailure("Dayflow 周统计正在更新，下次同步将自动重试")
                }
            }
            let latestCategories = try dayflow(settings, ["categories"])?["categories"] as? [JSON] ?? []
            guard try fingerprint(latestCategories) == categoriesHash else { throw SyncFailure("Dayflow 分类正在更新，下次同步将自动重试") }
            let body: JSON = ["device_id": settings.deviceID, "device_name": settings.deviceName,
                              "batch_id": UUID().uuidString.lowercased(), "expected_revision": revision,
                              "time_zone": zone, "day_boundary_hour": boundary, "status": status,
                              "categories": categories, "days": batchDays, "dailies": batchDailies, "weeks": batchWeeks]
            let data = try encodeJSON(body)
            guard data.count < 15 * 1024 * 1024 else { throw SyncFailure("同步批次超过 15 MB，请联系维护者拆分该日期") }
            try data.write(to: pendingURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pendingURL.path)
            let response = try await request("sync/batch", method: "POST", data: data)
            guard let confirmedRevision = response["revision"] as? Int else { throw SyncFailure("服务器未确认同步版本") }
            revision = confirmedRevision
            try FileManager.default.removeItem(at: pendingURL)
            report.changedDays += batchDays.count
            batchDays = []; batchDailies = []; batchWeeks = []
        }

        for (index, date) in changedDays.enumerated() {
            try Task.checkCancellation()
            progress("读取变化日期 \(date)（\(index + 1)/\(changedDays.count)）")
            guard let timeline = try dayflow(settings, ["timeline", date, "--detailed"]),
                  let cards = timeline["cards"] as? [JSON] else { throw SyncFailure("时间线返回格式无效") }
            let ids = cards.compactMap { $0["record_id"] as? Int }
            let expectedIDs = Set((snapshot.days[date] ?? []).compactMap { $0["id"] as? Int })
            guard Set(ids) == expectedIDs && ids.count == expectedIDs.count else { throw SyncFailure("Dayflow 时间线正在重生成，下次同步将自动重试") }
            var changed: [JSON] = []
            for card in cards {
                let id = card["record_id"] as! Int
                let hash = try fingerprint(card)
                if remoteActivities[id]?["content_hash"] as? String != hash || remoteActivities[id]?["source_deleted"] as? Bool == true {
                    changed.append(["content_hash": hash, "data": card]); report.changedActivities += 1
                }
            }
            batchDays.append(["date": date, "source_hash": snapshot.dayHashes[date] ?? emptyHash, "active_ids": ids, "activities": changed])
            if batchDays.count >= 7 { try await sendBatch() }
        }
        for date in changedDailies {
            let doc = try dayflow(settings, ["daily", date], allowMissing: true)
            batchDailies.append(["date": date, "source_hash": snapshot.dailyHashes[date] ?? missingDailyHash, "document": doc as Any? ?? NSNull()])
            if batchDailies.count >= 7 { try await sendBatch() }
        }
        for week in changedWeeks {
            let doc = try dayflow(settings, ["weekly", week], allowMissing: true)
            batchWeeks.append(["date": week, "source_hash": weekHashes[week]!, "document": doc as Any? ?? NSNull()])
            if batchWeeks.count >= 7 { try await sendBatch() }
        }
        progress("提交活动、日报与采集状态")
        try await sendBatch()
        let updated = try await request("sync/state?device_id=\(settings.deviceID)")
        let candidates = (updated["activities"] as? [JSON] ?? []).filter { item in
            guard let id = item["record_id"] as? Int else { return false }
            return snapshot.activeIDs.contains(id) && item["has_screenshot"] as? Bool != true
        }
        for (index, item) in candidates.enumerated() {
            try Task.checkCancellation()
            let id = item["record_id"] as! Int
            progress("同步活动截图（\(index + 1)/\(candidates.count)）")
            let image = try await ScreenshotExtractor.extract(candidates: database.screenshotCandidates(recordID: id), databasePath: settings.databasePath)
            guard let image else { report.missingScreenshots += 1; continue }
            _ = try await request("sync/activities/\(settings.deviceID)/\(id)/screenshot", method: "PUT", data: image, contentType: "image/jpeg")
            report.uploadedScreenshots += 1
        }
        report.revision = revision; report.completedAt = Date()
        let encoder = JSONEncoder(); encoder.outputFormatting = .prettyPrinted; encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(report).write(to: stateDirectory.appendingPathComponent("last-sync.json"), options: .atomic)
        return report
    }
}
