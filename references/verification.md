# 验证记录 — dsh-selection-assistant（0.1.0 Windows / 0.2.0 双端 / 0.2.1 结果窗几何 / 0.2.2 双运行时 / 0.2.3 翻译语言）

0.1.0 验证环境：Windows 11、DSH 桌面版 0.2.2-rc.1（desktop profile）、PowerShell 7.6.9、DSH 默认模型 `deepseek-account / deepseek-flash`。

0.2.0 与 0.2.1 验证环境：macOS 27.2（arm64）、Swift 6.4.2（Xcode Command Line Tools）、Node 26.13.0、DSH 桌面版 0.2.1-rc.3。Windows 结果窗改动最初只在 macOS 上做 PowerShell 语法与纯函数几何校验；2026-11-06 晚已在 Windows 实机安装 0.2.1，并补齐 WPF 自测与实时几何验证（见 §10.2）。

本文件保留 0.1.0 的完整验证记录。0.2.0 的 macOS 验证见第 9 节，0.2.1 的结果窗几何验证见第 10 节。

## 1. 验证矩阵与结果

| 面 | 命令 / 方法 | 覆盖 | 结果 |
|---|---|---|---|
| 宿主产物 | `node scripts/probe.mjs` | 裸导入 `lib/index.js`、`apply/inject/name` 导出、冷上下文不抛错、settings.json 生成 | PASS（基线） |
| 宿主逻辑与路由 | `node scripts/verify-host.mjs` | 设置默认值/夹紧/落盘/重载；7 条路由（state/settings/models/test/restart/preview/logs）；404/405；回环 SSE 鉴权、meta/delta/done、错误帧、413 上限 | PASS（基线） |
| 浏览器产物 | `node scripts/verify-client-bundle.mjs` | `dsh.client.platform`、`exports["./client"]`、`__ModuleLoader__` 注册 id、平台模块表、`settings.section` 注册、locale 字典 | PASS |
| 设置页布局守卫 | `node scripts/verify-client-bundle.mjs`（布局规则） | 构建产物中 `.sa-row-text` 含 `flex:1 1 auto`、`.sa-row-hint` 含 `overflow-wrap:anywhere` 与 `word-break:break-word`；修复前旧产物跑新守卫 FAIL（3 条缺失） | PASS |
| 助手解析与配置 | `node scripts/verify-helper-resolve.mjs` | pwsh 候选顺序、拒绝 PowerShell 5.1、候选可启动且为 PowerShell 7、helper-config 字段（actions/searchUrl/result 500×400/trigger）、spawn 失败的可见错误 | PASS（基线） |
| 助手自测 | `pwsh -File helper/selftest.ps1` | 钩子层事件队列与 longpress 判定、mock 宿主 HTTP/SSE、`-SelfTest` 启动、工具栏/结果窗截图、命令文件、stdin 生命周期、Bearer token | PASS=21 SKIP=1 FAIL=0 |
| 工具栏按钮点击 | `-SelfTest` 第 2 步对「翻译」按钮触发 `RaiseEvent`（真实 WPF 路由事件） | 点击处理器 → `Invoke-Action` → 结果窗打开 → 回环 SSE 完整流；`selftest-result.json` 的 `clicked=true` | PASS |
| 按钮点击回归 | 修复前代码 + 新自测（临时副本） | 旧闭包缺陷必须被新自测判失败 | PASS：FAIL=1，失败原因为「helper 自测未经工具栏按钮点击触发动作」 |
| 结果窗 pin 按钮 | `-SelfTest` 第 2 步对结果窗 pin 按钮触发 `RaiseEvent` 两次 | 钉住后 `Topmost=true`；再点取消钉住后 `Topmost` 恢复 `DefaultTopmost`；`selftest-result.json` 的 `pinToggled=true` | PASS |
| pin 按钮回归 | 新增 pin 前的代码 + 新自测（临时副本） | 缺少 pin 按钮必须被新自测判失败 | PASS：FAIL=1，失败原因为「helper 自测未经 pin 按钮切换置顶」；旧 UI + 新入口副本报「结果窗缺少 pin 按钮」 |
| 部署（工具栏按钮修复） | `POST /selection-assistant/helper/restart`，随后读 state 与 helper.log | 新助手进程启动、状态 running、启动后无新增 ERROR | PASS（PID 19364 → 27260，启动时间 2026-11-05 22:15:19） |
| 部署（pin 按钮） | `POST /selection-assistant/helper/restart`，随后读 state 与 helper.log | 新助手进程启动、状态 running、启动后无新增 ERROR | PASS（PID 27260 → 15076，启动时间 2026-11-06 11:45:25） |
| 客户端发布（设置页布局修复） | 读 `/plugins/events` 图条目，拉取插件客户端资源 | DSH 运行实例发布的 bundle 含换行修复；条目 rev 随重建更新；页面刷新即可生效 | PASS（rev 更新为 `110fb7f8`，资源含两条规则） |
| 助手重启（设置页布局修复） | `POST /selection-assistant/helper/restart`，随后读 state 与 helper.log | 新助手进程启动、状态 running、启动后无新增 ERROR | PASS（PID 15076 → 17932，启动时间 2026-11-06 12:53:57） |
| 应用图标 | `icon.svg` 解析 + GDI+ 近似预览 + 尺寸检查 | SVG XML 合法；30px/36px 下轮廓可辨认；浅色与深色底都有对比；文件大小远低于插件图标的 256 KiB 上限 | PASS |
| 真实插件加载 | 安装到 desktop profile 后经 live web 路由读取 | bundle `install_bundle` → `application: applied`；`GET /selection-assistant/state` 返回 settings/helper/platform/paths；`GET /models` 列出 DeepSeek 模型 | PASS（基线） |
| 真实模型调用 | 读取 helper-config 后直连回环 `/v1/action` | 走 DSH `ctx.llm` 调 DeepSeek 翻译英文句子：两条 meta + 流式 delta + done，耗时 1.1s，输出正确 | PASS（基线） |
| 设置页 | 浏览器半体构建 + jsdom 冒烟（settings-ui-dev 执行） | 9 个区块渲染、防抖保存只提交改动字段、动作编辑/排序/删除、失败横幅与重试、日志 Modal | PASS（非浏览器视觉，基线） |
| 全局钩子真实触发 | 需交互式桌面会话 | 当前 agent 会话进程为低完整性令牌，SendInput 被 UIPI 丢弃、钩子收不到高完整性输入 | SKIP |

