# 测试用：发一条真实的 Windows 通知，验抓取层到岛屿的完整链路。
# 实测（2026-09-26）：未打包进程用任意 AUMID 就能把 toast 投进通知中心，
# 不需要在开始菜单快捷方式里登记 AppUserModelID —— 所以下面没有登记逻辑。
#   powershell -File send-test.ps1                                  发 1 条
#   powershell -File send-test.ps1 -Count 3                         连发 3 条（测 +N 折叠）
#   powershell -File send-test.ps1 -Launch 'ms-settings:notifications'   测点开跳转
#   powershell -File send-test.ps1 -Count 2 -GapMs 3000 -Tag probe1       测「原地更新」：同 Tag 会不会复用同一行
param(
  [string]$Aumid = 'WinIsland.Test',
  [string]$Title = 'Island test',
  [string]$Body  = 'capture pipeline check',
  [string]$Launch = '',
  [string]$Activation = 'protocol',
  [string]$Tag = '',
  [string]$Group = '',
  [int]$Count = 1,
  [int]$GapMs = 400
)
$ErrorActionPreference = 'Stop'
# 深链里全是 ; 和 = ，走命令行会被 PowerShell 的参数解析切错，所以允许从环境变量传
# 正文同理：测「复制多行消息」要带真换行和 & 符号，也只能走环境变量
if ($env:WI_LAUNCH) { $Launch = $env:WI_LAUNCH }
if ($env:WI_ACTIVATION) { $Activation = $env:WI_ACTIVATION }
if ($env:WI_BODY) { $Body = $env:WI_BODY }
if ($env:WI_TITLE) { $Title = $env:WI_TITLE }
[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]

$attrs = ''
if ($Launch) { $attrs = ' launch="{0}" activationType="{1}"' -f $Launch, $Activation }
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid)
for ($i = 1; $i -le $Count; $i++) {
  $now = Get-Date -Format 'HH:mm:ss.fff'
  $s = @"
<toast$attrs><visual><binding template="ToastGeneric">
<title>$Title #$i</title>
<text>$Body</text>
<text>seq=$i sent=$now</text>
</binding></visual></toast>
"@
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($s)
  $n = New-Object Windows.UI.Notifications.ToastNotification $doc
  # Tag 相同 = 系统语义上的「同一条通知」，第二次 Show 应当替换而不是新增；这个实验决定岛屿能不能做实时活动
  if ($Tag) { $n.Tag = $Tag }
  if ($Group) { $n.Group = $Group }
  $notifier.Show($n)
  "sent $i at $now"
  if ($i -lt $Count) { Start-Sleep -Milliseconds $GapMs }
}
"setting=" + $notifier.Setting
