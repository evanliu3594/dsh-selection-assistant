# Changelog

## 0.2.4 (2026-11-13)

修复远程控制 / 合成输入下无法触发、取词失败。

### 修复

- 钩子只忽略助手自己通过 `SendInput` 产生的事件（`dwExtraInfo` 标记 `SELa`）；ToDesk、远程桌面等工具注入的键盘和鼠标事件按用户输入处理。
- 取词在常规 `SendInput Ctrl+C` 读不到文字时，追加 `WM_COPY` 和 `PostMessage Ctrl+C` 两条兜底路径。
- 修正自测中真实钩子注入事件被误判为「非注入」的断言。

### 验证

- ToDesk 远程控制 + Zed：鼠标拖选 23 个字符后长按 Ctrl，成功弹出助手；日志显示 `WM_COPY` 后 `PostMessage Ctrl+C` 取词成功。
- PowerShell 7.7.0 与 Windows PowerShell 5.1.19041.6456 下 `Add-Type` 编译 PASS；三个 `.ps1` 解析 0 错误。
- 待人工验收：其他远程控制工具、Zed 以外的应用、剪贴板被占用场景。

## 0.2.3 (2026-11-06)

新增翻译语言设置：目标语言与备选语言可在设置页选择，翻译前先本地判断源语言。

### 新增

- 设置页新增「翻译语言」区：目标语言（destLanguage）默认取本机显示语言，备选语言（optLanguage）默认 English；支持 20 种常用语言。
- 本地语言预判模块 `src/lang.ts`：按 Unicode 字符脚本 + 拉丁功能词判断源语言；判断不了返回 unknown，交给模型。
- 翻译分流：源语言已知且不是目标语言 → 译成目标语言；源语言等于目标语言 → 译成备选语言；两者相同 → 直接报错「目标语言与源语言重叠」，不调用模型。
- 新增 `scripts/verify-lang.mjs`（122 项检查）。

### 变更

- `language.target` / `language.fallback` 改存语言代码（如 `zh`、`en`）；旧设置里的「简体中文」「English」等显示名加载时自动迁移。
- 默认目标语言跟随本机显示语言（`Intl.DateTimeFormat().resolvedOptions().locale`），不再固定「简体中文」。
- 已知源语言的翻译提示词直接使用解析后的目标语言，不再重复「如果已经是目标语言就翻译成备选语言」的条件句。

### 修复

- 翻译目标与源语言重叠时不再发模型请求，结果窗显示「目标语言与源语言重叠」。

### 验证

- `node --experimental-strip-types scripts/verify-lang.mjs` PASS（122 项）。
- `build`、`probe`、`verify-host`、`verify-client-bundle`、`verify-helper-resolve`、`helper/selftest.ps1` 全 PASS。
- 独立验证：重叠路径 `prepareCall=0`、模型流 0 次；SSE 先 meta 后 error（code=language-overlap）。
- 实机安装 0.2.3 与设置保存、/v1/action 重叠错误见 `references/verification.md`。
- 仍待人工验收：真实模型对 unknown 文本的兜底、设置页真实渲染与下拉交互。

## 0.2.2 (2026-11-06)

Windows 助手新增 Windows PowerShell 5.1 兜底；有 PowerShell 7 时优先用 7。

### 新增

- Windows 助手支持 Windows PowerShell 5.1：未安装 PowerShell 7 的机器（Windows 10/11 自带 5.1）无需额外安装即可使用，功能与 PS7 一致。
- 宿主按「显式助手路径 → pwsh（解析器/磁盘/裸）→ powershell.exe（磁盘/裸）」解析候选；`verify-helper-resolve.mjs` 增加候选顺序、显式 5.1 与双运行时版本探测。
- 设置页状态卡新增「运行环境」，显示 `PowerShell 7` 或 `Windows PowerShell 5.1`；高级区助手路径提示同步双运行时口径。
- `helper/selftest.ps1` 新增 `-PowerShellExe`，可用 PowerShell 7 宿主驱动 5.1 助手自测。

### 变更

- C# 原生层时钟改为 `Clock.NowMs`（`Stopwatch`），HTTP 客户端改为 `HttpClientHandler`；兼容 .NET Framework 4.8。
- PowerShell 层新增 `Get-NowMs`，替换全部 `[Environment]::TickCount64`；5.1 分支显式引用 `System.Net.Http` 并设置 `Expect: 100-continue=false`、连接数 10。
- 三个助手脚本改为 UTF-8 with BOM；`SelectionHook.cs` 保持 C# 5 语法。
- 助手版本号从 0.1.0 修正为与 package.json 一致的 0.2.2。

### 修复

- 无 PowerShell 7 时宿主不再拒绝 `powershell.exe`；此前该场景会提示找不到 pwsh。

### 验证

