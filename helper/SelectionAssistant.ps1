# SelectionAssistant.ps1 — dsh-selection-assistant Windows helper process.
#
# Launched by the DSH host:
#   pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File SelectionAssistant.ps1 -ConfigPath <helper-config.json>
#
# Responsibilities: global hooks, Ctrl long press / drag selection trigger,
# clipboard capture, floating toolbar, streaming result window, host SSE client,
# helper-state persistence, command.json preview, self test.
#
# Startup contract: stdin stays open while the host lives; stdin EOF = exit.

[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [switch]$SelfTest,
    [switch]$SelfTestKeepWindows
)

$ErrorActionPreference = 'Stop'
$script:Here = $PSScriptRoot
if (-not $script:Here) { $script:Here = Split-Path -Parent $MyInvocation.MyCommand.Path }
$script:StartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:ShuttingDown = $false
$script:ExitCode = 0
$script:Cfg = $null
$script:State = @{}
$script:HooksInstalled = $false
$script:LogLevel = 2
$script:LastErrorLogAt = 0
$script:LastCommandId = ''
$script:SelectionText = ''
$script:SelectionApp = ''
$script:SuppressAutoClose = $false
$script:PreviewStream = $null

$script:SampleText = 'DeepSeek Harness 是一个本地 AI 智能体运行环境。选中这段文字并长按 Ctrl，就能看到划词助手。'
$script:PreviewSample = @"
**翻译**（本地预览）

划词助手：选中任意文字后长按 Ctrl，即可调用 DSH 当前配置的模型。

- 支持流式输出
- 支持 **粗体**、``行内代码``
- 支持代码块：

``````
const answer = 42
``````

当前为本地预览，不调用模型。
"@

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

# UTF-8 console output: the host collects the streams into its log.
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

# Load the WPF UI layer in the script scope so its functions stay visible.
try {
    . (Join-Path $script:Here 'lib\Ui.ps1')
} catch {
    $script:UiLoadError = $_.Exception.Message
}
$script:LogFallbackDir = Join-Path $env:USERPROFILE '.dsh\selection-assistant'

function Write-Log {
    param([string]$Level = 'info', [string]$Message = '')
    $rank = 2
    switch ($Level) { 'error' { $rank = 0 } 'warn' { $rank = 1 } 'info' { $rank = 2 } 'debug' { $rank = 3 } }
    if ($rank -gt $script:LogLevel) { return }
    $line = '{0} [{1}] {2} {3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Level.ToUpperInvariant(), $PID, $Message
    try {
        $path = $script:LogFile
        if (-not $path) { $path = Join-Path $script:LogFallbackDir 'helper.log' }
        $dir = Split-Path -Parent $path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        [System.IO.File]::AppendAllText($path, $line + "`r`n", [System.Text.UTF8Encoding]::new($false))
    } catch { }
    try {
        if ($script:Cfg -and $script:Cfg.endpoint) {
            $body = @{ level = $Level; message = $Message } | ConvertTo-Json -Compress -Depth 3
            [RestClient]::PostJsonFireAndForget(($script:Cfg.endpoint + '/v1/log'), $script:Cfg.token, $body)
        }
    } catch { }
}

function Write-LogErrorSafe {
    param([string]$Message)
    $now = [Environment]::TickCount64
    if ($now - $script:LastErrorLogAt -lt 1500) { return }
    $script:LastErrorLogAt = $now
    Write-Log 'error' $Message
}

# ---------------------------------------------------------------------------
# Config / state
# ---------------------------------------------------------------------------

function Get-Num {
    param($Value, [double]$Default, [double]$Min, [double]$Max)
    if ($null -eq $Value) { return $Default }
    try { $v = [double]$Value } catch { return $Default }
    if ($v -lt $Min) { return $Min }
    if ($v -gt $Max) { return $Max }
    return $v
}

function Get-Bool {
    param($Value, [bool]$Default)
    if ($null -eq $Value) { return $Default }
    return [bool]$Value
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return $raw | ConvertFrom-Json
    } catch { return $null }
}

function ConvertTo-HelperConfig {
    param($Raw)
    if ($null -eq $Raw) { return $null }
    $cfg = @{}
    $cfg.version = 1
    $cfg.endpoint = [string]$Raw.endpoint
    if (-not $cfg.endpoint) { $cfg.endpoint = '' }
    $cfg.endpoint = $cfg.endpoint.TrimEnd('/')
    $cfg.token = [string]$Raw.token
    $cfg.dataDir = [string]$Raw.dataDir
    if (-not $cfg.dataDir) { $cfg.dataDir = Join-Path $env:USERPROFILE '.dsh\selection-assistant' }
    $cfg.logPath = [string]$Raw.logPath
    if (-not $cfg.logPath) { $cfg.logPath = Join-Path $cfg.dataDir 'helper.log' }
    $cfg.locale = if ([string]$Raw.locale -eq 'en') { 'en' } else { 'zh' }
    $cfg.debug = Get-Bool $Raw.debug $false

    $t = $Raw.trigger
    $mode = 'ctrl'
    if ($t -and [string]$t.mode -in @('selection', 'ctrl', 'shortcut')) { $mode = [string]$t.mode }
    $cfg.trigger = @{
        mode           = $mode
        longPressMs    = [int](Get-Num $t.longPressMs 500 200 1500)
        shortcut       = if ($t -and [string]$t.shortcut) { [string]$t.shortcut } else { 'Ctrl+Alt+Q' }
        captureDelayMs = [int](Get-Num $t.captureDelayMs 120 50 500)
    }

    $tb = $Raw.toolbar
    $cfg.toolbar = @{
        compact           = Get-Bool $tb.compact $false
        maxVisibleActions = [int](Get-Num $tb.maxVisibleActions 5 1 8)
        scale             = Get-Num $tb.scale 1.0 0.85 1.25
    }

    $r = $Raw.result
    $cfg.result = @{
        followToolbar = Get-Bool $r.followToolbar $true
        rememberSize  = Get-Bool $r.rememberSize $true
        autoClose     = Get-Bool $r.autoClose $true
        alwaysOnTop   = Get-Bool $r.alwaysOnTop $true
        opacity       = Get-Num $r.opacity 0.96 0.2 1.0
        width         = Get-Num $r.width 500 300 900
        height        = Get-Num $r.height 400 200 900
    }

    $af = $Raw.appFilter
    $afMode = 'off'
    if ($af -and [string]$af.mode -in @('off', 'blacklist', 'whitelist')) { $afMode = [string]$af.mode }
    $processes = @()
    if ($af -and $af.processes) { $processes = @($af.processes | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ }) }
    $cfg.appFilter = @{ mode = $afMode; processes = $processes }

    $actions = @()
    if ($Raw.actions) {
        foreach ($a in @($Raw.actions)) {
            if ($null -eq $a) { continue }
            $kind = [string]$a.kind
            if ($kind -notin @('llm', 'search', 'copy')) { $kind = 'llm' }
            $actions += @{
                id      = [string]$a.id
                kind    = $kind
                label   = if ([string]$a.label) { [string]$a.label } else { [string]$a.id }
                icon    = if ([string]$a.icon) { [string]$a.icon } else { 'sparkle' }
                enabled = Get-Bool $a.enabled $true
                order   = Get-Num $a.order 0 -10000 10000
                searchUrl = if ($a.PSObject.Properties['searchUrl']) { [string]$a.searchUrl } else { '' }
            }
        }
    }
    $cfg.actions = $actions
    return $cfg
}

