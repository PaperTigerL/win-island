# 把 win-island 放进开始菜单 —— 这样在 Windows 搜索里打几个字就能找到并点开。
#
# 为什么是开始菜单目录而不是别的：搜索结果的「应用」那一栏读的就是开始菜单，
# 一个应用要被当成「应用」搜出来，唯一不需要管理员的做法是往**当前用户**的
# `Start Menu\Programs` 放一个 .lnk。`%ProgramData%\Microsoft\Windows\Start Menu` 是
# 「所有用户」那一份，普通权限写不进去（这台机器上装软件已经为此撞过 1303/1603）。
#
# 为什么不是「启动」文件夹：那个只管登录时自动跑，跟搜索找不到是两件事；
# 登录自启走的是 scripts\autostart.ps1 的计划任务（电池策略能写死、LastTaskResult 可查）。
#
# 用法：
#   powershell -File scripts\startmenu.ps1              注册（已存在就覆盖）
#   powershell -File scripts\startmenu.ps1 -Status      看快捷方式指向 + 有没有进应用列表
#   powershell -File scripts\startmenu.ps1 -Uninstall   删掉（不动正在跑的进程）
param(
  [switch]$Uninstall,
  [switch]$Status
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Exe  = Join-Path $Root 'bin\win-island.exe'
# 名字里英文和中文各留一个词：应用名就是文件名去掉 .lnk，搜索按它匹配。
# 叫「win-island 原子岛」的话，打 win-island 也中、打原子岛也中，而开始菜单里只多一条。
$Name = 'win-island 原子岛'
$Dir  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$Lnk  = Join-Path $Dir "$Name.lnk"

function Show-Entry {
  # 一律 Write-Host：这函数还要返回退出码，用字符串输出的话 `exit (Show-Entry)` 会把整个输出流当退出码。
  if (-not (Test-Path $Lnk)) { Write-Host "未注册：$Lnk 不存在"; return 3 }
  $l = (New-Object -ComObject WScript.Shell).CreateShortcut($Lnk)
  Write-Host "已注册   $Lnk"
  Write-Host "  指向   $($l.TargetPath) $($l.Arguments)"
  Write-Host "  工作   $($l.WorkingDirectory)"
  Write-Host "  图标   $($l.IconLocation)"
  Write-Host "  说明   $($l.Description)"
  if (-not (Test-Path $l.TargetPath)) { Write-Host "  ！目标文件不在盘上，点了会没反应 —— 先 npm run build" }
  # Get-StartApps 读的是系统那份「应用列表」缓存，和搜索的「应用」栏同源，
  # 所以这一步才是「真的被当成一个应用了」，而不是「文件夹里多了个文件」。
  try {
    $hit = @(Get-StartApps | Where-Object { $_.Name -like "*$Name*" })
    if ($hit.Count -eq 0) { Write-Host '  列表   Get-StartApps 里还没有（索引通常几十秒内跟上；见下面那条说明）' }
    else { foreach ($h in $hit) { Write-Host "  列表   有：$($h.Name)  AppID=$($h.AppID)" } }
  } catch {
    Write-Host "  列表   这台机器没有 Get-StartApps 这个 cmdlet（$($_.Exception.Message)），跳过这一步"
  }
  return 0
}

if ($Uninstall) {
  if (Test-Path $Lnk) {
    Remove-Item $Lnk -Force
    "已删除 $Lnk（岛屿进程没动，要停跑 scripts\stop.ps1）"
  } else { "本来就没有注册，不用删。" }
  exit 0
}

if ($Status) { exit (Show-Entry) }

if (-not (Test-Path $Exe)) { throw "缺 $Exe —— 先跑 npm run build 编出启动器。" }
if (-not (Test-Path $Dir)) { throw "开始菜单目录不存在：$Dir" }

$l = (New-Object -ComObject WScript.Shell).CreateShortcut($Lnk)
$l.TargetPath       = $Exe
# 参数写 start 而不是留空：不带参数 = status，那是给终端用的，点开一个只在控制台打字的程序
# 等于什么都没发生。start 这条自带先 stop（scripts\launch.ps1 第 20 行），所以重复点不会起两份。
$l.Arguments        = 'start'
$l.WorkingDirectory = $Root
# 图标直接取 exe 自己（资源段来自 build\version-info.res），这样托盘、任务管理器、
# 开始菜单、搜索结果四处是同一颗图，不另指 ico —— .lnk 指 ico 的话第 0 帧未必是想要的那档。
$l.IconLocation     = "$Exe,0"
$l.Description      = 'win-island：把 Windows 通知收进屏幕顶部的胶囊。点这里启动或重启'
$l.Save()

"已注册开始菜单项：$Name"
Show-Entry | Out-Host
"`n下一步（真凭据，不是「应该可以了」）："
"  按 Win 打 win 或 原子岛   # 应当出现「win-island 原子岛」，点开它" | Out-Host
"  .\bin\win-island.exe status   # 两个 pid 换了新的 = 那一下真的点着了"
