# 启动前轮转：单个日志/队列超过阈值就改名 .1，只留一份历史。
# 必须先 stop.ps1 再调用本脚本 —— Windows 上文件还被进程打开时改名会失败。
param(
  [Parameter(Mandatory = $true)][string]$DataDir,
  [long]$MaxBytes = 5MB
)
$ErrorActionPreference = 'Stop'
$names = @('capture.log', 'capture.out.log', 'capture.err.log',
           'island.out.log', 'island.err.log', 'queue.jsonl')
$done = @()
foreach ($n in $names) {
  $p = Join-Path $DataDir $n
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $len = (Get-Item -LiteralPath $p).Length
  if ($len -le $MaxBytes) { continue }
  $bak = $p + '.1'
  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force }
  Move-Item -LiteralPath $p -Destination $bak -Force
  $done += [pscustomobject]@{ file = $n; bytes = $len; to = ($n + '.1') }
}
# 永远输出数组：单条时管道会把数组拆成一个对象，调用方再按 .Count 数就会拿到空
ConvertTo-Json -InputObject @($done) -Compress -Depth 4
