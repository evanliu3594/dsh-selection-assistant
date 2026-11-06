import Foundation
import CoreGraphics

enum TriggerMode: String {
    case selection
    case ctrl
    case shortcut
}

enum AppFilterMode: String {
    case off
    case blacklist
    case whitelist
}

enum ActionKind: String {
    case llm
    case search
    case copy
}

struct TriggerConfig {
    var mode: TriggerMode = .ctrl
    var longPressMs: Int = 500
    var shortcut: String = "Ctrl+Alt+Q"
    var captureDelayMs: Int = 120
}

struct ToolbarConfig {
    var compact: Bool = false
    var maxVisibleActions: Int = 6
    var scale: Double = 1.0
}

struct ResultConfig {
    var followToolbar: Bool = true
    var rememberSize: Bool = true
    var autoClose: Bool = true
    var alwaysOnTop: Bool = true
    var opacity: Double = 0.96
    var width: Double = 500
    var height: Double = 400
}

struct AppFilterConfig {
    var mode: AppFilterMode = .off
    var processes: [String] = []
}

struct ActionConfig {
    var id: String
    var kind: ActionKind
    var label: String
    var icon: String
    var enabled: Bool
    var order: Double
    var searchUrl: String
}

struct HelperConfig {
    var version: Int = 1
    var endpoint: String = ""
    var token: String = ""
    var dataDir: String = ""
    var logPath: String = ""
    var locale: String = "zh"
    var debug: Bool = false
    var trigger = TriggerConfig()
    var toolbar = ToolbarConfig()
    var result = ResultConfig()
    var appFilter = AppFilterConfig()
    var actions: [ActionConfig] = []

    var strings: AppStrings { AppStrings.forLocale(locale) }

    var enabledActions: [ActionConfig] {
        actions.filter { $0.enabled }.sorted { lhs, rhs in
            if lhs.order == rhs.order { return lhs.id < rhs.id }
            return lhs.order < rhs.order
        }
    }

    func action(id: String) -> ActionConfig? {
        actions.first { $0.id == id }
    }

