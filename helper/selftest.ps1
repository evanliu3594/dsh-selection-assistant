# selftest.ps1 — headless self test for the dsh-selection-assistant Windows helper.
#
#   pwsh -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File helper/selftest.ps1 -RequireRealHook
#
# What it does:
#   1. hook layer: install the real global hooks and try to inject Ctrl down /
#      700 ms / up with SendInput; assert ctrl-down/ctrl-up events and the
#      long-press judgement. Inside a low-integrity sandbox SendInput is dropped
#      by UIPI; the real check is then SKIPped and the hook engine is exercised
#      through SelectionHook.TestInjectKey/TestInjectMouse instead. Run with
#      -RequireRealHook outside the sandbox to make the real check mandatory.
#   2. mock host: a TcpListener based HTTP/SSE server (HttpListener is not
#      available to non-elevated low-integrity processes) that validates the
#      Bearer token, records /v1/status and /v1/log, answers /v1/action with two
#      meta events, 10 delta events and done.
#   3. UI self test: launch SelectionAssistant.ps1 -SelfTest against the mock,
#      wait for exit code 0, validate selftest-result.json and the two window
#      screenshots in helper/preview.
#   4. lifecycle: launch the helper in normal mode with a stdin pipe, wait for
#      status ready, send a preview command through command.json, then close
#      stdin and assert the helper exits within 8 seconds with code 0.

[CmdletBinding()]
param(
    [switch]$RequireRealHook,
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$script:Root = $PSScriptRoot
$script:Pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$script:Tmp = Join-Path $script:Root '.selftest'
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Passes = 0
$script:Skips = 0

function Write-Pass([string]$Message) {
    $script:Passes++
    Write-Output ('PASS  ' + $Message)
}
function Write-Fail([string]$Message) {
    $script:Failures.Add($Message) | Out-Null
    Write-Output ('FAIL  ' + $Message)
}
function Write-Skip([string]$Message) {
    $script:Skips++
    Write-Output ('SKIP  ' + $Message)
}
function Write-Info([string]$Message) { Write-Output ('      ' + $Message) }

function New-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Get-PngSize([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 24) { return $null }
    if (-not ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47)) { return $null }
    $w = ([int]$bytes[16] -shl 24) -bor ([int]$bytes[17] -shl 16) -bor ([int]$bytes[18] -shl 8) -bor [int]$bytes[19]
    $h = ([int]$bytes[20] -shl 24) -bor ([int]$bytes[21] -shl 16) -bor ([int]$bytes[22] -shl 8) -bor [int]$bytes[23]
    return @{ Width = $w; Height = $h; Size = $bytes.Length }
}

function Start-Child {
    param([string]$Arguments, [switch]$CaptureInput)
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $script:Pwsh
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    if ($CaptureInput) { $psi.RedirectStandardInput = $true }
    $p = [System.Diagnostics.Process]::new()
    $p.StartInfo = $psi
    [void]$p.Start()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    return @{ Process = $p; OutTask = $outTask; ErrTask = $errTask }
}

# ---------------------------------------------------------------------------
# 1. Hook layer test
# ---------------------------------------------------------------------------