## 2. 关键实测事实

- DSH Host 插件运行在独立 Node 子进程，拿不到 Electron `BrowserWindow`；悬浮窗必须由独立原生进程提供（本实现用 PowerShell 7 + WPF）。
- PowerShell 脚本块不闭包函数局部变量。函数返回后，注册到 WPF 事件上的处理器读不到该函数的参数与局部变量。早期实现中全部动作按钮因此失效，点击时抛「管道元素中 '&' 后面的表达式生成了无效对象」。
- 该异常被 `Application.DispatcherUnhandledException` 捕获并置 `Handled = true`，助手进程不崩溃、工具栏保持显示，用户看到的现象是按钮无反应。排错时先查 helper.log 的 `[ERROR]` 行。
- `-SelfTest` 早期第 2 步直接调用 `Start-ResultStream`，绕过按钮点击；早期 selftest 的 ERROR 正则也不命中日志格式。两处盲区共同掩盖了该缺陷，现已修复。
- Host 进程无法用 `existsSync` 读取 `%LOCALAPPDATA%\Microsoft\WindowsApps` 下的 pwsh 路径，但 `CreateProcess` 仍可启动；因此 pwsh 解析不依赖 stat，并保留 `pwsh` 裸名兜底。
- 回环 ActionServer 与设置路由在 DSH web 服务上均可访问；设置路由同源、无 CORS 头。
- 真实 DeepSeek 流式输出经 `ctx.llm.prepareCall()` + `stream()` 正常，无需额外凭据。
- 助手脚本改动后，重启助手进程即生效（设置页「重启助手」按钮或 `POST /selection-assistant/helper/restart`），无需重启 DSH、无需重新构建。宿主 `src/` 改动才需要重启 DSH。
- 结果窗 pin 按钮钉住时同时置顶并跳过两条自动关闭路径（结果窗 `Deactivated`、全局鼠标按下命中窗口外）；取消钉住后置顶恢复 `result.alwaysOnTop`，自动关闭恢复 `result.autoClose`。
- pin 状态按窗口维护，新结果窗初始未钉住。钉住态图标为实心 `U+E840` 加强调色，未钉住为空心 `U+E718` 加 muted 色。
- 设置页客户端 bundle 由 DSH 的 client-hmr 监听：重新构建 `lib/client.js` 后，运行中的 DSH 会把新 rev 发布到 `/plugins/events`，插件资源按新 rev 提供。页面刷新或重新打开设置页即加载新 bundle，不需要重启 DSH。
- 设置页「高级」区的检测路径是无空格长串。行布局中左侧文本列没有换行规则时，文字会溢出并被右侧 300px 输入框遮挡；`overflow-wrap:anywhere` 加 `flex:1 1 auto` 让提示在列内换行后，行高增加 16px（2 行）或 32px（3 行），卡片随之变高。
- 助手自测中 27 个请求全部携带正确 Bearer token；关闭 stdin 后助手 8 秒内退出（实测约 40ms–2s）。

## 3. 未验证 / 人工验收项

