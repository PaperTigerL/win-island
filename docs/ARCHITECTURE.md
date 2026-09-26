# 架构

三层，各自能被替换：

```
 Windows 通知中心                %LOCALAPPDATA%\win-island            屏幕顶部
 ┌────────────────┐   轮询    ┌──────────────┐  读文件   ┌───────────────┐
 │ wpndatabase.db │ ────────> │ 抓取层        │ ────────> │ 渲染层         │
 │ (SQLite + WAL) │  700ms    │ capture.mjs  │  queue    │ island.ps1    │
 └────────────────┘           │  Node 22+    │  .jsonl   │  PowerShell   │
                              │              │           │  5.1 + WPF    │
                              │ 命名管道 API │           │  置顶无边框窗口 │
                              └──────┬───────┘           └───────┬───────┘
                                     │ 一行 JSON 进/出            │ 拖拽/滚轮/右键
   别的软件 ──> \\.\pipe\win-island ──┘   <── config.json 热加载 ──┘
                                     win-island.exe（启动器/控制台）
```

| 层 | 文件 | 职责 | 明确不负责 |
| --- | --- | --- | --- |
| 抓取层 | `src/capture/capture.mjs` | 读通知库、追加队列、天气/日程、命名管道 API | 画任何东西 |
| 渲染层 | `src/island/island.ps1` | 窗口、显示模式、交互、把队列渲染成小条/胶囊/面板 | 读通知库（只读队列文件） |
| 启动器 | `src/launcher/WinIsland.cs` → `bin/win-island.exe` | 找代码、起停、状态、开配置 | 重新实现应用逻辑 |

## 为什么是这三样，而不是「一个纯编译的程序」

选型不是口味问题，是这台机器上实测出来的：

- **官方 WinRT `UserNotificationListener` 走不通**：它要求调用方有「包身份」，未打包进程实测
  `IDENTITY=NONE`、`GetDefaultAsync` 报 `0x80131501`。要走就得打 MSIX，而 `dotnet` CLI 在这台机器上是坏
  shim（未打包进程拿不到包身份），也没装 rust。
  → 改成只读轮询 `wpndatabase.db`，普通用户权限，实测可用。
- **渲染层留在 PowerShell + WPF**：WPF 是 Windows 自带的，这样才能做到零安装。
  编译成 exe 就得引一个 SDK 或运行时，那正是这个项目想避免的。
- **Node 而不是别的**：读 SQLite+WAL 用 `node:sqlite`，够用且零依赖。
  试过 bun 1.2.9 —— **没有 `node:sqlite`**，所以也不能拿它编成单文件可执行程序。
- **`csc.exe` 只到 C# 5**（`.NET Framework 4.8`，系统自带），所以启动器里没有字符串内插、没有 `?.`、
  没有表达式体成员。这是编译器的上限，不是风格选择。

## 抓取层

- 只读打开 `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`（`node:sqlite` 的 `readOnly`），
  不写、不锁 —— 那是系统的库。
- 每 `WIN_ISLAND_POLL`（默认 700ms）一轮，按 `id` 去重后**追加**成 `queue.jsonl`（一行一条 JSON）。
  超过 `WIN_ISLAND_KEEP`（默认 120 条）或 512KB 就整体重写只留最近的。
- 载荷解码有两处坑：字段可能是 UTF-16LE（ASCII 后跟 `0x00`），XML 实体要解（`&lt;`、`&#10;`）。
  复制用的 `copy` 字段在这里就算好（标题 + 各行正文，**统一 CRLF**）——
  原始 `<text>` 里嵌的是裸 LF，混着进剪贴板粘到记事本就糊成一行，这是之前「复制了个寂寞」的真实原因。
- 每 3 秒写 `live.json`：通知中心里现在还剩哪些 `id`。
  这是判断「这条是被我处理了还是系统里没了」的唯一凭据。
- **Node 22 的 `node:sqlite` 还要实验开关**：起自己时检测，缺就带 `--experimental-sqlite` 重启一次
  （`WIN_ISLAND_RELAUNCHED=1` 防循环）。Node 24 不需要，所以启动脚本里不用猜版本。