function Save-State {
    try {
        if (-not $script:Cfg) { return }
        $state = @{}
        if ($script:State) { foreach ($k in $script:State.Keys) { $state[$k] = $script:State[$k] } }
        $state.version = 1
        $state.pid = $PID
        $state.startedAt = $script:StartedAt
        if (-not $state.ContainsKey('lastActionId')) { $state.lastActionId = '' }
        $dir = $script:Cfg.dataDir
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $path = Join-Path $dir 'helper-state.json'
        $json = $state | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
        $script:State = $state
    } catch { }
}

function Read-State {
    param([string]$DataDir)
    $path = Join-Path $DataDir 'helper-state.json'
    $raw = Read-JsonFile $path
    $state = @{}
    if ($raw) {
        if ($raw.resultWidth) { $state.resultWidth = [double]$raw.resultWidth }
        if ($raw.resultHeight) { $state.resultHeight = [double]$raw.resultHeight }
        if ($null -ne $raw.resultX) { $state.resultX = [int]$raw.resultX }
        if ($null -ne $raw.resultY) { $state.resultY = [int]$raw.resultY }
        if ($raw.lastActionId) { $state.lastActionId = [string]$raw.lastActionId }
        if ($raw.toolbarX) { $state.toolbarX = [int]$raw.toolbarX }
        if ($raw.toolbarY) { $state.toolbarY = [int]$raw.toolbarY }
    }
    return $state
}

# ---------------------------------------------------------------------------
# Status / log to host
# ---------------------------------------------------------------------------

function Post-Status {
    param([string]$State = 'ready', [string]$Message = '')
    try {
        if (-not $script:Cfg -or -not $script:Cfg.endpoint) { return }
        $body = @{ state = $State; message = $Message } | ConvertTo-Json -Compress
        $resp = [RestClient]::PostJson(($script:Cfg.endpoint + '/v1/status'), $script:Cfg.token, $body, 2500)
        if (-not $resp) { Write-Log 'warn' "POST /v1/status $State 未返回响应（宿主可能未启动）" }
        else { Write-Log 'debug' "POST /v1/status $State -> $resp" }
    } catch { Write-Log 'warn' ('POST /v1/status 失败: ' + $_.Exception.Message) }
}

# ---------------------------------------------------------------------------
# Side-effect capture helpers
# ---------------------------------------------------------------------------

function Save-Screenshot {
    param([int[]]$Rect, [string]$Path)
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
        $w = $Rect[2] - $Rect[0]
        $h = $Rect[3] - $Rect[1]
        if ($w -le 0 -or $h -le 0) { return $false }
        $bmp = [System.Drawing.Bitmap]::new($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($Rect[0], $Rect[1], 0, 0, [System.Drawing.Size]::new($w, $h))
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose()
        $bmp.Dispose()
        return $true
    } catch {
        Write-Log 'warn' ('截图失败: ' + $_.Exception.Message)
        return $false
    }
}

# ---------------------------------------------------------------------------
# Application filter / shortcuts
# ---------------------------------------------------------------------------

function Test-AppAllowed {
    param([string]$App)
    if (-not $script:Cfg) { return $true }
    $mode = [string]$script:Cfg.appFilter.mode
    if (-not $mode -or $mode -eq 'off') { return $true }
    $name = ([string]$App).Trim().ToLowerInvariant()
    $list = @($script:Cfg.appFilter.processes)
    if ($mode -eq 'blacklist') { return -not ($list -contains $name) }
    if ($mode -eq 'whitelist') { return ($list -contains $name) }
    return $true
}

$script:ShortcutVk = @{
    'space' = 0x20; 'enter' = 0x0D; 'tab' = 0x09; 'escape' = 0x1B; 'esc' = 0x1B
    'backspace' = 0x08; 'delete' = 0x2E; 'insert' = 0x2D; 'home' = 0x24; 'end' = 0x23
    'pageup' = 0x21; 'pagedown' = 0x22; 'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
}

function ConvertFrom-Shortcut {
    param([string]$Shortcut)
    $result = @{ Ctrl = $false; Alt = $false; Shift = $false; Win = $false; Vk = 0 }
    if (-not $Shortcut) { return $result }
    $parts = @($Shortcut.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -eq 0) { return $result }
    for ($i = 0; $i -lt $parts.Count; $i++) {
        $part = $parts[$i]
        $lower = $part.ToLowerInvariant()
        if ($lower -eq 'ctrl' -or $lower -eq 'control') { $result.Ctrl = $true; continue }
        if ($lower -eq 'alt') { $result.Alt = $true; continue }
        if ($lower -eq 'shift') { $result.Shift = $true; continue }
        if ($lower -eq 'win' -or $lower -eq 'meta') { $result.Win = $true; continue }
        $key = $lower
        if ($key.Length -eq 1) {
            $ch = $key.ToUpperInvariant()
            if ($ch -match '^[A-Z]$') { $result.Vk = [int][char]$ch; continue }
            if ($ch -match '^[0-9]$') { $result.Vk = [int][char]$ch; continue }
        }
        if ($key -match '^f([1-9]|1[0-9]|2[0-4])$') { $result.Vk = 0x6F + [int]$Matches[1]; continue }
        if ($script:ShortcutVk.ContainsKey($key)) { $result.Vk = [int]$script:ShortcutVk[$key]; continue }
    }
    return $result
}

# ---------------------------------------------------------------------------
# Hook event state machine
# ---------------------------------------------------------------------------

$script:Selection = @{ Has = $false; X = 0; Y = 0; At = 0; App = '' }
$script:Ctrl = @{ Down = $false; DownAt = 0; Cancelled = $false }
$script:PendingSelectionTrigger = 0
$script:Shortcut = $null

function Reset-TriggerState {
    $script:Ctrl.Down = $false
    $script:Ctrl.DownAt = 0
    $script:Ctrl.Cancelled = $false
    $script:PendingSelectionTrigger = 0
}

function Test-SelectionCandidate {
    if (-not $script:Selection.Has) { return $false }
    return ([Environment]::TickCount64 - $script:Selection.At) -le 5000
}

function Test-PointInRect {
    param([int]$X, [int]$Y, [int[]]$Rect)
    if (-not $Rect) { return $false }
    return ($X -ge $Rect[0] -and $X -lt $Rect[2] -and $Y -ge $Rect[1] -and $Y -lt $Rect[3])
}

function Invoke-Trigger {
    param([int]$X, [int]$Y, [string]$Reason)
    try {
        Reset-TriggerState
        $script:Selection.Has = $false
        if (-not $script:Cfg) { return }
        $fgPid = 0
        try { $fgPid = [ForegroundInfo]::GetForegroundProcessId() } catch { }
        if ($fgPid -eq $PID) { Write-Log 'debug' '忽略触发：前台是助手自己的窗口'; return }
        $app = ''
        try { $app = [ForegroundInfo]::GetForegroundProcessName() } catch { }
        if (-not (Test-AppAllowed $app)) {
            Write-Log 'debug' ("忽略触发：应用过滤命中 app=" + $app)
            return
        }
        $text = Get-SelectedText
        if ([string]::IsNullOrWhiteSpace($text)) { Write-Log 'debug' '忽略触发：未取到文本'; return }
        $script:SelectionText = $text
        $script:SelectionApp = $app
        Write-Log 'info' ("触发 [" + $Reason + "] app=" + $app + " chars=" + $text.Length + " at=" + $X + "," + $Y)
        Show-ToolbarAt -CursorX $X -CursorY $Y
    } catch {
        Write-LogErrorSafe ('触发失败: ' + $_.Exception.Message)
    }
}

