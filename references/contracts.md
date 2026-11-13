# dsh-selection-assistant — 接口契约（接口唯一出处）

本文件定义三部分之间的全部接口。任何一方改动接口，先改本文件。

支持两个平台，宿主与设置页共用，只有助手进程按平台实现：

- **宿主半体**（`src/*.ts`，运行在 DSH Host 的 Node 子进程）：管设置、模型调用、helper 进程生命周期。
- **助手进程（Windows）**（`helper/SelectionAssistant.ps1` + `helper/lib/**`，PowerShell 7，未安装时用 Windows PowerShell 5.1；WPF）：全局钩子、选词、工具栏、结果窗。
- **助手进程（macOS）**（`helper/macos/Sources/**`，Swift + AppKit，`swiftc` 编译）：全局事件 tap、选词、工具栏、结果窗。
- **设置页**（`src/client/**`，浏览器半体）：DSH 设置里的「划词助手」页面。

平台差异只在两处：助手启动命令与取词快捷键（Windows 用 Ctrl+C，macOS 用 ⌘C）。设置 JSON、回环 HTTP、SSE 与 UI 规格两端一致。

数据流：

```
任意应用 --选中文字--> 助手进程（钩子/剪贴板）--HTTP/SSE--> 宿主（ctx.llm，DeepSeek）--SSE--> 助手进程（结果窗）
DSH 设置页 --同源 fetch /selection-assistant/*--> 宿主（设置 JSON + 启动/重启 helper）
```

## 1. 路径与端口

- 设置与日志数据目录：`<dataDir>`，默认：
  - Windows：`%USERPROFILE%\.dsh\selection-assistant`
  - macOS：`~/.dsh/selection-assistant`
  - `settings.json`：唯一的设置持久化文件（宿主写，浏览器通过路由改）。
  - `helper-config.json`：宿主每次启动 helper 前写入的只读运行配置。
  - `helper-state.json`：helper 自己写的状态（记住的结果窗尺寸等）。
  - `command.json`：宿主写、helper 读的一次性命令（预览、刷新设置）。
  - `helper.log`：helper 日志，宿主也可追加。
- 宿主在本机回环地址开一个**独立 HTTP 服务**（`127.0.0.1`，随机端口），只给 helper 用；每次启动 helper 生成随机 32 字节 token。请求必须带 `Authorization: Bearer <token>`。
- 设置页走 DSH 自己的 `webServer`，前缀 `/selection-assistant`。同源 fetch，靠 DSH 自己的会话鉴权，不带 CORS 头。

## 2. 设置 JSON（唯一真源）

```ts
interface Settings {
  version: 1
  enabled: boolean
  trigger: {
    mode: 'selection' | 'ctrl' | 'shortcut'   // 默认 'ctrl'
    longPressMs: number                        // 200..1500，默认 500
    shortcut: string                           // 默认 'Ctrl+Alt+Q'
    captureDelayMs: number                     // 抓取剪贴板前的等待，默认 120
  }
  toolbar: {
    compact: boolean                           // 只显示图标，默认 false
    maxVisibleActions: number                  // 工具栏上最多直显几个动作，默认 5
    scale: number                              // 0.85..1.25，默认 1
  }
  result: {
    followToolbar: boolean                     // 默认 true
    rememberSize: boolean                      // 默认 true
    autoClose: boolean                         // 失焦自动关，默认 true
    alwaysOnTop: boolean                       // 默认 true
    opacity: number                            // 0.2..1，默认 0.96
    width: number                              // 默认 440
    height: number                             // 默认 320
  }
  model: {
    provider: string                           // '' = 跟随 DSH 默认模型
    model: string                              // '' = 跟随 DSH 默认模型
    reasoningEffort: string                    // '' = 提供方默认
    temperature: number | null                 // null = 不传
  }
  language: {
    ui: 'zh' | 'en'                            // 默认 'zh'
    target: string                             // 语言代码；默认取本机显示语言（如 'zh'、'en'）
    fallback: string                           // 语言代码；默认 'en'
  }
  appFilter: {
    mode: 'off' | 'blacklist' | 'whitelist'    // 默认 'off'
    processes: string[]                        // 例如 ["chrome.exe"]，大小写不敏感
  }
  actions: ActionSettings[]
  advanced: {
    helperPath: string                         // '' = 自动探测（Windows 优先 pwsh，未安装时 powershell.exe）或首次启动编译（macOS）
    logLevel: 'error' | 'warn' | 'info' | 'debug'
  }
}

interface ActionSettings {
  id: string                 // 'translate' | 'explain' | ... | 'custom-<uuid>'
  kind: 'llm' | 'search' | 'copy'
  preset: 'translate' | 'explain' | 'summarize' | 'optimize' | 'custom'
  labelZh: string
  labelEn: string
  icon: string               // 'translate' | 'explain' | 'summarize' | 'search' | 'copy' | 'optimize' | 'sparkle'
  enabled: boolean
  order: number              // 升序
  systemPrompt: string       // '' = 用内置
  prompt: string             // 模板，含 {{text}}；'' = 用内置
  searchUrl: string          // 仅 kind=search，模板含 {{query}}；'' = 内置 Google
  model: { provider: string; model: string }   // 空 = 用全局 model
}
```

