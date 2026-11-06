import Cocoa

// MARK: - Base panel

class OverlayPanel: NSPanel {
    private let keyable: Bool

    init(contentRect: NSRect, keyable: Bool, level: NSWindow.Level = .floating) {
        self.keyable = keyable
        var style: NSWindow.StyleMask = [.borderless]
        if !keyable { style.insert(.nonactivatingPanel) }
        super.init(contentRect: contentRect, styleMask: style, backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        self.level = level
        isMovableByWindowBackground = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        animationBehavior = .none
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    }

    override var canBecomeKey: Bool { keyable }
    override var canBecomeMain: Bool { false }
}

// MARK: - Card

final class CardView: NSView {
    private let palette: Palette

    init(palette: Palette, radius: CGFloat = 10) {
        self.palette = palette
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = radius
        layer?.borderWidth = 1
        layer?.borderColor = palette.border.cgColor
        layer?.backgroundColor = palette.bg.cgColor
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.28
        layer?.shadowRadius = 9
        layer?.shadowOffset = CGSize(width: 0, height: -2)
        layer?.masksToBounds = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func apply(palette: Palette) {
        layer?.borderColor = palette.border.cgColor
        layer?.backgroundColor = palette.bg.cgColor
    }
}

// MARK: - Small view factories

func makeTextLabel(_ text: String, size: CGFloat, color: NSColor, weight: NSFont.Weight = .regular) -> NSTextField {
    let label = NSTextField(labelWithString: text)
    label.font = Theme.font(size, weight: weight)
    label.textColor = color
    label.backgroundColor = .clear
    label.isBordered = false
    label.drawsBackground = false
    label.lineBreakMode = .byClipping
    label.maximumNumberOfLines = 1
    label.sizeToFit()
    return label
}

func makeIconView(icon: String, size: CGFloat, color: NSColor) -> NSView {
    if let image = ActionIcons.image(named: ActionIcons.symbolName(for: icon), size: size) {
        let view = NSImageView()
        view.image = image
        view.contentTintColor = color
        view.imageScaling = .scaleProportionallyDown
        view.frame = NSRect(x: 0, y: 0, width: size, height: size)
        return view
    }
    let label = makeTextLabel(ActionIcons.fallbackGlyph(for: icon), size: size, color: color)
    return label
}

/// Builds an icon + optional text row with explicit frames (no Auto Layout).
func makeIconLabelContent(
    icon: String?,
    label: String?,
    iconSize: CGFloat,
    textSize: CGFloat,
    color: NSColor,
    spacing: CGFloat
) -> (view: NSView, size: NSSize) {
    let iconView: NSView? = icon.map { makeIconView(icon: $0, size: iconSize, color: color) }
    let textLabel: NSTextField? = label.map { makeTextLabel($0, size: textSize, color: color) }
    let iconWidth = iconView?.frame.width ?? 0
    let textWidth = textLabel?.frame.width ?? 0
    let textHeight = textLabel?.frame.height ?? 0
    let width = iconWidth + (textLabel != nil ? spacing + textWidth : 0)
    let height = max(iconSize, textHeight)
    let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
    if let iconView {
        iconView.frame.origin = NSPoint(x: 0, y: (height - iconSize) / 2)
        container.addSubview(iconView)
    }
    if let textLabel {
        textLabel.frame.origin = NSPoint(x: iconWidth + spacing, y: (height - textHeight) / 2)
        container.addSubview(textLabel)
    }
    return (container, NSSize(width: width, height: height))
}

// MARK: - Hover button

final class HoverButton: NSView {
    var onClick: (() -> Void)?
    var tooltip: String = ""
    var tooltipDelay: TimeInterval = 0.2

    private let contentView: NSView
    private let contentSize: NSSize
    private let padding: NSSize
    private let hoverColor: NSColor
    private let cornerRadius: CGFloat
    private var hovered = false
    private var trackingAreaRef: NSTrackingArea?

