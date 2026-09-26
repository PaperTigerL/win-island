# 原子岛渲染层：一块常驻悬浮的「岛」，同一个窗口换内容不换窗口，四个显示态：
#   clock   常驻小条：时钟 + 星期日期 + 天气 + 未读数
#   handle  6px 把手（showClock=false 或 fullscreen=handle 时的常驻态），有未读时变亮
#   pill    来通知时弹出的胶囊，左键 = 跳来源应用
#   panel   展开态：时钟/天气 + 今日安排 + 未读列表（触发方式见 trigger）
#
# 这个文件里不写死任何交互参数。触发方式、位置与偏移、停留时长与延迟、动画、
# 什么条件下显示/隐藏，全部是 config.json 里 `island.*` 的配置项：
#   取值/类型/范围/枚举/默认值 -> src/island/prefs.ps1（唯一的 spec）
#   摆在哪、多大、跨屏换算     -> src/island/geometry.ps1
#   本文件只负责「读到一个值 -> 做一次事」，改行为不用改这里（清单见 docs/CONFIG.md）
# 配置热生效：主循环每秒比对一次 config.json 的 mtime，只应用真正变了的那几项。
#
# 天气和日程不在这里拉：见 src/schedule/meta.mjs，渲染层只读它写出的 weather.json / agenda.json。
# 为什么 PowerShell + WPF 而不是 Electron/Tauri：这台机器 dotnet 是坏 shim、没装 rust，
# 而 WPF 是系统自带的 —— 零安装就能拿到无边框、圆角、半透明、置顶和动画。
# 注意：本文件必须存成「UTF-8 带 BOM」，否则 PowerShell 5.1 会按 GBK 读，中文字符串会炸解析器。
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File island.ps1
#       powershell ... -File island.ps1 -HoldMs 9000 -Wide 520        # 命令行只覆盖显式传的那几项
# 退出：托盘图标右键 -> 退出，或右键胶囊 -> 退出岛屿
[CmdletBinding()]
param(
  [string]$Queue,
  [int]$HoldMs = 6000,
  [int]$TopPx = 10,
  [int]$Wide = 470,
  [int]$PollMs = 70,
  [int]$HotPx = 2,
  [int]$MaxRows = 200,
  [switch]$NoClock
)
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# 「按 AUMID 找回已经开着的那个窗口」的 Win32 逻辑和命令行版共用一份实现
. (Join-Path $PSScriptRoot 'activate-lib.ps1')
. (Join-Path $PSScriptRoot 'prefs.ps1')
. (Join-Path $PSScriptRoot 'geometry.ps1')

if (-not $Queue) { $Queue = Join-Path $env:LOCALAPPDATA 'win-island\queue.jsonl' }
$script:Queue = $Queue
$script:DataDir = Split-Path $Queue
$script:LiveFile = Join-Path $script:DataDir 'live.json'
$script:StateFile = Join-Path $script:DataDir 'read.json'
# 天气/日程由抓取层（meta.mjs）拉，渲染层只读这两个文件：UI 循环里发 HTTP 会掉帧
$script:WeatherFile = Join-Path $script:DataDir 'weather.json'
$script:AgendaFile  = Join-Path $script:DataDir 'agenda.json'
# 整周课表是抓取层另写的一份（week.json）：agenda.json 是三天窗口，装不下一周七天的课
$script:WeekFile    = Join-Path $script:DataDir 'week.json'
$script:ConfigFile  = Join-Path $script:DataDir 'config.json'
# meta.mjs 在隔壁模块目录：右键菜单里「刷新天气/日程」要拿它起一次性进程
$script:MetaScript  = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'src\schedule\meta.mjs'
# launch.ps1 解析过一次 node（可移植包带 bin\node.exe）并写进环境变量，这里跟着它走；
# 手工直接跑 island.ps1 时这个变量是空的，就用 PATH 上的 node。
function Get-NodeExe { if ($env:WIN_ISLAND_NODE) { $env:WIN_ISLAND_NODE } else { 'node' } }

# 生效配置：默认值 <- config.json 的 island 段 <- 命令行显式传的这几项。
# 全岛只认这一份 $script:P，不再各自拿参数变量，所以「改了配置没生效」只可能是这里漏了应用。$script:P = Get-PrefsDefault
$script:PSig = ''
$script:ReqAt = ''
$script:Paused = $false
$script:Mode = 'handle'
$script:StackUp = $false    # root 子元素当前是哪种顺序，见 Set-StackUp（XAML 声明序 = 面板往下长）
$script:Thru = $false       # 窗口当前是不是穿透态，只有翻转时才动 exstyle
$script:MenuUp = $false     # 菜单/托盘是不是开着，开着时让出置顶带（见 Sync-Topmost）
$script:Shown = $false
$script:Until = [datetime]::MinValue
$script:FadeAt = [datetime]::MinValue
$script:LeaveAt = [datetime]::MaxValue
$script:Last = $null
$script:All = @()
$script:HintUntil = $null
$script:LastClip = ''
$script:Weather = $null
$script:Agenda = $null
$script:AgendaMtime = [datetime]::MinValue
$script:WeatherMtime = [datetime]::MinValue
$script:WeekData = $null
$script:WeekMtime = [datetime]::MinValue
# 日程段两个态：today = 只列今天，week = 摊开整周课表。收起面板时回到 today，
# 不然每次顶开面板都是一屏课表，比原来更挡地方。
$script:SchedMode = 'today'
$script:ClkCache = ''
$script:hwnd = [IntPtr]::Zero
# 小条上的按压状态：拖拽 / 点击 / 长按三件事共用一次按下，靠位移量和按住时长分流
$script:PressAt = $null
$script:PressX = 0
$script:PressY = 0
$script:DragOff = $null
$script:Dragged = $false
$script:LongFired = $false
$script:HoverAt = $null          # hover 档的计时起点，trigger 不是 hover 时一直为 null
if (-not (Test-Path $script:DataDir)) { New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null }
Set-Content -Path (Join-Path $script:DataDir 'island.pid') -Value $PID -Encoding ASCII

# 这笔账只能岛屿自己记：probe-schema.mjs 查过通知库所有表，没有任何已读/已点/已清除列，
# 所以「点过」只有「点过岛屿」这一个凭据；系统横幅那边点掉的记不到（面板里如实写着）。
$script:Opened = @{}
$script:Dismissed = @{}
$script:Gone = @{}
$script:Totals = @{ opened = 0; dismissed = 0; gone = 0 }

# ---------- 配置装载（必须在拼 XAML 之前：宽度和间距要插进模板里） ----------
# $PSBoundParameters 只能在脚本作用域取，进了函数就变成函数自己的参数表，所以先收进来
$script:CliOver = @{}
if ($PSBoundParameters.ContainsKey('HoldMs')) { $script:CliOver.holdMs = $HoldMs }
if ($PSBoundParameters.ContainsKey('TopPx'))  { $script:CliOver.topGap = $TopPx }
if ($PSBoundParameters.ContainsKey('Wide'))   { $script:CliOver.wide = $Wide }
if ($PSBoundParameters.ContainsKey('PollMs')) { $script:CliOver.pollMs = $PollMs }
if ($PSBoundParameters.ContainsKey('HotPx'))  { $script:CliOver.hotPx = $HotPx }
if ($NoClock) { $script:CliOver.showClock = $false }

function Load-Prefs {
  $script:P = Read-Prefs $script:ConfigFile $script:CliOver
  # 非法值不拦启动，但必须说清楚被校正成了什么，否则用户只会觉得「我明明改了」
  foreach ($msg in @($script:PrefsIssues)) { "[prefs] $msg" | Write-Host }
  $script:PrefsIssues = @()
  $script:PSig = Get-PrefsSignature $script:P
  if (Test-Path $script:ConfigFile) { $script:PrefsMtime = (Get-Item $script:ConfigFile).LastWriteTime }
}
Load-Prefs

# 缩放后的外框宽度：所有「岛有多宽」的判断都走这里，不再直接读 wide
function Get-FootW { return [double]$script:P.wide * [double]$script:P.scale }

$Xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" ResizeMode="NoResize" AllowsTransparency="True"
        Background="Transparent" Topmost="True" ShowInTaskbar="False"
        SizeToContent="Height" Width="$([int](Get-FootW))" Title="win-island"
        FontFamily="Segoe UI Variable Text, Microsoft YaHei UI, Segoe UI"
        TextOptions.TextFormattingMode="Ideal" UseLayoutRounding="True">
  <Window.Resources>
    <LinearGradientBrush x:Key="glass" StartPoint="0,0" EndPoint="0,1">
      <GradientStop Color="#F21D2028" Offset="0"/>
      <GradientStop Color="#F7121419" Offset="1"/>
    </LinearGradientBrush>
    <DropShadowEffect x:Key="shade" BlurRadius="30" ShadowDepth="5" Opacity="0.6" Color="#E0000000"/>
    <Style x:Key="card" TargetType="Border">
      <Setter Property="Background" Value="{StaticResource glass}"/>
      <Setter Property="BorderBrush" Value="#2EFFFFFF"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Effect" Value="{StaticResource shade}"/>
    </Style>
    <Style x:Key="link" TargetType="TextBlock">
      <Setter Property="FontSize" Value="11.5"/>
      <Setter Property="Padding" Value="8,2,8,3"/>
      <Setter Property="Cursor" Value="Hand"/>
    </Style>
    <Style x:Key="meta" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#FF6E7784"/>
      <Setter Property="FontSize" Value="11"/>
    </Style>
    <!-- 日程行：「今天」列表和整周视图里逐天的列表共用这一个模板，所以提到资源里。
         状态色走 DataTrigger 而不是 {Binding 画刷}：画刷属性从行对象上绑不动，绑上来是
         null，WPF 就退回默认值 —— 症状是时间列渲染成纯黑（和深色底糊在一起）、左边竖条
         干脆看不见。字符串属性是好的，所以拿字符串当唯一真相。
         时间列 80px：「08:00-09:40」是 11 个 Consolas 12px 字符 ≈ 73px，上一版给 52px
         正好把节次尾数剪成「08:00-09」。 -->
    <DataTemplate x:Key="schedRow">
      <Grid Margin="4,2,4,2">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="80"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Border Grid.Column="0" Width="3" CornerRadius="2" Margin="0,1,7,1" Background="#FF9DCBFF">
          <Border.Style>
            <Style TargetType="Border">
              <Style.Triggers>
                <DataTrigger Binding="{Binding State}" Value="ongoing">
                  <Setter Property="Background" Value="#FF3DD48B"/>
                </DataTrigger>
                <DataTrigger Binding="{Binding State}" Value="soon">
                  <Setter Property="Background" Value="#FFFFA03C"/>
                </DataTrigger>
                <DataTrigger Binding="{Binding State}" Value="past">
                  <Setter Property="Background" Value="#24FFFFFF"/>
                </DataTrigger>
              </Style.Triggers>
            </Style>
          </Border.Style>
        </Border>
        <TextBlock Grid.Column="1" Text="{Binding At}" FontSize="12" FontFamily="Consolas"
                   FontWeight="SemiBold" VerticalAlignment="Center" Foreground="#FF9DCBFF">
          <TextBlock.Style>
            <Style TargetType="TextBlock">
              <Style.Triggers>
                <DataTrigger Binding="{Binding State}" Value="ongoing">
                  <Setter Property="Foreground" Value="#FF5CF0AE"/>
                </DataTrigger>
                <DataTrigger Binding="{Binding State}" Value="soon">
                  <Setter Property="Foreground" Value="#FFFFC178"/>
                </DataTrigger>
                <DataTrigger Binding="{Binding State}" Value="past">
                  <Setter Property="Foreground" Value="#FF6C7683"/>
                </DataTrigger>
              </Style.Triggers>
            </Style>
          </TextBlock.Style>
        </TextBlock>
        <!-- 标题独占 * 那一列，教室和状态各走 Auto：以前三个挤在一个横向 StackPanel 里，
             标题被 MaxWidth 卡死在 200px，「示例老师：示例课程1班」这种长名
             明明还有地方也要省略号。grid 的 * 列会把多出来的宽度真的给标题。 -->
        <TextBlock Grid.Column="2" Text="{Binding Head}" FontSize="12.5" Foreground="#FFEAF0F7"
                   VerticalAlignment="Center" Margin="4,0,0,0" TextTrimming="CharacterEllipsis"/>
        <TextBlock Grid.Column="3" Text="{Binding Where}" FontSize="11" Margin="8,2,0,0"
                   MaxWidth="112" TextTrimming="CharacterEllipsis" VerticalAlignment="Center"
                   Foreground="#FF79828F"/>
        <TextBlock Grid.Column="4" Text="{Binding Tag}" FontSize="10.5" Margin="8,0,0,0"
                   VerticalAlignment="Center" Foreground="#FF6E7784"/>
      </Grid>
    </DataTemplate>
    <!-- 整周视图里的一天：一行天头（星期 / 日期 / 放假或补班 / 几节），下面接它自己的课 -->
    <DataTemplate x:Key="weekDay">
      <StackPanel x:Name="dayRoot">
        <Grid Margin="4,5,4,2">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <Border x:Name="todayDot" Grid.Column="0" Width="5" Height="5" CornerRadius="3"
                  Background="#FF6FA8FF" Margin="0,0,5,0" VerticalAlignment="Center" Visibility="Collapsed"/>
          <TextBlock x:Name="wdT" Grid.Column="1" Text="{Binding Wd}" FontSize="11.5" FontWeight="SemiBold"
                     Foreground="#FF8A94A2" VerticalAlignment="Center"/>
          <TextBlock Grid.Column="2" Text="{Binding Date}" FontSize="11" Margin="5,0,0,1"
                     Foreground="#FF6E7784" VerticalAlignment="Center"/>
          <Border x:Name="holBg" Grid.Column="3" CornerRadius="8" Padding="6,1,6,2" Margin="8,0,0,0"
                  HorizontalAlignment="Left" VerticalAlignment="Center" Background="#33E5484D">
            <TextBlock x:Name="holT" Text="{Binding Holiday}" FontSize="10.5" Foreground="#FFFFB0AE"/>
          </Border>
          <TextBlock Grid.Column="4" Text="{Binding Count}" FontSize="10.5" Foreground="#FF5F6875"
                     VerticalAlignment="Center"/>
        </Grid>
        <ItemsControl ItemsSource="{Binding Rows}" ItemTemplate="{StaticResource schedRow}"/>
      </StackPanel>
      <!-- DataTemplate.Triggers 必须是 DataTemplate 的直接子元素，不能嵌在 StackPanel 里面：
           放错了 WPF 报「无法设置未知成员 System.Windows.DataTemplate.Triggers」，
           而且模板是第一次被用到才实例化，所以今天态一切正常、一点「本周课表」整个进程就没了。 -->
      <DataTemplate.Triggers>
        <DataTrigger Binding="{Binding Holiday}" Value="">
          <Setter TargetName="holBg" Property="Visibility" Value="Collapsed"/>
        </DataTrigger>
        <!-- 补班是「本来该休的那天要上课」，语义和放假相反，所以换成蓝；文案在数据层拼 -->
        <DataTrigger Binding="{Binding WorkFlag}" Value="1">
          <Setter TargetName="holBg" Property="Background" Value="#333DA0FF"/>
          <Setter TargetName="holT" Property="Foreground" Value="#FFA8CEFF"/>
        </DataTrigger>
        <DataTrigger Binding="{Binding TodayFlag}" Value="1">
          <Setter TargetName="todayDot" Property="Visibility" Value="Visible"/>
          <Setter TargetName="wdT" Property="Foreground" Value="#FFDCE6F5"/>
          <Setter TargetName="wdT" Property="FontWeight" Value="Bold"/>
        </DataTrigger>
        <DataTrigger Binding="{Binding PastFlag}" Value="1">
          <Setter TargetName="dayRoot" Property="Opacity" Value="0.45"/>
        </DataTrigger>
      </DataTemplate.Triggers>
    </DataTemplate>
    <Style x:Key="rowApp" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#FFB6C0CD"/>
      <Setter Property="FontSize" Value="11.5"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="MaxWidth" Value="250"/>
      <Setter Property="TextTrimming" Value="CharacterEllipsis"/>
    </Style>
    <Style x:Key="rowHead" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#FFF2F5F9"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Margin" Value="0,3,0,0"/>
      <Setter Property="TextTrimming" Value="CharacterEllipsis"/>
    </Style>
    <Style x:Key="rowLine" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#FF98A2B0"/>
      <Setter Property="FontSize" Value="11.5"/>
      <Setter Property="Margin" Value="0,2,0,0"/>
      <Setter Property="TextTrimming" Value="CharacterEllipsis"/>
    </Style>
    <!-- 默认滚动条是 WPF 里最破的一块，换成 6px 圆角细条 -->
    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="6"/>
      <Setter Property="MinWidth" Value="6"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Grid Background="Transparent">
              <Track x:Name="PART_Track" IsDirectionReversed="True"
                     Minimum="{TemplateBinding Minimum}" Maximum="{TemplateBinding Maximum}"
                     Value="{TemplateBinding Value}">
                <Track.Thumb>
                  <Thumb>
                    <Thumb.Template>
                      <ControlTemplate TargetType="Thumb">
                        <Border CornerRadius="3" Background="#4DFFFFFF" Margin="1,3,1,3"/>
                      </ControlTemplate>
                    </Thumb.Template>
                  </Thumb>
                </Track.Thumb>
              </Track>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <!-- 整体缩放放在根 StackPanel 的 LayoutTransform 上：一处改，小条/胶囊/面板连同字号留白一起缩放，
       不用给每个尺寸乘一遍系数（那种写法迟早漏掉一处）。窗口宽度由 Place-Island 同步成 wide*scale。
       这里子元素的声明顺序就是「面板往下长」；底部锚位要反过来，靠 Set-StackUp 重排。 -->
  <StackPanel x:Name="root">
    <StackPanel.LayoutTransform>
      <ScaleTransform x:Name="uiScale" ScaleX="1" ScaleY="1"/>
    </StackPanel.LayoutTransform>

    <Border x:Name="handle" Width="150" Height="6" CornerRadius="0,0,7,7"
            HorizontalAlignment="Center" Background="#40FFFFFF"/>

    <!-- 常驻小条：时钟 + 星期日期 + 天气 + 未读角标。天气段和角标各是一个配置项
         （showWeather / showUnread），要收起来的是「分隔线 + 天气」这一对，所以两条都起了名字。 -->
    <Border x:Name="clock" CornerRadius="0,0,15,15" Padding="13,3,13,5" Visibility="Collapsed"
            HorizontalAlignment="Center" Background="#E314161D"
            BorderBrush="#28FFFFFF" BorderThickness="1,0,1,1">
      <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
        <TextBlock x:Name="clkTime" Text="--:--" Foreground="#FFF3F6FA" FontSize="14.5"
                   FontWeight="SemiBold" VerticalAlignment="Center"/>
        <TextBlock x:Name="clkDate" Text="" Margin="7,0,0,0" FontSize="11" VerticalAlignment="Center"
                   Foreground="#FF8A94A2"/>
        <Border x:Name="clkWxSep" Width="1" Margin="10,4,10,4" Background="#26FFFFFF"/>
        <TextBlock x:Name="clkWx" Text="" FontSize="12" VerticalAlignment="Center"
                   Foreground="#FFB7C2D1"/>
        <Border x:Name="clkUnreadBox" CornerRadius="9" Padding="7,1,7,2" Margin="10,0,0,0"
                Background="#334C8DFF" VerticalAlignment="Center" Visibility="Collapsed">
          <TextBlock x:Name="clkUnread" Text="" Foreground="#FFD7E5FF" FontSize="11"/>
        </Border>
      </StackPanel>
    </Border>

    <Border x:Name="pill" Style="{StaticResource card}" Margin="0,$($script:P.topGap),0,0"
            CornerRadius="18" Padding="0" Opacity="0" Visibility="Collapsed">
      <Border.RenderTransform>
        <TranslateTransform x:Name="pillDy" Y="-8"/>
      </Border.RenderTransform>
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Border x:Name="accent" Grid.Column="0" Width="3" Height="30" CornerRadius="2"
                Margin="12,0,0,0" VerticalAlignment="Center" Background="#FF4C8DFF"/>
        <StackPanel Grid.Column="1" Margin="11,10,8,11">
          <StackPanel Orientation="Horizontal">
            <TextBlock x:Name="appName" Text="" Style="{StaticResource rowApp}" MaxWidth="230"/>
            <TextBlock x:Name="pillAt" Text="" Margin="8,0,0,0" Style="{StaticResource meta}"/>
          </StackPanel>
          <TextBlock x:Name="titleText" Text="" Margin="0,3,0,0" Foreground="#FFF5F7FA" FontSize="14"
                     FontWeight="SemiBold" TextTrimming="CharacterEllipsis" MaxHeight="40" TextWrapping="Wrap"/>
          <TextBlock x:Name="bodyText" Text="" Margin="0,2,0,0" Foreground="#FFA6B0BE" FontSize="12"
                     TextWrapping="Wrap" MaxHeight="40" TextTrimming="CharacterEllipsis"/>
        </StackPanel>
        <Border x:Name="chipBox" Grid.Column="2" VerticalAlignment="Center" Margin="0,0,12,0"
                CornerRadius="11" Padding="8,3,8,4" Background="#24FFFFFF">
          <TextBlock x:Name="chip" Text="" Foreground="#FFCBD5E2" FontSize="11"/>
        </Border>
      </Grid>
    </Border>

    <Border x:Name="panel" Style="{StaticResource card}" Margin="0,$($script:P.topGap),0,0"
            CornerRadius="20" Padding="10,10,10,8" Opacity="0" Visibility="Collapsed">
      <Border.RenderTransform>
        <TranslateTransform x:Name="panelDy" Y="-10"/>
      </Border.RenderTransform>
      <StackPanel>
        <!-- 第一段：时钟 + 天气。原来这里放的是「未读徽标 + 队列/已处理/消失」那行，
             和下面的空态文案是同一件事说两遍，所以挪到脚注里只说一次。 -->
        <Grid Margin="4,0,2,7">
          <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
            <TextBlock x:Name="pTime" Text="--:--" Foreground="#FFF5F8FC" FontSize="22" FontWeight="Light"/>
            <TextBlock x:Name="pDate" Text="" Margin="9,0,0,2" FontSize="11.5"
                       VerticalAlignment="Bottom" Foreground="#FF8A94A2"/>
          </StackPanel>
          <TextBlock x:Name="pWx" Text="" HorizontalAlignment="Right" VerticalAlignment="Center"
                     MaxWidth="252" FontSize="12" TextAlignment="Right" TextTrimming="CharacterEllipsis"
                     Foreground="#FFC3CDDB"/>
        </Grid>
        <Border Height="1" Background="#19FFFFFF" Margin="2,0,2,7"/>

        <!-- 第二段：日程。默认只列今天，「本周课表」把整周摊开（数据在 week.json，
             含每天的放假/补班标签）。今天一件没有也留着这一段：一句「今天没课 · 中秋假期」
             比整段消失有用，而且那正是他要看的东西。 -->
        <StackPanel x:Name="schedBox" Visibility="Collapsed">
          <Grid Margin="4,0,2,3">
            <Grid.ColumnDefinitions>
              <ColumnDefinition Width="Auto"/>
              <ColumnDefinition Width="*"/>
              <ColumnDefinition Width="Auto"/>
            </Grid.ColumnDefinitions>
            <TextBlock x:Name="schedTitle" Grid.Column="0" Text="今日安排" FontSize="11" FontWeight="SemiBold"
                       Foreground="#FF79828F"/>
            <TextBlock x:Name="schedNext" Grid.Column="1" Text="" Margin="8,0,8,0" HorizontalAlignment="Right"
                       FontSize="11" Foreground="#FF8FA6C8" TextTrimming="CharacterEllipsis" MaxWidth="268"/>
            <Border x:Name="btnWeek" Grid.Column="2" Background="#1AFFFFFF" CornerRadius="12" VerticalAlignment="Center">
              <TextBlock x:Name="btnWeekT" Text="本周课表" Foreground="#FF9FB6E8" Style="{StaticResource link}"/>
            </Border>
          </Grid>
          <TextBlock x:Name="schedNote" Text="" Margin="4,1,4,2" FontSize="12" Visibility="Collapsed"
                     Foreground="#FF9AA6B4" TextWrapping="Wrap"/>
          <ScrollViewer x:Name="schedScroll" MaxHeight="330" VerticalScrollBarVisibility="Auto"
                        HorizontalScrollBarVisibility="Disabled">
            <StackPanel>
              <ItemsControl x:Name="sched" ItemTemplate="{StaticResource schedRow}"/>
              <ItemsControl x:Name="schedWeek" ItemTemplate="{StaticResource weekDay}" Visibility="Collapsed"/>
            </StackPanel>
          </ScrollViewer>
          <Border Height="1" Background="#19FFFFFF" Margin="2,6,2,7"/>
        </StackPanel>

        <!-- 第三段：未读列表。徽标/空态/脚注三处只留徽标和脚注，不再各说一遍 -->
        <Grid Margin="4,0,2,7">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <Border Grid.Column="0" CornerRadius="11" Padding="9,2,9,3" Background="#334C8DFF" VerticalAlignment="Center">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="未读" Foreground="#FFD7E5FF" FontSize="11.5"/>
              <TextBlock x:Name="cnt" Text="0" Margin="4,0,0,0" Foreground="#FFFFFFFF" FontSize="11.5" FontWeight="Bold"/>
            </StackPanel>
          </Border>
          <StackPanel Grid.Column="2" Orientation="Horizontal">
            <Border Background="#1AFFFFFF" CornerRadius="12" Margin="0,0,5,0">
              <TextBlock x:Name="btnRead" Text="全部已读" Foreground="#FF9FB6E8" Style="{StaticResource link}"/>
            </Border>
            <Border Background="#1AFFFFFF" CornerRadius="12">
              <TextBlock x:Name="btnShut" Text="收起" Foreground="#FF8B95A3" Style="{StaticResource link}"/>
            </Border>
          </StackPanel>
        </Grid>
        <ListBox x:Name="list" Background="Transparent" BorderThickness="0" MaxHeight="470"
                 ScrollViewer.HorizontalScrollBarVisibility="Disabled"
                 ScrollViewer.VerticalScrollBarVisibility="Auto"
                 HorizontalContentAlignment="Stretch">
          <ListBox.ItemContainerStyle>
            <Style TargetType="ListBoxItem">
              <Setter Property="Background" Value="Transparent"/>
              <Setter Property="BorderThickness" Value="0"/>
              <Setter Property="Padding" Value="0"/>
              <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
              <Setter Property="Template">
                <Setter.Value>
                  <ControlTemplate TargetType="ListBoxItem">
                    <Border x:Name="bd" Background="{TemplateBinding Background}" CornerRadius="13"
                            Padding="10,8,10,9" Margin="0,1,2,1">
                      <ContentPresenter/>
                    </Border>
                    <ControlTemplate.Triggers>
                      <Trigger Property="IsMouseOver" Value="True">
                        <Setter TargetName="bd" Property="Background" Value="#22FFFFFF"/>
                      </Trigger>
                      <Trigger Property="IsSelected" Value="True">
                        <Setter TargetName="bd" Property="Background" Value="#2EFFFFFF"/>
                      </Trigger>
                    </ControlTemplate.Triggers>
                  </ControlTemplate>
                </Setter.Value>
              </Setter>
            </Style>
          </ListBox.ItemContainerStyle>
          <ListBox.ItemTemplate>
            <DataTemplate>
              <Grid>
                <Grid.ColumnDefinitions>
                  <ColumnDefinition Width="Auto"/>
                  <ColumnDefinition Width="*"/>
                </Grid.ColumnDefinitions>
                <Border Grid.Column="0" Width="3" CornerRadius="2" Margin="0,2,9,2"
                        Background="{Binding Bar}" VerticalAlignment="Stretch"/>
                <Grid Grid.Column="1">
                  <Grid.RowDefinitions>
                    <RowDefinition Height="Auto"/>
                    <RowDefinition Height="Auto"/>
                    <RowDefinition Height="Auto"/>
                  </Grid.RowDefinitions>
                  <TextBlock Grid.Row="0" Text="{Binding App}" Foreground="{Binding Fg}" FontSize="11.5"
                             FontWeight="SemiBold" HorizontalAlignment="Left" MaxWidth="300"
                             TextTrimming="CharacterEllipsis"/>
                  <StackPanel Grid.Row="0" Orientation="Horizontal" HorizontalAlignment="Right"
                              VerticalAlignment="Center">
                    <!-- 复制入口：悬停在这一行时才出现，样式沿用面板里「全部已读 / 收起」那颗 chip，
                         不再多造一种按钮。点它只复制、不跳来源应用（点行的其余区域才是跳）。 -->
                    <Border x:Name="cpBox" Background="#1AFFFFFF" CornerRadius="11" Margin="0,0,6,0"
                            Visibility="Hidden">
                      <TextBlock x:Name="cpTxt" Text="复制" Style="{StaticResource link}"
                                 Foreground="#FF9FB6E8"/>
                    </Border>
                    <TextBlock Text="{Binding At}" Foreground="#FF6E7784" FontSize="10.5"/>
                  </StackPanel>
                  <TextBlock Grid.Row="1" Text="{Binding Head}" Style="{StaticResource rowHead}"/>
                  <TextBlock Grid.Row="2" Text="{Binding Line}" Style="{StaticResource rowLine}"/>
                </Grid>
              </Grid>
              <DataTemplate.Triggers>
                <DataTrigger Binding="{Binding IsMouseOver, RelativeSource={RelativeSource AncestorType=ListBoxItem}}" Value="True">
                  <Setter TargetName="cpBox" Property="Visibility" Value="Visible"/>
                </DataTrigger>
              </DataTemplate.Triggers>
            </DataTemplate>
          </ListBox.ItemTemplate>
        </ListBox>
        <TextBlock x:Name="foot" Text="" Margin="5,7,5,0" Foreground="#FF6C7582" FontSize="10.5"
                   TextWrapping="Wrap"/>
      </StackPanel>
    </Border>

    <!-- 复制的轻提示：只说「成了/没成」一句话，不改胶囊和面板里已有的内容。
         它是独立一行（SizeToContent 会把窗口撑高），定时器 1.6s 后收回去。 -->
    <Border x:Name="hintBox" Visibility="Collapsed" HorizontalAlignment="Center" Margin="0,6,0,0"
            CornerRadius="11" Padding="10,3,10,4" Background="#E614161D"
            BorderBrush="#2EFFFFFF" BorderThickness="1">
      <TextBlock x:Name="hint" Text="" FontSize="11.5" Foreground="#FF9FE8C3"/>
    </Border>
  </StackPanel>
