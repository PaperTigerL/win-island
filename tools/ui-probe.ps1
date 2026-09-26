# 用 UI Automation 看/操作岛屿面板 —— 截图只能证明「画出来了」，证明不了「列表里真有条目、
# 点得到」。WPF 的 ListBoxItem 在 UIA 里就是 ListItem，拿 BoundingRectangle 换算成屏幕坐标
# 再发一次真点击（IslandWin32::ClickAt），这条才算端到端。
#   powershell -File ui-probe.ps1                    列面板里所有条目 + 屏幕坐标
#   powershell -File ui-probe.ps1 -Swipe             把光标顶到屏幕最上边（触发上滑展开）
#   powershell -File ui-probe.ps1 -ClickRow 0        真点第 0 行（= 跳来源应用）
#   powershell -File ui-probe.ps1 -ClickRead         真点「全部已读」
#   powershell -File ui-probe.ps1 -Away              把光标挪到屏幕下方（让面板收起）
#   powershell -File ui-probe.ps1 -Dump              列面板里所有文本元素（验证时钟/日程段真渲染了）
#   powershell -File ui-probe.ps1 -Shot panel6       一次进程里完成「上滑 -> 截图 -> 收起」，
#                                                    免得人手一动鼠标，面板就在两步之间收掉了
#   powershell -File ui-probe.ps1 -CopyRow 0         端到端验复制：上滑展开 -> 真右键那一行 ->
#                                                    在 UIA 里找到菜单项 -> 真点它 -> 回读剪贴板
#   powershell -File ui-probe.ps1 -FsCycle           端到端验全屏换档：右键胶囊 -> 点「全屏时：…」
#                                                    -> 回读 config.json（顺带验它没有 BOM）
[CmdletBinding()]
param(
  [int]$ClickRow = -1,
  [switch]$Swipe,
  [switch]$ClickRead,
  [switch]$Away,
  [switch]$Dump,
  [switch]$FsCycle,
  [string]$Shot = '',
  [int]$CopyRow = -1,
  [string]$CopyMatch = '',
  [string]$CopyVia = 'chip',
  [string]$CopyMenu = '复制这条（完整正文）'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'src/island') 'activate-lib.ps1')

$D = Join-Path $env:LOCALAPPDATA 'win-island'
$ipid = [int]((Get-Content (Join-Path $D 'island.pid') | Out-String).Trim())
if (-not (Get-Process -Id $ipid -ErrorAction SilentlyContinue)) { "岛屿没在跑（pid=$ipid）"; exit 1 }
$sa = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

if ($Swipe) {
  $x = [int]($sa.X + $sa.Width / 2)
  [IslandWin32]::MoveTo($x, $sa.Y + 1)
  Start-Sleep -Milliseconds 500
  "光标顶到 ($x,$($sa.Y + 1))，现在光标在 $([IslandWin32]::CursorX()),$([IslandWin32]::CursorY())"
  exit 0
}
if ($Away) {
  [IslandWin32]::MoveTo([int]($sa.X + $sa.Width / 2), [int]($sa.Y + $sa.Height - 100))
  "光标挪到屏幕下方，面板应在 0.5s 内收起"
  exit 0
}
if ($Shot) {
  # 同一个进程里 dot-source snap.ps1：另起一个 powershell 要几百毫秒，面板可能已经收了
  $x = [int]($sa.X + $sa.Width / 2)
  [IslandWin32]::MoveTo($x, $sa.Y + 1)
  Start-Sleep -Milliseconds 450
  & (Join-Path $PSScriptRoot 'snap.ps1') -H 620 -Tag $Shot
  [IslandWin32]::MoveTo($x, [int]($sa.Y + $sa.Height - 120))
  exit 0
}

# 岛屿 ShowInTaskbar=False、不在任务栏，但它是真顶层窗口，按 pid 从根节点找得到
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $ipid)
$win = $AE::RootElement.FindFirst($TS::Children, $cond)
if (-not $win) { "UIA 里找不到岛屿窗口（pid=$ipid）"; exit 1 }
$wr = $win.Current.BoundingRectangle
"岛屿窗口 rect=$([int]$wr.X),$([int]$wr.Y) $([int]$wr.Width)x$([int]$wr.Height)"

