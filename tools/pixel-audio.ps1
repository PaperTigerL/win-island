# 频谱的「真画出来了」判据：数屏幕上亮着的像素，不看日志。
#   powershell -File pixel-audio.ps1                    一行 JSON：窗口矩形 + 亮像素数
#   powershell -File pixel-audio.ps1 -Rect x,y,w,h      只数这块（窗口左上为原点的物理像素）
#   powershell -File pixel-audio.ps1 -Shot mytag        顺带把那条存成 PNG（存 %LOCALAPPDATA%，不进仓库）
#
# 为什么需要它：日志里 bands=[0.3,0.2,…] 只证明引擎算对了，证明不了那 12 根柱子真的画到了屏幕上
# （XAML 解析失败、可见性判错、画刷没挂上，都能让「数据全对但屏幕上什么都没有」——
#  这个岛以前就发生过一次：启动日志打全了，屏幕上是空的）。
#
# 为什么要 -Rect：窗口本身是透的，整窗矩形里桌面内容会混进计数。实测过一次假信号 ——
# 频谱一开小条变宽，透过去的东西跟着换，整窗「亮像素」反而从 204 掉到 174，比不放音还少。
# 所以判据数的是渲染层自己报出来的那块（audio.json 的 barRect），柱子就画在那里面。
#
# 计的是「亮的偏蓝像素」：柱子画刷是 (76..125,141..227,192..255) 的半透明蓝青，
# 而时钟白字 (243,246,250) 的 b-r 只有 7、日期灰字 (138,148,162) 亮度不够，都被排除。
# 判据用两次采样的**差**，所以未读角标这类恒定的蓝色元素不会造成误判。
#
# 前提：岛屿在跑、island.audioOn=true、屏幕缩放 100%（GetWindowRect 与截屏坐标同为物理像素才成立）。
[CmdletBinding()]
param([string]$Shot = '', [string]$Rect = '', [int]$Watch = 0, [int]$For = 4000)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class PW {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rr, B; }
  public static List<string> Find(uint want) {
    var o = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != want || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
      if (sb.ToString().IndexOf("win-island") < 0) return true;
      R r; GetWindowRect(h, out r);
      o.Add(h + "|" + r.L + "," + r.T + "," + (r.Rr - r.L) + "," + (r.B - r.T));
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
'@
Add-Type -TypeDefinition $src

$D = Join-Path $env:LOCALAPPDATA 'win-island'
$ipid = 0
if (Test-Path (Join-Path $D 'island.pid')) {
  $ipid = [int]((Get-Content (Join-Path $D 'island.pid') | Out-String).Trim())
}
if (-not $ipid -or -not (Get-Process -Id $ipid -ErrorAction SilentlyContinue)) {
  '{"ok":false,"reason":"岛屿没在跑（读不到 island.pid 或进程不在了）"}'; exit 1
}
$found = @(([PW]::Find([uint32]$ipid)))
if ($found.Count -eq 0) { '{"ok":false,"reason":"进程在但窗口不可见（audioOn 没开就只有一排 0，也可能整条被全屏策略收了）"}'; exit 1 }

# 多个候选取最宽的那个：常驻小条比托盘/隐藏窗口宽
$best = $null
foreach ($f in $found) {
  $p = $f.Split('|')[1].Split(',')
  if (-not $best -or [int]$p[2] -gt [int]$best[2]) {
    $best = @([int]$p[0], [int]$p[1], [int]$p[2], [int]$p[3], $f.Split('|')[0])
  }
}
$l = $best[0]; $t = $best[1]; $w = $best[2]; $h = $best[3]; $hwnd = $best[4]
if ($w -lt 40 -or $h -lt 8) { ('{"ok":false,"reason":"窗口矩形太小，截不出柱子：' + $w + 'x' + $h + '"}'); exit 1 }

# -Watch 120 -For 9000：每 120ms 打一行 JSON，连着打 9 秒。为什么要有这个模式：
# 单次调用要起一个 powershell、Add-Type 一次，约 0.7 秒 —— 那个节奏跟不上一段一段门控放的和弦，
# 门一开一关各 0.7 秒的话采样点会骑在两个状态上。常驻起来截一张 470x28 的小图只要十几毫秒。
# 计数范围每 tick 从 audio.json 现读（渲染层报哪块数哪块），读不到就是柱子收了 -> lit:-1。
if ($Watch -gt 0) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $jsonFile = Join-Path $D 'audio.json'
  $t_end = (Get-Date).AddMilliseconds($For)
  while ((Get-Date) -lt $t_end) {
    $t0 = Get-Date
    $rr = $null
    try {
      $j = Get-Content $jsonFile -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($j.barRect) { $rr = $j.barRect }
    } catch { }
    if (-not $rr -or $rr.Count -ne 4) { '{"lit":-1}' }
    else {
      $bx = [Math]::Max(0, [int]$rr[0]); $by = [Math]::Max(0, [int]$rr[1])
      $bw = [Math]::Min($w - $bx, [int]$rr[2]); $bh = [Math]::Min($h - $by, [int]$rr[3])
      # 窗口会挪（展开/收起、拖拽）：每次都重新按当前窗口位置截，坐标才是同一套
      $l2 = $best[0]; $t2 = $best[1]
      $f2 = @(([PW]::Find([uint32]$ipid)))
      if ($f2.Count -gt 0) {
        $p2 = $f2[0].Split('|')[1].Split(',')
        $l2 = [int]$p2[0]; $t2 = [int]$p2[1]
      }
      $lit = 0
      if ($bw -gt 3 -and $bh -gt 3) {
        $g.CopyFromScreen($l2, $t2, 0, 0, (New-Object System.Drawing.Size($w, $h)))
        for ($y = $by; $y -lt ($by + $bh); $y++) {
          for ($x = $bx; $x -lt ($bx + $bw); $x++) {
            $c = $bmp.GetPixel($x, $y)
            if ($c.B -gt 150 -and ($c.B - $c.R) -gt 40 -and $c.G -gt 90) { $lit++ }
          }
        }
      }
      '{"lit":' + $lit + ',"ms":' + [int]((Get-Date) - $t0).TotalMilliseconds + '}'
    }
    $sp = $Watch - [int]((Get-Date) - $t0).TotalMilliseconds
    if ($sp -gt 0) { Start-Sleep -Milliseconds $sp }
  }
  $g.Dispose(); $bmp.Dispose()
  exit 0
}

