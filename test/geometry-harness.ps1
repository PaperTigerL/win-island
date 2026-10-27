# geometry-harness.ps1 —— 几何/判定纯函数的执行端，由 test/geometry-test.mjs 调用。
# 跑的是 src/island/geometry.ps1 的真实实现（dot-source），不是测试里复刻的一份。
# 输出一行 JSON：{ checks: [{name, ok, detail}] }
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'src\island\geometry.ps1')

$checks = New-Object System.Collections.Generic.List[object]
function Check($name, $ok, $detail) {
  $checks.Add([pscustomobject]@{ name = $name; ok = [bool]$ok; detail = [string]$detail })
}

# ---------- 游戏 / 无边框全屏判定（Test-GameLike） ----------
$bounds = @{ Left = 0; Top = 0; Right = 1920; Bottom = 1080 }
$procs = @('cs2', 'dota2', 'league of legends')
function RectOf($l, $t, $r, $b) { return @{ L = $l; T = $t; R = $r; B = $b } }

Check '整屏 + 无标题栏 = 游戏/全屏' (Test-GameLike (RectOf 0 0 1920 1080) $bounds $false '' $procs)
Check '整屏 + 有标题栏 + 非名单 = 不算（普通最大化归 fullscreen 管）' (-not (Test-GameLike (RectOf 0 0 1920 1080) $bounds $true 'chrome' $procs))
Check '整屏 + 有标题栏 + 名单内 = 算（窗口化全屏游戏）' (Test-GameLike (RectOf 0 0 1920 1080) $bounds $true 'CS2' $procs)
Check '只盖住工作区（底部少 48px，露任务栏）= 不算' (-not (Test-GameLike (RectOf 0 0 1920 1032) $bounds $false '' $procs))
Check '右边差 100px（窗口化）= 不算' (-not (Test-GameLike (RectOf 0 0 1820 1080) $bounds $false '' $procs))
Check 'DWM 外扩 2px 用容差收下' (Test-GameLike (RectOf ([int]-2) ([int]-2) 1922 1082) $bounds $false '' $procs)
Check '上沿缩进 3px（没盖满整屏）= 不算' (-not (Test-GameLike (RectOf 3 0 1920 1080) $bounds $false '' $procs))
Check '无标题栏 + 空进程名 = 算（进程名拿不到不影响判定）' (Test-GameLike (RectOf 0 0 1920 1080) $bounds $false '' $procs)
Check '有标题栏 + 空进程名 = 不算' (-not (Test-GameLike (RectOf 0 0 1920 1080) $bounds $true '' $procs))
Check '名单里没有的进程（javaw）= 不算' (-not (Test-GameLike (RectOf 0 0 1920 1080) $bounds $true 'javaw' $procs))
$boundsNeg = @{ Left = -1920; Top = 0; Right = 0; Bottom = 1080 }
Check '主屏左侧的副屏（负坐标）整屏也能算' (Test-GameLike (RectOf ([int]-1920) 0 0 1080) $boundsNeg $false '' $procs)


# ---------- 拖拽吸附（Get-SnapPos）与显示器/DPI 指纹（Get-GeoKey） ----------
$wa = @(@{ X = 0; Y = 0; W = 1920; H = 1040; Primary = $true })
function Near($a, $b) { return [Math]::Abs([double]$a - [double]$b) -lt 0.01 }

