# AGENTS.md — dsh-selection-assistant（项目总纲）

> 本文件只保留目标、架构、已拍板口径与规则；会话进展写 `handoff/`，文件级细节写各目录说明，历史不堆进本文件。

## 0. 目录结构

| 目录 / 文件 | 职责 | 明细 |
|---|---|---|
| `src/` | 宿主半体：设置持久化、模型桥、助手进程管理、两个 HTTP 面 | 见 `src/` 内注释与 `references/contracts.md` |
| `src/client/` | 浏览器半体：DSH 设置页「划词助手」 | `references/contracts.md` §3 |
| `helper/` | Windows 助手进程（PowerShell 7 + WPF）：全局钩子、取词、工具栏、结果窗 | `helper/README.md` |
| `scripts/` | 构建与五面验证脚本（esbuild CLI、探针、宿主/浏览器/助手解析验证） | 本文件 §4 |
| `lib/` | 构建产物：`lib/index.js`（宿主）、`lib/client.js`（浏览器） | 只由 `node scripts/build.mjs` 生成 |
| `references/` | 接口契约、Cherry Studio 对照研究、验证记录 | `contracts.md` 是接口唯一出处 |
| `diagnosis/` | 归档的一次性排查脚本 | `diagnosis/deprecated/README.md` |
| `handoff/` | 会话交接记录 | 最新一份 = 当前状态入口 |
| `locale/` `icon.svg` | 插件元数据（Plugin Manager / 设置页读取） | — |
| `package.json` `cordis.patch.yml` | bundle 声明与安装层 | — |

## 1. 目标

让用户在**任意 Windows 软件**里选中文字后长按 Ctrl，弹出划词工具栏，一键调用 DSH 当前配置的 DeepSeek 模型完成翻译、解释、总结、搜索、复制等动作。形态、动作集合与设置方式参考 Cherry Studio 的 selection-assistant；模型服务默认来自 DeepSeek（通过 DSH 的 `ctx.llm`，不另存 API Key）。

## 2. 架构（已拍板）

| # | 决策 | 理由 |
|---|---|---|
| ① | 宿主半体运行在 DSH Host 的 Node 子进程，**不碰 Electron** | 实测 `dsh-desktop-host` 用 fork 启动运行时，插件拿不到 `BrowserWindow` |
| ② | 悬浮工具栏/结果窗由独立 helper 进程提供 | 只有独立进程能跨应用置顶；helper 用 PowerShell 7 + WPF 实现 |
| ③ | 取词只用剪贴板路径：保存 → Ctrl+C → 读 → 还原 | 无 UIA、无截屏，权限与隐私成本最低 |
| ④ | 模型调用走 `ctx.llm.prepareCall()/stream()`，默认跟随 `agentDefaultModel` | 复用 DSH 的 DeepSeek 账号与模型路由，零凭据 |
| ⑤ | 设置存 `<DSH_HOME>/selection-assistant/settings.json`，不走 plugin row config | 保存设置不应触发插件重启；row config 只留 dataDir/pwshPath 两个引导项 |
| ⑥ | helper ↔ 宿主用回环 HTTP + 每次启动随机 token；SSE 流式 | helper 不依赖 DSH 鉴权，宿主不依赖 helper 内部结构 |
| ⑦ | 每个动作一次独立模型调用，temperature 全局 | 与 Cherry 一致；暂不做多轮会话 |
| ⑧ | Windows only | 钩子与 WPF 都是 Windows 能力；非 Windows 时插件不崩，设置页显示原因 |
| ⑨ | 不做「引用到 DSH 会话」与「Ask Agent」 | 需要 DSH 会话写入通道，超出本次范围；README 已写明 |

## 3. 接口与文件归属

- `src/contract.ts` 是共享类型（Settings、ActionSettings、HelperConfig、StateDto、路由前缀、默认动作与默认提示词），宿主与浏览器半体都从它导入；helper 只看 `references/contracts.md` 的 JSON 形态。
- 新增/修改任何跨进程字段：先改 `references/contracts.md`，再改 `src/contract.ts`，最后改两端实现。
- 默认动作（6 个）：translate / explain / summarize / search / copy 启用，optimize 关闭；自定义动作上限 20，工具栏直显上限 8。

## 4. 构建与验证（五道门，缺一有盲区）