1. 真实动作按钮点击：设置页状态卡确认「运行中」，在 Chrome/记事本/Word 里选中文字 → 长按 Ctrl → 点「翻译」→ 结果窗流式出现译文。自测用同进程 `RaiseEvent` 覆盖了点击链路，真实鼠标点击仍留给用户验收。
2. 结果窗 pin 按钮的真实鼠标点击：点 pin 后点其他应用窗口，确认结果窗保持可见；再点 pin 取消，确认按设置恢复自动关闭。自测用 `RaiseEvent` 与处理器级测试覆盖，真实点击与窗口激活时序留给人工作业。
3. 设置页高级区在真实浏览器里的像素验收：刷新后确认「PowerShell 路径」的检测路径换行显示、不再与输入框重合。本机沙箱禁止浏览器自动化，只能用构建守卫与列宽计算验证。
4. 设置页在真实 DSH 设置里的视觉与交互（本机无法在浏览器内点击验收）。
5. 深色主题下的工具栏/结果窗与 pin 图标（自测截图只有浅色）。
6. 多显示器混合 DPI 的定位精度。
7. 管理员权限应用、游戏、UWP 沙箱应用中的取词成功率。
8. `-RequireRealHook` 的真实钩子注入（需非低完整性会话运行 `helper/selftest.ps1 -RequireRealHook`）。

## 4. 人工验收步骤

1. 打开 设置 → 划词助手，确认状态卡为「运行中」；若为错误，点「查看日志」。当前版本已随助手进程重启与客户端 bundle 发布生效，无需重启 DSH。
2. 在「高级」区确认「PowerShell 路径」的提示文字换行显示，与右侧输入框不重合。
3. 在任意应用里选中一段文字，按住 Ctrl 约 0.5 秒。
4. 点「翻译」，确认结果窗流式出现译文；`Esc` 关闭、`C` 复制、`R` 重新生成。
5. 点结果窗标题栏的 pin 按钮：窗口置顶并保持。点其他应用窗口，确认结果窗不关闭。
6. 再点 pin 取消钉住，点其他应用窗口，确认结果窗按「失焦自动关闭」设置关闭。
7. 依次点其余动作按钮（解释、总结、搜索、复制），确认每个都有反应。
8. 在桌面版 `%USERPROFILE%\.dsh\selection-assistant\helper.log` 与 `plugin.log` 查看运行日志。点击动作后不应再出现「未处理的 UI 异常」行。

## 5. 修复记录：工具栏按钮点击无反应

状态：已修复、已验证、已部署。

根因：`helper/lib/Ui.ps1` 的 `New-UiHoverButton` 用函数参数 `$OnClick` 绑定 WPF `MouseLeftButtonUp`。PowerShell 脚本块不闭包函数局部变量，函数返回后事件处理器中 `$OnClick` 为 `$null`，`& $null $sender` 抛「管道元素中 '&' 后面的表达式生成了无效对象」，异常被全局 UI 异常处理器吞掉。只有动作按钮传入 `-OnClick`，因此全部动作按钮失效；关闭按钮、溢出菜单与结果窗按钮在调用点直接绑定处理器，引用 `$script:` 变量与脚本函数，工作正常。

修复：

| 文件 | 改动 |
|---|---|
| `helper/lib/Ui.ps1` | `New-UiHoverButton` 删除 `-OnClick` 参数与绑定块；动作按钮在调用点绑定 `Add_MouseLeftButtonUp` 并调用 `Invoke-UiActionClick $sender.Tag`；新增 `Get-ToolbarActionButton` |
| `helper/SelectionAssistant.ps1` | `-SelfTest` 第 2 步改为对「翻译」按钮 `RaiseEvent` 并断言结果窗打开；自测状态与结果 JSON 增加 `clicked` |
| `helper/selftest.ps1` | ERROR 正则改为 `\[ERROR\] `；新增 `clicked` 断言 |

回归证据：

1. 修复前代码配新自测：FAIL=1，失败原因为「helper 自测未经工具栏按钮点击触发动作」；修复前基线单独运行旧自测为 PASS=19 SKIP=1 FAIL=0。
2. 旧缺陷 UI 配新点击驱动自测：PASS=11 SKIP=1 FAIL=9，helper.log 命中原错误文本「管道元素中 '&' 后面的表达式生成了无效对象」。
3. 修复后代码：Lead 终检与独立复验各跑两遍，均 PASS=20 SKIP=1 FAIL=0，helper.log 无 ERROR 行。
4. 部署后：新助手进程 PID 27260 于 22:15:19 启动，状态 running，启动后无新增 ERROR。

证据与复验报告：`diagnosis/action-button-click-2026-11-05/`（README.md、before/ 旧代码副本、verify-report.md、deploy-report.md、lead-final-selftest.txt）。

## 6. 功能记录：结果窗 pin 按钮

状态：已实现、已验证、已部署。

需求：结果窗加 pin 按钮，用户选择是否让窗口钉在最前。用户确认语义：钉住 = 保持可见。

交互：

