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

# 所有屏幕的工作区，换算成 DIP。返回 @{ X; Y; W; H } 数组
function Get-DipWorkAreas {
  $s = Get-DipScale
  $out = @()
  foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $scr.WorkingArea
    $out += @{
      X = [double]$b.X / $s; Y = [double]$b.Y / $s
      W = [double]$b.Width / $s; H = [double]$b.Height / $s
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
