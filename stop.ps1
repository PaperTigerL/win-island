# 停掉岛屿和抓取层。先按 pid 文件停，再按命令行兜底。
$D = Join-Path $env:LOCALAPPDATA 'win-island'
foreach ($f in 'capture.pid', 'island.pid') {
  $p = Join-Path $D $f
  if (-not (Test-Path $p)) { continue }
  $id = ((Get-Content $p -ErrorAction SilentlyContinue) | Out-String).Trim()
  if ($id -match '^\d+$') { Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue }
  Remove-Item $p -Force -ErrorAction SilentlyContinue
}
# 兜底按命令行匹配。岛屿那条只挑 powershell.exe 且命令行含 island.ps1 的；
# 停完 launch.ps1 时，它自己的命令行里没有 island.ps1（是 & (Join-Path ...) 动态拼的），不会被误杀。
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*capture.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "已停抓取层 pid=$($_.ProcessId)" }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*island.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "已停岛屿 pid=$($_.ProcessId)" }
'已停止'