function Get-SelectedText {
    $script:SuppressAutoClose = $true
    $snap = $null
    try {
        $snap = [ClipboardUtil]::Save()
        if (-not $snap.Saved) {
            Write-Log 'warn' '剪贴板被占用，取消本次取词'
            return ''
        }
        [void][ClipboardUtil]::Clear()
        [SelectionHook]::SendCtrlC()
        $delay = [int]$script:Cfg.trigger.captureDelayMs
        Start-Sleep -Milliseconds $delay
        $text = ''
        for ($i = 0; $i -lt 4; $i++) {
            $text = [ClipboardUtil]::ReadText()
            if ($null -eq $text) { $text = '' }
            if (-not [string]::IsNullOrEmpty($text)) { break }
            if ($i -lt 3) { Start-Sleep -Milliseconds 50 }
        }
        return [string]$text
    } catch {
        Write-Log 'warn' ('取词异常: ' + $_.Exception.Message)
        return ''
    } finally {
        if ($snap -and $snap.Saved) {
            try { [void][ClipboardUtil]::Restore($snap) } catch { }
        }
    }
}

function On-HookEvent {
    param($e)
    if ($null -eq $e) { return }
    if ($e.Injected) { return }
    try {
        if ($e.Kind -eq 'mouse') {
            if ($e.Phase -eq 'down') {
                $script:Ctrl.Cancelled = $true
                $script:PendingSelectionTrigger = 0
                $script:Selection.Has = $false
                if (Get-ToolbarVisible) {
                    $rect = Get-ToolbarRect
                    if (-not (Test-PointInRect $e.X $e.Y $rect)) { if ($script:UiHooks.OnCloseToolbar) { & $script:UiHooks.OnCloseToolbar } }
                }
                if ($script:Cfg.result.autoClose) {
                    foreach ($ctx in @($script:UI.Results)) {
                        if ($null -eq $ctx -or $ctx.Pinned) { continue }
                        if (-not (Test-ResultContextVisible $ctx)) { continue }
                        $rect = Get-ResultRect -Context $ctx
                        if (-not (Test-PointInRect $e.X $e.Y $rect)) { Close-ResultNow -Context $ctx }
                    }
                }
                return
            }
            if ($e.Phase -eq 'up') {
                if ($e.Button -eq 'L' -and $e.Drag) {
                    $script:Selection.Has = $true
                    $script:Selection.X = [int]$e.X
                    $script:Selection.Y = [int]$e.Y
                    $script:Selection.At = [Environment]::TickCount64
                    if ($script:Cfg.trigger.mode -eq 'selection') {
                        $script:PendingSelectionTrigger = [Environment]::TickCount64 + [int]$script:Cfg.trigger.captureDelayMs + 30
                    }
                }
                return
            }
            return
        }

        if ($e.Kind -eq 'key') {
            $vk = [int]$e.Vk
            if ($vk -eq 0x1B -and $e.Phase -eq 'down') {
                $target = Get-FocusedResultContext
                if (-not $target -or -not (Test-ResultContextVisible $target)) { $target = $script:UI.Result }
                if (-not $target -or -not (Test-ResultContextVisible $target)) { $target = Get-LastVisibleResultContext }
                if ($target) { Close-ResultNow -Context $target }
                if (Get-ToolbarVisible) { if ($script:UiHooks.OnCloseToolbar) { & $script:UiHooks.OnCloseToolbar } }
                $script:Ctrl.Cancelled = $true
                return
            }
            $isCtrl = ($vk -eq 0x11 -or $vk -eq 0xA2 -or $vk -eq 0xA3)
            if ($isCtrl) {
                if ($e.Phase -eq 'down') {
                    $script:Ctrl.Down = $true
                    $script:Ctrl.DownAt = [Environment]::TickCount64
                    if ($script:Cfg.trigger.mode -eq 'ctrl' -and (Test-SelectionCandidate)) {
                        $script:Ctrl.Cancelled = $false
                    } else {
                        $script:Ctrl.Cancelled = $true
                    }
                } else {
                    $script:Ctrl.Down = $false
                    $script:Ctrl.Cancelled = $true
                }
                return
            }
            if ($e.Phase -eq 'down') {
                if ($script:Ctrl.Down) { $script:Ctrl.Cancelled = $true }
                if ($script:Cfg.trigger.mode -eq 'shortcut' -and $script:ShortcutVkReady -and (Test-SelectionCandidate)) {
                    $sc = $script:Shortcut
                    if ($sc -and $sc.Vk -eq $vk -and
                        ([bool]$e.Ctrl -eq $sc.Ctrl) -and ([bool]$e.Alt -eq $sc.Alt) -and
                        ([bool]$e.Shift -eq $sc.Shift) -and ([bool]$e.Win -eq $sc.Win)) {
                        $x = $script:Selection.X
                        $y = $script:Selection.Y
                        Invoke-Trigger -X $x -Y $y -Reason 'shortcut'
                    }
                }
            }
        }
    } catch {
        Write-LogErrorSafe ('钩子事件处理失败: ' + $_.Exception.Message)
    }
}

function Check-LongPress {
    if (-not $script:Cfg) { return }
    if ($script:Cfg.trigger.mode -ne 'ctrl') { return }
    if (-not $script:Ctrl.Down -or $script:Ctrl.Cancelled) { return }
    if (-not $script:Selection.Has) { return }
    $elapsed = [Environment]::TickCount64 - $script:Ctrl.DownAt
    if ($elapsed -ge [int]$script:Cfg.trigger.longPressMs) {
        $x = $script:Selection.X
        $y = $script:Selection.Y
        Invoke-Trigger -X $x -Y $y -Reason 'ctrl-longpress'
    }
}

function Check-PendingSelectionTrigger {
    if ($script:PendingSelectionTrigger -le 0) { return }
    if ([Environment]::TickCount64 -lt $script:PendingSelectionTrigger) { return }
    $x = $script:Selection.X
    $y = $script:Selection.Y
    $script:PendingSelectionTrigger = 0
    Invoke-Trigger -X $x -Y $y -Reason 'selection'
}

# ---------------------------------------------------------------------------
# Actions / result window / SSE
# ---------------------------------------------------------------------------

function Find-Action {
    param([string]$ActionId)
    if (-not $script:Cfg.actions) { return $null }
    foreach ($a in $script:Cfg.actions) { if ($a.id -eq $ActionId) { return $a } }
    return $null
}

function Get-SearchUrl {
    param($Action, [string]$Text)
    $template = ''
    if ($Action -is [hashtable]) { $template = [string]$Action['searchUrl'] }
    elseif ($Action -and $Action.PSObject.Properties['searchUrl']) { $template = [string]$Action.searchUrl }
    if (-not $template) { $template = 'https://www.google.com/search?q={{query}}' }
    $encoded = [System.Uri]::EscapeDataString($Text)
    return $template.Replace('{{query}}', $encoded)
}

function Invoke-Action {
    param([string]$ActionId)
    try {
        $act = Find-Action -ActionId $ActionId
        if (-not $act) { Write-Log 'warn' ("未知动作: " + $ActionId); return }
        $text = [string]$script:SelectionText
        if ([string]::IsNullOrEmpty($text)) { Write-Log 'warn' '无选中文本，忽略动作'; return }
        $script:State.lastActionId = $ActionId
        Save-State
        if (-not $script:SelfTestState.Enabled) {
            if ($script:UiHooks.OnCloseToolbar) { & $script:UiHooks.OnCloseToolbar }
        }
        switch ($act.kind) {
            'copy' {
                $ok = [ClipboardUtil]::SetText($text)
                $pos = [ScreenUtil]::GetCursorPos()
                Show-UiToast -Text $(if ($ok) { '已复制' } else { '复制失败' }) -X $pos[0] -Y $pos[1]
                Write-Log 'info' ('动作 copy 完成 ok=' + $ok)
            }
            'search' {
                $url = Get-SearchUrl -Action $act -Text $text
                try { Start-Process -FilePath $url | Out-Null } catch { Start-Process -FilePath 'explorer.exe' -ArgumentList $url | Out-Null }
                Write-Log 'info' ('动作 search 打开浏览器: ' + $url)
            }
            default {
                Start-ResultStream -Action $act -Text $text
            }
        }
    } catch {
        Write-LogErrorSafe ('动作执行失败: ' + $_.Exception.Message)
    }
}

