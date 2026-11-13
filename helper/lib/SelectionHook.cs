// dsh-selection-assistant helper — native layer.
// Add-Type on Windows PowerShell 5.1 compiles as C# 5: keep new syntax C# 5 compatible.
//
// This file is compiled in memory by SelectionAssistant.ps1 through Add-Type.
// It owns everything that is easier in C# than in PowerShell:
//   * low level mouse / keyboard hooks (WH_MOUSE_LL + WH_KEYBOARD_LL)
//     running on a dedicated thread with its own message pump, callbacks only
//     enqueue events; the WPF dispatcher drains the queue every 40 ms.
//   * synthetic input (SendInput) for Ctrl+C capture and for the self test.
//   * clipboard save / read / restore with retries (Ctrl+C is the only capture
//     path, so the user clipboard must survive a failed capture).
//   * foreground process name (application filter) and foreground window id.
//   * cursor position, window rectangle, monitor work area and DPI scale.
//   * Win32 window style helpers used by the WPF windows (tool window,
//     no-activate, topmost, move without activation).
//   * HTTP client: SSE action stream (POST /v1/action) plus fire-and-forget
//     status / log posts.
//   * stdin EOF watcher: the host closes stdin when it exits, the helper must
//     then exit too.
//
// No JSON is produced or parsed here; PowerShell owns JSON.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// ---------------------------------------------------------------------------
// Event model
// ---------------------------------------------------------------------------

/// <summary>One input event produced by the low level hooks.</summary>
public sealed class HookEvent {
    /// <summary>"mouse" or "key".</summary>
    public string Kind = "";
    /// <summary>"down" or "up".</summary>
    public string Phase = "";
    /// <summary>"L", "R", "M" for mouse events; empty for keys.</summary>
    public string Button = "";
    /// <summary>Cursor position (physical pixels) for mouse events.</summary>
    public int X;
    public int Y;
    /// <summary>True when a left drag moved more than 4 physical pixels before the button was released.</summary>
    public bool Drag;
    /// <summary>Position where the left button went down (mouse events).</summary>
    public int DownX;
    public int DownY;
    /// <summary>Windows virtual key code for key events.</summary>
    public int Vk;
    public bool Ctrl;
    public bool Alt;
    public bool Shift;
    public bool Win;
    /// <summary>True for events produced by SendInput instead of the physical keyboard/mouse.</summary>
    public bool Injected;
    /// <summary>True when the event came from this helper's own SendInput; such events must not trigger the assistant.</summary>
    public bool OwnInjected;
    /// <summary>Clock.NowMs at the moment the hook saw the event.</summary>
    public long Ms;
}

/// <summary>Clipboard content captured before a simulated Ctrl+C.</summary>
public sealed class ClipboardSnapshot {
    public bool Saved;
    public bool HasText;
    public string Text = "";
    public bool HasDib;
    public byte[] Dib;
}

/// <summary>One server-sent event line, straight to PowerShell.</summary>
public sealed class SseEvent {
    /// <summary>meta / delta / done / error / transport-error / stream-end / cancelled.</summary>
    public string Kind = "";
    /// <summary>Raw JSON payload. Empty for transport errors, message goes to Kind.</summary>
    public string Data = "";
}

// ---------------------------------------------------------------------------
// Native methods
// ---------------------------------------------------------------------------

internal static class Native {
    internal const int WH_MOUSE_LL = 14;
    internal const int WH_KEYBOARD_LL = 13;
    internal const int WM_QUIT = 0x0012;
    internal const int PM_NOREMOVE = 0x0000;
    internal const int WM_KEYDOWN = 0x0100;
    internal const int WM_KEYUP = 0x0101;
    internal const int WM_SYSKEYDOWN = 0x0104;
    internal const int WM_SYSKEYUP = 0x0105;
    internal const int WM_MOUSEMOVE = 0x0200;
    internal const int WM_LBUTTONDOWN = 0x0201;
    internal const int WM_LBUTTONUP = 0x0202;
    internal const int WM_RBUTTONDOWN = 0x0204;
    internal const int WM_RBUTTONUP = 0x0205;
    internal const int WM_MBUTTONDOWN = 0x0207;
    internal const int WM_MBUTTONUP = 0x0208;
    internal const int LLKHF_INJECTED = 0x10;
    internal const int LLMHF_INJECTED = 0x01;

    internal const uint WM_COPY = 0x0301;

    /// <summary>dwExtraInfo value that marks SendInput events produced by this helper.</summary>
    internal static readonly IntPtr OwnInjectedMarker = new IntPtr(0x53454C41);

    internal const int VK_LCONTROL = 0xA2;
    internal const int VK_RCONTROL = 0xA3;
    internal const int VK_LSHIFT = 0xA0;
    internal const int VK_RSHIFT = 0xA1;
    internal const int VK_LMENU = 0xA4;
    internal const int VK_RMENU = 0xA5;
    internal const int VK_LWIN = 0x5B;
    internal const int VK_RWIN = 0x5C;

    internal const uint CF_TEXT = 1;
    internal const uint CF_DIB = 8;
    internal const uint CF_UNICODETEXT = 13;
    internal const uint GMEM_MOVEABLE = 0x0042;

