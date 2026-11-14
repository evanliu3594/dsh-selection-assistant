# AGENTS.md — dsh-selection-assistant（项目总纲）

> 本文件只保留目标、架构、已拍板口径与规则；会话进展写 `handoff/`，文件级细节写各目录说明，历史不堆进本文件。

## 0. 目录结构

| 目录 / 文件 | 职责 | 明细 |
|---|---|---|
| `src/` | 宿主半体：设置持久化、模型桥、助手进程管理、两个 HTTP 面 | 见 `src/` 内注释与 `references/contracts.md` |
| `src/client/` | 浏览器半体：DSH 设置页「划词助手」 | `references/contracts.md` §3 |
| `helper/` | Windows 助手进程（PowerShell 7 或 Windows PowerShell 5.1 + WPF）：全局钩子、取词、工具栏、结果窗 | `helper/README.md` |
| `helper/macos/` | macOS 助手进程（Swift + AppKit）：事件 tap、取词、工具栏、结果窗 | `helper/macos/README.md` |
| `scripts/` | 构建与验证脚本（esbuild CLI、swiftc、探针、宿主/浏览器/助手验证） | 本文件 §4 |
| `lib/` | 构建产物：`lib/index.js`（宿主）、`lib/client.js`（浏览器） | 只由 `node scripts/build.mjs` 生成 |
| `helper/macos/bin/` | macOS 助手编译产物（gitignored，首次启动时由宿主构建） | `scripts/build-macos-helper.sh` |
| `references/` | 接口契约、Cherry Studio 对照研究、验证记录 | `contracts.md` 是接口唯一出处 |
| `diagnosis/` | 归档的一次性排查脚本 | `diagnosis/deprecated/README.md` |
| `handoff/` | 会话交接记录 | 最新一份 = 当前状态入口 |
| `locale/` `icon.svg` | 插件元数据（Plugin Manager / 设置页读取） | — |
| `package.json` `cordis.patch.yml` | bundle 声明与安装层 | — |

## 1. 目标

让用户在**任意 Windows 或 macOS 软件**里选中文字后长按 Ctrl（macOS 为 Control），弹出划词工具栏，一键调用 DSH 当前配置的 DeepSeek 模型完成翻译、解释、总结、搜索、复制等动作。形态、动作集合与设置方式参考 Cherry Studio 的 selection-assistant；模型服务默认来自 DeepSeek（通过 DSH 的 `ctx.llm`，不另存 API Key）。

## 2. 架构（已拍板）

| # | 决策 | 理由 |
|---|---|---|
| ① | 宿主半体运行在 DSH Host 的 Node 子进程，**不碰 Electron** | 实测 `dsh-desktop-host` 用 fork 启动运行时，插件拿不到 `BrowserWindow` |
| ② | 悬浮工具栏/结果窗由独立 helper 进程提供 | 只有独立进程能跨应用置顶；Windows 用 PowerShell 7（未安装时 Windows PowerShell 5.1）+ WPF，macOS 用 Swift + AppKit |
| ③ | 取词只用剪贴板路径：保存 → 复制快捷键 → 读 → 还原 | 无 UIA、无截屏，权限与隐私成本最低；Windows 为 Ctrl+C，macOS 为 ⌘C |
| ④ | 模型调用走 `ctx.llm.prepareCall()/stream()`，默认跟随 `agentDefaultModel` | 复用 DSH 的 DeepSeek 账号与模型路由，零凭据 |
| ⑤ | 设置存 `<DSH_HOME>/selection-assistant/settings.json`，不走 plugin row config | 保存设置不应触发插件重启；row config 只留 dataDir/helperPath 两个引导项（旧 pwshPath 兼容） |
| ⑥ | helper ↔ 宿主用回环 HTTP + 每次启动随机 token；SSE 流式 | helper 不依赖 DSH 鉴权，宿主不依赖 helper 内部结构 |
| ⑦ | 每个动作一次独立模型调用，temperature 全局 | 与 Cherry 一致；暂不做多轮会话 |
| ⑧ | 双平台：Windows 10/11 + macOS 13.1+ | 两个平台各有原生助手；其他系统插件不崩，设置页显示原因。macOS 需要辅助功能授权 |
| ⑨ | 不做「引用到 DSH 会话」与「Ask Agent」 | 需要 DSH 会话写入通道，超出本次范围；README 已写明 |

## 3. 接口与文件归属