function Start-ResultStream {
    param($Action, [string]$Text)
    $ctx = $null
    try {
        if ($null -eq $Action) { return }
        # Capture the current window frame and pin state before closing anything.
        $placement = Get-ResultPlacement
        Close-UnpinnedResultWindows
        $label = Get-ActionLabel $Action
        $ctx = Show-ResultWindow -ActionLabel $label -ActionId ([string]$Action.id) -Placement $placement
        if (-not $ctx) { return }
        $ctx.App = [string]$script:SelectionApp
        $ctx.SourceText = $Text
        Start-ResultSse -Context $ctx -Action $Action -Text $Text
    } catch {
        Write-LogErrorSafe ('发起请求失败: ' + $_.Exception.Message)
        Write-Log 'debug' ('发起请求堆栈: ' + $_.ScriptStackTrace)
        if (-not $ctx) { $ctx = $script:UI.Result }
        if ($ctx) {
            try { $script:UI.Result = $ctx; Set-ResultError ('无法连接宿主：' + $_.Exception.Message) } catch { }
        }
    }
}

function Close-UnpinnedResultWindows {
    $contexts = @()
    if ($script:UI.Results) { $contexts = @($script:UI.Results) }
    foreach ($ctx in $contexts) {
        if ($null -eq $ctx) { continue }
        if ($ctx.Pinned) { continue }
        Close-ResultNow -Context $ctx
    }
}

function Reset-ResultForStream {
    param($Context)
    if ($null -eq $Context) { return }
    $Context.Text = ''
    $Context.Dirty = $false
    $Context.HasDelta = $false
    $Context.Done = $false
    $Context.Error = ''
    $Context.LoadingOn = $true
    # Clear the old document now; a Dirty render here would hide the loading
    # overlay before the first delta arrives.
    try { if ($Context.RichBox -and $Context.RichBox.Document) { $Context.RichBox.Document.Blocks.Clear() } } catch { }
    $Context.ModelLabel = ''
    $Context.Provider = ''
    $Context.Model = ''
    if ($Context.ModelTag) {
        $Context.ModelTag.Text = ''
        $Context.ModelTag.Visibility = 'Collapsed'
    }
    if ($Context.StatusText -and $Context.Palette) {
        try { $Context.StatusText.Foreground = Get-UiBrush $Context.Palette.Muted } catch { }
    }
    if ($Context.Loading) { $Context.Loading.Visibility = 'Visible' }
}

function Start-ResultSse {
    param($Context, $Action, [string]$Text)
    if ($null -eq $Context -or $null -eq $Action) { return }
    $script:UI.Result = $Context
    $Context.ActionId = [string]$Action.id
    $Context.ActionLabel = Get-ActionLabel $Action
    $Context.SourceText = $Text
    if ($Context.TitleLabel) { $Context.TitleLabel.Text = [string]$Context.ActionLabel }
    Reset-ResultForStream $Context
    Set-ResultLoading $true
    Set-ResultStatus '连接宿主…'
    try { if ($Context.Stream) { $Context.Stream.Cancel() } } catch { }
    $Context.Stream = $null
    $body = @{
        requestId = [guid]::NewGuid().ToString()
        actionId  = [string]$Action.id
        text      = $Text
        source    = @{ app = [string]$Context.App }
        locale    = [string]$script:Cfg.locale
    } | ConvertTo-Json -Compress -Depth 5
    $stream = [SseStream]::new()
    $stream.Start(($script:Cfg.endpoint + '/v1/action'), $script:Cfg.token, $body)
    $Context.Stream = $stream
    Set-ResultStatus '生成中…'
    Write-Log 'info' ('动作 ' + $Action.id + ' 已发起请求 chars=' + $Text.Length + ' app=' + $Context.App)
}

function Poll-Stream {
    $contexts = @()
    if ($script:UI.Results) { $contexts = @($script:UI.Results) }
    foreach ($ctx in $contexts) {
        if ($null -eq $ctx) { continue }
        $s = $ctx.Stream
        if (-not $s) { continue }
        if (-not (Test-ResultContextVisible $ctx)) {
            try { $s.Cancel() } catch { }
            $ctx.Stream = $null
            continue
        }
        $previous = $script:UI.Result
        $script:UI.Result = $ctx
        try {
            $drained = $false
            $guard = 0
            while ($guard -lt 120) {
                $guard++
                $ev = $s.Poll()
                if ($null -eq $ev) { $drained = $true; break }
                try {
                    switch ([string]$ev.Kind) {
                        'meta' {
                            $script:SelfTestState.MetaCount++
                            $data = $null
                            try { $data = $ev.Data | ConvertFrom-Json } catch { }
                            if ($data) {
                                $prov = ''
                                $model = ''
                                $label = ''
                                if ($data.PSObject.Properties['provider']) { $prov = [string]$data.provider }
                                if ($data.PSObject.Properties['model']) { $model = [string]$data.model }
                                if ($data.PSObject.Properties['label']) { $label = [string]$data.label }
                                Set-ResultMeta -Provider $prov -Model $model -Label $label
                            }
                            Set-ResultStatus '生成中…'
                        }
                        'delta' {
                            $script:SelfTestState.DeltaCount++
                            $data = $null
                            try { $data = $ev.Data | ConvertFrom-Json } catch { }
                            if ($data -and $data.PSObject.Properties['text']) { Add-ResultDelta ([string]$data.text) }
                            Set-ResultStatus '生成中…'
                        }
                        'done' {
                            $script:SelfTestState.Done = $true
                            if (-not $script:SelfTestState.DoneAt) { $script:SelfTestState.DoneAt = [Environment]::TickCount64 }
                            Set-ResultDone
                            Write-Log 'info' 'SSE done'
                        }
                        'error' {
                            $msg = '模型调用失败'
                            $data = $null
                            try { $data = $ev.Data | ConvertFrom-Json } catch { }
                            if ($data -and $data.PSObject.Properties['message'] -and $data.message) { $msg = [string]$data.message }
                            $script:SelfTestState.Error = $msg
                            Set-ResultError ('出错：' + $msg)
                            Write-Log 'warn' ('SSE error: ' + $msg)
                        }
                        'transport-error' {
                            $msg = [string]$ev.Data
                            if (-not $msg) { $msg = '连接失败' }
                            $script:SelfTestState.Error = $msg
                            Set-ResultError ('无法连接宿主：' + $msg)
                            Write-Log 'warn' ('SSE transport error: ' + $msg)
                        }
                        'stream-end' {
                            if (-not $ctx.Done -and -not $ctx.Error) {
                                $msg = '连接已断开，请重试'
                                $script:SelfTestState.Error = $msg
                                Set-ResultError $msg
                                Write-Log 'warn' 'SSE stream ended without done'
                            }
                        }
                        default { }
                    }
                } catch {
                    Write-LogErrorSafe ('SSE 事件处理失败: ' + $_.Exception.Message)
                }
            }
            if ($s.Finished -and $drained) { $ctx.Stream = $null }
        } finally {
            $script:UI.Result = $previous
        }
    }
}