</Window>
"@

$script:win     = [Windows.Markup.XamlReader]::Parse($Xaml)
# 解析失败时 PowerShell 只是记一条错误继续往下跑，结果是一个「进程活着但什么都没有」的僵尸岛
# （实测：XAML 里写了 Direction 之后，启动日志照样打全，屏幕上什么都没有）。这里必须硬退。
if (-not $script:win) { '[island] XAML 解析失败，退出（详情见 island.err.log）' | Write-Host; exit 1 }
$script:root    = $win.FindName('root')
$script:uiScale = $win.FindName('uiScale')
$script:handle  = $win.FindName('handle')
$script:clock   = $win.FindName('clock')
$script:clkTime = $win.FindName('clkTime')
$script:clkDate = $win.FindName('clkDate')
$script:clkWx   = $win.FindName('clkWx')
$script:clkWxSep = $win.FindName('clkWxSep')
$script:clkUnreadBox = $win.FindName('clkUnreadBox')
$script:clkUnread    = $win.FindName('clkUnread')
$script:pTime   = $win.FindName('pTime')
$script:pDate   = $win.FindName('pDate')
$script:pWx     = $win.FindName('pWx')
$script:schedBox    = $win.FindName('schedBox')
$script:sched       = $win.FindName('sched')
$script:schedWeek   = $win.FindName('schedWeek')
$script:schedTitle  = $win.FindName('schedTitle')
$script:schedNext   = $win.FindName('schedNext')
$script:schedNote   = $win.FindName('schedNote')
$script:schedScroll = $win.FindName('schedScroll')
$script:btnWeek     = $win.FindName('btnWeek')
$script:btnWeekT    = $win.FindName('btnWeekT')
$script:pill    = $win.FindName('pill')
$script:panel   = $win.FindName('panel')
$script:accent  = $win.FindName('accent')
$script:pillDy  = $win.FindName('pillDy')
$script:panelDy = $win.FindName('panelDy')
$script:name    = $win.FindName('appName')
$script:pillAt  = $win.FindName('pillAt')
$script:title   = $win.FindName('titleText')
$script:body    = $win.FindName('bodyText')
$script:chipBox = $win.FindName('chipBox')
$script:chip    = $win.FindName('chip')
$script:cnt     = $win.FindName('cnt')
$script:list    = $win.FindName('list')
$script:foot    = $win.FindName('foot')
$script:btnRead = $win.FindName('btnRead')
$script:btnShut = $win.FindName('btnShut')
$script:hintBox = $win.FindName('hintBox')
$script:hint    = $win.FindName('hint')

$script:Palette = '#FF4C8DFF', '#FF3DD48B', '#FFFFA03C', '#FFB07CFF', '#FFFF6B9D',
                 '#FF35C8D8', '#FFFF5B5B', '#FFF2C14E', '#FF7F9B3F', '#FF8C9EFF'
function Brush-Of($hex) {
  return New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString($hex))
}
function Get-Brush($key) {
  return Brush-Of (Get-BrushHex $key)
}
# 行对象上只挂字符串色值：WPF 绑 Brush 对象绑不上（退成默认黑色），
# 但 Brush 类型的依赖属性有内置类型转换器，给 '#RRGGBB' 字符串是能转的。
function Get-BrushHex($key) {
  $h = 0
  foreach ($ch in ([string]$key).ToCharArray()) { $h = ($h * 31 + [int]$ch) -band 0x7FFFFFFF }
  return $script:Palette[$h % $script:Palette.Length]
}

# 队列里的 app 有时是整串 AUMID（实测 mspaint 那条就是），显示前要收成能读的名字。
# 商店包那种 Microsoft.WindowsCalculator_8wekyb3d8bbwe!App 不能取第一段 —— 实测取 [0]
# 会得到「Microsoft」「Windows」这种谁都一样的空名字。
function Get-ShortName($item) {
  $a = [string]$item.app
  if (-not $a) { return '未知应用' }
  if ($a -match '[\\/]') { return (($a -split '[\\/]')[-1] -replace '\.[A-Za-z0-9]{1,5}$', '') }
  $t = ($a -replace '!.*$', '')
  $t = ($t -replace '_[a-z0-9]{6,}$', '')
  $junk = 'com','app','apps','microsoft','windows','system','package','packages','immersive',
          'nonimmersivepackage','desktop','client','core','x64','x86','arm64','wekyb3d8bbwe'
  $segs = @($t -split '[.\-]' | Where-Object { $_ })
  if ($segs.Count -le 1) { return $t }
  $good = @($segs | Where-Object { $junk -notcontains $_.ToLowerInvariant() })
  if ($good.Count -eq 0) { return $segs[-1] }
  return ($good | Sort-Object { $_.Length } -Descending | Select-Object -First 1)
}

function Animate($target, $prop, $to, $ms) {
  $a = New-Object System.Windows.Media.Animation.DoubleAnimation
  $a.To = $to
  $a.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds($ms))
  # New-Object 后面直接写 (名字=值) 会被 PowerShell 当命令参数解析成 EasingMode=... 报 CommandNotFoundException
  $ease = New-Object System.Windows.Media.Animation.CubicEase
  $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseOut
  $a.EasingFunction = $ease
  $target.BeginAnimation($prop, $a)
}

# ---------- 几何：摆在哪、多大（所有取值都来自 $script:P，见 prefs.ps1） ----------
# 锚位和拖拽保存的坐标描述的都是「小条」而不是「窗口」：面板一展开窗口高度会从 ~30 变成几百，
# 拿窗口当基准的话，每次展开小条都会跳一下。
function Get-BarH {
  $b = if ($script:Mode -eq 'handle') { $script:handle.ActualHeight } else { $script:clock.ActualHeight }
  if ($b -le 1) { $b = 30 * [double]$script:P.scale }     # 第一次布局前量不到，给个保守值
  return [double]$b
}
function Get-IslandH {
  $h = [double]$script:win.ActualHeight
  if ($h -le 1) { $h = Get-BarH }
  return $h
}

# 面板往上长还是往下长。.NET Framework 的 StackPanel 没有公开的 Direction（反射查过，
# 只有 .NET Core 的 WPF 有），所以「往上长」靠换子元素顺序：小条排在最后一个，它就贴在窗口下沿。
# 顺序变了等于重新挂一遍视觉树，所以只在真的翻转时才动手，用 $script:StackUp 记住当前态。
function Set-StackUp($up) {
  $up = [bool]$up
  if ($script:StackUp -eq $up) { return }
  $order = if ($up) { @($script:panel, $script:pill, $script:clock, $script:handle) }
           else { @($script:handle, $script:clock, $script:pill, $script:panel) }
  $script:root.Children.Clear()
  foreach ($c in $order) { $script:root.Children.Add($c) }
  $script:StackUp = $up
}

