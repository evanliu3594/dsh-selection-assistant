# Ui.ps1 — WPF windows for the selection assistant (toolbar + result window).
# Dot-sourced by SelectionAssistant.ps1 into the script scope, so $script:Cfg,
# $script:UiHooks and $script:UI are shared with the entry script.

$script:UiFont = 'Segoe UI, Microsoft YaHei UI, Microsoft YaHei'
$script:IconFont = 'Segoe MDL2 Assets'
$script:UiBrushCache = @{}
$script:UiHooks = @{
    OnAction            = $null   # param($actionId)
    OnCloseToolbar      = $null   # param()
    OnCopyResult        = $null   # param($ctx)
    OnRegenerate        = $null   # param($ctx)
    OnCloseResult       = $null   # param($ctx)
    OnSaveResultSize    = $null   # param($width,$height) physical frame size
    OnSaveResultPosition = $null  # param($x,$y) physical window origin
    OnToolbarMoved      = $null   # param($x,$y) physical
}
$script:UI = @{
    Theme       = 'light'
    Toolbar     = $null
    Result      = $null
    Results     = [System.Collections.Generic.List[object]]::new()
    Toast       = $null
    LoadAnim    = 0
}

# ---------------------------------------------------------------------------
# Theme / small helpers
# ---------------------------------------------------------------------------

function Get-SystemTheme {
    try {
        $v = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
        if ([int]$v -eq 0) { return 'dark' }
        return 'light'
    } catch { return 'light' }
}

function Get-UiPalette {
    param([string]$Theme = 'light')
    if ($Theme -eq 'dark') {
        return @{
            Bg = '#2B2D31'; Border = '#3F4147'; Text = '#E8E8EA'; Muted = '#9CA3AF'
            Hover = '#37393F'; Accent = '#4D6BFE'; CodeBg = '#1F2023'; Error = '#F87171'
            Shadow = '#000000'; Overlay = '#CC2B2D31'
        }
    }
    return @{
        Bg = '#FFFFFF'; Border = '#E6E6EC'; Text = '#1F2329'; Muted = '#6B7280'
        Hover = '#F2F3F5'; Accent = '#4D6BFE'; CodeBg = '#F5F6F8'; Error = '#D9363E'
        Shadow = '#000000'; Overlay = '#CCFFFFFF'
    }
}

function Get-UiBrush {
    param([string]$Hex)
    if (-not $script:UiBrushCache.ContainsKey($Hex)) {
        $color = [System.Windows.Media.ColorConverter]::ConvertFromString($Hex)
        $script:UiBrushCache[$Hex] = [System.Windows.Media.SolidColorBrush]::new($color)
    }
    return $script:UiBrushCache[$Hex]
}

function ConvertTo-UiThickness {
    param([string]$Value)
    $parts = @($Value -split ',')
    if ($parts.Count -ge 4) {
        return [System.Windows.Thickness]::new([double]$parts[0], [double]$parts[1], [double]$parts[2], [double]$parts[3])
    }
    if ($parts.Count -eq 2) {
        return [System.Windows.Thickness]::new([double]$parts[0], [double]$parts[1], [double]$parts[0], [double]$parts[1])
    }
    return [System.Windows.Thickness]::new([double]$parts[0])
}
function New-UiShadow {
    param([string]$ShadowColor = '#000000')
    $shadow = [System.Windows.Media.Effects.DropShadowEffect]::new()
    $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($ShadowColor)
    $shadow.BlurRadius = 18
    $shadow.ShadowDepth = 2
    $shadow.Direction = 270
    $shadow.Opacity = 0.28
    return $shadow
}

function New-UiText {
    param(
        [string]$Text = '',
        [double]$Size = 13,
        [string]$Color = '#1F2329',
        [switch]$Icon,
        [string]$FontFamily = ''
    )
    $tb = [System.Windows.Controls.TextBlock]::new()
    $tb.Text = $Text
    $tb.FontSize = $Size
    $tb.Foreground = Get-UiBrush $Color
    if ($Icon) { $tb.FontFamily = [System.Windows.Media.FontFamily]::new($script:IconFont) }
    elseif ($FontFamily) { $tb.FontFamily = [System.Windows.Media.FontFamily]::new($FontFamily) }
    else { $tb.FontFamily = [System.Windows.Media.FontFamily]::new($script:UiFont) }
    [System.Windows.Media.TextOptions]::SetTextFormattingMode($tb, [System.Windows.Media.TextFormattingMode]::Display)
    return $tb
}

function Get-ActionIconGlyph {
    param([string]$Icon)
    switch ($Icon) {
        'translate' { return [char]0xE8C1 }
        'explain' { return [char]0xEA80 }
        'summarize' { return [char]0xE9D5 }
        'search' { return [char]0xE721 }
        'copy' { return [char]0xE8C8 }
        'optimize' { return [char]0xE70F }
        'sparkle' { return [char]0xE735 }
        default { return [char]0xE735 }
    }
}

function Get-UiLocale {
    if ($script:Cfg -and $script:Cfg.locale -eq 'en') { return 'en' }
    return 'zh'
}

function Get-ActionLabel {
    param($Action)
    if ($null -eq $Action) { return '' }
    if ($Action -is [hashtable]) {
        if ($Action.ContainsKey('label') -and $Action['label']) { return [string]$Action['label'] }
        if ($Action.ContainsKey('labelZh') -and $Action['labelZh']) { return [string]$Action['labelZh'] }
        if ($Action.ContainsKey('id')) { return [string]$Action['id'] }
        return ''
    }
    if ($Action.PSObject.Properties['label'] -and $Action.label) { return [string]$Action.label }
    if ($Action.PSObject.Properties['labelZh'] -and $Action.labelZh) { return [string]$Action.labelZh }
    return [string]$Action.id
}

# A hover-highlighted clickable border. The click target lives in Tag.
# WPF event handlers run on the dispatcher after this function has returned.
# A PowerShell script block does not close over function-local variables, so a
# handler must never reference them. Bind click handlers at the call site and
# use only $script: variables, $sender properties and script-scope functions.
function New-UiHoverButton {
    param(
        $Content,
        [double]$Radius = 7,
        [string]$Padding = '8,3,8,3',
        [string]$Background = 'Transparent',
        [string]$HoverColor = '#F2F3F5',
        [string]$Tag = '',
        [string]$Tooltip = ''
    )
    $b = [System.Windows.Controls.Border]::new()
    $b.CornerRadius = [System.Windows.CornerRadius]::new($Radius)
    $b.Padding = ConvertTo-UiThickness $Padding
    $b.Background = Get-UiBrush $Background
    $b.Tag = $Tag
    $b.Child = $Content
    $b.VerticalAlignment = 'Center'
    if ($Tooltip) {
        $b.ToolTip = $Tooltip
        [System.Windows.Controls.ToolTipService]::SetInitialShowDelay($b, 200)
        [System.Windows.Controls.ToolTipService]::SetShowDuration($b, 6000)
    }
    $b.Add_MouseEnter({
            param($sender, $e)
            $sender.Background = Get-UiBrush $script:UI.ToolbarHover
        })
    $b.Add_MouseLeave({
            param($sender, $e)
            $sender.Background = Get-UiBrush 'Transparent'
        })
    return $b
}

function New-UiDragDots {
    param([double]$Scale = 1, [string]$Color = '#6B7280')
    $panel = [System.Windows.Controls.StackPanel]::new()
    $panel.Orientation = 'Vertical'
    $panel.VerticalAlignment = 'Center'
    $brush = Get-UiBrush $Color
    for ($row = 0; $row -lt 3; $row++) {
        $line = [System.Windows.Controls.StackPanel]::new()
        $line.Orientation = 'Horizontal'
        $line.HorizontalAlignment = 'Center'
        for ($col = 0; $col -lt 2; $col++) {
            $dot = [System.Windows.Shapes.Ellipse]::new()
            $dot.Width = [Math]::Round(2.2 * $Scale, 1)
            $dot.Height = [Math]::Round(2.2 * $Scale, 1)
            $dot.Fill = $brush
            $dot.Margin = [System.Windows.Thickness]::new(1.2 * $Scale, 1.2 * $Scale, 1.2 * $Scale, 1.2 * $Scale)
            $line.Children.Add($dot) | Out-Null
        }
        $panel.Children.Add($line) | Out-Null
    }
    return $panel
}

# ---------------------------------------------------------------------------
# Toolbar window
# ---------------------------------------------------------------------------

function Get-ToolbarActions {
    $all = @()
    if ($script:Cfg -and $script:Cfg.actions) {
        $all = @($script:Cfg.actions | Where-Object { $_.enabled } | Sort-Object { if ($_.PSObject.Properties['order']) { [double]$_.order } else { 0 } })
    }
    $maxVisible = 5
    if ($script:Cfg.toolbar -and $script:Cfg.toolbar.maxVisibleActions) { $maxVisible = [int]$script:Cfg.toolbar.maxVisibleActions }
    if ($maxVisible -lt 1) { $maxVisible = 1 }
    $visible = @($all | Select-Object -First $maxVisible)
    $overflow = @($all | Select-Object -Skip $maxVisible)
    return @{ All = $all; Visible = $visible; Overflow = $overflow }
}