function Invoke-HookTest {
    Write-Output ''
    Write-Output '== hook layer =='
    $csPath = Join-Path $script:Root 'lib\SelectionHook.cs'
    try {
        $cs = [System.IO.File]::ReadAllText($csPath, [System.Text.Encoding]::UTF8)
        Add-Type -TypeDefinition $cs -ErrorAction Stop
    } catch {
        Write-Fail ('SelectionHook.cs 编译失败: ' + $_.Exception.Message)
        return
    }
    $installed = $false
    try {
        $installed = [SelectionHook]::Install()
    } catch {
        Write-Fail ('全局钩子安装异常: ' + $_.Exception.Message)
        return
    }
    if (-not $installed) {
        Write-Fail ('全局钩子安装失败: ' + [SelectionHook]::LastError)
        return
    }
    Write-Info ('钩子安装成功: ' + [SelectionHook]::LastError)

    $realOk = $false
    $injectionWorked = $false
    try {
        [void][SelectionHook]::DrainEvents()
        [SelectionHook]::SendKey(0xA2, $true)
        Start-Sleep -Milliseconds 150
        $injectionWorked = [SelectionHook]::IsKeyDown(0xA2)
        Start-Sleep -Milliseconds 570
        [SelectionHook]::SendKey(0xA2, $false)
        Start-Sleep -Milliseconds 250
        $events = @([SelectionHook]::DrainEvents())
        $down = $events | Where-Object { $_.Kind -eq 'key' -and $_.Vk -eq 0xA2 -and $_.Phase -eq 'down' -and -not $_.Injected } | Select-Object -First 1
        $up = $events | Where-Object { $_.Kind -eq 'key' -and $_.Vk -eq 0xA2 -and $_.Phase -eq 'up' -and -not $_.Injected } | Select-Object -First 1
        if ($down -and $up) {
            $duration = $up.Ms - $down.Ms
            $longPressMs = 500
            $longPress = $duration -ge $longPressMs
            Write-Info ("真实注入: duration=${duration}ms longPress=$longPress events=" + $events.Count)
            if ($longPress) {
                Write-Pass ("真实钩子层收到 ctrl-down/ctrl-up 事件，时长 ${duration}ms >= ${longPressMs}ms（longpress=true）")
                $realOk = $true
            } else {
                Write-Fail ("真实钩子事件时长 ${duration}ms 小于 ${longPressMs}ms，longpress 判定失败")
            }
        }
    } catch {
        Write-Fail ('真实钩子注入测试异常: ' + $_.Exception.Message)
    } finally {
        try { [SelectionHook]::SendKey(0xA2, $false) } catch { }
        try { [void][SelectionHook]::DrainEvents() } catch { }
    }

    if (-not $realOk) {
        $reason = if ($injectionWorked) { '钩子回调未送达（沙箱按完整性过滤低完整性进程的钩子）' } else { 'SendInput 被 UIPI 静默丢弃（进程处于低完整性沙箱）' }
        if ($RequireRealHook) {
            Write-Fail ('真实钩子测试失败：' + $reason + '。-RequireRealHook 已开启，判为失败')
        } else {
            Write-Skip ('真实钩子注入：' + $reason + '。在沙箱外的普通 pwsh 中重跑并加 -RequireRealHook 可做强制校验')
        }
    }

    # -- engine level test (works everywhere) -------------------------------
    $engineOk = $true
    try {
        [void][SelectionHook]::DrainEvents()
        [SelectionHook]::TestInjectKey(0xA2, $true)
        Start-Sleep -Milliseconds 700
        [SelectionHook]::TestInjectKey(0xA2, $false)
        Start-Sleep -Milliseconds 120
        $events = @([SelectionHook]::DrainEvents())
        $down = $events | Where-Object { $_.Kind -eq 'key' -and $_.Vk -eq 0xA2 -and $_.Phase -eq 'down' -and -not $_.Injected } | Select-Object -First 1
        $up = $events | Where-Object { $_.Kind -eq 'key' -and $_.Vk -eq 0xA2 -and $_.Phase -eq 'up' -and -not $_.Injected } | Select-Object -First 1
        if (-not $down -or -not $up) {
            $engineOk = $false
            Write-Fail '钩子引擎事件队列未产生 ctrl-down/ctrl-up 事件'
        } else {
            $duration = $up.Ms - $down.Ms
            $longPress = $duration -ge 500
            if (-not $longPress) {
                $engineOk = $false
                Write-Fail ("钩子引擎事件时长 ${duration}ms 未达 longpress 判定")
            } else {
                Write-Pass ("钩子引擎产生 ctrl-down/ctrl-up 事件，时长 ${duration}ms，longpress=true")
            }
        }
        # mouse drag semantics used by the trigger state machine
        [void][SelectionHook]::DrainEvents()
        [SelectionHook]::TestInjectMouse('down', 'L', 100, 100, $false)
        [SelectionHook]::TestInjectMouse('up', 'L', 140, 130, $true)
        Start-Sleep -Milliseconds 60
        $mouse = @([SelectionHook]::DrainEvents()) | Where-Object { $_.Kind -eq 'mouse' -and $_.Phase -eq 'up' }
        if ($mouse -and $mouse[0].Drag -and $mouse[0].Button -eq 'L') {
            Write-Pass '钩子引擎产生鼠标拖拽抬起事件（Drag=true）'
        } else {
            $engineOk = $false
            Write-Fail '钩子引擎未产生鼠标拖拽抬起事件'
        }
    } catch {
        $engineOk = $false
        Write-Fail ('钩子引擎测试异常: ' + $_.Exception.Message)
    } finally {
        try { [SelectionHook]::Uninstall() } catch { }
    }
    if (-not $engineOk) { return }
}