function Close-ResultNow {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if ($null -eq $Context) { $script:SuppressAutoClose = $false; return }
    try { if ($Context.Stream) { $Context.Stream.Cancel() } } catch { }
    $Context.Stream = $null
    if ($script:UI.Result -eq $Context) { $script:SuppressAutoClose = $false }
    Close-ResultWindow -Context $Context
}

function Copy-ResultText {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if ($null -eq $Context) { return }
    $script:UI.Result = $Context
    $text = Get-ResultText -Context $Context
    if ([string]::IsNullOrEmpty($text)) { return }
    $ok = [ClipboardUtil]::SetText($text)
    Set-ResultStatus $(if ($ok) { '已复制' } else { '复制失败' })
}

function Regenerate-Result {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if ($null -eq $Context) { return }
    if (-not (Test-ResultContextVisible $Context)) { return }
    $actionId = [string]$Context.ActionId
    $act = Find-Action $actionId
    if (-not $act) { Write-Log 'warn' ('无法重新生成：未知动作 ' + $actionId); return }
    $text = [string]$Context.SourceText
    if ([string]::IsNullOrEmpty($text)) { $text = [string]$script:SelectionText }
    if ([string]::IsNullOrEmpty($text)) { return }
    $script:UI.Result = $Context
    # Restart the stream inside the same window: position, size and pin survive.
    Start-ResultSse -Context $Context -Action $act -Text $text
    Write-Log 'info' ('重新生成 ' + $actionId + '，沿用原窗口位置与尺寸')
}

# ---------------------------------------------------------------------------
# Preview command / command.json
# ---------------------------------------------------------------------------

function Invoke-Preview {
    param([string]$Text)
    try {
        if ([string]::IsNullOrWhiteSpace($Text)) { $Text = $script:SampleText }
        Close-AllResultWindows
        Close-ToolbarWindow
        $script:SelectionText = $Text
        $script:SelectionApp = 'preview'
        $screen = [ScreenUtil]::GetPrimaryScreenSize()
        $cx = [int]($screen[0] / 2)
        $cy = [int]($screen[1] / 2)
        Show-ToolbarAt -CursorX $cx -CursorY $cy
        $act = Find-Action 'translate'
        if ($act -and $act.kind -eq 'llm') {
            Start-ResultStream -Action $act -Text $Text
        } else {
            # No LLM translate action configured: show a local sample instead of calling the host.
            Show-ResultWindow -ActionLabel '翻译（预览）' -ActionId 'preview'
            Add-ResultDelta $script:PreviewSample
            Set-ResultDone
        }
        Write-Log 'info' '预览命令已执行'
    } catch {
        Write-LogErrorSafe ('预览失败: ' + $_.Exception.Message)
    }
}

function Poll-CommandFile {
    if (-not $script:Cfg -or -not $script:Cfg.dataDir) { return }
    $now = [Environment]::TickCount64
    if ($now -lt $script:NextCommandPoll) { return }
    $script:NextCommandPoll = $now + 400
    $path = Join-Path $script:Cfg.dataDir 'command.json'
    if (-not (Test-Path -LiteralPath $path)) { return }
    $raw = Read-JsonFile $path
    if (-not $raw) { return }
    $id = [string]$raw.id
    if (-not $id -or $id -eq $script:LastCommandId) { return }
    $script:LastCommandId = $id
    if ([string]$raw.type -eq 'preview') {
        $text = ''
        if ($raw.PSObject.Properties['text']) { $text = [string]$raw.text }
        Invoke-Preview -Text $text
    }
}

function Poll-PreviewStream {
    if (-not $script:PreviewStream) { return }
    $ps = $script:PreviewStream
    $now = [Environment]::TickCount64
    if ($now -lt $script:NextPreviewTick) { return }
    $script:NextPreviewTick = $now + 90
    $remaining = $ps.Text.Length - $ps.Pos
    if ($remaining -le 0) {
        $script:PreviewStream = $null
        Set-ResultDone
        return
    }
    $n = [Math]::Min(14, $remaining)
    Add-ResultDelta $ps.Text.Substring($ps.Pos, $n)
    $ps.Pos += $n
    if ($ps.Pos -ge $ps.Text.Length) {
        Set-ResultDone
        $script:PreviewStream = $null
    }
}

# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------

$script:SelfTestState = @{
    Enabled         = $false
    Step            = 0
    StepAt          = 0
    StartedAt       = 0
    MetaCount       = 0
    DeltaCount      = 0
    Done            = $false
    Clicked         = $false
    PinToggled      = $false
    StackOk         = $false
    StackOffsetX    = 0
    StackOffsetY    = 0
    StackSameSize   = $false
    OldVisible      = $false
    StackFirstRect  = @()
    StackSecondRect = @()
    Error           = ''
    ToolbarShot     = ''
    ResultShot      = ''
    ToolbarRect     = @()
    ResultRect      = @()
    Ok              = $false
    DoneAt          = 0
    TimeoutMs       = 20000
}


function Get-PreviewDir {
    $dir = Join-Path $script:Here 'preview'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    return $dir
}