function New-ToolbarWindow {
    $theme = Get-SystemTheme
    $script:UI.Theme = $theme
    $pal = Get-UiPalette $theme
    $scale = 1.0
    $compact = $false
    if ($script:Cfg.toolbar) {
        if ($script:Cfg.toolbar.scale) { $scale = [double]$script:Cfg.toolbar.scale }
        if ($script:Cfg.toolbar.compact) { $compact = $true }
    }
    if ($scale -lt 0.85) { $scale = 0.85 }
    if ($scale -gt 1.25) { $scale = 1.25 }
    $script:UI.ToolbarHover = $pal.Hover

    $height = if ($compact) { 34 } else { 40 }
    $win = [System.Windows.Window]::new()
    $win.WindowStyle = 'None'
    $win.AllowsTransparency = $true
    $win.Background = [System.Windows.Media.Brushes]::Transparent
    $win.Topmost = $true
    $win.ShowActivated = $false
    $win.ShowInTaskbar = $false
    $win.ResizeMode = 'NoResize'
    $win.SizeToContent = 'Width'
    $win.Height = ($height * $scale) + 24
    $win.WindowStartupLocation = 'Manual'
    $win.Left = -4000
    $win.Top = -4000
    $win.Opacity = 0.0

    $border = [System.Windows.Controls.Border]::new()
    $border.Margin = [System.Windows.Thickness]::new(12)
    $border.CornerRadius = [System.Windows.CornerRadius]::new(10)
    $border.BorderThickness = [System.Windows.Thickness]::new(1)
    $border.Background = Get-UiBrush $pal.Bg
    $border.BorderBrush = Get-UiBrush $pal.Border
    $border.Effect = New-UiShadow $pal.Shadow

    $stack = [System.Windows.Controls.StackPanel]::new()
    $stack.Orientation = 'Horizontal'
    $stack.VerticalAlignment = 'Center'
    $stack.Margin = [System.Windows.Thickness]::new((6 * $scale), 0, (6 * $scale), 0)

    # -- drag handle ---------------------------------------------------------
    $handle = [System.Windows.Controls.Border]::new()
    $handle.Padding = [System.Windows.Thickness]::new((5 * $scale), 0, (5 * $scale), 0)
    $handle.Cursor = [System.Windows.Input.Cursors]::SizeAll
    $handle.Background = Get-UiBrush 'Transparent'
    $handle.CornerRadius = [System.Windows.CornerRadius]::new(5)
    $handle.Child = New-UiDragDots -Scale $scale -Color $pal.Muted
    $handle.ToolTip = '拖动工具栏'
    [System.Windows.Controls.ToolTipService]::SetInitialShowDelay($handle, 300)
    $script:UI.ToolbarDrag = @{ Active = $false; CursorX = 0; CursorY = 0; WinX = 0; WinY = 0 }
    $handle.Add_MouseLeftButtonDown({
            param($sender, $e)
            $pos = [ScreenUtil]::GetCursorPos()
            $rect = [ForegroundInfo]::GetWindowRect($script:UI.Toolbar.Hwnd)
            $script:UI.ToolbarDrag.Active = $true
            $script:UI.ToolbarDrag.CursorX = $pos[0]
            $script:UI.ToolbarDrag.CursorY = $pos[1]
            $script:UI.ToolbarDrag.WinX = $rect[0]
            $script:UI.ToolbarDrag.WinY = $rect[1]
            [void]$sender.CaptureMouse()
            $e.Handled = $true
        })
    $handle.Add_MouseMove({
            param($sender, $e)
            if (-not $script:UI.ToolbarDrag.Active) { return }
            $pos = [ScreenUtil]::GetCursorPos()
            $nx = $script:UI.ToolbarDrag.WinX + ($pos[0] - $script:UI.ToolbarDrag.CursorX)
            $ny = $script:UI.ToolbarDrag.WinY + ($pos[1] - $script:UI.ToolbarDrag.CursorY)
            [WindowUtil]::MoveWindow($script:UI.Toolbar.Hwnd, $nx, $ny, $true)
            $script:UI.Toolbar.LastX = $nx
            $script:UI.Toolbar.LastY = $ny
        })
    $handle.Add_MouseLeftButtonUp({
            param($sender, $e)
            $script:UI.ToolbarDrag.Active = $false
            [void]$sender.ReleaseMouseCapture()
            if ($script:UiHooks.OnToolbarMoved) { & $script:UiHooks.OnToolbarMoved $script:UI.Toolbar.LastX $script:UI.Toolbar.LastY }
            $e.Handled = $true
        })
    $stack.Children.Add($handle) | Out-Null

    # -- action buttons ------------------------------------------------------
    $actions = Get-ToolbarActions
    $iconSize = 14 * $scale
    $labelSize = 12 * $scale
    foreach ($act in $actions.Visible) {
        $id = [string]$act.id
        $row = [System.Windows.Controls.StackPanel]::new()
        $row.Orientation = 'Horizontal'
        $row.VerticalAlignment = 'Center'
        $glyph = New-UiText -Text (Get-ActionIconGlyph $act.icon) -Size $iconSize -Color $pal.Text -Icon
        $glyph.VerticalAlignment = 'Center'
        $row.Children.Add($glyph) | Out-Null
        if (-not $compact) {
            $lbl = New-UiText -Text (Get-ActionLabel $act) -Size $labelSize -Color $pal.Text
            $lbl.Margin = [System.Windows.Thickness]::new((4 * $scale), 0, 0, 0)
            $lbl.VerticalAlignment = 'Center'
            $row.Children.Add($lbl) | Out-Null
        }
        $btn = New-UiHoverButton -Content $row -Radius 7 -Padding ("{0},{1},{0},{1}" -f (7 * $scale), (4 * $scale)) -HoverColor $pal.Hover -Tag $id -Tooltip (Get-ActionLabel $act)
        $btn.Add_MouseLeftButtonUp({
                param($sender, $e)
                $e.Handled = $true
                Invoke-UiActionClick $sender.Tag
            })
        $stack.Children.Add($btn) | Out-Null
    }

    $hasOverflow = $actions.Overflow.Count -gt 0
    if ($hasOverflow) {
        $sep = [System.Windows.Controls.Border]::new()
        $sep.Width = 1
        $sep.Height = 16 * $scale
        $sep.Margin = [System.Windows.Thickness]::new((5 * $scale), 0, (5 * $scale), 0)
        $sep.Background = Get-UiBrush $pal.Border
        $sep.VerticalAlignment = 'Center'
        $stack.Children.Add($sep) | Out-Null

        $more = New-UiText -Text ([char]0xE712) -Size $iconSize -Color $pal.Text -Icon
        $more.VerticalAlignment = 'Center'
        $moreBtn = New-UiHoverButton -Content $more -Radius 7 -Padding ("{0},{1},{0},{1}" -f (7 * $scale), (4 * $scale)) -HoverColor $pal.Hover -Tag 'overflow' -Tooltip '更多动作'
        $moreBtn.Add_MouseLeftButtonUp({
                param($sender, $e)
                $e.Handled = $true
                Show-ToolbarOverflowMenu $sender
            })
        $stack.Children.Add($moreBtn) | Out-Null
    }

    # -- close button --------------------------------------------------------
    $closeGlyph = New-UiText -Text ([char]0xE711) -Size $iconSize -Color $pal.Muted -Icon
    $closeGlyph.VerticalAlignment = 'Center'
    $closeBtn = New-UiHoverButton -Content $closeGlyph -Radius 7 -Padding ("{0},{1},{0},{1}" -f (6 * $scale), (4 * $scale)) -HoverColor $pal.Hover -Tag 'close' -Tooltip '关闭'
    $closeBtn.Add_MouseLeftButtonUp({
            param($sender, $e)
            $e.Handled = $true
            if ($script:UiHooks.OnCloseToolbar) { & $script:UiHooks.OnCloseToolbar }
        })
    $stack.Children.Add($closeBtn) | Out-Null

    $border.Child = $stack
    $win.Content = $border

    $win.Add_SourceInitialized({
            param($sender, $e)
            $script:UI.Toolbar.Hwnd = ([System.Windows.Interop.WindowInteropHelper]::new($script:UI.Toolbar.Window)).Handle
            [WindowUtil]::MakeNoActivate($script:UI.Toolbar.Hwnd)
        })

    $script:UI.Toolbar = @{
        Window    = $win
        Hwnd      = [IntPtr]::Zero
        Scale     = $scale
        Compact   = $compact
        Theme     = $theme
        Palette   = $pal
        Actions   = $actions
        LastX     = 0
        LastY     = 0
        Visible   = $false
        Text      = ''
        App       = ''
    }
    return $win
}

