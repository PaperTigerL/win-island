# 「把发这条通知的应用唤回前台」的共用实现，island.ps1 和 activate.ps1 都 dot-source 这个文件
# （同一份逻辑两处实现迟早对不上，所以拆开）。
#
# 为什么需要它：通知库里只有 AUMID（QQ / com.qoder.app / com.bilibili.bilibiliPC /
# WorkBuddy.WorkBuddy / 甚至一个 exe 路径）。实测最近 73 条里的 12 个应用身份中，
# Qoder 的 launch 是「notificationId=605f…」（不是协议串）、B 站干脆没有 launch，
# 这两个 shell:AppsFolder 也不认（错误 1229）—— 所以只能自己找窗口。
#
# 两个实测坑，代码都是为它们写的：
#   1) QQ/Qoder/哔哩哔哩 一个进程名有 6~15 个进程（Electron），只有其中一个带顶层窗口。
#      而且只有 IME 宿主窗口的进程（标题 "Default IME"）必须跳过，否则实测会先选中它，
#      点开胶囊什么也不会发生。
#   2) QQ 收进托盘的窗口是 vis=0 且 rect=-32000，但 IsIconic=false —— 只判断「最小化」不够，
#      「不可见」「在屏幕外」都得走 ShowWindow。
#   3) SetForegroundWindow 会被系统的前台锁定拒绝（从后台控制台调用实测就失败）。
#      岛屿自己是前台窗口所以正常能用，但仍然补了「接输入队列」和 SwitchToThisWindow 两级兜底。
if (-not ('IslandWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class IslandWin32 {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int  GetWindowTextLengthW(IntPtr h);
  // 必须标 [Out]：StringBuilder 默认只按「输入」封送，不写回的话调用方读到的是未初始化缓冲区，
  // 实测标题就变成一个随机字符（"QQ" 变 "Q"）
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern int  SetWindowLongW(IntPtr h, int idx, int newLong);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool join);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after,
    int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
  const int WS_EX_TRANSPARENT = 0x20;
  const int SW_RESTORE = 9, SW_SHOW = 5, GA_ROOTOWNER = 2;
  const int OFFSCREEN = -30000;   // 托盘隐藏/甩出屏幕外的窗口都落在 -32000 一带
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_NOACTIVATE = 0x10;

  // WPF 的 Topmost=True 只在设置那一刻生效一次：别的程序也开 TopMost（游戏切无边框全屏、
  // 某些工具窗）就会把岛压下去，而且岛自己不会有机会再抢回来。所以按固定节奏重申一次，
  // 位置尺寸都不动、也不抢焦点。
  public static bool ForceTopmost(IntPtr h) {
    return SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }


  // 岛屿常驻的「把手」压在屏幕最顶，正好盖住最大化窗口标题栏中间那块。不点透就是替别人
  // 吞掉标题栏点击，所以把手态必须 WS_EX_TRANSPARENT（WPF 的 AllowsTransparency 只管形状不管命中）。
  // 展开面板时要关掉，否则列表点不动。
  public static bool SetClickThrough(IntPtr h, bool on) {
    int ex = unchecked((int)GetWindowLongW(h, GWL_EXSTYLE));
    int want = on ? (ex | WS_EX_TRANSPARENT) : (ex & ~WS_EX_TRANSPARENT);
    if (want == ex) return true;
    return SetWindowLongW(h, GWL_EXSTYLE, want) != 0;
  }
  public static int CursorX() { PT p; return GetCursorPos(out p) ? p.X : -32000; }
  public static int CursorY() { PT p; return GetCursorPos(out p) ? p.Y : -32000; }
  // 左键现在是不是按着的。只能问 Win32：WPF 那侧 Mouse.PrimaryDevice 是 Win32MouseDevice，
  // .NET Framework 没有公开的 GetMouseState()（实测 MethodNotFound），而拖拽每 tick 都要问一次。
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vkey);
  public static bool LeftDown() { return (GetAsyncKeyState(0x01) & unchecked((short)0x8000)) != 0; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint data, uint extra, IntPtr reserved);
  const uint MDOWN = 0x0002, MUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010;
  public static void MoveTo(int x, int y) { SetCursorPos(x, y); }
  // 真发一次左键点击，点完把光标放回原位。测试脚本要靠它才有「用户真的点了」这件事，
  // 中间那次回读是对齐用户自己在动鼠标的情形：实测有过点子没落到胶囊上、日志里根本没有 [open]。
  public static string ClickAt(int x, int y) {
    PT save; GetCursorPos(out save);
    SetCursorPos(x, y);
    Thread.Sleep(70);
    PT now;
    for (int i = 0; i < 3; i++) {
      GetCursorPos(out now);
      if (now.X == x && now.Y == y) break;
      SetCursorPos(x, y); Thread.Sleep(30);
    }
    mouse_event(MDOWN, 0, 0, IntPtr.Zero);
    Thread.Sleep(45);
    mouse_event(MUP, 0, 0, IntPtr.Zero);
    Thread.Sleep(120);
    SetCursorPos(save.X, save.Y);
    return "点过 (" + x + "," + y + ")，光标放回 (" + save.X + "," + save.Y + ")";
  }
  // 验证点透真的生效：点透之后这一像素上拿到的句柄不该是岛屿自己
  public static IntPtr HitTest(int x, int y) { PT p = new PT(); p.X = x; p.Y = y; return WindowFromPoint(p); }
  // 右键版：行的操作面（复制/忽略）只挂在右键菜单上，测试要打开它就得出一次真右键，
  // 不能靠代码里直接 IsOpen=true —— 那样验不到「鼠标位置能命中哪一行」这一步。
  public static string RightClickAt(int x, int y) {
    PT save; GetCursorPos(out save);
    SetCursorPos(x, y);
    Thread.Sleep(70);
    mouse_event(RDOWN, 0, 0, IntPtr.Zero);
    Thread.Sleep(45);
    mouse_event(RUP, 0, 0, IntPtr.Zero);
    Thread.Sleep(120);
    SetCursorPos(save.X, save.Y);
    return "右键点过 (" + x + "," + y + ")，光标放回 (" + save.X + "," + save.Y + ")";
  }
  public static IntPtr RootOf(IntPtr h) { IntPtr r = GetAncestor(h, 2); return r == IntPtr.Zero ? h : r; }
  public static RECT Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }

  // 带标题但和「应用界面」无关的系统消息窗。不过滤的话实测会挑中 QQ 的 IME 宿主进程。
  static bool Junk(string t) {
    return t.Length == 0
      || t == "Default IME" || t == "MSCTFIME UI" || t == "DDE Server Window"
      || t.StartsWith("GDI+ Window", StringComparison.OrdinalIgnoreCase);
  }

  // 返回 "hwnd|vis|iconic|offscreen|面积|标题"，排序挑选交给 PowerShell。
  public static List<string> CandidateWindows(uint wantPid) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != wantPid) return true;
      int ex = unchecked((int)GetWindowLongW(h, GWL_EXSTYLE));
      if ((ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) != 0) return true;
      int len = GetWindowTextLengthW(h);
      if (len <= 0) return true;                            // 没标题的窗口不是给用户点的
      if (GetAncestor(h, GA_ROOTOWNER) != h) return true;   // 只留 owner 链顶，跳过子窗/弹窗
      var sb = new StringBuilder(len + 2);
      int n = GetWindowTextW(h, sb, sb.Capacity);
      string title = (n > 0) ? sb.ToString(0, n) : "";
      if (Junk(title)) return true;
      RECT r; GetWindowRect(h, out r);
      bool off = (r.L <= OFFSCREEN || r.T <= OFFSCREEN);
      long area = (long)(r.R - r.L) * (long)(r.B - r.T);
      if (area < 0) area = 0;
      list.Add(h + "|" + (IsWindowVisible(h) ? 1 : 0) + "|" + (IsIconic(h) ? 1 : 0) + "|"
                    + (off ? 1 : 0) + "|" + area + "|" + title);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  static bool Mine(IntPtr h) { return GetAncestor(GetForegroundWindow(), GA_ROOTOWNER) == h; }

  // 不看 SetForegroundWindow 的返回值，只看 GetForegroundWindow 是不是它 —— 返回 true 不等于用户真看见了。
  public static string Activate(IntPtr h) {
    if (Mine(h)) return "本来就在前台";
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    if (!IsWindowVisible(h)) ShowWindow(h, SW_SHOW);
    SetForegroundWindow(h);
    if (Mine(h)) return "已到前台[直接]";
    // 前台锁定：把本线程临时接进当前前台线程的输入队列，相当于「刚收到过输入」
    uint me = GetCurrentThreadId();
    uint fpid; uint ftid = GetWindowThreadProcessId(GetForegroundWindow(), out fpid);
    bool joined = (ftid != 0 && ftid != me) && AttachThreadInput(me, ftid, true);
    try {
      BringWindowToTop(h);
      SetForegroundWindow(h);
      if (Mine(h)) return "已到前台[接输入队列]";
      SwitchToThisWindow(h, true);          // Alt+Tab 走的那条路，异步，所以要等一再认
      for (int i = 0; i < 12 && !Mine(h); i++) Thread.Sleep(25);
      if (Mine(h)) return "已到前台[SwitchToThisWindow]";
    } finally {
      if (joined) AttachThreadInput(me, ftid, false);
    }
    return "三种办法都没能置前";
  }
}
'@ -Language CSharp
}

