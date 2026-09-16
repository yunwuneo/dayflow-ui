import Foundation
import Observation
import UIKit

@MainActor @Observable
final class ArchiveStore {
    let client: APIClient
    var overview: Overview?
    var selectedDay = ""
    var error: String?
    var loading = false
    var refreshID = 0
    private var generation = 0
    @ObservationIgnored let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 32 * 1024 * 1024
        return cache
    }()

    init(client: APIClient) { self.client = client }

    func load(session: SessionStore) async {
        generation += 1
        let ticket = generation
        loading = true
        error = nil
        // Clear date-specific content immediately so failures cannot show another day's report.
        if overview?.date != selectedDay && !selectedDay.isEmpty { overview = nil }
        defer { if ticket == generation { loading = false } }
        do {
            let query = selectedDay.isEmpty ? [] : [URLQueryItem(name: "date", value: selectedDay)]
            let result: Overview = try await client.get("overview", query: query)
            try Task.checkCancellation()
            guard ticket == generation else { return }
            overview = result
        } catch {
            guard ticket == generation, !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
            self.error = error.localizedDescription
            session.handle(error)
        }
    }

    var day: String { selectedDay.isEmpty ? overview?.date ?? "" : selectedDay }
    var zone: String { overview?.timeZone ?? "Asia/Shanghai" }
}

struct ActivityFilter: Hashable, Sendable {
    var day = ""
    var query = ""
    var category = ""
    var includeDeleted = false
    var refreshID = 0

    func parameters(page: Int) -> [URLQueryItem] {
        var queryItems = [URLQueryItem(name: "page", value: String(page)), URLQueryItem(name: "limit", value: "30")]
        if !day.isEmpty { queryItems.append(URLQueryItem(name: "date", value: day)) }
        if !query.isEmpty { queryItems.append(URLQueryItem(name: "q", value: query)) }
        if !category.isEmpty { queryItems.append(URLQueryItem(name: "category", value: category)) }
        queryItems.append(URLQueryItem(name: "include_deleted", value: String(includeDeleted)))
        return queryItems
    }
}

@MainActor @Observable
final class ActivityStore {
    var items: [Activity] = []
    var total = 0
    var page = 0
    var loading = false
    var error: String?
    private var filter = ActivityFilter()
    private var generation = 0

    func reset(_ filter: ActivityFilter, client: APIClient, session: SessionStore, debounce: Bool) async {
        generation += 1
        let ticket = generation
        self.filter = filter
        items = []
        total = 0
        page = 0
        error = nil
        loading = true
        defer { if ticket == generation { loading = false } }
        do {
            if debounce { try await Task.sleep(for: .milliseconds(300)) }
            try await fetch(page: 1, ticket: ticket, client: client)
        } catch { report(error, ticket: ticket, session: session) }
    }

    func next(client: APIClient, session: SessionStore) async {
        guard !loading else { return }
        let ticket = generation
        loading = true
        error = nil
        defer { if ticket == generation { loading = false } }
        do { try await fetch(page: page + 1, ticket: ticket, client: client) }
        catch { report(error, ticket: ticket, session: session) }
    }

    private func fetch(page: Int, ticket: Int, client: APIClient) async throws {
        let result: ActivityPage = try await client.get("activities", query: filter.parameters(page: page))
        try Task.checkCancellation()
        guard ticket == generation else { return }
        let known = Set(items.map(\.id))
        items += result.activities.filter { !known.contains($0.id) }
        total = result.total
        self.page = result.page
    }

    private func report(_ error: Error, ticket: Int, session: SessionStore) {
        guard ticket == generation, !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
        self.error = error.localizedDescription
        session.handle(error)
    }
}
