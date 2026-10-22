# notify-harness.ps1 —— 单向通知接入的执行端，由 test/notify-test.mjs 调用。
#
# 跑的是 src/island/notify.ps1 的真实实现（PowerShell dot-source），不是测试里的复刻版。
# fixture 只写在临时目录，绝不碰真实的 agent-hub 文件。输出一行 JSON：{checks,fixture,hashBefore,hashAfter,tmp}
#   -Fixture <path>  调用方备好的 fixture（测试侧要在进程退出后独立复算哈希）；不传就自己造一份。
param([string]$Fixture)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'src\island\notify.ps1')

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('win-island-notify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$noBom = New-Object System.Text.UTF8Encoding($false)
$LF = [string][char]10
$checks = New-Object System.Collections.Generic.List[object]
function Check($name, $ok, $detail) {
  $checks.Add([pscustomobject]@{ name = $name; ok = [bool]$ok; detail = [string]$detail })
}
function N($x) { return @($x).Count }

# 3 条唯一 + 1 条重复 id（内容不同）+ 1 条坏行：只该显示 3 条，坏行不能挡住后面的行
$lines = @(
  '{"id":"a1","ts":"2026-10-22T15:00:00+08:00","from":"redalert","title":"第一条","body":"正文一","level":"info"}',
  '{"id":"a2","ts":"2026-10-22T15:01:00+08:00","from":"steward","title":"second","body":"body two","level":"warn"}',
  '{"id":"a1","ts":"2026-10-22T15:02:00+08:00","from":"redalert","title":"重复的那条","body":"不该出现","level":"info"}',
  'not-json-at-all',
  '{"id":"a3","ts":"2026-10-22T15:03:00+08:00","from":"infra","title":"third","body":"body three","level":"error"}'
)
$f = $Fixture
if (-not $f) {
  $f = Join-Path $tmp 'notifications.jsonl'
  [System.IO.File]::WriteAllText($f, (($lines -join $LF) + $LF), $noBom)
}
$hashBefore = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash

$new1 = @(Read-NotifyNew $f 200)
$hashAfter = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash
$ids = @($new1 | ForEach-Object { [string]$_.id })
Check '3 条唯一通知（4 条有效行里 1 条重复）' ($new1.Count -eq 3) ('new=' + $new1.Count + ' ids=' + ($ids -join ','))
Check 'All 里也是 3 条' ((N $script:NotifyAll) -eq 3) ('all=' + (N $script:NotifyAll))
Check 'id 统一加 notify: 前缀' (($ids -join ',') -eq 'notify:a1,notify:a2,notify:a3') ('ids=' + ($ids -join ','))
$first = @($new1 | Where-Object { $_.id -eq 'notify:a1' })[0]
Check 'from 落到 app' ($first.app -eq 'redalert') ('app=' + $first.app)
Check 'title/body 原样展示' (($first.title -eq '第一条') -and ($first.body -eq '正文一')) ('title=' + $first.title + ' body=' + $first.body)
Check 'level 保留' ($first.level -eq 'info') ('level=' + $first.level)
Check 'ts 解析成毫秒时间' ([long]$first.ms -gt 0) ('ms=' + $first.ms)
Check 'at 收成 HH:mm:ss' ([string]$first.at -match '^\d{2}:\d{2}:\d{2}$') ('at=' + $first.at)
Check 'notifyOnly=true（Open-Source 的闸）' ($first.notifyOnly -eq $true) ('notifyOnly=' + $first.notifyOnly)
Check '外部条目不带 launch/actions（没有可执行入口）' (([string]$first.launch -eq '') -and ((N $first.actions) -eq 0)) ('launch=' + $first.launch + ' actions=' + (N $first.actions))
Check '读前读后源文件哈希一致' ($hashBefore -eq $hashAfter) ($hashBefore + ' -> ' + $hashAfter)

# 文件没变：不重复返回
$again = @(Read-NotifyNew $f 200)
Check '同一文件未变化时返回 0 条' ($again.Count -eq 0) ('new=' + $again.Count)

# 追加一条重复 + 一条新：只返回新的。用 fixture 的副本，保证调用方给的那份源文件一个字节都没动。
$g = Join-Path $tmp 'notifications-append.jsonl'
Copy-Item -LiteralPath $f -Destination $g -Force
[void](Set-NotifyPath $g)
$b1 = @(Read-NotifyNew $g 200)
Check '换文件后重新入账 3 条' ($b1.Count -eq 3) ('new=' + $b1.Count)
[System.IO.File]::AppendAllText($g, ('{"id":"a2","ts":"2026-10-22T15:04:00+08:00","from":"steward","title":"dup","body":"x","level":"info"}' + $LF +
  '{"id":"a4","ts":"2026-10-22T15:05:00+08:00","from":"ptq","title":"fourth","body":"body four","level":"info"}' + $LF), $noBom)
$new2 = @(Read-NotifyNew $g 200)
Check '追加时重复 id 不返回、新 id 只返回 1 条' (($new2.Count -eq 1) -and ($new2[0].id -eq 'notify:a4')) ('new=' + $new2.Count + ' ids=' + (@($new2 | ForEach-Object { $_.id }) -join ','))
Check '累计 4 条' ((N $script:NotifyAll) -eq 4) ('all=' + (N $script:NotifyAll))

# 无文件：静默返回空，不抛
$missingOk = $true
$missing = @()
try { $missing = @(Read-NotifyNew (Join-Path $tmp 'nope.jsonl') 200) } catch { $missingOk = $false }
Check '文件不存在时静默返回空' ($missingOk -and $missing.Count -eq 0) ('ok=' + $missingOk + ' new=' + $missing.Count)

# notify.path 解析：有值用值、空/坏/没文件都回默认
$cfg = Join-Path $tmp 'config.json'
[System.IO.File]::WriteAllText($cfg, '{ "notify": { "path": "D:/custom/notifications.jsonl" } }', $noBom)
$p1 = Get-NotifyPath $cfg 'DEFAULT'
[System.IO.File]::WriteAllText($cfg, '{ "notify": { } }', $noBom)
$p2 = Get-NotifyPath $cfg 'DEFAULT'
[System.IO.File]::WriteAllText($cfg, '{ "notify": { "path": ', $noBom)
$p3 = Get-NotifyPath $cfg 'DEFAULT'
$p4 = Get-NotifyPath (Join-Path $tmp 'none.json') 'DEFAULT'
Check 'notify.path 有值时原样采用' ($p1 -eq 'D:/custom/notifications.jsonl') ('p=' + $p1)
Check 'notify 段为空时回默认' ($p2 -eq 'DEFAULT') ('p=' + $p2)
Check '配置读坏时回默认' ($p3 -eq 'DEFAULT') ('p=' + $p3)
Check '配置文件不存在时回默认' ($p4 -eq 'DEFAULT') ('p=' + $p4)

# 换路径：旧条目清空、去重表清空；同一路径第二次返回 false
$sw1 = Set-NotifyPath 'D:/another.jsonl'
$sw2 = Set-NotifyPath 'D:/another.jsonl'
Check 'Set-NotifyPath 换新路径返回 true' ($sw1 -eq $true) ('ret=' + $sw1)
Check '换路径后旧条目清空' ((N $script:NotifyAll) -eq 0) ('all=' + (N $script:NotifyAll))
Check '同一路径再设返回 false' ($sw2 -eq $false) ('ret=' + $sw2)

# 排序键：外部通知用 ms，队列数字 id 作为退化兜底
$t1 = Get-ItemTimeMs ([pscustomobject]@{ id = 'notify:x'; ms = 1000 })
$t2 = Get-ItemTimeMs ([pscustomobject]@{ id = '42'; ms = 0 })
Check '排序键优先用 ms' ($t1 -eq 1000) ('t=' + $t1)
Check '没有 ms 时数字 id 兜底' ($t2 -eq 42) ('t=' + $t2)

@{ checks = $checks; fixture = $f; hashBefore = $hashBefore; hashAfter = $hashAfter; tmp = $tmp } |
  ConvertTo-Json -Depth 6 -Compress