    init(content: NSView, contentSize: NSSize, padding: NSSize, radius: CGFloat, hoverColor: NSColor, tooltip: String) {
        self.contentView = content
        self.contentSize = contentSize
        self.padding = padding
        self.hoverColor = hoverColor
        self.cornerRadius = radius
        self.tooltip = tooltip
        super.init(frame: NSRect(x: 0, y: 0, width: contentSize.width + padding.width * 2, height: contentSize.height + padding.height * 2))
        wantsLayer = true
        layer?.cornerRadius = radius
        layer?.backgroundColor = NSColor.clear.cgColor
        contentView.frame = NSRect(
            x: padding.width,
            y: (bounds.height - contentSize.height) / 2,
            width: contentSize.width,
            height: contentSize.height
        )
        addSubview(contentView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize {
        NSSize(width: contentSize.width + padding.width * 2, height: contentSize.height + padding.height * 2)
    }

    override func layout() {
        super.layout()
        contentView.frame = NSRect(
            x: padding.width,
            y: (bounds.height - contentSize.height) / 2,
            width: contentSize.width,
            height: contentSize.height
        )
    }

    override func updateTrackingAreas() {
        if let existing = trackingAreaRef { removeTrackingArea(existing) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingAreaRef = area
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) {
        hovered = true
        layer?.backgroundColor = hoverColor.cgColor
        if !tooltip.isEmpty {
            TooltipPresenter.shared.schedule(tooltip, from: self, delay: tooltipDelay)
        }
    }

    override func mouseExited(with event: NSEvent) {
        hovered = false
        layer?.backgroundColor = NSColor.clear.cgColor
        TooltipPresenter.shared.hide()
    }

    override func mouseDown(with event: NSEvent) {
        // Consume the press so parent drag handlers do not start.
    }

    override func mouseUp(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if bounds.contains(point) {
            onClick?()
        }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func performClick() {
        onClick?()
    }
}

// MARK: - Drag handle (six dots)

final class DragHandleView: NSView {
    var onMoved: ((Int, Int) -> Void)?
    private let scale: CGFloat
    private let color: NSColor
    private var startMouse: NSPoint = .zero
    private var startOrigin: NSPoint = .zero
    private var dragging = false

    init(scale: CGFloat, color: NSColor) {
        self.scale = scale
        self.color = color
        let width = 9.2 * scale + 10 * scale
        let height = 13.8 * scale
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: height))
        toolTip = "拖动工具栏"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize { frame.size }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        color.setFill()
        let dot = 2.2 * scale
        let margin = 1.2 * scale
        let cell = dot + margin * 2
        let totalWidth = cell * 2
        let totalHeight = cell * 3
        let originX = (bounds.width - totalWidth) / 2
        let originY = (bounds.height - totalHeight) / 2
        for row in 0..<3 {
            for column in 0..<2 {
                let rect = NSRect(
                    x: originX + CGFloat(column) * cell + margin,
                    y: originY + CGFloat(row) * cell + margin,
                    width: dot,
                    height: dot
                )
                NSBezierPath(ovalIn: rect).fill()
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        startMouse = NSEvent.mouseLocation
        startOrigin = window?.frame.origin ?? .zero
        dragging = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragging, let window else { return }
        let mouse = NSEvent.mouseLocation
        let origin = NSPoint(x: startOrigin.x + (mouse.x - startMouse.x), y: startOrigin.y + (mouse.y - startMouse.y))
        window.setFrameOrigin(origin)
    }

    override func mouseUp(with event: NSEvent) {
        guard dragging, let window else { return }
        dragging = false
        onMoved?(Int(window.frame.origin.x.rounded()), Int(window.frame.origin.y.rounded()))
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - Separator

final class SeparatorView: NSView {
    private let scale: CGFloat
    private let color: NSColor

    init(scale: CGFloat, color: NSColor) {
        self.scale = scale
        self.color = color
        super.init(frame: NSRect(x: 0, y: 0, width: 1 + 10 * scale, height: 16 * scale))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize { frame.size }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        color.setFill()
        let line = NSRect(x: (bounds.width - 1) / 2, y: 0, width: 1, height: bounds.height)
        line.fill()
    }
}

// MARK: - Resize grip

final class ResizeGripView: NSView {
    var onResizeEnd: ((NSSize) -> Void)?
    private let color: NSColor
    private var startMouse: NSPoint = .zero
    private var startFrame: NSRect = .zero
    private var dragFrame: NSRect = .zero
    private var resizing = false

    init(color: NSColor) {
        self.color = color
        super.init(frame: NSRect(x: 0, y: 0, width: 16, height: 16))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        color.withAlphaComponent(0.7).setStroke()
        for offset in stride(from: CGFloat(3), through: 13, by: 5) {
            let path = NSBezierPath()
            path.lineWidth = 1
            path.move(to: NSPoint(x: bounds.maxX - offset, y: 3))
            path.line(to: NSPoint(x: bounds.maxX - 3, y: bounds.maxY - offset))
            path.stroke()
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        startMouse = NSEvent.mouseLocation
        startFrame = window.frame
        dragFrame = window.frame
        resizing = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard resizing, let window else { return }
        let mouse = NSEvent.mouseLocation
        let deltaX = mouse.x - startMouse.x
        let deltaY = mouse.y - startMouse.y
        let newWidth = min(max(324, startFrame.width + deltaX), 924)
        let newHeight = min(max(224, startFrame.height - deltaY), 924)
        let frame = NSRect(x: startFrame.minX, y: startFrame.maxY - newHeight, width: newWidth, height: newHeight)
        dragFrame = frame
        window.setFrame(frame, display: true)
    }

    override func mouseUp(with event: NSEvent) {
        guard resizing else { return }
        resizing = false
        onResizeEnd?(dragFrame.size)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - Tooltip

final class TooltipPresenter {
    static let shared = TooltipPresenter()

    private var panel: NSPanel?
    private var workItem: DispatchWorkItem?

    func schedule(_ text: String, from view: NSView, delay: TimeInterval) {
        hide()
        guard !text.isEmpty, view.window != nil else { return }
        let item = DispatchWorkItem { [weak self, weak view] in
            guard let self, let view, view.window != nil else { return }
            self.show(text, from: view)
        }
        workItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func show(_ text: String, from view: NSView) {
        guard let viewWindow = view.window else { return }
        let palette = Theme.current
        let label = makeTextLabel(text, size: 11, color: palette.text)
        let contentWidth = label.frame.width + 16
        let contentHeight = label.frame.height + 8
        let cardWidth = contentWidth
        let cardHeight = contentHeight
        let panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: cardWidth + 20, height: cardHeight + 20),
            keyable: false,
            level: .floating
        )
        panel.ignoresMouseEvents = true
        let container = NSView(frame: NSRect(x: 0, y: 0, width: cardWidth + 20, height: cardHeight + 20))
        let card = CardView(palette: palette, radius: 6)
        card.frame = NSRect(x: 10, y: 10, width: cardWidth, height: cardHeight)
        label.frame.origin = NSPoint(x: 8, y: 4)
        card.addSubview(label)
        container.addSubview(card)
        panel.contentView = container

        let viewRect = viewWindow.convertToScreen(view.convert(view.bounds, to: nil))
        var origin = NSPoint(x: viewRect.midX - (cardWidth + 20) / 2, y: viewRect.minY - cardHeight - 20 - 6)
        let work = ScreenGeometry.workArea(containing: NSPoint(x: viewRect.midX, y: viewRect.midY))
        origin.x = min(max(origin.x, work.minX + 2), work.maxX - cardWidth - 22)
        if origin.y < work.minY + 2 { origin.y = viewRect.maxY + 6 }
        panel.setFrameOrigin(origin)
        panel.orderFrontRegardless()
        self.panel = panel
    }

    func hide() {
        workItem?.cancel()
        workItem = nil
        panel?.orderOut(nil)
        panel = nil
    }
}

// MARK: - Screenshot

enum Screenshot {
    struct CaptureResult {
        let ok: Bool
        let width: Int
        let height: Int
        let bytes: Int
        let message: String
    }

    static func ensureDirectory(_ path: String) {
        guard !path.isEmpty else { return }
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    @discardableResult
    static func capture(view: NSView, to path: String) -> CaptureResult {
        view.window?.displayIfNeeded()
        view.displayIfNeeded()
        guard view.bounds.width > 1, view.bounds.height > 1 else {
            return CaptureResult(ok: false, width: 0, height: 0, bytes: 0, message: "view bounds are empty")
        }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return CaptureResult(ok: false, width: 0, height: 0, bytes: 0, message: "cannot allocate bitmap rep")
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            return CaptureResult(ok: false, width: 0, height: 0, bytes: 0, message: "PNG encoding failed")
        }
        let directory = (path as NSString).deletingLastPathComponent
        if !directory.isEmpty { ensureDirectory(directory) }
        do {
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            return CaptureResult(ok: false, width: rep.pixelsWide, height: rep.pixelsHigh, bytes: data.count, message: error.localizedDescription)
        }
        return CaptureResult(ok: true, width: rep.pixelsWide, height: rep.pixelsHigh, bytes: data.count, message: "")
    }
}
