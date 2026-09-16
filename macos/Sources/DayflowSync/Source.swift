import Foundation
import SQLite3
import AVFoundation
import AppKit
import CoreImage

struct SourceSnapshot {
    let days: [String: [JSON]]
    let dayHashes: [String: String]
    let dailyHashes: [String: String]
    let goals: [JSON]
    let goalCategories: [JSON]
    let activeIDs: Set<Int>
}

final class SourceDatabase {
    private var db: OpaquePointer?
    init(path: String) throws {
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            if let db { sqlite3_close(db) }
            db = nil
            throw SyncFailure("无法只读打开 Dayflow 数据库，请检查文件路径与访问权限")
        }
        sqlite3_busy_timeout(db, 5000)
        do {
            // Refuse incompatible internal schemas before interpreting a missing row as a deletion.
            let required: [String: Set<String>] = [
                "timeline_cards": ["id", "day", "start_ts", "end_ts", "is_deleted", "metadata", "batch_id", "title", "summary", "detailed_summary", "category", "subcategory"],
                "screenshots": ["id", "captured_at", "file_path", "frame_index", "is_deleted"],
                "daily_standup_entries": ["standup_day", "payload_json", "updated_at"],
                "day_goals": ["day", "updated_at"], "day_goal_categories": ["day", "kind", "sort_order"]
            ]
            for (table, columns) in required {
                let actual = Set(try query("PRAGMA table_info(\(table))").compactMap { $0["name"] as? String })
                guard columns.isSubset(of: actual) else { throw SyncFailure("Dayflow 数据库结构不兼容：\(table)") }
            }
        } catch { sqlite3_close(db); db = nil; throw error }
    }
    deinit { sqlite3_close(db) }
    func query(_ sql: String, bindings: [Any] = []) throws -> [JSON] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw SyncFailure("Dayflow 数据查询失败") }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in bindings.enumerated() {
            if let int = value as? Int { sqlite3_bind_int64(statement, Int32(index + 1), Int64(int)) }
            else if let double = value as? Double { sqlite3_bind_double(statement, Int32(index + 1), double) }
            else if let string = value as? String { sqlite3_bind_text(statement, Int32(index + 1), string, -1, transient) }
        }
        var rows: [JSON] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { break }
            guard status == SQLITE_ROW else { throw SyncFailure("Dayflow 数据读取中断，保留上次同步状态") }
            var row: JSON = [:]
            for index in 0..<sqlite3_column_count(statement) {
                let key = String(cString: sqlite3_column_name(statement, index))
                switch sqlite3_column_type(statement, index) {
                case SQLITE_INTEGER: row[key] = Int(sqlite3_column_int64(statement, index))
                case SQLITE_FLOAT: row[key] = sqlite3_column_double(statement, index)
                case SQLITE_TEXT: row[key] = String(cString: sqlite3_column_text(statement, index))
                default: row[key] = NSNull()
                }
            }
            rows.append(row)
        }
        return rows
    }
    func snapshot() throws -> SourceSnapshot {
        _ = try query("BEGIN")
        defer { _ = try? query("ROLLBACK") }
        let rows = try query("SELECT id,batch_id,start_ts,end_ts,day,title,summary,category,subcategory,detailed_summary,metadata FROM timeline_cards WHERE is_deleted=0 ORDER BY id")
        var days: [String: [JSON]] = [:]
        for row in rows {
            guard let day = row["day"] as? String, let start = row["start_ts"] as? Int, let end = row["end_ts"] as? Int, end >= start else {
                throw SyncFailure("活动日期或时间戳无效，已停止同步")
            }
            days[day, default: []].append(row)
        }
        var hashes: [String: String] = [:]
        for (day, values) in days { hashes[day] = try fingerprint(values) }
        var dailies: [String: String] = [:]
        for row in try query("SELECT standup_day,payload_json,updated_at FROM daily_standup_entries ORDER BY standup_day") {
            if let day = row["standup_day"] as? String { dailies[day] = try fingerprint(row) }
        }
        return SourceSnapshot(days: days, dayHashes: hashes, dailyHashes: dailies,
                              goals: try query("SELECT * FROM day_goals ORDER BY day"),
                              goalCategories: try query("SELECT * FROM day_goal_categories ORDER BY day,kind,sort_order"),
                              activeIDs: Set(rows.compactMap { $0["id"] as? Int }))
    }
    func screenshotCandidates(recordID: Int) throws -> [JSON] {
        try query("""
          SELECT s.file_path,s.frame_index,s.captured_at FROM screenshots s
          JOIN timeline_cards t ON t.id=?
          WHERE s.is_deleted=0 AND s.captured_at>=t.start_ts AND s.captured_at<t.end_ts
          ORDER BY ABS(s.captured_at-(t.start_ts+t.end_ts)/2)
          """, bindings: [recordID])
    }
}

enum ScreenshotExtractor {
    static func extract(candidates: [JSON], databasePath: String) async throws -> Data? {
        let allowedRoot = URL(fileURLWithPath: databasePath).deletingLastPathComponent().appendingPathComponent("recordings").resolvingSymlinksInPath().path + "/"
        var attempted = Set<String>()
        for candidate in candidates {
            guard let path = candidate["file_path"] as? String, let frame = candidate["frame_index"] as? Int, frame >= 0,
                  frame < 100000, FileManager.default.fileExists(atPath: path) else { continue }
            let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
            guard url.path.hasPrefix(allowedRoot), !attempted.contains("\(path):\(frame)") else { continue }
            attempted.insert("\(path):\(frame)")
            try Task.checkCancellation()
            do { if let data = try await frameJPEG(url: url, frameIndex: frame) { return data } } catch is CancellationError { throw CancellationError() } catch { continue }
            if attempted.count >= 5 { break }
        }
        return nil
    }
    private static func frameJPEG(url: URL, frameIndex: Int) async throws -> Data? {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { return nil }
        let transform = try await track.load(.preferredTransform)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { return nil }
        defer { reader.cancelReading() }
        var current = 0
        while let sample = output.copyNextSampleBuffer() {
            defer { CMSampleBufferInvalidate(sample) }
            if current == frameIndex, let buffer = CMSampleBufferGetImageBuffer(sample) {
                var image = CIImage(cvPixelBuffer: buffer).transformed(by: transform)
                let extent = image.extent
                image = image.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
                let scale = min(1, 1440 / extent.width, 1200 / extent.height)
                image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                let context = CIContext(options: [.useSoftwareRenderer: false])
                guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
                return context.jpegRepresentation(of: image, colorSpace: colorSpace, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8])
            }
            current += 1
        }
        return nil
    }
}
