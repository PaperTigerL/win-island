
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'src\island\queue.ps1')
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('win-island-queue-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$f = Join-Path $tmp 'queue.jsonl'
$noBom = New-Object System.Text.UTF8Encoding($false)
$LF = [string][char]10
function W($s) { [System.IO.File]::WriteAllText($f, $s, $noBom) }
function A($s) { [System.IO.File]::AppendAllText($f, $s, $noBom) }
$checks = New-Object System.Collections.Generic.List[object]
function Check($name, $ok, $detail) {
  $checks.Add([pscustomobject]@{ name = $name; ok = [bool]$ok; detail = [string]$detail })
}
function Ids { return ((@($script:All) | ForEach-Object { [string]$_.id }) -join ',') }
function N($x) { return @($x).Count }

# 1) 两条完整 + 第三条写了一半
W ('{"id":"1","title":"one"}' + $LF + '{"id":"2","title":"two"}' + $LF + '{"id":"3","title":"thr')
$a = @(Read-QueueNew $f 200)
Check '两条完整行先读出来' ($a.Count -eq 2) ('new=' + $a.Count)
Check 'All 里也是两条' ((@($script:All).Count) -eq 2) ('all=' + @($script:All).Count)
$off1 = $script:QueueOffset

# 2) 半行不消费、不推进 offset
$b = @(Read-QueueNew $f 200)
Check '半行不消费' ($b.Count -eq 0) ('new=' + $b.Count)
Check '半行不推进 offset' ($script:QueueOffset -eq $off1) ('offset=' + $script:QueueOffset + ' 期望=' + $off1)

# 3) 补完第三行，再追加第四行
A ('ee"}' + $LF + '{"id":"4","title":"four"}' + $LF)
$c = @(Read-QueueNew $f 200)
Check '补完后两条都进来' ($c.Count -eq 2) ('new=' + $c.Count)
Check 'id 1,2,3,4 都在' ((Ids) -eq '1,2,3,4') ('ids=' + (Ids))

# 4) 模拟抓取层轮转：整份重写成最近几行（文件变小，offset 重置）
W ('{"id":"2","title":"two"}' + $LF + '{"id":"3","title":"three"}' + $LF + '{"id":"4","title":"four"}' + $LF)
$d = @(Read-QueueNew $f 200)
Check '轮转后重复 id 不再返回' ($d.Count -eq 0) ('new=' + $d.Count)
Check '轮转后 All 不重复' ((Ids) -eq '1,2,3,4') ('ids=' + (Ids))

# 5) 重复追加同一 id，再追加新 id
A ('{"id":"4","title":"four again"}' + $LF)
$e = @(Read-QueueNew $f 200)
Check '重复追加也不返回' ($e.Count -eq 0) ('new=' + $e.Count)
A ('{"id":"5","title":"five"}' + $LF)
$g = @(Read-QueueNew $f 200)
Check '新 id 5 进来' (($g.Count -eq 1) -and ((Ids) -eq '1,2,3,4,5')) ('new=' + $g.Count + ' ids=' + (Ids))

# 6) MaxRows 生效：追加 id6 时只保留最近 3 条
A ('{"id":"6","title":"six"}' + $LF)
$h = @(Read-QueueNew $f 3)
Check 'MaxRows 生效' (($h.Count -eq 1) -and ((@($script:All).Count) -eq 3) -and ((Ids) -eq '4,5,6')) ('new=' + $h.Count + ' all=' + @($script:All).Count + ' ids=' + (Ids))

# 7) 坏行（半截 JSON + 换行）跳过，后一行照常进来
A ('{"id":' + $LF + '{"id":"7","title":"seven"}' + $LF)
$i = @(Read-QueueNew $f 200)
Check '坏行跳过、后一行照常' (($i.Count -eq 1) -and ((Ids).EndsWith('7'))) ('new=' + $i.Count + ' ids=' + (Ids))

# 8) CRLF 行尾
A ('{"id":"8","title":"eight"}' + [char]13 + $LF)
$j = @(Read-QueueNew $f 200)
Check 'CRLF 行照常' ($j.Count -eq 1) ('new=' + $j.Count)

# 9) 文件不存在
$k = @(Read-QueueNew (Join-Path $tmp 'nope.jsonl') 200)
Check '不存在的文件返回空' ($k.Count -eq 0) ('new=' + $k.Count)


# 10) live.json 对账：空 ids 是合法快照「现存 0 条」（P2-3 的坑就在 -not $o.ids 对 @() 也为真）
$now = [long]([DateTimeOffset]::Now).ToUnixTimeMilliseconds()
$rows = @(
  [pscustomobject]@{ id = '101'; ms = $now - 60000 },
  [pscustomobject]@{ id = '102'; ms = $now - 120000 },
  [pscustomobject]@{ id = '103'; ms = $now - 180000 })
$g1 = Get-LiveDiff -All $rows -LiveIds @() -SnapAt ($now - 1000) -NowMs $now -Opened @{} -Dismissed @{} -Gone @{}
Check '空 ids：所有老条目都标 gone' ((@($g1.Add) -join ',') -eq '101,102,103') ('add=' + (@($g1.Add) -join ','))
Check '空 ids：没有可撤回的' ((@($g1.Revoke).Count) -eq 0) ('revoke=' + @($g1.Revoke).Count)

# 11) live 里还在的条目不标 gone
$g2 = Get-LiveDiff -All $rows -LiveIds @('102') -SnapAt ($now - 1000) -NowMs $now -Opened @{} -Dismissed @{} -Gone @{}
Check 'live 里还在的条目不标 gone' ((@($g2.Add) -join ',') -eq '101,103') ('add=' + (@($g2.Add) -join ','))

# 12) 入库不到 15 秒不判消失（防止「人还没看到就被抹掉」）
$fresh = @([pscustomobject]@{ id = '201'; ms = $now - 5000 })
$g3 = Get-LiveDiff -All $fresh -LiveIds @() -SnapAt ($now - 1000) -NowMs $now -Opened @{} -Dismissed @{} -Gone @{}
Check '入库不到 15 秒不标 gone' ((@($g3.Add).Count) -eq 0) ('add=' + (@($g3.Add) -join ','))

# 13) 快照比条目旧（没覆盖到它）不判消失
$g4 = Get-LiveDiff -All $rows -LiveIds @() -SnapAt ($now - 300000) -NowMs $now -Opened @{} -Dismissed @{} -Gone @{}
Check '快照比条目旧时不标 gone' ((@($g4.Add).Count) -eq 0) ('add=' + (@($g4.Add) -join ','))

# 14) 已处理 / 已忽略的条目不重复标 gone
$g5 = Get-LiveDiff -All $rows -LiveIds @() -SnapAt ($now - 1000) -NowMs $now -Opened @{ '101' = $true } -Dismissed @{ '102' = $true } -Gone @{}
Check 'opened/dismissed 的不重复标 gone' ((@($g5.Add) -join ',') -eq '103') ('add=' + (@($g5.Add) -join ','))

# 15) 误判撤回：之前标过 gone，但 live 里又出现了
$g6 = Get-LiveDiff -All $rows -LiveIds @('102') -SnapAt ($now - 1000) -NowMs $now -Opened @{} -Dismissed @{} -Gone @{ '102' = $true }
Check '还在 live 里的误判要撤回' ((@($g6.Revoke) -join ',') -eq '102') ('revoke=' + (@($g6.Revoke) -join ','))

# 16) 没有 ms 的坏行不参与判定
$bad = @([pscustomobject]@{ id = '301'; ms = 0 })
$g7 = Get-LiveDiff -All $bad -LiveIds @() -SnapAt ($now - 1000) -NowMs $now -Opened @{} -Dismissed @{} -Gone @{}
Check '没有 ms 的坏行不判 gone' ((@($g7.Add).Count) -eq 0) ('add=' + (@($g7.Add) -join ','))

Remove-Item $tmp -Recurse -Force
@{ checks = $checks; count = $checks.Count } | ConvertTo-Json -Depth 6 -Compress