function Place-Island {
  if (-not $script:win) { return }
  $p = $script:P
  $w = Get-FootW
  $h = Get-IslandH
  $bar = Get-BarH
  $rects = Get-DipWorkAreas
  $wa = Get-AnchorWorkArea $rects ([double]$script:win.Left + $w / 2) ([double]$script:win.Top + $bar / 2) `
                            ($p.monitor -eq 'primary')
  $a = [string]$p.anchor
  if ($a -eq 'free' -and [int]$p.x -ge 0 -and [int]$p.y -ge 0) {
    $c = Limit-OnScreen $rects ([double]$p.x) ([double]$p.y) $w $bar
    $barX = $c.X; $barY = $c.Y
  } else {
    $bx = switch -regex ($a) {
      'left$'  { [double]$wa.X }
      'right$' { [double]$wa.X + $wa.W - $w }
      default  { [double]$wa.X + ($wa.W - $w) / 2 }
    }
    $by = switch -regex ($a) {
      '^top-'    { [double]$wa.Y }
      '^bottom-' { [double]$wa.Y + $wa.H - $bar }
      default    { [double]$wa.Y + ($wa.H - $bar) / 2 }
    }
    $barX = $bx + [double]$p.offset
    $barY = $by + [double]$p.offsetY
  }
  # 面板往哪边长：下面放不下就整块往上长（底部锚位天然如此）
  $up = ($a -like 'bottom-*') -or (($barY + $h) -gt ([double]$wa.Y + $wa.H + 1))
  $winY = if ($up) { $barY + $bar - $h } else { $barY }
  if (-not (Test-OnAnyScreen $rects $barX $winY $w $h)) {
    # 显示器被拔掉 / 分辨率改小，保存的位置已经不在任何屏上：回落顶部居中，别把岛弄丢
    $wa = Get-PrimaryWorkArea
    "[island] 位置 $([int]$barX),$([int]$winY) $([int]$w)x$([int]$h) 不在任何屏上，回落顶部居中" | Write-Host
    $barX = [double]$wa.X + ($wa.W - $w) / 2
    $barY = [double]$wa.Y
    $winY = $barY
    $up = $false
  }
  # 面板往上长还是往下长：.NET Framework 的 StackPanel 没有公开的 Direction（.NET Core 才有），
  # 所以「往上长」靠换子元素顺序实现 —— 小条排最后一个时它就在窗口下沿。
  Set-StackUp $up
  $script:clock.CornerRadius = if ($up) { '15,15,0,0' } else { '0,0,15,15' }
  $script:handle.CornerRadius = if ($up) { '7,7,0,0' } else { '0,0,7,7' }
  if ([Math]::Abs([double]$script:win.Width - $w) -gt 0.5) { $script:win.Width = $w }
  if ([Math]::Abs([double]$script:win.Left - $barX) -gt 0.5) { $script:win.Left = $barX }
  if ([Math]::Abs([double]$script:win.Top - $winY) -gt 0.5) { $script:win.Top = $winY }
}

# 穿透开关：常驻态要不要吃点击。开着穿透就拖不动也点不到小条 —— 这是配置项 clickThrough 的代价，
# 想要点击/长按触发，prefs.ps1 的 Apply-PrefImplications 会自动把它关掉。
function Set-ClickThrough($on) {
  if ($script:hwnd -eq [IntPtr]::Zero) { return }
  [void][IslandWin32]::SetClickThrough($script:hwnd, [bool]$on)
}

# clickThrough 的真实语义是「光标不在岛上时穿透」：光标都已经压在条上了，这一下就是冲岛来的，
# 该收点击 —— 否则默认档（hover + 穿透）下拖不动也滚不动，「不吃标题栏点击」和「可拖拽缩放」
# 就永远只能二选一。拖拽途中不翻转：鼠标已捕获给 WPF 了，中途改 exstyle 只会把这次拖拽搞丢。
function Sync-ClickThrough {
  if ($script:PressAt) { return }
  $idle = ($script:Mode -eq 'handle' -or $script:Mode -eq 'clock' -or $script:Mode -eq 'hidden')
  $thru = [bool]$script:P.clickThrough -and $idle -and -not (Test-OverBar)
  if ($thru -eq $script:Thru) { return }
  $script:Thru = $thru
  Set-ClickThrough $thru
}

# 菜单/托盘弹出来时岛要让出置顶带：岛屿每 ~2s 抢一次置顶（autoTopmost），抢的结果就是把自己
# 的右键菜单压到窗口下面 —— 上面几项看不见更点不到，等于配置改不了（2026-09-26 实测）。
# 状态每 tick 现算而不是用计数器：漏收一次 Closed 就把置顶永久丢了，那比这个 bug 更难查。
function Test-MenuUp {
  if ($script:ctx -and $script:ctx.IsOpen) { return $true }
  if ($script:rowMenu -and $script:rowMenu.IsOpen) { return $true }
  if ($script:trayMenu -and $script:trayMenu.Visible) { return $true }
  return $false
}

# 只在「有没有菜单开着」翻转时动一次 Topmost：每 tick 改属性会让窗口反复进出置顶带，肉眼可见地闪
function Sync-Topmost {
  $up = Test-MenuUp
  if ($up -eq $script:MenuUp) { return }
  $script:MenuUp = $up
  $script:win.Topmost = (-not $up)
  if (-not $up -and $script:hwnd -ne [IntPtr]::Zero) {
    [void][IslandWin32]::ForceTopmost($script:hwnd)   # 收回置顶时立刻归位，别等下一次重申
  }
}

function Set-Mode($m) {
  $script:Mode = $m
  # 常驻小条在胶囊/面板展开时也不撤：岛是「长」出内容，不是换掉内容（showClock=false 才退回把手）
  $showBar = [bool]$script:P.showClock -and ($m -eq 'clock' -or $m -eq 'pill' -or $m -eq 'panel')
  $script:handle.Visibility = if ($m -eq 'handle') { 'Visible' } else { 'Collapsed' }
  $script:clock.Visibility  = if ($showBar) { 'Visible' } else { 'Collapsed' }
  $script:pill.Visibility   = if ($m -eq 'pill')   { 'Visible' } else { 'Collapsed' }
  $script:panel.Visibility  = if ($m -eq 'panel')  { 'Visible' } else { 'Collapsed' }
  # 常驻态（把手 / 时钟条 / 整条隐藏）按配置决定点透，胶囊和面板一定要吃点击
  Sync-ClickThrough
  if (-not $script:Shown) { $script:Shown = $true; $script:win.Show() }
  Place-Island          # 高度变了，锚位要重算（底部/中间锚位全靠这一步才不跳）
}

function Update-Handle {
  $n = @(Get-Unread).Count
  # 有未读的时候把手亮一点：不点进去也得让人知道这块能上滑
  $script:handle.Background = Brush-Of $(if ($n -gt 0) { '#B37FB0FF' } else { '#40FFFFFF' })
}

# 是不是「常驻态」：只有这三种态下才由配置决定长什么样，胶囊/面板/淡出是临时态
function Test-IdleShown {
  return ($script:Mode -eq 'handle' -or $script:Mode -eq 'clock' -or $script:Mode -eq 'hidden')
}

# 前台窗口铺满整个工作区时，常驻小条会盖住人家的标题栏中间，这时退回 6px 把手
function Test-ForegroundMaximized {
  try {
    $h = [IslandWin32]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { return $false }
    $root = [IslandWin32]::RootOf($h)
    if ($root -eq $script:hwnd) { return $false }
    $r = [IslandWin32]::Rect($root)
    $wa = [System.Windows.Forms.Screen]::FromHandle($root).WorkingArea
    return ($r.T -le ($wa.Top + 2) -and $r.L -le ($wa.Left + 2) -and
            $r.B -ge ($wa.Bottom - 2) -and $r.R -ge ($wa.Right - 2))
  } catch { return $false }
}

# ---------- 天气 / 日程 ----------
function Read-Meta($file) {
  if (-not (Test-Path $file)) { return $null }
  try { return (Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Update-Meta {
  # 按 mtime 决定要不要重新反序列化，文件没变就只是两次 Get-Item
  try {
    if (Test-Path $script:WeatherFile) {
      $t = (Get-Item $script:WeatherFile).LastWriteTime
      if ($t -ne $script:WeatherMtime) { $script:Weather = Read-Meta $script:WeatherFile; $script:WeatherMtime = $t }
    }
    if (Test-Path $script:AgendaFile) {
      $t = (Get-Item $script:AgendaFile).LastWriteTime
      if ($t -ne $script:AgendaMtime) {
        $script:Agenda = Read-Meta $script:AgendaFile; $script:AgendaMtime = $t
        if ($script:Mode -eq 'panel') { Refresh-Panel }
      }
    }
    if (Test-Path $script:WeekFile) {
      $t = (Get-Item $script:WeekFile).LastWriteTime
      if ($t -ne $script:WeekMtime) {
        $script:WeekData = Read-Meta $script:WeekFile; $script:WeekMtime = $t
        if ($script:Mode -eq 'panel' -and $script:SchedMode -eq 'week') { Refresh-Panel }
      }
    }
  } catch {}
}

function Format-Wx($w, $long) {
  if (-not $w) { return '天气未就绪' }
  $s = "$($w.glyph) $($w.temp)° $($w.txt)"
  if (-not $long) { return $s }
  $bits = @($s)
  if ($w.hi -ne $null -and $w.lo -ne $null) { $bits += "$($w.lo)~$($w.hi)°" }
  if ($w.rain -gt 0) { $bits += "降水 $($w.rain)%" }
  if ($w.city) { $bits += $w.city }
  return ($bits -join ' · ')
}

$script:Week = '周日', '周一', '周二', '周三', '周四', '周五', '周六'

function Update-Clock {
  $p = $script:P
  $now = Get-Date
  $hm = $now.ToString('HH:mm')
  $date = "$($script:Week[[int]$now.DayOfWeek]) $($now.Month)/$($now.Day)"
  $n = @(Get-Unread).Count
  $script:clkTime.Text = $hm
  $script:clkDate.Text = $date
  $wx = if ($p.showWeather) { 'Visible' } else { 'Collapsed' }
  $script:clkWxSep.Visibility = $wx
  $script:clkWx.Visibility = $wx
  $script:clkWx.Text = Format-Wx $script:Weather $false
  $script:clkUnreadBox.Visibility = if ($p.showUnread -and $n -gt 0) { 'Visible' } else { 'Collapsed' }
  $script:clkUnread.Text = "未读 $n"
  $script:pTime.Text = $hm
  $script:pDate.Text = $date
  $script:pWx.Text = Format-Wx $script:Weather $true
  $script:pWx.Visibility = $wx
}

# ---------- 显示条件：常驻态该长什么样 ----------
function Get-IdleMode {
  $p = $script:P
  $fs = Test-ForegroundMaximized
  if ($fs -and $p.fullscreen -eq 'hide') { return 'hidden' }
  if (-not $p.showClock) { return 'handle' }
  if ($fs -and $p.fullscreen -eq 'handle') { return 'handle' }
  return 'clock'
}

function Show-Idle {
  $m = Get-IdleMode
  if ($m -eq 'handle') { Show-Handle; return }
  if ($m -eq 'hidden') { Set-Mode 'hidden'; return }
  Set-Mode 'clock'; Update-Clock
}

# ---------- 配置热加载：每秒比一次 mtime，只应用真正变了的项 ----------
$script:PrefsGeo = 'anchor', 'x', 'y', 'offset', 'offsetY', 'wide', 'monitor', 'topGap', 'scale'
$script:PrefsVis = 'fullscreen', 'showClock', 'pillOn', 'showWeather', 'showUnread'

function Update-Prefs {
  try {
    if (-not (Test-Path $script:ConfigFile)) { return }
    $t = (Get-Item $script:ConfigFile).LastWriteTime
    if ($t -eq $script:PrefsMtime) { return }
    $script:PrefsMtime = $t
    $old = $script:P
    Load-Prefs
    $diff = @(Get-PrefsDiff $old $script:P)
    if ($diff.Count -gt 0) { Apply-Prefs $diff }
    Invoke-PrefsRequest
  } catch { "[island] 配置这一轮没读成，继续按上一轮的值跑：$($_.Exception.Message)" | Write-Host }
}

function Apply-Prefs($diff) {
  $p = $script:P
  foreach ($k in $diff) {
    # switch 的 case 不能写成 'a', 'b' { … }（解析器直接报错），所以这两项各占一行
    switch ($k) {
      'scale' { $script:uiScale.ScaleX = [double]$p.scale; $script:uiScale.ScaleY = [double]$p.scale }
      'pollMs' { $script:timer.Interval = [TimeSpan]::FromMilliseconds([int]$p.pollMs) }
      'clickThrough' { $script:Thru = $null; Sync-ClickThrough }
      'showWeather' { Update-Clock }
      'showUnread' { Update-Clock }
      'trigger' { $script:HoverAt = $null }
    }
  }
  if (@($diff | Where-Object { $script:PrefsGeo -contains $_ }).Count -gt 0) { Place-Island }
  if (@($diff | Where-Object { $script:PrefsVis -contains $_ }).Count -gt 0 -and (Test-IdleShown)) { Show-Idle }
  Sync-MenuLabels
  "[prefs] 热应用 $($diff -join ' ')" | Write-Host
}

# 一次性指令通道：外部程序往 config.json 的 island.request 里塞 {action,at}，岛消费后按 at 去重。
# 走文件而不是新开端口的原因：岛本来就在按 mtime 轮询这个文件，多一个通道就多一处会失败的 IO。
function Invoke-PrefsRequest {
  try {
    $cfg = (Get-Content $script:ConfigFile -Raw -Encoding UTF8) | ConvertFrom-Json
    if (-not $cfg.island -or -not $cfg.island.request) { return }
    $rq = $cfg.island.request
    $at = [string]$rq.at
    if (-not $at -or $at -eq $script:ReqAt) { return }      # 同一条指令只认一次
    $script:ReqAt = $at
    $a = [string]$rq.action
    $known = @('expand', 'collapse', 'pause', 'resume', 'recenter', 'pill') -contains $a
    # 消费必须留一行日志：外部程序只能拿到「文件写进去了」，岛有没有真的做这件事，
    # 判据在这行里（test/api-test.mjs 就是拿它当端到端凭据的）
    "[prefs] request $a @$at " + $(if ($known) { '已执行' } else { "不认识（expand/collapse/pause/resume/recenter/pill）" }) | Write-Host
    if (-not $known) { return }
    switch ($a) {
      'expand'   { Expand-Panel }
      'collapse' { if ($script:Mode -eq 'panel') { Collapse-Panel } else { Collapse-Pill } }
      'pause'    { Set-Paused $true }
      'resume'   { Set-Paused $false }
      'recenter' { Reset-Position }
      'pill'     { if ($script:Last) { Render $script:Last 1 } }
    }
  } catch {}
}

# 改配置并写回磁盘（菜单、托盘、外部程序都走这一个口子，所以「改了没落盘」只可能有一处原因）
function Set-Pref($key, $value) {
  [void](Write-Prefs $script:ConfigFile $key $value)
  $script:PrefsMtime = (Get-Item $script:ConfigFile).LastWriteTime
  $old = $script:P
  Load-Prefs
  $diff = @(Get-PrefsDiff $old $script:P)
  if ($diff.Count -gt 0) { Apply-Prefs $diff }
}

function Set-PrefMany($map) {
  [void](Write-PrefsFile $script:ConfigFile $map)
  $script:PrefsMtime = (Get-Item $script:ConfigFile).LastWriteTime
  $old = $script:P
  Load-Prefs
  $diff = @(Get-PrefsDiff $old $script:P)
  if ($diff.Count -gt 0) { Apply-Prefs $diff }
}

function Set-Paused($on) {
  $script:Paused = [bool]$on
  if ($script:Paused) { Collapse-Pill } else { if (Test-IdleShown) { Show-Idle } }
  Sync-MenuLabels
  "[island] 弹条$(if ($script:Paused) { '已暂停（只记未读数）' } else { '已恢复' })" | Write-Host
}

# 复位 = 清掉自由位置，回到锚位（不是把 scale 也归 1，那是另一件事）
function Reset-Position {
  Set-PrefMany @{ anchor = 'top-center'; x = -1; y = -1; offset = 0; offsetY = 0 }
  '[island] 位置已复位到顶部居中' | Write-Host
}

# 菜单项文案跟着生效值走：用户点一下看到的必须是当前状态，不然「换档」两字没有意义
function Get-PrefMenuText($key, $v) {
  switch ($key) {
    'fullscreen' { switch ($v) { 'float' { '照常悬浮' } 'hide' { '完全隐藏' } default { '缩成把手' } } }
    'trigger'    { switch ($v) { 'hover' { '悬停' } 'click' { '单击' } 'longpress' { '长按' } default { '只认托盘/API' } } }
    'clickThrough' { if ($v) { '穿透（压上小条时可拖）' } else { '不穿透（一直收点击）' } }
    'animOn'     { if ($v) { '开' } else { '关' } }
  }
}
function Cycle-Pref($key) {
  $order = switch ($key) {
    'fullscreen' { 'float', 'handle', 'hide' }
    'trigger'    { 'hover', 'click', 'longpress', 'manual' }
    'clickThrough' { $true, $false }
    'animOn'     { $true, $false }
  }
  $cur = [string]$script:P[$key]
  $i = 0
  for ($j = 0; $j -lt $order.Count; $j++) { if ("$($order[$j])" -eq $cur) { $i = $j } }
  Set-Pref $key $order[($i + 1) % $order.Count]
}
function Sync-MenuLabels {
  if ($script:miFs) { $script:miFs.Header = "全屏时：$(Get-PrefMenuText 'fullscreen' $script:P.fullscreen)" }
  if ($script:tiFs) { $script:tiFs.Text = $script:miFs.Header }
  if ($script:miTrig) { $script:miTrig.Header = "展开触发：$(Get-PrefMenuText 'trigger' $script:P.trigger)" }
  if ($script:miThru) { $script:miThru.Header = "小条鼠标：$(Get-PrefMenuText 'clickThrough' $script:P.clickThrough)" }
  if ($script:miAnim) { $script:miAnim.Header = "动画：$(Get-PrefMenuText 'animOn' $script:P.animOn)" }
  if ($script:miPause) { $script:miPause.Header = if ($script:Paused) { '继续弹条（已暂停）' } else { '暂停弹条' } }
}

function Show-Handle { Set-Mode 'handle'; Update-Handle }

# 入场位移的方向：面板往上长（底部锚位）时就得从下面滑进来，不然动画是倒着放的
function Get-SlideY {
  if ($script:StackUp) { return [double]$script:P.slidePx }
  return -[double]$script:P.slidePx
}

function Show-Pill {
  $p = $script:P
  Set-Mode 'pill'
  $script:pillDy.Y = Get-SlideY
  Animate $script:pill ([System.Windows.UIElement]::OpacityProperty) 1 $p.fadeMs
  Animate $script:pillDy ([System.Windows.Media.TranslateTransform]::YProperty) 0 $p.animMs
  $script:Until = (Get-Date).AddMilliseconds($p.holdMs)
}

# 收起要先淡出再换内容：立刻 Set-Mode 会把内容撤掉，淡出动画就变成「啪一下消失」
function Start-Fade {
  $script:Mode = 'fading'
  # 关掉动画时 fadeMs=0，这里给 30ms 兜底，不然会卡在 fading 里没人接手
  $script:FadeAt = (Get-Date).AddMilliseconds([Math]::Max(30, [int]$script:P.fadeMs))
}

function Collapse-Pill {
  if ($script:Mode -ne 'pill') { return }
  $p = $script:P
  Animate $script:pill ([System.Windows.UIElement]::OpacityProperty) 0 $p.fadeMs
  Animate $script:pillDy ([System.Windows.Media.TranslateTransform]::YProperty) (Get-SlideY) $p.fadeMs
  Start-Fade
}

function Expand-Panel {
  $p = $script:P
  Refresh-Panel
  Set-Mode 'panel'
  # 展开这一瞬间光标往往还压在触发点上（顶边之上没有屏幕了），所以先给一段宽限期再判「离开」
  $script:LeaveAt = (Get-Date).AddMilliseconds($p.openGraceMs)
  $script:panelDy.Y = Get-SlideY
  Animate $script:panel ([System.Windows.UIElement]::OpacityProperty) 1 $p.fadeMs
  Animate $script:panelDy ([System.Windows.Media.TranslateTransform]::YProperty) 0 $p.animMs
  "[island] 展开未读列表 cnt=$($script:cnt.Text)" | Write-Host
}

function Collapse-Panel {
  if ($script:Mode -ne 'panel') { return }
  $p = $script:P
  $script:SchedMode = 'today'
  Animate $script:panel ([System.Windows.UIElement]::OpacityProperty) 0 $p.fadeMs
  Animate $script:panelDy ([System.Windows.Media.TranslateTransform]::YProperty) (Get-SlideY) $p.fadeMs
  Start-Fade
  '[island] 收起未读列表' | Write-Host
}

# ---------- 账本 ----------
function Load-State {
  if (-not (Test-Path $script:StateFile)) { return }
  try {
    $o = Get-Content $script:StateFile -Raw | ConvertFrom-Json
    foreach ($k in @($o.opened))    { if ($k) { $script:Opened[[string]$k]    = $true } }
    foreach ($k in @($o.dismissed)) { if ($k) { $script:Dismissed[[string]$k] = $true } }
    foreach ($k in @($o.gone))      { if ($k) { $script:Gone[[string]$k]      = $true } }
    if ($o.totals) {
      $script:Totals.opened = [int]$o.totals.opened
      $script:Totals.dismissed = [int]$o.totals.dismissed
      $script:Totals.gone = [int]$o.totals.gone
    }
  } catch { '[island] 账本读坏了，按空账重来' | Write-Host }
}

function Save-State {
  # id 是通知库的自增行号，比队列里最小行号还老的那些永远查不到了，直接丢
  $keep = { param($h) @($h.Keys | Sort-Object { [int64]$_ } | Select-Object -Last 400) }
  $body = @{
    opened    = & $keep $script:Opened
    dismissed = & $keep $script:Dismissed
    gone      = & $keep $script:Gone
    totals    = $script:Totals
  } | ConvertTo-Json -Compress
  try {
    Set-Content -Path ($script:StateFile + '.tmp') -Value $body -Encoding UTF8
    Move-Item -Force ($script:StateFile + '.tmp') $script:StateFile
  } catch { "[island] 账本写失败：$($_.Exception.Message)" | Write-Host }
}

function Get-Unread {
  @($script:All | Where-Object {
      $id = [string]$_.id
      (-not $script:Opened[$id]) -and (-not $script:Dismissed[$id]) -and (-not $script:Gone[$id])
    } | Sort-Object { [int64]$_.id } -Descending)
}

function Mark-Opened($item) {
  $id = [string]$item.id
  if ($id -and -not $script:Opened[$id]) { $script:Opened[$id] = $true; $script:Totals.opened++; Save-State }
}
function Mark-Dismissed($item) {
  $id = [string]$item.id
  if ($id -and -not $script:Dismissed[$id]) { $script:Dismissed[$id] = $true; $script:Totals.dismissed++; Save-State }
}

# live.json：抓取层每 3 秒把「通知中心里还剩哪些行」写出来。队列里的 id 不在里面 = 这条
# 已经在系统侧被划掉或已过期（库里没有已读列，这两种分不开），所以只标「已消失」，
# 不算「已处理」—— 把记不到的那部分谎报成处理过，这个数就没意义了。
function Sync-Live {
  if (-not (Test-Path $script:LiveFile)) { return }
  try {
    if ((Get-Date) - (Get-Item $script:LiveFile).LastWriteTime -gt [TimeSpan]::FromSeconds(90)) { return }
    $o = Get-Content $script:LiveFile -Raw | ConvertFrom-Json
    if (-not $o.ids) { return }
    $live = @{}
    foreach ($i in @($o.ids)) { $live[[string]$i] = $true }
    $snapAt = [long]$o.at
    $nowMs = [long]([DateTimeOffset]::Now).ToUnixTimeMilliseconds()
    $changed = $false
    foreach ($r in $script:All) {
      $id = [string]$r.id
      if ($live[$id]) {
        # 判错了要能撤回：这条还在通知中心里，就说明之前那次「消失」是快照没覆盖到它（或抓取层
        # 那次写失败），不是用户划掉的。撤回比留着不管好 —— 留着它就再也回不到未读列表。
        if ($script:Gone[$id]) {
          $script:Gone.Remove($id); $script:Totals.gone--
          "[island] 撤回误判 id=$id（这条其实还在通知中心里）" | Write-Host
          $changed = $true
        }
        continue
      }
      if ($script:Gone[$id] -or $script:Opened[$id] -or $script:Dismissed[$id]) { continue }
      # 两种情况还不能判「消失」：快照比这条旧（没覆盖到它），或它刚进来不到 15 秒。
      # 判早了会把人还没看到的消息从面板里抹掉 —— 复制、跳转都没了对象。
      # 2026-09-26 实测到一次：抓取层 live.json 那次 rename 抛 EPERM，id=9437 落进队列 0.7 秒就进了 gone 名单。
      $ms = [long]$r.ms
      if (-not $ms) { continue }
      if ($snapAt -and $ms -gt $snapAt) { continue }
      if ($nowMs - $ms -lt 15000) { continue }
      $script:Gone[$id] = $true; $script:Totals.gone++; $changed = $true
    }
    if ($changed) { Save-State; if ($script:Mode -eq 'panel') { Refresh-Panel } else { Update-Handle } }
  } catch {}
}

# ---------- 队列增量读取：记字节偏移，文件被轮转截断（变小）就从头再来 ----------
$script:Offset = 0L
function Read-New {
  if (-not (Test-Path $script:Queue)) { return @() }
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($script:Queue, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    if ($fs.Length -lt $script:Offset) { $script:Offset = 0L }
    [void]$fs.Seek($script:Offset, [System.IO.SeekOrigin]::Begin)
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    $all = $sr.ReadToEnd()
    $script:Offset += [System.Text.Encoding]::UTF8.GetByteCount($all)
    $sr.Dispose()
    $out = @()
    foreach ($ln in ($all -split "`n")) {
      if (-not $ln.Trim()) { continue }
      try { $o = $ln | ConvertFrom-Json; if ($o) { $out += $o; $script:All += $o } } catch {}
    }
    if ($script:All.Count -gt $MaxRows) { $script:All = @($script:All | Select-Object -Last $MaxRows) }
    return $out
  } catch { return @() } finally { if ($fs) { $fs.Dispose() } }
}