内置动作默认值（首次运行生成，写进 settings.json）：

| id | kind | 默认启用 | 默认提示词（摘要） |
|---|---|---|---|
| translate | llm | 是 | 译为目标语言；原文已是目标语言则译成回退语言；只输出译文 |
| explain | llm | 是 | 面向普通读者解释含义、背景与难点 |
| summarize | llm | 是 | 用一段话概括要点 |
| search | search | 是 | 用默认浏览器打开 Google 搜索 |
| copy | copy | 是 | 直接复制原文 |
| optimize | llm | 否 | 润色：更通顺、更专业，保留原意 |

宿主校验规则：
- 未知字段忽略；越界数值夹到范围内；`actions` 为空数组时拒绝保存（至少保留一个动作）。
- 保存是**深合并**：客户端只需提交改动的字段；`actions` 若提交则整体替换。
- 保存后立即重启 helper（宿主自己负责），不重启 Host、不重启插件。
- `advanced.pwshPath` 是 0.1 的字段名。0.2 读取时若不存在 `helperPath` 才回退到旧字段，之后只写 `helperPath`。
- 翻译语言（0.2.3）：`language.target` 与 `language.fallback` 存语言代码；旧设置里的「简体中文」「English」等在加载时自动迁移。翻译动作先由本地脚本判断源语言：
  - 源语言已知且不是 `target`：译成 `target`；
  - 源语言已知且等于 `target`：译成 `fallback`；
  - `target` 与 `fallback` 相同且源语言是 `target`：不调用模型，SSE 返回 `error` 事件 `{ code: 'language-overlap', message: '目标语言与源语言重叠' }`；
  - 源语言 unknown：交给模型判断，提示词包含重叠规则。

## 3. 设置页 HTTP 契约（宿主 `webServer`，前缀 `/selection-assistant`）

所有响应 `Content-Type: application/json; charset=utf-8`，`Cache-Control: no-store`。失败统一：

```json
{ "ok": false, "error": { "code": "bad-request", "message": "中文说明" } }
```

### GET `/selection-assistant/state`

```json
{
  "ok": true,
  "state": {
    "settings": { /* 见第 2 节 */ },
    "helper": {
      "status": "stopped | starting | running | error",
      "pid": 12345,
      "startedAt": 1730000000000,
      "lastError": "",
      "restarts": 0,
      "runtime": "PowerShell 7 | Windows PowerShell 5.1"
    },
    "platform": {
      "os": "win32 | darwin",
      "arch": "x64 | arm64",
      "helper": "C:\\...\\pwsh.exe 或 /.../helper/macos/bin/SelectionAssistant",
      "helperKind": "powershell | swift | none",
      "supported": true,
      "reason": "",
      "permissions": { "accessibility": "granted | denied | unknown" }
    },
    "defaults": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "" },
    "paths": { "dataDir": "C:\\Users\\Evan\\.dsh\\selection-assistant", "log": "C:\\...\\helper.log" },
    "version": "0.2.4"
  }
}
```

