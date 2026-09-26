Windows 原子岛 —— 把所有软件的通知收进屏幕顶部的一枚胶囊
================================================================

现在能做什么
------------
任何走 Windows 通知中心（右下角 toast）的通知，都会同时出现在屏幕顶部正中的胶囊里：
应用名角标 + 标题 + 正文，6 秒后自动收起；期间鼠标停在上面不会消失。
左键点胶囊 = 跳到来源应用（和点右下角那条横幅做的是同一件事，见下「点开胶囊」）。
右键胶囊或托盘图标可以：暂停显示 / 重看上一条 / 打开岛目录 / 退出。

鼠标移到胶囊上向上滑（或点它展开）会拉开一块面板：顶上是一行时钟 + 天气（28° 阴 城市名），
中间是未读列表（一行一条，标题加正文摘要），底下是今天的日程，最下面一行是计数和提示。
面板里可以只读不动剪贴板地拿走某条的完整正文，见下「复制某条消息」。

点开胶囊走的是哪条路（按优先级）
--------------------------------
1. 通知载荷里带的 launch 协议串 + activationType —— 这就是系统自己用来跳转的那串参数，
   所以「QQ 通知点进那条会话」「设置通知点进设置页」这类深链是原样复用的。
   实测：ms-settings:notifications 点完「设置」窗口真的出现（点之前没有这个窗口）。
2. 没有协议串就按 AUMID 把应用唤到前台。AUMID 有两种，都验过：
   - 商店包（Microsoft.WindowsCalculator_...!App、WorkBuddy.WorkBuddy 这类开始菜单注册名）
     走 explorer.exe shell:AppsFolder\<AUMID>。实测点完 WorkBuddy 从第 5 层被唤到前台。
   - Win32 应用注册的 AUMID 本身就是一个 exe 路径（微信在开始菜单里的 AppID 就是
     C:\path\to\Weixin.exe），这种直接起 exe。实测点完记事本真的多出一个进程。
3. 两样都没有就只在日志里写一行「这条通知没带可跳转的信息」，不猜。

故意挡掉的写法：launch 里以 file: / javascript: / vbscript: / about: / search-ms: / ms-msdt: /
\\开头（UNC）的一律不执行，日志会写「拒绝这种写法」。通知正文是别的应用写进数据库的内容，
不该由我们的进程替它拉起本地文件或脚本 —— 这一条和「点不点横幅」无关，是边界。

怎么用
------
  powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1
      启动（抓取层 + 岛屿两个进程）。重复执行会先停旧的再起新的。
      重启一律走这个脚本：手工 Start-Process 起的实例，父 shell 被杀掉时出现过
      「进程活着、窗口从不显示」的静默失效（2026-09-26 抓到过一次）。
  powershell ... -File .\launch.ps1 -HoldMs 30000
      想慢慢试点跳转的时候把停留时间调长（默认 6 秒不够用）。
  powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
      停止。
  node .\capture.mjs --once
      不启动界面，只打印「现在库里有什么」，用来看抓取本身有没有坏。
  node .\capture.mjs --replay
      把库里现存通知全部灌进队列（看历史效果）。
  powershell -File .\send-test.ps1 -Count 3
      发测试通知，验证整条链路。
  powershell -File .\send-test.ps1 -Launch 'ms-settings:notifications'
      发一条带跳转协议的通知，用来试点开跳转。
  powershell -File .\send-test.ps1 -Aumid 'WorkBuddy.WorkBuddy'
      冒充某个应用发通知，用来验「按 AUMID 唤到前台」这条路。
  powershell -File .\probe-windows.ps1 -ProcId <岛屿pid>
      列出这个进程的全部顶层窗口和 vis 标志。判断「胶囊到底显示没显示」用它，别看日志猜。
      岛屿 pid 在 %LOCALAPPDATA%\win-island\island.pid。
  node .\peek-queue.cjs
      打印队列里每条通知带没带 launch / AUMID，用来看「点开能跳」对哪些应用有效。
  node .\bom.mjs
      改过任何 .ps1 之后跑一下：PowerShell 5.1 读没有 BOM 的 UTF-8 会按 GBK 解，
      中文注释的最后一个字节可能变成反引号，把下一行（比如 param 那行）吞掉 —— 症状是
      参数静默变成 null，而不是报错。

