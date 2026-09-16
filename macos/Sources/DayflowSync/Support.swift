import Foundation
import CryptoKit
import Security

typealias JSON = [String: Any]

struct SyncFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}
func encodeJSON(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
}
func fingerprint(_ value: Any) throws -> String {
    SHA256.hash(data: try encodeJSON(value)).map { String(format: "%02x", $0) }.joined()
}
func parseJSON(_ data: Data) throws -> JSON {
    guard let value = try JSONSerialization.jsonObject(with: data) as? JSON else { throw SyncFailure("数据格式不是 JSON 对象") }
    return value
}
func runCommand(_ executable: String, _ arguments: [String], timeout: TimeInterval = 90) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    let timer = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    timer.cancel()
    guard process.terminationStatus == 0 else {
        if let object = try? parseJSON(data), object["error"] is JSON { return data }
        throw SyncFailure("Dayflow 命令执行失败 (\(process.terminationStatus))：\(String(data: data.prefix(500), encoding: .utf8) ?? "")")
    }
    return data
}
func dayflow(_ configuration: Settings, _ arguments: [String], allowMissing: Bool = false) throws -> JSON? {
    let result = try parseJSON(runCommand(configuration.cliPath, arguments + ["--json"]))
    if let error = result["error"] as? JSON {
        if allowMissing && error["code"] as? String == "not_found" { return nil }
        throw SyncFailure(error["message"] as? String ?? "Dayflow 读取失败")
    }
    guard (result["schema_version"] as? Int) == 1 else { throw SyncFailure("Dayflow 接口版本不兼容，已停止同步") }
    return result
}
func mondayFor(_ date: String) -> String {
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"
    guard let parsed = formatter.date(from: date) else { return date }
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = formatter.timeZone
    let offset = (calendar.component(.weekday, from: parsed) + 5) % 7
    return formatter.string(from: calendar.date(byAdding: .day, value: -offset, to: parsed)!)
}

struct Settings: Codable {
    var serverURL = "http://127.0.0.1:4310"
    var deviceID = UUID().uuidString.lowercased()
    var deviceName = Host.current().localizedName ?? "My Mac"
    var cliPath = "/usr/local/bin/dayflow"
    var databasePath = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Dayflow/chunks.sqlite").path
    var intervalMinutes = 30
    var paused = false
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/DayflowSync", isDirectory: true)
    }
    static var file: URL { directory.appendingPathComponent("settings.json") }
    static func load(from url: URL = Settings.file) throws -> Settings {
        try JSONDecoder().decode(Settings.self, from: Data(contentsOf: url))
    }
    func save(to url: URL = Settings.file) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func validatedURL() throws -> URL {
        guard let url = URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
              url.scheme == "https" || (url.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(host)) else {
            throw SyncFailure("服务器地址须为 HTTPS；本机测试可使用 http://127.0.0.1:4310")
        }
        guard intervalMinutes >= 5 && intervalMinutes <= 1440 else { throw SyncFailure("同步间隔须为 5–1440 分钟") }
        guard UUID(uuidString: deviceID) != nil else { throw SyncFailure("设备 ID 无效") }
        return url
    }
}

enum Keychain {
    private static let service = "com.dayflow.archive.sync"
    static func read() throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                  kSecAttrAccount as String: "device-token", kSecReturnData as String: true]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
            throw SyncFailure("无法读取钥匙串令牌 (\(status))")
        }
        return token
    }
    static func save(_ token: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                  kSecAttrService as String: service, kSecAttrAccount as String: "device-token"]
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8)]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new }.merging([
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            ]) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw SyncFailure("无法保存钥匙串令牌 (\(status))") }
    }
}