- 三组自测全部 PASS=22 SKIP=1 FAIL=0：PS7 宿主 + PS7 助手、PS7 宿主 + PS5.1 助手、PS5.1 宿主 + PS5.1 助手；两运行时 helper.log 均无 ERROR，编译行分别为 PowerShell 7.6.9 与 5.1.19041.6456。
- 与 0.2.1 基线对比：22 条 PASS 断言逐条一致（含点击、pin、多窗口与几何断言）；截图尺寸 403×64 / 524×424。
- 双运行时 Add-Type 编译 PASS；`Clock.NowMs` 单调；C#5 约束扫描全项 0 命中；`[Environment]::TickCount64` 可执行调用 0 处。
- `probe`、`verify-host`、`verify-client-bundle`、`verify-helper-resolve` 全 PASS；构建产物哈希可重复。
- 宿主真实 spawn 5.1 的端到端与 DSH 实机安装验收见 `references/verification.md`。
- 仍待人工验收：真实交互桌面下的 5.1 全局钩子/SendInput、5.1 多屏混合 DPI 与深色主题、pin 叠窗真实鼠标交互。

## 0.2.1 (2026-11-06)

结果窗几何固化与多窗口堆叠。

### 新增

- 所有模型结果窗（翻译、解释、总结、润色）共享一套位置与尺寸记忆：用户手动拖动或缩放后写入 `helper-state.json`，后续结果窗沿用。
- 当前结果窗未 pin 时，下一次结果窗在原位、同尺寸出现；当前结果窗 pin 时保留旧窗，新窗同尺寸并向左下偏移 24 像素/点，可继续堆叠多个 pin 窗口。
- 每个结果窗独立流式输出、关闭、复制、重新生成、pin 与失焦行为。
- 设置页「功能窗口」增加行为说明。

### 变更

- `helper-state.json` 增加 `resultX`/`resultY`（窗口原点）；尺寸继续使用 `resultWidth`/`resultHeight`。
- `rememberSize` 继续控制尺寸记忆；位置记忆独立生效。

### 修复

- Windows：`Show-ResultWindow` 的 `$win.Activate()` 返回值混入函数输出，`Start-ResultStream` 收到数组而不是结果窗上下文，`$ctx.App` 报错导致结果流无法启动。改为 `[void]$win.Activate()`。

### 验证

- macOS 构建 PASS（646944 字节，arm64 13.1）；自测 PASS，`ok/clicked/pinToggled/resizeOk/stackOk/done` 全 true，`sessionCount=2`。
- macOS 助手端到端 `verify-macos-helper` PASS（LaunchServices、status/log、preview SSE、截图、健康退出）。
- macOS 宿主管线 `verify-host-macos` PASS（真实 HelperManager 构建启动、预览动作、SIGTERM 回收）。
- 通用门 `probe`、`verify-host`、`verify-client-bundle` PASS。
- Windows 实机：`helper/selftest.ps1` PASS=22 SKIP=1 FAIL=0（含多窗口断言）；几何专项测试 PASS；`probe`、`verify-host`、`verify-client-bundle`、`verify-helper-resolve` PASS。
- Windows 实机安装：`plugin_manager` 升级到 0.2.1（`application: applied`）；预览窗拖动/缩放后保存 `resultX/resultY/resultWidth/resultHeight`，下一次结果窗沿用保存的 rect（1380,203,358×450）。
- Windows 仍待实机验收：pin 叠窗真实交互、多屏混合 DPI、重启后的几何恢复、真实划词端到端。

## 0.2.0 (2026-11-06)

新增 macOS 支持。Windows 行为与 0.1.0 保持一致。

### 新增

- macOS 13.1 起新增原生助手（`helper/macos/Sources/`，Swift + AppKit）：全局事件 tap、拖选 + 长按 Control、选中即触发、快捷键、⌘C 剪贴板取词、应用名/Bundle ID 过滤、工具栏、溢出菜单、结果窗、流式 Markdown、pin、Toast、Esc/R/C。
- macOS 助手打包为 `SelectionAssistant.app`，宿主用 LaunchServices 启动，使辅助功能授权归属于助手自己；未授权时助手保持运行并每 1.5 秒复查，授权后自动安装事件 tap。
- macOS 宿主健康看门狗：助手每 2 秒检查宿主 `/v1/health`，宿主退出后约 6 秒内退出；宿主按 pid 停止旧实例。
- 宿主首次启动自动运行 `scripts/build-macos-helper.sh` 编译助手（需要 Xcode Command Line Tools），源码更新后增量重编；支持 `--universal` 生成 arm64 + x86_64 通用 app。
- 设置页按平台切换文案与提示：Windows 长按 Ctrl / macOS 长按 Control，应用过滤在 macOS 按应用名或 Bundle ID 匹配。
- 设置页 macOS 权限卡：显示 granted / denied / unknown，denied 时提供「打开辅助功能设置」按钮。
- 宿主新增 `platform.helperKind`、`platform.permissions.accessibility` 与 `POST /helper/open-permissions`。
- 新增 `scripts/verify-macos-helper.mjs`、`scripts/verify-host-macos.mjs` 与 `scripts/build-macos-helper.sh`。
- 文档与契约同步双端说明。

