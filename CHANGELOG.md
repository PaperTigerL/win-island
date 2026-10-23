# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

2026-10-23 P2 清理：

### 修复

- **混合 DPI（P1-11）**：工作区/光标换算按目标显示器取 DPI（`GetDpiForMonitor` / WPF `VisualTreeHelper.GetDpi`，
  失败回落主屏比例），每块屏的 Scale 纳入几何指纹；双屏不同缩放的实机验证仍待做（本机无双屏）。
- **面板空白单击（P2-4）**：未读列表左键只认鼠标下真正命中的 `ListBoxItem`，空白/滚动条不再拿上一次
  `SelectedItem` 去跳来源应用。
- **运行期 capture.log 轮转（P2-5）**：抓取层每次写日志前 `>5MB` 就把当前文件改名 `.1`，只留一份历史；
  `island.out.log` 仍由启动时 `rotate.ps1` 轮转（运行中被 cmd 写句柄占用，不能安全改名）。
- **Save-State 节流（P2-12）**：连续标记合并为 500ms 一次落盘，tick 里 `Flush-State` 到期写，退出时
  `Save-StateNow` 无条件写一次，避免每条标记都磁盘写。

### 测试

- geometry 33 条（新增分屏 DPI 换算/指纹 11 条）、log-rotate 10 条、panel-click 7 条、
  state-throttle 13 条；`node scripts/test-all.mjs --unit` 15 项全部 PASS。

2026-10-21 审计修复（分支 `audit/2026-10-21`）：

### 修复

- **抓取层回放（P0）**：重启时按 `capture.replayMinutes` / `replayMax`（默认 10 分钟 / 20 条）补回
  停机期间到达、队列里没有的通知，按 id 幂等，条目带 `backfilled=true`（面板/胶囊显示「补录·时间」，
  管道 `list` 也带这个字段）。此前启动水位线取库里最大 `ArrivalTime`，停机期间的通知被当历史
  永久跳过（审计实测两条有正文的通知消失）；窗口/上限/去重抽在 `src/capture/replay.mjs`，有单测。
- **过期 island.request（P2-7）**：`island.request` 的 `at` 去重是内存态，重启后为空，配置里残留的
  旧指令（审计里是 2026-10-11 的 `collapse`）会被当成新指令再执行一遍。现在 `prefs.ps1` 的
  `Test-PrefsRequest` 校验时间戳（可解析、与现在相差 ≤60 秒）和来源 `src`（短标识，管道写 `pipe`），
  过期/坏值/非法来源只记一行 `[prefs] 忽略 request：…` 不执行。prefs-test 加 11 条（58 条）。
- **拖拽与对齐（用户 2026-10-21 需求）**：松手时在 `snapPx`（默认 10 DIP）内自动吸附屏幕
  边缘或水平中心（按住 Shift 松手不吸附，只影响这一次），`dragPx` 默认 4→8（8 DIP 的轻微抖动
  不再抢走点击）；落盘统一 DIP，并把当次所在屏的 `monitorId` / `monitorDpi` 一起写回（诊断混合 DPI）。
  修「岛自己乱跑」：秒级循环只在显示器/DPI 指纹（`Get-GeoKey`）变化时才重算锚位，拖拽途中
  `Place-Island` 直接让位给拖拽；普通 tick 不再动窗口位置。geometry 测试加吸附/指纹 11 条（共 22）。
- **游戏 / 无边框全屏模式（`gameMode`，用户 2026-10-21 需求）**：前台窗口盖满整块显示器且
  「无标题栏」或「进程在已知游戏名单」时进入游戏态 —— tick 放宽到 1500ms、暂停 `autoTopmost` 重申、
  暂停音频电平可视化（有 `audio.ps1` 时）、常驻态按 `gameMode` 换成 6px 把手（`auto`/`handle`）或
  整条隐藏（`hide`）/照常悬浮（`float`）。2 次去抖，退出后恢复配置里的 `pollMs` 与常规常驻态。
  判定纯算术在 `geometry.ps1` 的 `Test-GameLike`，新增 11 条断言的 `test/geometry-test.mjs`；
  秒级节流从 `tick % 15` 改成时间戳（游戏态 1.5s tick 下 1 秒任务不会退化成 22.5 秒）。