- 按钮位于结果窗标题栏右侧、关闭按钮左侧。
- 钉住：`Topmost=true`，点击其他窗口不关闭；图标实心 `U+E840` 加强调色，Tooltip「取消钉住」。
- 取消钉住：`Topmost` 恢复 `result.alwaysOnTop`，自动关闭恢复 `result.autoClose`；图标空心 `U+E718` 加 muted 色，Tooltip「钉在最前」。
- 每个新结果窗初始未钉住，不跨窗口记忆。

实现：

| 文件 | 改动 |
|---|---|
| `helper/lib/Ui.ps1` | 标题栏加 pin 按钮（与关闭按钮同放 StackPanel，处理器在调用点绑定）；新增 `Set-ResultPinned` / `Toggle-ResultPinned` / `Get-ResultPinned`；结果窗状态含 `Pinned`、`DefaultTopmost`、`PinButton`、`PinGlyph`；`Deactivated` 在钉住时不关闭 |
| `helper/SelectionAssistant.ps1` | 全局鼠标按下自动关闭路径在钉住时跳过；自测状态与结果 JSON 增加 `pinToggled`；`-SelfTest` 用 `RaiseEvent` 点击 pin 两次并断言钉住/取消钉住 |
| `helper/selftest.ps1` | 新增 `pinToggled` 断言（PASS 由 20 升到 21） |

回归证据：

1. 新增 pin 前的代码配新自测：FAIL=1，失败原因为「helper 自测未经 pin 按钮切换置顶」。
2. 旧 UI 配新入口配新自测：`error=结果窗缺少 pin 按钮`，自测退出码 1。
3. 新代码：Lead 终检与独立复验各跑两遍，均 PASS=21 SKIP=1 FAIL=0，helper.log 无 ERROR 行。
4. 处理器级独立验证：`Deactivated` 与全局鼠标按下两条自动关闭路径在钉住时关闭计数为 0，取消钉住后恢复为 1；钉住/取消时 Topmost、字形、颜色、Tooltip 全部符合规格。
5. 部署：新助手进程 PID 15076 于 2026-11-06 11:45:25 启动，状态 running，启动后无新增 ERROR。

证据与复验报告：`diagnosis/result-pin-button-2026-11-06/`（README.md、before/ 旧代码副本、run1/run2 自测输出、旧代码回归输出、result-titlebar-zoom.png、verify-report.md、deploy-report.md、lead-final-selftest.txt）。

## 7. 修复记录：设置页高级区提示与输入框重合

状态：已修复、已验证、已随客户端 bundle 发布生效。

现象：设置 → 划词助手 → 高级，「PowerShell 路径」一行的提示「已探测到：C:\...\pwsh.exe」与右侧输入框重合，路径文字被输入框遮挡。

根因：`src/client/ui.tsx` 的 `FieldRow` 用水平 flex 行放左侧文字区与右侧控件。`.sa-row-text` 只写了 `min-width:0`，`.sa-row-hint` 没有换行规则；检测路径是无空格长串，实测 434.6px（12px 微软雅黑 UI）。输入框外框 317px（300 内容 + 16 内边距 + 1 边框），左侧文字列只有 199px（卡片约 570）到 389px（卡片 760），提示文字溢出到输入框下面，被输入框背景遮住。旧布局在最大卡片宽度下仍溢出约 45px。

修复：

| 文件 | 改动 |
|---|---|
| `src/client/styles.ts` | `.sa-row-text` 增加 `flex:1 1 auto`（保留 `min-width:0`）；`.sa-row-hint` 增加 `overflow-wrap:anywhere;word-break:break-word` |
| `scripts/verify-client-bundle.mjs` | 新增布局回归守卫：构建产物缺这两条规则时校验失败；旧产物跑新守卫 FAIL=3 |

验证证据：

1. `node scripts/build.mjs` 退出 0；重建前后 `lib/client.js`、`lib/index.js`、`lib/index.js.map` 哈希全部一致，产物可重复。`lib/index.js` 与此前构建完全一致（宿主源未改）。
2. `node scripts/verify-client-bundle.mjs` PASS；修复前的旧产物跑新守卫 FAIL，命中三条缺失规则。
3. 文本宽度独立复测：中文提示 434.62px、纯路径 374.62px、英文提示 433.26px；199px 列换行后 3 行、389px 列 2 行，可容纳。安装包前端 CSS 本身已使用 `overflow-wrap:anywhere` 11 次、`word-break:break-word` 3 次，兼容性有佐证。
4. 运行实例发布确认：读 `/plugins/events` 图条目，`dsh-selection-assistant` 的 rev 随重建更新；按该 rev 拉取插件客户端资源，内容等于本地 `lib/client.js` 加 DSH 追加的 `sourceMappingURL` 注释，且含两条修复规则。页面刷新或重新打开设置页即加载新 bundle，不需要重启 DSH。
5. 助手进程随客户端发布重启一次：PID 15076 → 17932，于 2026-11-06 12:53:57 启动，状态 running，启动后无新增 `[ERROR]`。
6. 未改范围：`AdvancedSection.tsx`、`ui.tsx` 与修复前完全一致；helper 代码仅 `Get-Version` 一行；宿主产物未变。