# ---------------------------------------------------------------------------
# 2. Mock host (TcpListener + HTTP/1.1 + SSE)
# ---------------------------------------------------------------------------

$script:MockScript = @'
param($State)

function Read-HttpRequest($Stream) {
    $buffer = New-Object byte[] 16384
    $data = New-Object System.Collections.Generic.List[byte]
    $headerEnd = -1
    while ($true) {
        $n = $Stream.Read($buffer, 0, $buffer.Length)
        if ($n -le 0) { return $null }
        for ($i = 0; $i -lt $n; $i++) { $data.Add($buffer[$i]) }
        $text = [System.Text.Encoding]::ASCII.GetString($data.ToArray())
        $idx = $text.IndexOf([string]::Concat([char]13, [char]10, [char]13, [char]10))
        if ($idx -ge 0) { $headerEnd = $idx; break }
        if ($data.Count -gt 1048576) { return $null }
    }
    $all = [System.Text.Encoding]::ASCII.GetString($data.ToArray())
    $head = $all.Substring(0, $headerEnd)
    $headerBytes = $headerEnd + 4
    $contentLength = 0
    foreach ($line in ($head -split ([string]::Concat([char]13, [char]10)))) {
        if ($line -match '^Content-Length:\s*(\d+)') { $contentLength = [int]$Matches[1] }
    }
    $have = $data.Count - $headerBytes
    while ($have -lt $contentLength) {
        $n = $Stream.Read($buffer, 0, $buffer.Length)
        if ($n -le 0) { break }
        for ($i = 0; $i -lt $n; $i++) { $data.Add($buffer[$i]) }
        $have += $n
    }
    $count = [Math]::Min($contentLength, [Math]::Max(0, $data.Count - $headerBytes))
    $bodyBytes = $data.GetRange($headerBytes, $count).ToArray()
    return @{ Head = $head; Body = [System.Text.Encoding]::UTF8.GetString($bodyBytes) }
}

function Write-HttpJson($Stream, $StatusText, $Text) {
    $body = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $head = "HTTP/1.1 $StatusText`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
    $Stream.Write($hb, 0, $hb.Length)
    $Stream.Write($body, 0, $body.Length)
    $Stream.Flush()
}

function Write-Sse($Stream, $Frame) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Frame)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

function Get-Authorization($Head) {
    foreach ($line in ($Head -split ([string]::Concat([char]13, [char]10)))) {
        if ($line -match '^Authorization:\s*(.+)$') { return $Matches[1].Trim() }
    }
    return ''
}

function Get-PropertyValue($Object, $Name) {
    if ($null -eq $Object) { return '' }
    if ($Object.PSObject.Properties[$Name]) { return [string]$Object.$Name }
    return ''
}

