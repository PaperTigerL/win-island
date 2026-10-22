param(
  [int]$HoldMs = 2500,
  [string]$Tag = 'fs-test',
  # 全屏期间顺手发一条通知：用来看 hide 档到底有没有把胶囊压住
  [switch]$Send,
  # 快照时机：窗口立起来之后过多少毫秒截。默认 1200，够主循环（~1s 一次）换过形
  [int]$SnapAt = 1200
)
# 自己造一个「真全屏」窗口（无边框、铺满整个屏幕含任务栏那条），用它来量岛屿到底认不认全屏。
# 判据是像素：截图里顶边中间是什么，就是岛屿在全屏下画出来的东西。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$sa = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.TopMost = $false
$f.BackColor = [System.Drawing.Color]::FromArgb(255, 20, 20, 25)
$f.ShowInTaskbar = $true
$f.Text = 'IslandFsTest'
[void]$f.Show()
$f.Activate()
# Bounds 要在 Show 之后设：Show 之前设会被 AutoScaleMode 按 DPI 重算，
# 症状是窗口只有 1082x660 挂在中间，测出来的「全屏行为」全是假的。
$f.SetBounds($sa.X, $sa.Y, $sa.Width, $sa.Height)
[void]$f.Refresh()
Start-Sleep -Milliseconds 900
$src = @'
using System;
using System.Runtime.InteropServices;
public class Q {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
}
'@
Add-Type -TypeDefinition $src
$h = [Q]::GetAncestor([Q]::GetForegroundWindow(), 2)
$r = New-Object Q+R
[void][Q]::GetWindowRect($h, [ref]$r)
$w = $r.Rt - $r.L
$hh = $r.B - $r.T
"全屏窗口 rect = $($r.L),$($r.T) ${w}x${hh}  (屏幕 $($sa.Width)x$($sa.Height))"
# 前台窗口不是自己造的这一个时，后面所有截图都不作数 —— 宁可报错也不要给个看起来对的图
if ($r.L -gt 0 -or $r.T -gt 0 -or $w -lt $sa.Width -or $hh -lt $sa.Height) {
  'FAIL 这个窗口没有真的铺满整屏，测不了全屏档'
  [void]$f.Close()
  exit 1
}
if ($Send) {
  & (Join-Path $PSScriptRoot 'send-test.ps1') -Title '全屏档测试' -Body 'hide 档下这条不该弹出胶囊' | Out-Host
}
Start-Sleep -Milliseconds $SnapAt
& (Join-Path $PSScriptRoot 'snap.ps1') -H 70 -Tag $Tag -CropW 700 -Scale 2 | Out-Host
Start-Sleep -Milliseconds $HoldMs
[void]$f.Close()
"已关闭测试窗口"