证据与复验报告：`diagnosis/ui-advanced-pwsh-overlap-2026-11-06/`（README.md、before/ 旧文件与旧 bundle、measure-pwsh-hint.ps1/.txt、old-bundle-guard-FAIL.txt、new-bundle-guard-PASS.txt、deployed-client-probe.json、probe-deployed-client.mjs、compare-served.mjs、verify-report.md、fix-verification.md）。

## 8. 变更记录：应用图标

状态：已更换，结构与尺寸检查通过；真机显示需 DSH 重新加载插件元数据后确认。

需求：用户要求图标简化为黑色矩形选框加鼠标指针。

设计：

- 白色圆角方形底（96×96 viewBox，圆角 20），保证深色主题下黑色线稿仍然可见。
- 黑色虚线选区框：圆角 3、线宽 4.5、虚线 8/6、圆头端点。
- 黑色鼠标指针叠在选区框右下角，白色 3px 描边与虚线框分离；指针尾巴伸出框外，表达拖选动作。
- 30px（插件列表行）与 36px（卡片）显示尺寸下轮廓可辨认。

验证：

- `icon.svg` XML 合法，461 字节；`package.json` 的 `exports["./icon"]` 指向该文件，远低于插件图标的 256 KiB 上限。
- GDI+ 近似渲染预览（浅色/深色背景、240px 大图、30px 与 36px 小图）显示虚线框与指针都能分辨。
- 图标由 DSH 在加载插件元数据时读取并内嵌为 data URI；重启 DSH 或重新加载插件后，插件管理器显示新图标。

局限：预览是 GDI+ 近似，并非浏览器对 SVG 的精确渲染；最终像素由 DSH 前端 `<img>` 渲染决定。

证据：`diagnosis/icon-redesign-2026-11-06/`（icon-candidate.svg、preview.png、render-preview.ps1）。

## 9. macOS 0.2.0 验证（2026-11-06）

验证环境：macOS 27.2（arm64）、Swift 6.4.2（Xcode Command Line Tools，SDK MacOSX27.2）、Node 26.13.0、DSH 桌面版 0.2.1-rc.3。

### 9.1 结果矩阵

| 面 | 命令 / 方法 | 覆盖 | 结果 |
|---|---|---|---|
| Swift 构建 | `sh scripts/build-macos-helper.sh` | 13 个 Swift 源文件、target `arm64-apple-macosx13.1`、app bundle Info.plist、ad-hoc codesign | PASS：内层二进制 624016 字节，bundle id `com.evanliu3594.dsh-selection-assistant.helper`，LSMinimumSystemVersion 13.1 |
| 通用构建 | `sh scripts/build-macos-helper.sh --universal` | arm64 + x86_64 编译、lipo 合并、签名 | PASS：内层 1231712 字节，`lipo -archs` 输出 `x86_64 arm64`；x86_64 链接仅出现 CompatibilityPacks 缺 x86_64 的警告 |
| 助手自测 | `--selftest --config ... --screenshot-dir ...` | 工具栏、动作按钮、结果窗、pin 两次、窗口缩放重排、离屏截图、selftest JSON | PASS：`ok/clicked/pinToggled/resizeOk/done` 全 true；toolbar 404×128、result 1048×848（测试 config 2 个动作；5 个动作时 644×128） |
| 助手端到端 | `node scripts/verify-macos-helper.mjs` | 构建、自测、mock 宿主 status/log、command.json 预览、SSE 消费、LaunchServices 启动、健康退出 | PASS：status `error + accessibility=false`（本机未授权，符合预期）；preview 触发 `/v1/action`；mock 返回 meta/delta/done；关掉 mock 宿主后连续 3 次健康检查失败并退出 |
| 宿主管线 | `node scripts/verify-host-macos.mjs` | 真实 `HelperManager` 自动构建、写 UserDefaults、LaunchServices 启动、status 权限帧、预览动作、SIGTERM 回收 | PASS：status `error + pid`；`permissions.accessibility=denied`；fake LLM 收到 `translate`；SIGTERM 后进程退出 0；helper.log 无 ERROR |
| 通用宿主 | `node scripts/probe.mjs`、`node scripts/verify-host.mjs` | 裸导入、冷上下文、设置迁移、平台分派、8 条路由、回环 SSE、鉴权、错误帧 | PASS |
| 浏览器产物 | `node scripts/verify-client-bundle.mjs` | 注册 id、平台模块表、settings.section、locale、布局守卫 | PASS |
| 视觉抽查 | selftest 截图 + `read_image` | 浅色工具栏（普通/紧凑+溢出）、结果窗、Markdown、底栏、pin、缩放柄 | PASS；截图与 Windows 版色板、圆角、尺寸、字体层级一致 |
| 深色主题 | 环境变量 `AppleInterfaceStyle=Dark` 下 selftest | 深色工具栏/结果窗 | 未生效，SKIP（AppKit 未跟随该环境变量），深色仍需人工验收 |
| 真实辅助功能授权 | 需人工在系统设置勾选 | 全局拖选、长按 Control、⌘C 取词、点击外部关闭 | 未验证（agent 无法代授权） |
| 真实 DeepSeek | 需已安装 DSH 插件与默认模型 | 真实流式翻译 | 未验证（本轮用 fake LLM 验证宿主到 helper 的 SSE 链路） |

