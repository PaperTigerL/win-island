# 配置

一个文件：`%LOCALAPPDATA%\win-island\config.json`，按段分开 —— `island`（悬浮行为）、`weather`、`calendar`、
`notify`（外部通知只读展示）、`capture`（抓取层回放）。
第一次运行没有这个文件也能跑，所有项都有默认值；岛屿或 `win-island config` 会为你生成一份。

改完**不用重启**：岛屿每秒比一次文件 mtime，只应用真正变了的项（`[prefs] 热应用 …` 写在 `island.out.log`）。

三条规矩：

- 编码 UTF-8 **无 BOM**（Node 侧 `JSON.parse` 不认 BOM，会当成整份配置读不懂）。
- 写盘是 `.tmp` + 改名，原子替换 —— 半截 JSON 会让那一轮回落默认值，面板上是一次看得见的闪。
- 非法值不会让岛屿崩：数字按范围夹回、枚举不在取值表里就回落默认，并且写一行 `[prefs] …` 说明校正成了什么。

## `island` 段

下面这张表和代码里的 `$PrefsSpec`（`src/island/prefs.ps1`）逐字对齐，`node test/prefs-test.mjs` 会核对，
文档漂了就红。

| 键 | 类型 | 默认 | 取值 / 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `anchor` | enum | `top-center` | `top-left` / `top-center` / `top-right` / `center-left` / `center` / `center-right` / `bottom-left` / `bottom-center` / `bottom-right` / `free` | 九宫格锚位。`free` = 用 `x`/`y` 的绝对坐标（拖拽后自动写这档） |
| `x` | int | `-1` | `-32768 ~ 32768` | anchor=free 时的左上角 X（设备独立像素，DIP）。-1 = 按锚位算 |
| `y` | int | `-1` | `-32768 ~ 32768` | anchor=free 时的左上角 Y（DIP）。-1 = 按锚位算 |
| `offset` | int | `0` | `-4000 ~ 4000` | 在锚位基础上的水平偏移（DIP，正数向右） |
| `offsetY` | int | `0` | `-4000 ~ 4000` | 在锚位基础上的垂直偏移（DIP，正数向下） |
| `scale` | real | `1.0` | `0.7 ~ 1.8` | 整体缩放（滚轮可改）。影响小条、胶囊、面板的全部文字和留白 |
| `wide` | int | `470` | `260 ~ 900` | 基准宽度（DIP，未缩放时） |
| `topGap` | int | `10` | `0 ~ 200` | 胶囊 / 面板和常驻小条之间的间距（DIP） |
| `monitor` | enum | `auto` | `auto` / `primary` | 锚位以哪块屏幕的工作区为准。`auto` = 岛当前所在的那块 |
| `trigger` | enum | `hover` | `hover` / `click` / `longpress` / `manual` | 展开未读面板的触发方式：悬停 / 单击 / 长按 / 只认托盘和管道 API |
| `hotPx` | int | `2` | `0 ~ 60` | hover 档：光标进入小条矩形外扩几个像素算「够到了」 |
| `dwellMs` | int | `0` | `0 ~ 3000` | hover 档：要停多久才算悬停（0 = 一碰到就开） |
| `longPressMs` | int | `550` | `150 ~ 3000` | longpress 档：按下不松手多久算长按 |
| `dragPx` | int | `8` | `1 ~ 40` | 按下后移动超过这么多像素判定为拖拽（否则算点击/长按） |
| `snapPx` | int | `10` | `0 ~ 100` | 拖拽结束吸附：距屏幕边缘或水平中心多少 DIP 内自动贴上去（0 = 关闭；按住 Shift 临时关闭） |
| `collapseMs` | int | `500` | `0 ~ 10000` | 面板：光标离开后过多久收起 |
| `openGraceMs` | int | `500` | `0 ~ 5000` | 面板刚展开时的宽限期（这时光标往往还压在触发点上） |
| `holdMs` | int | `6000` | `800 ~ 600000` | 胶囊弹出来以后停多久 |
| `fadeMs` | int | `170` | `0 ~ 2000` | 淡出时长（0 = 直接消失） |
| `animMs` | int | `240` | `0 ~ 2000` | 入场位移动画时长 |
| `slidePx` | int | `8` | `0 ~ 60` | 入场时从上往下滑的距离（0 = 只淡入不滑） |
| `animOn` | bool | `true` | `true / false` | 总开关：关掉 = 上面三个时长全部当 0 处理 |
| `fullscreen` | enum | `float` | `float` / `handle` / `hide` | 前台窗口铺满一屏时：照常悬浮 / 缩成 6px 把手 / 整条隐藏（通知也不弹） |
| `gameMode` | enum | `auto` | `auto` / `handle` / `hide` / `float` | 检测到游戏/无边框全屏时：auto 缩成 6px 把手 / handle 同上 / hide 整条隐藏 / float 照常悬浮；都暂停音频电平、自动置顶和轮询降载 |
| `showClock` | bool | `true` | `true / false` | 常驻态显示时钟小条；false = 只留 6px 把手 |
| `pillOn` | bool | `true` | `true / false` | 来通知时弹胶囊。false = 只记未读数，不弹（面板里照旧列得全） |
| `clickThrough` | bool | `true` | `true / false` | 常驻态点击穿透（不吞底下窗口的点击）。光标压上小条的那一段时间会自动收点击，所以拖拽/滚轮仍然可用 |
| `autoTopmost` | bool | `true` | `true / false` | 周期性重申置顶，治「被别的 TopMost 窗口压住」 |
| `showWeather` | bool | `true` | `true / false` | 小条和面板里显示天气段 |
| `showUnread` | bool | `true` | `true / false` | 小条上显示未读角标 |
| `audioOn` | bool | `false` | `true / false` | 小条上显示真实频谱（抓系统混音做 FFT，只在内存里留频段能量，不落盘不外传） |
| `audioBands` | int | `12` | `4 ~ 16` | 频谱柱子的格数（40Hz~16kHz 对数分频）。改动会重开抓取流 |
| `audioAllDevices` | bool | `true` | `true / false` | 抓所有活动的输出设备并把每格取最大值，而不是只听系统默认那个（放同一台机器上、但不走默认设备的声音也看得见）。改成 false 退回只听默认设备，改动会重开抓取流 |
| `audioGain` | real | `1.6` | `0.5 ~ 4.0` | 频谱高度增益：1 = 引擎原始值，越大越夸张（顶到 1 就截住） |
| `audioStallMs` | int | `150` | `60 ~ 1000` | 多久没有新的分析窗就判定「声音停了」，随后 250ms 内把柱子压到 0（静音必须归零判据的来源） |
| `audioFloorDb` | int | `46` | `20 ~ 70` | 频谱的显示下限（dB）：低于这个能量的频段算 0（柱子躺平、整段收起），它同时是柱高 0 的锚点，满幅正弦是柱高 1 —— 数值越大，小声的内容越显眼 |
| `audioShowBar` | real | `0.06` | `0.01 ~ 0.99` | 多高的柱子才算「真的在放东西」（柱高口径 0~1，不是线性能量）：低于它就不占小条的位置，安静满 audioHideMs 也收起。默认 0.06 相当于比地板条高出 1px 就算数 —— 嫌它常亮就调大，嫌它漏掉小声内容就调小 |
| `audioHideMs` | int | `1200` | `0 ~ 15000` | 安静多久之后把频谱整段收起（连分隔线）；0 = 只要开着就一直占位不收起 |
| `pollMs` | int | `70` | `20 ~ 1000` | 主循环 tick 间隔（毫秒）：光标跟手程度对 CPU 占用。改完立即生效（直接改定时器间隔） |
| `monitorId` | string | `` | — | 上次拖拽落盘时岛屿所在显示器的设备名（自动写，诊断用） |
| `monitorDpi` | real | `1.0` | `0.5 ~ 4.0` | 上次拖拽落盘时那块屏的 DPI 缩放（自动写，诊断混合 DPI） |

