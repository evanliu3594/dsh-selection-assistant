import Foundation

enum LogLevel: String {
    case error
    case warn
    case info
    case debug

    var rank: Int {
        switch self {
        case .error: return 0
        case .warn: return 1
        case .info: return 2
        case .debug: return 3
        }
    }
}

/// File + host logger. The host log POST is fire-and-forget and must never
/// affect the main flow. Never log clipboard contents or tokens.
final class Logger {
    static let shared = Logger()

    private let queue = DispatchQueue(label: "com.dsh.selection-assistant.log")
    private var filePath: String?
    private var endpoint: String = ""
    private var token: String = ""
    private var threshold: Int = LogLevel.info.rank
    private var lastErrorAt: TimeInterval = 0
    private let processId = ProcessInfo.processInfo.processIdentifier

    private lazy var formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    func configure(path: String?, fallbackPath: String?, endpoint: String, token: String, debug: Bool) {
        queue.sync {
            self.endpoint = endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            self.token = token
            self.threshold = debug ? LogLevel.debug.rank : LogLevel.info.rank
            self.filePath = path ?? fallbackPath
        }
    }

    func setEndpoint(_ endpoint: String, token: String) {
        queue.sync {
            self.endpoint = endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            self.token = token
        }
    }

    func flush() {
        queue.sync {}
    }

    func log(_ level: LogLevel, _ message: String) {
        let now = Date()
        queue.async { [weak self] in
            guard let self else { return }
            guard level.rank <= self.threshold else { return }
            let line = "\(self.formatter.string(from: now)) [\(level.rawValue.uppercased())] \(self.processId) \(message)"
            self.appendFile(line)
            self.postToHost(level: level, message: message)
        }
    }

    func error(_ message: String) { log(.error, message) }
    func warn(_ message: String) { log(.warn, message) }
    func info(_ message: String) { log(.info, message) }
    func debug(_ message: String) { log(.debug, message) }

    /// Rate-limited error logger used inside the main pump.
    func errorThrottled(_ message: String) {
        let now = Date().timeIntervalSince1970
        var allowed = false
        queue.sync {
            if now - self.lastErrorAt >= 1.5 {
                self.lastErrorAt = now
                allowed = true
            }
        }
        if allowed { error(message) }
    }

    private func appendFile(_ line: String) {
        guard let path = filePath, !path.isEmpty else { return }
        let fm = FileManager.default
        let dir = (path as NSString).deletingLastPathComponent
        if !dir.isEmpty, !fm.fileExists(atPath: dir) {
            try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
        if !fm.fileExists(atPath: path) {
            fm.createFile(atPath: path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: path) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            if let data = (line + "\n").data(using: .utf8) {
                try handle.write(contentsOf: data)
            }
        } catch {
            // Logging must never break the helper.
        }
    }

    private func postToHost(level: LogLevel, message: String) {
        guard !endpoint.isEmpty else { return }
        Http.postJSONAsync(
            urlString: endpoint + "/v1/log",
            token: token,
            body: ["level": level.rawValue, "message": message],
            completion: nil
        )
    }
}