`permissions.accessibility` 只在 macOS 有意义；Windows 恒为 `unknown`。权限状态由 helper 的 `/v1/status` 上报，宿主保存在内存里。`helper.runtime` 只在 Windows 有值，由宿主按实际启动的解释器文件名生成（`PowerShell 7` 或 `Windows PowerShell 5.1`）。

### POST `/selection-assistant/settings`

请求：`{ "patch": { /* 深合并的 Settings 片段 */ } }`
响应：`{ "ok": true, "state": { /* 同 GET /state 的 state */ } }`

### GET `/selection-assistant/models`

```json
{
  "ok": true,
  "providers": [
    {
      "provider": "deepseek-account",
      "name": "DeepSeek",
      "models": [
        { "id": "deepseek-flash", "name": "DeepSeek-V4.1-Flash",
          "reasoningEfforts": [{ "id": "max", "name": "max" }],
          "defaultReasoningEffort": "max" }
      ]
    }
  ],
  "defaults": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "max" }
}
```

### POST `/selection-assistant/test`

请求：`{ "provider": "", "model": "", "text": "" }`（空 = 跟随默认；text 空 = 用固定测试句）
响应：`{ "ok": true, "text": "模型输出", "provider": "...", "model": "..." }`
失败：`{ "ok": false, "error": { "code": "llm-failed", "message": "..." } }`

### POST `/selection-assistant/helper/restart`

响应：`{ "ok": true, "state": { ... } }`

### POST `/selection-assistant/helper/open-permissions`

仅 macOS。打开「系统设置 → 隐私与安全性 → 辅助功能」。

响应：`{ "ok": true }`；失败：`{ "ok": false, "error": { "code": "open-permissions-failed", "message": "..." } }`。

### POST `/selection-assistant/helper/preview`

请求：`{ "text": "预览用文字" }`；宿主写 `command.json` 让 helper 展示工具栏和结果窗（内容为固定样例）。
响应：`{ "ok": true }`

### GET `/selection-assistant/logs?lines=200`

响应：`{ "ok": true, "path": "...", "text": "最后 N 行日志" }`

## 4. 宿主 ↔ helper 回环 HTTP（端口与 token 在 helper-config.json 里）

请求头统一 `Authorization: Bearer <token>`。

### POST `/v1/action`（helper → 宿主，SSE 流）

请求体：

```json
{ "requestId": "uuid", "actionId": "translate", "text": "选中的原文",
  "source": { "app": "chrome.exe" }, "locale": "zh" }
```

响应 `Content-Type: text/event-stream`，事件依次为：

```
event: meta
data: {"provider":"deepseek-account","model":"deepseek-flash","label":"翻译"}

event: delta
data: {"text":"增量文本"}

event: done
data: {"reason":"stop"}
```

失败时：`event: error` + `data: {"code":"llm-failed","message":"中文说明"}`。
客户端断开（关结果窗）时宿主必须 abort 对应的 `ctx.llm.stream` signal。

### POST `/v1/status`（helper → 宿主）

```json
{ "state": "ready", "message": "", "permissions": { "accessibility": true } }
```

宿主据此更新状态机与 `platform.permissions.accessibility`。macOS helper 在辅助功能未授权时上报 `error` + `accessibility: false`，进程保持运行并每 1.5 秒复查；授权后安装事件 tap 并重新上报 `ready` + `accessibility: true`。Windows helper 可以省略 `permissions`。

### POST `/v1/log`（helper → 宿主）

`{ "level": "info", "message": "..." }`；宿主追加到 `helper.log`。

### GET `/v1/health`

`{ "ok": true }`（宿主用不到时可省略）。

## 5. helper 命令行与配置

宿主启动：