$s1 = Get-SnapPos $wa 5 100 470 30 10 $false
Check '左沿 5 DIP 内吸附到左边' ((Near $s1.X 0) -and $s1.Snapped -and ($s1.Edges -contains 'left')) ('X=' + $s1.X + ' edges=' + ($s1.Edges -join ','))
$s2 = Get-SnapPos $wa 1445 100 470 30 10 $false
Check '右沿 5 DIP 内吸附到右边' ((Near $s2.X 1450) -and ($s2.Edges -contains 'right')) ('X=' + $s2.X + ' edges=' + ($s2.Edges -join ','))
$s3 = Get-SnapPos $wa 720 100 470 30 10 $false
Check '水平中心 5 DIP 内吸附居中' ((Near $s3.X 725) -and ($s3.Edges -contains 'center-x')) ('X=' + $s3.X + ' edges=' + ($s3.Edges -join ','))
$s4 = Get-SnapPos $wa 700 8 470 30 10 $false
Check '上沿 8 DIP 内吸附到顶' ((Near $s4.Y 0) -and ($s4.Edges -contains 'top')) ('Y=' + $s4.Y + ' edges=' + ($s4.Edges -join ','))
$s5 = Get-SnapPos $wa 700 1002 470 30 10 $false
Check '下沿 8 DIP 内吸附到底' ((Near $s5.Y 1010) -and ($s5.Edges -contains 'bottom')) ('Y=' + $s5.Y + ' edges=' + ($s5.Edges -join ','))
$s6 = Get-SnapPos $wa 60 100 470 30 10 $false
Check '离边缘 60 DIP 不吸附' ((Near $s6.X 60) -and (-not $s6.Snapped)) ('X=' + $s6.X + ' snapped=' + $s6.Snapped)
$s7 = Get-SnapPos $wa 5 8 470 30 0 $false
Check 'snapPx=0 关闭吸附' ((-not $s7.Snapped) -and (Near $s7.X 5)) ('X=' + $s7.X + ' snapped=' + $s7.Snapped)
$s8 = Get-SnapPos $wa 5 8 470 30 10 $true
Check 'Shift（disabled）关闭吸附' ((-not $s8.Snapped) -and (Near $s8.X 5)) ('X=' + $s8.X + ' snapped=' + $s8.Snapped)
$waNeg = @(@{ X = -1920; Y = 0; W = 1920; H = 1040; Primary = $false }, @{ X = 0; Y = 0; W = 1920; H = 1040; Primary = $true })
$s9 = Get-SnapPos $waNeg (-1917) 100 470 30 10 $false
Check '副屏（负坐标）左沿也能吸附' ((Near $s9.X (-1920)) -and ($s9.Edges -contains 'left')) ('X=' + $s9.X + ' edges=' + ($s9.Edges -join ','))

# ---------- 贴边判定（Get-DockEdge）：圆角/描边/内边距朝哪翻靠它 ----------
$dw = @{ X = 0; Y = 0; W = 1920; H = 1080; Primary = $true }
Check '底边正好压在工作区下沿 = 贴底' ((Get-DockEdge $dw 1048 32 2) -eq 'bottom') ('dock=' + (Get-DockEdge $dw 1048 32 2))
Check '离底 1 DIP（容差内）= 贴底' ((Get-DockEdge $dw 1047 32 2) -eq 'bottom') ('dock=' + (Get-DockEdge $dw 1047 32 2))
Check '离底 3 DIP = 悬空' ((Get-DockEdge $dw 1045 32 2) -eq '') ('dock=' + (Get-DockEdge $dw 1045 32 2))
Check '贴着工作区上沿 = 贴顶' ((Get-DockEdge $dw 0 32 2) -eq 'top') ('dock=' + (Get-DockEdge $dw 0 32 2))
Check '离上沿 1 DIP（容差内）= 贴顶' ((Get-DockEdge $dw 1 32 2) -eq 'top') ('dock=' + (Get-DockEdge $dw 1 32 2))
Check '屏幕中间 = 悬空' ((Get-DockEdge $dw 500 32 2) -eq '') ('dock=' + (Get-DockEdge $dw 500 32 2))
Check '副屏（负坐标）贴底也认' ((Get-DockEdge @{ X = -1920; Y = 0; W = 1920; H = 1080 } 1048 32 2) -eq 'bottom') ('dock=' + (Get-DockEdge @{ X = -1920; Y = 0; W = 1920; H = 1080 } 1048 32 2))
$k1 = Get-GeoKey $wa 1.0 'auto'
$k2 = Get-GeoKey @(@{ X = 0; Y = 0; W = 1600; H = 860; Primary = $true }) 1.0 'auto'
Check '显示器尺寸变了 → 指纹变' ($k1 -ne $k2) ('k1=' + $k1 + ' k2=' + $k2)
$k3 = Get-GeoKey $wa 1.0 'auto'
Check '同样的几何/DPI → 指纹相同' ($k1 -eq $k3) ('k1=' + $k1 + ' k3=' + $k3)