- `src/contract.ts` 是共享类型（Settings、ActionSettings、HelperConfig、StateDto、路由前缀、默认动作与默认提示词），宿主与浏览器半体都从它导入；helper 只看 `references/contracts.md` 的 JSON 形态。
- `src/lang.ts` 是翻译语言模块：语言表、系统默认语言、本地检测、目标分流与 `LanguageOverlapError`。设置字段 `language.target` / `language.fallback` 存语言代码。
- 翻译规则：源语言已知且不是 target → target；等于 target → fallback；target == fallback 且源语言是 target → 报错「目标语言与源语言重叠」，不调用模型；unknown 交给模型。
- 新增/修改任何跨进程字段：先改 `references/contracts.md`，再改 `src/contract.ts`，最后改两端实现。
- 默认动作（6 个）：translate / explain / summarize / search / copy 启用，optimize 关闭；自定义动作上限 20，工具栏直显上限 8。

## 4. 构建与验证（双平台，缺一有盲区）

```bash
# 两端通用
node scripts/build.mjs                  # esbuild CLI；改完 src/ 必须重跑
node scripts/probe.mjs                  # 宿主产物：裸导入、冷上下文 apply、settings.json 生成
node scripts/verify-host.mjs            # 宿主：设置夹紧/落盘、全部路由（含权限路由）、回环 SSE、鉴权、错误帧
node scripts/verify-client-bundle.mjs   # 浏览器：注册 id、模块表、settings.section、locale、行内提示换行守卫

# Windows
node scripts/verify-helper-resolve.mjs  # 助手解析：pwsh 优先、powershell.exe 兜底、双运行时探测、helper-config 字段
node --experimental-strip-types scripts/verify-lang.mjs  # 翻译语言检测与目标分流
pwsh -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1   # 助手：mock 宿主 + 按钮点击 + 截图 + 钩子层
powershell.exe -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1   # 5.1 自测；或 pwsh selftest 加 -PowerShellExe 指定 5.1 助手

# macOS
sh scripts/build-macos-helper.sh        # swiftc 编译 app（首次启动时宿主也会自动调用）
node scripts/verify-macos-helper.mjs    # 编译 + 自测截图 + mock 宿主 SSE + LaunchServices + 健康退出
node scripts/verify-host-macos.mjs      # 真实 HelperManager 启动 app + 预览 SSE + 停止回收
# 已授权机器给两条 verify 命令加 --skip-build，避免重建 app 改变签名而丢失 TCC 授权
```

- 本机 shell 沙箱会拦 Node 的 piped-stdio 子进程，所以构建走 esbuild CLI + `spawnSync(stdio:'inherit')`；不要改用 esbuild JS API。
- 在 DSH shell 里跑 `verify-host.mjs` 若出现挂起（loopback 与端点交互的沙箱限制），改用后台方式执行；脚本自身以 `process.exit` 收尾。
- 浏览器半体没有浏览器内点击验证：产物注册面 + jsdom 冒烟已覆盖，视觉验收留给用户。
- Windows 全局钩子的真实注入需交互式桌面会话：`helper/selftest.ps1 -RequireRealHook`。agent 会话为低完整性令牌，普通 selftest 该项 SKIP。
- macOS 的辅助功能授权无法由 agent 代授予：自动验证覆盖编译、窗口渲染、SSE、LaunchServices 启动与健康退出；真实拖选取词与 ⌘C 需人工在系统设置授权后验收。
- 安装后的完整链路验证记录见 `references/verification.md`。

## 5. 规则

- 代码 ESM、无 `@deepseek-ai/*` 运行时依赖（宿主与浏览器都不 import DSH 包）；需要 DSH 服务时用 `ctx.get(...)` 的结构化类型。
- 面向用户的文案中文（或按 UI locale 双语）；日志写文件，不写凭据与剪贴板内容。
- 不修改 DSH 本体的 profile `package.json` / `cordis.patch.yml`，安装走 `plugin_manager install_bundle` 或 `dsh plugin add`。
- helper 进程只由宿主拉起与回收；stdin 关闭 = 宿主退出，helper 必须退出。
- Windows 助手双运行时：`SelectionHook.cs` 保持 C# 5（Windows PowerShell 5.1 的 Add-Type 上限）；三个 `.ps1` 保存为 UTF-8 with BOM；时钟用 `Clock.NowMs`/`Get-NowMs`，不使用 `Environment.TickCount64`。
- Windows 钩子只忽略助手自身的 `SendInput`（`dwExtraInfo` 标记）；ToDesk、远程桌面等外部注入输入按用户输入处理；取词兜底顺序为 `SendInput Ctrl+C` → `WM_COPY` → `PostMessage Ctrl+C`。
- macOS 助手打包为 `helper/macos/bin/SelectionAssistant.app`，宿主用 LaunchServices（`open`）启动；直接 spawn 内层二进制的授权会算到 DSH 头上，不要改成 spawn。源码改动会让宿主在下次启动时重新编译；产物不提交。重新编译会改变 ad-hoc 签名，辅助功能授权可能需要重新添加。
- macOS 没有 stdin 管道：助手每 2 秒请求宿主 `/v1/health`，连续 3 次失败即退出；宿主按 `helper-state.json` 的 pid 发 SIGTERM 停止。Windows 仍用 stdin EOF。
- 文档语言直白、先结论后证据；不出现「不是……而是……」句式。
- 未知字段、越界数值一律在宿主侧夹紧，不信任 settings.json 与请求体。
- 公开仓库包含源码、构建产物、验证脚本、用户文档、设计文档（`references/`）与 `AGENTS.md`；`handoff/`、`diagnosis/`、`helper/preview/` 由 `.gitignore` 排除，不进入 git tree。发布前在临时副本里 `git init` + `git add -A` 核对 tracked 集合与泄漏。