# ---------- 渲染 ----------
function Render($item, $burst) {
  $script:Last = $item
  $u = @(Get-Unread).Count
  $script:name.Text  = Get-ShortName $item
  $script:pillAt.Text = [string]$item.at
  $script:title.Text = [string]$item.title
  $script:body.Text  = [string]$item.body
  $script:accent.Background = Get-Brush ([string]$item.appId)
  $script:chipBox.Visibility = if ($script:P.showUnread -and $u -gt 0) { 'Visible' } else { 'Collapsed' }
  $script:chip.Text = if ($burst -gt 1) { "+$($burst - 1) · $u 未读" } else { "$u 未读" }
  Show-Pill          # 定位在 Set-Mode 里做（Place-Island），这里不再单独摆一次
  # 这行是「静默实例」的唯一信号：capture.log 有货而这里没有渲染行，就是窗口从没显示出来过，
  # 用 launch.ps1 重启（手工 Start-Process 起的实例若父 shell 被杀，出现过进程活着窗口不显示）
  "[island] 渲染 id=$($item.id) app=$($script:name.Text) 未读=$u" | Write-Host
}

# 一行日程：时间 / 标题 / 地点 / 状态键。状态按「现在」现算，不用数据文件写出那一刻的结论
# —— 文件是快照，快照会随时间变旧（课已经上完了还标着「快到了」）。
function New-SchedRow($e, $nowMs) {
  $s = [long]$e.s
  $en = [long]$e.e
  if ($en -le $s) { $en = $s + 1800000 }
  $ongoing = ($s -le $nowMs -and $nowMs -lt $en)
  $soon = (-not $ongoing) -and ($s -gt $nowMs) -and (($s - $nowMs) -le 36e5)
  $past = (-not $ongoing) -and (-not $soon) -and ($en -le $nowMs)
  $at = if ($e.allDay) { '全天' } elseif ($e.st -eq $e.et) { [string]$e.st } else { "$($e.st)-$($e.et)" }
  $tag = ''
  if ($ongoing) { $tag = '进行中' }
  elseif ($soon) { $tag = "还有 $([Math]::Round(($s - $nowMs) / 6e4)) 分钟" }
  $state = if ($ongoing) { 'ongoing' } elseif ($soon) { 'soon' } elseif ($past) { 'past' } else { 'next' }
  return [pscustomobject]@{
    At = $at; Head = [string]$e.title; Where = [string]$e.where; Tag = $tag
    State = $state; S = $s
  }
}