```
# Windows（优先 pwsh；未安装时宿主回退 powershell.exe）
<pwsh | powershell.exe> -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <helper/SelectionAssistant.ps1> -ConfigPath <helper-config.json>

# macOS（LaunchServices 启动 app，app 才是 TCC 负责进程）
/usr/bin/defaults write com.evanliu3594.dsh-selection-assistant.helper HelperConfigPath -string <helper-config.json>
/usr/bin/open -n -a <helper/macos/bin/SelectionAssistant.app>
```

macOS 27 的 `open --args` 不把参数传给 app，因此配置路径走 UserDefaults 键 `HelperConfigPath`。helper 取配置的顺序：命令行 `--config` > UserDefaults `HelperConfigPath` > `~/.dsh/selection-assistant/helper-config.json`。开发/验证用的 `SuppressPermissionPrompt`（Bool）与 `ScreenshotDir`（String）也走 UserDefaults；直跑内层二进制时可用同名命令行参数覆盖。

Windows 用 `windowsHide: true`，无控制台窗口；stderr/stdout 由宿主收集到日志。同一份 helper 脚本在 PowerShell 7 与 Windows PowerShell 5.1 下运行；C# 5 语法、UTF-8 BOM 与时钟约束见 `helper/README.md`「运行时兼容」。宿主按「显式助手路径 → pwsh（解析器/磁盘/裸）→ powershell.exe（磁盘/裸）」解析候选。macOS app 首次启动时由宿主运行 `sh scripts/build-macos-helper.sh` 编译（需要 Xcode Command Line Tools），之后按源码修改时间增量重编。可用 `--universal` 生成 arm64 + x86_64 通用 app。

macOS 的 stdin 不可用（app 由 LaunchServices 启动），因此宿主与助手的存活关系改为：

- helper 每 2 秒 `GET /v1/health`（不带 token）；连续 3 次失败 → 退出。
- helper 启动后尽早把 `pid` 写入 `helper-state.json`；宿主用 `SIGTERM` 停止它，2.5 秒后仍未退出则 `SIGKILL`。
- 宿主启动新实例前先按 pid 停掉旧实例；helper 自己也做单实例保护。

macOS helper 还接受只在开发/验证时使用的命令行参数（直跑内层二进制时）：

```
--selftest --config <helper-config.json> --screenshot-dir <dir>   # 不装 tap、不连宿主，渲染窗口并写 selftest-result.json
--no-permission-prompt                                            # 不弹系统授权框，仍上报 error 并持续复查
```

通过 `open` 启动时改成 UserDefaults 键：`SuppressPermissionPrompt` 等价 `--no-permission-prompt`，`ScreenshotDir` 等价 `--screenshot-dir`。

`helper-config.json`：

```json
{
  "version": 1,
  "endpoint": "http://127.0.0.1:52341",
  "token": "<64 位十六进制>",
  "dataDir": "C:\\Users\\Evan\\.dsh\\selection-assistant",
  "logPath": "C:\\Users\\Evan\\.dsh\\selection-assistant\\helper.log",
  "locale": "zh",
  "trigger": { "mode": "ctrl", "longPressMs": 500, "shortcut": "Ctrl+Alt+Q", "captureDelayMs": 120 },
  "toolbar": { "compact": false, "maxVisibleActions": 6, "scale": 1 },
  "result": { "followToolbar": true, "rememberSize": true, "autoClose": true, "alwaysOnTop": true, "opacity": 0.96, "width": 500, "height": 400 },
  "appFilter": { "mode": "off", "processes": [] },
  "actions": [
    { "id": "translate", "kind": "llm", "label": "翻译", "icon": "translate", "enabled": true, "order": 10, "searchUrl": "" }
  ],
  "debug": false
}
```

命令文件 `command.json`（宿主写，helper 监听变化；执行后 helper 把 `done` 写回 `helper-state.json` 或直接忽略）：

```json
{ "id": "uuid", "type": "preview", "text": "预览用文字" }
```

helper 状态文件 `helper-state.json`（helper 写）：

```json
{ "version": 1, "pid": 1234, "startedAt": 1730000000000,
  "resultX": 220, "resultY": 180,
  "resultWidth": 500, "resultHeight": 400,
  "lastActionId": "translate" }
```

