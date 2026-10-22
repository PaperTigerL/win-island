# notify-runtime.ps1 —— 单向通知的运行时取证：把 notify.path 临时指向 fixture，让真实的岛热加载，
# 在 island.out.log 里等「入账 3 条」并核对源文件哈希没变；最后按原始字节恢复 config.json。
# 不写 agent-hub 的文件、不联网；fixture 由调用方准备（通常是临时目录）。
param(
  [Parameter(Mandatory = $true)][string]$Fixture,
  [string]$ConfigFile = (Join-Path $env:LOCALAPPDATA 'win-island\config.json'),
  [string]$LogFile = (Join-Path $env:LOCALAPPDATA 'win-island\island.out.log')
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Log {
  if (-not (Test-Path -LiteralPath $LogFile)) { return '' }
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($LogFile, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $sr = New-Object System.IO.StreamReader($fs, $utf8)
    return $sr.ReadToEnd()
  } catch { return '' } finally { if ($fs) { $fs.Dispose() } }
}
function Wait-Log([string]$needle, [int]$fromLen, [int]$timeoutMs = 8000) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $all = Read-Log
    $new = if ($all.Length -ge $fromLen) { $all.Substring($fromLen) } else { $all }
    if ($new.Contains($needle)) {
      return [pscustomobject]@{ found = $true; ms = [int]$sw.ElapsedMilliseconds; line = (@($new -split "`r?`n" | Where-Object { $_.Contains($needle) })[-1]) }
    }
    Start-Sleep -Milliseconds 100
  }
  return [pscustomobject]@{ found = $false; ms = $timeoutMs; line = '' }
}

$hadConfig = Test-Path -LiteralPath $ConfigFile
$backup = $null
if ($hadConfig) { $backup = [System.IO.File]::ReadAllBytes($ConfigFile) }
$hashBefore = (Get-FileHash -LiteralPath $Fixture -Algorithm SHA256).Hash
$mark = (Read-Log).Length

$changed = $false
try {
  $cfg = $null
  if ($hadConfig) {
    try { $cfg = (Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8) | ConvertFrom-Json } catch { $cfg = $null }
  }
  if (-not $cfg) { $cfg = New-Object PSObject }
  if (-not $cfg.PSObject.Properties['notify']) {
    $cfg | Add-Member -NotePropertyName notify -NotePropertyValue (New-Object PSObject) -Force
  }
  $cfg.notify | Add-Member -NotePropertyName path -NotePropertyValue $Fixture -Force
  $tmp = $ConfigFile + '.tmp'
  [System.IO.File]::WriteAllText($tmp, ($cfg | ConvertTo-Json -Depth 12), $utf8)
  Move-Item -Force $tmp $ConfigFile
  $changed = $true
  $first = Wait-Log 'notify.path ->' $mark 8000
} finally {
  if ($hadConfig) { [System.IO.File]::WriteAllBytes($ConfigFile, $backup) }
  elseif (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
}
$hashAfter = (Get-FileHash -LiteralPath $Fixture -Algorithm SHA256).Hash
$mark2 = (Read-Log).Length
$restore = Wait-Log 'notify.path ->' $mark2 8000
$after = if (Test-Path -LiteralPath $ConfigFile) { [System.IO.File]::ReadAllBytes($ConfigFile) } else { $null }
$same = ($null -eq $backup -and $null -eq $after) -or ($backup -and $after -and [Convert]::ToBase64String($backup) -eq [Convert]::ToBase64String($after))

[pscustomobject]@{
  fixture = $Fixture
  changed = $changed
  first = $first
  restore = $restore
  hashBefore = $hashBefore
  hashAfter = $hashAfter
  hashSame = ($hashBefore -eq $hashAfter)
  configRestored = [bool]$same
  log = $LogFile
} | ConvertTo-Json -Depth 5 -Compress
