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
# 再清 launch.ps1 留下的 cmd 日志包装和它的子进程。包装握着 *.out.log 的写句柄，
# 漏掉它的话下一次 launch 的 cmd 打不开日志会「静默什么都不起」；子进程（老版本留下的空跑
# REPL）命令行里往往啥都没有，只按上面的关键字匹配抓不到，所以顺着父 pid 一起端。
# 只认命令行里出现我们自己那两个日志文件名的 cmd，别拿 '*win-island*' 这种宽匹配去误杀用户的 shell。
$wrap = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'win-island\\(capture|island)\.out\.log' })
if ($wrap) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  foreach ($w in $wrap) {
    foreach ($k in ($all | Where-Object { $_.ParentProcessId -eq $w.ProcessId })) {
      Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
    "已停日志包装 pid=$($w.ProcessId)"
  }
}
'已停止'
