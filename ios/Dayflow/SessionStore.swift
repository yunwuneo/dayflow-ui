import Foundation
import Observation
import Security

@MainActor enum CredentialVault {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.dayflow.archive",
        kSecAttrAccount as String: "archive-session"
    ]

    static func load() throws -> Credential? {
        var request = query
        request[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw VaultError(status: status) }
        return try JSONDecoder().decode(Credential.self, from: data)
    }

    static func save(_ credential: Credential) throws {
        let data = try JSONEncoder().encode(credential)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw VaultError(status: status) }
    }

    static func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultError(status: status) }
    }

    struct VaultError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "无法访问钥匙串（\(status)），请解锁设备后重试。" }
    }
}

@MainActor @Observable
final class SessionStore {
    var client: APIClient?
    var restoring = true
    var busy = false
    var error: String?
    var canRestore = false
    var serverText = UserDefaults.standard.string(forKey: "archive-server") ?? ""
    var username = UserDefaults.standard.string(forKey: "archive-username") ?? ""

    func restore() async {
        restoring = true
        defer { restoring = false }
        do {
            guard let credential = try CredentialVault.load() else { return }
            canRestore = true
            let api = APIClient(server: credential.server, credential: credential)
            let _: APIClient.Account = try await api.get("auth/session")
            client = api
            error = nil
        } catch { handle(error) }
    }

    func connect(password: String, token: String, useToken: Bool) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let server = try APIClient.serverURL(serverText)
            let credential: Credential
            if useToken {
                credential = Credential(server: server, kind: .bearer,
                    secret: token.trimmingCharacters(in: .whitespacesAndNewlines), username: "只读访问")
            } else {
                credential = try await APIClient(server: server).login(username: username, password: password)
            }
            let api = APIClient(server: server, credential: credential)
            let _: APIClient.Account = try await api.get("auth/session")
            try CredentialVault.save(credential)
            UserDefaults.standard.set(server.absoluteString, forKey: "archive-server")
            UserDefaults.standard.set(username, forKey: "archive-username")
            serverText = server.absoluteString
            client = api
            canRestore = true
        } catch { handle(error) }
    }

    func signOut() async {
        guard let client, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            if client.credential?.kind == .cookie {
                do { _ = try await client.data("auth/logout", method: "POST") }
                catch let failure as APIError where failure.unauthorized { /* Already revoked. */ }
            }
            try CredentialVault.clear()
            self.client = nil
            canRestore = false
            error = nil
        } catch { handle(error) }
    }

    func handle(_ failure: Error) {
        guard !(failure is CancellationError), (failure as? URLError)?.code != .cancelled else { return }
        error = failure.localizedDescription
        if let failure = failure as? APIError, failure.unauthorized {
            client = nil
            canRestore = false
            do { try CredentialVault.clear() } catch { self.error = error.localizedDescription }
        }
    }
}