复制某条消息（四个入口，拿到的字节完全一样）
--------------------------------------------
  1. 面板里鼠标移到某一行 → 行尾浮出「复制」小胶囊 → 点它（只要正文）。
  2. 在那一行上右键 → 「复制这条（完整正文）」或「复制这条（带来源和时间）」。
  3. 点中一行按 Ctrl+C。
  4. 右键胶囊 → 「复制上一条（完整正文）」/「复制全部未读」。
成功时行下方浮出「已复制 N 行 · 共 M 字」，1.6 秒后自己消失；失败提示变红并写明原因。

正文是抓取层算好的一个 copy 字段（标题 + 各行正文），面板和下面的管道 API 用的是同一个字段，
所以「面板里复制到的」和「别的软件 text 命令拿到的」不会有第二种写法。
换行统一成 CRLF：队列里的 <text> 元素内部原本嵌着裸 LF，混着 CRLF 一起进剪贴板，
粘到记事本/Word 就糊成一行 —— 这就是之前「复制了个寂寞」的真实原因，现在在抓取层就摊平成
一行一个元素、一次定成 CRLF。
剪贴板是独占锁（OpenClipboard），远程桌面和剪贴板管理器常常占着不放，所以失败会重试 3 次；
还不行就把原文写进 %LOCALAPPDATA%\win-island\last-copy.txt，提示里会这么说明，不至于白丢。

验证（判据是系统剪贴板里的字节，不是日志里那句「已复制」）：
  node .\copy-test.mjs
      真发一条多行通知（含中文、缩进、&&、代码块围栏）→ 真上滑开面板 → 真点行尾胶囊 →
      真右键点菜单 → 逐行比对 Get-Clipboard 读回来的东西，并要求裸 LF = 0。
      两条入口各跑一遍，全过才打 PASS。

给别的软件调用（命名管道）
--------------------------
抓取层常驻时开一个管道 \\.\pipe\win-island，一行 JSON 进、一行 JSON 出。
为什么是管道不是 HTTP 端口：只在本机可达、不占 TCP 端口、不经防火墙，也不和 sub-updater
的状态页（8732）抢端口。
  {"cmd":"ping"}                                  -> {ok,pid,at,n,unread}
  {"cmd":"list","limit":20}                       -> {ok,n,items:[{id,app,at,title,body,lines,unread}]}
                                                    默认只给未读；加 "unread":false 给全部
  {"cmd":"text","id":"9442"}                      -> {ok,id,text}      拿完整正文（CRLF），不动剪贴板
  {"cmd":"text","id":"9442","withSource":true}     -> 同上，末尾多一行「—— 来自 <应用> · <时间>」
  {"cmd":"copy","id":"9442"}                      -> {ok,id,chars,lines}  写进系统剪贴板
  {"cmd":"copy","text":"..."}                      -> 同上，直接复制你给的文本，不经过通知
失败一律是 {"ok":false,"reason":"可读的中文"}，不给堆栈。

PowerShell 调用（最省事的一段）：
  $c = New-Object System.IO.Pipes.NamedPipeClientStream('.','win-island','InOut')
  $c.Connect(2000)
  $w = New-Object System.IO.StreamWriter($c); $w.AutoFlush = $true
  $r = New-Object System.IO.StreamReader($c)
  $w.WriteLine('{"cmd":"ping"}'); $r.ReadLine()
  $w.WriteLine('{"cmd":"text","id":"9442"}'); $r.ReadLine()

验证：
  node .\api-test.mjs
      用另一个进程去连管道（不是同进程函数调用），先把剪贴板设成对照值 SENTINEL-未复制，
      发一条真通知，再走 ping / list / text / copy，要求 copy 之后剪贴板读回来的字节
      == text 命令返回的字节、裸 LF = 0，并且 copy 直接给文本那条也能进剪贴板。

两条边界要说在前面：
  - text / copy 返回的是别的应用写进通知库的文本，只当数据用：不要拿它拼命令、不要当链接
    点开。面板侧对通知带的 launch 串已经挡掉 file: / javascript: / UNC 那一类（见上），
    API 侧同样不执行任何内容。
  - 同一个 Windows 账户下的任何进程都能连上这个管道读到通知正文（QQ 群名、邮件主题都在里面）。
    这和它本来就能直接读 queue.jsonl 是同一个信任边界 —— 所以这些文件绝不进公开仓库。