- **Sync-Live 空列表（P2-3）**：`live.json` 里 `ids: []`（通知中心被清空）是合法快照，旧实现
  `if (-not $o.ids) { return }` 对空数组也成立，于是所有条目永远不标 gone。现在只有「字段缺失」
  才跳过；判定/撤回抽到 `queue.ps1` 的 `Get-LiveDiff`，队列测试从 14 条加到 22 条（空列表、15 秒
  宽限、快照过旧、已处理、误判撤回、坏行）。
- **topGap 热加载（P2-1）**：XAML 里的 `pill`/`panel` Margin 是启动时插值的，旧实现改 `topGap` 只
  重新定位、不更新 Margin，必须重启才看到间距。现在 `Apply-Prefs` 的 diff 里有 `topGap` 就重设两处
  Margin（窗口高度变了由 SizeChanged 再摆位置）。prefs-test 补两条源码级断言。
- **stop/launch 按安装路径限定（P1-9）**：`stop.ps1` 只停本仓库完整脚本路径的
  `island.ps1` / `capture.mjs`（旧实现匹配所有同名脚本，会把 `D:\win-island` 那份正在用的实例一起杀掉）；
  pid 文件先核对命令行归属，属于另一份副本的只跳过、不删。`launch.ps1` 打印安装根目录，并在管道被
  另一份占用时直接说明原因。实测：临时环境里停本仓库抓取层，运行副本的 4 个进程一个不少；
  把 pid 文件换成运行副本的 pid 后 stop 跳过且不删文件。
- **抓取层单实例重试**：抢管道失败先等约 3 秒（每 250ms 试一次，期间不刷错误日志），
  避免 `restart`（强杀旧进程后立刻启动新进程）偶发因为旧进程还没放掉管道而失败；真的还有一份在跑才以 7 退出。
- **抓取层单实例（P1-10）**：两份抓取层同时跑会 append 同一个 `queue.jsonl`（每条通知重复入库）、
  `capture.pid` 被后启动者覆盖。现在命名管道的独占 listen 就是锁：第二份以**退出码 7** 退出，
  不写 pid、不动队列；pid 文件是第一道（Windows pid 会复用，所以还要用 tasklist 确认是 node 进程）。
  管道名可用 `WIN_ISLAND_PIPE` 换，测试/实验副本互不抢占。新增 9 条断言的 `test/single-instance-test.mjs`。
- **抓取层**：`--once` / `--replay` 不再写 `capture.pid`。之前跑一次诊断命令会把常驻抓取层的 pid
  覆盖成自己的再退出，之后 `status` 报「抓取层没在跑」、`stop.ps1` 也停不掉真进程。
- **队列增量读取**：只消费到最后一个换行符，半行留到下一轮（旧实现把半行也推进 offset，下一轮从半行
  中间读，那条通知永久丢失）；按 id 去重（队列超过 512KB 整体重写后 offset 归零，旧实现会重复
  append，面板重复行、未读数虚高）；抓取层 append 前补末尾换行，避免半行把下一条拼成坏行。
  逻辑抽到 `src/island/queue.ps1`，新增 14 条断言的 `test/queue-test.mjs`。
- **小条命中区**：按可见小条宽度（clock/handle 的 `ActualWidth` × scale）和水平居中计算，
  不再把整窗 `wide*scale` 当命中区；`Get-BarH` 补上 LayoutTransform 的 scale。此前 540px 的透明窗口里
  只有约 274px 画着东西，左右空白也会展开面板并摘掉点击穿透，替下面窗口吞掉标题栏点击。