# -Rect 是「窗口内的相对像素矩形」，只用来限定计数范围；截图仍然整条存（-Shot 时要看得见上下文）
$ox = 0; $oy = 0; $cw = $w; $ch = $h
if ($Rect) {
  $r = @($Rect.Split(',') | ForEach-Object { [int]$_.Trim() })
  if ($r.Count -ne 4) { '{"ok":false,"reason":"-Rect 要 x,y,w,h 四个数"}'; exit 1 }
  $ox = [Math]::Max(0, $r[0]); $oy = [Math]::Max(0, $r[1])
  # 越界就裁掉：渲染层报的块要是跑出窗口外（DPI/缩放换算错），数到桌面上的蓝东西就是假信号
  $cw = [Math]::Min($w - $ox, $r[2]); $ch = [Math]::Min($h - $oy, $r[3])
  if ($cw -lt 4 -or $ch -lt 4) { ('{"ok":false,"reason":"计数块裁完只剩 ' + $cw + 'x' + $ch + '"}'); exit 1 }
}

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$lit = 0
for ($y = $oy; $y -lt ($oy + $ch); $y++) {
  for ($x = $ox; $x -lt ($ox + $cw); $x++) {
    $c = $bmp.GetPixel($x, $y)
    # 亮的偏蓝：柱子那一族颜色。r 越低越像柱子底噪，所以再要 b-r>40
    if ($c.B -gt 150 -and ($c.B - $c.R) -gt 40 -and $c.G -gt 90) { $lit++ }
  }
}
$out = Join-Path $D 'pixel-audio.png'
if ($Shot) { $out = Join-Path $D ("pixel-audio-{0}.png" -f $Shot) }
# -Shot 才存盘：这张图上有小条内容（时间/未读数），默认不往磁盘上留多余的份
if ($Shot) { $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }
$g.Dispose(); $bmp.Dispose()
# countRect 一起报出来：lit 是这块里的数，不报块大小的话「lit 涨了」可能只是块被裁大了。
$json = '{"ok":true,"hwnd":"' + $hwnd + '","pid":' + $ipid + ',"rect":[' + $l + ',' + $t + ',' +
  $w + ',' + $h + '],"countRect":[' + $ox + ',' + $oy + ',' + $cw + ',' + $ch + '],"lit":' + $lit +
  ',"total":' + ($cw * $ch) + '}'
if ($Shot) {
  # 路径里的反斜杠必须转义：'C:\Users\…' 直接拼进 JSON 会让 node 的 JSON.parse 报
  # 「Bad escaped character」——判据读不到数，等于这条判据从来没跑过。
  $esc = $out -replace '\\', '\\'
  $json = $json.TrimEnd('}') + ',"shot":true,"path":"' + $esc + '"}'
}
$json