### 项与项之间的硬关系

这些校正统一在 `Apply-PrefImplications` 里做，实现层不再到处打补丁：

- `trigger` 是 `click` 或 `longpress` 时，`clickThrough` 自动置 `false` —— 穿透开着就永远点不到小条。
- `animOn = false` 时 `fadeMs` / `animMs` / `slidePx` 全部按 0 处理。
- 右键菜单和托盘里的项改的就是这一段的值，**改完立刻落盘**（不是临时状态），重启还在。

### 单位

WPF 的 `Left`/`Top`/`Width` 是 DIP（设备独立像素），`Forms.Screen` 和 Win32 光标坐标是物理像素。
125%/150% 缩放的机器上两者差 1.25/1.5 倍，混用会把岛甩到屏幕外，所以：**这一段的坐标一律 DIP**，
进出边界由 `src/island/geometry.ps1` 统一换算。

拖拽同理：松手时 `x`/`y` 存的是 DIP（窗口左沿 + 小条上沿），同时把当时那块屏的 `monitorId` /
`monitorDpi` 一起写回（纯诊断）。吸附阈值 `snapPx` 也是 DIP，所以 125% 缩放下屏幕边缘的吸附距离
在物理像素里会自动变成 12.5px。

**混合 DPI**：工作区/光标换算现在按**目标显示器**取 DPI（`GetDpiForMonitor`，WPF 侧 `VisualTreeHelper.GetDpi`，
失败回落主屏比例），每块屏的 Scale 也纳入几何指纹。双屏不同缩放的实机验证仍未做（本机无双屏），
首次上机请复核 hover 命中与拖拽落点；`monitorDpi` 继续作为诊断字段落盘。