### 9.2 权限归属实测

| 启动方式 | responsible pid | `AXIsProcessTrusted()` | 结论 |
|---|---|---|---|
| DSH 宿主直接 spawn 内层二进制 | DSH（`/Applications/DeepSeek Harness.app`） | true | 权限来自 DSH，用户必须授权整个 DSH，不可接受 |
| `open -n -a SelectionAssistant.app` | 助手 app 自己 | false（本机未单独授权） | 授权归属于 `SelectionAssistant`，符合方案 |

因此宿主固定使用 LaunchServices 启动 app；UserDefaults 传配置路径。macOS 27 的 `open --args` 实测不传参数，已改用 `defaults write ... HelperConfigPath`。

### 9.3 本轮定位的构建问题

- 直接执行 `/Library/Developer/CommandLineTools/usr/bin/swiftc` 且未设置 `SDKROOT` 时，target 13.1 报 `unable to load standard library for target 'arm64-apple-macosx13.1'`；同一命令用 `xcrun swiftc` 成功。
- 修复：构建脚本导出 `SDKROOT=$(xcrun --show-sdk-path)`，保留绝对路径调用。
- 另一问题是并发构建共享 module cache。构建脚本已改为每次构建创建独立 `.build/build.XXXXXX`，在其中放 module cache 与 TMPDIR，退出时清理。
- 部署目标 13.0 在当前 Swift 6.4.2 + SDK 27.2 下稳定报标准库缺失；实测 13.1 可用，最低版本改为 macOS 13.1。

### 9.4 未验证 / 人工验收

1. 在 系统设置 → 隐私与安全性 → 辅助功能 勾选 `SelectionAssistant`，确认状态卡由「错误」变为「运行中」。
2. 在浏览器/记事本中拖选文字，长按 Control，确认工具栏出现；依次点翻译/解释/总结/搜索/复制。
3. 验证真实 ⌘C 取词、剪贴板还原、应用过滤（应用名/Bundle ID/可执行文件名）。
4. 结果窗 pin、失焦关闭、点击外部关闭、右下角缩放与记住尺寸。
5. 深色主题、溢出菜单、多屏/混合 DPI、Intel Mac 实机。
6. 设置页在真实 DSH 设置中的视觉与权限按钮实际打开系统设置。
7. 安装到 desktop profile 后经真实 `ctx.llm` 调 DeepSeek 的端到端翻译。

### 9.5 证据

- 构建与验证命令输出：本轮会话输出；`helper/macos/bin/SelectionAssistant.app`（gitignored）。
- 截图：`.verify-macos-helper-*/`（自测与 mock 预览），`.tools/dark-run/`（深色未生效对照）。
- 宿主集成日志：`.verify-host-macos-*/`（plugin.log、helper.log、helper-state.json、command.json）。

## 10. 0.2.1 结果窗几何固化与多窗口验证（2026-11-06）

### 10.1 macOS

| 面 | 命令 / 方法 | 结果 |
|---|---|---|
| 构建 | `node scripts/verify-macos-helper.mjs --keep` 内的 swiftc 构建 | PASS：646944 字节，arm64，macOS 13.1 |
| 自测 | `--selftest` | PASS：`ok/clicked/pinToggled/resizeOk/stackOk/done` 全 true，`sessionCount=2` |
| 第二窗口几何 | selftest 断言 | 首窗 pin 后开第二窗，旧窗仍可见、内容尺寸相同、原点相对首窗 `(-24,-24)` |
| 助手端到端 | `node scripts/verify-macos-helper.mjs` | PASS：LaunchServices、status/log、preview SSE、截图、健康退出 |
| 宿主管线 | `node scripts/verify-host-macos.mjs` | PASS：真实 HelperManager 构建启动、预览动作、SIGTERM 回收 |
| 通用门 | `build`、`probe`、`verify-host`、`verify-client-bundle` | PASS |
| 截图 | 自测工具栏与结果窗 | 工具栏 404×128，结果窗 1048×848；窗口布局正常 |