function Show-ToolbarOverflowMenu {
    param($Anchor)
    $pal = $script:UI.Toolbar.Palette
    $cm = [System.Windows.Controls.ContextMenu]::new()
    $cm.Background = Get-UiBrush $pal.Bg
    $cm.Foreground = Get-UiBrush $pal.Text
    $cm.BorderBrush = Get-UiBrush $pal.Border
    $cm.FontFamily = [System.Windows.Media.FontFamily]::new($script:UiFont)
    $cm.FontSize = 12
    $cm.PlacementTarget = $Anchor
    $cm.Placement = 'Bottom'
    foreach ($act in $script:UI.Toolbar.Actions.Overflow) {
        $mi = [System.Windows.Controls.MenuItem]::new()
        $panel = [System.Windows.Controls.StackPanel]::new()
        $panel.Orientation = 'Horizontal'
        $g = New-UiText -Text (Get-ActionIconGlyph $act.icon) -Size 13 -Color $pal.Text -Icon
        $g.Margin = [System.Windows.Thickness]::new(0, 0, 8, 0)
        $g.VerticalAlignment = 'Center'
        $panel.Children.Add($g) | Out-Null
        $t = New-UiText -Text (Get-ActionLabel $act) -Size 12 -Color $pal.Text
        $t.VerticalAlignment = 'Center'
        $panel.Children.Add($t) | Out-Null
        $mi.Header = $panel
        $mi.Tag = [string]$act.id
        $mi.Add_Click({
                param($sender, $e)
                Invoke-UiActionClick $sender.Tag
            })
        $cm.Items.Add($mi) | Out-Null
    }
    $cm.IsOpen = $true
}

function Invoke-UiActionClick {
    param([string]$ActionId)
    if (-not $ActionId) { return }
    if ($script:UiHooks.OnAction) { & $script:UiHooks.OnAction $ActionId }
}

function Show-ToolbarAt {
    param([int]$CursorX, [int]$CursorY)
    Close-ToolbarWindow
    $win = New-ToolbarWindow
    $script:UI.Toolbar.Visible = $true
    $win.Show()
    $win.UpdateLayout()
    [WindowUtil]::MakeNoActivate($script:UI.Toolbar.Hwnd)
    $rect = [ForegroundInfo]::GetWindowRect($script:UI.Toolbar.Hwnd)
    $w = $rect[2] - $rect[0]
    $h = $rect[3] - $rect[1]
    if ($w -le 0 -or $h -le 0) { $w = 240; $h = 64 }
    $work = [ScreenUtil]::GetWorkArea($CursorX, $CursorY)
    $x = $CursorX + 8
    $y = $CursorY + 12
    if (($x + $w) -gt $work[2]) { $x = $work[2] - $w - 8 }
    if ($x -lt $work[0]) { $x = $work[0] + 8 }
    if (($y + $h) -gt $work[3]) { $y = $CursorY - $h - 12 }
    if ($y -lt $work[1]) { $y = $work[1] + 8 }
    [WindowUtil]::MoveWindow($script:UI.Toolbar.Hwnd, $x, $y, $true)
    $script:UI.Toolbar.LastX = $x
    $script:UI.Toolbar.LastY = $y
    $win.Opacity = 1.0
}

function Get-ToolbarRect {
    if (-not $script:UI.Toolbar -or $script:UI.Toolbar.Hwnd -eq [IntPtr]::Zero) { return $null }
    return [ForegroundInfo]::GetWindowRect($script:UI.Toolbar.Hwnd)
}

function Get-ToolbarVisible { return [bool]($script:UI.Toolbar -and $script:UI.Toolbar.Visible) }

# Self-test hook: return the toolbar action Border whose Tag is the action id.
function Get-ToolbarActionButton {
    param([string]$ActionId)
    if (-not $script:UI.Toolbar -or -not $script:UI.Toolbar.Window) { return $null }
    $content = $script:UI.Toolbar.Window.Content
    if (-not $content -or -not $content.Child) { return $null }
    foreach ($child in @($content.Child.Children)) {
        if ($child -is [System.Windows.Controls.Border] -and [string]$child.Tag -eq $ActionId) { return $child }
    }
    return $null
}

function Close-ToolbarWindow {
    if (-not $script:UI.Toolbar) { return }
    $tb = $script:UI.Toolbar
    $script:UI.Toolbar = $null
    try { $tb.Window.Close() } catch { }
}

# ---------------------------------------------------------------------------
# Toast (used by the local copy action)
# ---------------------------------------------------------------------------

function Show-UiToast {
    param([string]$Text, [int]$X, [int]$Y)
    Close-UiToast
    $theme = Get-SystemTheme
    $pal = Get-UiPalette $theme
    $win = [System.Windows.Window]::new()
    $win.WindowStyle = 'None'
    $win.AllowsTransparency = $true
    $win.Background = [System.Windows.Media.Brushes]::Transparent
    $win.Topmost = $true
    $win.ShowActivated = $false
    $win.ShowInTaskbar = $false
    $win.SizeToContent = 'WidthAndHeight'
    $win.WindowStartupLocation = 'Manual'
    $win.Left = -4000
    $win.Top = -4000
    $win.Opacity = 0.0
    $border = [System.Windows.Controls.Border]::new()
    $border.Margin = [System.Windows.Thickness]::new(10)
    $border.CornerRadius = [System.Windows.CornerRadius]::new(8)
    $border.Padding = [System.Windows.Thickness]::new(14, 8, 14, 8)
    $border.Background = Get-UiBrush $pal.Bg
    $border.BorderThickness = [System.Windows.Thickness]::new(1)
    $border.BorderBrush = Get-UiBrush $pal.Border
    $border.Effect = New-UiShadow $pal.Shadow
    $border.Child = New-UiText -Text $Text -Size 13 -Color $pal.Text
    $win.Content = $border
    $script:UI.Toast = @{ Window = $win; Hwnd = [IntPtr]::Zero }
    $win.Add_SourceInitialized({
            param($sender, $e)
            $script:UI.Toast.Hwnd = ([System.Windows.Interop.WindowInteropHelper]::new($script:UI.Toast.Window)).Handle
            [WindowUtil]::MakeNoActivate($script:UI.Toast.Hwnd)
        })
    $win.Show()
    $win.UpdateLayout()
    [WindowUtil]::MakeNoActivate($script:UI.Toast.Hwnd)
    $rect = [ForegroundInfo]::GetWindowRect($script:UI.Toast.Hwnd)
    $w = $rect[2] - $rect[0]
    $h = $rect[3] - $rect[1]
    $work = [ScreenUtil]::GetWorkArea($X, $Y)
    $tx = $X + 8
    $ty = $Y + 34
    if (($tx + $w) -gt $work[2]) { $tx = $work[2] - $w - 8 }
    if (($ty + $h) -gt $work[3]) { $ty = $Y - $h - 8 }
    [WindowUtil]::MoveWindow($script:UI.Toast.Hwnd, $tx, $ty, $true)
    $win.Opacity = 0.97
    $script:UI.Toast.CloseAt = [Environment]::TickCount64 + 1100
}

function Close-UiToast {
    if (-not $script:UI.Toast) { return }
    $toast = $script:UI.Toast
    $script:UI.Toast = $null
    try { $toast.Window.Close() } catch { }
}

# ---------------------------------------------------------------------------
# Result window
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Result window list / context helpers
#
# $script:UI.Results holds every open result window context. A context is a
# hashtable that owns its window widgets plus Stream, Pinned, SourceText, App
# and Drag state. $script:UI.Result points at the current window.
# WPF handlers run on the dispatcher after the creating function has returned,
# so a handler resolves its own window from $sender and only touches $script:
# state, script functions, $sender and $e. PowerShell script blocks do not
# close over function locals.
# ---------------------------------------------------------------------------

function Get-ResultWindowFromSender {
    param($Sender)
    if ($null -eq $Sender) { return $null }
    if ($Sender -is [System.Windows.Window]) { return $Sender }
    try { return [System.Windows.Window]::GetWindow($Sender) } catch { return $null }
}

function Find-ResultContextByWindow {
    param($Window)
    if ($null -eq $Window) { return $null }
    if (-not $script:UI -or $null -eq $script:UI.Results) { return $null }
    foreach ($ctx in @($script:UI.Results)) {
        if ($null -eq $ctx) { continue }
        if ($ctx.Window -and [object]::ReferenceEquals($ctx.Window, $Window)) { return $ctx }
    }
    return $null
}

function Get-ResultContextFromSender {
    param($Sender)
    $win = Get-ResultWindowFromSender $Sender
    if ($null -eq $win) { return $null }
    return Find-ResultContextByWindow $win
}

function Test-ResultContextVisible {
    param($Context)
    if ($null -eq $Context -or $null -eq $Context.Window) { return $false }
    try { return [bool]$Context.Window.IsVisible } catch { return $false }
}

