# state-throttle-harness.ps1 —— 跑 src/island/state-throttle.ps1 的真实实现。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'src\island\state-throttle.ps1')

$checks = New-Object System.Collections.Generic.List[object]
function Check($name, $ok, $detail) {
  $checks.Add([pscustomobject]@{ name = $name; ok = [bool]$ok; detail = [string]$detail })
}

Check '未标脏不落盘' (-not (Test-StateFlushDue $false $null 999)) 'dirty=false'
Check '标脏但还没有 due 时间：立即到期' (Test-StateFlushDue $true $null 999) 'due=null'
Check '未到 due 时间：不落盘' (-not (Test-StateFlushDue $true 1000 999)) 'now=999 due=1000'
Check '恰好到 due：落盘' (Test-StateFlushDue $true 1000 1000) 'now=due=1000'
Check '超过 due：落盘' (Test-StateFlushDue $true 1000 1001) 'now=1001 due=1000'
Check 'due=0 视为立即到期' (Test-StateFlushDue $true 0 0) 'due=0 now=0'
Check '字符串数字也按数值比较' (-not (Test-StateFlushDue $true '1000' '999')) 'now="999" due="1000"'

@{ checks = $checks; count = $checks.Count } | ConvertTo-Json -Depth 6 -Compress