日程导入（多来源、多格式，含手机日历）
--------------------------------------
日程有两路数据：订阅的 .ics URL/文件（config.json 里 calendar.sources），和本机导入库
%LOCALAPPDATA%\win-island\cal.db。两路并进同一份 agenda.json，岛上的「今日安排」看不出来
哪路来的，字段一个都没多。

流程固定是三步：选文件 → 预览（可勾选、可改异常条目）→ 确认写入。前两步库里一个字都不动。

  node .\cal-import.mjs <文件或目录> [--as 来源名] [--format ics|csv|json|adb]
      只预览：把解析结果、每一条的问题（编码、没带时区、结束早于开始、重复规则不支持）打出来。
  node .\cal-import.mjs <文件或目录> --commit
      真写进库，写完打印「新写 / 重复 / 没时间跳过 / 沿用上次勾掉」和跨来源冲突。
      同一份文件重复 --commit 不会写两遍。
  node .\cal-import.mjs <文件或目录> --serve
      开预览页 http://127.0.0.1:8733/ 让你勾着选（只绑 127.0.0.1，不对外）。页面上两种勾选框
      语义不同，别弄混：
        待导入那一栏的勾 = 「这条要不要进库」；
        库里已经有的那一栏的勾 = 「这条要不要在岛上显示」—— 取消勾只是打标记，数据还在库里。
      时间不对的条目直接在行内的输入框改掉再提交，改完的时间就是入库的时间。
  node .\cal-import.mjs --list / --stats
      看库里有哪些来源、各多少条。
  node .\cal-import.mjs --drop 来源名
      删掉某个来源（撤销一次导入就用这个）。
  node .\cal-import.mjs --exclude 3,7
      按 id 关掉显示（等价于页面上取消勾选）。

  凡是动过库的出口（--commit / --drop / --exclude、页面上的导入和勾选隐藏）都会在
  那一刻把 agenda.json 和 week.json 两份一起重建，然后各打印一行「日程已重建 / 整周已重建」。
  抓取层自己那轮刷新最长隔 30 分钟，不当场重建的话就会出现「今日安排是新的、本周课表还是旧的」，
  同一次导入两个版本最难查。走代码调用时用 meta.mjs 的 rebuildSchedule()，别只调 fetchAgenda。

认格式：ics / csv / json / adb 的 `content query` 输出，按字节嗅探（扩展名只是提示），
编码 UTF-8 / GBK / UTF-16 自动判，字段名按同义词表映射（标题/SUMMARY/title/事件主题…）。
重复事件在读取时展开（DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL/BYDAY/BYSETPOS/BYMONTHDAY/
COUNT/UNTIL + EXDATE/RDATE），按「墙上时间」走，所以每周日的课在夏令时地区也还是周日。
去重键是 (来源, UID, 开始时间)；不同来源出现同一条只报冲突、两份都留，不替你删。
手机上设的提醒在 Android 是另一张表，cal-pull 会按 event_id 并回对应事件，否则「闹钟全丢了」。

手机（iQOO / OriginOS）怎么把日程弄过来：
  node .\cal-pull.mjs
      自己找 adb、看设备状态、试着查 content://com.android.calendar/{events,reminders,calendars}，
      顺手把 /sdcard/Download 里的 .ics/.csv/.json 也拉下来。每一步为什么不通它会写清楚
      （没开 USB 调试 / 弹窗没点允许 / shell 没有 READ_CALENDAR 权限），最后给一份预览。
  node .\cal-pull.mjs --import
      上面那步看着对再跑这个，来源记成「手机」。
三条路的现实情况：
  - 手动导出（手机日历 App → 设置 → 导出到下载目录）→ 这条一定通，`--via-files` 走的就是它。
  - adb content query → adb 在本机有（platform-tools 1.0.41），但权限能不能给到 shell uid
    没在这台 OriginOS 上实测过，属于未验证；开了 USB 调试跑一次才知道。
  - 直接读日历数据库 / adb backup / run-as → 非 debuggable 的系统应用，这条路是死的，不用试。

日程本身也能被别的软件读：预览页在跑的时候
  GET http://127.0.0.1:8733/api/schedule   = agenda.json 那一行 JSON（三天窗口 + 下一条）
  GET http://127.0.0.1:8733/api/week       = week.json 那一行 JSON（整周，含每天放假/补班）