function Find-Texts($el) {
  return $el.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Text)))
}
if ($FsCycle) {
  # 换档这条要真点出来：发通知撑出胶囊 -> 右键 -> UIA 找到「全屏时：…」-> 真点 -> 回读磁盘上的 config.json。
  # 只看日志不算数：写回 config.json 必须无 BOM，带 BOM 了 node 那边 JSON.parse 直接炸。
  $before = (Get-Content (Join-Path $D 'config.json') -Raw)
  & (Join-Path $PSScriptRoot 'send-test.ps1') -Title '全屏档菜单测试' -Body '右键换档' | Out-Host
  Start-Sleep -Milliseconds 900
  $w2 = $AE::RootElement.FindFirst($TS::Children, $cond)
  $r = $w2.Current.BoundingRectangle
  $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + [Math]::Min(40, $r.Height / 2))
  "[右键] 胶囊 $([int]$r.X),$([int]$r.Y) $([int]$r.Width)x$([int]$r.Height) -> $cx,$cy " + [IslandWin32]::RightClickAt($cx, $cy)
  Start-Sleep -Milliseconds 500
  $m = $null
  $all = $AE::RootElement.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::MenuItem)))
  for ($i = 0; $i -lt $all.Count; $i++) {
    if ($all.Item($i).Current.Name -like '全屏时：*') { $m = $all.Item($i); break }
  }
  if (-not $m) { "UIA 里没找到「全屏时：…」菜单项（当场 MenuItem 共 $($all.Count) 个）= 菜单没弹出"; exit 1 }
  $mr = $m.Current.BoundingRectangle
  "[菜单] 「$($m.Current.Name)」在 $([int]$mr.X),$([int]$mr.Y)"
  [void][IslandWin32]::ClickAt([int]($mr.X + $mr.Width / 2), [int]($mr.Y + $mr.Height / 2))
  Start-Sleep -Milliseconds 600
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $D 'config.json'))
  $bom = if ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { '有 BOM（node 会炸）' } else { '无 BOM' }
  $after = (Get-Content (Join-Path $D 'config.json') -Raw)
  "config.json：$bom / $($bytes.Length) 字节"
  "  换档前: " + (($before  | ConvertFrom-Json).island.fullscreen)
  "  换档后: " + (($after  | ConvertFrom-Json).island.fullscreen)
  # 别的段不能被这次写回弄丢（weather/calendar 是抓取层在读的）
  $lost = @()
  foreach ($k in (@((($before | ConvertFrom-Json).PSObject.Properties.Name)))) {
    if (-not (($after | ConvertFrom-Json).PSObject.Properties.Name) -contains $k) { $lost += $k }
  }
  if ($lost.Count) { "换档把这几段写丢了：$($lost -join ',')"; exit 1 }
  "其余段还在：$((($after | ConvertFrom-Json).PSObject.Properties.Name) -join ',')"
  exit 0
}
if ($ClickRead) {
  $t = Find-Texts $win
  for ($i = 0; $i -lt $t.Count; $i++) {
    if ($t.Item($i).Current.Name -eq '全部已读') {
      $r = $t.Item($i).Current.BoundingRectangle
      [IslandWin32]::ClickAt([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
      exit 0
    }
  }
  '面板里没有「全部已读」= 现在不是展开态'; exit 1
}

$items = $win.FindAll($TS::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::ListItem)))
if ($Dump) {
  # 日程那段是 ItemsControl，不产 ListItem，所以只数 ListItem 会漏掉它 —— 文本元素才看得全
  $tx = Find-Texts $win
  "文本元素 $($tx.Count) 个："
  for ($i = 0; $i -lt $tx.Count; $i++) {
    $e = $tx.Item($i); $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    "  $([int]$r.X),$([int]$r.Y) $([int]$r.Width)x$([int]$r.Height)  [$($e.Current.Name)]"
  }
}
if ($items.Count -eq 0) { '面板里没有 ListItem（未展开，或未读为 0）' } else { "ListItem $($items.Count) 行：" }
for ($i = 0; $i -lt $items.Count; $i++) {
  $it = $items.Item($i)
  $r = $it.Current.BoundingRectangle
  $txt = Find-Texts $it
  $parts = @()
  for ($j = 0; $j -lt [Math]::Min($txt.Count, 4); $j++) { $parts += $txt.Item($j).Current.Name }
  "  [$i] $([int]$r.X),$([int]$r.Y) $([int]$r.Width)x$([int]$r.Height)  " + ($parts -join ' | ')
}
if ($ClickRow -ge 0) {
  if ($ClickRow -ge $items.Count) { "只有 $($items.Count) 行，点不了第 $ClickRow 行"; exit 1 }
  $r = $items.Item($ClickRow).Current.BoundingRectangle
  [IslandWin32]::ClickAt([int]($r.X + 60), [int]($r.Y + $r.Height / 2))
}