function Get-IslandWindowCandidates {
  param([int]$ProcId)
  [IslandWin32]::CandidateWindows([uint32]$ProcId)
}

# AUMID -> 候选名字片段。QQ / com.qoder.app / com.bilibili.bilibiliPC / WorkBuddy.WorkBuddy
# 都要能落到 qoder / bilibili / workbuddy / qq 这种在进程名或安装路径里搜得到的短串。
function Get-AumidTokens {
  param([string]$Aumid, [string]$AppName)
  # 微信这类 AUMID 本身就是 exe 路径，切出来的 'exe'/'msi' 见谁匹配谁，必须先停掉
  $stop = @('com','app','apps','exe','msi','desktop','client','windows','microsoft','system','packages',
            'server','core','x64','x86','arm64','software','program','files','users','bin',
            'localappdata','application','immersive','nonimmersivepackage','wekyb3d8bbwe')
  $raw = @()
  # 商店包的 AUMID 带 _8wekyb3d8bbwe!App 这类后缀，切出来的碎片永远匹配不到进程，先剥掉。
  # app 和 appId 两种形状都要剥：实测只剥 appId 时，队列里的 app 也是整串 AUMID。
  $clean = { param($s) ($s -replace '!.*$', '' -replace '_[a-z0-9]{6,}$', '') }
  if ($Aumid) { $raw += (& $clean $Aumid) }
  if ($AppName) { $raw += (& $clean $AppName) }
  $toks = @()
  foreach ($r in $raw) {
    foreach ($t in ($r -split '[.\\_\-/]')) {
      $s = $t.Trim()
      if ($s.Length -lt 2) { continue }
      if ($stop -contains $s.ToLowerInvariant()) { continue }
      if ($s -match '^\d+$') { continue }
      $toks += $s
    }
  }
  return ($toks | Select-Object -Unique | Sort-Object { $_.Length } -Descending)
}

