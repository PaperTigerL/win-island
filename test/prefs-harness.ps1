# prefs-harness.ps1 —— 配置校验这一层的执行端，由 test/prefs-test.mjs 调用。
#
# 为什么用 PowerShell 跑而不是在测试里重算一遍：回落/夹取/联动这套规则的**唯一实现**就在
# prefs.ps1 里（那是岛屿运行时用的同一份代码）。测试里再写一份 JS 版本，测的只是我自己的副本，
# 岛屿真正会不会崩一点都没验到。
#
# 输出一行 JSON，断言全在调用方：{cases:[{name,issues,values}],write:{...}}
$ErrorActionPreference = 'Stop'
# stdout 默认跟控制台代码页走（这台机器是 GBK），Node 按 UTF-8 读就全是乱码 —— 断言会假失败
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'src\island\prefs.ps1')

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('win-island-prefs-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$noBom = New-Object System.Text.UTF8Encoding($false)

# 每一项都写成一份真实会遇到的 config.json，走 Read-Prefs 这条唯一入口
function Invoke-Case($name, $islandJson) {
  $f = Join-Path $tmp ($name + '.json')
  [void][System.IO.File]::WriteAllText($f, ('{ "island": ' + $islandJson + ' }'), $noBom)
  $p = Read-Prefs $f $null
  $vals = [ordered]@{}
  foreach ($k in (Get-PrefsSpec).Keys) { $vals[$k] = $p[$k] }
  [pscustomobject]@{ name = $name; issues = @($script:PrefsIssues); values = $vals }
}

$cases = @()
# 0) 完全没写过配置：一个键都不许掉到 null
$cases += Invoke-Case 'empty' '{ }'
# 1) 类型全错：数字位置放字符串、枚举放没见过的值、布尔放「maybe」
$cases += Invoke-Case 'wrongtype' '{ "scale":"abc", "wide":"470px", "anchor":"sideways", "clickThrough":"maybe", "holdMs":null }'
# 2) 范围越界：夹到上下限，而不是原样收下来
$cases += Invoke-Case 'clamped' '{ "hotPx":9999, "x":-99999, "scale":9, "pollMs":1, "holdMs":99999999, "wide":1 }'
# 3) 字符串写的数字要收（配置文件里 "70" 和 70 是一回事），大小写错的枚举也要收
$cases += Invoke-Case 'lenient' '{ "pollMs":"70", "trigger":"CLICK", "clickThrough":"yes", "animOn":0 }'
# 4) 联动：click/longpress 要吃点击，穿透必须自动关掉；animOn=false 三个时长归零
$cases += Invoke-Case 'imply-click' '{ "trigger":"click", "clickThrough":true }'
$cases += Invoke-Case 'imply-press' '{ "trigger":"longpress", "clickThrough":true }'
$cases += Invoke-Case 'imply-anim'  '{ "animOn":false, "fadeMs":300, "animMs":240, "slidePx":8 }'
# 5) 不认识的键：忽略并报出来，不能因为多了个错键就整份配置都不生效
$cases += Invoke-Case 'unknown' '{ "madeUpKey":7, "anchor":"bottom-center" }'
# 6) 整份 JSON 是坏的：这一轮全按默认跑，不许抛出去
$badf = Join-Path $tmp 'broken.json'
[void][System.IO.File]::WriteAllText($badf, '{ "island": { "anchor": ', $noBom)
$script:PrefsIssues = @()
$bp = Read-Prefs $badf $null
$cases += [pscustomobject]@{ name = 'broken'; issues = @($script:PrefsIssues)
  ; values = @{ anchor = $bp.anchor; scale = $bp.scale } }

# ---------- 写盘：原子、无 BOM、只动 island 段、未知键当场拒绝 ----------
$wf = Join-Path $tmp 'write.json'
[void][System.IO.File]::WriteAllText($wf, (ConvertTo-Json -Depth 8 -InputObject ([pscustomobject]@{
  weather = @{ on = $true; everyMin = 20; city = '示例市' }
  calendar = @{ on = $true; sources = @('a.ics') }
  island = @{ anchor = 'top-center'; x = -1; y = -1; scale = 1.0 }
})), $noBom)
# 一次写完整套位置（拖拽落盘就是这个形状）：不许出现「anchor 已经 free 但 x 还是 -1」的半套状态
[void](Write-PrefsFile $wf @{ anchor = 'free'; x = 120; y = 40 })
$threw = ''
try { [void](Write-PrefsFile $wf @{ madeUpKey = 1 }) } catch { $threw = $_.Exception.Message }
$after = [System.IO.File]::ReadAllBytes($wf)
$cfg = (Get-Content $wf -Raw -Encoding UTF8) | ConvertFrom-Json
$write = [pscustomobject]@{
  file = $wf
  bomFirstByte = [int]$after[0]          # 有 BOM 的话是 239（0xEF）
  bytes = $after.Length
  anchor = [string]$cfg.island.anchor
  x = [int]$cfg.island.x
  y = [int]$cfg.island.y
  scale = [double]$cfg.island.scale
  keptWeatherCity = [string]$cfg.weather.city
  keptCalendarSources = @($cfg.calendar.sources).Count
  unknownKeyThrew = $threw
  tmpLeft = Test-Path ($wf + '.tmp')     # Move-Item 之后不该留 .tmp
}

@{ cases = $cases; write = $write; tmp = $tmp } | ConvertTo-Json -Depth 8 -Compress
