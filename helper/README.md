# helper — Windows 划词助手进程

PowerShell 7 + WPF 实现的独立助手进程。macOS 版本见 [helper/macos/README.md](macos/README.md)。

宿主用下面的命令启动它：

```powershell
pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <helper>\SelectionAssistant.ps1 -ConfigPath <dataDir>\helper-config.json
```

宿主用 `windowsHide` 启动，stdio 由宿主收集。宿主保持 stdin 管道打开；宿主关闭 stdin 表示宿主已退出，helper 在下一个 40ms 周期内退出进程。

接口以宿主与助手之间的 JSON 契约为准；本目录只实现，不定义接口。

## 文件职责

| 文件 | 职责 |
|---|---|
| `SelectionAssistant.ps1` | 入口、配置/状态读写、HTTP 状态与日志、触发状态机、取词流程、动作分发、SSE 轮询、command.json 轮询、自测模式、退出清理 |
| `lib\SelectionHook.cs` | `Add-Type` 内存编译的原生层：WH_MOUSE_LL/WH_KEYBOARD_LL 钩子（独立线程 + 消息泵，回调只入队）、SendInput、剪贴板保存/读取/还原、前台进程名、屏幕与 DPI、窗口样式、SSE 客户端、stdin EOF 监视 |
| `lib\Ui.ps1` | WPF 界面：主题、工具栏、溢出菜单、结果窗、轻量 Markdown 渲染、Toast、拖动/缩放、位置计算、截图辅助之外的全部窗口逻辑 |
| `selftest.ps1` | 自测：钩子层、TcpListener mock 宿主、helper `-SelfTest`、截图校验、stdin 生命周期校验 |
| `preview\toolbar.png`、`preview\result.png` | 自测生成的窗口截图，供人工检查渲染；本地生成，不随仓库提交 |

分层原则：C# 只做原生调用和后台线程，所有 WPF 对象与状态机留在 PowerShell 主线程（Dispatcher 线程，pwsh 7 默认 STA）。钩子线程自己泵消息，回调只写 `ConcurrentQueue`；PowerShell 用 `DispatcherTimer`（40ms）消费，从不跨线程调用 PowerShell。

## 触发与取词

`trigger.mode` 三选一：

- `ctrl`（默认）：左键拖选（按下到抬起位移 > 4 物理像素）后按住 Ctrl；达到 `longPressMs` 且期间没有其他键、没有鼠标键、Ctrl 未松开 → 触发。提前松开或按其他键/鼠标键 → 取消。
- `selection`：拖选抬起后 `captureDelayMs` 触发。
- `shortcut`：拖选后按配置组合键（默认 `Ctrl+Alt+Q`）。

触发后：记录前台进程 → 应用过滤 → 保存剪贴板 → 清空剪贴板 → SendInput Ctrl+C（先释放用户按住的物理 Ctrl，发送后恢复按下状态）→ 等 `captureDelayMs` → 读剪贴板（最多 4 次、每次间隔 50ms）→ 还原剪贴板 → 文本为空则静默返回 → 在鼠标释放点附近显示工具栏。

工具栏/结果窗自身为前台、应用过滤命中（黑名单命中或白名单未命中）时完全不触发。

`kind=copy` 本地写剪贴板并弹出 1.1 秒 Toast；`kind=search` 本地打开浏览器；`kind=llm` 走宿主 `POST /v1/action` SSE。

## 结果窗

- 默认 500×400（配置值，夹紧到 300..900 × 200..900），右下角拖动改变尺寸，`rememberSize` 时写回 `helper-state.json`。
- 首次显示跟随工具栏下方，空间不足翻到上方；`followToolbar=false` 时在工作区居中。与工具栏间距 6px。
- 几何固化：用户拖动标题栏或右下角后，位置写 `resultX/resultY`，尺寸写 `resultWidth/resultHeight`。下一次结果窗在未 pin 时原位同尺寸替换；当前窗已 pin 时旧窗保留，新窗同尺寸并向左下偏移 24px。多个 pin 窗可同时存在，各自独立流式与关闭。
- 详细口径见 [references/result-window-geometry.md](../references/result-window-geometry.md)。
- 流式期间显示进度条与“正在生成”；收到 delta 后按轻量 Markdown 渲染（`**粗体**`、行内代码、``` 代码块、`- ` 列表），其余按纯文本。
- 窗口可获取焦点：`Esc` 关闭、`R` 重新生成、`C` 复制（无修饰键时生效）。失焦且 `autoClose` 打开时关闭并取消 SSE 请求；点击窗口外也会关闭。
- 标题栏 pin 按钮切换钉住：钉住时窗口置顶，点击窗口外不关闭；取消钉住后恢复 `result.alwaysOnTop` 与 `result.autoClose`。每个结果窗初始未钉住。
- 两条 `meta` 事件都容忍，后到的 `provider/model` 覆盖模型标签；第一条只有 label 时不会把标签清空。

## helper-state.json

helper 自己写，字段：`version`、`pid`、`startedAt`、`resultX`、`resultY`、`resultWidth`、`resultHeight`、`lastActionId`、`toolbarX`、`toolbarY`。写入用 UTF-8 无 BOM，先读旧值再合并。`resultX/Y` 是窗口原点（物理屏幕坐标），`resultWidth/Height` 是内容尺寸。

## 自测

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File helper\selftest.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File helper\selftest.ps1 -RequireRealHook   # 沙箱外强制真实钩子测试
pwsh -NoProfile -ExecutionPolicy Bypass -File helper\selftest.ps1 -KeepTemp          # 保留临时目录便于排查
```

