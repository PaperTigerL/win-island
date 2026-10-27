# geometry.ps1 —— 悬浮件「摆在哪、多大」的纯算术，和 WPF 无关，所以能单独拿去做断言。
#
# 为什么要单拎出来：位置这件事的坑全在单位上。WPF 的 Left/Top/Width 是 DIP（设备独立像素），
# System.Windows.Forms.Screen 给的是物理像素，125%/150% 缩放的机器上两者差 1.25/1.5 倍，
# 混着用就会把岛甩到屏幕外。这里统一：对外一律 DIP，进来先按比例换算。
#
# 另一个坑是 SizeToContent=Height：面板一展开窗口高度就从 ~34 变成几百，
# 所以底部锚位要钉「下沿」而不是「上沿」，否则展开的瞬间整块会往下跳。

function Get-DipScale {
  # px/DIP。DPI 感知关掉的进程里两个值相等 -> 1，所以下面的除法始终安全
  try {
    $px = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $dip = [System.Windows.SystemParameters]::PrimaryScreenWidth
    if ($dip -le 0) { return 1.0 }
    return [double]$px / [double]$dip
  } catch { return 1.0 }
}

# 单块显示器的 DPI（96/120/144...）换算成 px/DIP。0/异常一律按 100% 处理，并夹在
# 0.5~4.0：混合 DPI 机器上 Win32 偶尔会给出 0 或离谱值，不能让它把整块 UI 缩没。
function Get-DipScaleFromDpi($dpi) {
  $v = [double]$dpi
  if (-not ($v -gt 0)) { return 1.0 }
  $s = $v / 96.0
  if ($s -lt 0.5) { return 0.5 }
  if ($s -gt 4.0) { return 4.0 }
  return $s
}

# 所有屏幕的工作区，换算成 DIP。返回 @{ X; Y; W; H; Scale; Primary } 数组。
# scaleOf 由调用方提供「这块屏的 px/DIP」；不传则退回主屏比例（单屏/旧系统行为不变）。
# screens 只为测试注入：不传时走真实 Screen.AllScreens。
function Get-DipWorkAreas($scaleOf = $null, $screens = $null) {
  if (-not $screens) { $screens = [System.Windows.Forms.Screen]::AllScreens }
  $out = @()
  foreach ($scr in @($screens)) {
    $b = $scr.WorkingArea
    $s = if ($scaleOf) { [double](& $scaleOf $scr) } else { Get-DipScale }
    if (-not ($s -gt 0)) { $s = 1.0 }
    $out += @{
      X = [double]$b.X / $s; Y = [double]$b.Y / $s
      W = [double]$b.Width / $s; H = [double]$b.Height / $s
      Scale = $s
      Primary = [bool]$scr.Primary
    }
  }
  return $out
}

function Get-PrimaryWorkArea {
  # 主屏优先用 WPF 自己的口径，省掉一次换算（也躲开主屏被负坐标排列时的取整差）
  $wa = [System.Windows.SystemParameters]::WorkArea
  return @{ X = [double]$wa.X; Y = [double]$wa.Y; W = [double]$wa.Width; H = [double]$wa.Height; Primary = $true }
}

# 岛现在挂在哪块屏上：中心点落在谁的范围内就算谁；都不在（拔了屏）就回落主屏
function Get-AnchorWorkArea($rects, $cx, $cy, $preferPrimary) {
  if ($preferPrimary) { return Get-PrimaryWorkArea }
  foreach ($r in $rects) {
    if ($cx -ge $r.X -and $cx -le ($r.X + $r.W) -and $cy -ge $r.Y -and $cy -le ($r.Y + $r.H)) { return $r }
  }
  $p = @($rects | Where-Object { $_.Primary })
  if ($p.Count) { return $p[0] }
  return Get-PrimaryWorkArea
}