# 今天这一天的原始条目。优先 week.json：它按整周展开，包括已经上完的那几节；
# agenda.json 的三天窗口是先丢掉过去事件的，用它做「今天」会出现
# 「下午三点看今天上午的课，那条根本不存在」的情况。没有 week.json 才退回旧路径。
function Get-TodayEvents {
  $w = $script:WeekData
  if ($w -and $w.days) {
    $t = @($w.days | Where-Object { $_.today } | Select-Object -First 1)
    if ($t.Count) { return @($t[0].events) }
  }
  $a = $script:Agenda
  if (-not $a -or -not $a.days) { return @() }
  $d = @($a.days | Where-Object { [int]$_.offset -eq 0 } | Select-Object -First 1)
  if ($d.Count) { return @($d[0].events) }
  return @()
}

# 「今日安排」列表：只有今天。以前把后天的课也摊进这一段（还靠标题前缀区分），
# 结果周末点开来一句「今天没课」都说不出口，满屏都是下周一的课。
function Get-SchedRows {
  $nowMs = [long]([DateTimeOffset]::Now).ToUnixTimeMilliseconds()
  $out = @()
  foreach ($e in @(Get-TodayEvents)) {
    if (-not $e.s) { continue }
    if ($out.Count -ge 20) { break }
    $out += New-SchedRow $e $nowMs
  }
  return $out
}

# 整周课表：七天一组，一天一个天头 + 它自己的若干行。
function Get-WeekDays {
  $w = $script:WeekData
  if (-not $w -or -not $w.days) { return @() }
  $nowMs = [long]([DateTimeOffset]::Now).ToUnixTimeMilliseconds()
  $out = @()
  foreach ($d in @($w.days)) {
    $rows = @()
    foreach ($e in @($d.events)) {
      if (-not $e.s) { continue }
      if ($rows.Count -ge 20) { break }
      $rows += New-SchedRow $e $nowMs
    }
    $hol = ''
    if ($d.rest) { $hol = "放假 · $($d.rest)" }
    elseif ($d.work) { $hol = '调休补班' }
    $out += [pscustomobject]@{
      Wd = [string]$d.wd; Date = [string]$d.date; Holiday = $hol
      WorkFlag  = if ($d.work) { '1' } else { '' }
      TodayFlag = if ($d.today) { '1' } else { '' }
      PastFlag  = if ($d.past) { '1' } else { '' }
      Count = if ($rows.Count) { "$($rows.Count) 节" } else { '没课' }
      Rows = $rows
    }
  }
  return $out
}

# 今天没课时那句解释：假期就说假期，不然报一个本周里最近有课的日子。
function Get-TodayNote($today, $rows) {
  if ($rows.Count) { return '' }
  if ($today -and $today.rest) { return "今天$($today.rest)，放假，没课。" }
  if ($today -and $today.work) { return '今天调休补班，日程里还没有课。' }
  $w = $script:WeekData
  if (-not $w -or -not $w.days) { return '今天没课。' }
  $nowMs = [long]([DateTimeOffset]::Now).ToUnixTimeMilliseconds()
  foreach ($d in @($w.days)) {
    if ($d.today) { continue }
    foreach ($e in @($d.events)) {
      # 只报「还没开始」的那节：过去的条目在整周里看就行，写在提示里是误导
      if ($e.s -and [long]$e.s -ge $nowMs) {
        return "今天没课，本周最近的是 $($d.wd) $($d.date) $($e.st) $($e.title)"
      }
    }
  }
  return '今天没课，本周剩下的日子也没有安排。'
}

function Refresh-Panel {
  $u = @(Get-Unread)
  $rows = @()
  foreach ($r in $u) {
    $b = Get-BrushHex ([string]$r.appId)
    $rows += [pscustomobject]@{
      id   = [string]$r.id
      raw  = $r
      App  = (Get-ShortName $r)
      At   = [string]$r.at
      Head = [string]$r.title
      Line = [string]$r.body
      Bar  = $b
      Fg   = $b
    }
  }
  $coll = New-Object System.Collections.ObjectModel.ObservableCollection[object]
  foreach ($x in $rows) { [void]$coll.Add($x) }
  $script:list.ItemsSource = $coll
  $script:cnt.Text = "$($u.Count)"

  # 日程段：今天 / 整周两个态。一件日程数据都没有（没导过课表、没配订阅）才整段收起来；
  # 「今天没课」不是「没数据」，那种时候恰恰是要留一行说明的时候。
  $wk = @(Get-WeekDays)
  $tr = @(Get-SchedRows)
  $today = $null
  if ($script:WeekData -and $script:WeekData.days) {
    $t0 = @($script:WeekData.days | Where-Object { $_.today } | Select-Object -First 1)
    if ($t0.Count) { $today = $t0[0] }
  }
  $hasWeek = ($wk.Count -gt 0) -or ($script:WeekData -and $script:WeekData.days)
  if (-not $hasWeek -and -not $tr.Count) {
    $script:schedBox.Visibility = 'Collapsed'
    $script:schedNext.Text = ''
    $script:list.MaxHeight = 470
  } else {
    $script:schedBox.Visibility = 'Visible'
    $week = ($script:SchedMode -eq 'week') -and $hasWeek
    $script:btnWeek.Visibility = if ($hasWeek) { 'Visible' } else { 'Collapsed' }
    $script:btnWeekT.Text = if ($week) { '只看今天' } else { '本周课表' }
    $note = Get-TodayNote $today $tr
    $script:schedNote.Text = $note
    $script:schedNote.Visibility = if ($note) { 'Visible' } else { 'Collapsed' }
    if ($week) {
      $n = [int]$script:WeekData.n
      $ttl = '本周安排'
      if ($script:WeekData.weekNo) { $ttl += " · 第$($script:WeekData.weekNo)周" }
      $script:schedTitle.Text = "$ttl · $n 节"
      $d1 = $script:WeekData.days[0].date; $d7 = $script:WeekData.days[6].date
      $rest = @($wk | Where-Object { $_.Holiday -like '放假*' }).Count
      $script:schedNext.Text = if ($rest) { "$d1-$d7 · 其中 $rest 天放假" } else { "$d1-$d7" }
      $script:schedScroll.MaxHeight = 360
    } else {
      # 0 件不再写进标题：下面那句「今天中秋节，放假，没课」已经把同一件事说清楚了
      $script:schedTitle.Text = if ($tr.Count) { "今日安排 · $($tr.Count) 件" } else { '今日安排' }
      $nowMs = [long]([DateTimeOffset]::Now).ToUnixTimeMilliseconds()
      $nx = @($tr | Where-Object { [long]$_.S -ge $nowMs } | Select-Object -First 1)
      $script:schedNext.Text = if ($nx.Count) { "接下来 $($nx[0].At) $($nx[0].Head)" } elseif ($tr.Count) { '今天的都过完了' } else { '' }
      $script:schedScroll.MaxHeight = 240
    }
    $script:sched.Visibility = if ($week) { 'Collapsed' } else { 'Visible' }
    $script:schedWeek.Visibility = if ($week) { 'Visible' } else { 'Collapsed' }
    $script:sched.ItemsSource = $tr
    $script:schedWeek.ItemsSource = $wk
    if ($script:Agenda -and $script:Agenda.errors -and @($script:Agenda.errors).Count) {
      $script:schedNext.Text = "日程有问题：$(@($script:Agenda.errors) -join '；')"
    }
    # 日程占了高度，未读列表的可滚区间就要让出来，不然面板会顶出屏幕
    $sh = if ($week) { 30 + [Math]::Min(360, $wk.Count * 27 + $script:WeekData.n * 24) }
          else { 30 + [Math]::Min(240, [Math]::Max(1, $tr.Count + 1) * 26) }
    $script:list.MaxHeight = [Math]::Max(140, 470 - $sh)
  }
  $done = $script:Totals.opened + $script:Totals.dismissed
  $script:foot.Text = "点一条跳到来源应用；鼠标移到那一行、点行尾「复制」拿走全文（右键菜单、Ctrl+C 也可以）。岛屿记到 $done 条，系统侧消失 $($script:Totals.gone) 条（横幅那边点掉的记不到）。"
  Update-Clock
  Update-Handle
}

# ---------- 点开跳转 ----------
# 点开 = 跳到来源应用，用的就是通知中心自己那套跳转参数（launch + activationType），
# 和你点右下角那条横幅做的是同一件事。仍然挡掉能直接拉起本地文件/脚本的那几种写法——
# 那是「通知内容里的一行字符串」不该有的权力，跟点不点横幅无关。
$script:BadLaunch = '^(file:|javascript:|vbscript:|about:|search-ms:|ms-msdt:|\\\\)'
function Open-Source($item) {
  if (-not $item) { return $false }
  # 第 1 级：通知自带的协议深链（实测 QQ 的 ntqq-notification://… 靠这级直接跳到那个会话）
  $l = [string]$item.launch
  if ($l) {
    if ($l -match $script:BadLaunch) {
      "[open] 拒绝这种写法：$($l.Substring(0, [Math]::Min(70, $l.Length)))" | Write-Host
    } elseif ($l -match '^[A-Za-z][A-Za-z0-9+.\-]*:') {
      # 不能要求 '://'：ms-settings:notifications / mailto: / tel: 这类协议本来就没有斜杠
      try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $l
        $psi.UseShellExecute = $true
        [void][System.Diagnostics.Process]::Start($psi)
        "[open] 1协议跳转 $($l.Substring(0, [Math]::Min(70, $l.Length)))" | Write-Host
        Mark-Opened $item
        return $true
      } catch { "[open] 1协议失败：$($_.Exception.Message)" | Write-Host }
    }
  }
  # 第 2 级：应用本来就在跑 —— 把它已经开着的窗口唤回前台。放在「起 exe / AppsFolder」之前，
  # 因为实测 Qoder、B 站没有协议深链、AppsFolder 又不认（错误 1229），应用本来就开着，
  # 再起一个进程只会得到「多开/无反应」，不是用户要的「跳过去」。
  $id = [string]$item.appId
  $r = Invoke-AppActivate -Aumid $id -AppName ([string]$item.app) -SelfPid $PID
  if ($r -match '前台') { "[open] 2唤回窗口 $r" | Write-Host; Mark-Opened $item; return $true }
  "[open] 2唤回失败：$r" | Write-Host
  if ($id) {
    # 第 3 级：没在跑，但 AUMID 本身就是 exe 路径（微信在开始菜单里的 AppID 就是这种）
    if ($id -match '^[A-Za-z]:\\.+\.exe$' -and (Test-Path $id)) {
      try {
        Start-Process -FilePath $id
        "[open] 3拉起 $id" | Write-Host
        Mark-Opened $item
        return $true
      } catch { "[open] 3拉起失败：$($_.Exception.Message)" | Write-Host }
    }
    # 第 4 级：商店包 AUMID 走 shell:AppsFolder。路径型 id 到第 3 级就该到底了 —— 实测把
    # 已经不存在的 C:\Windows\System32\mspaint.exe 塞进 AppsFolder 只会得到一句没用的报错
    if ($id -notmatch '[\\/]') {
      try {
        Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$id"
        "[open] 4按 AUMID 激活 $id（没反应=这个应用没有可激活的入口）" | Write-Host
        Mark-Opened $item
        return $true
      } catch { "[open] 4激活失败：$($_.Exception.Message)" | Write-Host }
    }
    "[open] 到底了：$id 这个路径现在不存在，也没有可唤回的窗口" | Write-Host
  }
  '[open] 这条通知没带可跳转的信息，也没匹配到能唤回的窗口' | Write-Host
  return $false
}

