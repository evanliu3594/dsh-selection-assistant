import Foundation

enum Http {
    static func makeRequest(urlString: String, token: String, body: Any, accept: String) -> URLRequest? {
        guard let url = URL(string: urlString) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 120)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        request.httpBody = data
        return request
    }

    /// Fire-and-forget POST used by logging and status reporting.
    static func postJSONAsync(urlString: String, token: String, body: Any, completion: ((Int, String) -> Void)?) {
        guard let request = makeRequest(urlString: urlString, token: token, body: body, accept: "application/json") else {
            completion?(-1, "invalid request")
            return
        }
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                completion?(-1, error.localizedDescription)
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            completion?(status, text)
        }
        task.resume()
    }

    static func postJSONSync(urlString: String, token: String, body: Any, timeout: TimeInterval) -> (Int, String)? {
        guard let request = makeRequest(urlString: urlString, token: token, body: body, accept: "application/json") else {
            return nil
        }
        let semaphore = DispatchSemaphore(value: 0)
        var result: (Int, String)?
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if error != nil { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            result = (status, text)
        }
        task.resume()
        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            task.cancel()
            return nil
        }
        return result
    }

    static func getAsync(urlString: String, timeout: TimeInterval, completion: @escaping (Int) -> Void) {
        guard let url = URL(string: urlString) else {
            completion(-1)
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            if error != nil {
                completion(-1)
                return
            }
            completion((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        task.resume()
    }

    static func trim(_ text: String, _ maxLength: Int = 300) -> String {
        let flattened = text.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        if flattened.count <= maxLength { return flattened }
        return String(flattened.prefix(maxLength)) + "…"
    }
}

/// Streaming SSE client for POST /v1/action. Delegate callbacks run on the main
/// queue; events are delivered to the UI owner in order.
final class SSEStream: NSObject, URLSessionDataDelegate {
    var onEvent: ((String, String) -> Void)?

    private var sessionRef: URLSession?
    private var dataTaskRef: URLSessionDataTask?
    private var lineBuffer = Data()
    private var eventName: String?
    private var dataLines: [String] = []
    private var cancelled = false
    private var finished = false
    private var sawTerminal = false
    private var statusCode = 0
    private var httpErrorBody = Data()
    private var terminalEmitted = false

    var isFinished: Bool { finished }
    var isCancelled: Bool { cancelled }

    func start(urlString: String, token: String, body: Any) {
        guard let request = Http.makeRequest(urlString: urlString, token: token, body: body, accept: "text/event-stream") else {
            emit("transport-error", "无效的宿主地址")
            return
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 600
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let delegateQueue = OperationQueue.main
        delegateQueue.maxConcurrentOperationCount = 1
        let newSession = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        sessionRef = newSession
        let newTask = newSession.dataTask(with: request)
        dataTaskRef = newTask
        newTask.resume()
    }

    func cancel() {
        cancelled = true
        dataTaskRef?.cancel()
        dataTaskRef = nil
        sessionRef?.invalidateAndCancel()
        sessionRef = nil
        finished = true
    }

    private func emit(_ kind: String, _ data: String) {
        guard !cancelled, !terminalEmitted else { return }
        if kind == "done" || kind == "error" { terminalEmitted = true }
        onEvent?(kind, data)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        if statusCode >= 200 && statusCode < 300 {
            completionHandler(.allow)
        } else {
            httpErrorBody.removeAll()
            completionHandler(.allow)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !cancelled else { return }
        if statusCode >= 200 && statusCode < 300 {
            lineBuffer.append(data)
            processLines(final: false)
        } else if httpErrorBody.count < 4096 {
            httpErrorBody.append(data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !cancelled else { return }
        if let error = error as NSError? {
            if error.code == NSURLErrorCancelled && cancelled { return }
            let message: String
            if error.code == NSURLErrorTimedOut {
                message = "请求超时"
            } else {
                message = Http.trim(error.localizedDescription)
            }
            emit("transport-error", message)
        } else if statusCode < 200 || statusCode >= 300 {
            let body = String(data: httpErrorBody, encoding: .utf8) ?? ""
            var message = "宿主返回 HTTP \(statusCode)"
            if !body.isEmpty { message += "：" + Http.trim(body) }
            emit("transport-error", message)
        } else {
            processLines(final: true)
            flushEvent()
            if !sawTerminal {
                emit("stream-end", "连接已关闭")
            }
        }
        finished = true
        dataTaskRef = nil
        sessionRef?.finishTasksAndInvalidate()
        sessionRef = nil
    }

    private func processLines(final: Bool) {
        while let newline = lineBuffer.firstIndex(of: 0x0A) {
            let lineData = lineBuffer.subdata(in: lineBuffer.startIndex..<newline)
            lineBuffer.removeSubrange(lineBuffer.startIndex...newline)
            var line = String(decoding: lineData, as: UTF8.self)
            if line.hasSuffix("\r") { line.removeLast() }
            handleLine(line)
        }
        if final && !lineBuffer.isEmpty {
            var line = String(decoding: lineBuffer, as: UTF8.self)
            if line.hasSuffix("\r") { line.removeLast() }
            handleLine(line)
            lineBuffer.removeAll()
        }
    }

    private func handleLine(_ line: String) {
        if line.isEmpty {
            flushEvent()
            return
        }
        if line.hasPrefix(":") { return }
        let field: String
        var value: String
        if let colon = line.firstIndex(of: ":") {
            field = String(line[line.startIndex..<colon])
            value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            field = line
            value = ""
        }
        if field == "event" {
            eventName = value
        } else if field == "data" {
            dataLines.append(value)
        }
    }

    private func flushEvent() {
        guard eventName != nil || !dataLines.isEmpty else { return }
        let kind = eventName ?? "message"
        let payload = dataLines.joined(separator: "\n")
        eventName = nil
        dataLines.removeAll()
        if kind == "done" || kind == "error" { sawTerminal = true }
        emit(kind, payload)
    }
}
