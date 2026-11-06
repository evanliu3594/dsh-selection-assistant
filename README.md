# dsh-selection-assistant

在任意 Windows 软件里选中文字，长按 Ctrl，弹出划词工具栏；点一下就交给 DSH 当前配置的 DeepSeek 模型翻译、解释、总结、搜索或复制。形态、动作与设置项参考 [Cherry Studio 的划词助手](https://github.com/CherryHQ/cherry-studio)。

[![GitHub](https://img.shields.io/badge/GitHub-evanliu3594-181717?logo=github)](https://github.com/evanliu3594/dsh-selection-assistant) ![平台](https://img.shields.io/badge/platform-Windows-blue) ![类型](https://img.shields.io/badge/type-DSH%20bundle-green)

## 它做什么

- 在浏览器、Word、PDF 阅读器、聊天软件等**任意应用**里选中文字。
- 按住 Ctrl 约 0.5 秒（可调 200–1500ms），鼠标旁弹出浮动工具栏。
- 工具栏上的每个动作都是一次模型调用：默认启用翻译、解释、总结、搜索、复制，润色默认关闭。
- 结果窗流式显示 DeepSeek 输出，可复制、重新生成、调整大小、钉在最前；跟随工具栏、置顶、失焦可自动关闭。
- 模型默认跟随 DSH 的默认模型（桌面版即 DeepSeek 账号模型），也可在设置里单独指定服务与模型。
- 设置页在 **DSH 设置 → 划词助手**。

## 依赖

| 依赖 | 说明 |
|---|---|
| Windows 10/11 | 全局键盘/鼠标钩子与 WPF 悬浮窗口只在 Windows 可用 |
| PowerShell 7 | 助手进程用 pwsh 运行；设置页可指定 `pwsh.exe` 完整路径 |
| DSH 0.2.x 桌面版 | 需要 `llm` 服务；没有模型的 profile 会在调用时给出中文提示 |

不需要额外的 API Key、不需要管理员权限、不需要联网安装依赖（模型调用走 DSH 自己的通道）。

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

1. 在 `%USERPROFILE%\.dsh\selection-assistant\` 创建设置与日志；
2. 在 `127.0.0.1` 随机端口启动助手通信服务；
3. 拉起 `helper/SelectionAssistant.ps1` 助手进程（PowerShell 7 + WPF）。

打开 **设置 → 划词助手**，确认状态卡显示「运行中」。

## 使用

1. 在任意应用里用鼠标选中一段文字。
2. **按住 Ctrl** 约 0.5 秒，直到工具栏出现（默认触发方式）。
3. 点动作按钮：翻译 / 解释 / 总结 / 搜索 / 复制（润色需在设置里启用）。
4. 结果窗出现在工具栏下方；`Esc` 关闭，`R` 重新生成，`C` 复制。
5. 点结果窗标题栏的 pin 按钮可钉住窗口：钉住后窗口保持最前，点击其他应用不关闭；再点一次取消钉住，恢复设置里的置顶与失焦关闭行为。

触发方式可以改成「选中即出现」或「快捷键」，见设置页。

## 设置项

| 分区 | 内容 |
|---|---|
| 状态 | 启用开关、助手进程状态、重启 |
| 触发方式 | 选中文字 / 长按 Ctrl / 快捷键；长按时长；快捷键 |
| 工具栏 | 紧凑模式（只显示图标）、最多直显动作数、缩放 |
| 功能窗口 | 跟随工具栏、记住大小、失焦自动关闭、置顶、透明度 |
| 功能 | 动作启用与排序、编辑提示词、自定义动作、每动作模型覆盖、搜索引擎 |
| 模型 | 服务、模型、推理强度、温度（留空跟随 DSH 默认） |
| 高级 | pwsh 路径、日志级别、预览工具栏、查看日志 |

设置保存到 `<数据目录>\settings.json`，保存后只重启助手进程，不重启 DSH。

## 数据结构

```text
%USERPROFILE%\.dsh\selection-assistant\
  settings.json        设置（唯一真源）
  helper-config.json   每次启动助手时写入的运行配置
  helper-state.json    助手记住的结果窗尺寸等
  command.json         设置页「预览工具栏」的一次性命令
  helper.log           助手日志
  plugin.log           宿主插件日志
```

## 架构

```text
任意应用 ──选中文字──▶ 助手进程（PowerShell 7 + WPF）
                          │  全局钩子 / Ctrl 长按 / Ctrl+C 取词
                          ▼
                    本机回环 HTTP（随机端口 + 每次启动随机 token）
                          ▼
                    DSH Host 插件（Node，ctx.llm）
                          ▼
                    DeepSeek（或 DSH 里配置的任意模型路由）
```

- **宿主半体**（`src/`，构建到 `lib/index.js`）：设置持久化、模型调用、助手进程生命周期、两个 HTTP 面。
- **助手进程**（`helper/`）：唯一碰操作系统的一层；钩子、剪贴板、WPF 工具栏与结果窗。
- **设置页**（`src/client/`，构建到 `lib/client.js`）：注册在 DSH 设置里的 React 页面。

为什么不把悬浮窗做成 DSH 自己的窗口：DSH 插件宿主运行在独立 Node 子进程里，拿不到 Electron 的 `BrowserWindow`；跨应用置顶窗口只能由独立原生进程提供，这也是 Cherry Studio 用原生划词钩子 + 独立窗口的原因。

## 安全边界

- 回环服务只绑 `127.0.0.1`，每次启动生成新 token，请求必须带 `Authorization: Bearer`。
- 取词只走「保存剪贴板 → Ctrl+C → 读剪贴板 → 还原剪贴板」，不读 UI Automation，不截屏。
- 插件不落任何凭据；模型调用复用 DSH 自己的账号/密钥与模型路由。
- 设置页路由只挂在 DSH 自己的 web 服务上，同源、无 CORS 头。
- 助手进程从 `helper/` 目录运行，日志不含剪贴板内容。

## 已知限制

- 仅 Windows；Linux/macOS 不支持。
- 取词依赖剪贴板，个别应用（部分游戏、UWP 沙箱应用、远程桌面）可能复制不出文本。
- 已确认的应用过滤按进程名（如 `chrome.exe`）匹配。
- 不支持 Cherry Studio 的「Ask Agent / 引用到对话」动作；本插件的结果窗不回到 DSH 会话里。
- 需要 PowerShell 7；只有 Windows PowerShell 5.1 的机器会提示找不到 pwsh。

## 排错

| 现象 | 处理 |
|---|---|
| 设置里没有「划词助手」入口 | 完整重启 DSH；设置页由启动时装配的浏览器产物提供，刷新页面不够 |
| 状态卡为「错误」，提示找不到 pwsh | 设置 → 高级 → pwsh 路径，填 `(Get-Command pwsh).Source` 的输出；或安装 PowerShell 7 |
| 状态卡为「错误」，助手 15 秒未就绪 | 设置 → 高级 → 查看日志；读 `%USERPROFILE%\.dsh\selection-assistant\helper.log` |
| 长按 Ctrl 没反应 | 确认 DSH 正在运行、助手状态为「运行中」；部分应用（管理员权限窗口）需要同等权限才能被钩子捕获 |
| 工具栏出现但没取到词 | 该应用不支持 Ctrl+C 复制（或剪贴板被占用）；换到浏览器/记事本验证 |
| 模型报错（凭据/模型不支持） | 到 DSH 设置 → 模型，确认默认模型可用；或在划词助手设置里单独指定模型 |

## 开发与验证

```powershell
node scripts/build.mjs               # 构建宿主 + 浏览器半体
node scripts/probe.mjs               # 宿主产物：裸导入 + 冷上下文 apply
node scripts/verify-host.mjs         # 宿主：设置、路由、回环 SSE、鉴权
node scripts/verify-client-bundle.mjs # 浏览器产物：注册 id / 模块表 / settings.section
node scripts/verify-helper-resolve.mjs # 助手：pwsh 解析 + helper-config
pwsh -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1  # 助手自测（mock 宿主 + 按钮点击 + 截图）
```

接口契约见 [`references/contracts.md`](references/contracts.md)，验证记录见 [`references/verification.md`](references/verification.md)，Cherry Studio 对照研究见 [`references/cherry-studio-selection-assistant.md`](references/cherry-studio-selection-assistant.md)。

## 许可

MIT。
