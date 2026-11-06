import Cocoa

final class OverflowItemView: NSView {
    var onClick: (() -> Void)?
    private let palette: Palette
    private let rowWidth: CGFloat
    private let rowHeight: CGFloat
    private let iconView: NSView
    private let labelView: NSTextField
    private var trackingAreaRef: NSTrackingArea?
    private var hovered = false

    init(icon: String, title: String, palette: Palette, width: CGFloat, height: CGFloat) {
        self.palette = palette
        self.rowWidth = width
        self.rowHeight = height
        self.iconView = makeIconView(icon: icon, size: 13, color: palette.text)
        self.labelView = makeTextLabel(title, size: 12, color: palette.text)
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: height))
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.backgroundColor = NSColor.clear.cgColor
        iconView.frame.origin = NSPoint(x: 10, y: (height - iconView.frame.height) / 2)
        labelView.frame.origin = NSPoint(x: 10 + iconView.frame.width + 8, y: (height - labelView.frame.height) / 2)
        addSubview(iconView)
        addSubview(labelView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        if let existing = trackingAreaRef { removeTrackingArea(existing) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingAreaRef = area
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) {
        hovered = true
        layer?.backgroundColor = palette.hover.cgColor
    }

    override func mouseExited(with event: NSEvent) {
        hovered = false
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    override func mouseUp(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if bounds.contains(point) { onClick?() }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class ToolbarWindow {
    let panel: OverlayPanel
    private let card: CardView
    private let contentContainer: NSView
    private let palette: Palette
    private let strings: AppStrings
    private let scale: CGFloat
    private let compact: Bool
    private let actions: [ActionConfig]
    private let visibleActions: [ActionConfig]
    private let overflowActions: [ActionConfig]
    private var actionButtons: [String: HoverButton] = [:]
    private var overflowButton: HoverButton?
    private var closeButton: HoverButton!
    private var overflowPanel: NSPanel?
    private var dragHandle: DragHandleView!
    private(set) var visible = false
    private(set) var lastX = 0
    private(set) var lastY = 0

    var onAction: ((String) -> Void)?
    var onClose: (() -> Void)?
    var onMoved: ((Int, Int) -> Void)?

    var frame: NSRect { panel.frame }
    var isOverflowOpen: Bool { overflowPanel != nil }

    init(actions allActions: [ActionConfig], config: HelperConfig, palette: Palette) {
        self.palette = palette
        self.strings = config.strings
        self.scale = CGFloat(config.toolbar.scale)
        self.compact = config.toolbar.compact
        self.actions = allActions
        let maxVisible = max(1, min(8, config.toolbar.maxVisibleActions))
        self.visibleActions = Array(allActions.prefix(maxVisible))
        self.overflowActions = Array(allActions.dropFirst(maxVisible))

        let contentHeight = (compact ? 34.0 : 40.0) * scale

        // Build the horizontal content row first so the window size is known.
        let row = NSView(frame: .zero)
        var currentX: CGFloat = 0
        var children: [NSView] = []

        let handle = DragHandleView(scale: scale, color: palette.muted)
        handle.toolTip = strings.dragToolbar
        children.append(handle)

        var actionButtonsLocal: [String: HoverButton] = [:]
        for action in visibleActions {
            let content = makeIconLabelContent(
                icon: action.icon,
                label: compact ? nil : action.label,
                iconSize: 14 * scale,
                textSize: 12 * scale,
                color: palette.text,
                spacing: 4 * scale
            )
            let button = HoverButton(
                content: content.view,
                contentSize: content.size,
                padding: NSSize(width: 7 * scale, height: 4 * scale),
                radius: 7,
                hoverColor: palette.hover,
                tooltip: action.label
            )
            actionButtonsLocal[action.id] = button
            children.append(button)
        }

        var overflowLocal: HoverButton?
        if !overflowActions.isEmpty {
            let separator = SeparatorView(scale: scale, color: palette.border)
            children.append(separator)
            let content = makeIconLabelContent(
                icon: "ellipsis",
                label: nil,
                iconSize: 14 * scale,
                textSize: 12 * scale,
                color: palette.text,
                spacing: 0
            )
            let button = HoverButton(
                content: content.view,
                contentSize: content.size,
                padding: NSSize(width: 7 * scale, height: 4 * scale),
                radius: 7,
                hoverColor: palette.hover,
                tooltip: strings.moreActions
            )
            overflowLocal = button
            children.append(button)
        }

        let closeContent = makeIconLabelContent(
            icon: "xmark",
            label: nil,
            iconSize: 14 * scale,
            textSize: 12 * scale,
            color: palette.muted,
            spacing: 0
        )
        let close = HoverButton(
            content: closeContent.view,
            contentSize: closeContent.size,
            padding: NSSize(width: 6 * scale, height: 4 * scale),
            radius: 7,
            hoverColor: palette.hover,
            tooltip: strings.close
        )
        children.append(close)

        let marginX: CGFloat = 6 * scale
        let separatorMargin: CGFloat = 10 * scale
        currentX = marginX
        for child in children {
            let size: NSSize
            if let button = child as? HoverButton {
                size = button.intrinsicContentSize
            } else if let handle = child as? DragHandleView {
                size = handle.intrinsicContentSize
            } else if child is SeparatorView {
                size = NSSize(width: 1 + separatorMargin, height: 16 * scale)
            } else {
                size = child.frame.size
            }
            child.frame = NSRect(x: currentX, y: (contentHeight - size.height) / 2, width: size.width, height: size.height)
            row.addSubview(child)
            currentX += size.width
        }
        currentX += marginX

        let contentWidth = max(currentX, 80)
        row.frame = NSRect(x: 0, y: 0, width: contentWidth, height: contentHeight)

        let windowWidth = contentWidth + 24
        let windowHeight = contentHeight + 24
        self.panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight),
            keyable: false,
            level: .floating
        )
        self.card = CardView(palette: palette, radius: 10)
        self.contentContainer = row
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.alphaValue = 0

        let container = NSView(frame: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight))
        card.frame = NSRect(x: 12, y: 12, width: windowWidth - 24, height: windowHeight - 24)
        row.frame = NSRect(x: 0, y: 0, width: windowWidth - 24, height: windowHeight - 24)
        card.addSubview(row)
        container.addSubview(card)
        panel.contentView = container
        panel.ignoresMouseEvents = false

        self.actionButtons = actionButtonsLocal
        self.overflowButton = overflowLocal
        self.closeButton = close
        self.dragHandle = handle
        handle.onMoved = { [weak self] x, y in
            guard let self else { return }
            self.lastX = x
            self.lastY = y
            self.onMoved?(x, y)
        }
        for action in visibleActions {
            actionButtons[action.id]?.onClick = { [weak self] in self?.onAction?(action.id) }
        }
        overflowButton?.onClick = { [weak self] in self?.showOverflow() }
        close.onClick = { [weak self] in self?.onClose?() }
    }

    // MARK: Show / close

    func show(at point: CGPoint) {
        let size = panel.frame.size
        let work = ScreenGeometry.workArea(containing: point)
        var x = point.x + 8
        var y = point.y - size.height - 12
        if x + size.width > work.maxX - 8 { x = work.maxX - size.width - 8 }
        if x < work.minX + 8 { x = work.minX + 8 }
        if y < work.minY + 8 {
            y = point.y + 12
        }
        if y + size.height > work.maxY - 8 { y = work.maxY - size.height - 8 }
        if y < work.minY + 8 { y = work.minY + 8 }
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        visible = true
        lastX = Int(x.rounded())
        lastY = Int(y.rounded())
    }

    func close() {
        closeOverflow()
        TooltipPresenter.shared.hide()
        panel.orderOut(nil)
        panel.alphaValue = 0
        visible = false
    }

    func contains(screenPoint: CGPoint) -> Bool {
        panel.frame.contains(screenPoint)
    }

    // MARK: Overflow

    func showOverflow() {
        closeOverflow()
        guard !overflowActions.isEmpty, let anchorButton = overflowButton else { return }

        let itemHeight: CGFloat = 30
        let verticalPadding: CGFloat = 6
        var maxContentWidth: CGFloat = 120
        for action in overflowActions {
            let content = makeIconLabelContent(
                icon: action.icon,
                label: action.label,
                iconSize: 13,
                textSize: 12,
                color: palette.text,
                spacing: 8
            )
            maxContentWidth = max(maxContentWidth, content.size.width + 20)
        }
        let cardWidth = maxContentWidth + 12
        let cardHeight = CGFloat(overflowActions.count) * itemHeight + verticalPadding * 2
        let windowWidth = cardWidth + 24
        let windowHeight = cardHeight + 24

        let panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight),
            keyable: false,
            level: .floating
        )
        panel.alphaValue = 0
        let container = NSView(frame: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight))
        let card = CardView(palette: palette, radius: 10)
        card.frame = NSRect(x: 12, y: 12, width: cardWidth, height: cardHeight)
        for (index, action) in overflowActions.enumerated() {
            let item = OverflowItemView(
                icon: action.icon,
                title: action.label,
                palette: palette,
                width: cardWidth - 12,
                height: itemHeight
            )
            item.onClick = { [weak self] in
                self?.closeOverflow()
                self?.onAction?(action.id)
            }
            item.frame.origin = NSPoint(x: 6, y: cardHeight - verticalPadding - CGFloat(index + 1) * itemHeight)
            card.addSubview(item)
        }
        container.addSubview(card)
        panel.contentView = container

        let anchorWindow = anchorButton.window ?? panel
        let anchorRect = anchorWindow.convertToScreen(anchorButton.convert(anchorButton.bounds, to: nil))
        let work = ScreenGeometry.workArea(containing: NSPoint(x: anchorRect.midX, y: anchorRect.midY))
        var x = anchorRect.minX
        var y = anchorRect.minY - windowHeight - 2
        if x + windowWidth > work.maxX - 8 { x = work.maxX - windowWidth - 8 }
        if x < work.minX + 8 { x = work.minX + 8 }
        if y < work.minY + 8 {
            y = anchorRect.maxY + 4
        }
        if y + windowHeight > work.maxY - 8 { y = work.maxY - windowHeight - 8 }
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        if let window = overflowButton?.window {
            window.orderFrontRegardless()
        }
        panel.orderFrontRegardless()
        panel.alphaValue = 1
        overflowPanel = panel
    }

    func closeOverflow() {
        overflowPanel?.orderOut(nil)
        overflowPanel = nil
    }

    func overflowContains(screenPoint: CGPoint) -> Bool {
        guard let panel = overflowPanel else { return false }
        return panel.frame.contains(screenPoint)
    }

    // MARK: Self-test hook

    @discardableResult
    func performActionClick(_ id: String) -> Bool {
        guard let button = actionButtons[id] else { return false }
        button.performClick()
        return true
    }
}
