import Cocoa

final class ResultTitleBarView: NSView {
    var borderColor: NSColor = .clear
    private var startMouse: NSPoint = .zero
    private var startOrigin: NSPoint = .zero
    private var dragging = false

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        borderColor.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        startMouse = NSEvent.mouseLocation
        startOrigin = window.frame.origin
        dragging = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragging, let window else { return }
        let mouse = NSEvent.mouseLocation
        window.setFrameOrigin(NSPoint(
            x: startOrigin.x + (mouse.x - startMouse.x),
            y: startOrigin.y + (mouse.y - startMouse.y)
        ))
    }

    override func mouseUp(with event: NSEvent) {
        dragging = false
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class ResultBottomBarView: NSView {
    var borderColor: NSColor = .clear

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        borderColor.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }
}

final class ResultWindow: NSObject, NSWindowDelegate {
    let panel: OverlayPanel
    let actionId: String
    let actionLabel: String
    let config: ResultConfig
    let palette: Palette
    let strings: AppStrings

    var onClose: (() -> Void)?
    var onCopy: (() -> Void)?
    var onRegenerate: (() -> Void)?
    var onResizeEnd: ((NSSize) -> Void)?

    private let card: CardView
    private let titleBar: ResultTitleBarView
    private let titleLabel: NSTextField
    private let modelLabel: NSTextField
    private let pinIconView: NSView
    private let pinButton: HoverButton
    private let closeButton: HoverButton
    private let contentArea: NSView
    private let scrollView: NSScrollView
    private let textView: NSTextView
    private let loadingView: NSView
    private let loadingLabel: NSTextField
    private let progress: NSProgressIndicator
    private let statusLabel: NSTextField
    private let copyButton: HoverButton
    private let regenerateButton: HoverButton
    private let bottomCloseButton: HoverButton
    private let bottomBar: ResultBottomBarView
    private let grip: ResizeGripView
    private var keyMonitor: Any?

    private(set) var contentText = ""
    private(set) var isPinned = false
    private(set) var isDone = false
    private(set) var errorText = ""
    private(set) var hasDelta = false
    private(set) var defaultTopmost: Bool
    private var loadingOn = true
    private var dirty = false
    private var loadingPhase = 0
    private var closing = false
    private var resized = false
    private var provider = ""
    private var model = ""
    var suppressAutoClose = false

    var isVisible: Bool { panel.isVisible }
    var frame: NSRect { panel.frame }
    var contentSize: NSSize {
        NSSize(width: max(300, panel.frame.width - 24), height: max(200, panel.frame.height - 24))
    }