两个口给的就是岛上看的那两份，只绑 127.0.0.1。预览页用 node cal-preview.mjs 单独起。

验证（判据是文件系统和真 HTTP，不是「脚本没报错」）：
  node .\cal-test.mjs --expect 59        解析层：编码/时区/重复/提醒/字段映射/坏数据
  node .\cal-flow-test.mjs --expect 51   全流程：预览不写库 → 去重 → 冲突 → 展开 →
                                                     并进 agenda.json（字段形状不变）→ 真发 HTTP
                                                     勾几条就写几条 → 取消勾真的不显示、再勾回来。
两个测试都在临时目录里跑（WIN_ISLAND_HOME 指到 temp），不碰你真实的库；用的日程是合成的。

教务系统「教学日历」那张课表表格 → 日程
--------------------------------------
课表不用手工一条条敲。那张表格里能读出来的（课名、周次范围、教师、地点、星期、节次）已经
抄进 node .\cal-timetable.mjs 里的 COURSES 表，它生成 timetable.ics，
再走上面那条 cal-import 链路入库（来源名「课程表」）。

  node .\cal-timetable.mjs
  node .\cal-import.mjs timetable.ics --as 课程表 --commit

但表格本身不含两样必需信息，所以它们写死在那个文件顶上当常量，换学期/换学校就改这两处：
  WEEK1_MONDAY  第 1 周周一是哪天（校历上的开学日）。周次范围「2-9周」只有配上它才变成日期。
                现在填的是 2026-08-31 —— 2026-09-26 用手机「课程表」那页对照过：第4周 = 9/21-9/27，
                每门课的 本周/非本周 和周四那位轮课老师都对得上，所以这个值算核过了。
                岛上「本周安排 · 第N周」那个周次号读的是 config.json 里的 calendar.week1Monday，
                和这里是两个地方：改这里只影响导进来的课，改那里才影响面板上那个「第几周」。
  SLOTS         节次 → 时刻，按「一门课占的那几节连排」给整段：
                1-2 = 08:00-09:40，5-8 = 14:30-18:00（下午这条是他 2026-09-26 亲口纠正的，
                下午整段四节连排、2 点半上到 6 点），9-10 = 19:00-20:40，11-12 = 21:00-22:40。
                除下午那档以外其余三档都还没核实，错了就改这里重跑。
                手机上那张课程表每节都带时刻，对照一眼就能核完 —— 待核的是 1-2 / 3-4 / 9-10 / 11-12。
这两个值错了岛上就是错的，第一次导入务必 --serve 开页面扫一眼。重跑是同一来源替换，不会堆两份。

教师按周变的课（轮课）拆成一周一条，岛上那一行显示的就是那一周真正的老师（周四 9/24 那格
现在写「示例老师：示例课程1班」，和你导入的课表一致）。轮次表另外写进备注，
在 8733 页面的详情里能看到。以前是合成一条 + 备注，结果面板上只显示课名、显示不出谁上。

  node .\cal-import.mjs --drop 课程表     回退整份课表

导错了想全部回退：node .\cal-import.mjs --drop <来源>；
彻底清空：del "%LOCALAPPDATA%\win-island\cal.db"（订阅的 URL 源不受影响）。
发布包里不含任何人的真课表。想体验导课表：先跑 node cal-timetable.mjs（里面的 COURSES 是示例常量，换成你自己的），再 --commit。
之前演示用的来源「示例」和 config.json 里那两条演示订阅源已经清掉了，
还原订阅源就是把 calendar.sources 填回
["D:/win-island/schedule.example.ics","https://www.calendarlabs.com/ical-calendar/ics/46/USA_Holidays.ics"]。

面板上的「今日安排 / 本周课表」和假期提示
------------------------------------------
日程段默认只列今天。右上角那颗「本周课表」点下去摊开整周（周一到周日，一天一组，
含已经上完的那几天，过去的组整体压暗），再点变成「只看今天」；收起面板会回到今天态。
今天没课也留着这一段，写一句为什么（「今天中秋节，放假，没课。」/「今天没课，本周最近的是…」），
不再把后天的课摊进来冒充今天的安排。

