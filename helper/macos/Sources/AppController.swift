import Cocoa
import Foundation

struct LaunchOptions {
    var configPath: String?
    var selftest = false
    var screenshotDir: String?
    var noPermissionPrompt = false
}

final class AppController {
    // MARK: Configuration and shared services

    let config: HelperConfig
    let options: LaunchOptions
    let state: StateStore
    let strings: AppStrings
    let isSelftest: Bool
    let logger = Logger.shared
    let clipboard = ClipboardManager()
    let monitor = SelectionMonitor.shared

    static let sampleSelectionText = "DeepSeek Harness 是一个本地 AI 智能体运行环境。选中这段文字并长按 Control，就能看到划词助手。"

    static let localPreviewMarkdown: String = {
        let fence = String(repeating: "\u{60}", count: 3)
        return """
        **翻译**（本地预览）

        划词助手：选中任意文字后长按 Control，即可调用 DSH 当前配置的模型。

        - 支持流式输出
        - 支持 **粗体**、\u{60}行内代码\u{60}
        - 支持代码块：

        \(fence)
        const answer = 42
        \(fence)

        当前为本地预览，不调用模型。
        """
    }()

    // MARK: UI

    var toolbar: ToolbarWindow?
    var result: ResultWindow?
    var toast: Toast?
    var sse: SSEStream?
    var localStream: LocalPreviewStream?
    var selftestRunner: SelfTestRunner?

    struct LocalPreviewStream {
        var characters: [Character]
        var position: Int
        var nextTick: TimeInterval
    }

    // MARK: Trigger state

    struct SelectionCandidate {
        let point: CGPoint
        let at: TimeInterval
    }

    var selectionText = ""
    var selectionApp = ""
    private var selectionCandidate: SelectionCandidate?
    private var ctrlDown = false
    private var ctrlDownAt: TimeInterval = 0
    private var ctrlCancelled = true
    private var pendingSelectionTriggerAt: TimeInterval = 0
    private var capturing = false
    private var suppressAutoClose = false
    private var resultSourceText = ""
    private var lastAction: ActionConfig?
    private var shortcutSpec: ShortcutSpec

    // MARK: Runtime state

    private var pumpTimer: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private var shuttingDown = false
    private var tapInstalled = false
    private var permissionPrompted = false
    private var permissionDeniedReported = false
    private var tapErrorReported = false
    private var nextPermissionCheck: TimeInterval = 0
    private var readyReported = false
    private var nextHealthCheck: TimeInterval = 0
    private var healthFailures = 0
    private var healthInFlight = false
    private var nextCommandPoll: TimeInterval = 0
    private var lastCommandId = ""
    private var previewToolbarShotAt: TimeInterval?
    private var previewResultShotAt: TimeInterval?

    init(config: HelperConfig, options: LaunchOptions) {
        self.config = config
        self.options = options
        self.strings = config.strings
        self.isSelftest = options.selftest
        self.state = StateStore(dataDir: config.dataDir)
        self.shortcutSpec = ShortcutSpec.parse(config.trigger.shortcut)
    }

    // MARK: Lifecycle

    func start() {
        let endpoint = config.endpoint.isEmpty ? "(none)" : config.endpoint
        logger.info("助手启动 pid=\(getpid()) endpoint=\(endpoint) mode=\(config.trigger.mode.rawValue) selftest=\(isSelftest) noPermissionPrompt=\(options.noPermissionPrompt)")
        installSignalHandlers()
        startPump()

        if isSelftest {
            suppressAutoClose = true
            if config.trigger.mode == .shortcut && !shortcutSpec.isUsable {
                logger.warn("无法解析快捷键: \(config.trigger.shortcut)")
            }
            selftestRunner = SelfTestRunner(controller: self)
            selftestRunner?.start()
            return
        }

        guard !config.endpoint.isEmpty, !config.token.isEmpty else {
            logger.error("helper-config 缺少 endpoint 或 token")
            shutdown(reason: "缺少 endpoint 或 token", code: 2)
            return
        }
        if config.trigger.mode == .shortcut && !shortcutSpec.isUsable {
            logger.warn("无法解析快捷键: \(config.trigger.shortcut)")
        }
        readCommandBaseline()
        checkPermission(initial: true)
        nextHealthCheck = now() + 2.0
    }

    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                guard let self else { return }
                self.logger.info("收到终止信号")
                self.shutdown(reason: "signal \(sig)", code: 0)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func startPump() {
        let timer = Timer(timeInterval: 0.04, repeats: true) { [weak self] _ in
            self?.pump()
        }
        RunLoop.main.add(timer, forMode: .common)
        pumpTimer = timer
    }