    static func defaultDataDir() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".dsh/selection-assistant").path
    }

    /// Loads helper-config.json. Returns nil only when the file cannot be read/parsed.
    static func load(path: String) -> HelperConfig? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any] else { return nil }
        return HelperConfig.from(dictionary: dict)
    }

    static func makeDefault(locale: String = "zh") -> HelperConfig {
        var cfg = HelperConfig()
        cfg.dataDir = defaultDataDir()
        cfg.logPath = (cfg.dataDir as NSString).appendingPathComponent("helper.log")
        cfg.locale = locale == "en" ? "en" : "zh"
        cfg.actions = defaultActions(locale: cfg.locale)
        return cfg
    }

    static func defaultActions(locale: String) -> [ActionConfig] {
        let en = locale == "en"
        return [
            ActionConfig(id: "translate", kind: .llm, label: en ? "Translate" : "翻译", icon: "translate", enabled: true, order: 10, searchUrl: ""),
            ActionConfig(id: "explain", kind: .llm, label: en ? "Explain" : "解释", icon: "explain", enabled: true, order: 20, searchUrl: ""),
            ActionConfig(id: "summarize", kind: .llm, label: en ? "Summarize" : "总结", icon: "summarize", enabled: true, order: 30, searchUrl: ""),
            ActionConfig(id: "search", kind: .search, label: en ? "Search" : "搜索", icon: "search", enabled: true, order: 40, searchUrl: ""),
            ActionConfig(id: "copy", kind: .copy, label: en ? "Copy" : "复制", icon: "copy", enabled: true, order: 50, searchUrl: ""),
            ActionConfig(id: "optimize", kind: .llm, label: en ? "Optimize" : "优化", icon: "optimize", enabled: false, order: 60, searchUrl: ""),
        ]
    }

    static func from(dictionary dict: [String: Any]) -> HelperConfig {
        var cfg = HelperConfig()
        let defaults = HelperConfig.makeDefault()

        cfg.version = 1
        cfg.endpoint = string(dict, "endpoint", "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        cfg.token = string(dict, "token", "")
        cfg.dataDir = string(dict, "dataDir", "")
        if cfg.dataDir.isEmpty { cfg.dataDir = defaults.dataDir }
        cfg.logPath = string(dict, "logPath", "")
        if cfg.logPath.isEmpty { cfg.logPath = (cfg.dataDir as NSString).appendingPathComponent("helper.log") }
        cfg.locale = string(dict, "locale", "zh") == "en" ? "en" : "zh"
        cfg.debug = bool(dict, "debug", false)

        let trigger = dictionary(dict["trigger"])
        if let mode = TriggerMode(rawValue: string(trigger, "mode", "ctrl")) {
            cfg.trigger.mode = mode
        }
        cfg.trigger.longPressMs = int(trigger, "longPressMs", 500, 200, 1500)
        let shortcut = string(trigger, "shortcut", "Ctrl+Alt+Q").trimmingCharacters(in: .whitespaces)
        cfg.trigger.shortcut = shortcut.isEmpty ? "Ctrl+Alt+Q" : shortcut
        cfg.trigger.captureDelayMs = int(trigger, "captureDelayMs", 120, 50, 500)

        let toolbar = dictionary(dict["toolbar"])
        cfg.toolbar.compact = bool(toolbar, "compact", false)
        cfg.toolbar.maxVisibleActions = int(toolbar, "maxVisibleActions", 6, 1, 8)
        cfg.toolbar.scale = double(toolbar, "scale", 1.0, 0.85, 1.25)

        let result = dictionary(dict["result"])
        cfg.result.followToolbar = bool(result, "followToolbar", true)
        cfg.result.rememberSize = bool(result, "rememberSize", true)
        cfg.result.autoClose = bool(result, "autoClose", true)
        cfg.result.alwaysOnTop = bool(result, "alwaysOnTop", true)
        cfg.result.opacity = double(result, "opacity", 0.96, 0.2, 1.0)
        cfg.result.width = double(result, "width", 500, 300, 900)
        cfg.result.height = double(result, "height", 400, 200, 900)

        let filter = dictionary(dict["appFilter"])
        if let mode = AppFilterMode(rawValue: string(filter, "mode", "off")) {
            cfg.appFilter.mode = mode
        }
        if let rawProcesses = filter["processes"] as? [Any] {
            cfg.appFilter.processes = rawProcesses.compactMap { value -> String? in
                let name = (value as? String ?? String(describing: value)).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                return name.isEmpty ? nil : name
            }
        }

        let hasActionsField = dict.keys.contains("actions")
        var actions: [ActionConfig] = []
        if let rawActions = dict["actions"] as? [Any] {
            for raw in rawActions {
                guard let item = raw as? [String: Any] else { continue }
                let id = string(item, "id", "")
                if id.isEmpty { continue }
                let kind = ActionKind(rawValue: string(item, "kind", "llm")) ?? .llm
                var label = string(item, "label", "")
                if label.isEmpty {
                    label = cfg.locale == "en" ? string(item, "labelEn", "") : string(item, "labelZh", "")
                }
                if label.isEmpty { label = id }
                var icon = string(item, "icon", "")
                if icon.isEmpty { icon = "sparkle" }
                actions.append(ActionConfig(
                    id: id,
                    kind: kind,
                    label: label,
                    icon: icon,
                    enabled: bool(item, "enabled", true),
                    order: double(item, "order", 0, -10000, 10000),
                    searchUrl: string(item, "searchUrl", "")
                ))
            }
        }
        cfg.actions = hasActionsField ? actions : defaultActions(locale: cfg.locale)
        return cfg
    }

    // MARK: JSON helpers

    private static func dictionary(_ value: Any?) -> [String: Any] {
        value as? [String: Any] ?? [:]
    }

    private static func string(_ dict: [String: Any], _ key: String, _ fallback: String) -> String {
        guard let value = dict[key] else { return fallback }
        if let s = value as? String { return s }
        if value is NSNull { return fallback }
        return String(describing: value)
    }

    private static func bool(_ dict: [String: Any], _ key: String, _ fallback: Bool) -> Bool {
        guard let value = dict[key] else { return fallback }
        if let n = value as? NSNumber { return n.boolValue }
        if let b = value as? Bool { return b }
        if let s = value as? String {
            switch s.lowercased() {
            case "true", "1", "yes": return true
            case "false", "0", "no": return false
            default: return fallback
            }
        }
        return fallback
    }

    private static func double(_ dict: [String: Any], _ key: String, _ fallback: Double, _ lower: Double, _ upper: Double) -> Double {
        guard let value = dict[key] else { return fallback }
        var result = fallback
        if let n = value as? NSNumber { result = n.doubleValue }
        else if let s = value as? String, let d = Double(s) { result = d }
        if result.isNaN { return fallback }
        return min(max(result, lower), upper)
    }

    private static func int(_ dict: [String: Any], _ key: String, _ fallback: Int, _ lower: Int, _ upper: Int) -> Int {
        Int(double(dict, key, Double(fallback), Double(lower), Double(upper)).rounded())
    }
}

// MARK: - Shortcut parsing

struct ShortcutSpec {
    var control = false
    var option = false
    var shift = false
    var command = false
    var keyCode: CGKeyCode?
    var keyName = ""

    var isUsable: Bool { keyCode != nil }

    static let ansiKeyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
        "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
        ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
        "tab": 48, "space": 49, "\u{60}": 50, "delete": 51, "escape": 53,
        "return": 36, "enter": 76, "forwarddelete": 117,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79,
        "f19": 80, "f20": 90,
    ]

    static func parse(_ text: String) -> ShortcutSpec {
        var spec = ShortcutSpec()
        let parts = text.split(separator: "+").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        for part in parts {
            let lower = part.lowercased()
            switch lower {
            case "ctrl", "control":
                spec.control = true
            case "alt", "option", "opt":
                spec.option = true
            case "shift":
                spec.shift = true
            case "command", "cmd", "meta", "win", "super":
                spec.command = true
            default:
                var key = lower
                if key == "esc" { key = "escape" }
                if key == "pgup" { key = "pageup" }
                if key == "pgdn" { key = "pagedown" }
                if let code = ansiKeyCodes[key] {
                    spec.keyCode = code
                    spec.keyName = key
                }
            }
        }
        return spec
    }

    var expectedFlags: CGEventFlags {
        var flags: CGEventFlags = []
        if control { flags.insert(.maskControl) }
        if option { flags.insert(.maskAlternate) }
        if shift { flags.insert(.maskShift) }
        if command { flags.insert(.maskCommand) }
        return flags
    }

    func matches(keyCode: CGKeyCode, flags: CGEventFlags) -> Bool {
        guard let expectedKey = self.keyCode, expectedKey == keyCode else { return false }
        let relevant: CGEventFlags = [.maskControl, .maskAlternate, .maskShift, .maskCommand]
        return flags.intersection(relevant) == expectedFlags
    }
}
