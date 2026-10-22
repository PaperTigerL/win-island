# 开机（准确说：登录）自启 —— 注册 / 删除 / 查看一个计划任务。
#
# 为什么用计划任务而不是往「启动」文件夹塞快捷方式：
#   1) 这台是笔记本。任务能把电池策略写死 —— 用电池时照样起（DisallowStartIfOnBatteries=false）、
#      拔电转电池时不许被停（StopIfGoingOnBatteries=false）。快捷方式这两条一个都表达不了，
#      而「合盖搬到会议室就不启了」这种失效最难查。
#   2) 任务能查 LastTaskResult，起没起来是有据可查的，不靠「我看桌面上有岛」。
#   3) 和这台机器上 sub-updater 的做法保持一致，只有一个模式要学。
#
# 为什么触发器是 AtLogOn 而不是 AtStartup：岛屿要画窗口，必须跑在有桌面的交互会话里；
# 开机但没登录时起来的进程进不了桌面（Session 0），只会白等一次。
#
# 用法：
#   powershell -File scripts\autostart.ps1              注册（已存在就覆盖）
#   powershell -File scripts\autostart.ps1 -Status      看状态 + 上次结果
#   powershell -File scripts\autostart.ps1 -Uninstall   删掉
param(
  [switch]$Uninstall,
  [switch]$Status
)
$ErrorActionPreference = 'Stop'
$TaskName = 'win-island'
$Root = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $Root 'bin\win-island.exe'
$Desc = 'win-island：把 Windows 通知收进屏幕顶部的胶囊（抓取层 + 岛屿），登录时静默拉起'

function Show-Status {
  # 显示一律走 Write-Host：这函数同时要「返回一个退出码」，用字符串输出的话
  # `exit (Show-Status)` 会把整个输出流当成退出码（第一版就是这么静默什么都没打出来）。
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "未注册：计划任务里没有找到 $TaskName"; return 3 }
  $i = $t | Get-ScheduledTaskInfo
  $act = $t.Actions | Select-Object -First 1
  Write-Host "已注册   $TaskName"
  Write-Host ("  状态   {0}   上次运行 {1}  上次结果 0x{2:X8}" -f $t.State, $(if ($i.LastRunTime) { $i.LastRunTime } else { '从未' }), $i.LastTaskResult)
  Write-Host "  动作   $($act.Execute) $($act.Arguments)"
  Write-Host "  触发   $($t.Triggers.CimClass.CimClassName -join ', ')  (登录时)"
  # 打印的是 Settings 上真有的属性名：AllowStartIfOnBatteries 只是 -Settings 那个开关的名字，
  # CIM 实例上挂的是 DisallowStartIfOnBatteries（第一版照着参数名写，结果这行永远是空的）。
  Write-Host "  电池   DisallowStartIfOnBatteries=$($t.Settings.DisallowStartIfOnBatteries)  StopIfGoingOnBatteries=$($t.Settings.StopIfGoingOnBatteries)"
  Write-Host "  其他   重复实例=$($t.Settings.MultipleInstances)  时限=$($t.Settings.ExecutionTimeLimit)（PT0S = 不限）"
  Write-Host "  身份   LogonType=$($t.Principal.LogonType)  UserId=$($t.Principal.UserId)"
  if ($i.LastTaskResult -eq 0) { Write-Host '  上次结果 0 = 启动器正常退出（岛屿/抓取层是不是真活着看 win-island status）' }
  elseif ($i.LastTaskResult -eq 0x41303) { Write-Host '  上次结果 0x41303 = 这个任务还从来没跑过（想立刻验一遍就 schtasks /Run /TN win-island）' }
  elseif ($i.LastTaskResult -eq 0x800710E0) { Write-Host '  上次结果 0x800710E0 = 上一次还没跑完，这次被「重复实例=IgnoreNew」挡了' }
  return 0
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "已删除计划任务 $TaskName（岛屿进程没动，要停跑 scripts\stop.ps1）"
  } else { "本来就没有注册，不用删。" }
  exit 0
}

if ($Status) { exit (Show-Status) }

if (-not (Test-Path $Exe)) { throw "缺 $Exe —— 先跑 npm run build 编出启动器。" }

# 动作直接指向启动器：它是 winexe（不申请控制台），登录时不会闪黑框，所以不需要 wscript 包装。
# 走过 wscript 那一版，结论是别用：脚本一旦报错，wscript 在计划任务里弹的错误对话框没人看得见，
# 于是任务永远停在 Running，后续触发全被 IgnoreNew 挡掉（实测 LastTaskResult=0x800710E0）。
$action = New-ScheduledTaskAction -Execute $Exe -Argument 'start' -WorkingDirectory $Root

# -User 不能省：不带它的 LogonTrigger 意思是「任何用户登录」，那是管理员才能建的，
# 普通权限下 Register-ScheduledTask 直接抛 0x80070005 拒绝访问（本机实测）。
# 绑定到当前用户后同一个调用就通了，而我们要的本来也只是「他登录时上岛」。
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

# 显式写 Interactive：不写的话 Register-ScheduledTask 可能给你注册成「只在登录时运行」以外的
# 凭据类型，那种会话里画不出窗口。RunLevel Limited = 不提权，岛屿只读通知库不需要管理员。
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description $Desc -Force | Out-Null

"已注册计划任务 $TaskName"
Show-Status | Out-Host
"`n下一步（真凭据，不是「应该可以了」）："
"  schtasks /Run /TN $TaskName        # 手工触发一次，等价于登录"
"  .\bin\win-island.exe status        # 两个 pid 在不在、未读几条"
"  注销再登录                         # 想看真正的开机自启就这一条" | Out-Host