function Get-LastVisibleResultContext {
    param([switch]$PinnedOnly)
    if (-not $script:UI -or $null -eq $script:UI.Results) { return $null }
    $found = $null
    foreach ($ctx in @($script:UI.Results)) {
        if (-not (Test-ResultContextVisible $ctx)) { continue }
        if ($PinnedOnly -and -not $ctx.Pinned) { continue }
        $found = $ctx
    }
    return $found
}

function Get-ResultFallbackContext {
    $fallback = Get-LastVisibleResultContext -PinnedOnly
    if (-not $fallback) { $fallback = Get-LastVisibleResultContext }
    return $fallback
}

function Get-FocusedResultContext {
    $handle = [IntPtr]::Zero
    try { $handle = [ForegroundInfo]::GetForegroundWindow() } catch { }
    if ($handle -eq [IntPtr]::Zero) { return $null }
    foreach ($ctx in @($script:UI.Results)) {
        if ($null -eq $ctx) { continue }
        if ($ctx.Hwnd -and $ctx.Hwnd -eq $handle) { return $ctx }
    }
    return $null
}

function Add-ResultContext {
    param($Context)
    if ($null -eq $Context) { return }
    if ($null -eq $script:UI.Results) { $script:UI.Results = [System.Collections.Generic.List[object]]::new() }
    $script:UI.Results.Add($Context) | Out-Null
    $script:UI.Result = $Context
}

function Remove-ResultContext {
    param($Context)
    if ($null -eq $Context -or $null -eq $script:UI.Results) { return }
    $script:UI.Results.Remove($Context) | Out-Null
}

function Get-ClampedResultOrigin {
    param([int]$X, [int]$Y, [int]$Width, [int]$Height)
    $result = @{ X = $X; Y = $Y }
    $work = $null
    try { $work = [ScreenUtil]::GetWorkArea($X, $Y) } catch { }
    if (-not $work -or $work.Count -lt 4) { return $result }
    $minX = [int]$work[0] + 8
    $minY = [int]$work[1] + 8
    $maxX = [int]$work[2] - $Width - 8
    $maxY = [int]$work[3] - $Height - 8
    if ($maxX -lt $minX) { $maxX = $minX }
    if ($maxY -lt $minY) { $maxY = $minY }
    if ($X -lt $minX) { $X = $minX }
    if ($X -gt $maxX) { $X = $maxX }
    if ($Y -lt $minY) { $Y = $minY }
    if ($Y -gt $maxY) { $Y = $maxY }
    $result.X = $X
    $result.Y = $Y
    return $result
}

# Computed before any result window is closed: the current window frame (or the
# saved helper-state geometry when no window is visible) decides the placement.
# Width/Height are content sizes in WPF DIP, X/Y are physical screen pixels.
function Get-ResultPlacement {
    $cfgResult = $null
    if ($script:Cfg) { $cfgResult = $script:Cfg.result }
    $defaultWidth = 500.0
    $defaultHeight = 400.0
    if ($cfgResult) {
        if ($cfgResult.width) { $defaultWidth = [double]$cfgResult.width }
        if ($cfgResult.height) { $defaultHeight = [double]$cfgResult.height }
    }
    if ($defaultWidth -lt 300) { $defaultWidth = 300 }
    if ($defaultHeight -lt 200) { $defaultHeight = 200 }

    $current = $script:UI.Result
    if ($current -and -not (Test-ResultContextVisible $current)) { $current = $null }
    if (-not $current) { $current = Get-LastVisibleResultContext -PinnedOnly }

    if ($current) {
        $contentWidth = 0.0
        $contentHeight = 0.0
        try {
            $contentWidth = [double]$current.Window.Width - 24
            $contentHeight = [double]$current.Window.Height - 24
        } catch { }
        if ([double]::IsNaN($contentWidth) -or $contentWidth -lt 100) { $contentWidth = $defaultWidth }
        if ([double]::IsNaN($contentHeight) -or $contentHeight -lt 100) { $contentHeight = $defaultHeight }
        $rect = $null
        if ($current.Hwnd -and $current.Hwnd -ne [IntPtr]::Zero) {
            try { $rect = [ForegroundInfo]::GetWindowRect($current.Hwnd) } catch { }
        }
        if ($rect -and $rect.Count -ge 4) {
            $frameWidth = [int]$rect[2] - [int]$rect[0]
            $frameHeight = [int]$rect[3] - [int]$rect[1]
            if ($frameWidth -le 24 -or $frameHeight -le 24) {
                $scale = 1.0
                try { $scale = [ScreenUtil]::GetScaleAt([int]$rect[0], [int]$rect[1]) } catch { }
                if ($scale -le 0) { $scale = 1.0 }
                $frameWidth = [int](($contentWidth + 24) * $scale)
                $frameHeight = [int](($contentHeight + 24) * $scale)
            }
            if ($current.Pinned) {
                $origin = Get-ClampedResultOrigin -X ([int]$rect[0] - 24) -Y ([int]$rect[1] + 24) -Width $frameWidth -Height $frameHeight
                return @{ Width = $contentWidth; Height = $contentHeight; X = [int]$origin.X; Y = [int]$origin.Y; Source = 'stack'; Pinned = $true }
            }
            return @{ Width = $contentWidth; Height = $contentHeight; X = [int]$rect[0]; Y = [int]$rect[1]; Source = 'same'; Pinned = $false }
        }
    }

    $width = [double]$defaultWidth
    $height = [double]$defaultHeight
    if ($cfgResult -and [bool]$cfgResult.rememberSize -and $script:State) {
        if ($null -ne $script:State['resultWidth']) { $width = [double]$script:State['resultWidth'] }
        if ($null -ne $script:State['resultHeight']) { $height = [double]$script:State['resultHeight'] }
    }
    if ($width -lt 300) { $width = 300 }
    if ($width -gt 900) { $width = 900 }
    if ($height -lt 200) { $height = 200 }
    if ($height -gt 900) { $height = 900 }
    $savedX = $null
    $savedY = $null
    if ($script:State) {
        if ($null -ne $script:State['resultX']) { $savedX = [int]$script:State['resultX'] }
        if ($null -ne $script:State['resultY']) { $savedY = [int]$script:State['resultY'] }
    }
    if ($null -ne $savedX -and $null -ne $savedY) {
        $scale = 1.0
        try { $scale = [ScreenUtil]::GetScaleAt($savedX, $savedY) } catch { }
        if ($scale -le 0) { $scale = 1.0 }
        $frameWidth = [int](($width + 24) * $scale)
        $frameHeight = [int](($height + 24) * $scale)
        $origin = Get-ClampedResultOrigin -X $savedX -Y $savedY -Width $frameWidth -Height $frameHeight
        return @{ Width = $width; Height = $height; X = [int]$origin.X; Y = [int]$origin.Y; Source = 'saved'; Pinned = $false }
    }
    return @{ Width = $width; Height = $height; X = $null; Y = $null; Source = 'default'; Pinned = $false }
}

# Called when the user finishes dragging the title bar: persist the origin.
function OnSaveResultPosition {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if (-not $Context -or -not $Context.Window) { return }
    if ($null -eq $Context.Hwnd -or $Context.Hwnd -eq [IntPtr]::Zero) { return }
    $rect = $null
    try { $rect = [ForegroundInfo]::GetWindowRect($Context.Hwnd) } catch { }
    if (-not $rect -or $rect.Count -lt 4) { return }
    if ($script:UiHooks.OnSaveResultPosition) {
        & $script:UiHooks.OnSaveResultPosition ([int]$rect[0]) ([int]$rect[1])
    }
}