- **多显示器**：主屏左侧/上方的副屏坐标本来就是负数。`free` 位置不再用 `x>=0/y>=0` 判断（只把 -1
  当未设置哨兵），hover / 面板收起也不再一见负坐标就判假；拖到副屏后松手不会跳回主屏。
- **构建**：`build.mjs` 的 status 冒烟改用 `spawnSync`，接受 0（两层在跑）和 3（没在跑）——
  之前 `execFileSync` 在岛停着时抛异常，等于「岛没开着就构建不了」。
- **发布闸**：`precheck-publish.mjs` 的「长 base64/hex」阈值从 44 改到 40。32 字节随机 key 的 base64
  是 43 个字符位 + 一个 `=`，SHA-1 是 40 位十六进制，旧阈值两种真密钥都漏（审计用 32B base64 和
  SHA-1 复现，扫描器报「0 处，过关」）；同时给斜杠分隔的接口名/动作枚举补 ALLOW，避免假红。

### 新增（合并运行副本开发工作，分支 `merge/2026-10-21`）

- **实时频谱**：合并 `src/island/audio.ps1`（WASAPI loopback 抓所有活动输出端点 → 加窗 FFT →
  40Hz~16kHz 对数分频，只在内存留频段能量，不存采样、不落原始音频）。小条上按 `audioBands` 造柱子，
  `audio.json` 是进程间契约（`on/bands/bars/bandsN/level/peakHz/windows/idleMs/status/sources/barRect/at`），
  管道新增 `{"cmd":"audio"}`。8 个配置项（`audioOn` 默认 false、`audioBands` 12、`audioAllDevices`、
  `audioGain`、`audioStallMs`、`audioFloorDb`、`audioShowBar`、`audioHideMs`）进 `$PrefsSpec` 与
  `docs/CONFIG.md`，prefs 测试 33 → 41 项。测试：`test/audio-test.mjs`（103 条，要真实音频端点，
  只在非 `--unit` 跑）+ `test/audio-harness.ps1` / `test/render-endpoint.ps1` / `tools/pixel-audio.ps1`。
- **游戏态暂停频谱**：补 `Set-AudioLevelPaused` 适配层接审计留下的 `Set-AudioVizPaused` 钩子 ——
  进游戏态停抓取流、柱子归零、`audio.json` 写 `status="paused (gameMode)"`，退出游戏态
  `Update-Audio` 重开；`audioOn` 配置不动，tick 在暂停期间也不画柱子。合并的是两边逻辑：
  审计的 tick 时间戳节流/gameMode 去抖都在，运行副本的频谱开关与绘制也在。
- **登录自启 `scripts/autostart.ps1`**：注册计划任务 `win-island`（`AtLogOn` + Interactive 身份 +
  `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`），有 `-Status`（`LastTaskResult` 自证）与
  `-Uninstall`；普通权限注册失败明确报 `0x80070005`。
- **开始菜单 `scripts/startmenu.ps1`**：当前用户 `Programs` 放 `win-island 原子岛.lnk`
  （目标 `bin\win-island.exe`、图标 `$Exe,0`），`-Status` 用 `Get-StartApps` 证明进了应用列表，
  `-Uninstall` 只删快捷方式不动进程。
- **启动器**：`csc /target:winexe`（登录时被计划任务拉起不闪黑框，从终端跑仍能输出），`start` 改成
  ShellExecute detached 起 `launch.ps1` 并轮询两层 pid —— 不再把计划任务挂在 Running 被 `IgnoreNew`
  挡掉（`0x800710E0`）；构建冒烟保留「接受 0/3 退出码 + stdout 必须连得上父进程管道」的自证。
