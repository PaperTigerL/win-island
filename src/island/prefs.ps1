# prefs.ps1 —— 悬浮件的「所有可调行为」集中在这里：默认值、类型、取值范围、校验、读盘、写盘、变更比对。
#
# 为什么要单独一个文件：原来这些数字散在 island.ps1 里（把手几像素、胶囊停多久、淡出多久、
# 顶边算几个像素…），改一个行为要读进实现里找。现在实现只问「trigger 是什么档」「holdMs 多少」，
# 取值和合法性全归这个模块，岛本身不认识 JSON。
#
# 三条硬规矩（都踩过坑，别再破）：
#   1. 写 config.json 必须无 BOM —— node 那边 JSON.parse 遇到 BOM 直接炸；
#   2. 写之前必须从盘上重读再改（read-modify-write）—— 内存里那份可能已经被别人改过了；
#   3. 任何非法值都不许让岛崩：记一条 issue、回落到默认值、继续跑。配置写错了不该蓝屏。
#
# 依赖：无（纯函数 + 模块级变量），island.ps1 用 dot-source 引入。

# 每一项都带 type/default/（枚举带 values，数字带 min/max）/doc。
# doc 是给 docs/CONFIG.md 用的，test/prefs-test.mjs 会逐条核对这里和文档有没有对不上。
$PrefsSpec = [ordered]@{
  # ---- 位置与尺寸 ----
  anchor      = @{ type = 'enum'; default = 'top-center'
                   values = 'top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right',
                            'bottom-left', 'bottom-center', 'bottom-right', 'free'
                   doc = '九宫格锚位。`free` = 用 `x`/`y` 的绝对坐标（拖拽后自动写这档）' }
  x           = @{ type = 'int'; default = -1; min = -32768; max = 32768
                   doc = 'anchor=free 时的左上角 X（设备独立像素，DIP）。-1 = 按锚位算' }
  y           = @{ type = 'int'; default = -1; min = -32768; max = 32768
                   doc = 'anchor=free 时的左上角 Y（DIP）。-1 = 按锚位算' }
  offset      = @{ type = 'int'; default = 0; min = -4000; max = 4000
                   doc = '在锚位基础上的水平偏移（DIP，正数向右）' }
  offsetY     = @{ type = 'int'; default = 0; min = -4000; max = 4000
                   doc = '在锚位基础上的垂直偏移（DIP，正数向下）' }
  scale       = @{ type = 'real'; default = 1.0; min = 0.7; max = 1.8
                   doc = '整体缩放（滚轮可改）。影响小条、胶囊、面板的全部文字和留白' }
  wide        = @{ type = 'int'; default = 470; min = 260; max = 900
                   doc = '基准宽度（DIP，未缩放时）' }
  topGap      = @{ type = 'int'; default = 10; min = 0; max = 200
                   doc = '胶囊 / 面板和常驻小条之间的间距（DIP）' }
  monitor     = @{ type = 'enum'; default = 'auto'; values = 'auto', 'primary'
                   doc = '锚位以哪块屏幕的工作区为准。`auto` = 岛当前所在的那块' }

  # ---- 出现 / 消失的触发方式 ----
  trigger     = @{ type = 'enum'; default = 'hover'
                   values = 'hover', 'click', 'longpress', 'manual'
                   doc = '展开未读面板的触发方式：悬停 / 单击 / 长按 / 只认托盘和管道 API' }
  hotPx       = @{ type = 'int'; default = 2; min = 0; max = 60
                   doc = 'hover 档：光标进入小条矩形外扩几个像素算「够到了」' }
  dwellMs     = @{ type = 'int'; default = 0; min = 0; max = 3000
                   doc = 'hover 档：要停多久才算悬停（0 = 一碰到就开）' }
  longPressMs = @{ type = 'int'; default = 550; min = 150; max = 3000
                   doc = 'longpress 档：按下不松手多久算长按' }
  dragPx      = @{ type = 'int'; default = 4; min = 1; max = 40
                   doc = '按下后移动超过这么多像素判定为拖拽（否则算点击/长按）' }
  collapseMs  = @{ type = 'int'; default = 500; min = 0; max = 10000
                   doc = '面板：光标离开后过多久收起' }
  openGraceMs = @{ type = 'int'; default = 500; min = 0; max = 5000
                   doc = '面板刚展开时的宽限期（这时光标往往还压在触发点上）' }

  # ---- 停留时长与动画 ----
  holdMs      = @{ type = 'int'; default = 6000; min = 800; max = 600000
                   doc = '胶囊弹出来以后停多久' }
  fadeMs      = @{ type = 'int'; default = 170; min = 0; max = 2000
                   doc = '淡出时长（0 = 直接消失）' }
  animMs      = @{ type = 'int'; default = 240; min = 0; max = 2000
                   doc = '入场位移动画时长' }
  slidePx     = @{ type = 'int'; default = 8; min = 0; max = 60
                   doc = '入场时从上往下滑的距离（0 = 只淡入不滑）' }
  animOn      = @{ type = 'bool'; default = $true; doc = '总开关：关掉 = 上面三个时长全部当 0 处理' }

  # ---- 什么条件下显示 / 隐藏 ----
  fullscreen  = @{ type = 'enum'; default = 'float'
                   values = 'float', 'handle', 'hide'
                   doc = '前台窗口铺满一屏时：照常悬浮 / 缩成 6px 把手 / 整条隐藏（通知也不弹）' }
  showClock   = @{ type = 'bool'; default = $true
                   doc = '常驻态显示时钟小条；false = 只留 6px 把手' }
  pillOn      = @{ type = 'bool'; default = $true
                   doc = '来通知时弹胶囊。false = 只记未读数，不弹（面板里照旧列得全）' }
  clickThrough = @{ type = 'bool'; default = $true
                   doc = '常驻态点击穿透（不吞底下窗口的点击）。光标压上小条的那一段时间会自动收点击，所以拖拽/滚轮仍然可用' }
  autoTopmost = @{ type = 'bool'; default = $true
                   doc = '周期性重申置顶，治「被别的 TopMost 窗口压住」' }
  showWeather = @{ type = 'bool'; default = $true; doc = '小条和面板里显示天气段' }
  showUnread  = @{ type = 'bool'; default = $true; doc = '小条上显示未读角标' }

  # ---- 抓取节奏（也影响面板刷新，所以放在同一份配置里）----
  pollMs      = @{ type = 'int'; default = 70; min = 20; max = 1000
                   doc = '主循环 tick 间隔（毫秒）：光标跟手程度对 CPU 占用。改完立即生效（直接改定时器间隔）' }
}

