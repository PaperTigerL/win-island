# 真的在常驻小条上「按下 -> 移动 -> 松手」，用来验拖拽改位置和滚轮缩放这两条链路。
# 为什么不用 UIA 的 invoke：拖拽和滚轮根本没有「可调用」的元素，判据只能是窗口矩形动了没有、
# config.json 里落没落盘（内存里改了不算，下次启动回到顶部居中就是没持久化）。
#   powershell -File drag-bar.ps1                      往左上拖一段，报告矩形和落盘结果
#   powershell -File drag-bar.ps1 -Dx 120 -Dy -300     指定位移（物理像素）
#   powershell -File drag-bar.ps1 -Wheel 3             在小条上滚 3 格（正数放大）
#   powershell -File drag-bar.ps1 -Check               只读当前矩形 + 配置，不动鼠标
# 前置：岛要在常驻态（小条高度 <60px），并且 trigger 不能是 hover —— 不然光标一压上去面板就展开，
# 量到的矩形就不是小条了。测试脚本会先把 trigger 调成 manual。
[CmdletBinding()]
param(
  [int]$Dx = -260,
  [int]$Dy = -140,
  [int]$Wheel = 0,
  [switch]$Check,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName PresentationFramework
. (Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'src/island') 'activate-lib.ps1')
# activate-lib 里的 mouse_event 只声明了 4 个参数（点击用不到 mouseData），滚轮用得到，
# 所以这里按真签名 mouse_event(flags,dx,dy,mouseData,extraInfo) 另声明一份，不往生产库里加。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IslandDrag {
  [DllImport("user32.dll")]
  static extern void mouse_event(uint flags, uint dx, uint dy, int mouseData, IntPtr extraInfo);
  const uint DOWN = 0x0002, UP = 0x0004, WHEEL = 0x0800;
  public static void Down() { mouse_event(DOWN, 0, 0, 0, IntPtr.Zero); }
  public static void Up()   { mouse_event(UP, 0, 0, 0, IntPtr.Zero); }
  public static void Wheel(int delta) { mouse_event(WHEEL, 0, 0, delta, IntPtr.Zero); }
}
'@ -Language CSharp

$D = Join-Path $env:LOCALAPPDATA 'win-island'
$Cfg = Join-Path $D 'config.json'
$ipid = [int]((Get-Content (Join-Path $D 'island.pid') | Out-String).Trim())
if (-not (Get-Process -Id $ipid -ErrorAction SilentlyContinue)) { "岛屿没在跑（pid=$ipid）"; exit 1 }

