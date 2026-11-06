# dsh-selection-assistant — 接口契约（接口唯一出处）

本文件定义三部分之间的全部接口。任何一方改动接口，先改本文件。

- **宿主半体**（`src/*.ts`，运行在 DSH Host 的 Node 子进程）：管设置、模型调用、helper 进程生命周期。
- **助手进程**（`helper/**`，PowerShell 7 + WPF，独立进程）：全局钩子、选词、工具栏、结果窗。
- **设置页**（`src/client/**`，浏览器半体）：DSH 设置里的「划词助手」页面。

数据流：

```
任意应用 --选中文字--> 助手进程（钩子/剪贴板）--HTTP/SSE--> 宿主（ctx.llm，DeepSeek）--SSE--> 助手进程（结果窗）
DSH 设置页 --同源 fetch /selection-assistant/*--> 宿主（设置 JSON + 启动/重启 helper）
```

## 1. 路径与端口

- 设置与日志数据目录：`<dataDir>`，默认 `%USERPROFILE%\.dsh\selection-assistant`。
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
    target: string                             // 默认 '简体中文'
    fallback: string                           // 默认 'English'
  }
  appFilter: {
    mode: 'off' | 'blacklist' | 'whitelist'    // 默认 'off'
    processes: string[]                        // 例如 ["chrome.exe"]，大小写不敏感
  }
  actions: ActionSettings[]
  advanced: {
    pwshPath: string                           // '' = 自动探测
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
      "restarts": 0
    },
    "platform": { "os": "win32", "arch": "x64", "pwsh": "C:\\...\\pwsh.exe", "supported": true, "reason": "" },
    "defaults": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "" },
    "paths": { "dataDir": "C:\\Users\\Evan\\.dsh\\selection-assistant", "log": "C:\\...\\helper.log" },
    "version": "0.1.0"
  }
}
```

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

`{ "state": "ready" | "error", "message": "" }`；宿主据此更新状态机。

### POST `/v1/log`（helper → 宿主）

`{ "level": "info", "message": "..." }`；宿主追加到 `helper.log`。

### GET `/v1/health`

`{ "ok": true }`（宿主用不到时可省略）。

## 5. helper 命令行与配置

宿主启动：

```
<pwsh> -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <helper/SelectionAssistant.ps1> -ConfigPath <helper-config.json>
```

（`windowsHide: true`，无控制台窗口；stderr/stdout 由宿主收集到日志。）

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
  "toolbar": { "compact": false, "maxVisibleActions": 5, "scale": 1 },
  "result": { "followToolbar": true, "rememberSize": true, "autoClose": true, "alwaysOnTop": true, "opacity": 0.96, "width": 440, "height": 320 },
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
{ "version": 1, "pid": 1234, "startedAt": 1730000000000, "resultWidth": 440, "resultHeight": 320, "lastActionId": "translate" }
```

## 6. 触发语义（用户需求：选中文字后长按 Ctrl 出现划词助手）

- `ctrl` 模式（默认）：鼠标左键拖选（按下到抬起的位移 > 4px）后，用户按下并**按住** Ctrl；按住达到 `longPressMs` 且期间没有按其他键、没有按鼠标键、Ctrl 未松开 → 触发。
- `selection` 模式：鼠标拖选抬起后 `captureDelayMs` 毫秒 → 直接触发（避免误触发时可切回 `ctrl`）。
- `shortcut` 模式：任何一次拖选后，按下配置的快捷键（默认 `Ctrl+Alt+Q`）→ 触发。
- 触发后依次：记录前台进程（用于应用过滤）→ 保存剪贴板 → 模拟 Ctrl+C → 等待 `captureDelayMs` → 读剪贴板文本（最多重试 4 次，每次 50ms）→ 还原剪贴板 → 文本为空则静默退出 → 在鼠标释放点附近显示工具栏。
- 应用过滤命中（黑名单命中或白名单未命中）→ 完全不触发。
- 工具栏/结果窗自身为前台时不得触发。
- 不支持通过 UI Automation 直接取词；Ctrl+C 剪贴板是唯一取词路径（与 Cherry Studio 的 Windows 行为一致）。

## 7. UI 规格

### 工具栏

- 无边框、置顶、不抢焦点（`WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`），圆角 10px，1px 边框，投影。
- 高度：普通 40px，紧凑 34px；`scale` 等比缩放。宽度按动作数自适应。
- 结构：拖动柄（6 点图标，按住可拖动工具栏，位置记到 helper-state）→ 动作按钮（图标 16px + 可选文字 12px）→ 分隔线 → `…` 溢出菜单 → 关闭按钮。
- 默认显示前 `maxVisibleActions` 个启用动作，其余进溢出菜单；紧凑模式只显示图标（悬停显示 200ms 提示）。
- 深浅色跟随 Windows 系统主题（注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme`）。
- 视觉：浅色 `#FFFFFF` 背景 / `#E6E6EC` 边框 / 主文字 `#1F2329` / hover `#F2F3F5`；深色 `#2B2D31` 背景 / `#3F4147` 边框 / 主文字 `#E8E8EA` / hover `#37393F`；强调色 `#4D6BFE`。
- Esc 关闭；点击工具栏外关闭。

### 结果窗

- 跟随工具栏出现在其下方（空间不足时上方），不跟随则屏幕居中并在工作区内。
- 结构：标题行（动作名 + 模型标签 + 拖动 + 关闭）→ 内容区（只读、可选中、可滚动）→ 底栏（复制 / 重新生成 / 关闭）。
- 流式输出：先显示 loading 动画，收到首个 delta 后逐字追加；支持 `**粗体**`、行内代码、代码块、`- ` 列表的轻量渲染，其余按纯文本。
- `autoClose` 打开时，结果窗失去焦点即关闭（流式中仍关闭并 abort 请求）。
- `rememberSize` 打开时，用户拖动右下角改变尺寸后写回 helper-state，下次沿用。
- `opacity` 作用于整个窗口；`alwaysOnTop` 控制 Topmost。

### 图标

用 Segoe MDL2 Assets / Segoe Fluent Icons 字符；缺字形时退化为 ASCII 字符，不崩溃。宿主设置页用同一套 icon key。

## 8. 写入边界（并行开发时严格遵守）

| 范围 | 归属 |
|---|---|
| `src/*.ts`（宿主）、`scripts/**`、`package.json`、`cordis.patch.yml`、`locale/**`、`icon.svg`、`README.md`、`references/**`（除 cherry 报告） | Lead |
| `helper/**` | helper-dev |
| `src/client/**` | settings-ui-dev |
| `references/cherry-studio-selection-assistant.md` | cherry-researcher |

`src/contract.ts` 由 Lead 维护，浏览器与宿主都从它导入类型；其他角色只读。需要改契约先发消息给 Lead。

## 9. 构建与验证

```powershell
# 构建（esbuild CLI 由 scripts/build.mjs 调用，不需要联网）
node scripts/build.mjs

# 浏览器产物检查（注册 id / 模块表 / 可执行 apply）
node scripts/verify-client-bundle.mjs

# 宿主产物检查（裸 node 加载 lib/index.js，导出形态与 Config schema）
node scripts/probe.mjs

# helper 自测（不依赖 DSH）：窗口 + 钩子 + 宿主 mock
pwsh -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1
```