### 边界：库里根本没有「已读」

`tools/probe-schema.mjs` 把所有表看过了：没有任何已读/已点/已清除列。所以「未读」只能岛屿自己记账
（`read.json`）。一条从系统侧消失 = 你划掉了它或者它到期了，这两者分不开 —— 岛屿只标「系统侧消失」，
不谎报成「已处理」，那样这个数就没意义了。消失判定还有两道闸防误判：`live.json` 快照晚于这条入库时间
的不算消失、入库不到 15 秒不算消失；发现误判会撤回（日志 `[island] 撤回误判 id=…`）。

## 渲染层

一个窗口、一个 HWND，六种显示模式之间换的是可见性和 exstyle，不新建窗口：

```
handle ──来通知──> pill ──触发命中──> panel
  ↑                  │                  │
  └──────淡出────────┘<─────收起─────────┘
clock = 常驻态带时钟（showClock=true）
fading = 淡出中的一帧
hidden = fullscreen=hide 时整条不出现
```

- **DIP 与物理像素**：WPF 的 `Left/Top/Width/Height` 是 DIP，`Forms.Screen` 和 Win32 光标坐标是物理像素。
  所有换算集中在 `src/island/geometry.ps1`（纯函数，能单独断言），对外一律 DIP。
- **`SizeToContent=Height`**：面板一展开窗口高度从 ~34 变成几百，所以底部锚位钉的是**下沿**而不是上沿，
  否则展开瞬间整块往下跳。向上生长靠 `Set-StackUp` 重排 `root.Children`
  —— .NET Framework 的 WPF **没有** `StackPanel.Direction` 这个公开属性（实测），别再找。
- **点击穿透**：`clickThrough=true` 时常驻态带 `WS_EX_TRANSPARENT`，不吞底下窗口的点击；
  光标压上小条的那一段时间自动摘掉，所以拖拽和滚轮仍然可用。判断按键状态用 Win32
  `GetAsyncKeyState(VK_LBUTTON)`（`IslandWin32::LeftDown()`）—— WPF 这边
  `MouseDevice` **没有**公开的 `GetMouseState()`。
- **置顶**：`autoTopmost` 每 30 个 tick 重申一次 `SetWindowPos(HWND_TOPMOST)`，治「被别的 TopMost 窗口压住」。
  代价很隐蔽：**菜单开着时必须让出置顶带**，否则重申置顶会把岛屿自己的右键菜单压到窗口下面
  （表现为「菜单弹出来了但点不动」）。这就是 `Test-MenuUp` / `Sync-Topmost` 存在的原因。
- **配置热加载**：每秒比一次 `config.json` 的 mtime，`Get-PrefsDiff` 算出真正变了的键，
  再按键分派（几何项重新定位、可视项重画常驻态、`pollMs` 改定时器间隔、`scale` 改 `ScaleTransform`）。
- **落盘**：菜单/托盘/拖拽/滚轮改配置都走 `Set-Pref` / `Set-PrefMany` 这一个口子
  （写盘 → 刷新 mtime → 重算 diff → 应用），所以「改了没落盘」只可能有一处原因。

## 交互与数据契约

岛屿只认这些文件（都在 `%LOCALAPPDATA%\win-island`，都不进仓库）：

| 文件 | 谁写 | 谁读 | 形状 |
| --- | --- | --- | --- |
| `queue.jsonl` | 抓取层 | 岛屿 | 一行一条通知 JSON，含 `copy` 字段 |
| `live.json` | 抓取层 | 岛屿 | `{at,ids:[]}`，通知中心现存 id |
| `read.json` | 岛屿 | 抓取层 API | `{opened,dismissed,gone}`，**带 BOM**（PS 写的） |
| `config.json` | 岛屿 / 管道 / 你 | 两层 | `{island,weather,calendar}`，**无 BOM** |
| `weather.json` `agenda.json` `week.json` `holidays.json` `geo.json` | 抓取层 | 岛屿 | 天气、今日、整周、假期、定位缓存 |
| `cal.db` | `cal-import.mjs` | 抓取层 | SQLite(WAL)，本机导入的日程 |
| `*.pid` `*.log` | 两层 | 启动器 / 你 | pid 文件；`island.*.log` 是 **GBK** 编码 |

