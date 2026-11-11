# 本地宿主安装、卸载与重装配方

本配方适用于把本仓库作为 **本地 bundle** 安装进 DSH desktop profile，面向开发和验收环境。2026-11-10 在 macOS 27.2、arm64、DSH 0.2.2-rc.1 实机走通。

## 一、结论

优先使用 DSH 插件管理器。它支持热卸载和热安装，返回 `application: applied` 即生效，通常不需要完整重启 DSH。

本地开发安装使用 `link:` 依赖，profile 的 `node_modules/dsh-selection-assistant` 指向仓库。修改 `src/` 后必须重建 `lib/`，再让宿主重新加载插件。

卸载和重装不会删除用户设置，也不会改变 macOS 助手 app 的签名。用户设置目录 `~/.dsh/selection-assistant/` 会保留，辅助功能授权会保留。

## 二、本机路径

| 项 | 路径 |
|---|---|
| 仓库 | `/Users/liu/Desktop/gitdir/dsh-selection-assistant` |
| DSH profile | `~/.dsh/profiles/desktop` |
| profile 依赖 | `dsh-selection-assistant: link:<仓库绝对路径>` |
| bundle 选择 | `package.json` 的 `dsh.profile.bundles` 数组 |
| 用户设置 | `~/.dsh/selection-assistant/settings.json` |
| macOS 助手 app | `helper/macos/bin/SelectionAssistant.app` |
| DSH 自带 pnpm | `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs` |

`pnpm` 可能不在普通 shell 的 PATH 中。使用上面的 `pnpm.cjs`，或先执行 `node .../pnpm.cjs --version` 确认版本。

## 三、卸载

### 方式 A：DSH 插件管理器

1. 打开 DSH 设置 → 插件（Plugins）→ 已安装。
2. 找到 `dsh-selection-assistant`，可能显示为「划词助手」。
3. 点卸载并确认。
4. 等待操作完成，确认结果为 `application: applied`。

如果 Agent 环境提供 `plugin_manager` 工具，可直接调用：

```text
plugin_manager action=remove_bundle target=dsh-selection-assistant
```

卸载会做四件事：

1. 从 `dsh.profile.bundles` 移除 bundle 选择。
2. 从 profile 依赖移除 `dsh-selection-assistant`。
3. 运行 profile pnpm，删除 `node_modules/dsh-selection-assistant` 链接。
4. 热卸载宿主插件，停止助手进程，关闭设置页入口。

卸载后应满足：

```bash
# profile 依赖和 bundle 都应为空/false
node -e "const j=require(process.env.HOME+'/.dsh/profiles/desktop/package.json'); console.log(j.dependencies['dsh-selection-assistant'], j.dsh.profile.bundles.includes('dsh-selection-assistant'))"

# 插件路由应返回 404
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<当前端口>/selection-assistant/state

# 助手进程应不存在
pgrep -fl SelectionAssistant

# 用户设置应保留
ls -l ~/.dsh/selection-assistant/settings.json
```

### 方式 B：手动 profile 回退

当前 DSH 正在运行，先完整退出 DSH。不要在 DSH 运行时手改 profile，也不要在 Agent shell 的 workspace-write 沙箱里直接写 `~/.dsh`。

```bash
PROFILE="$HOME/.dsh/profiles/desktop"
REPO="/Users/liu/Desktop/gitdir/dsh-selection-assistant"
PNPM="node $HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
STAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "/tmp/dsh-selection-backup-$STAMP"
cp "$PROFILE/package.json" "$PROFILE/pnpm-lock.yaml" "$PROFILE/pnpm-workspace.yaml" "/tmp/dsh-selection-backup-$STAMP/"

# 先移除 bundle 选择，再移除依赖
node - <<'NODE'
const fs = require('fs')
const path = process.env.HOME + '/.dsh/profiles/desktop/package.json'
const doc = JSON.parse(fs.readFileSync(path, 'utf8'))
doc.dsh.profile.bundles = doc.dsh.profile.bundles.filter(name => name !== 'dsh-selection-assistant')
fs.writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
fs.chmodSync(path, 0o600)
NODE

"$PNPM" --dir "$PROFILE" remove dsh-selection-assistant
```