# 九宫格锚位 -> 左上角 DIP 坐标。w/h 是窗口当前应有的外框尺寸
function Resolve-Anchor($anchor, $wa, $w, $h, $offX, $offY) {
  $left = [double]$wa.X; $top = [double]$wa.Y
  $right = $left + [double]$wa.W; $bottom = $top + [double]$wa.H
  $x = switch -regex ($anchor) {
    '^top-left$|^center-left$|^bottom-left$'   { $left }
    '^top-right$|^center-right$|^bottom-right$' { $right - $w }
    default                                     { $left + ($right - $left - $w) / 2 }
  }
  $y = switch -regex ($anchor) {
    '^top-left$|^top-center$|^top-right$'      { $top }
    '^bottom-left$|^bottom-center$|^bottom-right$' { $bottom - $h }
    default                                    { $top + ($bottom - $top - $h) / 2 }
  }
  return @{ X = [double]$x + $offX; Y = [double]$y + $offY }
}

# 小条贴的是哪条屏幕边：'bottom' / 'top' / ''（悬空）。
# 为什么只判上下：小条是横向的，左右贴边不改变形状。贴边判定要容差（默认 2 DIP）——
# 吸附/缩放算出来的坐标带小数，差 1px 不该被当成悬空。
# 这一项决定圆角、描边、内边距朝哪翻：以前只看「展开后会不会溢出」，于是吸附到屏幕底部、
# 还没展开时小条仍是顶部样式（上平下圆 + 下沿描边），压在最下沿看起来像被裁掉一截。
function Get-DockEdge($wa, $barY, $bar, $tol) {
  $t = if ($null -ne $tol) { [double]$tol } else { 2.0 }
  $top = [double]$wa.Y
  $bottom = $top + [double]$wa.H
  if (([double]$barY + [double]$bar) -ge ($bottom - $t)) { return 'bottom' }
  if ([double]$barY -le ($top + $t)) { return 'top' }
  return ''
}

# 「这个前台窗口算不算游戏/无边框全屏」的纯判断（2026-10-21 用户需求：游戏/全屏卡顿）。
# 为什么放这里：判断只依赖矩形/标题栏/进程名，和 WPF 无关，能单测；取窗口、取屏幕留在 island.ps1。
#   1) 必须覆盖**整块显示器**（比 Bounds 而不是 WorkingArea —— 真全屏游戏会盖住任务栏）；
#   2) 无标题栏（WS_CAPTION 缺失）= 无边框全屏，直接算；
#   3) 有标题栏的（有些游戏窗口化全屏仍带边框）只在进程名命中已知游戏名单时才算。
# 普通最大化窗口有标题栏、又不在名单里，所以不会误判 —— 那种情况归 fullscreen 配置管。
function Test-GameLike($rect, $bounds, $hasCaption, $procName, $gameProcs) {
  $tol = 2
  # 一律先转成数字：PowerShell 命令模式下带负号的参数（-2）可能被当成字符串，字符串比较会把
  # -2 > 2 判成真、整条判定就反了。
  $rl = [double]$rect.L; $rt = [double]$rect.T; $rr = [double]$rect.R; $rb = [double]$rect.B
  $bl = [double]$bounds.Left; $bt = [double]$bounds.Top; $br = [double]$bounds.Right; $bb = [double]$bounds.Bottom
  if ($rl -gt ($bl + $tol) -or $rt -gt ($bt + $tol) -or
      $rr -lt ($br - $tol) -or $rb -lt ($bb - $tol)) { return $false }
  if (-not $hasCaption) { return $true }
  if (-not $procName) { return $false }
  return (@($gameProcs) -contains ([string]$procName).ToLowerInvariant())
}

function Test-OnAnyScreen($rects, $x, $y, $w, $h) {
  # 「看得见」的标准：和某块屏的重叠至少留出一条 40x12 的边 —— 全甩出去就再也抓不回来了
  foreach ($r in $rects) {
    $ox = [Math]::Min($x + $w, $r.X + $r.W) - [Math]::Max($x, $r.X)
    $oy = [Math]::Min($y + $h, $r.Y + $r.H) - [Math]::Max($y, $r.Y)
    if ($ox -ge 40 -and $oy -ge 12) { return $true }
  }
  return $false
}