自测内容：

1. 钩子层：安装真实全局钩子，用 SendInput 注入 Ctrl 按下 → 700ms → 松开，断言钩子收到 ctrl-down/ctrl-up 且时长 ≥ `longPressMs`；再用钩子引擎自注入事件验证事件队列、longpress 判定与鼠标拖拽语义。
2. mock 宿主：用 `TcpListener` 手写 HTTP/1.1 + SSE（本机非管理员、低完整性进程无法启动 `HttpListener`），校验 Bearer token，记录 `/v1/status` 与 `/v1/log`，`/v1/action` 依次发两条 meta、10 条 delta、一条 done。
3. UI 自测：启动 `SelectionAssistant.ps1 -SelfTest`，展示工具栏并截图 `preview\toolbar.png`；随后对工具栏「翻译」按钮触发真实 WPF 路由事件（`RaiseEvent`），断言结果窗已打开（`clicked=true`）；再对结果窗 pin 按钮触发两次点击，断言钉住/取消钉住与 Topmost（`pinToggled=true`）。等待完整流后截图 `preview\result.png`。随后再次 pin 首个窗口并触发第二次翻译，断言旧窗仍可见、新窗内容尺寸相同、原点偏移 `(-24, +24)`（`stackOk=true`）；等待第二个流完成后清理。断言退出码 0、`selftest-result.json`、截图尺寸、`helper.log` 无 ERROR。截图只写到本地 `preview\` 目录，不随仓库提交。`selftest-result.json` 新增 `stackOk/stackOffsetX/stackOffsetY/stackSameSize/oldVisible/stackFirstRect/stackSecondRect`。
4. 生命周期：普通模式启动 helper，等 `/v1/status` ready，写入 `command.json` 验证 preview 命令，然后关闭 stdin，断言 8 秒内退出且退出码 0。

通过时最后一行是 `SELFTEST: PASS`，退出码 0。

### 已知限制：低完整性沙箱

当前 DSH agent shell 及其子进程带低完整性令牌（`Mandatory Label\Low Mandatory Level`）。实测 Windows 会静默丢弃该进程的 `SendInput`（被 UIPI 拦截），全局钩子也收不到高完整性进程的输入，`HttpListener` 同样不可用。因此：

- 在沙箱内跑自测时，真实钩子注入项打印 `SKIP` 并说明原因，改用钩子引擎自注入完成事件队列与 longpress 判定校验；其余项全部真实执行，selftest 仍以 exit 0 结束。
- 在普通用户终端（中等完整性）重跑并加 `-RequireRealHook`，真实钩子注入项会被强制校验，用来验证生产形态。
- helper 由 DSH 宿主拉起时继承宿主的中等完整性令牌，钩子、SendInput、剪贴板均正常工作。

## 已知限制

- 取词只走 Ctrl+C + 剪贴板。命令行程序、部分游戏、以管理员权限运行的应用（UIPI 拦截 SendInput）、剪贴板被其他程序长期占用时会取不到词；此时静默返回，不弹窗。
- 剪贴板只备份与还原 Unicode 文本和 DIB 位图。富文本（HTML/RTF）等格式在取词后会被替换为纯文本。
- 多显示器混合 DPI 时窗口位置用物理像素 SetWindowPos 定位，通常正确；WPF 内部缩放与 150% 以上缩放的极端组合未逐项实测。
- 结果窗快捷键需要窗口获得焦点。工具栏不抢焦点（`WS_EX_NOACTIVATE`），结果窗可获取焦点。
- 工具栏溢出菜单（“…”）与紧凑模式的视觉效果未纳入自动截图断言，只做了代码路径检查。
- `kind=search` 用内置 Google 模板；若 `helper-config.json` 的 action 带 `searchUrl`，则用该模板（`{{query}}` 替换为 URL 编码后的选中文本）。
- 结果窗位置计算以主屏工作区/工具栏所在显示器为准，跨屏后不会自动跟随移动。

## 宿主联调注意

- `helper-config.json` 的 `endpoint` 不带尾部斜杠也兼容（helper 会去掉尾部 `/`），但建议按契约写成 `http://127.0.0.1:<port>`。
- 本目录脚本改动后，重启助手进程即可生效（设置页「重启助手」或 `POST /selection-assistant/helper/restart`），无需重启 DSH、无需重新构建；只有宿主 `src/` 改动才需要重启 DSH。
- helper 启动流程：读配置 → 编译 C# 原生层（约 0.6s）→ 初始化 WPF → 安装钩子 → `POST /v1/status {"state":"ready"}`。收到 ready 后宿主可以更新状态为 running。
- SSE 请求体：`{requestId, actionId, text, source:{app}, locale}`；`Authorization: Bearer <token>`。宿主关闭结果窗时代码会 `Cancel()` 请求（关闭响应流），宿主应据此 abort `ctx.llm.stream`。
- helper 对 `/v1/log` 的 POST 是 fire-and-forget，失败不重试、不影响主流程；本地 `helper.log` 始终写。
- 宿主退出时关闭 stdin 即可让 helper 退出；helper 也会在初始化失败时写本地日志并以非零码退出，宿主可据此显示错误。
- 进程崩溃/被杀时 Windows 会自动解除全局钩子，不会残留托底输入拦截。