function Save-SelfTestResult {
    try {
        $script:SelfTestState.Ok = ($script:SelfTestState.Done -and $script:SelfTestState.Clicked -and
            $script:SelfTestState.PinToggled -and $script:SelfTestState.StackOk -and
            $script:SelfTestState.DeltaCount -ge 1 -and $script:SelfTestState.MetaCount -ge 1 -and
            [string]::IsNullOrEmpty($script:SelfTestState.Error) -and
            (Test-Path -LiteralPath $script:SelfTestState.ToolbarShot) -and (Test-Path -LiteralPath $script:SelfTestState.ResultShot))
        $result = @{
            ok              = $script:SelfTestState.Ok
            done            = $script:SelfTestState.Done
            clicked         = $script:SelfTestState.Clicked
            pinToggled      = $script:SelfTestState.PinToggled
            stackOk         = $script:SelfTestState.StackOk
            stackOffsetX    = $script:SelfTestState.StackOffsetX
            stackOffsetY    = $script:SelfTestState.StackOffsetY
            stackSameSize   = $script:SelfTestState.StackSameSize
            oldVisible      = $script:SelfTestState.OldVisible
            stackFirstRect  = $script:SelfTestState.StackFirstRect
            stackSecondRect = $script:SelfTestState.StackSecondRect
            metaCount       = $script:SelfTestState.MetaCount
            deltaCount      = $script:SelfTestState.DeltaCount
            error           = $script:SelfTestState.Error
            toolbarShot     = $script:SelfTestState.ToolbarShot
            resultShot      = $script:SelfTestState.ResultShot
            toolbarRect     = $script:SelfTestState.ToolbarRect
            resultRect      = $script:SelfTestState.ResultRect
            durationMs      = [Environment]::TickCount64 - $script:SelfTestState.StartedAt
            pid             = $PID
        }
        $path = Join-Path $script:Cfg.dataDir 'selftest-result.json'
        if (-not (Test-Path -LiteralPath $script:Cfg.dataDir)) { New-Item -ItemType Directory -Force -Path $script:Cfg.dataDir | Out-Null }
        [System.IO.File]::WriteAllText($path, ($result | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
        Write-Log 'info' ('自测结果: ok=' + $script:SelfTestState.Ok + ' clicked=' + $script:SelfTestState.Clicked + ' pinToggled=' + $script:SelfTestState.PinToggled + ' stackOk=' + $script:SelfTestState.StackOk + ' metas=' + $script:SelfTestState.MetaCount + ' deltas=' + $script:SelfTestState.DeltaCount + ' done=' + $script:SelfTestState.Done)
    } catch {
        Write-Log 'error' ('写自测结果失败: ' + $_.Exception.Message)
    }
}


function Invoke-SelfTestTick {
    $st = $script:SelfTestState
    $now = [Environment]::TickCount64
    try {
        switch ($st.Step) {
            0 {
                if ($now - $st.StepAt -ge 500) {
                    $screen = [ScreenUtil]::GetPrimaryScreenSize()
                    $cx = [int]($screen[0] / 2) - 80
                    $cy = [int]($screen[1] / 2) - 60
                    $script:SelectionText = $script:SampleText
                    $script:SelectionApp = 'selftest'
                    Show-ToolbarAt -CursorX $cx -CursorY $cy
                    $st.ToolbarRect = Get-ToolbarRect
                    $st.Step = 1
                    $st.StepAt = $now
                }
            }
            1 {
                if ($now - $st.StepAt -ge 700) {
                    $previewDir = Get-PreviewDir
                    $path = Join-Path $previewDir 'toolbar.png'
                    if (Save-Screenshot -Rect (Get-ToolbarRect) -Path $path) { $st.ToolbarShot = $path; $st.ToolbarRect = Get-ToolbarRect }
                    Write-Log 'info' ('自测截图 toolbar: ' + $path)
                    $st.Step = 2
                    $st.StepAt = $now
                }
            }
            2 {
                if ($now - $st.StepAt -ge 150) {
                    # Drive the real button path: raise the same routed event a
                    # WPF click raises, then assert that the result window opened.
                    $actionBtn = Get-ToolbarActionButton -ActionId 'translate'
                    if (-not $actionBtn) {
                        $st.Error = '工具栏中找不到动作按钮 translate'
                        Write-Log 'error' $st.Error
                        Save-SelfTestResult
                        Stop-Helper 'selftest 点击断言失败'
                        return
                    }
                    $script:SelectionText = $script:SampleText
                    $margs = [System.Windows.Input.MouseButtonEventArgs]::new([System.Windows.Input.Mouse]::PrimaryDevice, [Environment]::TickCount, [System.Windows.Input.MouseButton]::Left)
                    $margs.RoutedEvent = [System.Windows.UIElement]::MouseLeftButtonUpEvent
                    $actionBtn.RaiseEvent($margs)
                    if (-not (Get-ResultVisible)) {
                        $st.Error = '工具栏按钮点击未触发动作'
                        Write-Log 'error' $st.Error
                        Save-SelfTestResult
                        Stop-Helper 'selftest 点击断言失败'
                        return
                    }
                    $st.Clicked = $true
                    Write-Log 'info' '自测点击 translate 按钮后结果窗已打开'
                    # Drive the real title-bar pin button twice: first click pins
                    # (Topmost=true), second click unpins and restores the
                    # configured DefaultTopmost value.
                    $pinBtn = $script:UI.Result.PinButton
                    if (-not $pinBtn) { throw [System.InvalidOperationException]::new('结果窗缺少 pin 按钮') }
                    $pinArgs = [System.Windows.Input.MouseButtonEventArgs]::new([System.Windows.Input.Mouse]::PrimaryDevice, [Environment]::TickCount, [System.Windows.Input.MouseButton]::Left)
                    $pinArgs.RoutedEvent = [System.Windows.UIElement]::MouseLeftButtonUpEvent
                    $pinBtn.RaiseEvent($pinArgs)
                    if (-not (Get-ResultPinned)) { throw [System.InvalidOperationException]::new('pin 按钮首次点击后未进入钉住状态') }
                    if (-not [bool]$script:UI.Result.Window.Topmost) { throw [System.InvalidOperationException]::new('钉住后结果窗 Topmost 不为 true') }
                    $pinArgs2 = [System.Windows.Input.MouseButtonEventArgs]::new([System.Windows.Input.Mouse]::PrimaryDevice, [Environment]::TickCount, [System.Windows.Input.MouseButton]::Left)
                    $pinArgs2.RoutedEvent = [System.Windows.UIElement]::MouseLeftButtonUpEvent
                    $pinBtn.RaiseEvent($pinArgs2)
                    if (Get-ResultPinned) { throw [System.InvalidOperationException]::new('pin 按钮第二次点击后仍处于钉住状态') }
                    $pinTopmost = [bool]$script:UI.Result.Window.Topmost
                    $pinExpected = [bool]$script:UI.Result.DefaultTopmost
                    if ($pinTopmost -ne $pinExpected) {
                        throw [System.InvalidOperationException]::new('取消钉住后 Topmost=' + $pinTopmost + '，与 DefaultTopmost=' + $pinExpected + ' 不一致')
                    }
                    $st.PinToggled = $true
                    Write-Log 'info' '自测 pin 按钮点击两次：钉住/取消钉住与 Topmost 校验通过'
                    # Pin the first result window once more, so the next
                    # action opens a second window stacked at (-24, +24).
                    $pinArgs3 = [System.Windows.Input.MouseButtonEventArgs]::new([System.Windows.Input.Mouse]::PrimaryDevice, [Environment]::TickCount, [System.Windows.Input.MouseButton]::Left)
                    $pinArgs3.RoutedEvent = [System.Windows.UIElement]::MouseLeftButtonUpEvent
                    $pinBtn.RaiseEvent($pinArgs3)
                    if (-not (Get-ResultPinned)) { throw [System.InvalidOperationException]::new('第三个 pin 点击后结果窗未处于钉住状态') }
                    Write-Log 'info' '自测再次钉住首个结果窗，准备多窗口断言'
                    $st.Step = 3
                    $st.StepAt = $now
                }
            }
            3 {
                $settleBase = if ($st.DoneAt) { $st.DoneAt } else { $st.StepAt }
                $doneFor = if ($st.DoneAt) { $now - $st.DoneAt } else { 0 }
                $timedOut = ($now - $st.StepAt) -gt $st.TimeoutMs
                if (($st.Done -and $doneFor -ge 700) -or ($st.Error -and $doneFor -ge 700) -or $timedOut) {
                    if (-not $st.Done -and -not $st.Error -and $timedOut) { $st.Error = '自测超时：未在 20 秒内收到 done 事件' }
                    $previewDir = Get-PreviewDir
                    $path = Join-Path $previewDir 'result.png'
                    $rect = Get-ResultRect
                    if ($rect -and $rect.Count -ge 4) { if (Save-Screenshot -Rect $rect -Path $path) { $st.ResultShot = $path; $st.ResultRect = $rect } }
                    else { Write-Log 'warn' '结果窗矩形为空，截图跳过' }
                    Write-Log 'info' ('自测截图 result: ' + $path)
                    Save-SelfTestResult
                    $st.Step = 4
                    $st.StepAt = $now
                }
            }
            4 {
                if ($now - $st.StepAt -ge 250) {
                    $first = $script:UI.Result
                    if (-not $first) { throw [System.InvalidOperationException]::new('多窗口断言：找不到首个结果窗') }
                    if (-not $first.Pinned) { throw [System.InvalidOperationException]::new('多窗口断言：首个结果窗未钉住') }
                    # Move the pinned window to a safe spot so the -24/+24 offset
                    # cannot be altered by work-area clamping.
                    $work = [ScreenUtil]::GetWorkArea(0, 0)
                    if ($first.Hwnd -ne [IntPtr]::Zero) {
                        $baseRect = [ForegroundInfo]::GetWindowRect($first.Hwnd)
                        if ($baseRect -and $baseRect.Count -ge 4) { $work = [ScreenUtil]::GetWorkArea([int]$baseRect[0] + 10, [int]$baseRect[1] + 10) }
                    }
                    [WindowUtil]::MoveWindow($first.Hwnd, ([int]$work[0] + 40), ([int]$work[1] + 8), [bool]$first.Window.Topmost)
                    $actionBtn = Get-ToolbarActionButton -ActionId 'translate'
                    if (-not $actionBtn) { throw [System.InvalidOperationException]::new('多窗口断言：工具栏中找不到 translate 按钮') }
                    $stackArgs = [System.Windows.Input.MouseButtonEventArgs]::new([System.Windows.Input.Mouse]::PrimaryDevice, [Environment]::TickCount, [System.Windows.Input.MouseButton]::Left)
                    $stackArgs.RoutedEvent = [System.Windows.UIElement]::MouseLeftButtonUpEvent
                    $actionBtn.RaiseEvent($stackArgs)
                    $second = $script:UI.Result
                    if (-not $second -or [object]::ReferenceEquals($second, $first)) {
                        throw [System.InvalidOperationException]::new('多窗口断言：第二次动作没有创建新的结果窗')
                    }
                    $st.OldVisible = (Test-ResultContextVisible $first)
                    if (-not $st.OldVisible) { throw [System.InvalidOperationException]::new('多窗口断言：钉住的首个结果窗被关闭') }
                    if (-not (Test-ResultContextVisible $second)) { throw [System.InvalidOperationException]::new('多窗口断言：第二个结果窗未显示') }
                    $firstW = [double]$first.Window.Width - 24
                    $firstH = [double]$first.Window.Height - 24
                    $secondW = [double]$second.Window.Width - 24
                    $secondH = [double]$second.Window.Height - 24
                    $st.StackSameSize = ([Math]::Abs($firstW - $secondW) -lt 0.5 -and [Math]::Abs($firstH - $secondH) -lt 0.5)
                    $firstRect = Get-ResultRect -Context $first
                    $secondRect = Get-ResultRect -Context $second
                    if (-not $firstRect -or -not $secondRect) { throw [System.InvalidOperationException]::new('多窗口断言：结果窗矩形为空') }
                    $st.StackOffsetX = [int]$secondRect[0] - [int]$firstRect[0]
                    $st.StackOffsetY = [int]$secondRect[1] - [int]$firstRect[1]
                    $st.StackFirstRect = $firstRect
                    $st.StackSecondRect = $secondRect
                    $st.StackOk = ($st.StackSameSize -and $st.StackOffsetX -eq -24 -and $st.StackOffsetY -eq 24)
                    if (-not $st.StackOk) {
                        throw [System.InvalidOperationException]::new('多窗口断言失败: sameSize=' + $st.StackSameSize + ' dx=' + $st.StackOffsetX + ' dy=' + $st.StackOffsetY)
                    }
                    Write-Log 'info' ('自测多窗口：旧窗仍可见，新窗同尺寸，原点偏移 ' + $st.StackOffsetX + ',' + $st.StackOffsetY)
                    $st.Step = 5
                    $st.StepAt = $now
                }
            }
            5 {
                $current = $script:UI.Result
                $currentDone = [bool]($current -and $current.Done)
                $timedOut = ($now - $st.StepAt) -gt 8000
                if ($currentDone -or $timedOut) {
                    if (-not $currentDone) { $st.Error = '多窗口断言：第二个结果流未在 8 秒内收到 done' }
                    Save-SelfTestResult
                    $st.Step = 6
                    $st.StepAt = $now
                }
            }
            6 {
                if ($now - $st.StepAt -ge 300) {
                    Close-AllUi
                    $st.Step = 7
                    Stop-Helper 'selftest 完成'
                }
            }
        }
    } catch {
        Write-Log 'error' ('自测步骤失败: ' + $_.Exception.Message)
        Write-Log 'debug' ('自测异常堆栈: ' + $_.ScriptStackTrace)
        $st.Error = $_.Exception.Message
        Save-SelfTestResult
        Stop-Helper 'selftest 异常'
    }
}

# ---------------------------------------------------------------------------
# Command prompts / status line helpers
# ---------------------------------------------------------------------------

function Get-Version { return '0.1.0' }

# ---------------------------------------------------------------------------
# Main pump
# ---------------------------------------------------------------------------

function Pump-Tick {
    try {
        if ($script:ShuttingDown) { return }
        if ($script:StdinWatched -and [StdInWatcher]::Eof) {
            Write-Log 'info' 'stdin 已关闭，宿主退出，助手一并退出'
            Stop-Helper 'stdin eof'
            return
        }
        # 1. hook events
        try {
            $events = [SelectionHook]::DrainEvents()
            if ($events -and $events.Count -gt 0) {
                foreach ($e in $events) { On-HookEvent $e }
            }
        } catch { Write-LogErrorSafe ('读取钩子事件失败: ' + $_.Exception.Message) }
        # 2. trigger state machine
        try {
            Check-LongPress
            Check-PendingSelectionTrigger
        } catch { Write-LogErrorSafe ('触发判定失败: ' + $_.Exception.Message) }
        # 3. streaming
        try { Poll-Stream } catch { Write-LogErrorSafe ('SSE 轮询失败: ' + $_.Exception.Message) }
        # 4. UI flush
        try { Update-ResultRender } catch { Write-LogErrorSafe ('渲染失败: ' + $_.Exception.Message) }
        try { Update-LoadingAnimation } catch { }
        # 5. toast expiry
        try {
            if ($script:UI.Toast -and $script:UI.Toast.CloseAt -and [Environment]::TickCount64 -ge $script:UI.Toast.CloseAt) { Close-UiToast }
        } catch { }
        # 6. preview stream + commands
        try { Poll-PreviewStream } catch { }
        try { Poll-CommandFile } catch { }
        # 7. self test
        if ($script:SelfTestState.Enabled -and -not $script:ShuttingDown) { Invoke-SelfTestTick }
    } catch {
        Write-LogErrorSafe ('主循环异常: ' + $_.Exception.Message)
    }
}

function Stop-Helper {
    param([string]$Reason = '')
    if ($script:ShuttingDown) { return }
    $script:ShuttingDown = $true
    Write-Log 'info' ('助手退出: ' + $Reason)
    try { Close-AllUi } catch { }
    try { if ($script:HooksInstalled) { [SelectionHook]::Uninstall(); $script:HooksInstalled = $false } } catch { }
    try { Save-State } catch { }
    try { $script:App.Shutdown() } catch { }
}

# ---------------------------------------------------------------------------
# Initialization
# ---------------------------------------------------------------------------

function Initialize-Helper {
    # -- config -----------------------------------------------------------
    if (-not $ConfigPath) {
        $script:LogFile = Join-Path $script:LogFallbackDir 'helper.log'
        Write-Log 'error' '缺少 -ConfigPath 参数'
        return 2
    }
    $rawConfig = Read-JsonFile $ConfigPath
    if ($null -eq $rawConfig) {
        $script:LogFile = Join-Path $script:LogFallbackDir 'helper.log'
        Write-Log 'error' ('无法读取配置文件: ' + $ConfigPath)
        return 2
    }
    $script:Cfg = ConvertTo-HelperConfig $rawConfig
    if (-not $script:Cfg.endpoint -or -not $script:Cfg.token) {
        $script:LogFile = $script:Cfg.logPath
        Write-Log 'error' 'helper-config 缺少 endpoint 或 token'
        return 2
    }
    $script:LogFile = $script:Cfg.logPath
    $script:LogLevel = if ($script:Cfg.debug) { 3 } else { 2 }
    $script:LogFallbackDir = $script:Cfg.dataDir
    Write-Log 'info' ('助手启动 pid=' + $PID + ' endpoint=' + $script:Cfg.endpoint + ' mode=' + $script:Cfg.trigger.mode + ' selfTest=' + $SelfTest.IsPresent)
    if (-not (Test-Path -LiteralPath $script:Cfg.dataDir)) { New-Item -ItemType Directory -Force -Path $script:Cfg.dataDir | Out-Null }

    # -- state ------------------------------------------------------------
    $script:State = Read-State -DataDir $script:Cfg.dataDir
    if ($script:Cfg.result.rememberSize) {
        if ($script:State.resultWidth) { $script:Cfg.result.width = [double]$script:State.resultWidth }
        if ($script:State.resultHeight) { $script:Cfg.result.height = [double]$script:State.resultHeight }
    }
    if ($script:State.toolbarX) { $script:RememberedToolbarX = [int]$script:State.toolbarX }
    if ($script:State.toolbarY) { $script:RememberedToolbarY = [int]$script:State.toolbarY }
    Save-State

    # -- native layer -----------------------------------------------------
    try {
        $csPath = Join-Path $script:Here 'lib\SelectionHook.cs'
        $cs = [System.IO.File]::ReadAllText($csPath, [System.Text.Encoding]::UTF8)
        Add-Type -TypeDefinition $cs -ErrorAction Stop
        Write-Log 'debug' 'SelectionHook.cs 编译完成'
    } catch {
        Write-Log 'error' ('C# 原生层编译失败: ' + $_.Exception.Message)
        Post-Status -State 'error' -Message ('原生层编译失败: ' + $_.Exception.Message)
        return 1
    }

    # -- DPI + WPF --------------------------------------------------------
    try {
        [ScreenUtil]::InitializeDpiAwareness()
        Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
        Add-Type -AssemblyName PresentationCore -ErrorAction Stop
        Add-Type -AssemblyName WindowsBase -ErrorAction Stop
        $script:App = [System.Windows.Application]::new()
        $script:App.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown
        $script:App.Add_DispatcherUnhandledException({
                param($sender, $e)
                Write-Log 'error' ('未处理的 UI 异常: ' + $e.Exception.Message)
                $e.Handled = $true
            })
        Write-Log 'debug' 'WPF 初始化完成'
    } catch {
        Write-Log 'error' ('WPF 初始化失败: ' + $_.Exception.Message)
        Post-Status -State 'error' -Message ('WPF 初始化失败: ' + $_.Exception.Message)
        return 1
    }

    # -- UI layer ---------------------------------------------------------
    $script:UI.Theme = Get-SystemTheme
    Wire-UiHooks

    # -- hooks ------------------------------------------------------------
    if (-not $SelfTest) {
        try {
            $ok = [SelectionHook]::Install()
            if ($ok) {
                $script:HooksInstalled = $true
                Write-Log 'info' '全局钩子安装成功'
            } else {
                Write-Log 'error' ('全局钩子安装失败: ' + [SelectionHook]::LastError)
                Post-Status -State 'error' -Message ('全局钩子安装失败: ' + [SelectionHook]::LastError)
                return 1
            }
        } catch {
            Write-Log 'error' ('全局钩子安装异常: ' + $_.Exception.Message)
            Post-Status -State 'error' -Message ('全局钩子安装异常: ' + $_.Exception.Message)
            return 1
        }
        try {
            $script:StdinWatched = [StdInWatcher]::Start()
            Write-Log 'debug' ('stdin 监视: ' + $script:StdinWatched)
        } catch { $script:StdinWatched = $false }
    } else {
        $script:StdinWatched = $false
    }

    # -- shortcut ---------------------------------------------------------
    $script:Shortcut = ConvertFrom-Shortcut ($script:Cfg.trigger.shortcut)
    $script:ShortcutVkReady = ([int]$script:Shortcut.Vk) -gt 0
    if ($script:Cfg.trigger.mode -eq 'shortcut' -and -not $script:ShortcutVkReady) {
        Write-Log 'warn' ('无法解析快捷键: ' + $script:Cfg.trigger.shortcut)
    }

    # -- command baseline --------------------------------------------------
    try {
        $cmdPath = Join-Path $script:Cfg.dataDir 'command.json'
        $rawCmd = Read-JsonFile $cmdPath
        if ($rawCmd -and $rawCmd.id) { $script:LastCommandId = [string]$rawCmd.id }
    } catch { }
    $script:NextCommandPoll = 0
    $script:NextPreviewTick = 0

    # -- status ready ------------------------------------------------------
    if ($SelfTest) {
        $script:SelfTestState.Enabled = $true
        $script:SelfTestState.StartedAt = [Environment]::TickCount64
        $script:SelfTestState.Step = 0
        $script:SelfTestState.StepAt = [Environment]::TickCount64
        $script:SuppressAutoClose = $true
        Write-Log 'info' '自测模式启动，不安装全局钩子'
    }
    Post-Status -State 'ready' -Message ''
    Save-State

    # -- timers ------------------------------------------------------------
    $script:PumpTimer = [System.Windows.Threading.DispatcherTimer]::new()
    $script:PumpTimer.Interval = [TimeSpan]::FromMilliseconds(40)
    $script:PumpTimer.Add_Tick({ Pump-Tick })
    $script:PumpTimer.Start()
    return 0
}

function Wire-UiHooks {
    $script:UiHooks.OnAction = {
        param($actionId)
        Invoke-Action -ActionId ([string]$actionId)
    }
    $script:UiHooks.OnCloseToolbar = {
        Close-ToolbarWindow
    }
    $script:UiHooks.OnCopyResult = {
        param($ctx)
        Copy-ResultText -Context $ctx
    }
    $script:UiHooks.OnRegenerate = {
        param($ctx)
        Regenerate-Result -Context $ctx
    }
    $script:UiHooks.OnCloseResult = {
        param($ctx)
        Close-ResultNow -Context $ctx
    }
    $script:UiHooks.OnSaveResultSize = {
        param($width, $height)
        try {
            $script:State.resultWidth = [Math]::Round([double]$width - 24)
            $script:State.resultHeight = [Math]::Round([double]$height - 24)
            Save-State
        } catch { }
    }
    $script:UiHooks.OnSaveResultPosition = {
        param($x, $y)
        try {
            $script:State.resultX = [int]$x
            $script:State.resultY = [int]$y
            Save-State
        } catch { }
    }
    $script:UiHooks.OnToolbarMoved = {
        param($x, $y)
        try {
            $script:State.toolbarX = [int]$x
            $script:State.toolbarY = [int]$y
            Save-State
        } catch { }
    }
}


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

$initCode = 1
try {
    $initCode = Initialize-Helper
} catch {
    try {
        if (-not $script:LogFile) { $script:LogFile = Join-Path $script:LogFallbackDir 'helper.log' }
        Write-Log 'error' ('初始化异常: ' + $_.Exception.Message)
    } catch { }
    $initCode = 1
}

if ($initCode -eq 0) {
    try {
        [void]$script:App.Run()
    } catch {
        try { Write-Log 'error' ('事件循环异常: ' + $_.Exception.Message) } catch { }
        $script:ExitCode = 1
    }
    try { Close-AllUi } catch { }
    try { if ($script:HooksInstalled) { [SelectionHook]::Uninstall() } } catch { }
    if ($script:SelfTestState.Enabled) {
        if ($script:SelfTestState.Ok) { $script:ExitCode = 0 }
        elseif ($script:ShuttingDown) { $script:ExitCode = 1 }
        if ($script:SelfTestState.Ok) { Write-Log 'info' 'SELFTEST PASS' } else { Write-Log 'error' 'SELFTEST FAIL' }
    }
} else {
    $script:ExitCode = $initCode
}

exit $script:ExitCode
