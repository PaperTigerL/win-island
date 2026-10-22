# 真的用鼠标点一下岛屿胶囊，用来测「点开胶囊 → 跳回来源应用」这条完整链路
# （computer-use 的点击要窗口句柄，而岛屿 ShowInTaskbar=False 不在它的列表里，所以自己发点击）。
# 安全：只点岛屿 pid 那个「宽 = 胶囊宽度、顶边在屏幕顶部 60px 内」的窗口，对不上就不点，
# 免得坐标算错点到用户窗口上。点完把光标放回原位。
#   powershell -File click-pill.ps1                     点屏幕上的胶囊
#   powershell -File click-pill.ps1 -DryRun             只报告要点哪儿
param(
  [int]$Wide = 470,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
. (Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'src/island') 'activate-lib.ps1')
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class IslandMouse {
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint data, uint extra, IntPtr reserved);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr h, [Out] StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public const uint DOWN = 0x0002, UP = 0x0004;
  public static RECT Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }
  // 谁在前台：只看 GetForegroundWindow，不看任何函数的返回值
  public static string Fg() {
    IntPtr h = GetForegroundWindow();
    uint pid; GetWindowThreadProcessId(h, out pid);
    var sb = new StringBuilder(256);
    int n = GetWindowTextW(h, sb, 256);
    return "hwnd=" + h + " pid=" + pid + " [" + (n > 0 ? sb.ToString(0, n) : "") + "]";
  }
}
'@ -Language CSharp

$D = Join-Path $env:LOCALAPPDATA 'win-island'
$ipid = [int]((Get-Content (Join-Path $D 'island.pid') | Out-String).Trim())
if (-not (Get-Process -Id $ipid -ErrorAction SilentlyContinue)) { "岛屿没在跑（pid=$ipid）"; exit 1 }
$cl = @(Get-IslandWindowCandidates -ProcId $ipid)
$pick = $null
foreach ($w in $cl) {
  $f = $w.Split('|', 6)
  if ($f[1] -ne '1') { continue }
  $r = [IslandMouse]::Rect([IntPtr][int64]$f[0])
  if (($r.R - $r.L) -ne $Wide) { continue }        # 不是胶囊那个宽度就别点
  if (($r.B - $r.T) -lt 40) { continue }           # 常驻把手只有 6px 高，点它会变成「上滑展开」而不是「点开通知」
  if ($r.T -gt 60 -or $r.T -lt -2) { continue }   # 胶囊只在顶部
  $pick = @{ hwnd = [IntPtr][int64]$f[0]; r = $r; title = $f[5] }
}
if (-not $pick) { "没找到符合条件的岛屿窗口（候选 $($cl.Count) 个）"; $cl | ForEach-Object { "  $_" }; exit 1 }
$r = $pick.r
$cx = $r.L + [int](($r.R - $r.L) / 2)
$cy = $r.T + [int](($r.B - $r.T) / 2)
"胶囊窗口 hwnd=$($pick.hwnd) rect=$($r.L),$($r.T) $($r.R-$r.L)x$($r.B-$r.T) -> 点 ($cx,$cy)"
if ($DryRun) { exit 0 }
$save = New-Object IslandMouse+PT
[void][IslandMouse]::GetCursorPos([ref]$save)
"点之前前台: " + [IslandMouse]::Fg()
[void][IslandMouse]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 60
# 用户正在用鼠标的时候，合成点击会被他真人的移动带偏（实测有一次点子没落到胶囊上，
# 日志里根本没有 [open]）。所以下手前再对一次坐标，最多纠正 3 次。
$now = New-Object IslandMouse+PT
for ($i = 0; $i -lt 3; $i++) {
  [void][IslandMouse]::GetCursorPos([ref]$now)
  if ($now.X -eq $cx -and $now.Y -eq $cy) { break }
  [void][IslandMouse]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 30
}
[void][IslandMouse]::mouse_event([IslandMouse]::DOWN, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 40
[void][IslandMouse]::mouse_event([IslandMouse]::UP, 0, 0, [IntPtr]::Zero)
# 岛屿里那级兜底最长要等 300ms，所以采样点放在它之后
Start-Sleep -Milliseconds 500
"点之后 +0.5s 前台: " + [IslandMouse]::Fg()
[void][IslandMouse]::SetCursorPos($save.X, $save.Y)
Start-Sleep -Milliseconds 1500
"点之后 +2.0s 前台: " + [IslandMouse]::Fg()
Start-Sleep -Milliseconds 2000
"点之后 +4.0s 前台: " + [IslandMouse]::Fg()
"光标回到 $($save.X),$($save.Y)"
