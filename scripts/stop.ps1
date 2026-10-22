# 停掉「这份安装」的岛屿和抓取层。
#
# 为什么不再按命令行全局匹配（P1-9）：旧实现匹配所有 *island.ps1* / *capture.mjs*，在仓库里跑
# launch.ps1 会把 D:\win-island 那份正在用的实例一起杀掉。现在只认本仓库的脚本完整路径：
#   island.ps1  D:\gh-win-island\repo\src\island\island.ps1
#   capture.mjs D:\gh-win-island\repo\src\capture\capture.mjs
# 另一份副本的进程、以及它写在共享 %LOCALAPPDATA% 里的 pid 文件，一律不动。
#
# pid 文件只是「候选」：必须先确认那个 pid 的命令行属于本仓库，才敢停；pid 已被别的进程复用、
# 或文件属于另一份副本时只跳过，不删别人的文件。

$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path $PSScriptRoot
$D = Join-Path $env:LOCALAPPDATA 'win-island'
$IslandScript  = Join-Path $Root 'src\island\island.ps1'
$CaptureScript = Join-Path $Root 'src\capture\capture.mjs'
# 命令行里是完整路径；路径里的 . \ 都是正则元字符，先转义
$RxIsland  = [regex]::Escape($IslandScript)
$RxCapture = [regex]::Escape($CaptureScript)
$RxOpt = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase

function Test-Mine($cmd, $rx) {
  if (-not $cmd) { return $false }
  return [bool][regex]::IsMatch([string]$cmd, $rx, $RxOpt)
}
function Get-Proc($procId) {
  return @(Get-CimInstance Win32_Process -Filter "ProcessId=$procId")
}
function Test-ProcAlive($procId) {
  return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

$stopped = 0
foreach ($pair in @(
    @{ File = 'capture.pid'; Rx = $RxCapture; What = '抓取层' },
    @{ File = 'island.pid';  Rx = $RxIsland;  What = '岛屿'   })) {
  $p = Join-Path $D $pair.File
  if (-not (Test-Path $p)) { continue }
  $pidText = ((Get-Content $p -ErrorAction SilentlyContinue) | Out-String).Trim()
  if ($pidText -notmatch '^\d+$') { Remove-Item $p -Force -ErrorAction SilentlyContinue; continue }
  $procId = [int]$pidText
  $proc = Get-Proc $procId
  if (-not $proc) {
    # 进程已经不在了：这是本仓库上次留下的旧 pid 文件（或别家已退出的），清掉无副作用
    Remove-Item $p -Force -ErrorAction SilentlyContinue
    continue
  }
  if (-not (Test-Mine $proc.CommandLine $pair.Rx)) {
    "跳过 $($pair.File)：pid=$procId 属于另一份副本（命令行不是 $Root），不动它"
    continue
  }
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  Remove-Item $p -Force -ErrorAction SilentlyContinue
  "已停$($pair.What) pid=$procId"
  $stopped++
}

# 兜底按命令行扫描，但仍然只认本仓库的完整脚本路径
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { Test-Mine $_.CommandLine $RxCapture } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "已停抓取层 pid=$($_.ProcessId)"; $stopped++ }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { Test-Mine $_.CommandLine $RxIsland } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "已停岛屿 pid=$($_.ProcessId)"; $stopped++ }

# 再清 launch.ps1 留下的 cmd 日志包装和它的子进程。包装握着 *.out.log 的写句柄，
# 漏掉它的话下一次 launch 的 cmd 打不开日志会「静默什么都不起」；子进程命令行里往往啥都没有，
# 只按关键字匹配抓不到，所以顺着父 pid 一起端。包装的命令行里同样带本仓库脚本路径，
# 所以不会误伤另一份副本的包装。
$wrap = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
  Where-Object { (Test-Mine $_.CommandLine $RxCapture) -or (Test-Mine $_.CommandLine $RxIsland) })
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
if ($stopped -eq 0) { "本仓库这份没在跑（$Root）；另一份副本的进程一律不动" }
'已停止'
