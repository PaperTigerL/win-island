# 语法自检：改完 .ps1 先跑这个。PowerShell 5.1 报中文错误 + 控制台 GBK，靠肉眼盯很容易漏，
# 而这里的解析器能一次性把所有语法错列出来（errors=0 才算过）。
#   powershell -File lint.ps1            查全部 .ps1
#   powershell -File lint.ps1 island     只查名字里含 island 的
param([string]$Only = '')
$files = Get-ChildItem -Path $PSScriptRoot -Filter '*.ps1' | Where-Object { $_.Name -like "*$Only*" }
$bad = 0
foreach ($f in $files) {
  $tokens = $null; $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
  $n = @($errs).Count
  if ($n -eq 0) { "OK   $($f.Name)" ; continue }
  $bad++
  "FAIL $($f.Name) errors=$n"
  foreach ($e in $errs) { "     L$($e.Extent.StartLineNumber) $($e.Message)" }
}
if ($bad) { exit 1 } else { exit 0 }