function Initialize-ResultWindow {
    param([string]$ActionLabel, [string]$ActionId, $Placement = $null)
    $theme = Get-SystemTheme
    $pal = Get-UiPalette $theme
    $script:UI.ToolbarHover = $pal.Hover
    $script:UI.Theme = $theme

    $cfgResult = $script:Cfg.result
    $width = 500.0
    $height = 400.0
    if ($Placement -and $null -ne $Placement['Width']) { $width = [double]$Placement['Width'] }
    elseif ($cfgResult -and $cfgResult.width) { $width = [double]$cfgResult.width }
    if ($Placement -and $null -ne $Placement['Height']) { $height = [double]$Placement['Height'] }
    elseif ($cfgResult -and $cfgResult.height) { $height = [double]$cfgResult.height }
    if ($width -lt 300) { $width = 300 }
    if ($height -lt 200) { $height = 200 }
    if (-not $Placement) {
        if ($width -gt 900) { $width = 900 }
        if ($height -gt 900) { $height = 900 }
    }
    $opacity = 0.96
    $alwaysTop = $true
    if ($cfgResult) {
        if ($null -ne $cfgResult.opacity) { $opacity = [double]$cfgResult.opacity }
        if ($null -ne $cfgResult.alwaysOnTop) { $alwaysTop = [bool]$cfgResult.alwaysOnTop }
    }
    if ($opacity -lt 0.2) { $opacity = 0.2 }
    if ($opacity -gt 1) { $opacity = 1 }

    $win = [System.Windows.Window]::new()
    $win.WindowStyle = 'None'
    $win.AllowsTransparency = $true
    $win.Background = [System.Windows.Media.Brushes]::Transparent
    $win.Topmost = $alwaysTop
    $win.ShowActivated = $true
    $win.ShowInTaskbar = $false
    $win.ResizeMode = 'NoResize'
    $win.WindowStartupLocation = 'Manual'
    $win.Width = $width + 24
    $win.Height = $height + 24
    $win.Left = -4000
    $win.Top = -4000
    $win.Opacity = 0.0

    $outer = [System.Windows.Controls.Border]::new()
    $outer.Margin = [System.Windows.Thickness]::new(12)
    $outer.CornerRadius = [System.Windows.CornerRadius]::new(10)
    $outer.BorderThickness = [System.Windows.Thickness]::new(1)
    $outer.Background = Get-UiBrush $pal.Bg
    $outer.BorderBrush = Get-UiBrush $pal.Border
    $outer.Effect = New-UiShadow $pal.Shadow

    $grid = [System.Windows.Controls.Grid]::new()
    $grid.RowDefinitions.Add([System.Windows.Controls.RowDefinition]::new())
    $grid.RowDefinitions[0].Height = [System.Windows.GridLength]::new(38)
    $grid.RowDefinitions.Add([System.Windows.Controls.RowDefinition]::new())
    $grid.RowDefinitions[1].Height = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $grid.RowDefinitions.Add([System.Windows.Controls.RowDefinition]::new())
    $grid.RowDefinitions[2].Height = [System.Windows.GridLength]::new(42)

    # -- title row ----------------------------------------------------------
    $title = [System.Windows.Controls.Border]::new()
    $title.Background = Get-UiBrush 'Transparent'
    $title.BorderThickness = [System.Windows.Thickness]::new(0, 0, 0, 1)
    $title.BorderBrush = Get-UiBrush $pal.Border
    $title.Cursor = [System.Windows.Input.Cursors]::SizeAll
    [System.Windows.Controls.Grid]::SetRow($title, 0)
    $titleGrid = [System.Windows.Controls.Grid]::new()
    $titleGrid.ColumnDefinitions.Add([System.Windows.Controls.ColumnDefinition]::new())
    $titleGrid.ColumnDefinitions[0].Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $titleGrid.ColumnDefinitions.Add([System.Windows.Controls.ColumnDefinition]::new())
    $titleGrid.ColumnDefinitions[1].Width = [System.Windows.GridLength]::new(0, [System.Windows.GridUnitType]::Auto)

    $titleStack = [System.Windows.Controls.StackPanel]::new()
    $titleStack.Orientation = 'Horizontal'
    $titleStack.VerticalAlignment = 'Center'
    $titleStack.Margin = [System.Windows.Thickness]::new(14, 0, 0, 0)
    $titleLabel = New-UiText -Text $ActionLabel -Size 13 -Color $pal.Text
    $titleLabel.FontWeight = [System.Windows.FontWeights]::SemiBold
    $titleLabel.VerticalAlignment = 'Center'
    $titleStack.Children.Add($titleLabel) | Out-Null
    $modelTag = New-UiText -Text '' -Size 11 -Color $pal.Muted
    $modelTag.Margin = [System.Windows.Thickness]::new(10, 0, 0, 0)
    $modelTag.VerticalAlignment = 'Center'
    $modelTag.Visibility = 'Collapsed'
    $titleStack.Children.Add($modelTag) | Out-Null
    $titleGrid.Children.Add($titleStack) | Out-Null

    # -- title actions: pin button + close button ---------------------------
    # Bind handlers at the call site; they reference only $script: state,
    # $sender and $e (the closure-defect rule).
    $titleActions = [System.Windows.Controls.StackPanel]::new()
    $titleActions.Orientation = 'Horizontal'
    $titleActions.VerticalAlignment = 'Center'
    $titleActions.HorizontalAlignment = 'Right'
    $titleActions.Margin = [System.Windows.Thickness]::new(0, 0, 6, 0)
    [System.Windows.Controls.Grid]::SetColumn($titleActions, 1)

    $titlePinGlyph = New-UiText -Text ([char]0xE718) -Size 12 -Color $pal.Muted -Icon
    $titlePinGlyph.VerticalAlignment = 'Center'
    $titlePin = New-UiHoverButton -Content $titlePinGlyph -Radius 6 -Padding '8,4,8,4' -HoverColor $pal.Hover -Tag 'result-pin' -Tooltip '钉在最前'
    $titlePin.Margin = [System.Windows.Thickness]::new(0, 0, 2, 0)
    $titlePin.VerticalAlignment = 'Center'
    # The title bar starts a window drag on MouseLeftButtonDown. Mark the pin
    # click handled so pressing it never turns into a drag.
    $titlePin.Add_MouseLeftButtonDown({
            param($sender, $e)
            $e.Handled = $true
        })
    $titlePin.Add_MouseLeftButtonUp({
            param($sender, $e)
            $e.Handled = $true
            $ctx = Get-ResultContextFromSender $sender
            if ($ctx) { Toggle-ResultPinned -Context $ctx }
        })
    $titleActions.Children.Add($titlePin) | Out-Null

    $titleCloseGlyph = New-UiText -Text ([char]0xE711) -Size 12 -Color $pal.Muted -Icon
    $titleCloseGlyph.VerticalAlignment = 'Center'
    $titleClose = New-UiHoverButton -Content $titleCloseGlyph -Radius 6 -Padding '8,4,8,4' -HoverColor $pal.Hover -Tag 'result-close' -Tooltip '关闭 (Esc)'
    # Mark the close press handled too, so the title-bar drag never starts.
    $titleClose.Add_MouseLeftButtonDown({
            param($sender, $e)
            $e.Handled = $true
        })
    $titleClose.Add_MouseLeftButtonUp({
            param($sender, $e)
            $e.Handled = $true
            $ctx = Get-ResultContextFromSender $sender
            if ($ctx -and $script:UiHooks.OnCloseResult) { & $script:UiHooks.OnCloseResult $ctx }
        })
    $titleClose.VerticalAlignment = 'Center'
    $titleActions.Children.Add($titleClose) | Out-Null
    $titleGrid.Children.Add($titleActions) | Out-Null
    $title.Child = $titleGrid
    $grid.Children.Add($title) | Out-Null

    $title.Add_MouseLeftButtonDown({
            param($sender, $e)
            $ctx = Get-ResultContextFromSender $sender
            if (-not $ctx) { return }
            $pos = [ScreenUtil]::GetCursorPos()
            $rect = [ForegroundInfo]::GetWindowRect($ctx.Hwnd)
            $ctx.Drag.Active = $true
            $ctx.Drag.CursorX = $pos[0]
            $ctx.Drag.CursorY = $pos[1]
            $ctx.Drag.WinX = $rect[0]
            $ctx.Drag.WinY = $rect[1]
            [void]$sender.CaptureMouse()
            $e.Handled = $true
        })
    $title.Add_MouseMove({
            param($sender, $e)
            $ctx = Get-ResultContextFromSender $sender
            if (-not $ctx -or -not $ctx.Drag.Active) { return }
            $pos = [ScreenUtil]::GetCursorPos()
            $nx = $ctx.Drag.WinX + ($pos[0] - $ctx.Drag.CursorX)
            $ny = $ctx.Drag.WinY + ($pos[1] - $ctx.Drag.CursorY)
            [WindowUtil]::MoveWindow($ctx.Hwnd, $nx, $ny, [bool]$ctx.Window.Topmost)
        })
    $title.Add_MouseLeftButtonUp({
            param($sender, $e)
            $ctx = Get-ResultContextFromSender $sender
            if (-not $ctx) { return }
            if ($ctx.Drag.Active) {
                $ctx.Drag.Active = $false
                OnSaveResultPosition -Context $ctx
            }
            try { [void]$sender.ReleaseMouseCapture() } catch { }
            $e.Handled = $true
        })


    # -- content row --------------------------------------------------------
    $content = [System.Windows.Controls.Grid]::new()
    [System.Windows.Controls.Grid]::SetRow($content, 1)
    $rtb = [System.Windows.Controls.RichTextBox]::new()
    $rtb.IsReadOnly = $true
    $rtb.IsDocumentEnabled = $true
    $rtb.BorderThickness = [System.Windows.Thickness]::new(0)
    $rtb.Background = [System.Windows.Media.Brushes]::Transparent
    $rtb.Foreground = Get-UiBrush $pal.Text
    $rtb.FontFamily = [System.Windows.Media.FontFamily]::new($script:UiFont)
    $rtb.FontSize = 13
    $rtb.Padding = [System.Windows.Thickness]::new(14, 8, 10, 8)
    $rtb.VerticalScrollBarVisibility = 'Auto'
    $rtb.HorizontalScrollBarVisibility = 'Disabled'
    $docs = [System.Windows.Documents.FlowDocument]::new()
    $docs.FontFamily = [System.Windows.Media.FontFamily]::new($script:UiFont)
    $docs.FontSize = 13
    $docs.Foreground = Get-UiBrush $pal.Text
    $docs.PagePadding = [System.Windows.Thickness]::new(0)
    $rtb.Document = $docs
    $content.Children.Add($rtb) | Out-Null

    $loading = [System.Windows.Controls.Border]::new()
    $loading.Background = Get-UiBrush $pal.Bg
    $loadingStack = [System.Windows.Controls.StackPanel]::new()
    $loadingStack.HorizontalAlignment = 'Center'
    $loadingStack.VerticalAlignment = 'Center'
    $loadingText = New-UiText -Text '正在生成' -Size 13 -Color $pal.Muted
    $loadingText.HorizontalAlignment = 'Center'
    $loadingStack.Children.Add($loadingText) | Out-Null
    $bar = [System.Windows.Controls.ProgressBar]::new()
    $bar.IsIndeterminate = $true
    $bar.Height = 3
    $bar.Width = 160
    $bar.Margin = [System.Windows.Thickness]::new(0, 10, 0, 0)
    $bar.Foreground = Get-UiBrush $pal.Accent
    $bar.Background = Get-UiBrush 'Transparent'
    $bar.BorderThickness = [System.Windows.Thickness]::new(0)
    $loadingStack.Children.Add($bar) | Out-Null
    $loading.Child = $loadingStack
    $content.Children.Add($loading) | Out-Null
    $grid.Children.Add($content) | Out-Null

    # -- bottom row ---------------------------------------------------------
    $bottom = [System.Windows.Controls.Border]::new()
    $bottom.BorderThickness = [System.Windows.Thickness]::new(0, 1, 0, 0)
    $bottom.BorderBrush = Get-UiBrush $pal.Border
    [System.Windows.Controls.Grid]::SetRow($bottom, 2)
    $bottomGrid = [System.Windows.Controls.Grid]::new()
    $bottomGrid.ColumnDefinitions.Add([System.Windows.Controls.ColumnDefinition]::new())
    $bottomGrid.ColumnDefinitions[0].Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $bottomGrid.ColumnDefinitions.Add([System.Windows.Controls.ColumnDefinition]::new())
    $bottomGrid.ColumnDefinitions[1].Width = [System.Windows.GridLength]::new(0, [System.Windows.GridUnitType]::Auto)
    $statusText = New-UiText -Text '' -Size 11 -Color $pal.Muted
    $statusText.Margin = [System.Windows.Thickness]::new(14, 0, 0, 0)
    $statusText.VerticalAlignment = 'Center'
    $bottomGrid.Children.Add($statusText) | Out-Null
    $buttons = [System.Windows.Controls.StackPanel]::new()
    $buttons.Orientation = 'Horizontal'
    $buttons.HorizontalAlignment = 'Right'
    $buttons.VerticalAlignment = 'Center'
    $buttons.Margin = [System.Windows.Thickness]::new(0, 0, 8, 0)
    [System.Windows.Controls.Grid]::SetColumn($buttons, 1)

    $btnCopy = New-UiHoverButton -Radius 6 -Padding '10,4,10,4' -HoverColor $pal.Hover -Tag 'copy' -Tooltip '复制 (C)' -Content (
        (New-UiActionRow -Glyph ([char]0xE8C8) -Label '复制' -Palette $pal -Size 12))
    $btnCopy.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $ctx = Get-ResultContextFromSender $sender; if ($ctx -and $script:UiHooks.OnCopyResult) { & $script:UiHooks.OnCopyResult $ctx } })
    $buttons.Children.Add($btnCopy) | Out-Null
    $btnRegen = New-UiHoverButton -Radius 6 -Padding '10,4,10,4' -HoverColor $pal.Hover -Tag 'regen' -Tooltip '重新生成 (R)' -Content (
        (New-UiActionRow -Glyph ([char]0xE72C) -Label '重新生成' -Palette $pal -Size 12))
    $btnRegen.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $ctx = Get-ResultContextFromSender $sender; if ($ctx -and $script:UiHooks.OnRegenerate) { & $script:UiHooks.OnRegenerate $ctx } })
    $buttons.Children.Add($btnRegen) | Out-Null
    $btnClose = New-UiHoverButton -Radius 6 -Padding '10,4,10,4' -HoverColor $pal.Hover -Tag 'close' -Tooltip '关闭 (Esc)' -Content (
        (New-UiActionRow -Glyph ([char]0xE711) -Label '关闭' -Palette $pal -Size 12))
    $btnClose.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $ctx = Get-ResultContextFromSender $sender; if ($ctx -and $script:UiHooks.OnCloseResult) { & $script:UiHooks.OnCloseResult $ctx } })
    $buttons.Children.Add($btnClose) | Out-Null
    $bottomGrid.Children.Add($buttons) | Out-Null
    $bottom.Child = $bottomGrid
    $grid.Children.Add($bottom) | Out-Null

    $outer.Child = $grid

    # -- resize thumb -------------------------------------------------------
    $thumb = [System.Windows.Controls.Primitives.Thumb]::new()
    $thumb.Width = 16
    $thumb.Height = 16
    $thumb.HorizontalAlignment = 'Right'
    $thumb.VerticalAlignment = 'Bottom'
    $thumb.Cursor = [System.Windows.Input.Cursors]::SizeNWSE
    $thumb.Background = [System.Windows.Media.Brushes]::Transparent
    $thumb.Opacity = 0.0
    $thumb.Margin = [System.Windows.Thickness]::new(0, 0, 3, 3)
    $thumb.Add_DragDelta({
            param($sender, $e)
            $ctx = Get-ResultContextFromSender $sender
            if (-not $ctx -or -not $ctx.Window) { return }
            $newW = [Math]::Max(324, $ctx.Window.Width + $e.HorizontalChange)
            $newH = [Math]::Max(224, $ctx.Window.Height + $e.VerticalChange)
            $ctx.Window.Width = $newW
            $ctx.Window.Height = $newH
            $ctx.Resized = $true
        })
    $thumb.Add_DragCompleted({
            param($sender, $e)
            $ctx = Get-ResultContextFromSender $sender
            if (-not $ctx -or -not $ctx.Resized) { return }
            if ($script:UiHooks.OnSaveResultSize) {
                & $script:UiHooks.OnSaveResultSize ($ctx.Window.Width) ($ctx.Window.Height)
            }
        })
    $content.Children.Add($thumb) | Out-Null
    $gripHint = New-UiText -Text ([char]0x25E2) -Size 10 -Color $pal.Muted -FontFamily 'Segoe UI Symbol'
    $gripHint.HorizontalAlignment = 'Right'
    $gripHint.VerticalAlignment = 'Bottom'
    $gripHint.Margin = [System.Windows.Thickness]::new(0, 0, 5, 3)
    $gripHint.IsHitTestVisible = $false
    $gripHint.Opacity = 0.55
    $content.Children.Add($gripHint) | Out-Null

    $win.Content = $outer
    $win.Add_Activated({
            param($sender, $e)
            $ctx = Get-ResultContextFromSender $sender
            if ($ctx) { $script:UI.Result = $ctx }
        })
    $win.Add_SourceInitialized({
            param($sender, $e)
            $ctx = Get-ResultContextFromSender $sender
            if (-not $ctx) { return }
            $ctx.Hwnd = ([System.Windows.Interop.WindowInteropHelper]::new($ctx.Window)).Handle
            [WindowUtil]::MakeToolWindow($ctx.Hwnd)
        })
    $win.Add_Deactivated({
            param($sender, $e)
            $ctx = Get-ResultContextFromSender $sender
            if (-not $ctx) { return }
            if ($ctx.Pinned) { return }
            if (-not $script:Cfg -or -not $script:Cfg.result.autoClose) { return }
            if ($script:SuppressAutoClose) { return }
            if ($script:UiHooks.OnCloseResult) { & $script:UiHooks.OnCloseResult $ctx }
        })
    # Safety net for a window closed by the system (Alt+F4, session end):
    # Close-ResultWindow already removes the context before it calls Close().
    $win.Add_Closed({
            param($sender, $e)
            $ctx = Get-ResultContextFromSender $sender
            if (-not $ctx) { return }
            try { if ($ctx.Stream) { $ctx.Stream.Cancel() } } catch { }
            $ctx.Stream = $null
            Remove-ResultContext $ctx
            if ($script:UI.Result -eq $ctx) { $script:UI.Result = Get-ResultFallbackContext }
        })
    $win.Add_PreviewKeyDown({
            param($sender, $e)
            try {
                $ctx = Get-ResultContextFromSender $sender
                if (-not $ctx) { return }
                if ($e.Key -eq [System.Windows.Input.Key]::Escape) {
                    $e.Handled = $true
                    if ($script:UiHooks.OnCloseResult) { & $script:UiHooks.OnCloseResult $ctx }
                    return
                }
                if ([System.Windows.Input.Keyboard]::Modifiers -ne [System.Windows.Input.ModifierKeys]::None) { return }
                if ($e.Key -eq [System.Windows.Input.Key]::C) {
                    $e.Handled = $true
                    if ($script:UiHooks.OnCopyResult) { & $script:UiHooks.OnCopyResult $ctx }
                } elseif ($e.Key -eq [System.Windows.Input.Key]::R) {
                    $e.Handled = $true
                    if ($script:UiHooks.OnRegenerate) { & $script:UiHooks.OnRegenerate $ctx }
                }
            } catch { }
        })

    $res = @{
        Window         = $win
        Hwnd           = [IntPtr]::Zero
        RichBox        = $rtb
        Loading        = $loading
        LoadingText    = $loadingText
        TitleLabel     = $titleLabel
        ModelTag       = $modelTag
        StatusText     = $statusText
        Palette        = $pal
        Theme          = $theme
        ActionId       = $ActionId
        ActionLabel    = $ActionLabel
        Text           = ''
        LoadingOn      = $true
        Dirty          = $false
        HasDelta       = $false
        Done           = $false
        Error          = ''
        Resized        = $false
        ModelLabel     = ''
        Provider       = ''
        Model          = ''
        Pinned         = $false
        DefaultTopmost = $alwaysTop
        PinButton      = $titlePin
        PinGlyph       = $titlePinGlyph
        Stream         = $null
        SourceText     = ''
        App            = ''
        Drag           = @{ Active = $false; CursorX = 0; CursorY = 0; WinX = 0; WinY = 0 }
    }
    Add-ResultContext $res
    $script:UI.Result = $res
    return $win
}