    init(config: HelperConfig, palette: Palette, actionLabel: String, actionId: String, contentSize: NSSize) {
        self.actionId = actionId
        self.actionLabel = actionLabel
        self.config = config.result
        self.palette = palette
        self.strings = config.strings
        self.defaultTopmost = config.result.alwaysOnTop

        var width = contentSize.width
        var height = contentSize.height
        width = min(max(width, 300), 900)
        height = min(max(height, 200), 900)
        let cardWidth = width
        let cardHeight = height
        let windowWidth = cardWidth + 24
        let windowHeight = cardHeight + 24

        self.panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight),
            keyable: true,
            level: config.result.alwaysOnTop ? .floating : .normal
        )
        self.card = CardView(palette: palette, radius: 10)
        self.titleBar = ResultTitleBarView(frame: NSRect(x: 0, y: cardHeight - 38, width: cardWidth, height: 38))
        self.titleBar.borderColor = palette.border
        self.titleBar.wantsLayer = true
        self.titleBar.layer?.backgroundColor = NSColor.clear.cgColor

        self.titleLabel = makeTextLabel(actionLabel, size: 13, color: palette.text, weight: .semibold)
        self.modelLabel = makeTextLabel("", size: 11, color: palette.muted)
        self.modelLabel.isHidden = true

        let pinContent = makeIconLabelContent(icon: "pin", label: nil, iconSize: 12, textSize: 12, color: palette.muted, spacing: 0)
        self.pinIconView = pinContent.view
        self.pinButton = HoverButton(
            content: pinContent.view,
            contentSize: pinContent.size,
            padding: NSSize(width: 8, height: 4),
            radius: 6,
            hoverColor: palette.hover,
            tooltip: strings.pinOnTop
        )

        let closeContent = makeIconLabelContent(icon: "xmark", label: nil, iconSize: 12, textSize: 12, color: palette.muted, spacing: 0)
        self.closeButton = HoverButton(
            content: closeContent.view,
            contentSize: closeContent.size,
            padding: NSSize(width: 8, height: 4),
            radius: 6,
            hoverColor: palette.hover,
            tooltip: strings.closeEsc
        )

        let contentHeight = cardHeight - 38 - 42
        self.contentArea = NSView(frame: NSRect(x: 0, y: 42, width: cardWidth, height: contentHeight))
        self.scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: cardWidth, height: contentHeight))
        self.textView = NSTextView(frame: NSRect(x: 0, y: 0, width: cardWidth, height: contentHeight))
        self.loadingView = NSView(frame: NSRect(x: 0, y: 0, width: cardWidth, height: contentHeight))
        self.loadingLabel = makeTextLabel(strings.generating, size: 13, color: palette.muted)
        self.progress = NSProgressIndicator(frame: NSRect(x: 0, y: 0, width: 160, height: 4))
        self.statusLabel = makeTextLabel("", size: 11, color: palette.muted)

        let copyContent = makeIconLabelContent(icon: "doc.on.doc", label: strings.copy, iconSize: 12, textSize: 12, color: palette.text, spacing: 4)
        self.copyButton = HoverButton(
            content: copyContent.view,
            contentSize: copyContent.size,
            padding: NSSize(width: 10, height: 4),
            radius: 6,
            hoverColor: palette.hover,
            tooltip: strings.copyShortcut
        )
        let regenContent = makeIconLabelContent(icon: "arrow.clockwise", label: strings.regenerate, iconSize: 12, textSize: 12, color: palette.text, spacing: 4)
        self.regenerateButton = HoverButton(
            content: regenContent.view,
            contentSize: regenContent.size,
            padding: NSSize(width: 10, height: 4),
            radius: 6,
            hoverColor: palette.hover,
            tooltip: strings.regenerateShortcut
        )
        let bottomCloseContent = makeIconLabelContent(icon: "xmark", label: strings.close, iconSize: 12, textSize: 12, color: palette.text, spacing: 4)
        self.bottomCloseButton = HoverButton(
            content: bottomCloseContent.view,
            contentSize: bottomCloseContent.size,
            padding: NSSize(width: 10, height: 4),
            radius: 6,
            hoverColor: palette.hover,
            tooltip: strings.closeEsc
        )
        self.bottomBar = ResultBottomBarView(frame: .zero)
        self.grip = ResizeGripView(color: palette.muted)

        super.init()

        panel.delegate = self
        panel.alphaValue = CGFloat(config.result.opacity)
        panel.isMovableByWindowBackground = false

        titleBar.addSubview(titleLabel)
        titleBar.addSubview(modelLabel)
        titleBar.addSubview(pinButton)
        titleBar.addSubview(closeButton)

        pinButton.onClick = { [weak self] in self?.performPinClick() }
        closeButton.onClick = { [weak self] in self?.requestClose() }

        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.documentView = textView

        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.textColor = palette.text
        textView.font = Theme.font(13)
        textView.textContainerInset = NSSize(width: 14, height: 8)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.allowsUndo = false
        textView.usesFindBar = false

        contentArea.addSubview(scrollView)
        loadingView.wantsLayer = true
        loadingView.layer?.backgroundColor = palette.bg.cgColor
        loadingView.addSubview(loadingLabel)
        progress.style = .bar
        progress.isIndeterminate = true
        progress.controlSize = .small
        progress.minValue = 0
        progress.maxValue = 100
        progress.startAnimation(nil)
        loadingView.addSubview(progress)
        contentArea.addSubview(loadingView)

        bottomBar.borderColor = palette.border
        bottomBar.wantsLayer = true
        bottomBar.layer?.backgroundColor = NSColor.clear.cgColor
        bottomBar.addSubview(statusLabel)

        copyButton.onClick = { [weak self] in self?.onCopy?() }
        regenerateButton.onClick = { [weak self] in self?.onRegenerate?() }
        bottomCloseButton.onClick = { [weak self] in self?.requestClose() }
        bottomBar.addSubview(copyButton)
        bottomBar.addSubview(regenerateButton)
        bottomBar.addSubview(bottomCloseButton)

        grip.onResizeEnd = { [weak self] size in
            guard let self else { return }
            self.resized = true
            if self.config.rememberSize {
                self.onResizeEnd?(NSSize(width: max(300, size.width - 24), height: max(200, size.height - 24)))
            }
        }
        contentArea.addSubview(grip)

        card.addSubview(titleBar)
        card.addSubview(contentArea)
        card.addSubview(bottomBar)

        let container = NSView(frame: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight))
        container.addSubview(card)
        panel.contentView = container

        layoutContent()
        setLoading(true)
        setStatus(strings.connectingHost)
    }

    deinit {
        removeKeyMonitor()
    }

    private func layoutContent() {
        let windowSize = panel.contentView?.bounds.size ?? panel.frame.size
        let cardWidth = max(300, windowSize.width - 24)
        let cardHeight = max(200, windowSize.height - 24)
        card.frame = NSRect(x: 12, y: 12, width: cardWidth, height: cardHeight)
        titleBar.frame = NSRect(x: 0, y: cardHeight - 38, width: cardWidth, height: 38)
        let contentHeight = max(0, cardHeight - 80)
        contentArea.frame = NSRect(x: 0, y: 42, width: cardWidth, height: contentHeight)
        scrollView.frame = NSRect(x: 0, y: 0, width: cardWidth, height: contentHeight)
        textView.frame = NSRect(x: 0, y: 0, width: cardWidth, height: contentHeight)
        loadingView.frame = NSRect(x: 0, y: 0, width: cardWidth, height: contentHeight)
        loadingLabel.frame.origin = NSPoint(x: max(0, (cardWidth - loadingLabel.frame.width) / 2), y: contentHeight / 2 + 12)
        progress.frame = NSRect(x: max(0, (cardWidth - 160) / 2), y: max(0, contentHeight / 2 - 12), width: 160, height: 4)
        bottomBar.frame = NSRect(x: 0, y: 0, width: cardWidth, height: 42)
        statusLabel.frame.origin = NSPoint(x: 14, y: (42 - statusLabel.frame.height) / 2)
        var buttonX = cardWidth - 8
        for button in [bottomCloseButton, regenerateButton, copyButton] {
            let size = button.intrinsicContentSize
            buttonX -= size.width
            button.frame = NSRect(x: buttonX, y: (42 - size.height) / 2, width: size.width, height: size.height)
            buttonX -= 2
        }
        grip.frame = NSRect(x: cardWidth - 19, y: 3, width: 16, height: 16)
        layoutTitle()
    }

    private func layoutTitle() {
        let titleY = (38 - titleLabel.frame.height) / 2
        titleLabel.frame.origin = NSPoint(x: 14, y: titleY)
        let closeSize = closeButton.intrinsicContentSize
        let pinSize = pinButton.intrinsicContentSize
        closeButton.frame = NSRect(x: card.frame.width - 6 - closeSize.width, y: (38 - closeSize.height) / 2, width: closeSize.width, height: closeSize.height)
        pinButton.frame = NSRect(x: closeButton.frame.minX - 2 - pinSize.width, y: (38 - pinSize.height) / 2, width: pinSize.width, height: pinSize.height)
        if !modelLabel.isHidden {
            modelLabel.frame.origin = NSPoint(x: titleLabel.frame.maxX + 10, y: (38 - modelLabel.frame.height) / 2)
        }
    }

    /// Self-test hook: resize the window and confirm every region reflowed.
    func selfTestResize(to windowSize: NSSize) -> Bool {
        let current = panel.frame
        let newFrame = NSRect(x: current.origin.x, y: current.origin.y, width: windowSize.width, height: windowSize.height)
        panel.setFrame(newFrame, display: true)
        layoutContent()
        let expectedWidth = windowSize.width - 24
        let expectedHeight = windowSize.height - 24
        let contentHeight = expectedHeight - 80
        return abs(card.frame.width - expectedWidth) < 1
            && abs(card.frame.height - expectedHeight) < 1
            && abs(titleBar.frame.width - expectedWidth) < 1
            && abs(scrollView.frame.width - expectedWidth) < 1
            && abs(scrollView.frame.height - contentHeight) < 1
            && abs(contentArea.frame.height - contentHeight) < 1
            && abs(bottomBar.frame.width - expectedWidth) < 1
            && abs(grip.frame.maxX - (expectedWidth - 3)) < 1
    }

    // MARK: Show / close

    func show(relativeToToolbar toolbarFrame: NSRect?, cursorPoint: CGPoint?) {
        installKeyMonitor()
        let size = panel.frame.size
        var origin: NSPoint
        if config.followToolbar, let toolbarFrame {
            let work = ScreenGeometry.workArea(containing: NSPoint(x: toolbarFrame.midX, y: toolbarFrame.midY))
            var x = toolbarFrame.minX
            var y = toolbarFrame.minY - 6 - size.height
            if y < work.minY + 8 {
                y = toolbarFrame.maxY + 6
            }
            if y + size.height > work.maxY - 8 { y = work.maxY - size.height - 8 }
            if y < work.minY + 8 { y = work.minY + 8 }
            if x + size.width > work.maxX - 8 { x = work.maxX - size.width - 8 }
            if x < work.minX + 8 { x = work.minX + 8 }
            origin = NSPoint(x: x, y: y)
        } else {
            let point = cursorPoint ?? NSPoint(x: NSScreen.main?.frame.midX ?? 0, y: NSScreen.main?.frame.midY ?? 0)
            let work = ScreenGeometry.workArea(containing: point)
            let centered = NSRect(x: work.midX - size.width / 2, y: work.midY - size.height / 2, width: size.width, height: size.height)
            origin = ScreenGeometry.clamp(rect: centered, into: work).origin
        }
        panel.setFrameOrigin(origin)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(textView)
    }

    func requestClose() {
        onClose?()
    }

    func close() {
        guard !closing else { return }
        closing = true
        removeKeyMonitor()
        panel.delegate = nil
        TooltipPresenter.shared.hide()
        panel.orderOut(nil)
    }

    func contains(screenPoint: CGPoint) -> Bool {
        panel.frame.contains(screenPoint)
    }

    // MARK: Streaming state

    func setLoading(_ on: Bool) {
        loadingOn = on
        loadingView.isHidden = !on
        if on {
            loadingPhase = 0
            loadingLabel.stringValue = strings.generating
            progress.startAnimation(nil)
        } else {
            progress.stopAnimation(nil)
        }
    }

    func animateLoading() {
        guard loadingOn else { return }
        loadingPhase = (loadingPhase + 1) % 4
        loadingLabel.stringValue = strings.generating + String(repeating: ".", count: loadingPhase)
    }

    func setStatus(_ text: String, color: NSColor? = nil) {
        statusLabel.stringValue = text
        if let color { statusLabel.textColor = color }
    }

    func appendDelta(_ text: String) {
        if loadingOn { setLoading(false) }
        hasDelta = true
        contentText += text
        dirty = true
    }

    func setDone() {
        isDone = true
        setLoading(false)
        setStatus(strings.done)
        renderIfNeeded()
    }

    func setError(_ message: String) {
        errorText = message
        isDone = true
        setLoading(false)
        dirty = false
        textView.textStorage?.setAttributedString(MarkdownRenderer.error(message, palette: palette))
        setStatus(strings.errorStatus, color: palette.error)
    }

    func applyMeta(provider: String, model: String, label: String) {
        if !label.isEmpty {
            titleLabel.stringValue = label
            titleLabel.sizeToFit()
        }
        if !provider.isEmpty { self.provider = provider }
        if !model.isEmpty { self.model = model }
        let tag = self.model.isEmpty ? self.provider : self.model
        if !tag.isEmpty {
            modelLabel.stringValue = tag
            modelLabel.sizeToFit()
            modelLabel.isHidden = false
            layoutTitle()
        }
        setStatus(strings.generatingStatus)
    }

    func renderIfNeeded() {
        guard dirty else { return }
        dirty = false
        let rendered = MarkdownRenderer.render(contentText, palette: palette)
        textView.textStorage?.setAttributedString(rendered)
        scrollToBottom()
    }

    private func scrollToBottom() {
        guard textView.string.count > 0 else { return }
        let location = max(0, (textView.string as NSString).length - 1)
        textView.scrollRangeToVisible(NSRange(location: location, length: 1))
    }

    func copyResultText() -> String {
        let text = contentText
        guard !text.isEmpty else { return "" }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        let ok = pasteboard.setString(text, forType: .string)
        setStatus(ok ? strings.copied : strings.copyFailed, color: ok ? nil : palette.error)
        return text
    }

    // MARK: Pin

    @discardableResult
    func performPinClick() -> Bool {
        isPinned.toggle()
        panel.level = isPinned ? .statusBar : (defaultTopmost ? .floating : .normal)
        let color = isPinned ? palette.accent : palette.muted
        pinButton.tooltip = isPinned ? strings.unpin : strings.pinOnTop
        applyTint(pinIconView, color)
        return isPinned
    }

    private func applyTint(_ view: NSView, _ color: NSColor) {
        if let imageView = view as? NSImageView {
            imageView.contentTintColor = color
        }
        for subview in view.subviews { applyTint(subview, color) }
    }

    // MARK: Keyboard

    private func installKeyMonitor() {
        removeKeyMonitor()
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self, self.panel.isVisible, event.window === self.panel else { return event }
            if self.handleKey(event) { return nil }
            return event
        }
    }

    private func removeKeyMonitor() {
        if let monitor = keyMonitor {
            NSEvent.removeMonitor(monitor)
            keyMonitor = nil
        }
    }

    private func handleKey(_ event: NSEvent) -> Bool {
        if event.keyCode == 53 {
            requestClose()
            return true
        }
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if !modifiers.isEmpty { return false }
        if event.keyCode == 8 {
            onCopy?()
            return true
        }
        if event.keyCode == 15 {
            onRegenerate?()
            return true
        }
        return false
    }

    // MARK: NSWindowDelegate

    func windowDidResize(_ notification: Notification) {
        guard !closing else { return }
        layoutContent()
        if isDone { scrollToBottom() }
    }

    func windowDidResignKey(_ notification: Notification) {
        guard !closing else { return }
        guard !suppressAutoClose else { return }
        guard !isPinned else { return }
        guard config.autoClose else { return }
        onClose?()
    }
}
