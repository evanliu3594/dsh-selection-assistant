import Cocoa

/// UI-only self test. Never installs the event tap, never contacts the host:
/// shows the toolbar, screenshots it, clicks a real action button, verifies the
/// result window opened, toggles pin twice, renders the local Markdown sample,
/// screenshots the result window and writes selftest-result.json.
final class SelfTestRunner {
    private weak var controller: AppController?
    private let screenshotDir: String
    private let startedAt: TimeInterval
    private var step = 0
    private var stepAt: TimeInterval
    private var doneAt: TimeInterval?
    private var finished = false
    private var clicked = false
    private var pinToggled = false
    private var resizeOk = false
    private var stackOk = false
    private var error = ""
    private var toolbarShot = ""
    private var resultShot = ""
    private var toolbarRect: [Int] = []
    private var resultRect: [Int] = []
    private var toolbarSize = (width: 0, height: 0)
    private var resultSize = (width: 0, height: 0)

    init(controller: AppController) {
        self.controller = controller
        let directory = controller.options.screenshotDir ?? controller.config.dataDir
        self.screenshotDir = directory
        Screenshot.ensureDirectory(directory)
        let start = Date().timeIntervalSince1970
        self.startedAt = start
        self.stepAt = start
    }

    func start() {
        step = 0
        stepAt = Date().timeIntervalSince1970
        controller?.logger.info("自测模式启动，不安装事件 tap、不连接宿主")
    }

    func tick(_ current: TimeInterval) {
        guard !finished, let controller else { return }
        switch step {
        case 0:
            if current - stepAt >= 0.5 {
                controller.selectionText = AppController.sampleSelectionText
                controller.selectionApp = "selftest"
                let screen = NSScreen.main ?? NSScreen.screens.first
                let point: CGPoint
                if let screen {
                    point = NSPoint(x: screen.frame.midX - 80, y: screen.frame.midY - 60)
                } else {
                    point = NSPoint(x: 400, y: 400)
                }
                controller.showToolbar(at: point)
                toolbarRect = Self.rectArray(controller.toolbar?.frame)
                step = 1
                stepAt = current
            }

        case 1:
            if current - stepAt >= 0.6 {
                if let toolbar = controller.toolbar, let view = toolbar.panel.contentView {
                    let path = (screenshotDir as NSString).appendingPathComponent("toolbar.png")
                    let capture = Screenshot.capture(view: view, to: path)
                    if capture.ok {
                        toolbarShot = path
                        toolbarSize = (capture.width, capture.height)
                        toolbarRect = Self.rectArray(toolbar.frame)
                    } else {
                        fail("toolbar 截图失败: \(capture.message)", controller: controller)
                        return
                    }
                } else {
                    fail("工具栏未显示，无法截图", controller: controller)
                    return
                }
                controller.logger.info("自测截图 toolbar: \(toolbarShot) \(toolbarSize.width)x\(toolbarSize.height)")
                step = 2
                stepAt = current
            }

        case 2:
            if current - stepAt >= 0.15 {
                guard let toolbar = controller.toolbar else {
                    fail("工具栏未创建", controller: controller)
                    return
                }
                let actionId: String
                if controller.config.action(id: "translate") != nil {
                    actionId = "translate"
                } else if let first = controller.config.enabledActions.first {
                    actionId = first.id
                } else {
                    actionId = "translate"
                }
                if !toolbar.performActionClick(actionId) {
                    fail("工具栏中找不到动作按钮 \(actionId)", controller: controller)
                    return
                }
                guard let result = controller.result, result.isVisible else {
                    fail("工具栏按钮点击未触发动作", controller: controller)
                    return
                }
                clicked = true
                let first = result.performPinClick()
                if !first {
                    fail("pin 按钮首次点击后未进入钉住状态", controller: controller)
                    return
                }
                if result.panel.level != .statusBar {
                    fail("钉住后窗口层级不是 statusBar", controller: controller)
                    return
                }
                let second = result.performPinClick()
                if second {
                    fail("pin 按钮第二次点击后仍处于钉住状态", controller: controller)
                    return
                }
                let expected: NSWindow.Level = result.defaultTopmost ? .floating : .normal
                if result.panel.level != expected {
                    fail("取消钉住后窗口层级与 defaultTopmost 不一致", controller: controller)
                    return
                }
                pinToggled = true
                let originalFrame = result.frame
                let testSize = NSSize(
                    width: min(924, originalFrame.width + 80),
                    height: min(924, originalFrame.height + 60)
                )
                resizeOk = result.selfTestResize(to: testSize)
                _ = result.selfTestResize(to: originalFrame.size)
                if !resizeOk {
                    fail("结果窗改尺寸后内容区未重排", controller: controller)
                    return
                }

                // Stacking: keep the first window pinned, open a second result
                // window and verify the old one stays, same size, offset (-24,-24).
                let firstWindow = result
                let firstFrame = firstWindow.frame
                let firstSize = firstWindow.contentSize
                if !firstWindow.performPinClick() {
                    fail("再次 pin 第一窗失败", controller: controller)
                    return
                }
                controller.performAction(actionId)
                guard controller.sessions.count >= 2,
                      let secondWindow = controller.result,
                      secondWindow !== firstWindow else {
                    fail("第二次动作未创建独立结果窗", controller: controller)
                    return
                }
                let oldVisible = firstWindow.isVisible
                let sameSize = abs(secondWindow.contentSize.width - firstSize.width) < 1
                    && abs(secondWindow.contentSize.height - firstSize.height) < 1
                let deltaX = secondWindow.frame.origin.x - firstFrame.origin.x
                let deltaY = secondWindow.frame.origin.y - firstFrame.origin.y
                stackOk = oldVisible && sameSize && abs(deltaX + 24) < 1 && abs(deltaY + 24) < 1
                if !stackOk {
                    fail("多窗口堆叠不符合预期 oldVisible=(oldVisible) sameSize=(sameSize) dx=(deltaX) dy=(deltaY)", controller: controller)
                    return
                }
                controller.logger.info("自测点击动作按钮、pin 两次、缩放重排与多窗口堆叠校验通过")
                step = 3
                stepAt = current
            }

        case 3:
            guard let result = controller.result else {
                fail("结果窗已关闭，无法截图", controller: controller)
                return
            }
            if result.isDone {
                if doneAt == nil {
                    doneAt = current
                    controller.logger.info("自测本地样例流完成")
                }
                if current - (doneAt ?? current) >= 0.7 {
                    captureResult(controller)
                    let ok = writeResult(controller)
                    finished = true
                    controller.shutdown(reason: "selftest 完成", code: ok ? 0 : 1)
                }
            } else if current - stepAt > 20 {
                result.setDone()
                result.renderIfNeeded()
                error = "自测超时：未在 20 秒内完成本地样例流"
                controller.logger.error(error)
                captureResult(controller)
                _ = writeResult(controller)
                finished = true
                controller.shutdown(reason: "selftest 超时", code: 1)
            }

        default:
            break
        }
    }