# 只读一次就缓存下来的东西：上一次解析出的值 + 规范化签名（用来算「哪几项变了」）
$script:Prefs = $null
$script:PrefsSig = ''
$script:PrefsMtime = [datetime]::MinValue
$script:PrefsIssues = @()

function Get-PrefsSpec { return $PrefsSpec }

function Get-PrefsDefault {
  $h = @{}
  foreach ($k in $PrefsSpec.Keys) { $h[$k] = $PrefsSpec[$k].default }
  return $h
}

# 把 JSON 里读来的任意值收成 spec 要求的类型；不合法就回落默认并留一句话给用户看
function Convert-PrefValue($key, $raw, $fallback) {
  $spec = $PrefsSpec[$key]
  if ($null -eq $raw -or $raw -is [System.DBNull]) { return $fallback }
  switch ($spec.type) {
    'bool' {
      if ($raw -is [bool]) { return $raw }
      $s = "$raw".Trim().ToLower()
      if ($s -in '1', 'true', 'yes', 'on')  { return $true }
      if ($s -in '0', 'false', 'no', 'off') { return $false }
      $script:PrefsIssues += "$key=$raw 不是布尔值，按 $fallback"
      return $fallback
    }
    'int' {
      $n = 0
      if (-not [int]::TryParse("$raw".Trim(), [ref]$n)) {
        $script:PrefsIssues += "$key=$raw 不是整数，按 $fallback"
        return $fallback
      }
      return (Limit-PrefNum $key $n $spec)
    }
    'real' {
      $d = 0.0
      if (-not [double]::TryParse("$raw".Trim(), [ref]$d)) {
        $script:PrefsIssues += "$key=$raw 不是数字，按 $fallback"
        return $fallback
      }
      return [double](Limit-PrefNum $key $d $spec)
    }
    'enum' {
      $s = "$raw".Trim().ToLower()
      if ($spec.values -notcontains $s) {
        $script:PrefsIssues += "$key='$s' 只认 $($spec.values -join '/')，按 $fallback"
        return $fallback
      }
      return $s
    }
    default { return $raw }
  }
}

function Limit-PrefNum($key, $n, $spec) {
  if ($spec.min -ne $null -and $n -lt $spec.min) {
    $script:PrefsIssues += "$key=$n 小于下限 $($spec.min)，按 $($spec.min)"
    return $spec.min
  }
  if ($spec.max -ne $null -and $n -gt $spec.max) {
    $script:PrefsIssues += "$key=$n 超过上限 $($spec.max)，按 $($spec.max)"
    return $spec.max
  }
  return $n
}