验证数据目录改到系统临时目录（`mkdtempSync(tmpdir())`）。LaunchServices 启动的 app 读取仓库（Desktop）内配置会触发 macOS“桌面文件夹”TCC；生产数据目录是 `~/.dsh/selection-assistant`，不受影响。

### 10.2 Windows（2026-11-06 实机补测）

环境：Windows 11、PowerShell 7.6.9、DSH 桌面版 0.2.2-rc.1（desktop profile）。

| 面 | 方法 | 结果 |
|---|---|---|
| 助手自测 | `pwsh -File helper/selftest.ps1` | PASS=22 SKIP=1 FAIL=0；含多窗口断言（旧窗保留、同尺寸、原点偏移 `-24,+24`）；截图 403×64 / 524×424 |
| 几何专项 | 本机测试脚本（加载 `Ui.ps1` + `SelectionHook.cs`） | PASS：保存几何驱动新窗、`rememberSize=false` 回落尺寸、`OnSaveResultPosition` 取真实窗口原点、未 pin 原位、pin 偏移 `(-24,+24)` |
| 宿主通用门 | `probe`、`verify-host`、`verify-client-bundle`、`verify-helper-resolve` | PASS |
| 实机安装 | `plugin_manager remove_bundle` + `install_bundle`（同一 link 目录） | `application: applied`；运行实例 `bundleVersion=0.2.1`，助手 PID 4788，`helperKind=powershell` |
| 预览 smoke | `POST /selection-assistant/helper/preview` | PASS：`预览命令已执行`、SSE done；无 ERROR |
| 实时几何 | 第一次预览后拖动/缩放窗口 → `helper-state.json`；无当前窗时再次预览 | PASS：保存 `resultX=1380`、`resultY=203`、`resultWidth=334`、`resultHeight=426`；下一个结果窗 rect 为 `1380,203,358×450`（等于保存值 + 24 frame） |

实机过程中发现并修复一个 Windows 阻断缺陷：`Show-ResultWindow` 的 `$win.Activate()` 返回值未抑制，混入函数返回值，`Start-ResultStream` 收到数组而不是结果窗上下文，`$ctx.App` 抛错导致结果流无法启动。修复为 `[void]$win.Activate()`；提交 `07c8ac9`。

Windows 仍待实机验收：pin 叠窗的真实鼠标交互、多屏混合 DPI、重启后的几何恢复、真实划词端到端。预期 selftest PASS 数比 0.2.0 增加 1 项（多窗口断言）。

### 10.3 未验证 / 人工验收

1. Windows 多屏混合 DPI、pin 叠窗真实鼠标交互、重启后的几何恢复。
2. macOS 辅助功能授权后的真实拖选、⌘C、点击外部/失焦、多 pin 窗交互。
3. macOS 手动拖动/缩放后的位置保存与重启后恢复；Windows 已验证保存值与下一窗口沿用，重启后恢复未单独验证。
4. 深色主题、溢出菜单、多屏/混合 DPI、Intel 实机。
5. 真实 DeepSeek 端到端。

## 11. 0.2.2 Windows PowerShell 5.1 兜底验证（2026-11-06）

验证环境：Windows 11、PowerShell 7.6.9、Windows PowerShell 5.1.19041.6456、DSH 桌面版 0.2.2-rc.1。

### 11.1 调研与改动

调研先确认三个阻断：宿主 `isLegacyPowerShell()` 拒绝 `powershell.exe`；C# 的 `Environment.TickCount64`/`SocketsHttpHandler` 在 .NET Framework 4.8 不存在；三个 `.ps1` 为 UTF-8 无 BOM，5.1 按 ANSI 读取会改写中文字面量。另发现 PS 层 22 处 `[Environment]::TickCount64` 在 5.1 下静默返回 `$null`，会让长按、拖选延迟与 Toast 计时失效。

实现：C# 增加 `Clock.NowMs`（`Stopwatch`）、HTTP 客户端改 `HttpClientHandler`；PS 层增加 `Get-NowMs`；`Add-Type` 增加 5.1 分支（`System.Net.Http` 引用与 `ServicePointManager` 两项设置）；三个脚本转 UTF-8 with BOM；`selftest.ps1` 增加 `-PowerShellExe`；宿主候选增加 5.1 兜底并在状态 DTO 发布 `runtime`；设置页状态卡显示运行环境。

### 11.2 三组自测

| 组 | 自测宿主 | 助手引擎 | 结果 |
|---|---|---|---|
| 1 | pwsh 7.6.9 | pwsh 7.6.9 | PASS=22 SKIP=1 FAIL=0，退出码 0 |
| 2 | pwsh 7.6.9 | PS 5.1.19041.6456（`-PowerShellExe`） | PASS=22 SKIP=1 FAIL=0，退出码 0 |
| 3 | PS 5.1.19041.6456 | PS 5.1.19041.6456 | PASS=22 SKIP=1 FAIL=0，退出码 0 |

