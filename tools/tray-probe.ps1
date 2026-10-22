# tray-probe.ps1 —— 找 WinIsland 托盘图标的真实矩形（只读探测，不点、不抢焦点）。
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File tools/tray-probe.ps1 [-TargetPid <island pid>] [-Hover] [-Shot <png>]
# 输出 JSON：{pid, windows:[...], icons:[{hwnd,uID,hr,rect}], tooltips:[...], afterHover:[...], hover:{...}}
# -Hover 只会把光标移到图标中心（SetCursorPos），不点击、不抢焦点；读完提示后把光标放回原处。
param([int]$TargetPid = 0, [switch]$Hover, [string]$Shot = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Root = Split-Path $PSScriptRoot -Parent
if (-not $TargetPid) {
  $pf = Join-Path $env:LOCALAPPDATA 'win-island\island.pid'
  if (Test-Path $pf) { $TargetPid = [int]((Get-Content $pf -Raw).Trim()) }
}
if (-not $TargetPid) { throw '没有 island.pid，岛屿没在跑？' }

$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TrayProbe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wp, StringBuilder lp);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("shell32.dll")] public static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER id, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct NOTIFYICONIDENTIFIER { public uint cbSize; public IntPtr hWnd; public uint uID; public Guid guidItem; }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Txt(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Tip(IntPtr h) { var s = new StringBuilder(1024); SendMessage(h, 0x000D, (IntPtr)1024, s); return s.ToString(); }
  public static RECT Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }
  public static int IconRect(IntPtr h, uint uid, out RECT r) {
    var id = new NOTIFYICONIDENTIFIER(); id.cbSize = (uint)Marshal.SizeOf(id); id.hWnd = h; id.uID = uid; id.guidItem = Guid.Empty;
    return Shell_NotifyIconGetRect(ref id, out r);
  }
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

$wins = New-Object System.Collections.Generic.List[object]
$cb = [TrayProbe+EnumProc]{
  param($h, $l)
  $p = 0
  [void][TrayProbe]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $TargetPid) {
    $r = [TrayProbe]::Rect($h)
    $wins.Add([pscustomobject]@{
      hwnd = [int64]$h; cls = [TrayProbe]::Cls($h); title = [TrayProbe]::Txt($h)
      visible = [TrayProbe]::IsWindowVisible($h)
      rect = "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
    })
  }
  return $true
}
[void][TrayProbe]::EnumWindows($cb, [IntPtr]::Zero)

# 子窗口也扫一遍：NotifyIcon 的隐藏窗口有时挂在 WinForms 顶层窗口下面
$kids = New-Object System.Collections.Generic.List[object]
foreach ($w in $wins.ToArray()) {
  $pcb = [TrayProbe+EnumProc]{
    param($h, $l)
    $p = 0
    [void][TrayProbe]::GetWindowThreadProcessId($h, [ref]$p)
    if ($p -eq $TargetPid) {
      $r = [TrayProbe]::Rect($h)
      $kids.Add([pscustomobject]@{
        hwnd = [int64]$h; parent = $w.hwnd; cls = [TrayProbe]::Cls($h); title = [TrayProbe]::Txt($h)
        visible = [TrayProbe]::IsWindowVisible($h)
        rect = "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
      })
    }
    return $true
  }
  [void][TrayProbe]::EnumChildWindows([IntPtr]$w.hwnd, $pcb, [IntPtr]::Zero)
}

$icons = New-Object System.Collections.Generic.List[object]
foreach ($w in ($wins.ToArray() + $kids.ToArray())) {
  for ($uid = 0; $uid -le 8; $uid++) {
    $r = New-Object TrayProbe+RECT
    $hr = [TrayProbe]::IconRect([IntPtr]$w.hwnd, [uint32]$uid, [ref]$r)
    if ($hr -eq 0) {
      $icons.Add([pscustomobject]@{ hwnd = $w.hwnd; uID = $uid; hr = $hr; rect = "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)" })
    }
  }
}

# 全系统的 tooltip 窗口（托盘提示由 explorer 创建），读一下当前文本
function Get-TipWindows {
  $list = New-Object System.Collections.Generic.List[object]
  $tcb = [TrayProbe+EnumProc]{
    param($h, $l)
    $c = [TrayProbe]::Cls($h)
    if ($c -eq 'tooltips_class32') {
      $r = [TrayProbe]::Rect($h)
      $list.Add([pscustomobject]@{
        hwnd = [int64]$h; visible = [TrayProbe]::IsWindowVisible($h)
        text = [TrayProbe]::Tip($h); title = [TrayProbe]::Txt($h)
        rect = "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
      })
    }
    return $true
  }
  [void][TrayProbe]::EnumWindows($tcb, [IntPtr]::Zero)
  return $list.ToArray()
}
$tips = Get-TipWindows

# 悬停（只移动光标，不点击）：等提示出来后重扫 tooltip 窗口并截一张图
$hoverInfo = $null
$after = @()
$uiaTips = @()
$shotErr = ''
if ($Hover -and $icons.Count -gt 0) {
  $ic = $icons[0]
  $nums = @($ic.rect -split ',' | ForEach-Object { [int]$_ })
  $cx = [int](($nums[0] + $nums[2]) / 2)
  $cy = [int](($nums[1] + $nums[3]) / 2)
  $old = New-Object TrayProbe+POINT
  [void][TrayProbe]::GetCursorPos([ref]$old)
  [void][TrayProbe]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 1500
  $after = Get-TipWindows
  # UIA 也看一眼：Win10/11 的托盘气泡可能只暴露成 ToolTip 控件
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ToolTip)
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $uiaTips = @(for ($i = 0; $i -lt $found.Count; $i++) {
      $e = $found.Item($i)
      [pscustomobject]@{ name = $e.Current.Name; cls = $e.Current.ClassName; off = $e.Current.IsOffscreen }
    })
  } catch { }
  if ($Shot) {
    try {
      Add-Type -AssemblyName System.Drawing
      Add-Type -AssemblyName System.Windows.Forms
      $sw = [System.Windows.Forms.SystemInformation]::VirtualScreen.Width
      $sh = [System.Windows.Forms.SystemInformation]::VirtualScreen.Height
      $sx = [Math]::Max(0, $cx - 360); $sy = [Math]::Max(0, $cy - 220)
      $ww = [Math]::Min(720, $sw - $sx); $hh = [Math]::Min(260, $sh - $sy)
      $bmp = New-Object System.Drawing.Bitmap($ww, $hh)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($sx, $sy, 0, 0, $bmp.Size)
      $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
    } catch { $shotErr = $_.Exception.Message }
  }
  [void][TrayProbe]::SetCursorPos($old.X, $old.Y)
  $hoverInfo = @{
    icon = $ic.rect; x = $cx; y = $cy; restored = "$($old.X),$($old.Y)"
    shot = $Shot; shotError = [string]$shotErr; tips = @($after | Where-Object { [string]$_.text -ne '' })
    uia = $uiaTips
  }
}

@{ pid = $TargetPid; windows = $wins.ToArray(); children = $kids.ToArray(); icons = $icons.ToArray();
   tooltips = $tips; afterHover = $after; hover = $hoverInfo; uiaTips = $uiaTips } |
  ConvertTo-Json -Depth 6 -Compress
