import AppKit
import ApplicationServices

struct HookEvent {
    enum Kind {
        case mouseDown
        case mouseUp
        case keyDown
        case flagsChanged
    }

    let kind: Kind
    let point: CGPoint
    let button: Int
    let keyCode: CGKeyCode
    let flags: CGEventFlags
    let isRepeat: Bool
    let dragDistance: CGFloat
    let timestamp: TimeInterval
}

enum Permissions {
    static func accessibilityTrusted(prompt: Bool) -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let options = [key: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }
}

struct AppInfo {
    let pid: pid_t
    let name: String
    let bundleId: String
    let executable: String

    var aliases: [String] {
        [name, bundleId, executable]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
    }

    static func frontmost() -> AppInfo? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return AppInfo(
            pid: app.processIdentifier,
            name: app.localizedName ?? "",
            bundleId: app.bundleIdentifier ?? "",
            executable: app.executableURL?.lastPathComponent ?? ""
        )
    }
}

/// Global CGEventTap. The tap runs on its own thread and only appends events to
/// a queue; the main pump drains it. Synthesized key events are tagged with a
/// magic user-data value and ignored on the way back in.
final class SelectionMonitor {
    static let shared = SelectionMonitor()

    private let lock = NSLock()
    private var queue: [HookEvent] = []
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var tapRunLoop: CFRunLoop?
    private var thread: Thread?
    private var installedFlag = false
    private var lastErrorText = ""
    private var leftDownPoint: CGPoint?
    private let magic: Int64 = 0x5345_4C41