# 把自由位置拉回屏内（贴边留 1px，别把圆角切掉）；已经在屏内就原样返回
function Limit-OnScreen($rects, $x, $y, $w, $h) {
  $wa = Get-AnchorWorkArea $rects ($x + $w / 2) ($y + $h / 2) $false
  $nx = [Math]::Max([double]$wa.X, [Math]::Min([double]$x, [double]($wa.X + $wa.W - $w)))
  $ny = [Math]::Max([double]$wa.Y, [Math]::Min([double]$y, [double]($wa.Y + $wa.H - $h)))
  if (-not (Test-OnAnyScreen $rects $nx $ny $w $h)) {
    # 拖到比屏幕还宽（缩放太大）时上面会夹出一个更离谱的值，这时退回锚位而不是硬夹
    return (Resolve-Anchor 'top-center' $wa $w $h 0 0)
  }
  return @{ X = $nx; Y = $ny }
}
# 拖拽结束吸附（2026-10-21 用户需求）：距屏幕边缘或水平中心在 snapPx（默认 10 DIP）以内就贴上去。
# x/y 是小条左上角（窗口左沿 + 小条上沿），w 是窗口宽度、h 是小条高度。
# Shift 按住时调用方传 -disabled，只影响这一次拖拽，不写配置。
# 只贴「当前这块屏」的工作区：跨屏拖动时按岛中心落在谁身上算谁，和锚位/夹取用的是同一套判断。
function Get-SnapPos($rects, $x, $y, $w, $h, $snapPx, $disabled) {
  $out = @{ X = [double]$x; Y = [double]$y; Snapped = $false; Edges = @() }
  $limit = [double]$snapPx
  if ($disabled -or $limit -le 0) { return $out }
  $x = [double]$x; $y = [double]$y; $w = [double]$w; $h = [double]$h
  $wa = Get-AnchorWorkArea $rects ($x + $w / 2) ($y + $h / 2) $false
  $left = [double]$wa.X; $top = [double]$wa.Y
  $right = $left + [double]$wa.W; $bottom = $top + [double]$wa.H
  $midX = $left + ($right - $left - $w) / 2
  $edges = @()
  # 水平：左沿 / 右沿 / 水平中心，取距离最近且在阈值内的一个
  $xc = @(
    @{ V = $left;   D = [Math]::Abs($x - $left);             A = 'left' },
    @{ V = $right - $w; D = [Math]::Abs(($x + $w) - $right); A = 'right' },
    @{ V = $midX;   D = [Math]::Abs(($x + $w / 2) - ($left + $right) / 2); A = 'center-x' }
  ) | Sort-Object { [double]$_.D } | Select-Object -First 1
  if ($xc -and [double]$xc.D -le $limit) { $out.X = [double]$xc.V; $edges += $xc.A }
  # 垂直：只贴工作区上/下沿（中间位置本来就该由用户自己放）
  $yc = @(
    @{ V = $top;    D = [Math]::Abs($y - $top);            A = 'top' },
    @{ V = $bottom - $h; D = [Math]::Abs(($y + $h) - $bottom); A = 'bottom' }
  ) | Sort-Object { [double]$_.D } | Select-Object -First 1
  if ($yc -and [double]$yc.D -le $limit) { $out.Y = [double]$yc.V; $edges += $yc.A }
  $out.Edges = $edges
  $out.Snapped = ($edges.Count -gt 0)
  return $out
}

# 显示器/DPI 指纹：工作区集合 + 缩放 + monitor 配置。只有它变了才重算锚位 ——
# 普通 tick 一律不动窗口位置（用户反馈「岛自己乱跑」的一个来源）。
function Get-GeoKey($rects, $scale, $monitor) {
  $parts = foreach ($r in @($rects)) {
    $rs = if ($null -ne $r.Scale -and [double]$r.Scale -gt 0) { [double]$r.Scale } else { [double]$scale }
    "$([double]$r.X)@$([double]$r.Y)@$([double]$r.W)@$([double]$r.H)@$([int]$r.Primary)@$rs"
  }
  return "$([double]$scale)|$monitor|" + ($parts -join ';')
}