# DIP -> 物理像素：小条矩形是物理的，config 里存的 x/y 是 DIP，混着比会在 125% 机器上差出几百
function Get-Scale {
  $dip = [System.Windows.SystemParameters]::PrimaryScreenWidth
  if ($dip -le 0) { return 1.0 }
  return [double]([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width) / [double]$dip
}
function Get-Bar {
  # 岛屿主窗口的标题就是 win-island；同进程还有几个隐藏的壳窗口，按标题+可见筛掉
  foreach ($w in @(Get-IslandWindowCandidates -ProcId $ipid)) {
    $f = $w.Split('|', 6)
    if ($f[1] -ne '1') { continue }
    if ($f[5] -ne 'win-island') { continue }
    $script:ih = [IntPtr][int64]$f[0]
    return [IslandWin32]::Rect($script:ih)
  }
  return $null
}
function Get-Cfg {
  $c = (Get-Content $Cfg -Raw -Encoding UTF8) | ConvertFrom-Json
  if (-not $c.island) { return @{} }
  return $c.island
}
$s = Get-Scale
$r = Get-Bar
if (-not $r) { "找不到岛屿主窗口（pid=$ipid）"; exit 1 }
"小条矩形 px=$($r.L),$($r.T) $(($r.R-$r.L))x$(($r.B-$r.T))  DIP=$([Math]::Round($r.L/$s,1)),$([Math]::Round($r.T/$s,1))  scale=$s"
$c0 = Get-Cfg
"配置 anchor=$($c0.anchor) x=$($c0.x) y=$($c0.y) scale=$($c0.scale) trigger=$($c0.trigger)"
if ($Check) { exit 0 }
if (($r.B - $r.T) -gt 60) { "小条高度 $(($r.B-$r.T)) > 60 = 现在不是常驻态（面板/胶囊开着），先收起再测"; exit 1 }

$cx = $r.L + [int](($r.R - $r.L) / 2)
$cy = $r.T + [int](($r.B - $r.T) / 2)
if ($DryRun) { "会点 ($cx,$cy)，位移 ($Dx,$Dy)"; exit 0 }

$save = New-Object IslandWin32+PT
[void][IslandWin32]::GetCursorPos([ref]$save)
# 光标压上去以后等一帧，再确认两件事：光标还在原地（用户真人一动鼠标，合成操作就被带偏，
# 实测过点子没落到岛上），以及命中的是岛屿窗口（穿透还开着的话这点下去是别人的窗口，测出来是假绿）。
function Assert-Ready($x, $y) {
  $now = New-Object IslandWin32+PT
  for ($i = 0; $i -lt 3; $i++) {
    [void][IslandWin32]::GetCursorPos([ref]$now)
    if ($now.X -eq $x -and $now.Y -eq $y) { break }
    [void][IslandWin32]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 60
  }
  [void][IslandWin32]::GetCursorPos([ref]$now)
  if ($now.X -ne $x -or $now.Y -ne $y) { "光标停在 $($now.X),$($now.Y)，不在目标 ($x,$y) = 用户正在用鼠标，这轮测不了"; exit 1 }
  $hit = [IslandWin32]::HitTest($x, $y)
  if ($hit -ne $script:ih) { "光标压在 ($x,$y) 却命中 $hit（岛屿主窗口=$script:ih）= 穿透没关掉，不动手"; exit 1 }
  "光标对齐 ($x,$y)、命中岛屿窗口 $hit，可以继续"
}
if ($Wheel -ne 0) {
  # 滚轮要落在窗口上才有效：先把光标压到小条正中，等岛屿把穿透关掉（tick 70ms，给 400ms）
  [void][IslandWin32]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 400
  Assert-Ready $cx $cy
  $step = if ($Wheel -gt 0) { 120 } else { -120 }
  for ($i = 0; $i -lt [Math]::Abs($Wheel); $i++) {
    [IslandDrag]::Wheel($step)
    Start-Sleep -Milliseconds 140
  }
  Start-Sleep -Milliseconds 800
  $c1 = Get-Cfg
  $r1 = Get-Bar
  "滚轮后：config.scale=$($c1.scale)  矩形 px=$($r1.L),$($r1.T) $(($r1.R-$r1.L))x$(($r1.B-$r1.T))"
} else {
  [void][IslandWin32]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 400
  Assert-Ready $cx $cy
  [void][IslandDrag]::Down()
  # 按下这件事也要有凭据：读不到左键就说明这一下没落到岛上，后面量到的都是假的
  if (-not [IslandWin32]::LeftDown()) { '按下后左键状态读不到 = 这一下没按上，不测了'; exit 1 }
  $steps = 10
  for ($i = 1; $i -le $steps; $i++) {
    [void][IslandWin32]::SetCursorPos($cx + [int]($Dx * $i / $steps), $cy + [int]($Dy * $i / $steps))
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Milliseconds 120
  [void][IslandDrag]::Up()
  Start-Sleep -Milliseconds 800
  $r1 = Get-Bar
  $c1 = Get-Cfg
  "拖拽后：矩形 px=$($r1.L),$($r1.T) $(($r1.R-$r1.L))x$(($r1.B-$r1.T))"
  "落盘：anchor=$($c1.anchor) x=$($c1.x) y=$($c1.y)（期望 free + $([Math]::Round($r1.L/$s,0)),$([Math]::Round($r1.T/$s,0))）"
}
[void][IslandWin32]::SetCursorPos($save.X, $save.Y)
