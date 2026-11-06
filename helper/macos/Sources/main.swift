import Cocoa
import Foundation

private let helperBundleIdentifier = "com.evanliu3594.dsh-selection-assistant.helper"

private func parseLaunchOptions() -> LaunchOptions {
    var options = LaunchOptions()
    let args = CommandLine.arguments
    var index = 1
    while index < args.count {
        switch args[index] {
        case "--config":
            if index + 1 < args.count {
                options.configPath = args[index + 1]
                index += 2
            } else {
                index += 1
            }
        case "--selftest":
            options.selftest = true
            index += 1
        case "--screenshot-dir":
            if index + 1 < args.count {
                options.screenshotDir = args[index + 1]
                index += 2
            } else {
                index += 1
            }
        case "--no-permission-prompt":
            options.noPermissionPrompt = true
            index += 1
        default:
            index += 1
        }
    }

    // Normal mode is launched by LaunchServices, which does not forward argv.
    // Read the same settings through the app domain written by the defaults CLI.
    let defaults = UserDefaults(suiteName: helperBundleIdentifier) ?? UserDefaults.standard
    if options.configPath == nil, !options.selftest {
        if let path = defaults.string(forKey: "HelperConfigPath")?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty {
            options.configPath = path
        }
    }
    if options.screenshotDir == nil, !options.selftest {
        if let directory = defaults.string(forKey: "ScreenshotDir")?.trimmingCharacters(in: .whitespacesAndNewlines), !directory.isEmpty {
            options.screenshotDir = directory
        }
    }
    if !options.noPermissionPrompt, !options.selftest {
        options.noPermissionPrompt = defaults.bool(forKey: "SuppressPermissionPrompt")
    }
    return options
}

final class HelperAppDelegate: NSObject, NSApplicationDelegate {
    private let options: LaunchOptions
    private var controller: AppController?

    init(options: LaunchOptions) {
        self.options = options
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config: HelperConfig

        if let path = options.configPath {
            if let loaded = HelperConfig.load(path: path) {
                config = loaded
            } else if options.selftest {
                config = HelperConfig.makeDefault()
                configureLogger(config: config, options: options)
                Logger.shared.warn("自测模式无法读取配置 \(path)，使用默认配置")
            } else {
                let fallback = HelperConfig.makeDefault()
                configureLogger(config: fallback, options: options, forceSilent: true)
                Logger.shared.error("无法读取配置文件: \(path)")
                Logger.shared.flush()
                exit(2)
            }
        } else if options.selftest {
            config = HelperConfig.makeDefault()
        } else {
            let defaultPath = (HelperConfig.defaultDataDir() as NSString).appendingPathComponent("helper-config.json")
            if let loaded = HelperConfig.load(path: defaultPath) {
                config = loaded
            } else {
                let fallback = HelperConfig.makeDefault()
                configureLogger(config: fallback, options: options, forceSilent: true)
                Logger.shared.error("无法读取配置文件: \(defaultPath)")
                Logger.shared.flush()
                exit(2)
            }
        }

        configureLogger(config: config, options: options)

        if !options.selftest {
            guard !config.endpoint.isEmpty, !config.token.isEmpty else {
                Logger.shared.error("helper-config 缺少 endpoint 或 token")
                Logger.shared.flush()
                exit(2)
            }
            if let existingPid = Self.readHelperPid(dataDir: config.dataDir),
               existingPid > 0,
               existingPid != getpid(),
               kill(existingPid, 0) == 0 {
                Logger.shared.warn("已存在同一 dataDir 的助手进程 pid=\(existingPid)，本次启动退出")
                Logger.shared.flush()
                exit(0)
            }
        }

        let appController = AppController(config: config, options: options)
        controller = appController
        appController.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.closeAllUI()
    }

    private func configureLogger(config: HelperConfig, options: LaunchOptions, forceSilent: Bool = false) {
        let fallback = (config.dataDir as NSString).appendingPathComponent("helper.log")
        let silent = options.selftest || forceSilent
        Logger.shared.configure(
            path: config.logPath,
            fallbackPath: fallback,
            endpoint: silent ? "" : config.endpoint,
            token: silent ? "" : config.token,
            debug: config.debug
        )
    }

    private static func readHelperPid(dataDir: String) -> pid_t? {
        let path = (dataDir as NSString).appendingPathComponent("helper-state.json")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              let number = dictionary["pid"] as? NSNumber else { return nil }
        let pid = number.int32Value
        return pid > 0 ? pid_t(pid) : nil
    }
}

URLCache.shared = URLCache(memoryCapacity: 1_000_000, diskCapacity: 0, diskPath: nil)

let options = parseLaunchOptions()
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = HelperAppDelegate(options: options)
application.delegate = delegate
application.run()