# 所有匹配上的进程，按名字匹配度排序。同名多进程（Electron）全留着，由调用方逐个找窗口。
# 实测分数：QQ=100 名相等、哔哩哔哩=30 只有路径里有 bilibili、crashpad_handler 不再匹配
# 路径要按「整段」比，不能当子串比：实测 'C:\Windows\System32\mspaint.exe' 用子串比会连到
# 58 个系统进程，第一个带窗口的其实是联想的热键工具 FnHotkeyUtility —— 唤错了别人的应用。
# 整段比也躲不开 System32 这一段，所以 AUMID 自带 exe 路径时只准比文件名（-ExeOnly）：
# 那种 AUMID 已经把身份说清楚了，安装目录不该再算线索；包名型（com.bilibili.bilibiliPC）
# 没有别的线索，才允许比安装目录段。
function Get-MatchProcesses {
  param([string[]]$Tokens, [int]$SelfPid = 0, [switch]$ExeOnly)
  $rows = @()
  foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
    if ($SelfPid -gt 0 -and $p.Id -eq $SelfPid) { continue }
    $name = ''; $path = ''
    try { $name = $p.ProcessName } catch { continue }
    try { $path = $p.Path } catch {}
    $ln = $name.ToLowerInvariant()
    $segs = @()
    if ($path) { $segs = @($path -split '[\\/]' | ForEach-Object { ($_ -replace '\.[A-Za-z0-9]{1,5}$', '').ToLowerInvariant() } | Where-Object { $_ }) }
    # AUMID 已经给出 exe 路径时，只认文件名那一段：目录名（System32、software…）见谁匹配谁
    if ($ExeOnly -and $segs.Count -gt 0) { $segs = @($segs[-1]) }
    $score = 0
    foreach ($t in $Tokens) {
      $lt = $t.ToLowerInvariant()
      if ($ln -eq $lt) { $score = 100; break }
      # 两字以下的片段（QQ 就是）只允许整名相等：包含匹配会连到 QQEX、crashpad 这些同目录进程，
      # 而那类进程往往只有 IME 窗，实测会把唤回带偏。
      if ($t.Length -lt 3) { continue }
      if ($ln.Contains($lt)) { if ($score -lt 60) { $score = 60 }; continue }
      if ($segs -contains $lt) { if ($score -lt 30) { $score = 30 } }
    }
    if ($score -gt 0) { $rows += [pscustomobject]@{ proc = $p; score = $score } }
  }
  return @($rows | Sort-Object score -Descending)
}