## 6. 当前状态

0.2.4 在 0.2.3 基础上修复远程控制/合成输入下的触发与取词。Windows 实机已验证，已推送 `main`（`ff306c0`）；macOS 端补上远程注入 Ctrl 与 AX 取词兜底，验证见下。0.2.3 新增翻译语言设置与本地预判；0.2.2 新增 Windows PowerShell 5.1 兜底；0.2.1 已合并到 `main`，并已安装进 desktop profile（Windows 实机，`application: applied`）。Windows 0.1.0 行为保留，0.2.1 新增结果窗几何固化与多窗口堆叠，两端均已实现。

macOS 验证结果（2026-11-06，macOS 27.2 arm64、Swift 6.4.2）：

- 构建：`sh scripts/build-macos-helper.sh` PASS（arm64 13.1，646944 字节）。
- 助手自测：PASS；`ok/clicked/pinToggled/resizeOk/stackOk/done` 全 true，`sessionCount=2`。
- 助手端到端：`node scripts/verify-macos-helper.mjs` PASS（LaunchServices、权限 error 帧、预览 SSE、截图、健康退出）。
- 宿主管线：`node scripts/verify-host-macos.mjs` PASS（真实 HelperManager 构建启动、UserDefaults、预览动作、SIGTERM 回收）。
- 通用门：`probe`、`verify-host`、`verify-client-bundle` PASS。
- 权限归属与 0.2.0 相同：`open` 启动 app 的 responsible pid 是自己、AX trust=false。
- 自动化验证数据目录在系统临时目录；LaunchServices app 读取 Desktop 下配置会触发“桌面文件夹”TCC，生产 `~/.dsh` 不受影响。

Windows 0.2.1（2026-11-06 Windows 实机补测）：

- 结果窗列表、每窗 Stream、pin 叠窗与未 pin 原位、`resultX/resultY` 已实现。
- `helper/selftest.ps1` PASS=22 SKIP=1 FAIL=0，多窗口断言（旧窗保留、同尺寸、偏移 `-24,+24`）通过；几何专项测试 PASS。
- 实机修复：`Show-ResultWindow` 的 `$win.Activate()` 返回值泄漏进函数输出，导致结果流无法启动；改为 `[void]$win.Activate()`（提交 `07c8ac9`）。
- 运行中插件已通过 `plugin_manager remove_bundle` + `install_bundle` 升级到 0.2.1（`application: applied`）；预览窗拖动/缩放后 `helper-state.json` 写入 `resultX/resultY/resultWidth/resultHeight`，下一个结果窗 rect 与保存值一致。
- 待实机验收：pin 叠窗真实交互、多屏混合 DPI、重启后的几何恢复、真实划词端到端。

Windows 0.2.2（2026-11-06 Windows 实机验证）：

