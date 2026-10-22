# 语法自检：改完 .ps1 先跑这个。PowerShell 5.1 报中文错误 + 控制台 GBK，靠肉眼盯很容易漏，
# 而这里的解析器能一次性把所有语法错列出来（errors=0 才算过）。
#   powershell -File scripts/lint.ps1            查仓库里全部 .ps1（dist/scratch/bin 不算）
#   powershell -File scripts/lint.ps1 island     只查名字里含 island 的
param([string]$Only = '')
$Root = Split-Path $PSScriptRoot
$skip = 'dist', 'scratch', 'bin', 'node_modules', '.git'
$files = Get-ChildItem -Path $Root -Recurse -Filter '*.ps1' | Where-Object {
  $rel = $_.FullName.Substring($Root.Length + 1)
  $head = ($rel -split '[\\/]')[0]
  ($skip -notcontains $head) -and ($_.Name -like "*$Only*")
}
if (-not @($files).Count) { "没找到要查的 .ps1（Only='$Only'）"; exit 1 }
$bad = 0
foreach ($f in $files) {
  $tokens = $null; $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
  $n = @($errs).Count
  $rel = $f.FullName.Substring($Root.Length + 1)
  if ($n -eq 0) { "OK   $rel" ; continue }
  $bad++
  "FAIL $rel errors=$n"
  foreach ($e in $errs) { "     L$($e.Extent.StartLineNumber) $($e.Message)" }
}
if ($bad) { exit 1 } else { exit 0 }
