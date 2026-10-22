# 命令行版：单独验证「按 AUMID 把应用唤回前台」这一层，不依赖岛屿。
#   powershell -File activate.ps1 -Aumid QQ              真的唤一次
#   powershell -File activate.ps1 -Aumid com.qoder.app -List   只看匹配到谁、有哪些窗口
# 匹配和唤回的本体都在 activate-lib.ps1，岛屿 dot-source 的是同一份。
param(
  [string]$Aumid = '',
  [string]$AppName = '',
  [switch]$List
)
$ErrorActionPreference = 'Stop'
. (Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'src/island') 'activate-lib.ps1')

if ($List) {
  $m = Get-AppMatches -Aumid $Aumid -AppName $AppName -SelfPid $PID
  foreach ($t in $m.toks) { "片段: $t" }
  "exeOnly=$($m.exeOnly) 匹配进程数: $($m.procs.Count)"
  foreach ($c in $m.procs) {
    $p = $c.proc
    "  pid=$($p.Id) score=$($c.score) $($p.ProcessName) path=$($p.Path)"
    foreach ($w in (Get-IslandWindowCandidates -ProcId $p.Id)) { "      窗口 $w" }
  }
  return
}

if (-not $Aumid -and -not $AppName) { '用法： activate.ps1 -Aumid QQ [-List]'; return }
'-> ' + (Invoke-AppActivate -Aumid $Aumid -AppName $AppName -SelfPid $PID)
