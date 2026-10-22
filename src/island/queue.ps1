# queue.ps1 —— island.ps1 的队列增量读取，单独成文件是为了能脱开 WPF 单独断言。
#
# 两条坑（2026-10-21 审计复现）：
#   1) append 写到一半时如果 tick 恰好读走，旧实现按「读到多少字节就推进多少」记 offset，
#      会把半行也吞掉：下一轮从半行中间开始读，那一整条通知永久丢失。这里只推进到
#      最后一个换行符，半行留在文件里等下一次。
#   2) 抓取层队列超过 512KB 会整份重写成最近 KEEP 条，文件变小 → offset 归零 → 同一批
#      id 再读一遍，旧实现直接 append 到 $script:All，面板里出现重复行、未读数虚高。
#      这里按 id 去重，轮转和 --replay 都不会重复计数。
#
# 依赖：无（纯文件 IO + ConvertFrom-Json），island.ps1 dot-source 引入；测试见
# test/queue-harness.ps1（不启 WPF、不碰真实数据目录）。

$script:QueueOffset = 0L
$script:QueueIds = @{}
$script:All = @()

function Reset-QueueReader {
  $script:QueueOffset = 0L
  $script:QueueIds = @{}
  $script:All = @()
}

# 读 Path 里「从上次 offset 起新增的完整行」，返回新条目；半行不消费、重复 id 不返回。
function Read-QueueNew {
  param([string]$Path, [int]$MaxRows = 200)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return @() }
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    # 文件变小 = 抓取层轮转/截断，从头再来。按 id 去重保证重读不会重复。
    if ($fs.Length -lt $script:QueueOffset) { $script:QueueOffset = 0L }
    [void]$fs.Seek($script:QueueOffset, [System.IO.SeekOrigin]::Begin)
    $remaining = [long]$fs.Length - $script:QueueOffset
    if ($remaining -le 0) { return @() }
    # 队列上限 512KB；这里留 16MB 余量只是防止文件被外部写坏时一次吃掉太多内存。
    if ($remaining -gt 16MB) { $remaining = 16MB }
    $buf = New-Object byte[] ([int]$remaining)
    $n = 0
    while ($n -lt $buf.Length) {
      $r = $fs.Read($buf, $n, $buf.Length - $n)
      if ($r -le 0) { break }
      $n += $r
    }
    if ($n -le 0) { return @() }
    # 只消费到最后一个换行符；末尾没有换行的半行不推进 offset。
    $lastNl = -1
    for ($i = $n - 1; $i -ge 0; $i--) {
      if ($buf[$i] -eq 10) { $lastNl = $i; break }
    }
    if ($lastNl -lt 0) { return @() }
    $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $lastNl + 1)
    $script:QueueOffset += ($lastNl + 1)
    # 理论上队列无 BOM；真有人用记事本存过一份，也在第一行前剥掉，不让整段 JSON 解析失败。
    if ($script:QueueOffset -eq ($lastNl + 1) -and $text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) {
      $text = $text.Substring(1)
    }
    # 调用方可能在 dot-source 之后自己填过 All（测试会），把去重表补齐。
    if ($script:QueueIds.Count -eq 0 -and @($script:All).Count -gt 0) {
      foreach ($it in @($script:All)) {
        if ($it -and $it.id) { $script:QueueIds[[string]$it.id] = $true }
      }
    }
    $out = @()
    foreach ($ln in ($text -split ([string][char]10))) {
      $line = $ln.TrimEnd([char]13)
      if (-not $line.Trim()) { continue }
      try { $o = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
      if (-not $o -or -not $o.id) { continue }
      $id = [string]$o.id
      if ($script:QueueIds.ContainsKey($id)) { continue }
      $script:QueueIds[$id] = $true
      $script:All += $o
      $out += $o
    }
    if (@($script:All).Count -gt $MaxRows) {
      $script:All = @($script:All | Select-Object -Last $MaxRows)
      $script:QueueIds = @{}
      foreach ($it in @($script:All)) {
        if ($it -and $it.id) { $script:QueueIds[[string]$it.id] = $true }
      }
    }
    return $out
  } catch { return @() } finally { if ($fs) { $fs.Dispose() } }
}
# live.json 对账的纯逻辑（P2-3）：抓取层每 3 秒写「通知中心里现存哪些 id」，这里算出
# 「哪些条目该标 gone / 哪些之前误判了该撤回」。和 queue 读取一样抽出来，是为了能脱开 WPF 断言。
#
# 旧实现的坑：if (-not $o.ids) { return } 对 ids:[] 也成立 —— 用户把通知中心清空后（抓取层写
# ids=[]），所有条目永远不会被标 gone（审计 P2-3）。现在空数组是合法状态：现存 0 条。
# 两道防误判的闸保留：快照比条目旧（没覆盖到它）不算，入库不到 GraceMs（默认 15 秒）不算。
function Get-LiveDiff {
  param(
    $All, [string[]]$LiveIds, [long]$SnapAt, [long]$NowMs,
    $Opened, $Dismissed, $Gone, [int]$GraceMs = 15000
  )
  $live = @{}
  foreach ($i in @($LiveIds)) { if ($null -ne $i) { $live[[string]$i] = $true } }
  $add = @()
  $revoke = @()
  foreach ($r in @($All)) {
    if ($null -eq $r) { continue }
    $id = [string]$r.id
    if (-not $id) { continue }
    if ($live.ContainsKey($id)) {
      # 判错了要能撤回：这条还在通知中心里，就说明之前那次「消失」是快照没覆盖到它（或抓取层
      # 那次写失败），不是用户划掉的。撤回比留着不管好 —— 留着它就再也回不到未读列表。
      if ($Gone -and $Gone[$id]) { $revoke += $id }
      continue
    }
    if (($Gone -and $Gone[$id]) -or ($Opened -and $Opened[$id]) -or ($Dismissed -and $Dismissed[$id])) { continue }
    $ms = [long]$r.ms
    if (-not $ms) { continue }
    if ($SnapAt -and $ms -gt $SnapAt) { continue }
    if (($NowMs - $ms) -lt $GraceMs) { continue }
    $add += $id
  }
  return @{ Add = $add; Revoke = $revoke }
}

