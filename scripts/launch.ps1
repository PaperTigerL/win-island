# 启动「抓取层 + 岛屿」。
# 重启岛屿一律走这个脚本：手工 Start-Process 起的实例，如果父 shell 被杀掉，
# 出现过「进程活着但窗口从不显示」的静默失效（2026-09-26 pid 13432，vis=False 查不出来）。
param(
  [int]$HoldMs = 6000
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot          # 仓库根：脚本在 scripts\，代码在 src\
$D = Join-Path $env:LOCALAPPDATA 'win-island'
New-Item -ItemType Directory -Force -Path $D | Out-Null

# 用哪个 node：可移植包里带着 bin\node.exe（免环境安装就靠它），否则退回 PATH 上的 node。
# 解析一次写进环境变量，两个子进程都从这儿拿 —— 岛屿那边不再各解一遍。
$Node = 'node'
foreach ($c in @($env:WIN_ISLAND_NODE, (Join-Path $Root 'bin\node.exe'))) {
  if ($c -and (Test-Path $c)) { $Node = $c; break }
}
$env:WIN_ISLAND_NODE = $Node

# stop.ps1 只停本仓库这份（按脚本完整路径限定），不会碰 D:\win-island 之类的另一份副本
& (Join-Path $PSScriptRoot 'stop.ps1')

# 不能用 Start-Process -RedirectStandardOutput：一加重定向 .NET 就把 UseShellExecute 置 false，
# 而 UseShellExecute=false 等于 bInheritHandles=true —— 调用方 stdout 管道那个可继承句柄会原样
# 复制进子进程（重定向只换 STD_OUTPUT_HANDLE 槽位，旧句柄的副本还在）。于是只要岛屿还活着，
# 用管道调这个脚本的人就拿不到 EOF（2026-09-26 卡死两次）。改成让 cmd 在命令行里自己重定向：
# Start-Process 走 ShellExecute 不继承句柄，日志文件照旧，窗口照样隐藏。
function ConvertTo-CmdArg([string]$s) { if ($s -match '\s') { '"' + $s + '"' } else { $s } }
function ConvertTo-CmdQuote([string]$s) { '"' + $s + '"' }

function Start-Hidden {
  param([string]$Exe, [string[]]$Argv, [string]$Out, [string]$Err)
  $parts = New-Object System.Collections.Generic.List[string]
  $parts.Add((ConvertTo-CmdArg $Exe))
  foreach ($a in $Argv) { $parts.Add((ConvertTo-CmdArg $a)) }
  $line = ($parts -join ' ') + ' >' + (ConvertTo-CmdQuote $Out) + ' 2>' + (ConvertTo-CmdQuote $Err)
  # cmd 规则：/c 后面整串被一对引号包住时，它剥掉这一对再解析 —— 里层引号必须严格成对。
  Start-Process -FilePath $env:ComSpec -WindowStyle Hidden -WorkingDirectory $Root `
    -ArgumentList ('/c "' + $line + '"')
}

Start-Hidden $Node @((Join-Path $Root 'src\capture\capture.mjs')) `
  (Join-Path $D 'capture.out.log') (Join-Path $D 'capture.err.log')
Start-Hidden 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  (Join-Path $Root 'src\island\island.ps1'), '-HoldMs', "$HoldMs") `
  (Join-Path $D 'island.out.log') (Join-Path $D 'island.err.log')

Start-Sleep -Seconds 2
"已启动。安装根目录：$Root"
"日志目录：$D"
foreach ($f in 'capture.log', 'island.out.log', 'island.err.log', 'capture.err.log') {
  $p = Join-Path $D $f
  if (Test-Path $p) {
    $t = (Get-Content $p -Tail 3 -Encoding UTF8) -join ' / '
    if ($t) { "  $f -> $t" }
  }
}

# 同一台机器只允许一份抓取层（命名管道独占，见 capture.mjs 的单实例保护）。另一份副本正在跑时，
# 本副本的抓取层会以退出码 7 退出 —— 这是设计，不是崩溃；这里直接把原因和处理办法说出来。
$capLog = Join-Path $D 'capture.log'
if (Test-Path $capLog) {
  $capTail = @(Get-Content $capLog -Tail 8 -ErrorAction SilentlyContinue) -join ' / '
  if ($capTail -match '单实例保护') {
    $pn = $env:WIN_ISLAND_PIPE
    if (-not $pn) { $pn = '\\.\pipe\win-island' }
    "！抓取层没起来：管道 $pn 被另一份 WinIsland 占着（别去停它，那是你在用的那份）。"
    "  要并行做实验：设 WIN_ISLAND_PIPE 和 WIN_ISLAND_HOME 指向独立数据目录，再跑本脚本。"
  }
}