## `weather` 段

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `on` | `true` | 关掉就完全不发外部请求，小条上天气段消失 |
| `everyMin` | `20` | 拉取节流（分钟） |
| `city` | 空 | 城市名，走 open-meteo 地理编码 |
| `lat` / `lon` | 空 | 直接给经纬度，绕开自动定位（特网/无定位权限时用它） |

一个都没填时按 IP 定位。拿不到就不显示天气段，不影响通知主链路。

## `calendar` 段

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `on` | `true` | 关掉 = 不读订阅源（本机导入的库照旧显示） |
| `sources` | `[]` | `.ics` 的 URL 或本地文件路径，多个源并进同一份日程 |
| `everyMin` | `30` | 订阅源刷新节流（分钟） |
| `days` | `3` | 向后看几天 |
| `week1Monday` | 空 | 教学周第 1 周周一（`YYYY-MM-DD`）。空 = 面板上不显示「第 N 周」 |

`week1Monday` 只管面板上那个周次号；导课表用的是 `src/schedule/cal-timetable.mjs` 顶上那个同名常量，
两个地方互不影响 —— 改这里只影响面板，改那里只影响导进来的课。

### 游戏 / 无边框全屏（`gameMode`）

前台窗口**盖满整块显示器**（比的是屏幕边界，不是工作区 —— 真全屏游戏会盖住任务栏）并且
「没有标题栏」或「进程在已知游戏名单里」时，岛屿进入游戏态：

- tick 从 `pollMs` 放宽到 **1500ms**（降 CPU；配置值不动，退出后自动恢复）；
- 暂停 `autoTopmost` 的周期重申（每 2 秒一次 `SetWindowPos` 正是和游戏抢前台的来源之一）；
- 暂停音频频谱（`Set-AudioVizPaused` 调 `audio.ps1` 适配层 `Set-AudioLevelPaused`：停掉
  抓取流、柱子归零、`audio.json` 标 `paused (gameMode)`；退出游戏态自动重开，配置 `audioOn` 不变）；
- 常驻态换成：`auto` / `handle` → 6px 把手，`hide` → 整条隐藏，`float` → 照常悬浮
  （`float` 也照样降载，只是不换形状）。

检测带 2 次去抖（约 2 秒），alt-tab 出去看一眼再回来不会让岛来回闪；退出后恢复配置里的 `pollMs`
和常规常驻态。普通最大化窗口有标题栏，不会被当成游戏（那种归 `fullscreen` 管）。

