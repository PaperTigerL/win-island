# 使用手册

- 装 / 起 / 停：[第 1 节](#1-装起停)
- 界面上能做什么：[第 2 节](#2-界面上能做什么)
- 改行为（配置项）：[`docs/CONFIG.md`](CONFIG.md)
- 给别的软件调用：[第 5 节](#5-给别的软件调用命名管道)
- 日程与课表导入：[第 6 节](#6-日程与课表)
- 出问题：[第 8 节](#8-出问题了按这个顺序查)

命令都在仓库根目录下执行（路径是相对的，克隆到哪都能跑）。

## 1. 装 / 起 / 停

### 前提

| 要 | 为什么 | 不要会怎样 |
| --- | --- | --- |
| Windows 11 | 通知库 `wpndatabase.db` 的表结构按 10.0.26200 实测 | 未验证 |
| Node 22+ | 抓取层用 `node:sqlite` 读通知库 | 起不来抓取层（岛屿本身不需要 Node） |
| PowerShell 5.1 | 系统自带，渲染层是 WPF | — |
| 管理员权限 | **不需要** | — |

### 起

```powershell
.\bin\win-island.exe start        # 编译出来的启动器：找代码、起两层、回状态
.\bin\win-island.exe status       # 两层在不在、未读几条（--json 给机器读）
.\bin\win-island.exe stop
.\bin\win-island.exe config       # 用记事本打开 config.json
.\bin\win-island.exe help
```

不想用 exe 就直接跑脚本，效果一样（exe 也只是转调它们）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\launch.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1
```

**重启岛屿一律走 `scripts\launch.ps1`**。手工 `Start-Process` 起的实例，父 shell 被杀掉时出现过
「进程活着、窗口从不显示」的静默失效，`probe-windows.ps1` 才查得出来 —— 别给自己留这种坑。

### 验一下整条链路

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\send-test.ps1 -Count 3
```

顶部胶囊弹出来、带 `+N` 折叠，就说明「通知中心 → 抓取层 → 队列 → 岛屿」整条是通的。

### 同一份数据目录只允许一份抓取层

抓取层用命名管道（默认 `\\.\pipe\win-island`，可用 `WIN_ISLAND_PIPE` 换）的独占性当锁：
第二份启动会因为管道被占**以退出码 7 退出**，不会覆盖 `capture.pid`、也不会往队列追加
（会先等约 3 秒再放弃，给 `restart` 的旧进程留出释放管道的时间；`capture.log` 里有一行「单实例保护：…」）。
pid 文件只是第二道：Windows 的 pid 会被复用，
所以还要确认那个 pid 真的是 node 进程才算数。

两份安装（仓库 + `D:\win-island` 运行副本）共用 `%LOCALAPPDATA%\win-island` 时：
`scripts\stop.ps1` 只停**本仓库脚本完整路径**的那一份，另一份的进程和 pid 文件都不动
（pid 文件先核对命令行归属，属于别人的只跳过）；但抓取层因为管道独占只能有一份。
要同时跑，给实验副本设 `WIN_ISLAND_HOME` + `WIN_ISLAND_PIPE`（数据目录和管道名都独立）。

### 开机自启

一条命令注册一个「登录时」触发的计划任务：

```powershell
powershell -File .\scripts\autostart.ps1              # 注册（已存在就覆盖）
powershell -File .\scripts\autostart.ps1 -Status      # 查：状态、动作、触发、电池、上次结果
powershell -File .\scripts\autostart.ps1 -Uninstall   # 删（不动正在跑的进程）
```

为什么是计划任务而不是往「启动」文件夹塞快捷方式：这台是笔记本，任务能把电池策略写死
（`DisallowStartIfOnBatteries=False`、`StopIfGoingOnBatteries=False`，合盖搬去会议室照样起），
而且 `LastTaskResult` 是可查的证据，不靠「我看桌面上有岛」。触发器选 `AtLogOn` 而不是 `AtStartup`：
岛屿要画窗口，必须跑在有桌面的交互会话里，开机未登录时起来的进程进不了桌面。
动作直接指向 `bin\win-island.exe start`（winexe，不申请控制台），所以登录时不闪黑框，也不需要 wscript 包装。

想立刻验一遍，不用等注销：

```powershell
schtasks /Run /TN win-island        # 手工触发，等价于跑一遍登录时那条动作
.\bin\win-island.exe status         # 两个 pid 在不在
```

`-Status` 里 `上次结果 0x41303` = 这个任务还没跑过；`0x800710E0` = 上一次还没退出，被 `IgnoreNew` 挡了
（启动器现在是 detached 起法，正常情况下不会再把任务挂着不放）。

### 让 Windows 搜索能找到它

仓库是解压即用的，谁都没往系统里登记过。一条命令把自己登进当前用户的开始菜单，
Windows 搜索的「应用」那一栏读的就是这个目录：

```powershell
powershell -File .\scripts\startmenu.ps1              # 注册（已存在就覆盖）
powershell -File .\scripts\startmenu.ps1 -Status      # 查：指向、图标、有没有进应用列表
powershell -File .\scripts\startmenu.ps1 -Uninstall   # 删（不动正在跑的进程）
```

按 Win 打 `win` 或 `原子岛` 都能命中 —— 项目名就叫 `win-island 原子岛`，中英文各留一个词是故意的，
搜索按应用名（= 文件名去掉 `.lnk`）匹配，这样两种打法都中，而开始菜单里只多一条。
这个只管「能被搜到、能被点开」，和登录自启是两件事（上一节），别指望它替代计划任务 ——
快捷方式表达不了电池策略。

## 2. 界面上能做什么

常驻态是一枚小条（时钟 + 天气 + 未读角标）。`showClock=false` 时缩成 6px 把手。

| 动作 | 结果 | 可配置项 |
| --- | --- | --- |
| 来通知 | 弹出胶囊（应用名 + 标题 + 正文），到点自动收起；鼠标停在上面不消失 | `pillOn` `holdMs` |
| 光标压上小条 | 展开未读面板 | `trigger` `hotPx` `dwellMs` |
| 单击 / 长按小条 | 同上 | `trigger=click` / `longpress` |
| 点胶囊 | 跳到来源应用（见第 3 节） | — |
| 按住小条拖动 | 移动位置，松手在 10 DIP 内自动吸附屏幕边缘/水平中心（按住 Shift 松手不吸附），落盘 DIP | `dragPx` `snapPx` |
| 进游戏 / 无边框全屏 | 自动切 6px 把手（可配隐藏）、降载，退出游戏自动恢复 | `gameMode` |
| 在小条上滚滚轮 | 整体缩放 0.7 ~ 1.8，落盘 | `scale` |
| 右键小条 / 胶囊 / 托盘图标 | 菜单 | — |
| 托盘图标 | 常驻入口，界面被全屏盖住时用它 | — |
| 小条上那排频谱柱子 | 默认关着；打开后实时跟系统混音（见下） | `audioOn` 等 8 项 |

菜单项**按「先能改，再能看」排**：前四项就是行为开关（全屏时 / 触发方式 / 点击穿透 / 动画），
接着是复位到顶部居中、打开配置文件，再往下才是暂停、重看上一条、复制、刷新天气日程、打开岛目录、退出。
改完立刻写进 `config.json`，重启还在 —— 不是临时状态。

一个曾经真实存在过的坑，写在这儿是为了让你别再造出来：右键菜单弹出来却**点不动**，
是因为 `autoTopmost` 周期重申置顶会把岛屿自己的菜单压到窗口下面。现在菜单/托盘开着时会暂停重申
（`Test-MenuUp` / `Sync-Topmost`）。

### 面板里有什么

顶上一行时钟 + 天气（`28° 阴 城市名`）；中间未读列表（一行一条，标题 + 正文摘要，行尾有「复制」）；
底下今天的日程，右上角「本周课表」摊开整周（一天一组，过去的组压暗，含每天放假 / 调休补班标记）；
最底一行是计数和提示。今天没课也留着那段，写一句为什么，不把后天的课摊进来冒充今天的安排。

### 小条上那排频谱柱子

默认关着。开法三种，任选：右键小条 → `实时频谱：…`（菜单文字后面直接跟着当前状态，
「开着但没抓到音频」在这个入口上看得出来）；`{"cmd":"config.set","island":{"audioOn":true}}`；
或直接在 `config.json` 里写。关掉是同一个入口反着走一遍。柱子跟着 `audioBands`（格数）、
`audioGain`（增益）、`audioStallMs`（多久没新声音就压到 0）、`audioFloorDb`（多小的声音还算看得见）、
`audioShowBar`（多高的柱子才算「在放」）、`audioHideMs`（安静多久整段收起）、
`audioAllDevices`（要不要连非默认输出设备一起抓）走，都在 [`CONFIG.md`](CONFIG.md) 里。

柱高不是「能量 × 高度」那种线性映射：小声内容在线性口径下 17 像素里长不到 1 像素，
现在按 dB 折算（`audioFloorDb` 以下是 0，满幅是 1）。放同一台机器上、但没走默认设备的声音
默认也抓得到，`{"cmd":"audio"}` 的 `sources` 逐台报抓到多少分析窗。

它是真数据不是动画：抓的是系统混音（WASAPI loopback），所以**扬声器里正在响的都会画出来**，
包括你不想被旁人看见的东西 —— 这也是它默认关着、对外只给每格一个 0~1 的能量数
（不存采样、不做识别、不出这台机器）的原因。安静房间里它躺平是对的：整机没声音时 loopback 一个包都不给。

进游戏 / 无边框全屏时频谱会**暂停**（抓取流停掉、柱子归零，`audio.json` 标 `paused (gameMode)`），
退出后自动接着开，`audioOn` 配置一个字不改 —— 这是 `gameMode` 降载的一部分。

## 3. 点开胶囊跳到来源应用

按三级走，全实测过：

1. **载荷里的 `launch` 协议串 + `activationType`** —— 这就是系统自己用来跳转的那串参数，
   所以「点通知进那条会话」这类深链是原样复用的。实测 `ms-settings:notifications` 点完设置窗口真的出现。
2. **按 AUMID 唤到前台**。两种 AUMID 都验过：
   - 商店包（开始菜单注册名那种）走 `explorer.exe shell:AppsFolder\<AUMID>`；
   - Win32 应用注册的 AUMID 本身就是 exe 路径（有些软件在开始菜单里的 AppID 就是它的 exe），这种直接起。
3. 两样都没有就只写一行日志，**不猜**。

故意挡掉的：`launch` 以 `file:` / `javascript:` / `vbscript:` / `about:` / `search-ms:` / `ms-msdt:` /
`\\`（UNC）开头的一律不执行，日志写「拒绝这种写法」。那是**别的应用写进数据库的一行字符串**，
不该有权力让我们的进程替它拉起本地文件或脚本 —— 这一条和「点不点横幅」无关，是边界。

有些应用的 `launch` 不是 URL（比如某个 IDE 的是 `notificationId=<一串哈希>`），没有协议头就不硬拼成命令，
退到第 2 条 AUMID 路径。

## 4. 复制某条消息

四个入口，拿到的字节完全一样（同一个 `copy` 字段）：

1. 面板里鼠标移到某一行 → 行尾浮出「复制」小胶囊 → 点它。
2. 那一行上右键 → 「复制这条（完整正文）」/「复制这条（带来源和时间）」。
3. 点中一行按 `Ctrl+C`。
4. 右键小条 → 「复制上一条（完整正文）」/「复制全部未读」。

成功时行下方浮出「已复制 N 行 · 共 M 字」，1.6 秒后自己消失；失败提示变红并写明原因。

换行统一成 **CRLF**：原始 `<text>` 元素里嵌的是裸 LF，混着进剪贴板粘到记事本 / Word 就糊成一行。
剪贴板是独占锁（`OpenClipboard`），远程桌面和剪贴板管理器常占着不放，所以失败重试 3 次；
还不行就把原文写进 `%LOCALAPPDATA%\win-island\last-copy.txt`，提示里会这么说明，不至于白丢。

## 5. 给别的软件调用（命名管道）

抓取层常驻时开 `\\.\pipe\win-island`，**一行 JSON 进、一行 JSON 出**。
为什么是管道不是 HTTP 端口：只在本机可达、不占 TCP 端口、不经防火墙。

```
{"cmd":"ping"}                                    -> {ok,pid,at,n,unread}
{"cmd":"list","limit":20}                         -> {ok,n,items:[{id,app,at,title,body,lines,unread}]}
                                                   默认只给未读；加 "unread":false 给全部
{"cmd":"text","id":"9442"}                        -> {ok,id,text}            完整正文（CRLF），不动剪贴板
{"cmd":"text","id":"9442","withSource":true}      -> 同上，末尾多一行「—— 来自 <应用> · <时间>」
{"cmd":"copy","id":"9442"}                        -> {ok,id,chars,lines}     写进系统剪贴板
{"cmd":"copy","text":"..."}                        -> 同上，直接复制你给的文本
{"cmd":"config"}                                   -> {ok,path,island,weather,calendar}
{"cmd":"config.set","island":{"scale":1.2}}         -> {ok,island}            只并 island 段
{"cmd":"request","action":"expand"}                 -> {ok,action,at}         让岛做一次动作
{"cmd":"audio"}                                    -> {ok,on,bands[],bars[],level,peakHz,windows,idleMs,status,at}
                                                    频谱快照（只有频段能量数字，没有音频内容）
```

`request` 认的动作：`expand` / `collapse` / `pause` / `resume` / `recenter` / `pill`。
它写的是 `config.json` 里那个 `island.request`，岛屿下一次热加载（≤1 秒）消费，按 `at` 去重 ——
不再新开端口的原因：岛本来就在盯这个文件，多一条通道就多一处会失败的 IO。

失败一律 `{"ok":false,"reason":"可读的中文"}`，不给堆栈。

PowerShell 里最省事的一段：

```powershell
$c = New-Object System.IO.Pipes.NamedPipeClientStream('.','win-island','InOut')
$c.Connect(2000)
$w = New-Object System.IO.StreamWriter($c); $w.AutoFlush = $true
$r = New-Object System.IO.StreamReader($c)
$w.WriteLine('{"cmd":"ping"}'); $r.ReadLine()
$w.WriteLine('{"cmd":"config.set","island":{"anchor":"bottom-center"}}'); $r.ReadLine()
```

两条边界说在前面：

- `text` / `copy` 返回的是别的应用写进通知库的文本，**只当数据用**：不拿它拼命令、不当链接点开。
- **同一个 Windows 账户下的任何进程**都能连上这个管道读到通知正文（群名、邮件主题都在里面）。
  这和它本来就能直接读 `queue.jsonl` 是同一个信任边界 —— 所以这些文件绝不进公开仓库。

## 6. 日程与课表

两路数据并进同一份 `agenda.json`：订阅源（`config.json` 里 `calendar.sources`，`.ics` 的 URL 或文件）
和本机导入库 `cal.db`。岛上看不出哪路来的，字段一个都没多。

流程固定三步：**选文件 → 预览 → 确认写入**。前两步库里一个字不动。

```powershell
node .\src\schedule\cal-import.mjs 你的文件.ics                 # 只预览
node .\src\schedule\cal-import.mjs 你的文件.ics --serve         # 开 http://127.0.0.1:8733/ 勾着选
node .\src\schedule\cal-import.mjs 你的文件.ics --as 来源名 --commit
node .\src\schedule\cal-import.mjs --list                       # 库里有哪些来源、各多少条
node .\src\schedule\cal-import.mjs --drop 来源名                # 撤销一次导入
node .\src\schedule\cal-import.mjs --exclude 3,7                # 按 id 关掉显示（数据还在库里）
```

`--serve` 页面上两种勾选框语义不同，别弄混：**待导入**那栏的勾 = 「这条要不要进库」；
**库里已有**那栏的勾 = 「这条要不要在岛上显示」。时间不对的条目直接在行内输入框改掉再提交，改完就是入库的时间。

凡是动过库的出口（`--commit` / `--drop` / `--exclude`、页面上的导入和勾选）都会当场把 `agenda.json`
**和** `week.json` 两份一起重建。抓取层自己那轮刷新最长隔 30 分钟，不当场重建就会出现
「今日安排是新的、本周课表还是旧的」—— 同一次导入两个版本最难查。走代码调用时用
`src/schedule/meta.mjs` 的 `rebuildSchedule()`，别只调 `fetchAgenda`。

认格式：`ics` / `csv` / `json` / adb `content query` 输出，按**字节**嗅探（扩展名只是提示），
编码 UTF-8 / GBK / UTF-16 自动判，字段名按同义词表映射（标题 / SUMMARY / title / 事件主题…）。
重复事件在读取时展开（`DAILY/WEEKLY/MONTHLY/YEARLY` + `INTERVAL/BYDAY/BYSETPOS/BYMONTHDAY/COUNT/UNTIL`
+ `EXDATE/RDATE`），按**墙上时间**走，所以每周日的课在夏令时地区也还是周日。
去重键是 `(来源, UID, 开始时间)`；不同来源出现同一条只报冲突、两份都留，不替你删。

### 教务系统那张课表表格 → 日程

`src/schedule/cal-timetable.mjs` 把表格里读得出的（课名、周次范围、教师、地点、星期、节次）
写成 `COURSES` 常量，生成 `.ics`，再走上面的导入链路：

```powershell
node .\src\schedule\cal-timetable.mjs
node .\src\schedule\cal-import.mjs timetable.ics --as 课程表 --commit
```

表格本身不含两样必需信息，所以它们写死在那个文件顶上当常量，**换学期 / 换学校必须改这两处**：

| 常量 | 为什么读不出来 |
| --- | --- |
| `WEEK1_MONDAY` | 第 1 周周一是哪天（校历上的开学日）。「2-9 周」只有配上它才变成日期 |
| `SLOTS` | 第几节 → 几点。教学日历只写「1-2 节」，作息表是学校自己定的 |

这两个值错了岛上就是错的，第一次导入务必 `--serve` 开页面扫一眼。重跑是同一来源替换，不会堆两份。
教师按周变的课（轮课）拆成**一周一条**，岛上那一行显示的就是那一周真正的老师。

面板上「本周安排 · 第 N 周」那个周次号读的是 `config.json` 里 `calendar.week1Monday`，
和上面那个常量是两个地方：改这里只影响导进来的课，改那里才影响面板上那个「第几周」。

### 手机日程

```powershell
node .\src\schedule\cal-pull.mjs              # 自己找 adb、查权限、拉文件，最后给一份预览
node .\src\schedule\cal-pull.mjs --import     # 上面看着对再跑这个，来源记成「手机」
```

三条路的现实情况：

- **手机日历 App 手动导出到下载目录** → 一定通（`--via-files` 走的就是它）。
- **adb `content query`** → adb 本身有（platform-tools 1.0.41），但 `READ_CALENDAR` 能不能给到 shell uid
  取决于厂商，**未实测**；开了 USB 调试跑一次才知道。
- **直接读日历数据库 / `adb backup` / `run-as`** → 非 debuggable 的系统应用，这条路是死的，不用试。

没有「不碰手机设置就自动同步」这种方案，别按那个预期提需求。导入的日程也不会写回手机。

### 机器可读接口

预览页在跑的时候（只绑 127.0.0.1）：

```
GET http://127.0.0.1:8733/api/schedule   = agenda.json 那一行 JSON（三天窗口 + 下一条）
GET http://127.0.0.1:8733/api/week       = week.json  那一行 JSON（整周，含每天放假/补班）
```

`node .\src\schedule\cal-preview.mjs` 可以单独把预览页起起来。假期数据取 `timor.tech`，按年缓存
（`holidays.json`）：放假是红标、调休补班是蓝标（语义相反，颜色也相反）。拉不到不影响别的，
岛上顶多少了假期标签。

## 7. 命令行参数

`src/island/island.ps1`（这些只是**本次启动**的覆盖，压过 `config.json`，不写盘；要长期生效改配置文件）：

| 参数 | 默认 | 对应配置项 |
| --- | --- | --- |
| `-HoldMs` | 6000 | `holdMs` |
| `-TopPx` | 10 | `topGap` |
| `-Wide` | 470 | `wide` |
| `-PollMs` | 70 | `pollMs` |
| `-HotPx` | 2 | `hotPx` |
| `-NoClock` | — | `showClock=false` |
| `-Queue` | 数据目录里的 `queue.jsonl` | — |

抓取层的环境变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `WIN_ISLAND_HOME` | `%LOCALAPPDATA%\win-island` | 数据目录。测试就指到临时目录，不碰真实库 |
| `WIN_ISLAND_POLL` | 700 | 轮询通知库的毫秒数 |
| `WIN_ISLAND_KEEP` | 120 | 队列保留条数 |
| `WIN_ISLAND_PIPE` | `\\.\pipe\win-island` | 管道名。测试/实验副本各用一条，互不抢占 |
| `WIN_ISLAND_RELAUNCHED` | — | 内部用：带 `--experimental-sqlite` 重启自己时防循环 |

## 8. 出问题了，按这个顺序查

```powershell
.\bin\win-island.exe status                                  # 两层在不在、未读几条
node .\src\capture\capture.mjs --once                        # 不启界面，只看「库里有没有抓到东西」
powershell -File .\tools\probe-windows.ps1 -ProcId (Get-Content "$env:LOCALAPPDATA\win-island\island.pid")
node .\tools\peek-queue.cjs                                  # 每条通知带不带 launch / AUMID
```

判据是**窗口是不是真显示 + 队列里是不是真有货**，不是日志里那句「已启动」：

- `capture.log` 有货、`island.out.log` 里却没有 `[island] 渲染` 行 → 进程活着但窗口没显示，用 `launch.ps1` 重启。
- `island.err.log` 空 = 界面没报错。
- 重启后 `capture.log` 有一行「回放最近 N 分钟 …」= 补录过；面板上那些行的时间带「补录·」。
- 抓取层以**退出码 7** 结束、日志里有「单实例保护」= 已经有一份在跑，不是崩溃。
- `probe-windows.ps1` 里 `vis=False` = 窗口存在但没画出来。
- **胶囊没弹，但右下角原生 toast 有** → 那条应用没走通知中心（或者「在通知中心显示」被关了、
  或者正在专注助手/免打扰），库里根本没有行。这不是 bug，是边界。
- 想确认「点得动」：`probe-windows.ps1` + `ui-probe.ps1`（真右键、真点菜单项）。

日志和数据（`island.*.log` 是 **GBK** 编码，用 `Get-Content` 或记事本打开是对的，
`cat` / `iconv -f UTF-8` 会看到乱码）：

```
%LOCALAPPDATA%\win-island\
  queue.jsonl      通知队列（岛屿读这个）        capture.log     抓到什么、延迟多少、API 起没起
  live.json        通知中心现存 id               capture.out/err 抓取层标准输出
  read.json        岛屿的已读账本（带 BOM）      island.out.log   渲染行 + 点开跳转的行
  config.json      配置（无 BOM）                island.err.log   界面报错，空就是没问题
  weather.json / agenda.json / week.json / holidays.json / geo.json   缓存
  cal.db           本机导入的日程库（SQLite WAL）  cal-inbox\      从手机拉的原始文件
  last-copy.txt    只在剪贴板写不进去时才出现（兜底，不是正常路径）
```

为什么数据不放项目目录：通知正文里有群名、邮件主题这类东西，而项目目录是要推到 GitHub 的。
队列超过 512KB 会自动只留最近 120 条。

## 9. 自证判据

别信文档说的，跑这几条（会真的动鼠标、剪贴板，用临时数据目录）：

```powershell
node .\scripts\test-all.mjs          # 全跑：BOM/语法 + 单元那 10 套 + 端到端 api/copy + 频谱 103
node .\scripts\test-all.mjs --unit   # 只跑不碰桌面的 10 套（含频谱契约，不需要声卡）
node .\test\cal-test.mjs --expect 59          # 解析层：编码/时区/重复/提醒/字段映射/坏数据
node .\test\cal-flow-test.mjs --expect 51     # 全流程 + 真 HTTP：预览不写库 → 去重 → 冲突 → 展开 →
                                              #   并进 agenda.json（字段形状不变）→ 真发 HTTP 勾几条写几条
node .\test\prefs-test.mjs --expect 66        # 配置项：spec ↔ 文档一致 + 非法值回落 + request/游戏态/吸附
node .\test\queue-test.mjs --expect 22        # 队列：半行不吞、轮转/重复不重复计数、坏行不挡后一行（不启 WPF）
node .\test\replay-test.mjs --expect 21       # 回放：窗口/上限/幂等（假通知库，不碰真库）
node .\test\single-instance-test.mjs --expect 9   # 单实例：管道独占抢不到就退出码 7（不碰真库）
node .\test\geometry-test.mjs --expect 22     # 游戏识别 + 拖拽吸附 + DPI 指纹（不启 WPF）
node .\test\audio-contract-test.mjs --expect 15   # 频谱契约：引擎/暂停钩子/audio.json/管道/配置（不碰声卡）
node .\test\api-test.mjs                      # 另一个进程走管道取全文 + 写剪贴板（含 config/request/audio）
node .\test\copy-test.mjs                     # 真点面板行尾「复制」，逐行比对系统剪贴板字节
node .\test\audio-test.mjs --expect 103       # 频谱真判据：放合成纯音看落格 + 数屏幕上那块矩形的亮像素
```

后几条的判据是**系统剪贴板里的字节**、**盘上的 `config.json`** 和**屏幕上的亮像素**，
不是日志里那句「已复制」/「已应用」。`audio-test` 要真实音频端点，纯远程会话里会失败，
但那本来就不是能跑频谱的机器。

## 10. 已知做不到（别当 bug 问）

1. 右下角原生 toast 还在弹，现在是「两处都显示」。真要只留岛屿就得关掉系统横幅，
   而「关掉横幅后通知还进不进库」这一层耦合没实测过 —— 谁想做谁先测那一层，别先改界面。
2. 应用自己画的气泡 / 悬浮窗（不走通知中心的）抓不到，库里根本没有行。
3. 在 设置 > 通知 里被关掉、或「在通知中心显示」被取消的应用，不入库。
4. 专注助手 / 免打扰期间的通知不进胶囊。
5. 胶囊里没有应用图标，只有文字角标。
6. 点开跳转只对「载荷带协议串」或「AUMID 能在开始菜单查到」的应用有效；
   AUMID 为空、或应用压根没注册可激活入口的，点了就是收了，日志写明原因。
7. 「未读」是岛屿自己记的账：库里没有任何已读列，所以「系统侧消失」和「你处理过了」分不开。
   副作用：想「先把系统里的清干净，再在岛上复制全部未读」是反的，清掉就等于消失。
8. 面板里的「复制」胶囊要 hover 才出现（列表窄，常驻会挤掉时间）。脚本驱动时要留出 hover 生效的时间，
   否则 UIA 里根本没有这个元素。
9. 补班那天到底按周几的课表上，公开接口给不出来（假期接口只给「补哪个节」，不给换成周几）。
   学校自己放的假（运动会、小学期）也不在法定节假日表里。
10. 节次 → 时刻（`SLOTS`）是学校作息，接口给不了，只能自己核对。

## 11. 撤销这一切

```powershell
.\bin\win-island.exe stop
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\win-island"   # 数据目录，删了就干净了
Remove-Item -Recurse -Force <仓库目录>
```