- `resultX`/`resultY`：结果窗 frame 原点（屏幕坐标）。只在用户手动拖动结束后写入；0.2.1 起用于固化位置。
- `resultWidth`/`resultHeight`：内容区尺寸（窗口宽高减 24）。用户手动缩放结束后写入；`rememberSize` 控制是否沿用。
- 两者都由 helper 自己读写，宿主不解析位置字段。`

## 6. 触发语义（选中文字后长按触发键出现划词助手）

- `ctrl` 模式（默认）：鼠标左键拖选（按下到抬起的位移 > 4px）后，用户按下并**按住**触发键；按住达到 `longPressMs` 且期间没有按其他键、没有按鼠标键、触发键未松开 → 触发。
  - Windows 触发键为 Ctrl。
  - macOS 触发键为 Control（⌃），与 Windows 的 Ctrl 语义一致。
- `selection` 模式：鼠标拖选抬起后 `captureDelayMs` 毫秒 → 直接触发（避免误触发时可切回 `ctrl`）。
- `shortcut` 模式：任何一次拖选后，按下配置的快捷键（默认 `Ctrl+Alt+Q`）→ 触发。macOS 把 `Ctrl`/`Control` 解析为 ⌃，`Alt`/`Option` 解析为 ⌥，`Win`/`Meta`/`Cmd`/`Command` 解析为 ⌘。
- 触发后依次：记录前台应用（用于应用过滤）→ 保存剪贴板 → 模拟复制快捷键 → 等待 `captureDelayMs` → 读剪贴板文本（最多重试 4 次，每次 50ms）→ 还原剪贴板 → 文本为空则静默退出 → 在鼠标释放点附近显示工具栏。
  - Windows 复制快捷键为 Ctrl+C。
  - macOS 复制快捷键为 ⌘C；若 Control 仍被物理按住，helper 先发送 Control keyUp，复制后再恢复。
- 应用过滤命中（黑名单命中或白名单未命中）→ 完全不触发。
  - Windows 按进程名匹配（如 `chrome.exe`）。
  - macOS 按应用名、Bundle ID 或可执行文件名匹配（三者任一，大小写不敏感）。
- 工具栏/结果窗自身为前台时不得触发。
- 取词只走剪贴板，不读 UI Automation，不截屏。
- macOS 需要「辅助功能」授权才能安装全局事件 tap 与发送 ⌘C。授权缺失时 helper 保持运行，设置页显示权限状态与「打开辅助功能设置」按钮。
- macOS 的辅助功能授权按「负责进程」判定。宿主必须用 LaunchServices（`open`）启动 `SelectionAssistant.app`，授权才属于助手自己；宿主直接 spawn app 内层二进制会把授权算到 DSH 头上。

## 7. UI 规格

### 工具栏

- 无边框、置顶、不抢焦点（Windows：`WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`；macOS：`NSPanel` + `nonactivatingPanel` + `becomesKeyOnlyIfNeeded`），圆角 10px，1px 边框，投影。
- 高度：普通 40px，紧凑 34px；`scale` 等比缩放。宽度按动作数自适应。
- 结构：拖动柄（6 点图标，按住可拖动工具栏，位置记到 helper-state）→ 动作按钮（图标 14–16px + 可选文字 12px）→ 分隔线 → `…` 溢出菜单 → 关闭按钮。
- 默认显示前 `maxVisibleActions` 个启用动作，其余进溢出菜单；紧凑模式只显示图标（悬停显示提示）。
- 深浅色跟随系统主题（Windows 读注册表 `AppsUseLightTheme`；macOS 读 `NSApp.effectiveAppearance`）。
- 视觉：浅色 `#FFFFFF` 背景 / `#E6E6EC` 边框 / 主文字 `#1F2329` / hover `#F2F3F5`；深色 `#2B2D31` 背景 / `#3F4147` 边框 / 主文字 `#E8E8EA` / hover `#37393F`；强调色 `#4D6BFE`。
- Esc 关闭；点击工具栏外关闭。