## `notify` 段（单向：只读）

外部通知只做一件事：**读出来显示**。岛不写回这个文件、不向 agent-hub 发任何请求、也不执行通知里的
任何命令；`from` / `title` / `body` / `level` 全部当展示字符串处理。文件不存在时静默跳过，不影响启动。
按 `id` 去重；面板里点这类条目只会记为已读，不会拉起来源应用（右键可复制全文或忽略）。

这一段的键不在 `$PrefsSpec` 里（它不属于悬浮行为），`config.set` 也不会改它；改完配置由每秒的
mtime 热加载重新解析。

| 键 | 默认 | 取值 | 说明 |
| --- | --- | --- | --- |
| `path` | `D:/OpenSource/lab/sup/group/out/agent-hub/notifications.jsonl` | 绝对路径 | 只读 JSONL。每行 schema `{id,ts,from,title,body,level}`，`id` 必填（去重键），`ts` 用 ISO 时间 |

```json
{ "notify": { "path": "D:/OpenSource/lab/sup/group/out/agent-hub/notifications.jsonl" } }
```

`id` 在岛内部会加 `notify:` 前缀，和通知库的自增行号区分开；同一个 `id` 在文件里出现多次只显示一条。

## `capture` 段

抓取层的回放窗口（重启时把停机期间到达、队列里还没有的通知补回来）。抓取层只在启动时读一次，
改完要重启抓取层（`scripts\launch.ps1` 会先 stop 再 start）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `replayMinutes` | `10` | 启动时回放最近多少分钟内到达的通知（`0` = 关闭回放） |
| `replayMax` | `20` | 一次最多回放多少条（`0` = 关闭回放）；超了保留最新的 |

补录条目在 `queue.jsonl` 里带 `backfilled: true`，面板/胶囊时间列显示成 `补录·HH:MM:SS`，
管道 `list` 也会带这个字段。队列里已有的 id 不会重复补：重启两次、队列轮转之后都安全
（岛屿那边还有一层按 id 去重）。

## `island.request`：让外部程序触发一次动作

不算配置项（`[prefs]` 不会报它「不是已知项」），是一条一次性指令通道：写进 `config.json`，
岛屿下一次热加载（≤1 秒）消费，按 `at` 去重，同一条不会执行两遍。

```json
{ "island": { "request": { "action": "expand", "at": "2026-09-26T10:00:00.000", "src": "pipe" } } }
```

`action` 认这几个：`expand`（展开面板）、`collapse`（收起）、`pause`、`resume`、
`recenter`（回到顶部居中）、`pill`（重看上一条胶囊）。

指令有准入校验：`at` 必须能被解析成时间、并且与当前时间相差不超过 **60 秒**；`src`（可选）必须是
短标识（管道写 `pipe`）。过期、时间戳坏掉、来源非法的指令一律不执行，只在 `island.out.log` 留一行
`[prefs] 忽略 request：…`。这条规则兜的是「重启后把配置里残留的旧指令当成新指令执行」——
`at` 去重是内存态，重启就没了。

实际用起来不用手写 JSON，走管道：

```
{"cmd":"request","action":"expand"}
```

## 用管道改配置（不用开记事本）

抓取层常驻时开着 `\\.\pipe\win-island`，两个命令对账：

```
{"cmd":"config"}                                     -> {ok,path,island,weather,calendar}
{"cmd":"config.set","island":{"scale":1.2}}          -> {ok,island}
```

`config.set` 只并 `island` 段，`weather` / `calendar` 一个字不动；一次最多 32 项，值必须是标量。
它**不在管道这一侧重复校验取值** —— 校验规则只有岛屿上 `$PrefsSpec` 一份，抄两份就会有不一致的说法。
越界值由岛屿夹回并写进 `island.out.log`，再用 `config` 读一次就是盘上真实那份。

## 最小可用的一份

```json
{
  "weather": { "on": true, "everyMin": 20 },
  "calendar": { "on": true, "everyMin": 30, "sources": [] },
  "island": { "fullscreen": "handle" }
}
```