- 双运行时兜底：`pwsh` 7 优先，未安装时使用 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`；设置页状态卡显示运行环境。
- 三组自测 PASS=22 SKIP=1 FAIL=0：7 宿主+7 助手、7 宿主+5.1 助手、5.1 宿主+5.1 助手；两运行时 `helper.log` 均无 ERROR。
- 与 0.2.1 基线断言逐条一致；`probe`、`verify-host`、`verify-client-bundle`、`verify-helper-resolve` PASS；构建产物哈希可重复。
- C# 5、UTF-8 BOM、`Get-NowMs`/`Clock.NowMs` 的约束已写入 §5。
- 待人工验收：真实桌面 5.1 全局钩子/SendInput、5.1 多屏混合 DPI 与深色主题、宿主真实 spawn 5.1 的实机安装链路。

Windows 0.2.3（2026-11-06 Windows 实机验证）：

- 设置页新增「翻译语言」区：目标语言默认取本机显示语言，备选语言默认 English；旧设置显示名自动迁移为语言代码。
- 本地预判模块 `src/lang.ts`：源语言已知时按 target/fallback 分流；target == fallback 且源语言是 target 时不调用模型，SSE 返回 `error`（code=language-overlap，message=目标语言与源语言重叠）；unknown 交给模型。
- `verify-lang` 122 项、全部 node 门、`helper/selftest.ps1` PASS；独立验证 248 项，重叠路径 prepareCall=0。
- 实机安装 0.2.3：旧设置迁移为 `zh/en`；切到 `en/en` 后英文 action 返回 meta + error；恢复 `zh/en`。
- 待人工验收：真实模型对 unknown 文本的兜底、设置页真实渲染与下拉交互、结果窗显示该错误。

Windows 0.2.4（2026-11-13 Windows 实机验证）：

- 触发：钩子只忽略助手自身 `SendInput`（`dwExtraInfo` 标记 `SELa`）；ToDesk 注入的键鼠事件按用户输入处理。
- 取词：常规 `SendInput Ctrl+C` 读不到文字时，依次尝试 `WM_COPY` 和 `PostMessage Ctrl+C`。
- ToDesk 远程 + Zed：拖选 23 个字符后长按 Ctrl 成功触发；日志显示 `WM_COPY` 后 `PostMessage Ctrl+C` 取词成功。
- PS7.7.0 与 PS5.1.19041.6456 下 `Add-Type` 编译 PASS；三个 `.ps1` 解析 0 错误。
- 待人工验收：其他远程控制工具、Zed 以外应用、剪贴板被占用场景。

macOS 0.2.4 远程注入验证（2026-11-14，macOS 27.2 arm64、Swift 6.4.2）：

- 事件 tap 继续只忽略助手自身合成事件；ToDesk 等外部注入的键鼠事件按用户输入处理。
- remote-control 只发 Ctrl `keyDown/keyUp`、不发 `flagsChanged` 时，归一化为状态事件后长按可触发。
- 鼠标事件带 Control 标志、没有单独键盘状态时，鼠标松开也能启动长按。
- `⌘C` 取不到文字时，追加读取前台元素的 `kAXSelectedTextAttribute`；合成测试取到 95 字符。
- 构建：`sh scripts/build-macos-helper.sh --universal` PASS；app 版本 0.2.4，`x86_64 + arm64`，codesign PASS。
- `verify-macos-helper --skip-build` PASS（selftest、预览 SSE、健康退出）；重建后辅助功能授权为 false，需人工重新添加。

macOS 0.2.3 兼容验证（2026-11-10，macOS 27.2 arm64、Swift 6.4.2、Node 26.13.0）：

- 拉取 `main` 到 `90782ed`，`package.json` 版本 0.2.3；0.2.2/0.2.3 没有改 macOS 助手源码。
- 通用门 PASS：`build`、`probe`、`verify-host`、`verify-client-bundle`、`verify-lang`（122 项）。
- 已授权机器上用 `--skip-build` 跑 macOS 验证：`verify-macos-helper` PASS（ready、accessibility true、selftest 全 true、sessionCount=2）；`verify-host-macos` PASS（status running、预览 SSE、SIGTERM 回收）。
- 当前 macOS 设置 `简体中文/English` 在内存中迁移为 `zh/en`；首次保存后落盘为语言代码。
- 合成真实取词测试：正式助手日志 `触发 [ctrl-longpress] app=SelectionTriggerTest chars=59`，事件 tap 与 ⌘C 取词均正常。
- 2026-11-10 19:01 重启后宿主加载 0.2.3；19:01 与 19:07 在 DeepSeek Harness 窗口真实触发 134/136 字符，translate SSE 完成。
- 2026-11-10 19:18 通过插件管理器完成热卸载/热重装（`application: applied`）；profile 依赖恢复 `link:`，状态路由 200，助手 running，权限 granted；用户设置与 TCC 授权保留；全程未重启 DSH、未重建 app。
- 2026-11-11 已对齐 macOS app 版本：`CFBundleShortVersionString=0.2.3`，二进制为 `x86_64 + arm64` universal，codesign 校验通过。重建改变 ad-hoc 签名，辅助功能授权需要重新添加。

待人工验收：macOS 真实应用（浏览器/TextEdit）拖选与长按 Control、两端 pin 叠窗与几何恢复、深色主题、多屏/混合 DPI、真实 DeepSeek 端到端。

注意：macOS 辅助功能授权无法由 agent 代授予。重新编译 app 会改变 ad-hoc 签名，授权可能需要重新勾选。宿主 `src/` 改动后，用 `plugin_manager` 移除并重新安装 bundle 可即时生效（本次实测 `application: applied`）；直接替换文件不会热重载，必要时完整重启 DSH。macOS 助手源码改动后宿主下次启动会重新编译 app；浏览器半体更新后重建 `lib/` 并刷新设置页。

## 7. 参考

- 接口契约：`references/contracts.md`
- 结果窗几何规则：`references/result-window-geometry.md`
- 本地安装、卸载与重装：`references/install.md`
- Windows 助手：`helper/README.md`
- macOS 助手：`helper/macos/README.md`
- Cherry Studio 对照研究：`references/cherry-studio-selection-assistant.md`
- DSH 插件开发：skill `cordis-plugin-development`。