数据分两份文件，形状不同用途不同：
  week.json      整周。抓取层 meta.mjs 每轮和 agenda.json 一起写；同一天内 30 分钟过期。
                 {at, monday, weekNo, todayIdx, n, days:[{i,iso,date,wd,today,past,rest,work,events[]}]}
  holidays.json  法定假日 + 调休补班，按年缓存（{days:{'2026-09-25':{kind:'rest',name:'中秋节'}}}）。
                 缺哪个年补哪个年，拉不到的年记一笔失败时间、半小时内不再敲那个接口。
agenda.json 的形状一个字没改（三天窗口那份还是它），整周是另开的一份 —— 那个契约已经被
渲染层和 /api/schedule 钉住了，塞七天进去等于改契约。

为什么还要额外拉一个外部接口：cal.db 里只有「哪天几点有课」，「那天放不放假、是不是调休补班」
库里根本没有，问不出来。用的是 https://timor.tech/api/holiday/year/<年>，它把放假和补班放在
同一张表里（holiday:true 是放、false 是补班），一次请求两样都齐。所以：
  放假 → 天头上一个红标「放假 · 中秋节」；补班 → 蓝标「调休补班」（语义相反，颜色也相反）。
  今天那一天的假期还会写进「今天没课」那句解释里。
这个接口只在抓取层用，拉不到不影响别的：岛上顶多少了假期标签，课还是那些课。

节次时刻表（几点到几点）不在这里，在 cal-timetable.mjs 顶上那个 SLOTS 常量里 ——
假期接口给不了学校作息，两件事别混。

  node .\meta.mjs --week      把整周那份打出来（含周次号和假期标签），核对用
  curl http://127.0.0.1:8733/api/week     别的应用要读整周时走这个口

参数（岛屿）
------------
  -HoldMs 6000    一条通知停留多久
  -TopPx 14       距离屏幕顶部多少像素
  -Wide 470       胶囊宽度
  环境变量 WIN_ISLAND_POLL=700  抓取轮询间隔毫秒（越小越跟手，越费一点 CPU）

日志和数据在哪
--------------
  %LOCALAPPDATA%\win-island\queue.jsonl    通知队列（岛屿读这个）
  %LOCALAPPDATA%\win-island\capture.log    抓到什么、入库延迟多少毫秒、API 有没有起来
  %LOCALAPPDATA%\win-island\island.out.log 渲染行 + 点开跳转的行（[island] 渲染 / [open] ...）
  %LOCALAPPDATA%\win-island\island.err.log 界面报错都在这，空的就是没问题
  %LOCALAPPDATA%\win-island\read.json      岛屿自己的账本（opened / dismissed / gone），
                                           「未读」就是按它算的。PowerShell 写的，带 BOM。
  %LOCALAPPDATA%\win-island\live.json      抓取层每 3 秒写「通知中心里还剩哪些 id」。
                                           判断「这条是被我处理了还是系统里没了」只认它。
  %LOCALAPPDATA%\win-island\last-copy.txt  只在剪贴板写不进去时才出现（兜底，不是正常路径）
  %LOCALAPPDATA%\win-island\weather.json / agenda.json / geo.json / config.json
                                           天气、日程、定位缓存和参数
  %LOCALAPPDATA%\win-island\week.json      整周课表那份（面板「本周课表」和 /api/week 都读它）
  %LOCALAPPDATA%\win-island\holidays.json  法定假日 + 调休补班，按年缓存，只从 timor.tech 拉
  %LOCALAPPDATA%\win-island\cal.db         本机导入的日程库（SQLite，WAL）；岛上日程段的
                                           「本机导入」来源就是它
  %LOCALAPPDATA%\win-island\cal-inbox\     从手机拉下来的原始 dump / 文件，导入的输入目录
  注意 island.out.log 是 GBK 编码（Start-Process 重定向走的是控制台代码页），
  用 Get-Content 或记事本打开是对的，用 cat / iconv -f UTF-8 会看到乱码。
  判断岛屿是不是「活着但不显示」：capture.log 有货、island.out.log 里却没有 [island] 渲染 行，
  就是窗口没显示出来，用 launch.ps1 重启。

为什么数据不放这个目录：通知正文里有 QQ 群名、邮件主题这类东西，而另一个会推到公开仓库的项目目录队列文件超过 512KB 会自动只保留最近 120 条，
彻底清空：删掉 queue.jsonl 即可（岛屿会自动从头再读）。

