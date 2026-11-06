# dsh-selection-assistant

在任意 Windows 或 macOS 软件里选中文字，长按触发键，弹出划词工具栏；点一下就交给 DSH 当前配置的 DeepSeek 模型翻译、解释、总结、搜索或复制。形态、动作与设置项参考 [Cherry Studio 的划词助手](https://github.com/CherryHQ/cherry-studio)。

[![GitHub](https://img.shields.io/badge/GitHub-evanliu3594-181717?logo=github)](https://github.com/evanliu3594/dsh-selection-assistant) ![平台](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue) ![类型](https://img.shields.io/badge/type-DSH%20bundle-green)

## 它做什么

- 在浏览器、Word、PDF 阅读器、聊天软件等任意应用里选中文字。
- 按住 Ctrl（macOS 为 Control）约 0.5 秒（可调 200–1500ms），鼠标旁弹出浮动工具栏。
- 工具栏上的每个动作都是一次模型调用：默认启用翻译、解释、总结、搜索、复制，润色默认关闭。
- 翻译动作按「目标语言 / 备选语言」自动分流：本地先判断选中文字的语言，非目标语言译成目标语言，已经是目标语言则译成备选语言；两者相同时，目标语言原文直接报错「目标语言与源语言重叠」，不调用模型。判断不了的语言交给模型处理。
- 结果窗流式显示 DeepSeek 输出，可复制、重新生成、调整大小、钉在最前；跟随工具栏、置顶、失焦可自动关闭。
- 模型默认跟随 DSH 的默认模型（桌面版即 DeepSeek 账号模型），也可在设置里单独指定服务与模型。
- 设置页在 DSH 设置 → 划词助手，两个平台共用。

## 依赖

| 依赖 | Windows | macOS |
|---|---|---|
| 系统 | Windows 10/11 | macOS 13.1 及以上 |
| 原生助手 | PowerShell 7 + WPF（未安装时回退 Windows PowerShell 5.1） | Swift + AppKit，打包为 `SelectionAssistant.app` |
| 构建工具 | 无需额外工具 | Xcode Command Line Tools（`xcode-select --install`） |
| 系统权限 | 无 | 辅助功能（全局事件 tap + ⌘C） |
| DSH | 0.2.x 桌面版，需要 `llm` 服务 | 同左 |

不需要额外 API Key、不需要管理员权限、不需要联网安装依赖（模型调用走 DSH 自己的通道）。

## 安装

在 DSH 里安装本 bundle（二选一）：

```text
# 方式一：让 Agent 用 plugin_manager install_bundle 安装本仓库
target: https://github.com/evanliu3594/dsh-selection-assistant

# 方式二：命令行
dsh plugin --profile desktop add https://github.com/evanliu3594/dsh-selection-assistant
```

本地开发时也可以先克隆仓库，再把克隆目录交给 `install_bundle` 或 `dsh plugin add`，用 `link:` 安装便于改代码。

安装后重启 DeepSeek Harness（浏览器产物在启动时装配）。首次加载时插件会：

1. 在 `%USERPROFILE%\.dsh\selection-assistant\`（Windows）或 `~/.dsh/selection-assistant/`（macOS）创建设置与日志；
2. 在 `127.0.0.1` 随机端口启动助手通信服务；
3. Windows 拉起 `helper/SelectionAssistant.ps1`（优先 PowerShell 7，未安装时用 Windows PowerShell 5.1；WPF 界面）；
4. macOS 检查 `helper/macos/bin/SelectionAssistant.app`，缺失或源码更新时运行 `sh scripts/build-macos-helper.sh` 编译，然后通过 LaunchServices 启动这个 app。

打开 设置 → 划词助手，确认状态卡显示「运行中」。

### macOS 辅助功能授权

macOS 需要「辅助功能」权限才能监听全局事件并发送 ⌘C。第一次启动时 helper 会弹出系统授权提示：

1. 打开 系统设置 → 隐私与安全性 → 辅助功能；
2. 勾选 `SelectionAssistant`（列表里可能显示为“划词助手”；如果列表里没有，点 `+` 选择 `helper/macos/bin/SelectionAssistant.app`，不要选 app 里的内层二进制）；
3. 回到 DSH，状态卡应在 2 秒内变为「运行中」；没有变化时点「重启助手」。

权限按「负责进程」判定：辅助功能授权属于 `SelectionAssistant.app` 自己，给 DeepSeek Harness 授权不会让助手获得权限。设置页状态卡提供「打开辅助功能设置」按钮。重新编译 helper 会改变 ad-hoc 签名，系统可能要求重新勾选。

## 使用

1. 在任意应用里用鼠标选中一段文字。
2. 按住 Ctrl（macOS 为 Control）约 0.5 秒，直到工具栏出现（默认触发方式）。
3. 点动作按钮：翻译 / 解释 / 总结 / 搜索 / 复制（润色需在设置里启用）。
4. 结果窗出现在工具栏下方；Esc 关闭，R 重新生成，C 复制。
5. 点结果窗标题栏的 pin 按钮可钉住窗口：钉住后窗口保持最前，点击其他应用不关闭；再点一次取消钉住，恢复设置里的置顶与失焦关闭行为。
6. 手动拖动或缩放结果窗后，几何会固定。下一次划词时，未 pin 的旧窗会被原位同尺寸替换；旧窗已 pin 时旧窗保留，新窗同尺寸并向左下偏移 24 像素（macOS 为 24 点），可继续堆叠。

触发方式可以改成「选中即出现」或「快捷键」，见设置页。

## 设置项

| 分区 | 内容 |
|---|---|
| 状态 | 启用开关、助手进程状态、macOS 辅助功能权限、重启 |
| 触发方式 | 选中文字 / 长按触发键 / 快捷键；长按时长；快捷键 |
| 翻译语言 | 目标语言（默认取本机显示语言）、备选语言（默认 English）；本地判断源语言后分流 |
| 工具栏 | 紧凑模式（只显示图标）、最多直显动作数、缩放 |
| 功能窗口 | 跟随工具栏、记住大小、失焦自动关闭、置顶、透明度；手动调整后固定位置/尺寸 |
| 功能 | 动作启用与排序、编辑提示词、自定义动作、每动作模型覆盖、搜索引擎 |
| 模型 | 服务、模型、推理强度、温度（留空跟随 DSH 默认） |
| 高级 | 助手路径（Windows 为 pwsh 或 powershell）、日志级别、预览工具栏、查看日志 |

设置保存到 `<数据目录>\settings.json`，保存后只重启助手进程，不重启 DSH。

## 数据结构

```text
Windows: %USERPROFILE%\.dsh\selection-assistant\
macOS:   ~/.dsh/selection-assistant/
  settings.json        设置（唯一真源）
  helper-config.json   每次启动助手时写入的运行配置
  helper-state.json    助手记住的结果窗位置/尺寸、工具栏位置等
  command.json         设置页「预览工具栏」的一次性命令
  helper.log           助手日志
  plugin.log           宿主插件日志
```

## 架构

```text
任意应用 ──选中文字──▶ 助手进程
                          Windows: PowerShell 7 或 Windows PowerShell 5.1 + WPF
                          macOS:   Swift + AppKit
                          │  全局钩子 / 长按触发 / 复制取词
                          ▼
                    本机回环 HTTP（随机端口 + 每次启动随机 token）
                          ▼
                    DSH Host 插件（Node，ctx.llm）
                          ▼
                    DeepSeek（或 DSH 里配置的任意模型路由）
```

- 宿主半体（`src/`，构建到 `lib/index.js`）：设置持久化、模型调用、助手进程生命周期、两个 HTTP 面。按 `process.platform` 选择 PowerShell 或 Swift 助手。
- 助手进程（`helper/`）：唯一碰操作系统的一层。Windows 优先用 PowerShell 7；未安装时回退 Windows 自带的 PowerShell 5.1，两者共用同一套 WPF 界面。macOS 用 Swift + AppKit，源码在 `helper/macos/Sources/`，由 `swiftc` 编译成 `SelectionAssistant.app`，宿主用 LaunchServices 启动它，保证辅助功能授权算在助手自己头上。
- 设置页（`src/client/`，构建到 `lib/client.js`）：注册在 DSH 设置里的 React 页面，两平台共用。

为什么不把悬浮窗做成 DSH 自己的窗口：DSH 插件宿主运行在独立 Node 子进程里，拿不到 Electron 的 `BrowserWindow`；跨应用置顶窗口只能由独立原生进程提供。

## 安全边界

- 回环服务只绑 `127.0.0.1`，每次启动生成新 token，请求必须带 `Authorization: Bearer`。
- 取词只走「保存剪贴板 → 复制快捷键 → 读剪贴板 → 还原剪贴板」，不读 UI Automation，不截屏。
- 插件不落任何凭据；模型调用复用 DSH 自己的账号/密钥与模型路由。
- 设置页路由只挂在 DSH 自己的 web 服务上，同源、无 CORS 头。
- 助手进程从插件目录运行，日志不含剪贴板内容。
- macOS 只申请辅助功能权限，不申请录屏、输入监控或完全磁盘访问。

## 已知限制

- 支持 Windows 10/11 与 macOS 13.1+；Linux 不支持。
- 取词依赖剪贴板，个别应用（部分游戏、沙箱应用、远程桌面、密码框）可能复制不出文本。
- 应用过滤在 Windows 按进程名匹配，在 macOS 按应用名、Bundle ID 或可执行文件名匹配。
- macOS 从 App Store 或部分沙箱应用取词时，系统可能忽略模拟的 ⌘C。
- macOS 重新编译 helper 后，辅助功能授权可能需要重新勾选。
- 高级区「预览工具栏」需要助手进程正在运行。
- macOS 宿主退出后，助手通过 `/v1/health` 检测到宿主消失并在约 6 秒内退出。
- 不支持 Cherry Studio 的「Ask Agent / 引用到对话」动作；本插件的结果窗不回到 DSH 会话里。
- Windows 优先使用 PowerShell 7；未安装时自动回退 Windows PowerShell 5.1，功能一致，无需额外安装。
- 翻译语言的本地判断是启发式：拉丁语系短句、专有名词可能判断不出来，这类文本交给模型决定；纯汉字日文会按中文处理。
- macOS 需要 Xcode Command Line Tools；没有 `swiftc` 时状态卡会给出安装命令。

## 排错

| 现象 | 处理 |
|---|---|
| 设置里没有「划词助手」入口 | 完整重启 DSH；设置页由启动时装配的浏览器产物提供，刷新页面不够 |
| Windows 状态卡提示找不到 PowerShell | 设置 → 高级 → 助手路径，填 `(Get-Command pwsh).Source` 的输出；没有 PowerShell 7 时填 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| macOS 状态卡提示「需要辅助功能权限」 | 点「打开辅助功能设置」，勾选 SelectionAssistant（可能显示“划词助手”）；不行就重启助手 |
| macOS 状态卡提示无法构建助手 | 运行 `xcode-select --install`，装完点「重启助手」；或手动运行 `sh scripts/build-macos-helper.sh` 看编译错误 |
| 状态卡为「错误」，助手 15 秒未就绪 | 设置 → 高级 → 查看日志；读数据目录下的 `helper.log` |
| 长按没有反应 | 确认 DSH 正在运行、助手状态为「运行中」；Windows 管理员窗口需要同等权限；macOS 确认辅助功能已授权 |
| 工具栏出现但没取到词 | 该应用不支持复制快捷键（或剪贴板被占用）；换到浏览器/记事本验证 |
| 模型报错（凭据/模型不支持） | 到 DSH 设置 → 模型，确认默认模型可用；或在划词助手设置里单独指定模型 |

## 开发与验证

```bash
# 两端通用
node scripts/build.mjs                  # 构建宿主 + 浏览器半体
node scripts/probe.mjs                  # 宿主产物：裸导入 + 冷上下文 apply
node scripts/verify-host.mjs            # 宿主：设置、路由、回环 SSE、鉴权
node scripts/verify-client-bundle.mjs   # 浏览器产物：注册 id / 模块表 / settings.section

# Windows
node scripts/verify-helper-resolve.mjs  # 助手：pwsh / powershell 解析 + helper-config
node --experimental-strip-types scripts/verify-lang.mjs  # 翻译语言检测与目标分流
pwsh -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1  # 助手自测（mock 宿主 + 按钮点击 + 截图）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1  # Windows PowerShell 5.1 自测

# macOS
sh scripts/build-macos-helper.sh        # 编译 Swift 助手 app（宿主首次启动也会自动调用）
sh scripts/build-macos-helper.sh --universal  # arm64 + x86_64 通用包
node scripts/verify-macos-helper.mjs    # 编译 + 窗口自测截图 + mock 宿主 SSE + LaunchServices + 健康退出
node scripts/verify-host-macos.mjs      # 真实 HelperManager 启动 app + 预览 SSE + SIGTERM 回收
```

本机开发前需要 esbuild CLI：执行 `npm install --no-save esbuild`，或用 `ESBUILD_BINARY` 指向已有二进制。

macOS 需要辅助功能授权才能验证真实拖选取词；自动验证覆盖编译、窗口渲染、SSE、LaunchServices 启动与健康退出，真实取词与 ⌘C 需人工验收。

接口契约见 [references/contracts.md](references/contracts.md)，结果窗几何规则见 [references/result-window-geometry.md](references/result-window-geometry.md)，验证记录见 [references/verification.md](references/verification.md)，Cherry Studio 对照研究见 [references/cherry-studio-selection-assistant.md](references/cherry-studio-selection-assistant.md)。

## 许可

MIT。
