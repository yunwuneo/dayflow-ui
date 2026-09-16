import Foundation

enum APIError: LocalizedError {
    case invalidServer, insecureServer, invalidResponse, missingSession
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidServer: "请输入服务器地址，例如 https://dayflow.example.com"
        case .insecureServer: "服务器需要使用 HTTPS；本机和局域网地址可使用 HTTP。"
        case .invalidResponse: "服务器返回了无法识别的数据。"
        case .missingSession: "服务器未返回登录会话，请检查服务器配置。"
        case let .http(_, message): message
        }
    }
    var unauthorized: Bool { if case .http(401, _) = self { true } else { false } }
}

struct Credential: Codable, Sendable {
    enum Kind: String, Codable { case cookie, bearer }
    let server: URL
    let kind: Kind
    let secret: String
    let username: String
}

// Never forward archive credentials through an HTTP redirect to another origin.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class APIClient: Sendable {
    let server: URL
    let credential: Credential?
    private let session: URLSession

    init(server: URL, credential: Credential? = nil, configuration: URLSessionConfiguration = .ephemeral) {
        self.server = server
        self.credential = credential
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    static func serverURL(_ input: String) throws -> URL {
        guard var parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.port == nil || (1...65535).contains(parts.port!) else { throw APIError.invalidServer }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        let privateIPv4 = octets.count == 4 && octets.allSatisfy { (0...255).contains($0) }
            && (octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 172 && (16...31).contains(octets[1])))
        let local = host == "localhost" || host == "[::1]" || host == "::1" || host.hasSuffix(".local") || privateIPv4
        guard scheme == "https" || local else { throw APIError.insecureServer }
        var path = parts.path
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix("/api/v1") { path.removeLast(7) }
        parts.path = path
        guard let url = parts.url else { throw APIError.invalidServer }
        return url
    }

    func request(_ path: String, query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil) throws -> URLRequest {
        var parts = URLComponents(url: server.appending(path: "api/v1/\(path)"), resolvingAgainstBaseURL: false)!
        parts.queryItems = query.isEmpty ? nil : query
        guard let url = parts.url else { throw APIError.invalidServer }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("1", forHTTPHeaderField: "X-Dayflow-Request")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let credential {
            switch credential.kind {
            case .bearer: request.setValue("Bearer \(credential.secret)", forHTTPHeaderField: "Authorization")
            case .cookie: request.setValue("dayflow_session=\(credential.secret)", forHTTPHeaderField: "Cookie")
            }
        }
        return request
    }

    func data(_ path: String, query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request(path, query: query, method: method, body: body))
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError.http(response.statusCode, message ?? "请求失败（\(response.statusCode)）")
        }
        return (data, response)
    }

    func get<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let (data, _) = try await data(path, query: query)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.invalidResponse }
    }

    func login(username: String, password: String) async throws -> Credential {
        let body = try JSONEncoder().encode(LoginBody(username: username, password: password))
        let (_, response) = try await data("auth/login", method: "POST", body: body)
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            if let key = entry.key as? String, let value = entry.value as? String { result[key] = value }
        }
        guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: server)
            .first(where: { $0.name == "dayflow_session" }) else { throw APIError.missingSession }
        return Credential(server: server, kind: .cookie, secret: cookie.value, username: username)
    }

    struct Account: Decodable, Sendable { let username: String }
    private struct LoginBody: Encodable { let username: String; let password: String }
    private struct ErrorBody: Decodable { let error: String }
}
