# 启动「抓取层 + 岛屿」。
# 关键细节：两个子进程都必须带 -RedirectStandardOutput，否则它们会继承调用方的 stdout 句柄，
# 谁用管道调这个脚本就永远等不到 EOF（我 2026-09-26 就是这么把自己堵死一次的）。
# 重启岛屿一律走这个脚本：手工 Start-Process 起的实例，如果父 shell 被杀掉，
# 出现过「进程活着但窗口从不显示」的静默失效（2026-09-26 pid 13432，vis=False 查不出来）。
param(
  [int]$HoldMs = 6000
)
$ErrorActionPreference = 'Stop'
$D = Join-Path $env:LOCALAPPDATA 'win-island'
New-Item -ItemType Directory -Force -Path $D | Out-Null
& (Join-Path $PSScriptRoot 'stop.ps1')

Start-Process -FilePath 'node' -ArgumentList (Join-Path $PSScriptRoot 'capture.mjs') -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $D 'capture.out.log') -RedirectStandardError (Join-Path $D 'capture.err.log')
Start-Process -FilePath 'powershell' `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'island.ps1'), '-HoldMs', "$HoldMs") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $D 'island.out.log') -RedirectStandardError (Join-Path $D 'island.err.log')

Start-Sleep -Seconds 2
"已启动。日志目录：$D"
foreach ($f in 'capture.log', 'island.out.log', 'island.err.log', 'capture.err.log') {
  $p = Join-Path $D $f
  if (Test-Path $p) {
    $t = (Get-Content $p -Tail 3) -join ' / '
    if ($t) { "  $f -> $t" }
  }
}