function New-UiActionRow {
    param([char]$Glyph, [string]$Label, $Palette, [double]$Size = 12)
    $row = [System.Windows.Controls.StackPanel]::new()
    $row.Orientation = 'Horizontal'
    $row.VerticalAlignment = 'Center'
    $g = New-UiText -Text $Glyph -Size $Size -Color $Palette.Text -Icon
    $g.VerticalAlignment = 'Center'
    $row.Children.Add($g) | Out-Null
    if ($Label) {
        $t = New-UiText -Text $Label -Size $Size -Color $Palette.Text
        $t.Margin = [System.Windows.Thickness]::new(4, 0, 0, 0)
        $t.VerticalAlignment = 'Center'
        $row.Children.Add($t) | Out-Null
    }
    return $row
}

function Show-ResultWindow {
    param([string]$ActionLabel, [string]$ActionId, $Placement = $null)
    if ($null -eq $Placement) { $Placement = Get-ResultPlacement }
    $win = Initialize-ResultWindow -ActionLabel $ActionLabel -ActionId $ActionId -Placement $Placement
    $script:SuppressAutoClose = $false
    $win.Show()
    $win.UpdateLayout()
    $ctx = $script:UI.Result
    if (-not $ctx) { return $null }
    [WindowUtil]::MakeToolWindow($ctx.Hwnd)
    try { $win.Activate() } catch { }
    if ($Placement -and $null -ne $Placement['X'] -and $null -ne $Placement['Y']) {
        Set-ResultWindowPosition -Context $ctx -X ([int]$Placement['X']) -Y ([int]$Placement['Y'])
    } else {
        Set-ResultWindowPosition -Context $ctx
    }
    $win.Opacity = 0.0
    $op = 0.96
    if ($script:Cfg.result -and $null -ne $script:Cfg.result.opacity) { $op = [double]$script:Cfg.result.opacity }
    $win.Opacity = $op
    return $ctx
}