- 两运行时 `helper.log` 均无 ERROR；编译行分别为「PowerShell 7.6.9」与「PowerShell 5.1.19041.6456」。
- 与 0.2.1 基线对比：22 条 PASS 断言逐条一致，含点击、pin、多窗口（旧窗保留、同尺寸、偏移 `-24,+24`）与几何断言。
- 截图尺寸一致：工具栏 403×64、结果窗 524×424；5.1 工具栏 PNG 字节数多 91，来自字体栅格差异。

### 11.3 静态与门禁

| 项 | 结果 |
|---|---|
| 脚本编码 | 三个 `.ps1` 首字节 EF BB BF；PS7 与 5.1 解析均 0 错误 |
| C# 5 约束 | 字符串插值、`nameof`、表达式体、`out var`、`?.` 等 0 命中；两运行时 `Add-Type` 均 PASS |
| 时钟 | `[Environment]::TickCount64` 可执行调用 0 处；`Clock.NowMs` 单调 |
| 候选顺序 | 默认 pwsh 在前、`powershell.exe` 兜底；显式 5.1 为第一候选；双运行时探测 7/7/5/5 |
| 构建 | `node scripts/build.mjs` PASS；三产物 SHA256 重建前后一致 |
| 门禁 | `probe`、`verify-host`、`verify-client-bundle`、`verify-helper-resolve` 全 PASS |

### 11.4 实机安装与切换

- `plugin_manager remove_bundle` + `install_bundle` 均 `application: applied`，运行实例 `version=0.2.2`，默认助手 `runtime=PowerShell 7`（pid 7584）。
- 设置页路由把 `advanced.helperPath` 指向 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` 后，助手自动重启：`runtime=Windows PowerShell 5.1`、pid 10224、进程名 `powershell`，`全局钩子安装成功`。
- 5.1 助手执行预览命令：`动作 translate 已发起请求`、`预览命令已执行`，无 ERROR。
- 恢复 `helperPath` 为空后，助手回到 `runtime=PowerShell 7`、pid 26932、进程名 `pwsh`。

### 11.5 未验证 / 人工验收

1. 真实交互桌面下 5.1 助手的全局钩子与 SendInput（本次低完整性沙箱 SKIP，需 `-RequireRealHook` 普通会话）。
2. 5.1 多屏混合 DPI、深色主题、pin 叠窗真实鼠标交互。
3. 无 PowerShell 7 的干净机器上的完整安装链路（本次用显式路径模拟，解析逻辑已覆盖隐藏 pwsh 的候选测试）。

## 12. 0.2.3 翻译语言设置与本地预判验证（2026-11-06）

验证环境：Windows 11、PowerShell 7.6.9、DSH 桌面版 0.2.2-rc.1。

### 12.1 实现

- 设置页新增「翻译语言」区：目标语言（默认取本机显示语言）与备选语言（默认 English），共 20 种语言；`language.target` / `language.fallback` 改存语言代码，旧显示名加载时迁移。
- `src/lang.ts`：Unicode 字符脚本 + 拉丁功能词本地判断；目标分流与 `LanguageOverlapError`。
- `src/llm.ts`：翻译动作在提示词构建阶段先分流；重叠时在模型调用前抛出错误，SSE 返回 `error` 事件；unknown 时提示词带重叠规则。
- `src/server.ts`：SSE `error` 事件透出 `code=language-overlap` 与消息。

### 12.2 自动验证

| 项 | 结果 |
|---|---|
| `node --experimental-strip-types scripts/verify-lang.mjs` | PASS，122 项 |
| `build` / `probe` / `verify-host` / `verify-client-bundle` / `verify-helper-resolve` | 全 PASS |
| `helper/selftest.ps1` | PASS=22 SKIP=1 FAIL=0 |
| 独立验证（release-verifier） | 248 项检查全过；重叠路径 `prepareCall=0`、模型流 0 次；SSE 先 meta 后 error |
| 构建可重复 | 重建前后三产物 SHA256 不变 |

### 12.3 实机切换与错误帧

- `plugin_manager` 安装 0.2.3（`application: applied`）；运行实例 `version=0.2.3`，旧设置自动迁移为 `target=zh`、`fallback=en`。
- 设置页路由切换为 `target=en`、`fallback=en` 后，直接调用 `/v1/action`（英文文本）返回：
  ```
  event: meta
  event: error
  data: {"code":"language-overlap","message":"目标语言与源语言重叠"}
  ```
- 恢复 `target=zh`、`fallback=en` 后状态正常。

### 12.4 未验证 / 人工验收

1. 真实模型对 unknown 文本的兜底行为（本地判断不了时）。
2. 设置页真实渲染、两个下拉交互、最长标签在窄窗口的排版。
3. helper 结果窗显示该错误帧的实际视觉效果。
4. macOS 侧界面与行为（共用同一套 TS 逻辑）。
