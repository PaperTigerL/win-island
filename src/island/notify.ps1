# notify.ps1 —— 外部通知的单向接入：只读一份 JSONL，按 id 去重后交给面板显示。
#
# 边界（这条线不能破）：
#   1) 只读。本文件没有任何写盘、联网、起进程的代码路径；源文件读前读后哈希必须一致。
#   2) 不执行通知里的任何内容。from/title/body/level 全是展示字符串，不参与任何判定。
#   3) 文件不存在 = 没有外部通知，静默返回空，不影响岛启动。
#
# 条目归一成和队列通知同一形状（id/app/title/body/ms/at…），面板和复制逻辑不用分叉；
# 额外的 notifyOnly=true 是给 Open-Source 的闸：这类条目永远不跳来源应用。
# id 加 "notify:" 前缀，既不和通知库的自增行号撞，也不会让账本里的 [int64] 转换炸掉。
#
# 依赖：无（纯文件 IO + ConvertFrom-Json），island.ps1 dot-source 引入；测试见
# test/notify-harness.ps1（不启 WPF、不碰真实通知文件）。

$script:NotifyDefaultPath = 'D:/OpenSource/lab/sup/group/out/agent-hub/notifications.jsonl'
$script:NotifyPath = ''
$script:NotifyAll = @()
$script:NotifySeen = @{}
$script:NotifyStamp = ''

function Get-NotifyDefaultPath { return $script:NotifyDefaultPath }

# 顶层 notify 段不属于悬浮行为，所以不在 $PrefsSpec 里（不参与 config.set）。
# 解析失败/没写/空串一律回默认路径：外部文件读不到只该静默，不该让岛起不来。
function Get-NotifyPath($ConfigFile, $DefaultPath) {
  if (-not $ConfigFile -or -not (Test-Path -LiteralPath $ConfigFile)) { return $DefaultPath }
  try {
    $cfg = (Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8) | ConvertFrom-Json
    if ($cfg -and $cfg.PSObject.Properties['notify']) {
      $n = $cfg.notify
      if ($n -and $n.PSObject.Properties['path']) {
        $p = [string]$n.path
        if ($p.Trim()) { return $p.Trim() }
      }
    }
  } catch {}
  return $DefaultPath
}

# 换文件 = 旧文件那批条目全部作废（它们属于上一个来源），去重表也一起清。
function Set-NotifyPath($Path) {
  $p = [string]$Path
  if ($p -eq $script:NotifyPath) { return $false }
  $script:NotifyPath = $p
  $script:NotifyAll = @()
  $script:NotifySeen = @{}
  $script:NotifyStamp = ''
  return $true
}

function ConvertTo-NotifyItem($o) {
  if ($null -eq $o) { return $null }
  $raw = ([string]$o.id).Trim()
  if (-not $raw) { return $null }
  $ms = 0L
  $when = [datetimeoffset]::MinValue
  if ([datetimeoffset]::TryParse([string]$o.ts, [ref]$when)) { $ms = $when.ToUnixTimeMilliseconds() }
  $at = if ($ms -gt 0) { $when.LocalDateTime.ToString('HH:mm:ss') } else { [string]$o.ts }
  $from = [string]$o.from
  if (-not $from) { $from = 'agent-hub' }
  $title = [string]$o.title
  if (-not $title) { $title = '（外部通知）' }
  return [pscustomobject]@{
    id          = "notify:$raw"
    notifyOnly  = $true
    ms          = $ms
    ts          = [string]$o.ts
    at          = $at
    app         = $from
    appId       = "notify:$from"
    title       = $title
    body        = [string]$o.body
    level       = [string]$o.level
    lines       = @()
    launch      = ''
    actions     = @()
    backfilled  = $false
  }
}

# 读文件尾部的完整行（没人保证最后一行一定写完；半行下轮再说）。
# 文件被外部轮转/截断时长度指纹会变，重读不会重复：去重靠 id。
function Read-NotifyNew {
  param([string]$Path, [int]$MaxRows = 200)
  if (-not $Path) { return @() }
  if (-not (Test-Path -LiteralPath $Path)) {
    $script:NotifyStamp = ''
    return @()
  }
  $fs = $null
  try {
    $fi = Get-Item -LiteralPath $Path
    $stamp = "$($fi.LastWriteTimeUtc.Ticks)|$($fi.Length)"
    if ($stamp -eq $script:NotifyStamp) { return @() }
    $script:NotifyStamp = $stamp
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $len = [long]$fs.Length
    if ($len -le 0) { return @() }
    $from = 0L
    # 外部文件可能被别家写得很大；只读最后 16MB，别让一次读盘把 UI 线程卡住。
    if ($len -gt 16MB) { $from = $len - 16MB }
    [void]$fs.Seek($from, [System.IO.SeekOrigin]::Begin)
    $buf = New-Object byte[] ([int]($len - $from))
    $n = 0
    while ($n -lt $buf.Length) {
      $r = $fs.Read($buf, $n, $buf.Length - $n)
      if ($r -le 0) { break }
      $n += $r
    }
    if ($n -le 0) { return @() }
    $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    # 从中间开始读时第一行可能是半截：直接丢掉，避免把残片当一条通知。
    if ($from -gt 0 -and $text.Length -gt 0) {
      $nl = $text.IndexOf([char]10)
      if ($nl -ge 0) { $text = $text.Substring($nl + 1) }
    }
    $out = @()
    foreach ($ln in ($text -split ([string][char]10))) {
      $line = $ln.TrimEnd([char]13)
      if (-not $line.Trim()) { continue }
      try { $o = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
      $it = ConvertTo-NotifyItem $o
      if (-not $it) { continue }
      if ($script:NotifySeen.ContainsKey($it.id)) { continue }
      $script:NotifySeen[$it.id] = $true
      $script:NotifyAll += $it
      $out += $it
    }
    if (@($script:NotifyAll).Count -gt $MaxRows) {
      $script:NotifyAll = @($script:NotifyAll | Select-Object -Last $MaxRows)
    }
    return $out
  } catch {
    return @()
  } finally {
    if ($fs) { $fs.Dispose() }
  }
}

# 队列条目和外部通知的合并视图。排队列那套（Read-QueueNew / Get-LiveDiff）仍只认
# $script:All —— live.json 里不会有外部 id，混进去会被误判「已消失」。
function Get-AllItems { return @($script:All) + @($script:NotifyAll) }

# 排序键：优先 ms（两类条目都有时间戳），退化时用数字 id；外部 id 带前缀，解析不了就 0。
function Get-ItemTimeMs($item) {
  if ($null -eq $item) { return 0L }
  $ms = 0L
  if ($null -ne $item.ms) { [void][int64]::TryParse([string]$item.ms, [ref]$ms) }
  if ($ms -le 0) {
    $n = 0L
    if ([int64]::TryParse([string]$item.id, [ref]$n)) { $ms = $n }
  }
  return $ms
}