    internal const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    internal const uint KEYEVENTF_KEYUP = 0x0002;
    internal const uint INPUT_MOUSE = 0;
    internal const uint INPUT_KEYBOARD = 1;

    internal const int GWL_EXSTYLE = -20;
    internal const long WS_EX_TOOLWINDOW = 0x00000080L;
    internal const long WS_EX_APPWINDOW = 0x00040000L;
    internal const long WS_EX_NOACTIVATE = 0x08000000L;

    internal static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    internal static readonly IntPtr HWND_TOP = IntPtr.Zero;

    internal const uint SWP_NOSIZE = 0x0001;
    internal const uint SWP_NOZORDER = 0x0004;
    internal const uint SWP_NOACTIVATE = 0x0010;

    internal const uint MONITOR_DEFAULTTONEAREST = 2;
    internal const uint MDT_EFFECTIVE_DPI = 0;

    internal const uint FILE_TYPE_PIPE = 0x0003;
    internal const int STD_INPUT_HANDLE = -10;

    [StructLayout(LayoutKind.Sequential)]
    internal struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MSG {
        public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
        public uint time; public POINT pt; public uint lPrivate;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MSLLHOOKSTRUCT {
        public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct KBDLLHOOKSTRUCT {
        public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    internal struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MONITORINFO {
        public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    internal delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    internal static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    internal static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    internal static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    internal static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    internal static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    internal static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    internal static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    internal static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

    [DllImport("user32.dll")]
    internal static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr OpenProcess(int dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern bool QueryFullProcessImageNameW(IntPtr hProcess, int dwFlags, StringBuilder lpExeName, ref int lpdwSize);

    [DllImport("kernel32.dll")]
    internal static extern bool CloseHandle(IntPtr hObject);

    [DllImport("user32.dll")]
    internal static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    internal static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    internal static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("shcore.dll")]
    internal static extern int GetDpiForMonitor(IntPtr hmonitor, uint dpiType, out uint dpiX, out uint dpiY);

    [DllImport("user32.dll")]
    internal static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern uint GetDpiForSystem();

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    internal static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    internal static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr GetClipboardData(uint uFormat);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

    [DllImport("user32.dll")]
    internal static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll")]
    internal static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("kernel32.dll")]
    internal static extern UIntPtr GlobalSize(IntPtr hMem);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr GlobalFree(IntPtr hMem);

    [DllImport("user32.dll")]
    internal static extern bool SetProcessDPIAware();

    [DllImport("shcore.dll")]
    internal static extern int SetProcessDpiAwareness(int value);

    [DllImport("user32.dll")]
    internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll")]
    internal static extern uint GetFileType(IntPtr hFile);

    [DllImport("kernel32.dll")]
    internal static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}

/// <summary>
/// Monotonic millisecond clock. Environment.TickCount64 is a .NET Core API and
/// does not exist on .NET Framework 4.8, the runtime of Windows PowerShell 5.1.
/// Stopwatch starts when this class is first touched, which is once per helper.
/// </summary>
public static class Clock {
    private static readonly System.Diagnostics.Stopwatch Sw = System.Diagnostics.Stopwatch.StartNew();
    public static long NowMs { get { return Sw.ElapsedMilliseconds; } }
}
// ---------------------------------------------------------------------------
// Low level hooks
// ---------------------------------------------------------------------------

/// <summary>
/// Global mouse / keyboard hook engine. Install() starts a dedicated STA-free
/// thread that owns a Win32 message pump; hook callbacks only copy the event
/// into a ConcurrentQueue. DrainEvents() is called on the WPF thread.
/// </summary>
public static class SelectionHook {
    private static readonly ConcurrentQueue<HookEvent> Queue = new ConcurrentQueue<HookEvent>();
    private static Native.HookProc _mouseProc;
    private static Native.HookProc _keyProc;
    private static IntPtr _mouseHook = IntPtr.Zero;
    private static IntPtr _keyHook = IntPtr.Zero;
    private static Thread _thread;
    private static uint _threadId;
    private static readonly ManualResetEventSlim Ready = new ManualResetEventSlim(false);
    private static volatile bool _installed;

    private static bool _lCtrl, _rCtrl, _lShift, _rShift, _lAlt, _rAlt, _lWin, _rWin;
    private static bool _leftDown;
    private static int _downX, _downY;
    private static bool _dragged;

    public static string LastError = "";

    public static bool Installed { get { return _installed; } }
    public static bool LCtrlDown { get { return _lCtrl; } }
    public static bool RCtrlDown { get { return _rCtrl; } }
    public static bool CtrlDown { get { return _lCtrl || _rCtrl; } }

    public static long NowMs { get { return Clock.NowMs; } }

    /// <summary>Starts the hook thread. Returns false and fills LastError on failure.</summary>
    public static bool Install() {
        if (_installed) return true;
        LastError = "";
        Ready.Reset();
        _thread = new Thread(HookThread) { IsBackground = true, Name = "SelectionHook" };
        _thread.Start();
        if (!Ready.Wait(4000)) { LastError = "hook thread did not start within 4s"; return false; }
        return _installed;
    }

    public static void Uninstall() {
        if (_thread == null) return;
        try {
            if (_threadId != 0) Native.PostThreadMessage(_threadId, Native.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            _thread.Join(2000);
        } catch { }
        _installed = false;
        _thread = null;
        _threadId = 0;
    }

    private static void HookThread() {
        _threadId = Native.GetCurrentThreadId();
        Native.MSG msg;
        Native.PeekMessage(out msg, IntPtr.Zero, 0, 0, Native.PM_NOREMOVE);
        _mouseProc = MouseCallback;
        _keyProc = KeyboardCallback;
        _mouseHook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, _mouseProc, IntPtr.Zero, 0);
        int mouseErr = Marshal.GetLastWin32Error();
        _keyHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, _keyProc, IntPtr.Zero, 0);
        int keyErr = Marshal.GetLastWin32Error();
        if (_mouseHook == IntPtr.Zero || _keyHook == IntPtr.Zero) {
            if (_mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(_mouseHook);
            if (_keyHook != IntPtr.Zero) Native.UnhookWindowsHookEx(_keyHook);
            _mouseHook = IntPtr.Zero;
            _keyHook = IntPtr.Zero;
            LastError = "SetWindowsHookEx failed (mouse error " + mouseErr + ", keyboard error " + keyErr + ")";
            Ready.Set();
            return;
        }
        _installed = true;
        Ready.Set();
        while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0)) {
            Native.TranslateMessage(ref msg);
            Native.DispatchMessage(ref msg);
        }
        Native.UnhookWindowsHookEx(_mouseHook);
        Native.UnhookWindowsHookEx(_keyHook);
        _mouseHook = IntPtr.Zero;
        _keyHook = IntPtr.Zero;
        _installed = false;
    }

    private static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            try {
                Native.MSLLHOOKSTRUCT data = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.MSLLHOOKSTRUCT));
                int msg = (int)wParam;
                bool injected = (data.flags & Native.LLMHF_INJECTED) != 0;
                bool ownInjected = injected && data.dwExtraInfo == Native.OwnInjectedMarker;
                switch (msg) {
                    case Native.WM_LBUTTONDOWN:
                        _leftDown = true;
                        _downX = data.pt.x;
                        _downY = data.pt.y;
                        _dragged = false;
                        Enqueue(MouseEvent("down", "L", data.pt.x, data.pt.y, false, injected, ownInjected));
                        break;
                    case Native.WM_LBUTTONUP:
                        if (_leftDown) {
                            int dx = data.pt.x - _downX;
                            int dy = data.pt.y - _downY;
                            if (dx * dx + dy * dy > 16) _dragged = true;
                        }
                        Enqueue(MouseEvent("up", "L", data.pt.x, data.pt.y, _dragged, injected, ownInjected));
                        _leftDown = false;
                        _dragged = false;
                        break;
                    case Native.WM_MOUSEMOVE:
                        if (_leftDown && !_dragged) {
                            int mdx = data.pt.x - _downX;
                            int mdy = data.pt.y - _downY;
                            if (mdx * mdx + mdy * mdy > 16) _dragged = true;
                        }
                        break;
                    case Native.WM_RBUTTONDOWN:
                        Enqueue(MouseEvent("down", "R", data.pt.x, data.pt.y, false, injected, ownInjected));
                        break;
                    case Native.WM_RBUTTONUP:
                        Enqueue(MouseEvent("up", "R", data.pt.x, data.pt.y, false, injected, ownInjected));
                        break;
                    case Native.WM_MBUTTONDOWN:
                        Enqueue(MouseEvent("down", "M", data.pt.x, data.pt.y, false, injected, ownInjected));
                        break;
                    case Native.WM_MBUTTONUP:
                        Enqueue(MouseEvent("up", "M", data.pt.x, data.pt.y, false, injected, ownInjected));
                        break;
                }
            } catch { }
        }
        return Native.CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    private static IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            try {
                Native.KBDLLHOOKSTRUCT data = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                int msg = (int)wParam;
                bool up = msg == Native.WM_KEYUP || msg == Native.WM_SYSKEYUP;
                bool injected = (data.flags & Native.LLKHF_INJECTED) != 0;
                bool ownInjected = injected && data.dwExtraInfo == Native.OwnInjectedMarker;
                int vk = (int)data.vkCode;
                ApplyKeyState(vk, up, ownInjected);
                HookEvent e = new HookEvent();
                e.Kind = "key";
                e.Phase = up ? "up" : "down";
                e.Vk = vk;
                e.Injected = injected;
                e.OwnInjected = ownInjected;
                e.Ms = Clock.NowMs;
                FillModifiers(e);
                Queue.Enqueue(e);
            } catch { }
        }
        return Native.CallNextHookEx(_keyHook, nCode, wParam, lParam);
    }

    private static void ApplyKeyState(int vk, bool up, bool ownInjected) {
        // Physical state tracks real and externally injected input; only our own
        // Ctrl+C helper events must not affect it.
        if (ownInjected) return;
        switch (vk) {
            case Native.VK_LCONTROL: _lCtrl = !up; break;
            case Native.VK_RCONTROL: _rCtrl = !up; break;
            case Native.VK_LSHIFT: _lShift = !up; break;
            case Native.VK_RSHIFT: _rShift = !up; break;
            case Native.VK_LMENU: _lAlt = !up; break;
            case Native.VK_RMENU: _rAlt = !up; break;
            case Native.VK_LWIN: _lWin = !up; break;
            case Native.VK_RWIN: _rWin = !up; break;
        }
    }

    private static void FillModifiers(HookEvent e) {
        e.Ctrl = _lCtrl || _rCtrl;
        e.Alt = _lAlt || _rAlt;
        e.Shift = _lShift || _rShift;
        e.Win = _lWin || _rWin;
    }

    private static HookEvent MouseEvent(string phase, string button, int x, int y, bool drag, bool injected, bool ownInjected) {
        HookEvent e = new HookEvent();
        e.Kind = "mouse";
        e.Phase = phase;
        e.Button = button;
        e.X = x;
        e.Y = y;
        e.Drag = drag;
        e.DownX = _downX;
        e.DownY = _downY;
        e.Injected = injected;
        e.OwnInjected = ownInjected;
        e.Ms = Clock.NowMs;
        FillModifiers(e);
        return e;
    }

    private static void Enqueue(HookEvent e) { Queue.Enqueue(e); }

    /// <summary>Returns and clears everything the hook callbacks queued.</summary>
    public static HookEvent[] DrainEvents() {
        List<HookEvent> list = new List<HookEvent>();
        HookEvent e;
        while (Queue.TryDequeue(out e)) list.Add(e);
        return list.ToArray();
    }

    /// <summary>Only used by the self test: pushes a key event into the queue.</summary>
    public static void TestInjectKey(int vk, bool down) {
        ApplyKeyState(vk, !down, false);
        HookEvent e = new HookEvent();
        e.Kind = "key";
        e.Phase = down ? "down" : "up";
        e.Vk = vk;
        e.Injected = false;
        e.OwnInjected = false;
        e.Ms = Clock.NowMs;
        FillModifiers(e);
        Queue.Enqueue(e);
    }

    /// <summary>Only used by the self test: pushes a mouse event into the queue.</summary>
    public static void TestInjectMouse(string phase, string button, int x, int y, bool drag) {
        HookEvent e = MouseEvent(phase, button, x, y, drag, false, false);
        Queue.Enqueue(e);
    }

    // -- synthetic input ----------------------------------------------------

    /// <summary>Current kernel key state as reported by GetAsyncKeyState (self test only).</summary>
    public static bool IsKeyDown(int vk) { return (Native.GetAsyncKeyState(vk) & 0x8000) != 0; }

    public static void SendKey(int vk, bool down) {
        Native.INPUT[] inputs = new Native.INPUT[1];
        inputs[0].type = Native.INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = (ushort)vk;
        inputs[0].U.ki.wScan = (ushort)Native.MapVirtualKey((uint)vk, 0);
        inputs[0].U.ki.dwFlags = down ? 0u : Native.KEYEVENTF_KEYUP;
        inputs[0].U.ki.time = 0;
        // Mark helper-generated input so the hook can ignore its own Ctrl+C.
        inputs[0].U.ki.dwExtraInfo = Native.OwnInjectedMarker;
        Native.SendInput(1, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
    }

    /// <summary>
    /// Simulates Ctrl+C without disturbing a physically held Ctrl: the held
    /// Ctrl is released first, the copy is sent, then the physical Ctrl state is
    /// restored so the user's long press is not broken.
    /// </summary>
    public static void SendCtrlC() {
        bool restoreL = _lCtrl;
        bool restoreR = _rCtrl;
        if (restoreL) { SendKey(Native.VK_LCONTROL, false); Thread.Sleep(6); }
        if (restoreR) { SendKey(Native.VK_RCONTROL, false); Thread.Sleep(6); }
        SendKey(Native.VK_LCONTROL, true); Thread.Sleep(6);
        SendKey(0x43 /* C */, true); Thread.Sleep(8);
        SendKey(0x43, false); Thread.Sleep(6);
        SendKey(Native.VK_LCONTROL, false); Thread.Sleep(6);
        if (restoreL) { SendKey(Native.VK_LCONTROL, true); Thread.Sleep(6); }
        if (restoreR) { SendKey(Native.VK_RCONTROL, true); }
    }

    /// <summary>Self test support: inject a bare key press (no modifiers).</summary>
    public static void SendKeyPress(int vk) {
        SendKey(vk, true);
        Thread.Sleep(10);
        SendKey(vk, false);
    }

    /// <summary>
    /// Fallback for apps that ignore global SendInput (remote-control sessions):
    /// ask the foreground window to copy its selection through WM_COPY.
    /// </summary>
    public static bool SendCopyMessage() {
        IntPtr hwnd = Native.GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return false;
        return Native.PostMessage(hwnd, Native.WM_COPY, IntPtr.Zero, IntPtr.Zero);
    }

    /// <summary>
    /// Fallback for apps that ignore global SendInput: post a Ctrl+C key pair
    /// directly to the foreground window. Winit/Electron style apps still read
    /// the posted keyboard messages even when the low-level hook path is blocked.
    /// </summary>
    public static bool PostCtrlC() {
        IntPtr hwnd = Native.GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return false;
        bool ok = true;
        ok &= Native.PostMessage(hwnd, (uint)Native.WM_KEYDOWN, new IntPtr(Native.VK_LCONTROL), KeyLParam(Native.VK_LCONTROL, false));
        Thread.Sleep(8);
        ok &= Native.PostMessage(hwnd, (uint)Native.WM_KEYDOWN, new IntPtr(0x43), KeyLParam(0x43, false));
        Thread.Sleep(8);
        ok &= Native.PostMessage(hwnd, (uint)Native.WM_KEYUP, new IntPtr(0x43), KeyLParam(0x43, true));
        Thread.Sleep(8);
        ok &= Native.PostMessage(hwnd, (uint)Native.WM_KEYUP, new IntPtr(Native.VK_LCONTROL), KeyLParam(Native.VK_LCONTROL, true));
        return ok;
    }

    private static IntPtr KeyLParam(int vk, bool up) {
        uint scan = Native.MapVirtualKey((uint)vk, 0);
        long value = 1 | ((long)scan << 16);
        if (up) value |= 0xC0000000L;
        return new IntPtr(unchecked((int)value));
    }
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/// <summary>Clipboard save / read / restore with retries; text and DIB only.</summary>
public static class ClipboardUtil {
    private const int OpenRetries = 8;
    private const int OpenDelayMs = 15;

    private static bool OpenWithRetry() {
        for (int i = 0; i < OpenRetries; i++) {
            if (Native.OpenClipboard(IntPtr.Zero)) return true;
            Thread.Sleep(OpenDelayMs);
        }
        return false;
    }

    /// <summary>Snapshot the clipboard so a failed capture does not eat user content.</summary>
    public static ClipboardSnapshot Save() {
        ClipboardSnapshot snap = new ClipboardSnapshot();
        if (!OpenWithRetry()) return snap;
        snap.Saved = true;
        try {
            if (Native.IsClipboardFormatAvailable(Native.CF_UNICODETEXT)) {
                IntPtr h = Native.GetClipboardData(Native.CF_UNICODETEXT);
                if (h != IntPtr.Zero) {
                    IntPtr p = Native.GlobalLock(h);
                    if (p != IntPtr.Zero) {
                        snap.HasText = true;
                        snap.Text = Marshal.PtrToStringUni(p) ?? "";
                        Native.GlobalUnlock(h);
                    }
                }
            }
            if (Native.IsClipboardFormatAvailable(Native.CF_DIB)) {
                IntPtr h = Native.GetClipboardData(Native.CF_DIB);
                if (h != IntPtr.Zero) {
                    long size = (long)Native.GlobalSize(h);
                    IntPtr p = Native.GlobalLock(h);
                    if (p != IntPtr.Zero && size > 0 && size < 64L * 1024 * 1024) {
                        snap.Dib = new byte[size];
                        Marshal.Copy(p, snap.Dib, 0, (int)size);
                        snap.HasDib = true;
                        Native.GlobalUnlock(h);
                    }
                }
            }
        } catch { } finally { Native.CloseClipboard(); }
        return snap;
    }

    /// <summary>Empties the clipboard so a failed Ctrl+C cannot return stale text.</summary>
    public static bool Clear() {
        if (!OpenWithRetry()) return false;
        try { return Native.EmptyClipboard(); } catch { return false; } finally { Native.CloseClipboard(); }
    }

    /// <summary>Reads clipboard text; returns null when the clipboard cannot be opened.</summary>
    public static string ReadText() {
        if (!OpenWithRetry()) return null;
        try {
            if (!Native.IsClipboardFormatAvailable(Native.CF_UNICODETEXT)) return "";
            IntPtr h = Native.GetClipboardData(Native.CF_UNICODETEXT);
            if (h == IntPtr.Zero) return "";
            IntPtr p = Native.GlobalLock(h);
            if (p == IntPtr.Zero) return "";
            try { return Marshal.PtrToStringUni(p) ?? ""; } finally { Native.GlobalUnlock(h); }
        } catch { return null; } finally { Native.CloseClipboard(); }
    }

    public static bool SetText(string text) {
        if (!OpenWithRetry()) return false;
        try {
            Native.EmptyClipboard();
            return SetUnicodeText(text);
        } catch { return false; } finally { Native.CloseClipboard(); }
    }

    /// <summary>Puts the snapshot back. Restores text first, then the bitmap.</summary>
    public static bool Restore(ClipboardSnapshot snap) {
        if (snap == null || !snap.Saved) return false;
        if (!OpenWithRetry()) return false;
        try {
            Native.EmptyClipboard();
            if (snap.HasText) SetUnicodeText(snap.Text ?? "");
            if (snap.HasDib && snap.Dib != null) {
                IntPtr h = AllocHGlobal(snap.Dib);
                if (h != IntPtr.Zero && Native.SetClipboardData(Native.CF_DIB, h) == IntPtr.Zero) Native.GlobalFree(h);
            }
            return true;
        } catch { return false; } finally { Native.CloseClipboard(); }
    }

    private static bool SetUnicodeText(string text) {
        byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
        IntPtr h = AllocHGlobal(bytes);
        if (h == IntPtr.Zero) return false;
        if (Native.SetClipboardData(Native.CF_UNICODETEXT, h) == IntPtr.Zero) { Native.GlobalFree(h); return false; }
        return true;
    }

    private static IntPtr AllocHGlobal(byte[] bytes) {
        IntPtr h = Native.GlobalAlloc(Native.GMEM_MOVEABLE, (UIntPtr)bytes.Length);
        if (h == IntPtr.Zero) return IntPtr.Zero;
        IntPtr p = Native.GlobalLock(h);
        if (p == IntPtr.Zero) { Native.GlobalFree(h); return IntPtr.Zero; }
        Marshal.Copy(bytes, 0, p, bytes.Length);
        Native.GlobalUnlock(h);
        return h;
    }
}

// ---------------------------------------------------------------------------
// Foreground process / screen geometry
// ---------------------------------------------------------------------------

/// <summary>Foreground window, foreground process name and window rectangles.</summary>
public static class ForegroundInfo {
    public static IntPtr GetForegroundWindow() { return Native.GetForegroundWindow(); }

    public static int GetForegroundProcessId() {
        int pid;
        Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
        return pid;
    }

    public static string GetForegroundProcessName() {
        IntPtr hwnd = Native.GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return "";
        int pid;
        Native.GetWindowThreadProcessId(hwnd, out pid);
        return GetProcessName(pid);
    }

    public static string GetProcessName(int pid) {
        if (pid <= 0) return "";
        IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return "";
        try {
            StringBuilder sb = new StringBuilder(1024);
            int size = sb.Capacity;
            if (!Native.QueryFullProcessImageNameW(h, 0, sb, ref size)) return "";
            string full = sb.ToString();
            int slash = full.LastIndexOf('\\');
            string name = slash >= 0 ? full.Substring(slash + 1) : full;
            return name.ToLowerInvariant();
        } catch { return ""; } finally { Native.CloseHandle(h); }
    }

    public static int[] GetWindowRect(IntPtr hwnd) {
        Native.RECT r;
        if (!Native.GetWindowRect(hwnd, out r)) return new int[] { 0, 0, 0, 0 };
        return new int[] { r.Left, r.Top, r.Right, r.Bottom };
    }

    public static bool IsOwnWindow(IntPtr hwnd) {
        int pid;
        Native.GetWindowThreadProcessId(hwnd, out pid);
        return pid == System.Diagnostics.Process.GetCurrentProcess().Id;
    }
}

/// <summary>Physical pixel geometry, work areas and per-monitor DPI.</summary>
public static class ScreenUtil {
    public static void InitializeDpiAwareness() {
        try {
            if (Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        } catch { }
        try { Native.SetProcessDpiAwareness(2); return; } catch { }
        try { Native.SetProcessDPIAware(); } catch { }
    }

    public static int[] GetCursorPos() {
        Native.POINT p;
        Native.GetCursorPos(out p);
        return new int[] { p.x, p.y };
    }

    public static int[] GetPrimaryScreenSize() {
        return new int[] { GetSystemMetrics(0), GetSystemMetrics(1) };
    }

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    private static Native.MONITORINFO MonitorInfoFromPoint(int x, int y) {
        Native.POINT pt; pt.x = x; pt.y = y;
        IntPtr mon = Native.MonitorFromPoint(pt, Native.MONITOR_DEFAULTTONEAREST);
        Native.MONITORINFO info = new Native.MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
        Native.GetMonitorInfoW(mon, ref info);
        return info;
    }

    /// <summary>Work area of the monitor that contains (x, y): left, top, right, bottom (physical px).</summary>
    public static int[] GetWorkArea(int x, int y) {
        Native.MONITORINFO info = MonitorInfoFromPoint(x, y);
        return new int[] { info.rcWork.Left, info.rcWork.Top, info.rcWork.Right, info.rcWork.Bottom };
    }

    public static int[] GetMonitorRect(int x, int y) {
        Native.MONITORINFO info = MonitorInfoFromPoint(x, y);
        return new int[] { info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right, info.rcMonitor.Bottom };
    }

    /// <summary>Effective DPI scale (1.0 = 96 dpi) of the monitor at (x, y).</summary>
    public static double GetScaleAt(int x, int y) {
        Native.POINT pt; pt.x = x; pt.y = y;
        IntPtr mon = Native.MonitorFromPoint(pt, Native.MONITOR_DEFAULTTONEAREST);
        uint dpiX = 96, dpiY = 96;
        try {
            if (Native.GetDpiForMonitor(mon, Native.MDT_EFFECTIVE_DPI, out dpiX, out dpiY) != 0) { dpiX = 96; dpiY = 96; }
        } catch { dpiX = 96; dpiY = 96; }
        if (dpiX == 0) dpiX = 96;
        return dpiX / 96.0;
    }

    public static double GetSystemScale() {
        uint dpi = 96;
        try { dpi = Native.GetDpiForSystem(); } catch { }
        if (dpi == 0) dpi = 96;
        return dpi / 96.0;
    }
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

/// <summary>Win32 tweaks for the WPF windows: tool window, no activate, topmost, move.</summary>
public static class WindowUtil {
    /// <summary>Adds WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE so the window never takes focus.</summary>
    public static void MakeNoActivate(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        try {
            long ex = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE).ToInt64();
            ex |= Native.WS_EX_TOOLWINDOW;
            ex |= Native.WS_EX_NOACTIVATE;
            ex &= ~Native.WS_EX_APPWINDOW;
            Native.SetWindowLongPtr(hwnd, Native.GWL_EXSTYLE, new IntPtr(ex));
        } catch { }
    }

    /// <summary>Adds WS_EX_TOOLWINDOW only: no taskbar entry, but focusable.</summary>
    public static void MakeToolWindow(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        try {
            long ex = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE).ToInt64();
            ex |= Native.WS_EX_TOOLWINDOW;
            ex &= ~Native.WS_EX_APPWINDOW;
            Native.SetWindowLongPtr(hwnd, Native.GWL_EXSTYLE, new IntPtr(ex));
        } catch { }
    }

    /// <summary>Moves the window in physical pixels without activating or resizing it.</summary>
    public static void MoveWindow(IntPtr hwnd, int x, int y, bool topmost) {
        if (hwnd == IntPtr.Zero) return;
        try {
            Native.SetWindowPos(hwnd, topmost ? Native.HWND_TOPMOST : Native.HWND_TOP, x, y, 0, 0,
                Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
        } catch { }
    }

    /// <summary>Applies the z-order in physical pixels without moving the window.</summary>
    public static void SetTopmost(IntPtr hwnd, bool topmost) {
        if (hwnd == IntPtr.Zero) return;
        try {
            Native.SetWindowPos(hwnd, topmost ? Native.HWND_TOPMOST : Native.HWND_TOP, 0, 0, 0, 0,
                Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_NOZORDER * 0);
        } catch { }
    }

    public static int[] GetWindowRect(IntPtr hwnd) { return ForegroundInfo.GetWindowRect(hwnd); }
}

// ---------------------------------------------------------------------------
// HTTP: status / log / SSE stream
// ---------------------------------------------------------------------------

/// <summary>Small HTTP helper; never throws into PowerShell.</summary>
public static class RestClient {
    private static readonly HttpClient Http = CreateClient();

    private static HttpClient CreateClient() {
        try {
            // .NET Framework 4.8 has no SocketsHttpHandler, so ConnectTimeout and
            // PooledConnectionLifetime are unavailable. Loopback traffic must not
            // go through the system proxy.
            HttpClientHandler handler = new HttpClientHandler();
            handler.AllowAutoRedirect = false;
            handler.UseProxy = false;
            HttpClient c = new HttpClient(handler);
            c.Timeout = TimeSpan.FromSeconds(120);
            c.DefaultRequestHeaders.UserAgent.ParseAdd("dsh-selection-helper/0.1");
            return c;
        } catch {
            HttpClient c = new HttpClient();
            c.Timeout = TimeSpan.FromSeconds(30);
            return c;
        }
    }

    private static HttpRequestMessage BuildRequest(string url, string token, string json) {
        HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token ?? "");
        req.Content = new StringContent(json ?? "{}", Encoding.UTF8);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        return req;
    }

    /// <summary>Synchronous POST; returns the response body or "" on any failure.</summary>
    public static string PostJson(string url, string token, string json, int timeoutMs) {
        if (string.IsNullOrEmpty(url)) return "";
        try {
            using (HttpRequestMessage req = BuildRequest(url, token, json))
            using (CancellationTokenSource cts = new CancellationTokenSource(Math.Max(250, timeoutMs)))
            using (HttpResponseMessage resp = Http.SendAsync(req, cts.Token).GetAwaiter().GetResult()) {
                return resp.Content.ReadAsStringAsync().GetAwaiter().GetResult() ?? "";
            }
        } catch { return ""; }
    }

    /// <summary>Fire-and-forget POST used for status and log lines.</summary>
    public static void PostJsonFireAndForget(string url, string token, string json) {
        if (string.IsNullOrEmpty(url)) return;
        try {
            ThreadPool.QueueUserWorkItem(delegate { PostJson(url, token, json, 3000); });
        } catch { }
    }
}

/// <summary>
/// One SSE request to POST /v1/action. A background thread reads the stream and
/// enqueues SseEvent items; PowerShell polls Poll() on the WPF thread.
/// </summary>
public sealed class SseStream {
    private readonly ConcurrentQueue<SseEvent> _queue = new ConcurrentQueue<SseEvent>();
    private CancellationTokenSource _cts;
    private Thread _thread;
    private Stream _bodyStream;
    private volatile bool _finished;
    private bool _cancelled;

    public bool Finished { get { return _finished; } }

    public void Start(string url, string token, string jsonBody) {
        _cts = new CancellationTokenSource();
        _thread = new Thread(new ThreadStart(delegate { Run(url, token, jsonBody); }));
        _thread.IsBackground = true;
        _thread.Name = "SelectionSse";
        _thread.Start();
    }

    public SseEvent Poll() {
        SseEvent e;
        return _queue.TryDequeue(out e) ? e : null;
    }

    public void Cancel() {
        _cancelled = true;
        try { if (_cts != null) _cts.Cancel(); } catch { }
        try {
            Stream s = _bodyStream;
            if (s != null) s.Dispose();
        } catch { }
    }

    private void Emit(string kind, string data) {
        SseEvent e = new SseEvent();
        e.Kind = kind;
        e.Data = data ?? "";
        _queue.Enqueue(e);
    }

    private void Run(string url, string token, string jsonBody) {
        bool sawTerminal = false;
        try {
            using (HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post, url))
            using (CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token)) {
                linked.CancelAfter(TimeSpan.FromMinutes(10));
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token ?? "");
                req.Content = new StringContent(jsonBody ?? "{}", Encoding.UTF8);
                req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
                req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

                // Local client avoids the shared HttpClient timeout on streaming bodies.
                using (HttpClient client = new HttpClient()) {
                    client.Timeout = TimeSpan.FromSeconds(120);
                    using (HttpResponseMessage resp = client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, linked.Token).GetAwaiter().GetResult()) {
                        if (!resp.IsSuccessStatusCode) {
                            string body = "";
                            try { body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult(); } catch { }
                            Emit("transport-error", "宿主返回 HTTP " + (int)resp.StatusCode + (string.IsNullOrEmpty(body) ? "" : "：" + Trim(body, 300)));
                            return;
                        }
                        _bodyStream = resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult();
                        using (StreamReader reader = new StreamReader(_bodyStream, Encoding.UTF8, true, 4096, true)) {
                            string eventName = null;
                            StringBuilder data = null;
                            string line;
                            while ((line = reader.ReadLine()) != null) {
                                if (_cts.IsCancellationRequested) break;
                                if (line.Length == 0) {
                                    if (eventName != null || data != null) {
                                        string payload = data == null ? "" : data.ToString();
                                        Emit(eventName == null ? "message" : eventName, payload);
                                        if (eventName == "done" || eventName == "error") sawTerminal = true;
                                        eventName = null;
                                        data = null;
                                    }
                                    continue;
                                }
                                if (line[0] == ':') continue;
                                int colon = line.IndexOf(':');
                                string field = colon < 0 ? line : line.Substring(0, colon);
                                string value = colon < 0 ? "" : line.Substring(colon + 1);
                                if (value.StartsWith(" ")) value = value.Substring(1);
                                if (field == "event") eventName = value;
                                else if (field == "data") {
                                    if (data == null) data = new StringBuilder(value);
                                    else data.Append('\n').Append(value);
                                }
                            }
                            if (data != null) {
                                string payload = data.ToString();
                                string kind = eventName == null ? "message" : eventName;
                                Emit(kind, payload);
                                if (kind == "done" || kind == "error") sawTerminal = true;
                            }
                        }
                    }
                }
            }
            if (!sawTerminal && !_cancelled) Emit("stream-end", "连接已关闭");
        } catch (OperationCanceledException) {
            if (!_cancelled) Emit("transport-error", "请求超时");
        } catch (ObjectDisposedException) {
            if (!_cancelled) Emit("transport-error", "连接已中断");
        } catch (Exception ex) {
            if (!_cancelled) Emit("transport-error", ErrorText(ex));
        } finally {
            _finished = true;
        }
    }

    private static string ErrorText(Exception ex) {
        Exception inner = ex;
        while (inner.InnerException != null) inner = inner.InnerException;
        string msg = inner.Message;
        return Trim(msg, 300);
    }

    private static string Trim(string s, int max) {
        if (string.IsNullOrEmpty(s)) return "";
        s = s.Replace("\r", " ").Replace("\n", " ").Trim();
        return s.Length <= max ? s : s.Substring(0, max) + "…";
    }
}