    var installed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return installedFlag
    }

    var lastError: String {
        lock.lock()
        defer { lock.unlock() }
        return lastErrorText
    }

    func install(completion: @escaping (Bool, String?) -> Void) {
        lock.lock()
        if installedFlag {
            lock.unlock()
            DispatchQueue.main.async { completion(true, nil) }
            return
        }
        let alreadyStarting = thread != nil
        lock.unlock()
        if alreadyStarting { return }

        let worker = Thread { [weak self] in
            guard let self else { return }
            self.runTapThread(completion: completion)
        }
        worker.name = "SelectionEventTap"
        worker.stackSize = 512 * 1024
        lock.lock()
        thread = worker
        lock.unlock()
        worker.start()
    }

    private func runTapThread(completion: @escaping (Bool, String?) -> Void) {
        let eventMask: CGEventMask =
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.leftMouseUp.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.rightMouseUp.rawValue) |
            (1 << CGEventType.otherMouseDown.rawValue) |
            (1 << CGEventType.otherMouseUp.rawValue) |
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.keyUp.rawValue) |
            (1 << CGEventType.flagsChanged.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<SelectionMonitor>.fromOpaque(refcon).takeUnretainedValue()
            monitor.handle(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }

        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: eventMask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            finishInstallFailure("无法创建事件 tap（缺少辅助功能权限或系统限制）", completion: completion)
            return
        }
        guard let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
            finishInstallFailure("无法创建事件 tap 的 run loop source", completion: completion)
            return
        }

        lock.lock()
        tap = port
        source = runLoopSource
        tapRunLoop = CFRunLoopGetCurrent()
        installedFlag = true
        lastErrorText = ""
        lock.unlock()

        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        DispatchQueue.main.async { completion(true, nil) }

        CFRunLoopRun()

        lock.lock()
        installedFlag = false
        tap = nil
        source = nil
        tapRunLoop = nil
        thread = nil
        lock.unlock()
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CFMachPortInvalidate(port)
    }

    private func finishInstallFailure(_ message: String, completion: @escaping (Bool, String?) -> Void) {
        lock.lock()
        lastErrorText = message
        thread = nil
        lock.unlock()
        DispatchQueue.main.async { completion(false, message) }
    }

    func uninstall() {
        lock.lock()
        let runningLoop = tapRunLoop
        let port = tap
        installedFlag = false
        lock.unlock()
        if let port { CGEvent.tapEnable(tap: port, enable: false) }
        if let runningLoop { CFRunLoopStop(runningLoop) }
    }

    func drain() -> [HookEvent] {
        lock.lock()
        defer { lock.unlock() }
        guard !queue.isEmpty else { return [] }
        let events = queue
        queue.removeAll(keepingCapacity: true)
        return events
    }

    // MARK: Tap callback

    private func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock()
            let port = tap
            lock.unlock()
            if let port { CGEvent.tapEnable(tap: port, enable: true) }
            return
        }
        if event.getIntegerValueField(.eventSourceUserData) == magic { return }
        let now = Date().timeIntervalSince1970
        let point = event.location
        let flags = event.flags
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            let button = type == .leftMouseDown ? 0 : (type == .rightMouseDown ? 1 : 2)
            if button == 0 { leftDownPoint = point }
            append(HookEvent(kind: .mouseDown, point: point, button: button, keyCode: 0, flags: flags, isRepeat: false, dragDistance: 0, timestamp: now))
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            let button = type == .leftMouseUp ? 0 : (type == .rightMouseUp ? 1 : 2)
            var distance: CGFloat = 0
            if button == 0, let start = leftDownPoint {
                distance = hypot(point.x - start.x, point.y - start.y)
            }
            if button == 0 { leftDownPoint = nil }
            append(HookEvent(kind: .mouseUp, point: point, button: button, keyCode: 0, flags: flags, isRepeat: false, dragDistance: distance, timestamp: now))
        case .keyDown:
            let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
            let repeatKey = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            // Remote-control software can inject a Control keyDown/keyUp pair
            // without a flagsChanged event. Normalize it to the same state event
            // the local keyboard produces.
            if isControlKey(keyCode) {
                var controlFlags = flags
                controlFlags.insert(.maskControl)
                append(HookEvent(kind: .flagsChanged, point: point, button: 0, keyCode: keyCode, flags: controlFlags, isRepeat: false, dragDistance: 0, timestamp: now))
                return
            }
            append(HookEvent(kind: .keyDown, point: point, button: 0, keyCode: keyCode, flags: flags, isRepeat: repeatKey, dragDistance: 0, timestamp: now))
        case .keyUp:
            let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
            if isControlKey(keyCode) {
                var controlFlags = flags
                controlFlags.remove(.maskControl)
                append(HookEvent(kind: .flagsChanged, point: point, button: 0, keyCode: keyCode, flags: controlFlags, isRepeat: false, dragDistance: 0, timestamp: now))
            }
        case .flagsChanged:
            let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
            append(HookEvent(kind: .flagsChanged, point: point, button: 0, keyCode: keyCode, flags: flags, isRepeat: false, dragDistance: 0, timestamp: now))
        default:
            break
        }
    }

    private func isControlKey(_ keyCode: CGKeyCode) -> Bool {
        keyCode == 59 || keyCode == 62
    }

    private func append(_ event: HookEvent) {
        lock.lock()
        queue.append(event)
        if queue.count > 512 { queue.removeFirst(queue.count - 512) }
        lock.unlock()
    }

    // MARK: Synthetic keyboard events

    func currentFlags() -> CGEventFlags {
        CGEventSource.flagsState(.combinedSessionState)
    }

    /// Sends Cmd+C without disturbing a physically held Control key.
    func sendCmdC() {
        let controlHeld = currentFlags().contains(.maskControl)
        if controlHeld {
            postKey(CGKeyCode(59), down: false, flags: [])
            usleep(6000)
        }
        postKey(CGKeyCode(55), down: true, flags: [.maskCommand])
        usleep(6000)
        postKey(CGKeyCode(8), down: true, flags: [.maskCommand])
        usleep(8000)
        postKey(CGKeyCode(8), down: false, flags: [.maskCommand])
        usleep(6000)
        postKey(CGKeyCode(55), down: false, flags: [])
        usleep(6000)
        if controlHeld {
            postKey(CGKeyCode(59), down: true, flags: [.maskControl])
        }
    }

    private func postKey(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags) {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down) else {
            return
        }
        event.flags = flags
        event.setIntegerValueField(.eventSourceUserData, value: magic)
        event.post(tap: .cghidEventTap)
    }
}
