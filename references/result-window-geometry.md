# 结果窗几何固化与多窗口堆叠（0.2.1）

本文件是实现口径，宿主、Windows 助手与 macOS 助手按此执行。接口字段仍以 `references/contracts.md` 为准。

## 1. 适用范围

- 所有模型结果窗：翻译、解释、总结、润色（`kind=llm` 的动作）。
- 搜索与复制不产生结果窗，不参与本功能。
- 几何记录为全局共享的一套，不做按动作区分。

## 2. 几何定义

- 位置：窗口 frame 的原点（屏幕坐标）。两个平台的窗口都含 12px/pt 透明阴影边距；记录窗口原点即可保持可见卡片位置一致。
- 尺寸：窗口 frame 的宽高减去 24（内容区尺寸），与现有 `resultWidth`/`resultHeight` 口径一致。
- 持久化文件：`helper-state.json`。
  - 已有：`resultWidth`、`resultHeight`（内容尺寸）。
  - 新增：`resultX`、`resultY`（窗口原点，Windows 为物理屏幕坐标；macOS 为 AppKit 全局坐标）。
- 只在用户手动拖动标题栏结束、手动拖动右下角缩放结束时写入。程序化定位（跟随工具栏/居中/堆叠偏移）不写入。
- `rememberSize` 仍控制尺寸记忆。关闭时只固定位置，尺寸回落到设置值。
- 位置不受 `rememberSize` 影响。

## 3. 新结果窗的定位算法

触发一次模型动作时，按以下顺序：

1. 取“当前窗口”：最近创建或最近激活且可见的结果窗；没有当前窗口时，取最近一个可见的 pin 住窗口。
2. 在关闭任何窗口前，记录它的窗口 frame 与 pin 状态。
3. 关闭所有**未 pin** 的结果窗；pin 住的窗口全部保留。
4. 计算新窗口：
   - 当前窗口存在且 pin 住：
     - 尺寸 = 当前窗口内容尺寸。
     - 位置 = 当前窗口原点向左 24、向下 24。
     - 钳制到该点所在屏幕工作区，保留 8px 边距。
   - 当前窗口存在且未 pin：
     - 尺寸 = 当前窗口内容尺寸。
     - 位置 = 当前窗口原点。
   - 当前窗口不存在：
     - 若 `helper-state.json` 有 `resultX/resultY`：位置用保存值；尺寸用保存的 `resultWidth/Height`（`rememberSize` 为真）或设置值。
     - 否则保持现有默认：`followToolbar` 为真时跟随工具栏，否则屏幕居中。
5. 新窗口创建后成为当前窗口。pin 住的旧窗口继续显示、继续各自的流式输出。

### 多个 pin 窗口

- 第 2、3、4 个 pin 窗口按同一规则，从当前窗口继续向左下偏移 24。
- 每个窗口独立关闭、复制、重新生成、取消 pin。
- 当前窗口未 pin 时，新窗口在原位出现；已 pin 的旧窗口不移动。

## 4. 交互规则

- Esc 关闭当前/聚焦的结果窗；其他 pin 窗口保留。
- 点击窗口外：未 pin 的结果窗关闭；pin 窗口保留。
- 失焦自动关闭：只作用于未 pin 的结果窗。
- 重新生成：作用于按钮所在窗口；保持该窗口的位置和尺寸，不产生新的偏移；pin 状态保持。
- 关闭按钮/标题栏关闭：只关闭所在窗口。
- 拖拽标题栏/缩放：更新所有窗口共享的几何记录。

## 5. Windows 实现约束

- `helper/lib/Ui.ps1`
  - 用 `$script:UI.Results` 保存全部结果窗上下文；`$script:UI.Result` 指向当前窗口。
  - 每个结果上下文自带 `Stream`、`Pinned`、`SourceText`、`App`、`Drag` 等字段。
  - 事件处理器必须用 `$sender` 解析所属窗口（`Window.GetWindow`），禁止只依赖全局当前窗口。
  - `Poll-Stream` 遍历所有上下文；处理某窗口事件时临时把 `$script:UI.Result` 指向它，事件处理完恢复。
  - 新增 `Get-ResultPlacement`、`Show-ResultWindow -Placement`、`OnSaveResultPosition`。
- `helper/SelectionAssistant.ps1`
  - `Start-ResultStream` 先算 placement，再关闭未 pin 窗口，再创建。
  - `Close-ResultNow` 取消对应窗口的 `Stream`。
  - 全局鼠标按下、Esc、Stop-Helper、Selftest 清理都改为遍历全部结果窗。
  - `helper-state.json` 读写 `resultX/resultY`。
- 自测：保留原有 `-SelfTest` 断言；新增至少一条多窗口断言：pin 住第一个结果窗后触发第二次动作，断言旧窗仍可见、新窗尺寸相同且原点左移 24、下移 24。

## 6. macOS 实现约束

- `helper/macos/Sources/AppController.swift`
  - 新增 `ResultSession`：`window`、`sse`、`localStream`、`action`、`text`。
  - `sessions: [ResultSession]`；`activeSession`；`result` 可作为 active 的计算属性保留给 selftest。
  - 每个会话独立 SSE/本地预览；pump 遍历所有会话渲染。
  - 关闭、pin、缩放、重新生成、Esc、点击外部均按所在窗口解析会话。
  - 新增几何读取/写入与 placement 计算；AppKit 的“向下”是 y 减小，偏移为 `x-24, y-24`。
- `helper/macos/Sources/ResultWindow.swift`
  - 新增 `onMoved` 回调（标题栏拖动结束触发）。
  - `show` 支持 `preferredOrigin`；新窗口用该原点，钳制到工作区。
  - 多窗口下每个窗口独立 key monitor、pin、resize 与关闭。
- `helper/macos/Sources/State.swift`
  - 新增 `resultOrigin` 读取与 `setResultOrigin`。
- 自测：保留现有断言；新增 `stackOk`：pin 第一个窗口后触发第二个结果窗，断言旧窗可见、新窗内容尺寸相同、原点相对旧窗 `(-24,-24)`。

## 7. 验收

- Windows：`helper/selftest.ps1` 通过（含新增多窗口断言）；`verify-helper-resolve.mjs` 通过。
- macOS：`sh scripts/build-macos-helper.sh` 通过；`--selftest` 的 `ok/clicked/pinToggled/resizeOk/stackOk/done` 全 true；`verify-macos-helper.mjs` 与 `verify-host-macos.mjs` 通过。
- 版本：`package.json` 与 CHANGELOG 进入 0.2.1。

## 8. 0.2.1 实现与验证状态

- macOS：`SelectionAssistant.app` 构建 PASS（646944 字节，arm64 13.1）；`--selftest` 的 `ok/clicked/pinToggled/resizeOk/stackOk/done` 全 true，`sessionCount=2`；`verify-macos-helper`、`verify-host-macos` PASS。
- Windows：`Ui.ps1`、`SelectionAssistant.ps1`、`selftest.ps1` 语法解析 PASS；纯函数几何测试覆盖默认、pin 偏移 `(-24,+24)`、未 pin 原位、保存几何、结果列表移除，全部 PASS。WPF 运行时自测待 Windows 实机。
- 自动验证的 macOS 配置/数据目录放在系统临时目录，避免 LaunchServices app 读取 Desktop 配置触发“桌面文件夹”TCC。