手动卸载完成后重新启动 DSH，再按上面的检查项确认。

## 四、安装

本地开发安装要传 **仓库目录的绝对路径**，不要传 `lib/index.js`，也不要传 GitHub URL 代替本地目录。

### 方式 A：DSH 插件管理器

1. 打开 DSH 设置 → 插件（Plugins）。
2. 在安装入口选择本地插件目录；如果当前 DSH 版本只接受 npm 包名，改用下面的 Agent 工具或手动回退。
3. 勾选启用，确认安装。
4. 等待 `application: applied`，确认版本为 `0.2.3`。

如果 Agent 环境提供 `plugin_manager` 工具：

```text
plugin_manager action=install_bundle target=/Users/liu/Desktop/gitdir/dsh-selection-assistant
```

安装成功后应满足：

- profile 依赖为 `link:/Users/liu/Desktop/gitdir/dsh-selection-assistant`。
- `node_modules/dsh-selection-assistant` 是指向仓库的符号链接。
- `dsh.profile.bundles` 包含 `dsh-selection-assistant`。
- 插件管理器返回的 `version` 为 `0.2.3`。
- `/selection-assistant/state` 返回 200。
- 助手状态为 `running`，macOS 权限为 `granted`。
- 原 `settings.json` 内容仍在；语言设置应在内存中迁移为 `zh/en`。

### 方式 B：手动 profile 回退

先完整退出 DSH。

```bash
PROFILE="$HOME/.dsh/profiles/desktop"
REPO="/Users/liu/Desktop/gitdir/dsh-selection-assistant"
PNPM="node $HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs"

"$PNPM" --dir "$PROFILE" add "dsh-selection-assistant@link:$REPO"

node - <<'NODE'
const fs = require('fs')
const path = process.env.HOME + '/.dsh/profiles/desktop/package.json'
const doc = JSON.parse(fs.readFileSync(path, 'utf8'))
const bundles = doc.dsh.profile.bundles
if (!bundles.includes('dsh-selection-assistant')) {
  const before = bundles.indexOf('@deepseek-ai/dsh-subagent-codex')
  if (before >= 0) bundles.splice(before, 0, 'dsh-selection-assistant')
  else bundles.push('dsh-selection-assistant')
}
fs.writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
fs.chmodSync(path, 0o600)
NODE

"$PNPM" --dir "$PROFILE" install
```

启动 DSH，等插件加载完成，再检查状态。

## 五、验证

```bash
# 当前 DSH 端口会变化，用设置页 URL 或 /plugins/events 所在端口
PORT=61922
curl -s http://127.0.0.1:$PORT/selection-assistant/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s).state; console.log(JSON.stringify({version:j.version,helper:j.helper,platform:j.platform,language:j.language},null,2))})"

pgrep -fl SelectionAssistant
tail -20 ~/.dsh/selection-assistant/helper.log
```

正常状态应包含：

- `version: "0.2.3"`
- `helper.status: "running"`
- `platform.permissions.accessibility: "granted"`（macOS）
- `language.target` 和 `language.fallback` 为语言代码

macOS 首次安装还需要在 系统设置 → 隐私与安全性 → 辅助功能 勾选 `SelectionAssistant`，可能显示为「划词助手」。授权归属是 app bundle 本身，给 DeepSeek Harness 授权不会让助手获得权限。

## 六、踩坑记录

