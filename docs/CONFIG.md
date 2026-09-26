# 配置

一个文件：`%LOCALAPPDATA%\win-island\config.json`，三段 —— `island`（悬浮行为）、`weather`、`calendar`。
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
| `dragPx` | int | `4` | `1 ~ 40` | 按下后移动超过这么多像素判定为拖拽（否则算点击/长按） |
| `collapseMs` | int | `500` | `0 ~ 10000` | 面板：光标离开后过多久收起 |
| `openGraceMs` | int | `500` | `0 ~ 5000` | 面板刚展开时的宽限期（这时光标往往还压在触发点上） |
| `holdMs` | int | `6000` | `800 ~ 600000` | 胶囊弹出来以后停多久 |
| `fadeMs` | int | `170` | `0 ~ 2000` | 淡出时长（0 = 直接消失） |
| `animMs` | int | `240` | `0 ~ 2000` | 入场位移动画时长 |
| `slidePx` | int | `8` | `0 ~ 60` | 入场时从上往下滑的距离（0 = 只淡入不滑） |
| `animOn` | bool | `true` | `true / false` | 总开关：关掉 = 上面三个时长全部当 0 处理 |
| `fullscreen` | enum | `float` | `float` / `handle` / `hide` | 前台窗口铺满一屏时：照常悬浮 / 缩成 6px 把手 / 整条隐藏（通知也不弹） |
| `showClock` | bool | `true` | `true / false` | 常驻态显示时钟小条；false = 只留 6px 把手 |
| `pillOn` | bool | `true` | `true / false` | 来通知时弹胶囊。false = 只记未读数，不弹（面板里照旧列得全） |
| `clickThrough` | bool | `true` | `true / false` | 常驻态点击穿透（不吞底下窗口的点击）。光标压上小条的那一段时间会自动收点击，所以拖拽/滚轮仍然可用 |
| `autoTopmost` | bool | `true` | `true / false` | 周期性重申置顶，治「被别的 TopMost 窗口压住」 |
| `showWeather` | bool | `true` | `true / false` | 小条和面板里显示天气段 |
| `showUnread` | bool | `true` | `true / false` | 小条上显示未读角标 |
| `pollMs` | int | `70` | `20 ~ 1000` | 主循环 tick 间隔（毫秒）：光标跟手程度对 CPU 占用。改完立即生效（直接改定时器间隔） |

### 项与项之间的硬关系

这些校正统一在 `Apply-PrefImplications` 里做，实现层不再到处打补丁：

- `trigger` 是 `click` 或 `longpress` 时，`clickThrough` 自动置 `false` —— 穿透开着就永远点不到小条。
- `animOn = false` 时 `fadeMs` / `animMs` / `slidePx` 全部按 0 处理。
- 右键菜单和托盘里的项改的就是这一段的值，**改完立刻落盘**（不是临时状态），重启还在。

### 单位

WPF 的 `Left`/`Top`/`Width` 是 DIP（设备独立像素），`Forms.Screen` 和 Win32 光标坐标是物理像素。
125%/150% 缩放的机器上两者差 1.25/1.5 倍，混用会把岛甩到屏幕外，所以：**这一段的坐标一律 DIP**，
进出边界由 `src/island/geometry.ps1` 统一换算。

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

## `island.request`：让外部程序触发一次动作

不算配置项（`[prefs]` 不会报它「不是已知项」），是一条一次性指令通道：写进 `config.json`，
岛屿下一次热加载（≤1 秒）消费，按 `at` 去重，同一条不会执行两遍。

```json
{ "island": { "request": { "action": "expand", "at": "2026-09-26T10:00:00.000" } } }
```

`action` 认这几个：`expand`（展开面板）、`collapse`（收起）、`pause`、`resume`、
`recenter`（回到顶部居中）、`pill`（重看上一条胶囊）。

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
