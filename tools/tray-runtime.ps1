# tray-runtime.ps1 —— W-5 三档托盘提示的运行时取证（只改配置让真实的岛热应用，不点托盘、不抢焦点）。
#
# 做法：备份 config.json 原始字节 -> 依次写 trigger=click/longpress/hover -> 每次在 island.out.log
# 里等 Sync-MenuLabels 打出的 `[island] 托盘提示：…` -> 最后按原始字节恢复配置并等它热应用回去。
# 这条路径改的是真实的 NotifyIcon.Text（island.ps1 里紧挨着 `$script:tray.Text = Get-TrayText` 的日志），
# 不是测试里另起一个假控件。
param(
  [string]$ConfigFile = (Join-Path $env:LOCALAPPDATA 'win-island\config.json'),
  [string]$LogFile = (Join-Path $env:LOCALAPPDATA 'win-island\island.out.log')
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'src\island\prefs.ps1')

$utf8 = New-Object System.Text.UTF8Encoding($false)
$texts = @{
  hover     = 'Windows 原子岛：悬停图标展开未读列表'
  click     = 'Windows 原子岛：左键单击图标展开未读列表'
  longpress = 'Windows 原子岛：长按图标展开未读列表'
  manual    = 'Windows 原子岛：通过托盘菜单展开未读列表'
}
function Read-Log {
  if (-not (Test-Path -LiteralPath $LogFile)) { return '' }
  # cmd 的日志包装握着写句柄，默认共享模式打不开；只读 + 允许读写者并存
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($LogFile, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $sr = New-Object System.IO.StreamReader($fs, $utf8)
    return $sr.ReadToEnd()
  } catch { return '' } finally { if ($fs) { $fs.Dispose() } }
}
function Wait-TrayLog([string]$trigger, [int]$fromLen, [int]$timeoutMs = 6000) {
  $want = '[island] 托盘提示：' + $texts[$trigger]
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $all = Read-Log
    $new = if ($all.Length -ge $fromLen) { $all.Substring($fromLen) } else { $all }
    if ($new.Contains($want)) {
      $line = @($new -split "`r?`n" | Where-Object { $_.Contains($want) })[-1]
      return [pscustomobject]@{ trigger = $trigger; found = $true; ms = [int]$sw.ElapsedMilliseconds; line = $line }
    }
    Start-Sleep -Milliseconds 100
  }
  return [pscustomobject]@{ trigger = $trigger; found = $false; ms = $timeoutMs; line = '' }
}

$hadConfig = Test-Path -LiteralPath $ConfigFile
$backup = $null
if ($hadConfig) { $backup = [System.IO.File]::ReadAllBytes($ConfigFile) }

# 原始 trigger（没配置就按默认 hover）：最后恢复时要等它热应用回去
$origTrigger = 'hover'
if ($hadConfig) {
  try {
    $cfg = (Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8) | ConvertFrom-Json
    if ($cfg -and $cfg.island -and $cfg.island.trigger) { $origTrigger = [string]$cfg.island.trigger }
  } catch { }
}

$results = @()
try {
  foreach ($tr in 'click', 'longpress', 'hover') {
    $mark = (Read-Log).Length
    [void](Write-PrefsFile $ConfigFile @{ trigger = $tr })
    $results += Wait-TrayLog $tr $mark
  }
} finally {
  if ($hadConfig) { [System.IO.File]::WriteAllBytes($ConfigFile, $backup) }
  elseif (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
}
# 恢复原始配置后，确认岛真的回到了原来的提示（不是只在盘上改了）。
# 最后一档本来就是 hover：原配置也是 hover 时没有 diff，不会再有新日志，直接按字节恢复判定。
$mark2 = (Read-Log).Length
$restore = if ($origTrigger -eq 'hover') {
  [pscustomobject]@{ trigger = 'hover'; found = $true; ms = 0; line = '（最后一档已是 hover，无需再热应用）' }
} else {
  Wait-TrayLog $origTrigger $mark2 6000
}
$after = if (Test-Path -LiteralPath $ConfigFile) { [System.IO.File]::ReadAllBytes($ConfigFile) } else { $null }
$same = ($null -eq $backup -and $null -eq $after) -or ($backup -and $after -and [Convert]::ToBase64String($backup) -eq [Convert]::ToBase64String($after))

[pscustomobject]@{
  origTrigger = $origTrigger
  results = $results
  restore = $restore
  configRestored = [bool]$same
  configBytes = if ($after) { $after.Length } else { 0 }
  log = $LogFile
} | ConvertTo-Json -Depth 5 -Compress