# 从 "hwnd|vis|iconic|offscreen|面积|标题" 里挑一个最能代表「这个应用」的窗口
function Get-BestWindow {
  param([string[]]$Cands)
  $best = $null
  foreach ($c in $Cands) {
    $f = @($c.Split('|', 6))
    if ($f.Count -lt 6) { continue }
    # 在屏幕上 > 最小化 > 托盘隐藏；同级再比面积，免得挑中 1x1 的隐藏宿主
    $rank = 1
    if ($f[1] -eq '1' -and $f[3] -eq '0') { $rank = 3 }
    elseif ($f[2] -eq '1') { $rank = 2 }
    $area = [int64]0; [void][int64]::TryParse($f[4], [ref]$area)
    if (-not $best -or $rank -gt $best.rank -or ($rank -eq $best.rank -and $area -gt $best.area)) {
      $best = @{ rank = $rank; area = $area; hwnd = [IntPtr][int64]$f[0]; title = $f[5]
                 vis = ($f[1] -eq '1'); iconic = ($f[2] -eq '1'); off = ($f[3] -eq '1') }
    }
  }
  return $best
}

# 片段 + 候选进程一起算出来，命令行版和岛屿都走这一个入口。
# 两处各写一遍迟早对不上：实测 -List 分支漏传 -ExeOnly，mspaint 的误报数一直降不下来。
function Get-AppMatches {
  param([string]$Aumid, [string]$AppName, [int]$SelfPid = 0)
  $toks = Get-AumidTokens -Aumid $Aumid -AppName $AppName
  # AUMID 本身就是 exe 路径时，身份是文件名，安装目录不能再算匹配依据（见 Get-MatchProcesses 头一段）
  $exeOnly = [bool]($Aumid -match '[\\/]')
  return @{ toks = $toks; exeOnly = $exeOnly
            procs = @(Get-MatchProcesses -Tokens $toks -SelfPid $SelfPid -ExeOnly:$exeOnly) }
}

function Invoke-AppActivate {
  param([string]$Aumid, [string]$AppName, [int]$SelfPid = 0)
  $m = Get-AppMatches -Aumid $Aumid -AppName $AppName -SelfPid $SelfPid
  $toks = $m.toks
  $procs = $m.procs
  if (-not $toks) { return '没拿到可匹配的名字片段' }
  if ($procs.Count -eq 0) { return "没有进程匹配（片段：$($toks -join ',')）" }
  $seen = @()
  foreach ($c in $procs) {
    $p = $c.proc
    $cl = @(Get-IslandWindowCandidates -ProcId $p.Id)
    if ($cl.Count -eq 0) { $seen += "$($p.Id)"; continue }
    $pick = Get-BestWindow -Cands $cl
    if (-not $pick) { $seen += "$($p.Id)"; continue }
    $where = '正常'
    if ($pick.iconic) { $where = '最小化' }
    elseif ($pick.off -or -not $pick.vis) { $where = '托盘隐藏' }
    $r = [IslandWin32]::Activate($pick.hwnd)
    return "$($p.ProcessName) pid=$($p.Id) 候选 $($cl.Count) 个窗口 选[$($pick.title)]（$where）-> $r"
  }
  return "匹配到 $($procs.Count) 个进程，但都只有 IME/消息窗（跳过 pid：$($seen -join ' ')）"
}