    private func fail(_ message: String, controller: AppController) {
        error = message
        controller.logger.error("自测失败: \(message)")
        if controller.result != nil { captureResult(controller) }
        _ = writeResult(controller)
        finished = true
        controller.shutdown(reason: "selftest 失败", code: 1)
    }

    private func captureResult(_ controller: AppController) {
        guard let result = controller.result, result.isVisible, let view = result.panel.contentView else {
            if error.isEmpty { error = "结果窗不可见，无法截图" }
            return
        }
        let path = (screenshotDir as NSString).appendingPathComponent("result.png")
        let capture = Screenshot.capture(view: view, to: path)
        if capture.ok {
            resultShot = path
            resultSize = (capture.width, capture.height)
            controller.logger.info("自测截图 result: \(path) \(capture.width)x\(capture.height)")
        } else if error.isEmpty {
            error = "result 截图失败: \(capture.message)"
        }
        resultRect = Self.rectArray(result.frame)
    }

    @discardableResult
    private func writeResult(_ controller: AppController) -> Bool {
        let fileManager = FileManager.default
        let toolbarValid = !toolbarShot.isEmpty && fileManager.fileExists(atPath: toolbarShot) && toolbarSize.width >= 50 && toolbarSize.height >= 20
        let resultValid = !resultShot.isEmpty && fileManager.fileExists(atPath: resultShot) && resultSize.width >= 50 && resultSize.height >= 20
        let streamDone = controller.result?.isDone ?? false
        let ok = clicked && pinToggled && resizeOk && stackOk && streamDone && error.isEmpty && toolbarValid && resultValid

        let payload: [String: Any] = [
            "ok": ok,
            "clicked": clicked,
            "pinToggled": pinToggled,
            "resizeOk": resizeOk,
            "stackOk": stackOk,
            "sessionCount": controller.sessions.count,
            "done": streamDone,
            "toolbarShot": toolbarShot,
            "resultShot": resultShot,
            "rect": resultRect,
            "toolbarRect": toolbarRect,
            "resultRect": resultRect,
            "toolbarSize": [toolbarSize.width, toolbarSize.height],
            "resultSize": [resultSize.width, resultSize.height],
            "error": error,
            "durationMs": Int((Date().timeIntervalSince1970 - startedAt) * 1000),
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
        ]

        var directories: [String] = []
        for directory in [controller.config.dataDir, screenshotDir] where !directory.isEmpty && !directories.contains(directory) {
            directories.append(directory)
        }
        var written: [String] = []
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
            for directory in directories {
                Screenshot.ensureDirectory(directory)
                let path = (directory as NSString).appendingPathComponent("selftest-result.json")
                do {
                    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
                    written.append(path)
                } catch {
                    // Try the next directory.
                }
            }
        }

        print("SELFTEST toolbar-shot: \(toolbarShot) (\(toolbarSize.width)x\(toolbarSize.height))")
        print("SELFTEST result-shot: \(resultShot) (\(resultSize.width)x\(resultSize.height))")
        for path in written {
            print("SELFTEST result-json: \(path)")
        }
        print("SELFTEST: \(ok ? "PASS" : "FAIL")")
        if !ok {
            controller.logger.error("自测未通过 clicked=\(clicked) pinToggled=\(pinToggled) resizeOk=\(resizeOk) stackOk=\(stackOk) done=\(streamDone) error=\(error)")
        }
        return ok
    }

    private static func rectArray(_ rect: NSRect?) -> [Int] {
        guard let rect else { return [] }
        return [Int(rect.origin.x.rounded()), Int(rect.origin.y.rounded()), Int(rect.size.width.rounded()), Int(rect.size.height.rounded())]
    }
}