1. **Agent shell 不能直接写 `~/.dsh`**。本会话的 workspace-write 沙箱会拒绝写 profile；请求更高权限时可能等待授权并超时。优先使用宿主插件管理器或人工终端。
2. **DSH 自带 pnpm 不在 PATH**。普通 `pnpm` 可能直接报 `command not found`，使用 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs`。
3. **依赖和 bundle 是两个开关**。只删依赖会留下失效的 bundle 选择；只删 bundle 会留下已安装包。两边必须一起处理。
4. **本地开发必须用 `link:`**。插件管理器实测输出 `+ dsh-selection-assistant link:/.../dsh-selection-assistant`；复制安装会失去本地改动能力。
5. **改 `src/` 后要重建 `lib/`**。宿主加载 `lib/index.js`；只改源码不重建，运行的仍是旧产物。
6. **改 `src/` 后还要重载宿主插件**。插件管理器安装/卸载会热应用；手动替换 `lib/` 通常需要完整重启 DSH。
7. **配置目录不要删**。`~/.dsh/selection-assistant/` 存用户设置、日志和几何状态。卸载/重装不应删除它；只有明确要恢复出厂设置时才备份后删除。
8. **重装通常不需要重启 DSH**。插件管理器返回 `application: applied` 后路由和助手会立即变化；设置页如果没有入口，再完整重启 DSH 或刷新页面。
9. **卸载时助手会被停止**。这是正常行为；重装后宿主会重新写 `helper-config.json` 并用新端口启动助手。
10. **macOS 重装不要重建 app**。重建会改变 ad-hoc 签名，辅助功能授权可能失效。仅卸载/重装插件不会重建 app，授权保持。
11. **macOS app 必须用 LaunchServices 启动**。宿主用 `open -a SelectionAssistant.app` 启动；直接 spawn 内层二进制会把授权算到 DSH 头上。
12. **辅助功能授权可能显示旧签名**。如果日志一直提示缺少权限，查看 TCC 日志是否 cdhash 不匹配；移除旧条目，重新添加当前 `SelectionAssistant.app`。
13. **验证脚本加 `--skip-build`**。已授权机器运行 `verify-macos-helper.mjs` 或 `verify-host-macos.mjs` 时，加该参数可避免重建 app、保住 TCC。
14. **0.2.3 语言设置会迁移**。旧 `settings.json` 里的「简体中文 / English」在加载时转成 `zh / en`；首次保存后写回代码。不要在重装后手改回显示名。
15. **端口和 token 每次启动都会变**。不要缓存旧的 `/selection-assistant/state` 端口；以当前 DSH URL 为准。
16. **安装前先卸载同名包**。插件管理器对已安装的同名 bundle 会返回 `already-installed`；先移除再安装。
17. **profile 文件权限是 600**。手动编辑后保持权限；DSH 和 pnpm 都以当前用户运行。
18. **Windows 同样走插件管理器**。助手优先 PowerShell 7，缺失时回退 Windows PowerShell 5.1；Windows 没有 macOS TCC，但数据目录在 `%USERPROFILE%\.dsh\selection-assistant\`。
19. **macOS app 版本元数据已对齐 0.2.3**，二进制为 `x86_64 + arm64` universal。重新构建会改变 ad-hoc 签名，辅助功能授权需要重新添加。

## 七、回滚

profile 损坏时，用卸载前备份恢复：

```bash
cp "/tmp/dsh-selection-backup-<时间戳>/package.json" "$PROFILE/package.json"
cp "/tmp/dsh-selection-backup-<时间戳>/pnpm-lock.yaml" "$PROFILE/pnpm-lock.yaml"
cp "/tmp/dsh-selection-backup-<时间戳>/pnpm-workspace.yaml" "$PROFILE/pnpm-workspace.yaml"
cd "$PROFILE" && node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs install
```

恢复后重启 DSH。用户设置和 macOS 授权不需要随 profile 一起回滚。

## 八、实测记录

2026-11-10 19:18 CST，macOS 27.2 arm64：

- 卸载：插件管理器返回 `changed=true`、`application=applied`；profile 依赖为 `null`，bundle 选择为 `false`；状态路由 HTTP 404；助手进程消失；`settings.json` 保留。
- 重装：返回 `changed=true`、`application=applied`、`link:/Users/liu/Desktop/gitdir/dsh-selection-assistant`、`version=0.2.3`；状态路由 HTTP 200；助手重新启动，`accessibility=granted`；设置仍在。
- 全程未重启 DSH，未重建 macOS app，未重新授权辅助功能。

详细运行时日志见 [verification.md](verification.md) §14。