### 变更

- `Settings.advanced.pwshPath` 改名为 `helperPath`；旧 settings.json 在缺少新字段时自动迁移，之后只写新字段。
- Row config 支持 `helperPath`，保留 `pwshPath` 作为旧配置回退。
- `StateDto.platform` 由 `{ pwsh }` 扩展为 `{ helper, helperKind, supported, reason, permissions }`。

### 验证

- 宿主：`probe`、`verify-host`（设置迁移、平台分派、8 条设置路由、回环 SSE、鉴权、权限帧）PASS。
- 浏览器：`verify-client-bundle` PASS。
- macOS 构建：native arm64 PASS（624016 字节，13.1）；universal PASS（arm64 + x86_64，1231712 字节）。
- macOS 助手自测：PASS；`ok/clicked/pinToggled/resizeOk/done` 全 true；工具栏与结果窗截图正常。
- macOS 助手端到端：`verify-macos-helper` PASS（LaunchServices 启动、权限 error 帧、预览 SSE、截图、健康退出）。
- macOS 宿主管线：`verify-host-macos` PASS（真实 HelperManager 自动构建、UserDefaults、预览动作、SIGTERM 回收）。
- 权限归属实测：`open` 启动的 app 是 responsible pid、AX trust=false；直接 spawn 内层二进制时 responsible 是 DSH、trust=true。
- 待人工验收：辅助功能授权后的真实拖选取词与 ⌘C、深色主题、溢出菜单视觉、多屏/混合 DPI、Intel 实机、设置页真实视觉、真实 DeepSeek 端到端。

### 已知限制

- macOS 需要 Xcode Command Line Tools；需要辅助功能授权；重新编译会改变 ad-hoc 签名，授权可能需要重新勾选。
- 取词依赖剪贴板；个别应用可能不出词。
- 未验证：macOS 从 App Store 沙箱应用取词、深色主题、溢出菜单视觉、混合 DPI 多屏、Intel 实机、真实辅助功能授权后的完整动作链路、真实 DeepSeek 端到端。

## 0.1.0 (2026-11-06)

首个公开发布版本。

### 新增

- 全局划词助手：任意 Windows 应用里选中文字后长按 Ctrl（默认 500ms，可调 200–1500ms）弹出浮动工具栏；也支持「选中即出现」和快捷键两种触发方式。
- 6 个内置动作：翻译、解释、总结、搜索、复制（默认启用），润色（默认关闭）；支持自定义动作、动作排序、每动作提示词与模型覆盖，自定义动作上限 20。
- 结果窗：流式输出、轻量 Markdown 渲染、复制/重新生成/关闭、跟随工具栏、置顶、失焦自动关闭、透明度、记住尺寸。
- 结果窗 pin 按钮：钉住后窗口置顶，点击其他窗口不自动关闭；取消钉住恢复设置里的置顶与失焦关闭行为。
- 设置页（DSH 设置 → 划词助手）：状态、触发方式、应用过滤、工具栏、功能窗口、动作管理、模型、高级诊断。
- 模型默认跟随 DSH 默认模型（DeepSeek 账号），可按动作覆盖服务与模型。
- 应用黑白名单（按进程名）。
- 助手进程守护：崩溃自动重启、日志、设置改动即时重载。
- 应用图标：白色圆角底、黑色虚线选区框与鼠标指针。

### 修复与加固

- 修复工具栏动作按钮点击无反应：WPF 事件处理器此前引用函数局部回调变量，函数返回后读到 `$null`，点击抛错并被全局 UI 异常处理器吞掉。现在在调用点绑定处理器。
- 修复设置页「高级」区 PowerShell 路径提示与输入框重合：提示文字在列内换行。
- 自测加固：`-SelfTest` 用真实 WPF 路由事件点击工具栏按钮和结果窗 pin 按钮；修正 helper.log 的 ERROR 判定正则；`verify-client-bundle.mjs` 增加布局回归守卫。

### 已知限制

- 仅 Windows；取词依赖剪贴板；不支持「引用到 DSH 会话」。
- 需要 PowerShell 7。
- 宿主 `src/` 更新后需完整重启 DSH；helper 脚本更新后重启助手进程；浏览器半体重建后刷新页面。
- 未验证：真实鼠标点击动作按钮与 pin 按钮、设置页真实浏览器视觉、深色主题、多屏混合 DPI、管理员权限应用取词。

### 验证

- 宿主产物、7 条设置路由、回环 SSE、鉴权与错误帧：PASS。
- 浏览器产物注册 / 模块表 / settings.section / locale / 设置页布局守卫：PASS。
- 助手解析与 helper-config：PASS；助手自测 PASS=21 SKIP=1 FAIL=0。
- 真实 DeepSeek 流式翻译经已安装插件跑通（1.1s）。
- 版本口径：仓库只发布 0.1.0。开发期的内部迭代编号已并入 0.1.0，不再单独发布。
