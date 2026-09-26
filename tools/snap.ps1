# 截屏幕顶部一条存成 PNG，用来看岛屿画出来到底长什么样（截图里有通知正文，所以只存
# %LOCALAPPDATA%\win-island，不要往任何会 push 出去的仓库里放）。
#   powershell -File snap.ps1                 截顶部 480px
#   powershell -File snap.ps1 -Tag panel -H 520
param(
  [int]$H = 480,
  [int]$Y = 0,
  [string]$Tag = 'snap',
  [int]$CropW = 0,
  [int]$Scale = 1
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$sa = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = [Math]::Min($sa.Width, 1900)
if ($Y + $H -gt $sa.Height) { $H = $sa.Height - $Y }
$bmp = New-Object System.Drawing.Bitmap($w, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
[void]$g.CopyFromScreen($sa.X, $sa.Y + $Y, 0, 0, (New-Object System.Drawing.Size($w, $H)))
# 顶部一条按整屏宽缩到预览里根本看不清字，所以支持「只截中间一段并放大」
if ($CropW -gt 0 -and $Scale -gt 1) {
  $cx = [Math]::Max(0, [int](($w - $CropW) / 2))
  $ch = [Math]::Min($H, 200)
  # 乘法要先进普通变量再交给 New-Object：写成 Bitmap($a * $b, ...) 在 5.1 里会被当成数组传参
  $bw = $CropW * $Scale
  $bh = $ch * $Scale
  $big = New-Object System.Drawing.Bitmap($bw, $bh)
  $g2 = [System.Drawing.Graphics]::FromImage($big)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $src = New-Object System.Drawing.Rectangle($cx, 0, $CropW, $ch)
  $dst = New-Object System.Drawing.Rectangle(0, 0, $bw, $bh)
  [void]$g2.DrawImage($bmp, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
  $g2.Dispose(); $bmp.Dispose()
  $bmp = $big; $w = $bw; $H = $bh
}
$dir = Join-Path $env:LOCALAPPDATA 'win-island'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$out = Join-Path $dir "$Tag.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved $out ($w x $H)"