### 结果窗

- 首次出现：跟随工具栏下方（空间不足时上方），不跟随则屏幕居中并在工作区内。
- 结构：标题行（动作名 + 模型标签 + 拖动 + 关闭）→ 内容区（只读、可选中、可滚动）→ 底栏（复制 / 重新生成 / 关闭）。
- 流式输出：先显示 loading 动画，收到首个 delta 后逐字追加；支持 `**粗体**`、行内代码、代码块、`- ` 列表的轻量渲染，其余按纯文本。
- `autoClose` 打开时，未 pin 的结果窗失去焦点即关闭（流式中仍关闭并 abort 请求）；pin 窗不关闭。
- `rememberSize` 打开时，用户拖动右下角改变尺寸后写回 helper-state，下次沿用。
- 几何固化（0.2.1）：用户手动拖动/缩放后，位置与尺寸写入 helper-state；下一次结果窗沿用。当前结果窗未 pin 时先关闭它，新窗在原位同尺寸出现；当前结果窗 pin 时保留旧窗，新窗同尺寸并向左下偏移 24。多个 pin 窗可同时存在，各自独立流式、关闭、复制、重新生成。
- 详细口径见 `references/result-window-geometry.md`。
- `opacity` 作用于整个窗口；`alwaysOnTop` 控制置顶（Windows：Topmost；macOS：窗口 level）。

### 图标

- Windows：Segoe MDL2 Assets / Segoe Fluent Icons 字符；缺字形时退化为 ASCII 字符，不崩溃。
- macOS：SF Symbols 名称映射同一套 icon key（如 translate → `translate`、search → `magnifyingglass`、copy → `doc.on.doc`）；系统没有该符号时退化为文字符号，不崩溃。
- 宿主设置页用同一套 icon key。

### 设置页「翻译语言」

- 两个原生下拉：目标语言（`language.target`）与备选语言（`language.fallback`），选项来自 `LANGUAGES`（20 种），显示名随 `language.ui` 切换。
- 位置：触发方式之后、应用过滤之前。
- 允许两者相同；相同值不拦截，仅在底部说明运行时会直接报错。

## 8. 写入边界（并行开发时严格遵守）

| 范围 | 归属 |
|---|---|
| `src/*.ts`（宿主）、`scripts/**`、`package.json`、`cordis.patch.yml`、`locale/**`、`icon.svg`、`README.md`、`references/**`（除 cherry 报告） | Lead |
| `helper/**`（Windows PowerShell 与 macOS Swift） | helper-dev |
| `src/client/**` | settings-ui-dev |
| `references/cherry-studio-selection-assistant.md` | cherry-researcher |

`src/contract.ts` 由 Lead 维护，浏览器与宿主都从它导入类型；其他角色只读。需要改契约先发消息给 Lead。

## 9. 构建与验证

```bash
# 两端通用：构建宿主与浏览器产物（esbuild CLI，不需要联网）
node scripts/build.mjs

# 两端通用：浏览器产物检查（注册 id / 模块表 / 可执行 apply）
node scripts/verify-client-bundle.mjs

# 两端通用：宿主产物检查（裸 node 加载 lib/index.js，导出形态与 Config schema）
node scripts/probe.mjs

# 两端通用：宿主路由、设置夹紧、回环 SSE、鉴权
node scripts/verify-host.mjs

# Windows：pwsh 优先、powershell.exe 兜底、双运行时探测 + helper-config 字段
node scripts/verify-helper-resolve.mjs
node --experimental-strip-types scripts/verify-lang.mjs
pwsh -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1

# macOS：编译 + 自测截图 + mock 宿主 SSE + LaunchServices + 健康退出
node scripts/verify-macos-helper.mjs
node scripts/verify-host-macos.mjs
```

macOS 构建产物为 `helper/macos/bin/SelectionAssistant.app`；构建参数：`sh scripts/build-macos-helper.sh`（当前架构）或 `sh scripts/build-macos-helper.sh --universal`（arm64 + x86_64）。
