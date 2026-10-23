# 账本落盘节流：纯时间判断，island.ps1 的 Save-State/Flush-State 共用，能脱开 WPF 单测。
function Test-StateFlushDue($dirty, $dueAt, $nowMs) {
  if (-not $dirty) { return $false }
  if ($null -eq $dueAt) { return $true }
  return ([double]$nowMs -ge [double]$dueAt)
}
