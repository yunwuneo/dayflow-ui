import XCTest
@testable import Dayflow

final class DayflowTests: XCTestCase {
    func testServerNormalizationAndTransportPolicy() throws {
        XCTAssertEqual(try APIClient.serverURL(" https://example.com/archive/api/v1/ ").absoluteString, "https://example.com/archive")
        XCTAssertEqual(try APIClient.serverURL("http://192.168.1.2:4310").host, "192.168.1.2")
        XCTAssertThrowsError(try APIClient.serverURL("http://example.com"))
        XCTAssertThrowsError(try APIClient.serverURL("https://name:secret@example.com"))
        XCTAssertThrowsError(try APIClient.serverURL("https://example.com?token=secret"))
        XCTAssertThrowsError(try APIClient.serverURL("file:///tmp"))
    }

    func testAuthenticatedScreenshotAndQueryEncoding() throws {
        let url = try APIClient.serverURL("https://example.com/archive")
        let credential = Credential(server: url, kind: .bearer, secret: "readonly", username: "Test")
        let client = APIClient(server: url, credential: credential)
        let request = try client.request("activities/device/123/screenshot")
        XCTAssertEqual(request.url?.path, "/archive/api/v1/activities/device/123/screenshot")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer readonly")
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        let filter = ActivityFilter(query: "项目 & Xcode+#", category: "工作", includeDeleted: true)
        let search = try client.request("activities", query: filter.parameters(page: 2))
        let items = URLComponents(url: search.url!, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first { $0.name == "q" }?.value, "项目 & Xcode+#")
        XCTAssertEqual(items.first { $0.name == "page" }?.value, "2")
        XCTAssertEqual(items.first { $0.name == "include_deleted" }?.value, "true")
        XCTAssertNil(items.first { $0.name == "date" })
    }

    func testCookieAuthIsExplicit() throws {
        let url = URL(string: "https://example.com")!
        let client = APIClient(server: url, credential: Credential(server: url, kind: .cookie, secret: "session", username: "neo"))
        let request = try client.request("auth/logout", method: "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "dayflow_session=session")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Dayflow-Request"), "1")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func testDateArithmeticAndDeviceZone() {
        XCTAssertEqual(DayFormat.shift("2026-03-01", by: -1), "2026-02-28")
        XCTAssertEqual(DayFormat.shift("2024-03-01", by: -1), "2024-02-29")
        XCTAssertEqual(DayFormat.time("2026-09-16T18:30:00.123Z", zone: "Asia/Shanghai"), "02:30")
        XCTAssertEqual(DayFormat.time("2026-09-16T18:30:00Z", zone: "UTC"), "18:30")
        XCTAssertEqual(DayFormat.duration(59.7), "1小时")
        XCTAssertEqual(DayFormat.duration(119.8), "2小时")
    }

    func testDailyBlockerVariantsAndNullDocuments() throws {
        for (json, expected) in [("{}", []), ("{\"blockers\":null}", []),
                                 ("{\"blockers\":\"待办\"}", ["待办"]), ("{\"blockers\":[\"A\",\"B\"]}", ["A", "B"])] {
            let result = try JSONDecoder().decode(Daily.self, from: Data(json.utf8))
            XCTAssertEqual(result.blockers, expected)
        }
        var object = PreviewTransport.overview(day: "2026-09-16")
        object["daily"] = NSNull()
        object["weekly"] = NSNull()
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let result = try decoder.decode(Overview.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(result.daily)
        XCTAssertNil(result.weekly)
        XCTAssertEqual(result.devices.first?.status.pendingBatches, 2)
    }

    @MainActor func testPaginationAndFilterReset() async throws {
        let client = PreviewTransport.client()
        let session = SessionStore()
        let store = ActivityStore()
        await store.reset(ActivityFilter(day: "2026-09-16"), client: client, session: session, debounce: false)
        XCTAssertEqual(store.items.count, 30)
        XCTAssertEqual(store.total, 33)
        await store.next(client: client, session: session)
        XCTAssertEqual(store.items.count, 33)
        XCTAssertEqual(Set(store.items.map(\.id)).count, 33)
        await store.reset(ActivityFilter(query: "不存在"), client: client, session: session, debounce: false)
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(store.total, 0)
        await store.reset(ActivityFilter(includeDeleted: true), client: client, session: session, debounce: false)
        XCTAssertEqual(store.total, 34)
    }

    @MainActor func testCancelledSearchDoesNotReplaceNewResults() async {
        let client = PreviewTransport.client()
        let session = SessionStore()
        let store = ActivityStore()
        let old = Task { await store.reset(ActivityFilter(query: "旧结果"), client: client, session: session, debounce: true) }
        await Task.yield()
        old.cancel()
        await store.reset(ActivityFilter(query: "项目"), client: client, session: session, debounce: false)
        await old.value
        XCTAssertFalse(store.items.isEmpty)
        XCTAssertTrue(store.items.allSatisfy { $0.title.contains("项目") })
        XCTAssertNil(store.error)
    }
}
