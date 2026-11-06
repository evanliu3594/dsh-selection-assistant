import Cocoa

final class Toast {
    private var panel: NSPanel?
    private(set) var closeAt: TimeInterval = 0
    private var onClose: (() -> Void)?

    var isVisible: Bool { panel != nil }

    func show(text: String, at point: CGPoint) {
        close()
        let palette = Theme.current
        let label = makeTextLabel(text, size: 13, color: palette.text)
        let cardWidth = label.frame.width + 28
        let cardHeight = label.frame.height + 16
        let windowWidth = cardWidth + 20
        let windowHeight = cardHeight + 20

        let panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight),
            keyable: false,
            level: .floating
        )
        let container = NSView(frame: NSRect(x: 0, y: 0, width: windowWidth, height: windowHeight))
        let card = CardView(palette: palette, radius: 8)
        card.frame = NSRect(x: 10, y: 10, width: cardWidth, height: cardHeight)
        label.frame.origin = NSPoint(x: 14, y: 8)
        card.addSubview(label)
        container.addSubview(card)
        panel.contentView = container

        let work = ScreenGeometry.workArea(containing: point)
        var x = point.x + 8
        var y = point.y - windowHeight - 34
        if x + windowWidth > work.maxX - 8 { x = work.maxX - windowWidth - 8 }
        if x < work.minX + 8 { x = work.minX + 8 }
        if y < work.minY + 8 { y = point.y + 34 }
        if y + windowHeight > work.maxY - 8 { y = work.maxY - windowHeight - 8 }
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        panel.alphaValue = 0.97
        panel.orderFrontRegardless()
        self.panel = panel
        self.closeAt = Date().timeIntervalSince1970 + 1.1
    }

    func tick(_ now: TimeInterval) {
        guard closeAt > 0, now >= closeAt else { return }
        close()
    }

    func close() {
        panel?.orderOut(nil)
        panel = nil
        closeAt = 0
    }
}