- **图标**：`make-icon.mjs` 六档（16/20/24/32/48/256，150% DPI 的 `SmallIconSize` 是 24，不能省），
  蓝色机身 + 白胶囊 + 右上未读点；托盘图标读 `assets/icon.ico` 里和 `SmallIconSize` 同档那帧
  （拿不到才回落 `SystemIcons.Application`）—— 审计 P2-9「托盘是系统占位图」修复。
- **私有文件仍不进仓**：`scripts/pack-release.mjs` / `scripts/precheck-private.json`（以及
  `tools/repost-real.mjs`、`tools/mtp-*.ps1`、`tools/probe-identity.mjs`、`tools/probe-payload.mjs`、
  `tools/dbq.mjs`）继续 `.gitignore` 排除；部署包由运维侧把它们拷进去，`build.mjs --release`
  在公开克隆里照旧明确报错（退出码 2）。

### 已知未修（2026-10-21 第二轮）

- ~~**混合 DPI 多显示器（P1-11）**：`Get-DipScale` 仍只按主屏算比例。~~ 已修（2026-10-23）：改为按目标
  显示器取 DPI，并把每屏 Scale 纳入几何指纹；`monitorId` / `monitorDpi` 继续落盘做诊断。双屏不同缩放的
  实机验证仍待做（本机无双屏），见 `docs/CONFIG.md`「单位」一节。
- ~~音频电平可视化（运行副本有、仓库没有）~~：已在 `merge/2026-10-21` 合并，`Set-AudioLevelPaused`
  适配层接上了 `gameMode` 的暂停钩子。
- **`pollMs` 改后周期漂移（P2-2 只修了一半）**：最影响体验的「秒级」块（时钟/配置热加载/游戏检测/
  显示器变化）已改成时间戳调度；但「读队列 %4 / 对账 %30 / 天气日程 %143」仍是 tick 计数，
  改 `pollMs` 后这些周期会跟着变（游戏态 1.5s tick 下对账会到 45 秒一次）。
- ~~运行副本里未进仓库的功能~~：已在 `merge/2026-10-21` 合并（频谱 + 自启 + 开始菜单 + winexe +
  detached start + 六档图标/托盘）。只有 `pack-release.mjs` / `precheck-private.json` 这类私有文件
  按设计继续留在仓库外（部署包带）。差异清单见审计目录 `RUNTIME-COPY-DIFF-2026-10-21.md`。
- **公开克隆仍出不了发布包（P1-8）**：`pack-release.mjs` / `precheck-private.json` 是私有文件，
  `build.mjs --release` 现在明确报错并以 2 退出，不再 ENOENT。
- **审计 P2 其余未修项**：~~面板空白处单击可能命中上一次选中的行并跳转（P2-4）~~ 已修；`capture.log`
  已运行期轮转，`island.out.log` 仍只在启动时轮转（P2-5 部分）；管道 `list` 只读队列尾部 256KB（P2-6）；
  `activationType` 解析了但点开没用到（P2-8）；~~托盘图标是系统占位图~~（P2-9 已修，改用
  `assets/icon.ico` 同档帧）；应用名映射没覆盖
  `BackgroundAccess` / `com.qodercn.app`（P2-10）；`--replay` 的旧条目会被 live 对账标 gone（P2-11）；
  ~~`Save-State` 每条标记都写盘（P2-12）~~ 已修（500ms 合并）。

## [1.0.0] - 2026-09-26

第一个公开版本。

### 新增

- **抓取层** `src/capture/capture.mjs`：只读轮询 Windows 通知库（`wpndatabase.db`），
  按 id 去重后追加成 `queue.jsonl`；载荷 UTF-16LE / XML 实体解码；复制用的 `copy` 字段在
  这一层就算好并统一成 CRLF。每 3 秒写 `live.json`（通知中心现存 id）。
  Node 22 缺 `node:sqlite` 开关时带 `--experimental-sqlite` 重启自己一次。