    private func pump() {
        guard !shuttingDown else { return }
        let current = now()

        if !isSelftest {
            for event in monitor.drain() {
                handle(event)
            }
            if tapInstalled && !monitor.installed {
                tapInstalled = false
                readyReported = false
                logger.warn("事件 tap 已失效，重新安装")
            }
            checkLongPress(current)
            checkPendingSelection(current)
            if !tapInstalled && current >= nextPermissionCheck {
                nextPermissionCheck = current + 1.5
                checkPermission(initial: false)
            }
            if current >= nextHealthCheck {
                nextHealthCheck = current + 2.0
                checkHealth()
            }
            if current >= nextCommandPoll {
                nextCommandPoll = current + 0.4
                pollCommandFile()
            }
        }

        tickLocalPreview(current)
        result?.renderIfNeeded()
        result?.animateLoading()
        toast?.tick(current)
        tickPreviewScreenshots(current)
        selftestRunner?.tick(current)
    }

    private func now() -> TimeInterval {
        Date().timeIntervalSince1970
    }

    func shutdown(reason: String, code: Int32) {
        guard !shuttingDown else { return }
        shuttingDown = true
        logger.info("助手退出: \(reason)")
        pumpTimer?.invalidate()
        pumpTimer = nil
        closeAllUI()
        sse?.cancel()
        sse = nil
        localStream = nil
        if !isSelftest {
            monitor.uninstall()
        }
        state.save()
        logger.flush()
        exit(code)
    }

    func closeAllUI() {
        closeToolbar()
        closeResult()
        toast?.close()
        toast = nil
        TooltipPresenter.shared.hide()
    }

    // MARK: Event handling

    private func handle(_ event: HookEvent) {
        switch event.kind {
        case .mouseDown:
            ctrlCancelled = true
            pendingSelectionTriggerAt = 0
            selectionCandidate = nil
            let point = ScreenGeometry.appKitPoint(fromCG: event.point)
            if let resultWindow = result, resultWindow.isVisible,
               config.result.autoClose, !resultWindow.isPinned,
               !resultWindow.contains(screenPoint: point) {
                closeResult()
            }
            if let toolbarWindow = toolbar, toolbarWindow.visible {
                if toolbarWindow.isOverflowOpen {
                    if toolbarWindow.overflowContains(screenPoint: point) { return }
                    toolbarWindow.closeOverflow()
                }
                if !toolbarWindow.contains(screenPoint: point) {
                    closeToolbar()
                }
            }

        case .mouseUp:
            guard event.button == 0, event.dragDistance > 4 else { return }
            let point = ScreenGeometry.appKitPoint(fromCG: event.point)
            selectionCandidate = SelectionCandidate(point: point, at: event.timestamp)
            if config.trigger.mode == .selection {
                pendingSelectionTriggerAt = event.timestamp + Double(config.trigger.captureDelayMs) / 1000.0 + 0.03
            }

        case .keyDown:
            if event.keyCode == 53 {
                if let toolbarWindow = toolbar, toolbarWindow.isOverflowOpen {
                    toolbarWindow.closeOverflow()
                }
                if result?.isVisible == true { closeResult() }
                if toolbar?.visible == true { closeToolbar() }
                ctrlCancelled = true
                return
            }
            if ctrlDown { ctrlCancelled = true }
            if config.trigger.mode == .shortcut,
               !event.isRepeat,
               let candidate = selectionCandidate,
               candidateFresh(candidate, at: event.timestamp),
               shortcutSpec.matches(keyCode: event.keyCode, flags: event.flags) {
                triggerSelection(point: candidate.point, reason: "shortcut")
            }

        case .flagsChanged:
            let ctrlNow = event.flags.contains(.maskControl)
            let isCtrlKey = event.keyCode == 59 || event.keyCode == 62
            if isCtrlKey {
                if ctrlNow && !ctrlDown {
                    ctrlDown = true
                    ctrlDownAt = event.timestamp
                    if config.trigger.mode == .ctrl,
                       let candidate = selectionCandidate,
                       candidateFresh(candidate, at: event.timestamp) {
                        ctrlCancelled = false
                    } else {
                        ctrlCancelled = true
                    }
                } else if !ctrlNow && ctrlDown {
                    ctrlDown = false
                    ctrlCancelled = true
                }
            } else if ctrlDown {
                ctrlCancelled = true
            }
        }
    }