# ---------- P1-11：按目标显示器取 DPI（纯换算 / 分屏工作区 / 指纹） ----------
Check '96 DPI → 1.0' ((Near (Get-DipScaleFromDpi 96) 1.0)) ('s=' + (Get-DipScaleFromDpi 96))
Check '120 DPI → 1.25' ((Near (Get-DipScaleFromDpi 120) 1.25)) ('s=' + (Get-DipScaleFromDpi 120))
Check '144 DPI → 1.5' ((Near (Get-DipScaleFromDpi 144) 1.5)) ('s=' + (Get-DipScaleFromDpi 144))
Check '0/无效 DPI → 回落到 1.0' ((Near (Get-DipScaleFromDpi 0) 1.0)) ('s=' + (Get-DipScaleFromDpi 0))
Check '离谱 DPI 夹到 4.0' ((Near (Get-DipScaleFromDpi 9999) 4.0)) ('s=' + (Get-DipScaleFromDpi 9999))

$fakeScreens = @(
  @{ DeviceName = 'A'; Primary = $true;  WorkingArea = @{ X = 0;    Y = 0; Width = 1920; Height = 1040 } },
  @{ DeviceName = 'B'; Primary = $false; WorkingArea = @{ X = 1920; Y = 0; Width = 2560; Height = 1400 } }
)
$scaleOf = { param($scr) if ($scr.DeviceName -eq 'B') { 2.0 } else { 1.0 } }
$dwa = @(Get-DipWorkAreas $scaleOf $fakeScreens)
Check '主屏按自己的 1.0 换算' ((Near $dwa[0].X 0) -and (Near $dwa[0].W 1920) -and (Near $dwa[0].Scale 1.0)) ('A=' + ($dwa[0] | ConvertTo-Json -Compress))
Check '副屏按自己的 2.0 换算（物理 2560→DIP 1280）' ((Near $dwa[1].X 960) -and (Near $dwa[1].W 1280) -and (Near $dwa[1].Scale 2.0)) ('B=' + ($dwa[1] | ConvertTo-Json -Compress))
Check '副屏 Y/Height 同样按 2.0 换算' ((Near $dwa[1].H 700)) ('H=' + $dwa[1].H)
Check '分屏工作区保留 Primary 标记' (([bool]$dwa[0].Primary) -and (-not [bool]$dwa[1].Primary)) ('A=' + $dwa[0].Primary + ' B=' + $dwa[1].Primary)

$rg1 = @(@{ X = 0; Y = 0; W = 1920; H = 1040; Primary = $true; Scale = 1.0 })
$rg2 = @(@{ X = 0; Y = 0; W = 1920; H = 1040; Primary = $true; Scale = 1.5 })
Check '分屏 DPI 变化 → 指纹变' ((Get-GeoKey $rg1 1.0 'auto') -ne (Get-GeoKey $rg2 1.0 'auto')) ('k1=' + (Get-GeoKey $rg1 1.0 'auto') + ' k2=' + (Get-GeoKey $rg2 1.0 'auto'))
Check '无 Scale 字段时仍用传入比例（兼容旧数据）' ((Get-GeoKey $wa 1.25 'auto').StartsWith('1.25|auto|')) ('k=' + (Get-GeoKey $wa 1.25 'auto'))

@{ checks = $checks; count = $checks.Count } | ConvertTo-Json -Depth 6 -Compress