// ---------------------------------------------------------------------------
// stdin EOF watcher
// ---------------------------------------------------------------------------

/// <summary>
/// The host writes helper-config.json, then keeps the helper's stdin pipe open.
/// When the host dies the pipe closes; the helper must exit. This class only
/// starts for real pipes (redirected input), never for a console or NUL device.
/// </summary>
public static class StdInWatcher {
    private static volatile bool _eof;
    private static int _started;

    public static bool Eof { get { return _eof; } }

    public static bool Start() {
        if (Interlocked.CompareExchange(ref _started, 1, 0) != 0) return _started == 2;
        try {
            if (!Console.IsInputRedirected) { _started = 3; return false; }
            IntPtr handle = Native.GetStdHandle(Native.STD_INPUT_HANDLE);
            uint type = Native.GetFileType(handle);
            if (type != Native.FILE_TYPE_PIPE) { _started = 3; return false; }
            Thread t = new Thread(new ThreadStart(delegate {
                try {
                    TextReader reader = Console.In;
                    while (true) { if (reader.Read() < 0) break; }
                } catch { } finally { _eof = true; }
            }));
            t.IsBackground = true;
            t.Name = "SelectionStdin";
            t.Start();
            _started = 2;
            return true;
        } catch {
            _started = 3;
            return false;
        }
    }
}

/// <summary>Error text helpers shared by PowerShell error reporting.</summary>
public static class Diagnostics {
    public static string DescribeException(Exception ex) {
        if (ex == null) return "unknown error";
        Exception inner = ex;
        while (inner.InnerException != null) inner = inner.InnerException;
        return inner.GetType().Name + ": " + inner.Message;
    }
}