编码这一列不是小事：PS 5.1 的 `Set-Content -Encoding UTF8` 会塞 BOM，Node 读到就炸；
反过来 Node 写的无 BOM JSON，PS 5.1 读 `.ps1` 时没 BOM 会按 GBK 解 —— 症状不是报错，
而是**中文注释最后一个字节变成反引号、把下一行吞掉**（参数静默变 null）。
所以：`.ps1` 必须 UTF-8 带 BOM（`node scripts/bom.mjs` 检查），`config.json` 必须无 BOM。

## 对外接口

两条，都不监听 TCP：

1. **命名管道 `\\.\pipe\win-island`**（抓取层）：`ping` / `list` / `text` / `copy` / `config` / `config.set` / `request`。
   一行 JSON 进、一行 JSON 出，失败一律 `{ok:false,reason:"可读的中文"}`。
   为什么不是 HTTP 端口：只在本机可达、不占 TCP 端口、不经防火墙。
2. **HTTP `http://127.0.0.1:8733`**（只在 `cal-import --serve` / `cal-preview` 跑的时候存在）：
   导入预览页 + `GET /api/schedule` + `GET /api/week`。**只绑 127.0.0.1**，绝不绑 `0.0.0.0`。

## 安全边界

- **通知里的 `launch` 串是别的进程写进数据库的一行字符串**，不该有权力让我们的进程替它拉起本地文件。
  点开跳转按三级走：载荷里的协议深链（复用系统那套）→ 按 AUMID 唤到前台 → 都没有只写日志。
  `file:` / `javascript:` / `vbscript:` / `about:` / `search-ms:` / `ms-msdt:` / UNC 开头一律拒绝。
- 导入的日程文本、管道进出的文本**只当数据**：不拿来拼路径、不当链接点开；
  预览页渲染前统一 `esc()`。
- 信任边界要说实话：**同一个 Windows 账户下的任何进程**都能连上这个管道读到通知正文，
  和它直接去读 `queue.jsonl` 是同一道墙。这不是「已鉴权的 API」。
- 因此：通知正文、日程、截图、`config.json` 一律只落在 `%LOCALAPPDATA%`，
  仓库里一个数据文件都没有，发布前还要过一道隐私预检（下一节）。

## 构建与发布

```
node scripts/build.mjs              # 图标 → assets/icon.ico；版本资源 → csc → bin/win-island.exe
node scripts/build.mjs --release    # 顺带打包 dist/win-island
node scripts/test-all.mjs           # 四套自证判据
node scripts/precheck-publish.mjs   # 发布前的闸
```

发布**只从 `dist/win-island` 提交**，而 `dist/win-island` 由 `scripts/pack-release.mjs` 按**白名单**生成：

- 白名单点名要发哪些文件，其余一律不进 —— 新增文件必须显式加进 `SHIP`，忘了就构建期报错。
- 进包前对源码做脱敏替换（示例课表、示例老师、相对路径），把「真实数据」挡在包外。
- 打包完自证一遍：点名禁入的文件（`precheck-private.json`、`pack-release.mjs`、真实课表、
  私有草稿目录 `scratch/` 等）只要出现在 `dist/` 里就退出码 1。
- 最后一道才是 `precheck-publish.mjs`：递归扫发布包，两类都要报 —— 能识别到人的
  （名单在旁边的 `precheck-private.json`，它自己不许进包）和密钥形状的（正则通用规则）。

这条链路的存在理由：仓库里 30 多个文件，人眼扫第三屏就开始漏，而**公开出去的仓库撤不回来**。
命中不等于一定有错（`a@x.com` 是测试用的假地址），所以要人过一遍 —— 但「一条没有」才算过关。