try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $State.listener = $listener
    $State.port = [int]$listener.LocalEndpoint.Port
    $State.ready = $true
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $req = Read-HttpRequest $stream
            if ($null -eq $req) { continue }
            $requestLine = ($req.Head -split ([string]::Concat([char]13, [char]10)))[0]
            $parts = $requestLine -split ' '
            $method = $parts[0]
            $path = $parts[1]
            $auth = Get-Authorization $req.Head
            $State.auth = $auth
            $entry = @{ method = $method; path = $path; auth = $auth; body = $req.Body }
            $State.requests.Add($entry) | Out-Null
            $authOk = ($auth -eq ('Bearer ' + $State.token))
            if (-not $authOk) {
                Write-HttpJson $stream '401 Unauthorized' '{"ok":false,"error":"bad token"}'
                continue
            }
            switch ($path) {
                '/v1/status' {
                    $State.statuses.Add($entry) | Out-Null
                    Write-HttpJson $stream '200 OK' '{"ok":true}'
                }
                '/v1/log' {
                    $State.logs.Add($entry) | Out-Null
                    Write-HttpJson $stream '200 OK' '{"ok":true}'
                }
                '/v1/health' {
                    Write-HttpJson $stream '200 OK' '{"ok":true}'
                }
                '/v1/action' {
                    $State.actions.Add($entry) | Out-Null
                    $head = "HTTP/1.1 200 OK`r`nContent-Type: text/event-stream; charset=utf-8`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
                    $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
                    $stream.Write($hb, 0, $hb.Length)
                    $stream.Flush()
                    $meta1 = @{ label = '翻译' } | ConvertTo-Json -Compress
                    Write-Sse $stream ("event: meta`ndata: " + $meta1 + "`n`n")
                    Start-Sleep -Milliseconds 40
                    $meta2 = @{ provider = 'deepseek-account'; model = 'deepseek-flash'; label = '翻译' } | ConvertTo-Json -Compress
                    Write-Sse $stream ("event: meta`ndata: " + $meta2 + "`n`n")
                    Start-Sleep -Milliseconds 40
                    $mockLines = @('**翻译**（mock）', '', '划词助手已连接宿主。', '', '- 支持流式输出', '- 支持 **粗体** 与 `行内代码`', '', '```', 'const answer = 42', '```', '')
                    $full = ($mockLines -join "`n")
                    $chunkSize = [Math]::Ceiling($full.Length / 10.0)
                    for ($i = 0; $i -lt 10; $i++) {
                        $start = $i * $chunkSize
                        if ($start -ge $full.Length) { break }
                        $len = [Math]::Min($chunkSize, $full.Length - $start)
                        $chunk = $full.Substring($start, $len)
                        $payload = @{ text = $chunk } | ConvertTo-Json -Compress
                        Write-Sse $stream ("event: delta`ndata: " + $payload + "`n`n")
                        Start-Sleep -Milliseconds 30
                    }
                    Write-Sse $stream ("event: done`ndata: {`"reason`":`"stop`"}`n`n")
                    $State.sseDone = $true
                }
                default {
                    Write-HttpJson $stream '404 Not Found' '{"ok":false,"error":"not found"}'
                }
            }
        } catch {
            $State.handlerError = [string]$_.Exception.Message
        } finally {
            try { $client.Close() } catch { }
        }
    }
} catch {
    $State.serverError = [string]$_.Exception.Message
} finally {
    try { $listener.Stop() } catch { }
}
'@

function Start-MockHost {
    $state = [hashtable]::Synchronized(@{
            ready = $false; port = 0; token = $script:Token
            auth = ''; sseDone = $false
            requests = [System.Collections.ArrayList]::new()
            statuses = [System.Collections.ArrayList]::new()
            logs     = [System.Collections.ArrayList]::new()
            actions  = [System.Collections.ArrayList]::new()
            listener = $null
            handlerError = ''
            serverError = ''
        })
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = 'MTA'
    $rs.Open()
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($script:MockScript).AddParameter('State', $state)
    $handle = $ps.BeginInvoke()
    $deadline = [Environment]::TickCount64 + 6000
    while (-not $state.ready -and [Environment]::TickCount64 -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not $state.ready) {
        Write-Fail ('mock 宿主启动失败: ' + $state.serverError)
        try { $ps.Stop() } catch { }
        return $null
    }
    return @{ State = $state; Runspace = $rs; PowerShell = $ps; Handle = $handle }
}

function Stop-MockHost($Mock) {
    if (-not $Mock) { return }
    try { if ($Mock.State.listener) { $Mock.State.listener.Stop() } } catch { }
    try { if (-not $Mock.Handle.IsCompleted) { $Mock.Handle.AsyncWaitHandle.WaitOne(3000) | Out-Null } } catch { }
    try { $Mock.PowerShell.Stop() } catch { }
    try { $Mock.PowerShell.Dispose() } catch { }
    try { $Mock.Runspace.Dispose() } catch { }
}

# ---------------------------------------------------------------------------
# 3. UI self test
# ---------------------------------------------------------------------------