```powershell
node scripts/build.mjs                  # esbuild CLI；改完 src/ 必须重跑
node scripts/probe.mjs                  # 宿主产物：裸导入、冷上下文 apply、settings.json 生成
node scripts/verify-host.mjs            # 宿主：设置夹紧/落盘、全部路由、回环 SSE、鉴权、错误帧
node scripts/verify-client-bundle.mjs   # 浏览器：注册 id、模块表、settings.section、locale、行内提示换行守卫
node scripts/verify-helper-resolve.mjs  # 助手解析：pwsh 候选、拒绝 PS 5.1、helper-config 字段
pwsh -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1   # 助手：mock 宿主 + 按钮点击 + 截图 + 钩子层
```

- 本机 shell 沙箱会拦 Node 的 piped-stdio 子进程，所以构建走 esbuild CLI + `spawnSync(stdio:'inherit')`；不要改用 esbuild JS API。
- 在 DSH shell 里跑 `verify-host.mjs` 若出现挂起（loopback 与端点交互的沙箱限制），改用 `Start-Process node ... -RedirectStandardOutput` 方式执行；脚本自身以 `process.exit` 收尾。
- 浏览器半体没有浏览器内点击验证：产物注册面 + jsdom 冒烟已覆盖，视觉验收留给用户。
- 全局钩子的真实注入需交互式桌面会话：`helper/selftest.ps1 -RequireRealHook`。agent 会话为低完整性令牌，普通 selftest 该项 SKIP。
- 安装后的完整链路验证记录见 `references/verification.md`。

## 5. 规则

- 代码 ESM、无 `@deepseek-ai/*` 运行时依赖（宿主与浏览器都不 import DSH 包）；需要 DSH 服务时用 `ctx.get(...)` 的结构化类型。
- 面向用户的文案中文（或按 UI locale 双语）；日志写文件，不写凭据与剪贴板内容。
- 不修改 DSH 本体的 profile `package.json` / `cordis.patch.yml`，安装走 `plugin_manager install_bundle` 或 `dsh plugin add`。
- helper 进程只由宿主拉起与回收；stdin 关闭 = 宿主退出，helper 必须退出。
- 文档语言直白、先结论后证据；不出现「不是……而是……」句式。
- 未知字段、越界数值一律在宿主侧夹紧，不信任 settings.json 与请求体。
- 公开仓库只包含源码、构建产物、验证脚本、用户文档与许可证；`handoff/`、`diagnosis/`、`references/`、`AGENTS.md`、`helper/preview/` 由 `.gitignore` 排除，不进入 git tree。发布前在临时副本里 `git init` + `git add -A` 核对 tracked 集合与泄漏。

## 6. 当前状态

0.1.0 已交付并安装进 desktop profile（`link:` 指向本目录）。验证结果：

- 宿主产物、7 条设置路由、回环 SSE、鉴权与错误帧：PASS（`scripts/verify-host.mjs`）。
- 浏览器产物注册与 locale：PASS（`scripts/verify-client-bundle.mjs`）。
- 设置页布局守卫：PASS（构建产物含 `.sa-row-text` 的 `flex:1 1 auto` 与 `.sa-row-hint` 的换行规则）。
- 助手解析（PowerShell 7 候选可启动）与 helper-config：PASS（`scripts/verify-helper-resolve.mjs`）。
- 助手自测：PASS=21 SKIP=1 FAIL=0（SKIP 为低完整性沙箱下的真实 SendInput 注入）。
- 工具栏按钮点击链路：PASS（`-SelfTest` 用真实 WPF 路由事件点击「翻译」，断言结果窗打开）。
- 结果窗 pin 按钮：PASS（`-SelfTest` 点击 pin 两次，断言钉住/取消钉住与 Topmost）。
- 高级区提示换行：PASS（构建守卫 + 文本宽度计算 + 运行实例发布确认）。
- 应用图标：白底圆角、黑色虚线选区框 + 鼠标指针；XML 合法，30px/36px 下可辨认，深浅主题有对比。
- 真实 DeepSeek 流式翻译经已安装插件跑通（1.1s，meta/delta/done 完整）。
- 待人工验收：真实动作按钮点击、结果窗 pin 按钮真实鼠标点击与保持可见、设置页高级区提示换行的真实像素、设置页视觉、深色主题、多屏混合 DPI。

注意：仓库只发布 0.1.0，开发期的内部迭代编号已并入该版本。浏览器半体更新后重新构建 `lib/` 并刷新设置页即可（运行中的 DSH 带 client-hmr，通常不需要重启 DSH）；宿主 `src/` 更新后仍必须完整重启 DSH；helper 脚本更新后重启助手进程；图标元数据在 DSH 加载插件时读取，重启 DSH 或重新加载插件后显示新图标。

## 7. 参考

- 接口契约：`references/contracts.md`
- Cherry Studio 对照研究：`references/cherry-studio-selection-assistant.md`
- DSH 插件开发：skill `cordis-plugin-development。