# 从盘上读一份合并好的配置：默认值 <- config.json 的 island 段 <- 命令行显式给的参数
# 返回 hashtable；同时把「哪些项被校正过」记在 $script:PrefsIssues 里（调用方负责打印一次）
function Read-Prefs($file, $overrides) {
  $merged = Get-PrefsDefault
  $script:PrefsIssues = @()
  $island = $null
  if (Test-Path $file) {
    try {
      $raw = Get-Content $file -Raw -Encoding UTF8
      if ($raw) {
        $cfg = $raw | ConvertFrom-Json
        if ($cfg.PSObject.Properties['island']) { $island = $cfg.island }
      }
    } catch {
      $script:PrefsIssues += "config.json 读不懂（$($_.Exception.Message)），这一轮全按默认值跑"
    }
  }
  if ($island) {
    foreach ($k in @($island.PSObject.Properties.Name)) {
      # "island": {} 这种空段，PS 给的是 @($null) 而不是空数组 —— 不挡掉的话下面 Contains($null)
      # 直接抛 ArgumentNullException，整份配置那一轮就读不成（2026-09-26 prefs-test 抓到）
      if (-not $k) { continue }
      # request 是外部程序塞的一次性指令（见 island.ps1 的 Invoke-PrefsRequest），不是行为参数，
      # 不豁免的话每次热加载都要白报一行「不是已知项」
      if ($k -eq 'request') { continue }
      if (-not $PrefsSpec.Contains($k)) {
        $script:PrefsIssues += "island.$k 不是已知项，忽略（已知项见 docs/CONFIG.md）"
        continue
      }
      $merged[$k] = Convert-PrefValue $k $island.$k $merged[$k]
    }
  }
  if ($overrides) {
    # 命令行只覆盖显式传了的那几项：-NoClock / -HoldMs 这种是「我这次就要这样」，压过文件
    foreach ($k in $overrides.Keys) { $merged[$k] = Convert-PrefValue $k $overrides[$k] $merged[$k] }
  }
  return Apply-PrefImplications $merged
}

# 项与项之间有硬冲突时在这里统一摆平，别让实现层到处打补丁
function Apply-PrefImplications($p) {
  # click / longpress 要吃点击才收得到，穿透开着就永远点不到小条
  if (@('click', 'longpress') -contains $p.trigger -and $p.clickThrough) {
    $script:PrefsIssues += "trigger=$($p.trigger) 要能点，clickThrough 自动置为 false"
    $p.clickThrough = $false
  }
  # 关掉动画 = 时长归零，实现层就只看 animOn 一个开关
  if (-not $p.animOn) { $p.fadeMs = 0; $p.animMs = 0; $p.slidePx = 0 }
  return $p
}

function Get-PrefsSignature($p) {
  $parts = foreach ($k in $PrefsSpec.Keys) { "$k=$($p[$k])" }
  return ($parts -join ';')
}

# 变了哪些项（只回键名）—— 岛拿它决定「要不要重建定时器 / 重新定位 / 重新画」
function Get-PrefsDiff($old, $new) {
  if (-not $old) { return @($PrefsSpec.Keys) }
  $d = @()
  foreach ($k in $PrefsSpec.Keys) { if ("$($old[$k])" -ne "$($new[$k])") { $d += $k } }
  return $d
}

function Write-PrefsFile($file, $map) {
  # 读盘 -> 只改 island.<keys> -> 原子替换。整份重写而不是改字符串，是为了不破坏别人的段；
  # 多项一次写完，是为了不让「anchor 已经写 free 但 x 还是 -1」这种半套状态被岛读到。
  $dir = Split-Path $file
  if (-not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
  $cfg = $null
  if (Test-Path $file) {
    try { $cfg = (Get-Content $file -Raw -Encoding UTF8) | ConvertFrom-Json } catch { $cfg = $null }
  }
  if (-not $cfg) { $cfg = New-Object PSObject }
  if (-not $cfg.PSObject.Properties['island']) {
    $cfg | Add-Member -NotePropertyName island -NotePropertyValue (New-Object PSObject) -Force
  }
  foreach ($k in @($map.Keys)) {
    if (-not $PrefsSpec.Contains($k)) { throw "Write-Prefs: $k 不是已知配置项" }
    $cfg.island | Add-Member -NotePropertyName $k -NotePropertyValue $map[$k] -Force
  }
  $tmp = "$file.tmp"
  # Set-Content -Encoding UTF8 会塞 BOM：Node 侧 JSON.parse 会当场炸，所以显式无 BOM 写
  [void][System.IO.File]::WriteAllText($tmp, ($cfg | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -Force $tmp $file
  return $cfg
}

function Write-Prefs($file, $key, $value) { return Write-PrefsFile $file @{ $key = $value } }