function New-HelperConfigPath([string]$DataDir, [int]$Port, [string]$Token) {
    $config = @{
        version   = 1
        endpoint  = "http://127.0.0.1:$Port"
        token     = $Token
        dataDir   = $DataDir
        logPath   = (Join-Path $DataDir 'helper.log')
        locale    = 'zh'
        trigger   = @{ mode = 'ctrl'; longPressMs = 500; shortcut = 'Ctrl+Alt+Q'; captureDelayMs = 120 }
        toolbar   = @{ compact = $false; maxVisibleActions = 5; scale = 1 }
        result    = @{ followToolbar = $true; rememberSize = $true; autoClose = $false; alwaysOnTop = $true; opacity = 0.96; width = 500; height = 400 }
        appFilter = @{ mode = 'off'; processes = @() }
        actions   = @(
            @{ id = 'translate'; kind = 'llm'; label = '翻译'; icon = 'translate'; enabled = $true; order = 10 },
            @{ id = 'explain'; kind = 'llm'; label = '解释'; icon = 'explain'; enabled = $true; order = 20 },
            @{ id = 'summarize'; kind = 'llm'; label = '总结'; icon = 'summarize'; enabled = $true; order = 30 },
            @{ id = 'search'; kind = 'search'; label = '搜索'; icon = 'search'; enabled = $true; order = 40 },
            @{ id = 'copy'; kind = 'copy'; label = '复制'; icon = 'copy'; enabled = $true; order = 50 },
            @{ id = 'optimize'; kind = 'llm'; label = '润色'; icon = 'optimize'; enabled = $true; order = 60 }
        )
        debug     = $true
    }
    $path = Join-Path $DataDir 'helper-config.json'
    New-Utf8NoBom $path ($config | ConvertTo-Json -Depth 8)
    return $path
}

function Invoke-UiSelfTest {
    Write-Output ''
    Write-Output '== UI self test (helper -SelfTest against mock host) =='
    $dataDir = Join-Path $script:Tmp 'selftest-run'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $configPath = New-HelperConfigPath -DataDir $dataDir -Port $script:Mock.State.port -Token $script:Token
    $previewDir = Join-Path $script:Root 'preview'
    New-Item -ItemType Directory -Force -Path $previewDir | Out-Null
    Remove-Item (Join-Path $previewDir 'toolbar.png') -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $previewDir 'result.png') -ErrorAction SilentlyContinue

    $scriptPath = Join-Path $script:Root 'SelectionAssistant.ps1'
    $args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" -SelfTest -ConfigPath "' + $configPath + '"'
    $child = Start-Child -Arguments $args
    $child.Process.WaitForExit(40000) | Out-Null
    $stdout = ''
    $stderr = ''
    try { $stdout = $child.OutTask.Result } catch { }
    try { $stderr = $child.ErrTask.Result } catch { }
    if (-not $child.Process.HasExited) {
        Write-Fail 'helper -SelfTest 40 秒内未退出'
        try { $child.Process.Kill($true) } catch { }
        return
    }
    Write-Info ('helper -SelfTest exitCode=' + $child.Process.ExitCode)
    if ($stdout.Trim()) { Write-Info ('stdout: ' + $stdout.Trim()) }
    if ($stderr.Trim()) { Write-Info ('stderr: ' + $stderr.Trim()) }
    if ($child.Process.ExitCode -eq 0) {
        Write-Pass 'helper -SelfTest 退出码 0'
    } else {
        Write-Fail ('helper -SelfTest 退出码 ' + $child.Process.ExitCode + '（期望 0）')
    }

    $resultPath = Join-Path $dataDir 'selftest-result.json'
    if (Test-Path -LiteralPath $resultPath) {
        try {
            $result = [System.IO.File]::ReadAllText($resultPath) | ConvertFrom-Json
            Write-Info ('selftest-result: ok=' + $result.ok + ' metas=' + $result.metaCount + ' deltas=' + $result.deltaCount + ' done=' + $result.done + ' pinToggled=' + $result.pinToggled + ' error=' + $result.error)
            if ($result.ok) { Write-Pass 'helper 自测结果 ok=true' } else { Write-Fail 'helper 自测结果 ok=false' }
            if ($result.clicked) { Write-Pass 'helper 自测经工具栏按钮点击触发动作' } else { Write-Fail 'helper 自测未经工具栏按钮点击触发动作' }
            if ($result.done) { Write-Pass 'helper 收到 SSE done 事件' } else { Write-Fail 'helper 未收到 SSE done 事件' }
            if ($result.pinToggled) { Write-Pass 'helper 自测经 pin 按钮切换置顶' } else { Write-Fail 'helper 自测未经 pin 按钮切换置顶' }
            if ([int]$result.metaCount -ge 2) { Write-Pass ('helper 收到 ' + $result.metaCount + ' 条 meta 事件（含两条 meta）') } else { Write-Fail ('meta 事件数 ' + $result.metaCount + ' < 2') }
            if ([int]$result.deltaCount -ge 10) { Write-Pass ('helper 收到 ' + $result.deltaCount + ' 条 delta 事件') } else { Write-Fail ('delta 事件数 ' + $result.deltaCount + ' < 10') }
        } catch {
            Write-Fail ('读取 selftest-result.json 失败: ' + $_.Exception.Message)
        }
    } else {
        Write-Fail '缺少 selftest-result.json'
    }

    foreach ($name in @('toolbar.png', 'result.png')) {
        $path = Join-Path $previewDir $name
        $png = Get-PngSize $path
        if ($png) {
            if ($png.Width -ge 120 -and $png.Height -ge 30 -and $png.Size -gt 2000) {
                Write-Pass ("截图 $name 存在: " + $png.Width + "x" + $png.Height + ", " + $png.Size + " bytes")
            } else {
                Write-Fail ("截图 $name 尺寸异常: $($png.Width)x$($png.Height), $($png.Size) bytes")
            }
        } else {
            Write-Fail ("截图缺失或不是 PNG: $name")
        }
    }

    # helper log must not contain error level lines
    $logPath = Join-Path $dataDir 'helper.log'
    if (Test-Path -LiteralPath $logPath) {
        $logText = [System.IO.File]::ReadAllText($logPath, [System.Text.Encoding]::UTF8)
        $errorLines = @($logText -split "`r?`n" | Where-Object { $_ -match '\[ERROR\] ' })
        if ($errorLines.Count -eq 0) { Write-Pass 'helper.log 无 ERROR 行' } else { Write-Fail ('helper.log 含 ' + $errorLines.Count + ' 条 ERROR 行: ' + $errorLines[0]) }
    } else {
        Write-Fail '缺少 helper.log'
    }
}

