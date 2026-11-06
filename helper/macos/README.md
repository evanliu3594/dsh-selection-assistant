# helper/macos — macOS 划词助手进程

Swift + AppKit 实现的独立助手进程，功能对齐 Windows 版 `helper/SelectionAssistant.ps1`。源码在 `helper/macos/Sources/`，构建产物是 `helper/macos/bin/SelectionAssistant.app`（gitignored）。

接口以 `references/contracts.md` 为准；本目录只实现，不定义接口。

## 构建

```bash
sh scripts/build-macos-helper.sh              # 当前架构
sh scripts/build-macos-helper.sh --universal  # arm64 + x86_64
```

要求 Xcode Command Line Tools（`xcode-select --install`）。脚本调用 `xcrun --find swiftc`，并导出 `xcrun --show-sdk-path` 的 `SDKROOT`。swiftc 的 module cache 与 `TMPDIR` 放在每次构建独立的 `.build/build.XXXXXX` 目录，避免并发构建互相破坏。

产物结构：

```text
SelectionAssistant.app/
  Contents/
    Info.plist                     LSUIElement=true, bundle id com.evanliu3594.dsh-selection-assistant.helper, minimum macOS 13.1
    MacOS/SelectionAssistant      ad-hoc signed binary
```

## 宿主启动约定

宿主用 LaunchServices 启动 app，使辅助功能授权归属于助手自己：

```bash
/usr/bin/defaults write com.evanliu3594.dsh-selection-assistant.helper HelperConfigPath -string <helper-config.json>
/usr/bin/open -n -a <helper/macos/bin/SelectionAssistant.app>
```

macOS 27 的 `open --args` 不传参数，因此配置路径走 UserDefaults。helper 取配置的顺序：

1. 命令行 `--config`
2. UserDefaults `HelperConfigPath`
3. `~/.dsh/selection-assistant/helper-config.json`

## 命令行与 UserDefaults

直跑内层二进制时可用：

```
--config <path>              指定 helper-config.json
--selftest                   不装事件 tap、不连宿主，渲染窗口 + 截图 + pin/缩放断言
--screenshot-dir <dir>       自测或预览截图目录
--no-permission-prompt       不弹辅助功能授权框，仍上报 error 并持续复查
```

通过 `open` 启动时改用 UserDefaults：

| 键 | 类型 | 含义 |
|---|---|---|
| `HelperConfigPath` | String | 配置文件绝对路径 |
| `SuppressPermissionPrompt` | Bool | 等价 `--no-permission-prompt` |
| `ScreenshotDir` | String | 等价 `--screenshot-dir` |

## 生命周期

- 宿主写 `command.json {id,type:"preview",text}`，helper 每 400ms 轮询；新 id 触发预览。
- helper 启动后尽早把 `pid` 写入 `helper-state.json`。宿主停止时按 pid 发 SIGTERM；helper 保存状态、关闭窗口、退出 0。
- helper 每 2 秒 `GET /v1/health`（不带 token）；连续 3 次失败后退出 0。宿主退出或崩溃后约 6 秒清理。
- 同一 dataDir 只允许一个实例；新实例读到存活 pid 后直接退出 0。
- 辅助功能未授权时：用 `AXIsProcessTrustedWithOptions` 提示一次，上报 `error + permissions.accessibility=false`，进程保持运行；每 1.5 秒复查，授权后安装 CGEventTap 并上报 `ready + true`。
- 事件 tap 使用 `CGEventTap`（listenOnly），运行在独立线程；取词发送 ⌘C，若 Control 物理按下会先释放再恢复。

## 文件职责

| 文件 | 职责 |
|---|---|
| `Sources/main.swift` | 入口、参数/UserDefaults、单实例、AppDelegate |
| `Sources/AppController.swift` | 触发状态机、取词、动作分发、SSE、command.json、权限/健康检查、SIGTERM |
| `Sources/Config.swift` | helper-config 解析与夹紧、默认动作、快捷键解析 |
| `Sources/Log.swift` | 本地日志 + `/v1/log` |
| `Sources/Http.swift` | POST/GET、SSE 客户端 |
| `Sources/Clipboard.swift` | 剪贴板保存/清空/读取/还原 |
| `Sources/SelectionMonitor.swift` | CGEventTap、事件队列、⌘C 注入 |
| `Sources/Theme.swift` | 深浅色板、字体、图标、屏幕坐标、双语文案 |
| `Sources/OverlayViews.swift` | NSPanel、卡片、悬停按钮、拖动柄、缩放柄、Tooltip、截图 |
| `Sources/ToolbarWindow.swift` | 工具栏、紧凑模式、溢出弹层 |
| `Sources/ResultWindow.swift` | 结果窗、流式 Markdown、pin、Esc/R/C、缩放重排 |
| `Sources/Markdown.swift` | 粗体、行内代码、代码块、列表 |
| `Sources/Toast.swift` | 复制 Toast |
| `Sources/State.swift` | helper-state.json |
| `Sources/SelfTest.swift` | 离屏截图自测 |

## 自测

```bash
sh scripts/build-macos-helper.sh
helper/macos/bin/SelectionAssistant.app/Contents/MacOS/SelectionAssistant \
  --config <config.json> --selftest --screenshot-dir <dir>
```

通过时最后一行是 `SELFTEST: PASS`，退出码 0。`selftest-result.json` 字段：`ok`、`clicked`、`pinToggled`、`resizeOk`、`done`、`error`、`toolbarShot`、`resultShot`、`toolbarSize`、`resultSize`、`durationMs`、`pid`。

宿主级自动验证：

```bash
node scripts/verify-macos-helper.mjs   # 构建 + 自测 + mock 宿主 SSE + LaunchServices + 健康退出
node scripts/verify-host-macos.mjs     # 真实 HelperManager 启动 app + 预览 SSE + SIGTERM 回收
```

## 已知限制

- 辅助功能授权无法由脚本代授予；授权后的真实拖选、长按 Control、⌘C 取词需人工验收。System Settings 列表里可能显示为“划词助手”。
- 重新编译会改变 ad-hoc 签名，System Settings 里的授权可能需要重新添加。
- 深色主题、溢出菜单视觉、多屏混合 DPI 尚未逐项截图验收。
- 取词依赖剪贴板；部分沙箱应用可能忽略模拟的 ⌘C。
- `advanced.helperPath` 指向自定义路径时，应填 `.app`；填内层二进制会绕过 LaunchServices，权限归属会算到 DSH。