# ---------- 复制 ----------
# 一条消息的「完整内容」= 标题 + 正文各行。首选 capture.mjs 写好的 copy 字段（它已经按 CRLF 拼好），
# 队列里的旧条目没有 copy/lines，就退回压平过的 body —— 至少不给人空剪贴板。
# 行尾一律先归一到 CRLF：混着 LF 的内容粘进记事本/Word 会并成一行，那是「复制坏了」不是「复制没成」。
function Format-CopyText($s) { return ("$s" -replace "`r`n", "`n") -replace "`n", "`r`n" }

function Get-CopyText($item, $withSource) {
  if (-not $item) { return '' }
  $parts = @()
  $c = [string]$item.copy
  if ($c) {
    $parts = @($c -split "`r`n")
  } else {
    $t = [string]$item.title
    if ($t) { $parts += $t }
    $ls = @()
    foreach ($l in @($item.lines)) { foreach ($k in ("$l" -split "`r?`n")) { if ($k -ne '') { $ls += $k } } }
    if ($ls.Count -gt 0) { $parts += $ls }
    elseif ([string]$item.body) { $parts += [string]$item.body }
  }
  if ($withSource) {
    $parts += "—— 来自 $($item.app) · $([string]$item.at)"
    $ac = @($item.actions) | Where-Object { "$_" -ne '' }
    if ($ac.Count -gt 0) { $parts += "操作：$($ac -join ' / ')" }
  }
  return (Format-CopyText ($parts -join "`r`n"))
}

# 剪贴板是全机独占锁：远程桌面同步、剪贴板管理器、安全软件正在读写时 OpenClipboard 会失败并抛
# COMException/InvalidOperationException，所以重试三次；仍失败就退到岛目录里的 last-copy.txt，
# 让人至少拿得到内容，而不是什么都不发生。
function Copy-Clip($text) {
  if (-not $text) { return '这条没有可复制的文本' }
  $err = ''
  for ($i = 1; $i -le 3; $i++) {
    try {
      [System.Windows.Clipboard]::Clear()
      [System.Windows.Clipboard]::SetData([System.Windows.DataFormats]::UnicodeText, [string]$text)
      $script:LastClip = [string]$text
      return $null
    } catch { $err = $_.Exception.Message; Start-Sleep -Milliseconds 120 }
  }
  try {
    $f = Join-Path $script:DataDir 'last-copy.txt'
    Set-Content -LiteralPath $f -Value ([string]$text) -Encoding UTF8
    return "剪贴板占用（$err），内容已写到 $f"
  } catch { return "剪贴板写入失败：$err" }
}

function Show-Hint($text, $bad) {
  $script:hint.Text = [string]$text
  $script:hint.Foreground = Brush-Of $(if ($bad) { '#FFFF9C9C' } else { '#FF9FE8C3' })
  $script:hintBox.Visibility = 'Visible'
  $script:HintUntil = (Get-Date).AddMilliseconds(1600)
}

# 成功后要「复制了几个字/几行」这种能核对的数，不写「已复制」了事 —— 光知道复制了没法判断内容对不对。
function Copy-Message($item, $withSource) {
  $txt = Get-CopyText $item $withSource
  if (-not $txt) { Show-Hint '复制失败：这条通知没有正文' $true; return }
  $err = Copy-Clip $txt
  if ($err) {
    "[clip] 失败：$err" | Write-Host
    Show-Hint "复制失败：$err" $true
    return
  }
  $n = @($txt -split "`r`n").Count
  "[clip] 已复制 $n 行 / $($txt.Length) 字 id=$($item.id)" | Write-Host
  Show-Hint "已复制 $n 行 · 共 $($txt.Length) 字" $false
}

function Copy-All-Unread() {
  $us = @(Get-Unread)
  if ($us.Count -eq 0) { Show-Hint '没有未读可复制' $true; return }
  $blocks = @()
  foreach ($u in $us) {
    $b = Get-CopyText $u $true
    if ($b) { $blocks += $b }
  }
  if ($blocks.Count -eq 0) { Show-Hint '复制失败：未读都没有正文' $true; return }
  $txt = $blocks -join "`r`n`r`n"
  $err = Copy-Clip $txt
  if ($err) {
    "[clip] 失败：$err" | Write-Host
    Show-Hint "复制失败：$err" $true
    return
  }
  "[clip] 已复制全部未读 $($us.Count) 条 / $($txt.Length) 字" | Write-Host
  Show-Hint "已复制全部未读 $($us.Count) 条 · 共 $($txt.Length) 字" $false
}


# ---------- 触发与拖拽：判定只看配置项，实现里不留数字 ----------
# 光标位置换成 DIP：Win32 给的是物理像素，窗口的 Left/Top 是 DIP，
# 125%/150% 缩放的机器上直接比会差出几百像素（hover 永远判不中）。
function Get-CursorDip {
  $s = Get-DipScale
  return @{ X = [double][IslandWin32]::CursorX() / $s; Y = [double][IslandWin32]::CursorY() / $s }
}

# 小条在屏幕上的矩形（DIP）。往上长时小条贴在窗口下沿，锚位/命中都要按它算。
function Get-BarRect {
  $bar = Get-BarH
  $h = Get-IslandH
  $y = if ($script:StackUp) { [double]$script:win.Top + $h - $bar } else { [double]$script:win.Top }
  return @{ X = [double]$script:win.Left; Y = $y; W = Get-FootW; H = $bar }
}

function Test-OverBar {
  $p = $script:P
  $c = Get-CursorDip
  if ($c.X -lt 0 -or $c.Y -lt 0) { return $false }        # 光标在副屏负坐标之外时 Win32 也给负值
  $r = Get-BarRect
  $g = [double]$p.hotPx
  return ($c.X -ge ($r.X - $g) -and $c.X -le ($r.X + $r.W + $g) -and
          $c.Y -ge ($r.Y - $g) -and $c.Y -le ($r.Y + $r.H + $g))
}

# hover 档：够到小条并且停够 dwellMs 才算。dwellMs=0 时不额外等一帧，碰到就开。
function Test-HoverTrigger {
  $p = $script:P
  if ([string]$p.trigger -ne 'hover' -or -not (Test-OverBar)) { $script:HoverAt = $null; return $false }
  if ($p.dwellMs -le 0) { return $true }
  if (-not $script:HoverAt) { $script:HoverAt = Get-Date; return $false }
  return ((Get-Date) - $script:HoverAt).TotalMilliseconds -ge [int]$p.dwellMs
}

# 按下之后的分流：位移超 dragPx = 拖拽；按住不松超 longPressMs = 长按；否则松手算单击。
# 松手一定要在这里判（而不是只挂 MouseLeftButtonUp）：用户在岛上按下、甩到别处松开时，
# WPF 不会给我们 Up 事件，状态就永久卡在「按着」上。
function Update-Press {
  if (-not $script:PressAt) { return }
  $p = $script:P
  $down = [IslandWin32]::LeftDown()
  $c = Get-CursorDip
  if (-not $down) { End-Press $c; return }
  if (-not $script:Dragged) {
    $moved = [Math]::Max([Math]::Abs($c.X - $script:PressX), [Math]::Abs($c.Y - $script:PressY))
    if ($moved -ge [double]$p.dragPx) { $script:Dragged = $true }
  }
  if ($script:Dragged) {
    $script:win.Left = $c.X - $script:DragOff.X
    $script:win.Top  = $c.Y - $script:DragOff.Y
    return
  }
  if (([string]$p.trigger -eq 'longpress') -and -not $script:LongFired) {
    $held = ((Get-Date) - $script:PressAt).TotalMilliseconds
    if ($held -ge [double]$p.longPressMs) { $script:LongFired = $true; Expand-Panel }
  }
}

function Begin-Press {
  $c = Get-CursorDip
  $script:PressAt = Get-Date
  $script:PressX = $c.X; $script:PressY = $c.Y
  $script:DragOff = @{ X = $c.X - [double]$script:win.Left; Y = $c.Y - [double]$script:win.Top }
  $script:Dragged = $false
  $script:LongFired = $false
}

function End-Press($c) {
  $script:PressAt = $null
  if ($script:Dragged) {
    # 拖完立刻落盘：下次启动要回到用户放的地方，而不是回到顶部居中
    $r = Get-BarRect
    Set-PrefMany @{ anchor = 'free'; x = [int]$r.X; y = [int]$r.Y }
    "[island] 已拖到 $([int]$r.X),$([int]$r.Y)（DIP），写回 config.json" | Write-Host
    $script:Dragged = $false
    return
  }
  if (([string]$script:P.trigger -eq 'click') -and -not $script:LongFired) { Expand-Panel }
}

function Test-OverPanel {
  if ($script:win.IsMouseOver) { return $true }
  $c = Get-CursorDip
  if ($c.Y -lt 0) { return $false }
  return ($c.Y -le ([double]$script:win.Top + [Math]::Ceiling($script:win.ActualHeight) + 14) -and
          $c.X -ge ([double]$script:win.Left - 20) -and
          $c.X -le ([double]$script:win.Left + $script:win.ActualWidth + 20))
}

# ---------- 定时器：默认 70ms 一次（光标要跟手），读队列每 4 次、对账每 30 次、配置每秒 ----------
$script:tick = 0
$script:timer = New-Object System.Windows.Threading.DispatcherTimer
$script:timer.Interval = [TimeSpan]::FromMilliseconds([int]$script:P.pollMs)
$script:timer.Add_Tick({
  $script:tick++
  if ($script:HintUntil -and (Get-Date) -gt $script:HintUntil) {
    $script:HintUntil = $null
    $script:hintBox.Visibility = 'Collapsed'
  }
  if ($script:tick % 4 -eq 1) {
    $new = @(Read-New)
    if ($new.Count -gt 0) {
      if ($script:Mode -eq 'panel') { Refresh-Panel }        # 展开着来新通知：只刷列表，不再弹胶囊
      elseif ($script:Paused) { Update-Handle }
      elseif (-not $script:P.pillOn -or (Get-IdleMode) -eq 'hidden') {
        # 不弹不等于不记：未读数和「上一条」照算，面板里列得全，只是不打扰
        $script:Last = $new[-1]
        "[island] 按配置压住 id=$($script:Last.id)（$($script:Last.title)）不弹：pillOn=$($script:P.pillOn) 常驻态=$(Get-IdleMode)" | Write-Host
      }
      else { Render $new[-1] $new.Count }
    }
  }
  Update-Press
  Sync-ClickThrough          # 光标压上小条的那一刻就要能吃点击，不然拖不动
  if ($script:tick % 4 -eq 3) { Sync-Topmost }   # 菜单开着就别抢置顶，抢了会把菜单压到岛下面
  if ($script:tick % 30 -eq 0) { Sync-Live }
  if ($script:P.autoTopmost -and -not $script:MenuUp -and $script:tick % 30 -eq 7) {
    [void][IslandWin32]::ForceTopmost($script:hwnd)          # 被别的 TopMost 压住时抢回来
  }
  if ($script:tick % 15 -eq 0) {
    # 秒级：时钟走字；配置热加载；常驻态跟着「前台是不是铺满一屏」换形
    Update-Clock
    Update-Prefs
    if (Test-IdleShown -and (Get-IdleMode) -ne $script:Mode) { Show-Idle }
  }
  if ($script:tick % 143 -eq 0) { Update-Meta }        # ~10 秒看一次天气/日程文件变了没
  switch ($script:Mode) {
    'pill' {
      if (Test-HoverTrigger) { Collapse-Pill; Expand-Panel }
      elseif ((Get-Date) -gt $script:Until -and -not $script:win.IsMouseOver) { Collapse-Pill }
    }
    'panel' {
      if (Test-OverPanel) { $script:LeaveAt = (Get-Date).AddMilliseconds($script:P.collapseMs) }
      elseif ((Get-Date) -gt $script:LeaveAt) { Collapse-Panel }
    }
    'fading' {
      # 淡出途中又够到小条：直接换面板，别等淡完
      if (Test-HoverTrigger) { Expand-Panel }
      elseif ((Get-Date) -gt $script:FadeAt) { Show-Idle }
    }
    default {
      if (Test-HoverTrigger) { Expand-Panel }
    }
  }
})
$script:timer.Start()

