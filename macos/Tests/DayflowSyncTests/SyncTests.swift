import XCTest
@testable import DayflowSync

final class SyncTests: XCTestCase {
    func testNonzeroCLIStatusPreservesStructuredNotFound() throws {
        let data = try runCommand("/bin/sh", ["-c", "printf '%s' '{\"error\":{\"code\":\"not_found\"},\"schema_version\":1}'; exit 3"])
        XCTAssertEqual((try parseJSON(data)["error"] as? JSON)?["code"] as? String, "not_found")
        XCTAssertThrowsError(try runCommand("/bin/sh", ["-c", "exit 9"]))
    }
    func testCanonicalHashesIgnoreKeyOrdering() throws {
        XCTAssertEqual(try fingerprint(["a": 1, "b": "活动"]), try fingerprint(["b": "活动", "a": 1]))
        XCTAssertNotEqual(try fingerprint(["title": "old"]), try fingerprint(["title": "new"]))
    }
    func testWeekBoundary() {
        XCTAssertEqual(mondayFor("2026-09-20"), "2026-09-14")
        XCTAssertEqual(mondayFor("2026-09-21"), "2026-09-21")
        XCTAssertEqual(mondayFor("2026-01-01"), "2025-12-29")
    }
    func testRejectsRemotePlaintextAndCredentialURLs() throws {
        var settings = Settings()
        settings.serverURL = "http://example.com"
        XCTAssertThrowsError(try settings.validatedURL())
        settings.serverURL = "https://user:password@example.com"
        XCTAssertThrowsError(try settings.validatedURL())
        settings.serverURL = "https://example.com/path"
        XCTAssertThrowsError(try settings.validatedURL())
        settings.serverURL = "https://example.com"
        XCTAssertNoThrow(try settings.validatedURL())
        settings.serverURL = "http://127.0.0.1:4310"
        XCTAssertNoThrow(try settings.validatedURL())
    }
    func testAllowsHTTPForConfiguredInternalIPv4RangesAndLoopback() {
        var settings = Settings()
        for address in [
            "http://192.168.0.0", "http://192.168.255.255:4310",
            "http://192.168.1.10:4310/", "http://100.64.0.0", "http://100.64.255.255:8080",
            "http://127.0.0.1:4310", "http://localhost:4310", "http://[::1]:4310",
            "https://example.com", "https://192.168.1.10:4310",
        ] {
            settings.serverURL = address
            XCTAssertNoThrow(try settings.validatedURL(), address)
        }
    }
    func testRejectsHTTPOutsideConfiguredRangesAndLookalikeHosts() {
        var settings = Settings()
        for address in [
            "http://192.167.255.255", "http://192.169.0.0",
            "http://100.63.255.255", "http://100.65.0.0",
            "http://10.0.0.1", "http://172.16.0.1", "http://8.8.8.8",
            "http://192.168.1.256", "http://100.64.1", "http://192.168.1.1.",
            "http://192.168.1.1.example.com", "http://100.64.example.com",
            "http://192.168.1.1@evil.example.com", "http://user:password@192.168.1.1",
            "http://192.168.1.1/path", "http://100.64.1.1?query=value", "http://100.64.1.1#fragment",
            "ftp://192.168.1.1",
        ] {
            settings.serverURL = address
            XCTAssertThrowsError(try settings.validatedURL(), address)
        }
    }
    func testSettingsDecodesLegacyConfigWithoutDailyBriefDirectory() throws {
        let legacy = #"{"serverURL":"https://example.com","deviceID":"11111111-1111-1111-1111-111111111111","deviceName":"Mac","cliPath":"/usr/local/bin/dayflow","databasePath":"/tmp/chunks.sqlite","intervalMinutes":30,"paused":false}"#
        let decoded = try JSONDecoder().decode(Settings.self, from: Data(legacy.utf8))
        XCTAssertEqual(decoded.dailyBriefDirectory, Settings.defaultDailyBriefDirectory)
    }
    func testDailyBriefSourceScansValidDaysAndImages() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dayflow-brief-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let dayDir = root.appendingPathComponent("2026-11-20", isDirectory: true)
        let imagesDir = dayDir.appendingPathComponent("images", isDirectory: true)
        let ignoredDir = root.appendingPathComponent("saved", isDirectory: true)
        try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ignoredDir, withIntermediateDirectories: true)
        let brief = #"{"day":"2026-11-20","sourceDay":"2026-11-19","generatedAt":"2026-11-20T04:05:00Z","content":{"order":["docket"],"docket":[{"title":"Task 1","prompt":"Do task 1","agent":true}]},"userState":{"handoffs":[]}}"#
        try brief.write(to: dayDir.appendingPathComponent("brief.json"), atomically: true, encoding: .utf8)
        try Data([0xFF, 0xD8, 0xFF]).write(to: imagesDir.appendingPathComponent("link-demo.jpg"))
        try Data([0x00]).write(to: imagesDir.appendingPathComponent("ignored.txt"))

        let scanned = try DailyBriefSource.scan(directory: root.path)
        XCTAssertEqual(scanned.count, 1)
        XCTAssertEqual(scanned[0].day, "2026-11-20")
        XCTAssertEqual(scanned[0].sourceDay, "2026-11-19")
        XCTAssertEqual(Array(scanned[0].images.keys), ["link-demo.jpg"])
    }
}