if ($CopyRow -ge 0) {
  # 判据只有一个：Get-Clipboard 读回来的东西和这条通知的原文逐字相等。
  # 日志里那句「已复制 N 行」是自己写的，证明不了系统剪贴板里真有它。
  #
  # 整个动作必须在同一个进程里做完：上滑撑开面板 -> 找行 -> 右键 -> 点菜单项。
  # 分成两次进程的话，前一次进程退出时光标一动，面板 0.5s 内就收了，第二次右键会点到空处
  # （2026-09-26 实测：rect 变成 230x209 的胶囊态，ListItem 0 行）。
  $x = [int]($sa.X + $sa.Width / 2)
  [IslandWin32]::MoveTo($x, $sa.Y + 1)
  Start-Sleep -Milliseconds 550
  $win = $AE::RootElement.FindFirst($TS::Children, $cond)
  if (-not $win) { "上滑后 UIA 里找不到岛屿窗口"; exit 1 }
  $items = $win.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::ListItem)))
  if ($CopyMatch) {
    # 未读列表里第几行取决于当时有多少条，测试按标题文本自己定位，不写死下标
    for ($i = 0; $i -lt $items.Count; $i++) {
      $t = Find-Texts $items.Item($i)
      $joined = ''
      for ($j = 0; $j -lt $t.Count; $j++) { $joined += $t.Item($j).Current.Name }
      if ($joined -like "*$CopyMatch*") { $CopyRow = $i; break }
    }
    "按「$CopyMatch」定位到第 $CopyRow 行（共 $($items.Count) 行）"
  }
  if ($CopyRow -ge $items.Count) { "只有 $($items.Count) 行，复制不了第 $CopyRow 行"; exit 1 }
  $r = $items.Item($CopyRow).Current.BoundingRectangle
  $rx = [int]($r.X + 60); $ry = [int]($r.Y + $r.Height / 2)
  # 光标先落到那一行：一是让「复制」那颗悬停 chip 显形（模板里靠 IsMouseOver 触发），
  # 二是右键时命中 ListBoxItem 才会把 rowTarget 设成这条；光标停在列表区内，菜单弹出时面板不会同时收起
  [IslandWin32]::MoveTo($rx, $ry)
  Start-Sleep -Milliseconds 260
  if ($CopyVia -eq 'chip') {
    $btn = $null
    $t = Find-Texts $items.Item($CopyRow)
    for ($j = 0; $j -lt $t.Count; $j++) {
      if ($t.Item($j).Current.Name -eq '复制') { $btn = $t.Item($j); break }
    }
    if (-not $btn) { "第 $CopyRow 行里没有「复制」这个文本元素 = 没显形或模板没渲染"; exit 1 }
    $br = $btn.Current.BoundingRectangle
    "[悬停] 「复制」在 $([int]$br.X),$([int]$br.Y) $([int]$br.Width)x$([int]$br.Height)"
    [void][IslandWin32]::ClickAt([int]($br.X + $br.Width / 2), [int]($br.Y + $br.Height / 2))
  } else {
    "[右键] $([IslandWin32]::RightClickAt($rx, $ry))"
    Start-Sleep -Milliseconds 450
    $cond2 = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::MenuItem)),
      (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $CopyMenu)))
    $m = $AE::RootElement.FindFirst($TS::Descendants, $cond2)
    if (-not $m) {
      $all = $AE::RootElement.FindAll($TS::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::MenuItem)))
      "UIA 里找不到菜单项「$CopyMenu」（当场可见的 MenuItem 共 $($all.Count) 个）= 菜单没弹出或项名不对"
      exit 1
    }
    $mr = $m.Current.BoundingRectangle
    "[菜单] 「$CopyMenu」在 $([int]$mr.X),$([int]$mr.Y) $([int]$mr.Width)x$([int]$mr.Height)"
    [void][IslandWin32]::ClickAt([int]($mr.X + $mr.Width / 2), [int]($mr.Y + $mr.Height / 2))
  }
  Start-Sleep -Milliseconds 320
  # 轻反馈也要验：点了以后面板上那句「已复制 N 行 · 共 M 字」得真的出现，
  # 不然用户只知道按下过，不知道成没成
  $h = ''
  $tx = Find-Texts $win
  for ($j = 0; $j -lt $tx.Count; $j++) {
    if ($tx.Item($j).Current.Name -like '已复制*') { $h = $tx.Item($j).Current.Name; break }
  }
  "[提示] 反馈文本 = " + $(if ($h) { "[$h]" } else { '没有（点完 0.3s 内没出现 = 反馈没渲染）' })
  Start-Sleep -Milliseconds 300
  $clip = (Get-Clipboard -Raw)
  if ($null -eq $clip -or $clip -eq '') { '剪贴板是空的 = 复制没生效'; exit 1 }
  $lines = @($clip -split "`r`n")
  # 行尾必须是 CRLF：混进 LF 的话粘到记事本会并成一行，所以这里单独数一次
  $lf = (@((($clip -replace "`r`n", '').ToCharArray() | Where-Object { [int]$_ -eq 10 }))).Count
  "剪贴板回读：$($clip.Length) 字 / $($lines.Count) 行 / 裸 LF $lf 个（要 0）"
  for ($i = 0; $i -lt $lines.Count; $i++) { "  <$i> [$($lines[$i])]" }
}