# ---------- 交互 ----------
$script:pill.Add_MouseLeftButtonUp({
  if (Open-Source $script:Last) { Refresh-Panel } else { Update-Handle }
  Collapse-Pill
})
$script:pill.Add_MouseRightButtonUp({ $script:ctx.IsOpen = $true })

# 小条上的鼠标动作。clickThrough=true 时这些一个都收不到（事件被穿透到下面的窗口），
# 所以 prefs.ps1 里 trigger=click/longpress 会自动把穿透关掉 —— 不是这里做两套逻辑。
$script:clock.Add_MouseLeftButtonDown({ Begin-Press })
$script:clock.Add_MouseRightButtonUp({ $script:ctx.IsOpen = $true })
$script:clock.Add_MouseWheel({
  param($s, $e)
  $e.Handled = $true
  $cur = [double]$script:P.scale
  $next = [Math]::Round($cur + $(if ($e.Delta -gt 0) { 0.05 } else { -0.05 }), 2)
  if ($next -eq $cur) { return }
  # 上下限交给 spec 夹（scale: 0.7~1.8），这里不重复写数字
  Set-Pref 'scale' $next
})
$tip = New-Object System.Windows.Controls.ToolTip
$tip.Content = '左键：打开来源应用    右键：菜单'
$script:pill.ToolTip = $tip
$clockTip = New-Object System.Windows.Controls.ToolTip
$clockTip.Content = '拖动 = 挪位置（会记住）    滚轮 = 缩放    右键 = 菜单'
$script:clock.ToolTip = $clockTip

$script:ctx = New-Object System.Windows.Controls.ContextMenu
function Add-Menu($header, $action) {
  $mi = New-Object System.Windows.Controls.MenuItem
  $mi.Header = $header
  $mi.Add_Click($action)
  [void]$script:ctx.Items.Add($mi)
  return $mi
}
# 改配置的入口排在最前面：菜单是从鼠标位置往下长的，压在屏幕顶部时后面几项容易被够不着，
# 而「换档」恰恰是用户点开菜单的目的。这四条就是把 config.json 的关键行为搬到鼠标上：
# 点一下换下一档，立刻生效并写回盘。
$script:miFs = Add-Menu '' { Cycle-Pref 'fullscreen' }
$script:miTrig = Add-Menu '' { Cycle-Pref 'trigger' }
$script:miThru = Add-Menu '' { Cycle-Pref 'clickThrough' }
$script:miAnim = Add-Menu '' { Cycle-Pref 'animOn' }
[void](Add-Menu '复位到顶部居中' { Reset-Position })
[void](Add-Menu '打开配置文件 config.json' {
  if (Test-Path $script:ConfigFile) { Invoke-Item $script:ConfigFile } else { Invoke-Item $script:DataDir }
})
$script:miPause = Add-Menu '暂停弹条' { Set-Paused (-not $script:Paused) }
[void](Add-Menu '展开未读列表' { Expand-Panel })
[void](Add-Menu '重看上一条' { if ($script:Last) { Render $script:Last 1 } })
[void](Add-Menu '复制上一条（完整正文）' { Copy-Message $script:Last $false })
[void](Add-Menu '复制全部未读' { Copy-All-Unread })
[void](Add-Menu '刷新天气/日程' {
  # 抓取层自己按 everyMin 节流，这里就起一个一次性的 meta.mjs 强制重拉，几秒后文件 mtime 变了会自动刷进来
  try {
    Start-Process -FilePath (Get-NodeExe) -ArgumentList "`"$($script:MetaScript)`"" -WindowStyle Hidden
    '[meta] 已触发重拉天气/日程' | Write-Host
  } catch { "[meta] 刷新失败：$($_.Exception.Message)" | Write-Host }
})
[void](Add-Menu '打开岛目录' { Invoke-Item $script:DataDir })
[void](Add-Menu '退出岛屿' { $script:tray.Visible = $false; $script:timer.Stop(); $script:win.Close() })
Sync-MenuLabels

$script:rowMenu = New-Object System.Windows.Controls.ContextMenu
$script:rowTarget = $null
$script:list.Add_MouseLeftButtonUp({
  $o = $args[1].OriginalSource
  # 点在行尾那颗「复制」上 = 只复制这一条，不跳来源应用；行的其余区域照旧跳。
  # 注意要传 .raw：列表里那行是展示模型（App/Head/Line），通知本体在 .raw 里，
  # 直接拿展示行去复制会因为取不到 title/lines 而报「没有正文」。
  if ($o -is [System.Windows.Controls.TextBlock] -and [string]$o.Text -eq '复制') {
    $it = $o.DataContext
    if ($it) { Copy-Message $it.raw $false }
    return
  }
  $sel = $script:list.SelectedItem
  if (-not $sel) { return }
  if (Open-Source $sel.raw) { Collapse-Panel } else { Refresh-Panel }
})
$script:list.Add_MouseRightButtonUp({
  # 必须在这里截断冒泡：不截的话事件继续往上走到 $script:panel 的右键处理，那边会开 ctx，
  # 而 WPF 同一时刻只允许一个 ContextMenu —— 后开的把 rowMenu 顶掉，实测表现为
  # 「右键一行什么都没发生」，UIA 里根本找不到菜单项（2026-09-26 copy-test 第 5 步）。
  $args[1].Handled = $true
  $it = $null
  try {
    $pt = [System.Windows.Input.Mouse]::GetPosition($script:list)
    $cit = $script:list.ItemContainerGenerator.ContainerFromPoint($pt)
    if ($cit) { $it = $cit.DataContext }
  } catch {}
  if (-not $it) { $it = $script:list.SelectedItem }
  if (-not $it) { return }
  $script:rowTarget = $it
  $script:rowMenu.PlacementTarget = $script:list
  $script:rowMenu.IsOpen = $true
})
$miGo = New-Object System.Windows.Controls.MenuItem
$miGo.Header = '跳到来源应用'
$miGo.Add_Click({
  if ($script:rowTarget) { [void](Open-Source $script:rowTarget.raw); Refresh-Panel }
})
[void]$script:rowMenu.Items.Add($miGo)
$miCp = New-Object System.Windows.Controls.MenuItem
$miCp.Header = '复制这条（完整正文）'
$miCp.Add_Click({ if ($script:rowTarget) { Copy-Message $script:rowTarget.raw $false } })
[void]$script:rowMenu.Items.Add($miCp)
$miCs = New-Object System.Windows.Controls.MenuItem
$miCs.Header = '复制这条（带来源和时间）'
$miCs.Add_Click({ if ($script:rowTarget) { Copy-Message $script:rowTarget.raw $true } })
[void]$script:rowMenu.Items.Add($miCs)
# 选中一行按 Ctrl+C 就复制：列表里「复制」本来就该有这个键位，不用绕右键。
$script:list.Add_PreviewKeyDown({
  param($s, $e)
  $ctrl = ([System.Windows.Input.Keyboard]::Modifiers -band
           [System.Windows.Input.ModifierKeys]::Control) -ne 0
  if ($ctrl -and $e.Key -eq [System.Windows.Input.Key]::C) {
    $sel = $script:list.SelectedItem
    if ($sel) { Copy-Message $sel.raw $false; $e.Handled = $true }
  }
})
$miIg = New-Object System.Windows.Controls.MenuItem
$miIg.Header = '忽略这条（算已处理）'
$miIg.Add_Click({
  if ($script:rowTarget) { Mark-Dismissed $script:rowTarget; Refresh-Panel }
})
[void]$script:rowMenu.Items.Add($miIg)

$script:btnRead.Add_MouseLeftButtonUp({
  $n = 0
  foreach ($r in @(Get-Unread)) { Mark-Dismissed $r; $n++ }
  Refresh-Panel
  "[island] 未读全部标记已读 $n 条" | Write-Host
})
$script:btnShut.Add_MouseLeftButtonUp({ Collapse-Panel })
# 「今天 / 本周」是同一个位置上的切换，不开第二个面板：整周摊开来二十几行，
# 默认必须是紧凑的那个，展开只在这一次停留。
$script:btnWeek.Add_MouseLeftButtonUp({
  $script:SchedMode = if ($script:SchedMode -eq 'week') { 'today' } else { 'week' }
  Refresh-Panel
  "[island] 日程段切到 $($script:SchedMode)" | Write-Host
})
$script:panel.Add_MouseRightButtonUp({ $script:ctx.IsOpen = $true })

$script:tray = New-Object System.Windows.Forms.NotifyIcon
$script:tray.Icon = [System.Drawing.SystemIcons]::Application
$script:tray.Visible = $true
$script:tray.Text = 'Windows 原子岛：左键单击图标展开未读列表'
# 托盘要有一份独立的入口：trigger=manual 或穿透锁住小条时，岛上的鼠标动作全都不通，
# 只有托盘还能换档；WinForms 的 MenuItem 也塞不进 WPF 的 ContextMenu，所以只能各建一份
$script:trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
# 和岛上的右键菜单同一个次序：改配置的排前面
$script:tiFs = $script:trayMenu.Items.Add('全屏时：…')
$script:tiFs.Add_Click({ Cycle-Pref 'fullscreen' })
[void]$script:trayMenu.Items.Add('复位到顶部居中').Add_Click({ Reset-Position })
[void]$script:trayMenu.Items.Add('打开配置文件').Add_Click({ if (Test-Path $script:ConfigFile) { Invoke-Item $script:ConfigFile } else { Invoke-Item $script:DataDir } })
[void]$script:trayMenu.Items.Add('展开未读列表').Add_Click({ Expand-Panel })
[void]$script:trayMenu.Items.Add('打开岛目录').Add_Click({ Invoke-Item $script:DataDir })
[void]$script:trayMenu.Items.Add('退出').Add_Click({ $script:tray.Visible = $false; $script:timer.Stop(); $script:win.Close() })
$script:tray.ContextMenuStrip = $script:trayMenu
Sync-MenuLabels
$script:tray.Add_MouseClick({ if ($script:Mode -eq 'panel') { Collapse-Panel } else { Expand-Panel } })

$script:win.Add_SourceInitialized({
  $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:win)
  $script:hwnd = [IntPtr]$helper.Handle
  # 穿透状态要等 HWND 建出来才设得进去，而配置在拼 XAML 前就读好了，所以这里补一次
  Set-ClickThrough ((Test-IdleShown) -and [bool]$script:P.clickThrough)
})
# 窗口尺寸一变（展开面板、改缩放、换字体）就重算位置：底部/中间锚位全靠这一步才不跳
$script:win.Add_SizeChanged({ Place-Island })
$script:win.Add_Closed({
  Save-State
  $script:timer.Stop(); $script:tray.Visible = $false; $script:app.Shutdown()
})

Load-State
Read-New | Out-Null      # 启动就把历史队列读满：展开要看的是全部，不是「本次运行以来」
$script:uiScale.ScaleX = [double]$script:P.scale
$script:uiScale.ScaleY = [double]$script:P.scale
Place-Island
Update-Clock
Sync-Live
Update-Meta
Show-Idle
$wxn = if ($script:Weather) { "$($script:Weather.temp)° $($script:Weather.txt) $($script:Weather.city)" } else { '无' }
$sdn = if ($script:Agenda) { "$($script:Agenda.n) 件" } else { '无' }
$p = $script:P
# 启动就把生效值整行打出来：调配置的人第一眼要看到的是「我写的值到底被采纳了还是被夹回了默认」
"[island] pid=$PID queue=$Queue" | Write-Host
"[island] 生效配置 位置=$($p.anchor)($($p.x),$($p.y)) 偏移=$($p.offset)/$($p.offsetY) 缩放=$($p.scale) 宽=$([int](Get-FootW)) " +
  "触发=$($p.trigger)(hot=$($p.hotPx) dwell=$($p.dwellMs)) 停留=$($p.holdMs)ms 收起=$($p.collapseMs)ms 动画=$($p.animOn)($($p.fadeMs)/$($p.animMs)/$($p.slidePx))" | Write-Host
"[island] 生效配置 全屏=$($p.fullscreen) 小条=$($p.showClock) 胶囊=$($p.pillOn) 穿透=$($p.clickThrough) 置顶重申=$($p.autoTopmost) " +
  "队列 $($script:All.Count) 条 未读 $(@(Get-Unread).Count) 天气=$wxn 日程=$sdn" | Write-Host
$script:app = New-Object System.Windows.Application
$script:app.Run($script:win)
