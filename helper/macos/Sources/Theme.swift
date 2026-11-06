import Cocoa
import ApplicationServices

// MARK: - Colors

extension NSColor {
    /// Accepts #RGB, #RRGGBB, #AARRGGBB (alpha first, like the Windows helper's palette).
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 {
            var expanded = ""
            for ch in s { expanded.append(ch); expanded.append(ch) }
            s = expanded
        }
        var value: UInt64 = 0
        Scanner(string: s).scanHexInt64(&value)
        let r, g, b, a: CGFloat
        if s.count == 8 {
            a = CGFloat((value >> 24) & 0xFF) / 255.0
            r = CGFloat((value >> 16) & 0xFF) / 255.0
            g = CGFloat((value >> 8) & 0xFF) / 255.0
            b = CGFloat(value & 0xFF) / 255.0
        } else {
            a = 1.0
            r = CGFloat((value >> 16) & 0xFF) / 255.0
            g = CGFloat((value >> 8) & 0xFF) / 255.0
            b = CGFloat(value & 0xFF) / 255.0
        }
        self.init(srgbRed: r, green: g, blue: b, alpha: a)
    }
}

struct Palette {
    let bg: NSColor
    let border: NSColor
    let text: NSColor
    let muted: NSColor
    let hover: NSColor
    let accent: NSColor
    let codeBg: NSColor
    let error: NSColor

    static let light = Palette(
        bg: NSColor(hex: "#FFFFFF"),
        border: NSColor(hex: "#E6E6EC"),
        text: NSColor(hex: "#1F2329"),
        muted: NSColor(hex: "#6B7280"),
        hover: NSColor(hex: "#F2F3F5"),
        accent: NSColor(hex: "#4D6BFE"),
        codeBg: NSColor(hex: "#F5F6F8"),
        error: NSColor(hex: "#D9363E")
    )

    static let dark = Palette(
        bg: NSColor(hex: "#2B2D31"),
        border: NSColor(hex: "#3F4147"),
        text: NSColor(hex: "#E8E8EA"),
        muted: NSColor(hex: "#9CA3AF"),
        hover: NSColor(hex: "#37393F"),
        accent: NSColor(hex: "#4D6BFE"),
        codeBg: NSColor(hex: "#1F2023"),
        error: NSColor(hex: "#F87171")
    )
}

enum Theme {
    static var isDark: Bool {
        let appearance = NSApp.effectiveAppearance
        return appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }

    static var current: Palette {
        isDark ? .dark : .light
    }

    static func font(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.systemFont(ofSize: size, weight: weight)
    }

    static func monoFont(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.monospacedSystemFont(ofSize: size, weight: weight)
    }
}

// MARK: - Screen geometry

enum ScreenGeometry {
    /// Main display height in points. CGEvent locations use a top-left origin on the
    /// main display, AppKit uses a bottom-left origin.
    static var mainDisplayHeight: CGFloat {
        if let screen = NSScreen.screens.first { return screen.frame.height }
        return CGDisplayBounds(CGMainDisplayID()).height
    }

    static func appKitPoint(fromCG point: CGPoint) -> CGPoint {
        CGPoint(x: point.x, y: mainDisplayHeight - point.y)
    }

    static func screen(containing point: CGPoint) -> NSScreen {
        for screen in NSScreen.screens {
            if screen.frame.contains(point) { return screen }
        }
        return NSScreen.main ?? NSScreen.screens.first ?? NSScreen.screens[0]
    }

    static func workArea(containing point: CGPoint) -> NSRect {
        screen(containing: point).visibleFrame
    }

    static func clamp(rect: NSRect, into work: NSRect, margin: CGFloat = 8) -> NSRect {
        var r = rect
        if r.maxX > work.maxX - margin { r.origin.x = work.maxX - margin - r.width }
        if r.minX < work.minX + margin { r.origin.x = work.minX + margin }
        if r.maxY > work.maxY - margin { r.origin.y = work.maxY - margin - r.height }
        if r.minY < work.minY + margin { r.origin.y = work.minY + margin }
        return r
    }

    static var cursorAppKit: CGPoint {
        NSEvent.mouseLocation
    }
}

// MARK: - Localized strings

struct AppStrings {
    let locale: String

    static func forLocale(_ locale: String) -> AppStrings {
        AppStrings(locale: locale == "en" ? "en" : "zh")
    }

    private var en: Bool { locale == "en" }

    var dragToolbar: String { en ? "Drag toolbar" : "拖动工具栏" }
    var moreActions: String { en ? "More actions" : "更多动作" }
    var close: String { en ? "Close" : "关闭" }
    var closeEsc: String { en ? "Close (Esc)" : "关闭 (Esc)" }
    var copy: String { en ? "Copy" : "复制" }
    var copyShortcut: String { en ? "Copy (C)" : "复制 (C)" }
    var regenerate: String { en ? "Regenerate" : "重新生成" }
    var regenerateShortcut: String { en ? "Regenerate (R)" : "重新生成 (R)" }
    var copied: String { en ? "Copied" : "已复制" }
    var copyFailed: String { en ? "Copy failed" : "复制失败" }
    var generating: String { en ? "Generating" : "正在生成" }
    var generatingStatus: String { en ? "Generating…" : "生成中…" }
    var connectingHost: String { en ? "Connecting to host…" : "连接宿主…" }
    var done: String { en ? "Done" : "完成" }
    var errorStatus: String { en ? "Error" : "出错" }
    var pinOnTop: String { en ? "Pin on top" : "钉在最前" }
    var unpin: String { en ? "Unpin" : "取消钉住" }
    var previewTranslate: String { en ? "Translate (preview)" : "翻译（预览）" }
    var accessibilityRequired: String {
        en
            ? "Accessibility permission is required. Open System Settings → Privacy & Security → Accessibility and allow SelectionAssistant (it may appear as 划词助手)."
            : "需要辅助功能权限：请在“系统设置 → 隐私与安全性 → 辅助功能”中允许 SelectionAssistant（可能显示为“划词助手”）。"
    }
}

// MARK: - Action icons (SF Symbols with ASCII fallback)

enum ActionIcons {
    static func symbolName(for icon: String) -> String {
        switch icon {
        case "translate": return "character.bubble"
        case "explain": return "lightbulb"
        case "summarize": return "text.alignleft"
        case "search": return "magnifyingglass"
        case "copy": return "doc.on.doc"
        case "optimize": return "wand.and.stars"
        case "sparkle": return "sparkles"
        default: return icon
        }
    }

    static func fallbackGlyph(for icon: String) -> String {
        switch icon {
        case "translate": return "文"
        case "explain": return "?"
        case "summarize": return "≡"
        case "search": return "⌕"
        case "copy": return "⧉"
        case "optimize": return "✦"
        case "sparkle": return "✦"
        case "ellipsis": return "…"
        case "xmark": return "✕"
        case "pin", "pin.fill": return "⚲"
        case "arrow.clockwise": return "↻"
        case "doc.on.doc": return "⧉"
        default: return "✦"
        }
    }

    static func image(named name: String, size: CGFloat) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: size, weight: .regular)
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
        let configured = image.withSymbolConfiguration(config) ?? image
        configured.isTemplate = true
        return configured
    }
}