- **渲染层** `src/island/island.ps1`：单个置顶窗口在六种模式间切换
  （`handle` / `clock` / `pill` / `panel` / `fading` / `hidden`），常驻小条 = 时钟 + 天气 + 未读角标，
  面板 = 未读列表 + 今日日程 + 整周课表。
- **点开跳回来源应用**：三级回落（通知自带协议深链 → 按 AUMID 唤到前台 → 只写日志），
  并拒绝执行 `file:` / `javascript:` / `vbscript:` / `about:` / `search-ms:` / `ms-msdt:` / UNC 的 launch 串。
- **复制**：面板行内胶囊、行右键、`Ctrl+C`、菜单四个入口共用一个 `copy` 字段；
  剪贴板独占锁失败重试 3 次并兜底写 `last-copy.txt`。
- **悬浮行为全量可配置**（29 项，`docs/CONFIG.md`）：锚位 / 偏移 / 缩放 / 触发方式（悬停、单击、
  长按、只认外部调用）/ 各类延迟与宽限期 / 动画时长 / 全屏与显隐条件 / 抓取节奏。
  非法值按范围夹回或回落默认并写一行 `[prefs]`，配置错误不会让岛屿崩。
- **拖拽与缩放持久化**：按住小条拖动（`anchor` 自动变 `free`）、滚轮改 `scale`，
  都立即写 `config.json`；DIP 与物理像素的换算集中在 `src/island/geometry.ps1`，
  位置落到屏外时回落顶部居中并写明原因。
- **始终置顶**：`autoTopmost` 周期重申；菜单 / 托盘开着时暂停重申，否则会把岛屿自己的右键菜单
  压到窗口下面（表现为「菜单弹出来却点不动」）。
- **日程**：`.ics` / `.csv` / `.json` / adb `content query` 输出统一导入（按字节嗅探格式、
  UTF-8/GBK/UTF-16 自动判、字段名同义词映射、重复事件按墙上时间展开、去重键 `(来源,UID,开始)`、
  跨来源冲突只报告不代删）；`--serve` 预览页勾着选；动过库的出口一起重建 `agenda.json` 与 `week.json`。
- **整周课表 + 假期**：`week.json` 与按年缓存的 `holidays.json`（放假 / 调休补班标记），
  `GET /api/schedule`、`GET /api/week` 只绑 127.0.0.1。
- **对外接口**：命名管道 `\\.\pipe\win-island`（`ping` `list` `text` `copy` `config` `config.set` `request`）
  + `config.json` 里的 `island.request` 一次性动作通道。
- **启动器** `bin\win-island.exe`：系统自带 `csc.exe` 编译，带版本资源和图标，
  命令 `start` / `stop` / `status` / `test` / `config` / `data` / `version` / `help`。
- **自证判据五套**：解析层 59 条、导入全流程 + 真 HTTP 51 条、配置项 44 条、
  管道端到端、真点击复制比对剪贴板字节。
- **发布链路**：`pack-release.mjs`（白名单打包 + 脱敏替换 + 自检禁入文件）、
  `precheck-publish.mjs`（递归扫个人信息与密钥形状，一条没有才过关）。
- **文档**：`README.md` + `docs/USAGE.md` + `docs/CONFIG.md` + `docs/ARCHITECTURE.md` + `CONTRIBUTING.md`。

### 变更

- 目录从「30 多个文件摊在根上」重排成 `src/{capture,island,schedule,launcher}` + `scripts` + `test` + `tools` + `docs`，
  所有交叉引用改成 `$PSScriptRoot` / `import.meta.url` 相对定位，克隆到任何路径都能跑。
- 详细手册从 `README-用法.txt` 迁到 `docs/USAGE.md`，命令示例不再绑死在某台机器的绝对路径上。

## 早期快照

`886b6f2` 是重构前推上去的那一版（根目录平铺、行为写死、无 Release、无启动器），只作为历史保留；
1.0.0 的发布包由 `scripts/pack-release.mjs` 重新生成，不基于那一次提交。
