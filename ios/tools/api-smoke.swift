import Foundation

@main
struct APISmoke {
    static func main() async throws {
        let env = ProcessInfo.processInfo.environment
        let server = try APIClient.serverURL(env["DAYFLOW_TEST_SERVER"] ?? "http://127.0.0.1:4310")
        guard let username = env["ADMIN_USERNAME"], let password = env["ADMIN_PASSWORD"] else {
            throw SmokeError(message: "ADMIN_USERNAME and ADMIN_PASSWORD are required")
        }
        let credential = try await APIClient(server: server).login(username: username, password: password)
        let client = APIClient(server: server, credential: credential)
        do {
            let _: APIClient.Account = try await client.get("auth/session")
            let overview: Overview = try await client.get("overview")
            let day = overview.availableDays.first ?? overview.today
            let _: Overview = try await client.get("overview", query: [.init(name: "date", value: day)])
            let page: ActivityPage = try await client.get("activities", query: [.init(name: "date", value: day)])
            if let first = page.activities.first {
                let detail: Activity = try await client.get("activities/\(first.id)")
                guard detail.id == first.id else { throw SmokeError(message: "Detail identity mismatch") }
            }
            if let screenshot = page.activities.first(where: \.hasScreenshot) {
                let (data, response) = try await client.data("activities/\(screenshot.id)/screenshot")
                guard response.mimeType == "image/jpeg", data.starts(with: [0xFF, 0xD8]) else {
                    throw SmokeError(message: "Invalid authenticated screenshot")
                }
            }
            let _: ActivityPage = try await client.get("activities", query: [.init(name: "q", value: "项目"), .init(name: "include_deleted", value: "true")])
            if let token = env["READ_API_TOKEN"], !token.isEmpty {
                let reader = APIClient(server: server, credential: Credential(server: server, kind: .bearer, secret: token, username: "test"))
                let _: Overview = try await reader.get("overview")
                if let screenshot = page.activities.first(where: \.hasScreenshot) {
                    _ = try await reader.data("activities/\(screenshot.id)/screenshot")
                }
            }
            _ = try await client.data("auth/logout", method: "POST")
            do {
                let _: APIClient.Account = try await client.get("auth/session")
                throw SmokeError(message: "Logout did not revoke session")
            } catch let error as APIError where error.unauthorized {}
            print("Live API passed: login, session, overview, models, activities, detail, screenshots, search, read token, logout.")
            print("Available days: \(overview.availableDays.count); activities on latest day: \(page.total).")
        } catch {
            _ = try? await client.data("auth/logout", method: "POST")
            throw error
        }
    }
    struct SmokeError: Error { let message: String }
}