function Set-ResultWindowPosition {
    param($Context = $null, $X = $null, $Y = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if (-not $Context -or -not $Context.Window) { return }
    $win = $Context.Window
    $hwnd = $Context.Hwnd
    if ($null -eq $hwnd -or $hwnd -eq [IntPtr]::Zero) { return }
    if ($null -ne $X -and $null -ne $Y) {
        [WindowUtil]::MoveWindow($hwnd, [int]$X, [int]$Y, [bool]$win.Topmost)
        return
    }
    $rect = [ForegroundInfo]::GetWindowRect($hwnd)
    $w = $rect[2] - $rect[0]
    $h = $rect[3] - $rect[1]
    if ($w -le 0 -or $h -le 0) { return }
    $follow = $true
    if ($script:Cfg.result -and $null -ne $script:Cfg.result.followToolbar) { $follow = [bool]$script:Cfg.result.followToolbar }
    $tbRect = Get-ToolbarRect
    $cursor = [ScreenUtil]::GetCursorPos()
    $work = [ScreenUtil]::GetWorkArea($cursor[0], $cursor[1])
    if ($follow -and $tbRect) {
        $work = [ScreenUtil]::GetWorkArea($tbRect[0] + 10, $tbRect[1] + 10)
        $x = $tbRect[0]
        $y = $tbRect[3] + 6
        if (($y + $h) -gt $work[3]) {
            $y = $tbRect[1] - 6 - $h
            if ($y -lt $work[1]) { $y = $work[1] + 8 }
        }
    } else {
        $x = $work[0] + [int](($work[2] - $work[0] - $w) / 2)
        $y = $work[1] + [int](($work[3] - $work[1] - $h) / 2)
    }
    if (($x + $w) -gt $work[2]) { $x = $work[2] - $w - 8 }
    if ($x -lt $work[0]) { $x = $work[0] + 8 }
    if (($y + $h) -gt $work[3]) { $y = $work[3] - $h - 8 }
    if ($y -lt $work[1]) { $y = $work[1] + 8 }
    [WindowUtil]::MoveWindow($hwnd, $x, $y, [bool]$win.Topmost)
}

function Get-ResultRect {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if (-not $Context) { return $null }
    if ($null -eq $Context.Hwnd -or $Context.Hwnd -eq [IntPtr]::Zero) { return $null }
    return [ForegroundInfo]::GetWindowRect($Context.Hwnd)
}

function Get-ResultVisible {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    return [bool](Test-ResultContextVisible $Context)
}

# Pinned result window: stay visible and topmost until the user unpins it.
# Topmost falls back to the configured result.alwaysOnTop value when unpinned.
function Set-ResultPinned {
    param([bool]$Pinned, $Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if (-not $Context -or -not $Context.Window) { return }
    $Context.Pinned = $Pinned
    if ($Pinned) {
        $Context.Window.Topmost = $true
        if ($Context.PinGlyph) { $Context.PinGlyph.Text = [char]0xE840; $Context.PinGlyph.Foreground = Get-UiBrush $Context.Palette.Accent }
        if ($Context.PinButton) { $Context.PinButton.ToolTip = '取消钉住' }
    } else {
        $Context.Window.Topmost = [bool]$Context.DefaultTopmost
        if ($Context.PinGlyph) { $Context.PinGlyph.Text = [char]0xE718; $Context.PinGlyph.Foreground = Get-UiBrush $Context.Palette.Muted }
        if ($Context.PinButton) { $Context.PinButton.ToolTip = '钉在最前' }
    }
}

function Toggle-ResultPinned {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if (-not $Context) { return }
    Set-ResultPinned -Pinned (-not [bool]$Context.Pinned) -Context $Context
}

function Get-ResultPinned {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if (-not $Context) { return $false }
    return [bool]$Context.Pinned
}

function Close-ResultWindow {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if ($null -eq $Context) { return }
    try { if ($Context.Stream) { $Context.Stream.Cancel() } } catch { }
    $Context.Stream = $null
    Remove-ResultContext $Context
    if ($script:UI.Result -eq $Context) { $script:UI.Result = Get-ResultFallbackContext }
    try { if ($Context.Window) { $Context.Window.Close() } } catch { }
}


function Set-ResultMeta {
    param([string]$Provider, [string]$Model, [string]$Label)
    if (-not $script:UI.Result) { return }
    if ($Label) { $script:UI.Result.TitleLabel.Text = $Label; $script:UI.Result.ActionLabel = $Label }
    if ($Provider) { $script:UI.Result.Provider = $Provider }
    if ($Model) { $script:UI.Result.Model = $Model }
    $tag = ''
    if ($script:UI.Result.Model) { $tag = $script:UI.Result.Model }
    elseif ($script:UI.Result.Provider) { $tag = $script:UI.Result.Provider }
    if ($tag) {
        $script:UI.Result.ModelTag.Text = $tag
        $script:UI.Result.ModelTag.Visibility = 'Visible'
    }
}

function Set-ResultLoading {
    param([bool]$On)
    if (-not $script:UI.Result) { return }
    $script:UI.Result.LoadingOn = $On
    if ($On) { $script:UI.Result.Loading.Visibility = 'Visible' }
    else { $script:UI.Result.Loading.Visibility = 'Collapsed' }
}

function Add-ResultDelta {
    param([string]$Text)
    if (-not $script:UI.Result) { return }
    if ($script:UI.Result.LoadingOn) { Set-ResultLoading $false }
    $script:UI.Result.HasDelta = $true
    $script:UI.Result.Text = $script:UI.Result.Text + $Text
    $script:UI.Result.Dirty = $true
}

function Set-ResultStatus {
    param([string]$Text, [string]$Color = '')
    if (-not $script:UI.Result) { return }
    $script:UI.Result.StatusText.Text = $Text
    if ($Color) { $script:UI.Result.StatusText.Foreground = Get-UiBrush $Color }
}

function Set-ResultDone {
    if (-not $script:UI.Result) { return }
    $script:UI.Result.Done = $true
    Set-ResultLoading $false
    Set-ResultStatus '完成'
}

function Set-ResultError {
    param([string]$Message)
    if (-not $script:UI.Result) { return }
    $script:UI.Result.Error = $Message
    $script:UI.Result.Done = $true
    Set-ResultLoading $false
    $pal = $script:UI.Result.Palette
    $doc = [System.Windows.Documents.FlowDocument]::new()
    $doc.FontFamily = [System.Windows.Media.FontFamily]::new($script:UiFont)
    $doc.FontSize = 13
    $doc.PagePadding = [System.Windows.Thickness]::new(0)
    $p = [System.Windows.Documents.Paragraph]::new()
    $p.Margin = [System.Windows.Thickness]::new(0)
    $run = [System.Windows.Documents.Run]::new($Message)
    $run.Foreground = Get-UiBrush $pal.Error
    $p.Inlines.Add($run)
    $doc.Blocks.Add($p) | Out-Null
    $script:UI.Result.RichBox.Document = $doc
    Set-ResultStatus '出错' $pal.Error
}

function Set-ResultText {
    param([string]$Text)
    if (-not $script:UI.Result) { return }
    $script:UI.Result.Text = $Text
    $script:UI.Result.Dirty = $true
}

function Update-ResultRender {
    if (-not $script:UI -or $null -eq $script:UI.Results) { return }
    foreach ($ctx in @($script:UI.Results)) {
        if ($null -eq $ctx -or -not $ctx.Dirty) { continue }
        $ctx.Dirty = $false
        try {
            $doc = Convert-MarkdownToFlowDocument -Text ([string]$ctx.Text) -Palette $ctx.Palette
            $ctx.RichBox.Document = $doc
            try { $ctx.RichBox.ScrollToEnd() } catch { }
            if ($ctx.LoadingOn) {
                $ctx.LoadingOn = $false
                if ($ctx.Loading) { $ctx.Loading.Visibility = 'Collapsed' }
            }
        } catch { }
    }
}


# Lightweight markdown subset: **bold**, `inline code`, fenced code blocks, "- " lists.
function Convert-MarkdownToFlowDocument {
    param([string]$Text, $Palette)
    $doc = [System.Windows.Documents.FlowDocument]::new()
    $doc.FontFamily = [System.Windows.Media.FontFamily]::new($script:UiFont)
    $doc.FontSize = 13
    $doc.Foreground = Get-UiBrush $Palette.Text
    $doc.PagePadding = [System.Windows.Thickness]::new(0)
    $normalized = ($Text -replace "`r`n", "`n") -replace "`r", "`n"
    $lines = $normalized -split "`n"
    $i = 0
    $currentList = $null
    $codeLines = New-Object System.Collections.Generic.List[string]
    $inCode = $false

    function Flush-List {
        if ($script:MarkListRef) { $script:MarkListRef = $null }
    }

    foreach ($line in $lines) {
        if ($line -match '^\s*```') {
            if ($inCode) {
                Add-CodeBlockToDoc -Doc $doc -Lines $codeLines -Palette $Palette
                $codeLines.Clear()
                $inCode = $false
            } else {
                $inCode = $true
            }
            continue
        }
        if ($inCode) { $codeLines.Add($line); continue }
        if ($line -match '^\s*[-*]\s+(.+)$') {
            $itemText = $Matches[1]
            if (-not $script:MarkListRef) {
                $list = [System.Windows.Documents.List]::new()
                $list.MarkerStyle = [System.Windows.TextMarkerStyle]::Disc
                $list.Margin = [System.Windows.Thickness]::new(18, 2, 0, 6)
                $list.Padding = [System.Windows.Thickness]::new(0)
                $doc.Blocks.Add($list) | Out-Null
                $script:MarkListRef = $list
            }
            $li = [System.Windows.Documents.ListItem]::new()
            $itemPara = [System.Windows.Documents.Paragraph]::new()
            $itemPara.Margin = [System.Windows.Thickness]::new(0, 1, 0, 1)
            Add-InlineRuns -Paragraph $itemPara -Text $itemText -Palette $Palette
            $li.Blocks.Add($itemPara) | Out-Null
            $script:MarkListRef.ListItems.Add($li) | Out-Null
            continue
        }
        $script:MarkListRef = $null
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $p = [System.Windows.Documents.Paragraph]::new()
        $p.Margin = [System.Windows.Thickness]::new(0, 0, 0, 8)
        $p.LineHeight = 21
        Add-InlineRuns -Paragraph $p -Text $line -Palette $Palette
        $doc.Blocks.Add($p) | Out-Null
    }
    if ($inCode -and $codeLines.Count -gt 0) {
        Add-CodeBlockToDoc -Doc $doc -Lines $codeLines -Palette $Palette
    }
    $script:MarkListRef = $null
    return $doc
}

function Add-CodeBlockToDoc {
    param($Doc, $Lines, $Palette)
    $text = ($Lines -join "`n")
    $p = [System.Windows.Documents.Paragraph]::new()
    $p.Background = Get-UiBrush $Palette.CodeBg
    $p.FontFamily = [System.Windows.Media.FontFamily]::new('Consolas, Cascadia Mono, Courier New')
    $p.FontSize = 12
    $p.Margin = [System.Windows.Thickness]::new(0, 2, 0, 8)
    $p.Padding = [System.Windows.Thickness]::new(8, 6, 8, 6)
    $p.Inlines.Add([System.Windows.Documents.Run]::new($text)) | Out-Null
    $Doc.Blocks.Add($p) | Out-Null
}

function Add-InlineRuns {
    param($Paragraph, [string]$Text, $Palette)
    $pattern = '(\*\*(.+?)\*\*|`([^`]+)`)'
    $pos = 0
    foreach ($m in [regex]::Matches($Text, $pattern)) {
        if ($m.Index -gt $pos) {
            $Paragraph.Inlines.Add([System.Windows.Documents.Run]::new($Text.Substring($pos, $m.Index - $pos))) | Out-Null
        }
        if ($m.Value.StartsWith('**')) {
            $run = [System.Windows.Documents.Run]::new($m.Groups[2].Value)
            $run.FontWeight = [System.Windows.FontWeights]::Bold
            $Paragraph.Inlines.Add($run) | Out-Null
        } else {
            $run = [System.Windows.Documents.Run]::new($m.Groups[3].Value)
            $run.FontFamily = [System.Windows.Media.FontFamily]::new('Consolas, Cascadia Mono, Courier New')
            $run.FontSize = 12
            $run.Background = Get-UiBrush $Palette.CodeBg
            $run.Foreground = Get-UiBrush $Palette.Accent
            $Paragraph.Inlines.Add($run) | Out-Null
        }
        $pos = $m.Index + $m.Length
    }
    if ($pos -lt $Text.Length) {
        $Paragraph.Inlines.Add([System.Windows.Documents.Run]::new($Text.Substring($pos))) | Out-Null
    }
}

function Get-ResultText {
    param($Context = $null)
    if ($null -eq $Context) { $Context = $script:UI.Result }
    if ($null -eq $Context) { return '' }
    return [string]$Context.Text
}

function Update-LoadingAnimation {
    if (-not $script:UI -or $null -eq $script:UI.Results) { return }
    $hasLoading = $false
    foreach ($ctx in @($script:UI.Results)) {
        if ($ctx -and $ctx.LoadingOn) { $hasLoading = $true; break }
    }
    if (-not $hasLoading) { return }
    $script:UI.LoadAnim = ($script:UI.LoadAnim + 1) % 4
    $dots = '.' * $script:UI.LoadAnim
    foreach ($ctx in @($script:UI.Results)) {
        if ($null -eq $ctx -or -not $ctx.LoadingOn) { continue }
        if ($ctx.LoadingText) { $ctx.LoadingText.Text = '正在生成' + $dots }
    }
}

function Close-AllResultWindows {
    $contexts = @()
    if ($script:UI.Results) { $contexts = @($script:UI.Results) }
    if ($script:UI.Results) { $script:UI.Results.Clear() }
    $script:UI.Result = $null
    foreach ($ctx in $contexts) {
        if ($null -eq $ctx) { continue }
        try { if ($ctx.Stream) { $ctx.Stream.Cancel() } } catch { }
        $ctx.Stream = $null
        try { if ($ctx.Window) { $ctx.Window.Close() } } catch { }
    }
}

function Close-AllUi {
    Close-ToolbarWindow
    Close-UiToast
    Close-AllResultWindows
}