还做不到 / 已知没解决（别当成 bug 来问我）
------------------------------------------
1. 右下角原生 toast 还在弹，现在是「两处都显示」—— 这是你要的样子（你说原生留着不要紧），
   不是没做完。真要只留岛屿就得关掉系统横幅，而「关掉横幅后通知还进不进库」这一层耦合
   没实测过，谁想做谁先测那一层，别先改界面。
2. 应用自己画的气泡/悬浮窗（不走通知中心的那种）抓不到，库里根本没有行。
   那类只能靠监听窗口出现来做，是另一套机制，脆且要长期维护。
3. 在 设置 > 通知 里被关掉、或者「在通知中心显示」被取消的应用，不入库，岛上也不会有。
4. 专注助手/免打扰期间的通知不进胶囊。
5. 没做开机自启（要的话挂个计划任务，和 sub-updater 那套一个做法；笔记本上记得关
   DisallowStartIfOnBatteries，否则用电池就不启动）。
6. 胶囊里没有应用图标，只有文字角标。
7. 点开跳转对「载荷里带协议串」或「AUMID 能在开始菜单里查到」的应用才有效。实测到的两类跳不动：
   AUMID 是空（有些应用的 handler 记录里就没有 PrimaryId），以及应用压根没注册可激活入口。
   这两种点了就是收了，日志会写明原因。
8. 有些应用带的 launch 不是 URL（比如 Qoder 的 launch 是 notificationId=<一串哈希>），
   这种没有协议头，不会硬拼成命令执行，会退到第 2 条 AUMID 路径。
9. 通知库里根本没有「已读 / 已点 / 已清除」这一列（probe-schema.mjs 把所有表看过了），
   所以「系统侧消失」和「你处理过了」分不开：一条在通知中心里被划掉或者到期了，岛屿只记成
   「系统侧消失」，不谎报成你处理过 —— 那样这个数就没意义了。
   副作用：想「先把系统里的清干净，再在岛上复制全部未读」是反的，清掉就等于消失。
   消失的判定留了覆盖与龄期两道闸（live.json 快照晚于这条入库时间的不算消失、入库不到 15 秒
   不算消失），并且发现误判会撤回（日志里 [island] 撤回误判 id=…）。
10. 面板里的「复制」胶囊是鼠标移到那一行才出现的（列表窄，常驻会挤掉时间）。要点到它得先
    hover，脚本驱动时要留出 hover 生效的时间，否则 UIA 里根本没有这个元素。
11. 手机日历还没做到「自动同步」：MTP 只暴露媒体和下载目录，永远看不到应用私有数据库，
    所以要么手机上手动导出到下载目录（下面那条命令能接住），要么开 USB 调试赌 OriginOS 把
    READ_CALENDAR 给 shell。没有「不碰手机设置就自动同步」这种方案，别按那个预期提需求。
12. 导入的日程不会自己写回手机：cal.db 是本机一份只进不出的副本，改了手机上的原日程，
    岛上的副本不会跟着变，要重新导一次（同来源 --commit 是替换，不会堆两份）。
13. 假期标签只到「这天放假 / 这天补班」这一层。「调休补班那天到底按周几的课表上」这个接口
    给不出来（timor 只给 target=补哪个节，不给换成周几），所以补班那天岛上照常显示它自己的课，
    不会替你改成「按周三课表」。真要那层，得学校教务出「调休课表」，或者手工在 cal.db 里补。
    另外学校自己放的假（运动会、小学期）不在法定节假日表里，岛上不会知道。
14. 节次 → 时刻（SLOTS）里 1-2 / 3-4 / 9-10 / 11-12 四档还是从教学日历那张图推的，5-8 = 14:30-18:00 按本校作息填的。晚上那两档尤其可疑：手机上那张课程表像是把 11 节标在
    20:15，而我这里写的是 21:00 —— 没核。那门 12-15 周才上的课，所以今天看不出来，
    但别当成对的。核完改 cal-timetable.mjs 顶上重跑一次 --commit 就换掉。

撤销这一切
----------
  powershell -File .\stop.ps1
  rd /s /q D:\win-island
  del /q "%LOCALAPPDATA%\win-island"