    private func candidateFresh(_ candidate: SelectionCandidate, at time: TimeInterval) -> Bool {
        time - candidate.at <= 5.0
    }

    private func checkLongPress(_ current: TimeInterval) {
        guard config.trigger.mode == .ctrl else { return }
        guard ctrlDown, !ctrlCancelled, let candidate = selectionCandidate else { return }
        let elapsed = (current - ctrlDownAt) * 1000.0
        guard elapsed >= Double(config.trigger.longPressMs) else { return }
        triggerSelection(point: candidate.point, reason: "ctrl-longpress")
    }

    private func checkPendingSelection(_ current: TimeInterval) {
        guard pendingSelectionTriggerAt > 0, current >= pendingSelectionTriggerAt else { return }
        pendingSelectionTriggerAt = 0
        guard let candidate = selectionCandidate else { return }
        triggerSelection(point: candidate.point, reason: "selection")
    }

    private func resetTriggerState() {
        ctrlDown = false
        ctrlDownAt = 0
        ctrlCancelled = true
        pendingSelectionTriggerAt = 0
        selectionCandidate = nil
    }

    // MARK: Capture + trigger

    private func triggerSelection(point: CGPoint, reason: String) {
        guard !capturing, !shuttingDown else { return }
        resetTriggerState()
        guard let app = AppInfo.frontmost() else {
            logger.debug("忽略触发：无法获取前台应用")
            return
        }
        if app.pid == getpid() {
            logger.debug("忽略触发：前台是助手自己的窗口")
            return
        }
        guard appAllowed(app) else {
            logger.debug("忽略触发：应用过滤命中 app=\(app.name)")
            return
        }

        capturing = true
        let text = captureSelectedText()
        capturing = false
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            logger.debug("忽略触发：未取到文本")
            return
        }
        selectionText = text
        selectionApp = app.name.isEmpty ? app.executable : app.name
        logger.info("触发 [\(reason)] app=\(selectionApp) chars=\(text.count)")
        showToolbar(at: point)
    }

    private func captureSelectedText() -> String {
        suppressAutoClose = true
        defer { suppressAutoClose = false }
        let snapshot = clipboard.save()
        if !snapshot.saved {
            logger.warn("剪贴板不可读，取消本次取词")
            return ""
        }
        clipboard.clear()
        monitor.sendCmdC()
        usleep(UInt32(config.trigger.captureDelayMs) * 1000)
        var text = ""
        for attempt in 0..<4 {
            text = clipboard.readText() ?? ""
            if !text.isEmpty { break }
            if attempt < 3 { usleep(50_000) }
        }
        clipboard.restore(snapshot)
        return text
    }

    private func appAllowed(_ app: AppInfo) -> Bool {
        switch config.appFilter.mode {
        case .off:
            return true
        case .blacklist:
            return !matchesFilter(app)
        case .whitelist:
            return matchesFilter(app)
        }
    }

    private func matchesFilter(_ app: AppInfo) -> Bool {
        let aliases = Set(app.aliases)
        return config.appFilter.processes.contains { aliases.contains($0.lowercased()) }
    }

    // MARK: Toolbar

    func showToolbar(at point: CGPoint) {
        closeToolbar()
        let toolbarWindow = ToolbarWindow(actions: config.enabledActions, config: config, palette: Theme.current)
        toolbarWindow.onAction = { [weak self] actionId in self?.performAction(actionId) }
        toolbarWindow.onClose = { [weak self] in self?.closeToolbar() }
        toolbarWindow.onMoved = { [weak self] x, y in self?.state.setToolbarPosition(x: x, y: y) }
        toolbar = toolbarWindow
        toolbarWindow.show(at: point)
    }

    func closeToolbar() {
        toolbar?.close()
        toolbar = nil
    }

    // MARK: Actions

    func performAction(_ actionId: String) {
        guard let action = config.action(id: actionId) else {
            logger.warn("未知动作: \(actionId)")
            return
        }
        guard !selectionText.isEmpty else {
            logger.warn("无选中文本，忽略动作")
            return
        }
        state.setLastActionId(actionId)
        lastAction = action
        resultSourceText = selectionText
        if !isSelftest { closeToolbar() }

        switch action.kind {
        case .copy:
            let ok = clipboard.setText(selectionText)
            showToast(ok ? strings.copied : strings.copyFailed, at: NSEvent.mouseLocation)
            logger.info("动作 copy 完成 ok=\(ok)")
        case .search:
            if let url = searchURL(action: action, text: selectionText) {
                if NSWorkspace.shared.open(url) {
                    logger.info("动作 search 已打开浏览器")
                } else {
                    logger.warn("动作 search 打开浏览器失败")
                }
            } else {
                logger.warn("动作 search URL 无效")
            }
        case .llm:
            startResultStream(action: action, text: selectionText, useLocal: isSelftest)
        }
    }

    private func searchURL(action: ActionConfig, text: String) -> URL? {
        var template = action.searchUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if template.isEmpty { template = "https://www.google.com/search?q={{query}}" }
        let encoded = percentEncode(text)
        return URL(string: template.replacingOccurrences(of: "{{query}}", with: encoded))
    }

    private func percentEncode(_ text: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
    }

    private func showToast(_ text: String, at point: CGPoint) {
        if toast == nil { toast = Toast() }
        toast?.show(text: text, at: point)
    }

    // MARK: Result window and streaming

    func initialResultContentSize() -> NSSize {
        var width = config.result.width
        var height = config.result.height
        if config.result.rememberSize, let remembered = state.rememberedResultSize {
            width = remembered.width
            height = remembered.height
        }
        return NSSize(width: min(max(width, 300), 900), height: min(max(height, 200), 900))
    }

    func startResultStream(action: ActionConfig, text: String, useLocal: Bool = false) {
        closeResult()
        let size = initialResultContentSize()
        let window = ResultWindow(
            config: config,
            palette: Theme.current,
            actionLabel: action.label,
            actionId: action.id,
            contentSize: size
        )
        window.onClose = { [weak self] in self?.closeResult() }
        window.onCopy = { [weak self] in _ = self?.result?.copyResultText() }
        window.onRegenerate = { [weak self] in self?.regenerate() }
        window.onResizeEnd = { [weak self] newSize in
            self?.state.setResultSize(width: Double(newSize.width), height: Double(newSize.height))
        }
        window.suppressAutoClose = isSelftest
        result = window
        lastAction = action
        resultSourceText = text
        suppressAutoClose = isSelftest

        let toolbarFrame = (toolbar?.visible == true) ? toolbar?.frame : nil
        window.show(relativeToToolbar: toolbarFrame, cursorPoint: NSEvent.mouseLocation)
        window.setLoading(true)
        window.setStatus(strings.connectingHost)

        if useLocal || isSelftest || config.endpoint.isEmpty || config.token.isEmpty {
            startLocalPreviewStream()
        } else {
            startSSE(action: action, text: text)
            window.setStatus(strings.generatingStatus)
        }
    }

    func closeResult() {
        sse?.cancel()
        sse = nil
        localStream = nil
        previewResultShotAt = nil
        guard let window = result else { return }
        result = nil
        suppressAutoClose = false
        window.suppressAutoClose = true
        window.close()
    }

    private func regenerate() {
        guard let action = lastAction else { return }
        var text = selectionText
        if text.isEmpty { text = resultSourceText }
        guard !text.isEmpty else { return }
        startResultStream(action: action, text: text, useLocal: isSelftest)
    }

    private func startLocalPreviewStream() {
        localStream = LocalPreviewStream(characters: Array(AppController.localPreviewMarkdown), position: 0, nextTick: 0)
        result?.setStatus(strings.generatingStatus)
    }

    private func tickLocalPreview(_ current: TimeInterval) {
        guard var stream = localStream else { return }
        if current < stream.nextTick { return }
        stream.nextTick = current + 0.09
        let remaining = stream.characters.count - stream.position
        if remaining <= 0 {
            localStream = nil
            result?.setDone()
            previewStreamFinished()
            return
        }
        let count = min(14, remaining)
        let text = String(stream.characters[stream.position..<(stream.position + count)])
        stream.position += count
        result?.appendDelta(text)
        if stream.position >= stream.characters.count {
            localStream = nil
            result?.setDone()
            previewStreamFinished()
        } else {
            localStream = stream
        }
    }

    private func startSSE(action: ActionConfig, text: String) {
        let body: [String: Any] = [
            "requestId": UUID().uuidString,
            "actionId": action.id,
            "text": text,
            "source": ["app": selectionApp],
            "locale": config.locale,
        ]
        let stream = SSEStream()
        sse = stream
        stream.onEvent = { [weak self, weak stream] kind, data in
            guard let self, let stream, self.sse === stream else { return }
            self.handleSSEEvent(kind: kind, data: data)
        }
        stream.start(urlString: config.endpoint + "/v1/action", token: config.token, body: body)
        logger.info("动作 \(action.id) 已发起请求 chars=\(text.count) app=\(selectionApp)")
    }

    private func handleSSEEvent(kind: String, data: String) {
        let object = jsonObject(data)
        switch kind {
        case "meta":
            let provider = object?["provider"] as? String ?? ""
            let model = object?["model"] as? String ?? ""
            let label = object?["label"] as? String ?? ""
            result?.applyMeta(provider: provider, model: model, label: label)
        case "delta":
            if let text = object?["text"] as? String {
                result?.appendDelta(text)
            }
            result?.setStatus(strings.generatingStatus)
        case "done":
            result?.setDone()
            logger.info("SSE done")
            previewStreamFinished()
        case "error":
            let message = (object?["message"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "模型调用失败"
            result?.setError("出错：" + message)
            logger.warn("SSE error message=\(Http.trim(message, 200))")
        case "transport-error":
            let message = data.isEmpty ? "连接失败" : data
            result?.setError("无法连接宿主：" + message)
            logger.warn("SSE transport error: \(Http.trim(message, 200))")
        case "stream-end":
            if let window = result, !window.isDone, window.errorText.isEmpty {
                window.setError("连接已断开，请重试")
            }
            logger.warn("SSE stream ended without done")
        default:
            break
        }
    }

    private func jsonObject(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return object as? [String: Any]
    }

    private func previewStreamFinished() {
        guard !isSelftest, options.screenshotDir != nil else { return }
        previewResultShotAt = now() + 0.9
    }

    // MARK: command.json

    private func commandFilePath() -> String {
        (config.dataDir as NSString).appendingPathComponent("command.json")
    }

    private func readJSONDictionary(_ path: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return object as? [String: Any]
    }

    private func readCommandBaseline() {
        if let object = readJSONDictionary(commandFilePath()),
           let id = object["id"] as? String,
           !id.isEmpty {
            lastCommandId = id
        }
        nextCommandPoll = 0
    }

    private func pollCommandFile() {
        guard let object = readJSONDictionary(commandFilePath()),
              let id = object["id"] as? String,
              !id.isEmpty,
              id != lastCommandId else { return }
        lastCommandId = id
        guard (object["type"] as? String) == "preview" else { return }
        let text = object["text"] as? String ?? ""
        invokePreview(text: text)
    }

    private func invokePreview(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let content = trimmed.isEmpty ? AppController.sampleSelectionText : text
        closeResult()
        closeToolbar()
        selectionText = content
        selectionApp = "preview"

        let screen = NSScreen.main ?? NSScreen.screens.first
        let point: CGPoint
        if let screen {
            point = NSPoint(x: screen.frame.midX - 80, y: screen.frame.midY - 60)
        } else {
            point = NSPoint(x: 400, y: 400)
        }
        showToolbar(at: point)
        if options.screenshotDir != nil, !isSelftest {
            previewToolbarShotAt = now() + 0.6
        }

        if let translate = config.action(id: "translate"), translate.kind == .llm {
            if config.endpoint.isEmpty || config.token.isEmpty {
                startResultStream(action: translate, text: content, useLocal: true)
            } else {
                startResultStream(action: translate, text: content)
            }
        } else {
            let previewAction = ActionConfig(
                id: "preview",
                kind: .llm,
                label: strings.previewTranslate,
                icon: "translate",
                enabled: true,
                order: 0,
                searchUrl: ""
            )
            startResultStream(action: previewAction, text: content, useLocal: true)
        }
        logger.info("预览命令已执行")
    }

    private func tickPreviewScreenshots(_ current: TimeInterval) {
        guard let directory = options.screenshotDir, !isSelftest else { return }
        if let shotAt = previewToolbarShotAt, current >= shotAt {
            previewToolbarShotAt = nil
            if let toolbarWindow = toolbar, toolbarWindow.visible, let view = toolbarWindow.panel.contentView {
                let path = (directory as NSString).appendingPathComponent("toolbar.png")
                let capture = Screenshot.capture(view: view, to: path)
                if capture.ok {
                    logger.info("预览截图 toolbar: \(path) \(capture.width)x\(capture.height)")
                } else {
                    logger.warn("预览截图 toolbar 失败: \(capture.message)")
                }
            }
        }
        if let shotAt = previewResultShotAt, current >= shotAt {
            previewResultShotAt = nil
            if let window = result, window.isVisible, let view = window.panel.contentView {
                let path = (directory as NSString).appendingPathComponent("result.png")
                let capture = Screenshot.capture(view: view, to: path)
                if capture.ok {
                    logger.info("预览截图 result: \(path) \(capture.width)x\(capture.height)")
                } else {
                    logger.warn("预览截图 result 失败: \(capture.message)")
                }
            }
        }
    }

    // MARK: Accessibility permission and event tap

    private func checkPermission(initial: Bool) {
        guard !tapInstalled, !shuttingDown else { return }
        var prompt = false
        if !permissionPrompted {
            prompt = !options.noPermissionPrompt
            permissionPrompted = true
        }
        let trusted = Permissions.accessibilityTrusted(prompt: prompt)
        if trusted {
            if monitor.installed {
                tapInstalled = true
                if !readyReported {
                    readyReported = true
                    postStatus(state: "ready", message: "", accessibility: true)
                }
                return
            }
            monitor.install { [weak self] ok, error in
                guard let self, !self.shuttingDown else { return }
                if ok {
                    self.tapInstalled = true
                    self.logger.info("全局事件 tap 安装成功")
                    if !self.readyReported {
                        self.readyReported = true
                        self.postStatus(state: "ready", message: "", accessibility: true)
                    }
                } else {
                    self.logger.error("事件 tap 安装失败: \(error ?? "unknown")")
                    if !self.tapErrorReported {
                        self.tapErrorReported = true
                        self.postStatus(state: "error", message: error ?? "事件 tap 安装失败", accessibility: true)
                    }
                }
            }
        } else if !permissionDeniedReported {
            permissionDeniedReported = true
            logger.warn("缺少辅助功能权限，等待用户授权")
            postStatus(state: "error", message: strings.accessibilityRequired, accessibility: false)
        }
    }

    private func postStatus(state: String, message: String, accessibility: Bool) {
        guard !isSelftest, !config.endpoint.isEmpty else { return }
        let body: [String: Any] = [
            "state": state,
            "message": message,
            "permissions": ["accessibility": accessibility],
        ]
        let endpoint = config.endpoint
        let token = config.token
        let stateName = state
        DispatchQueue.global(qos: .utility).async {
            if let (status, text) = Http.postJSONSync(urlString: endpoint + "/v1/status", token: token, body: body, timeout: 2.5) {
                Logger.shared.debug("POST /v1/status \(stateName) -> \(status) \(Http.trim(text, 120))")
            } else {
                Logger.shared.warn("POST /v1/status \(stateName) 未返回响应（宿主可能未启动）")
            }
        }
    }

    // MARK: Host health

    private func checkHealth() {
        guard !isSelftest, !healthInFlight, !config.endpoint.isEmpty else { return }
        healthInFlight = true
        Http.getAsync(urlString: config.endpoint + "/v1/health", timeout: 2.0) { [weak self] status in
            DispatchQueue.main.async {
                guard let self, !self.shuttingDown else { return }
                self.healthInFlight = false
                if status == 200 {
                    if self.healthFailures > 0 {
                        self.logger.info("宿主健康检查恢复")
                    }
                    self.healthFailures = 0
                } else {
                    self.healthFailures += 1
                    self.logger.warn("宿主健康检查失败 \(self.healthFailures)/3 status=\(status)")
                    if self.healthFailures >= 3 {
                        self.shutdown(reason: "宿主连续 3 次健康检查失败", code: 0)
                    }
                }
            }
        }
    }
}