# ---------------------------------------------------------------------------
# 4. Lifecycle test: stdin EOF must terminate the helper
# ---------------------------------------------------------------------------

function Invoke-LifecycleTest {
    Write-Output ''
    Write-Output '== lifecycle test (stdin EOF -> helper exit) =='
    $dataDir = Join-Path $script:Tmp 'lifecycle-run'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $configPath = New-HelperConfigPath -DataDir $dataDir -Port $script:Mock.State.port -Token $script:Token
    $scriptPath = Join-Path $script:Root 'SelectionAssistant.ps1'
    $args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" -ConfigPath "' + $configPath + '"'
    $child = Start-Child -Arguments $args -CaptureInput
    try {
        $statusCountBefore = $script:Mock.State.statuses.Count
        $deadline = [Environment]::TickCount64 + 20000
        while ($script:Mock.State.statuses.Count -le $statusCountBefore -and [Environment]::TickCount64 -lt $deadline) {
            Start-Sleep -Milliseconds 200
        }
        if ($script:Mock.State.statuses.Count -le $statusCountBefore) {
            Write-Fail '普通模式 helper 启动后未上报 /v1/status ready'
            return
        }
        Write-Pass '普通模式 helper 启动并上报 /v1/status'

        # preview command through command.json
        $cmdPath = Join-Path $dataDir 'command.json'
        $cmd = @{ id = [guid]::NewGuid().ToString(); type = 'preview'; text = '预览命令测试文字' } | ConvertTo-Json -Compress
        New-Utf8NoBom $cmdPath $cmd
        $logDeadline = [Environment]::TickCount64 + 8000
        $previewSeen = $false
        while ([Environment]::TickCount64 -lt $logDeadline) {
            foreach ($entry in $script:Mock.State.logs) {
                if ($entry.body -match '预览命令已执行') { $previewSeen = $true; break }
            }
            if ($previewSeen) { break }
            Start-Sleep -Milliseconds 250
        }
        if ($previewSeen) { Write-Pass 'command.json preview 命令被执行' } else { Write-Fail 'command.json preview 命令未被执行' }
        Start-Sleep -Milliseconds 400

        $child.Process.StandardInput.Close()
        $exited = $child.Process.WaitForExit(8000)
        if ($exited) {
            Write-Info ('关闭 stdin 后退出码: ' + $child.Process.ExitCode)
            if ($child.Process.ExitCode -eq 0) { Write-Pass 'stdin 关闭后 helper 8 秒内退出，退出码 0' } else { Write-Fail ('stdin 关闭后退出码 ' + $child.Process.ExitCode + '（期望 0）') }
        } else {
            Write-Fail 'stdin 关闭后 helper 8 秒内未退出'
            try { $child.Process.Kill($true) } catch { }
        }
    } finally {
        if (-not $child.Process.HasExited) { try { $child.Process.Kill($true) } catch { } }
        try { [void]$child.OutTask.Result } catch { }
        try { [void]$child.ErrTask.Result } catch { }
    }

    $statePath = Join-Path $dataDir 'helper-state.json'
    if (Test-Path -LiteralPath $statePath) {
        try {
            $state = [System.IO.File]::ReadAllText($statePath) | ConvertFrom-Json
            if ($state.pid -and $state.startedAt) { Write-Pass 'helper-state.json 含 pid/startedAt' } else { Write-Fail 'helper-state.json 缺 pid/startedAt' }
        } catch { Write-Fail ('读取 helper-state.json 失败: ' + $_.Exception.Message) }
    } else {
        Write-Fail '缺少 helper-state.json'
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Write-Output 'dsh-selection-assistant helper selftest'
Write-Output ('root: ' + $script:Root)
Write-Output ('pwsh: ' + $script:Pwsh)
Write-Output ('low-integrity-sandbox: ' + ((whoami /groups | Select-String 'Mandatory Label' | Out-String).Trim()))

if (Test-Path -LiteralPath $script:Tmp) { Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $script:Tmp | Out-Null
$script:Token = -join ((1..64) | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] })
$script:Mock = $null

try {
    Invoke-HookTest

    Write-Output ''
    Write-Output '== mock host =='
    $script:Mock = Start-MockHost
    if (-not $script:Mock) {
        Write-Fail 'mock 宿主不可用，跳过后续测试'
    } else {
        Write-Pass ('mock 宿主监听 127.0.0.1:' + $script:Mock.State.port)
        Invoke-UiSelfTest
        Invoke-LifecycleTest

        # auth + request checks
        $requests = @($script:Mock.State.requests)
        $badAuth = @($requests | Where-Object { $_.auth -ne ('Bearer ' + $script:Token) })
        if ($badAuth.Count -eq 0 -and $requests.Count -gt 0) { Write-Pass ("全部 " + $requests.Count + " 个请求携带正确 Bearer token") } else { Write-Fail ('鉴权失败请求数: ' + $badAuth.Count) }
        $actions = @($script:Mock.State.actions)
        if ($actions.Count -ge 1) {
            $first = $actions[0]
            if ($first.body -match '"actionId":"translate"') { Write-Pass 'SSE 请求 actionId=translate' } else { Write-Fail 'SSE 请求 actionId 不是 translate' }
            if ($first.body -match 'DeepSeek Harness') { Write-Pass 'SSE 请求携带选中文本' } else { Write-Fail 'SSE 请求未携带选中文本' }
        } else {
            Write-Fail 'mock 未收到 /v1/action 请求'
        }
        if ($script:Mock.State.sseDone) { Write-Pass 'mock 已发送完整 SSE 流（meta/delta/done）' } else { Write-Fail 'mock SSE 未完整发送' }
        if ($script:Mock.State.handlerError) { Write-Fail ('mock 处理错误: ' + $script:Mock.State.handlerError) }
    }
} finally {
    Stop-MockHost $script:Mock
    if (-not $KeepTemp) { Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Output ''
Write-Output '----------------------------------------'
Write-Output ('PASS=' + $script:Passes + '  SKIP=' + $script:Skips + '  FAIL=' + $script:Failures.Count)
if ($script:Failures.Count -gt 0) {
    foreach ($f in $script:Failures) { Write-Output ('  FAILED: ' + $f) }
    Write-Output 'SELFTEST: FAIL'
    exit 1
}
Write-Output 'SELFTEST: PASS'
exit 0
