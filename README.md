# win-island

把 Windows 通知中心里的所有通知，收进屏幕顶部一枚常驻胶囊。

任何走系统通知中心（右下角 toast）的通知都会同时出现在顶部：应用名 + 标题 + 正文，到点自动收起，
鼠标停在上面不消失。展开面板能看未读列表、时钟天气、今天的日程和整周课表；点一条跳回来源应用；
复制某条只走一个入口字段，四个地方拿到的字节完全一样。行为几乎全部可配置，配置改完立即热加载并落盘。

Windows 11 · Node 22+ · 系统自带的 PowerShell 5.1 + WPF · 不需要管理员权限。

## 快速开始

```powershell
git clone https://github.com/PaperTigerL/win-island.git
cd win-island
.\bin\win-island.exe start                     # 起抓取层 + 岛屿，并把状态打回来
powershell -File .\tools\send-test.ps1 -Count 3   # 发三条测试通知，验整条链路
.\bin\win-island.exe status
.\bin\win-island.exe stop
```

`bin\win-island.exe` 是用系统自带的 `csc.exe` 编出来的启动器：它负责找代码、起停、问状态、开配置，
不重新实现应用逻辑。渲染层留在 PowerShell + WPF 上，正是为了「装都不用装」。
为什么是这三层、为什么不用官方 WinRT 接口，写在 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

详细手册：[`docs/USAGE.md`](docs/USAGE.md)　·　全部配置项：[`docs/CONFIG.md`](docs/CONFIG.md)

## 能做什么

| | |
| --- | --- |
| 抓取 | 只读轮询通知库（`wpndatabase.db`），实测覆盖 QQ(NTQQ)、QQ邮箱、B站、WorkBuddy、NVIDIA、VSCode、WSL、WPS、OneDrive、Windows 安全中心 |
| 常驻 | 顶部小条：时钟 + 天气 + 未读角标。可拖到九宫格任意锚位、滚轮缩放 0.7~1.8，位置和大小落盘，重启恢复 |
| 展开 | 触发方式四档：悬停 / 单击 / 长按 / 只认外部调用。延迟、宽限期、收起时长都是配置项 |
| 跳转 | 点一条 → 通知自带的协议深链 → 按 AUMID 唤到前台 → 都没有只写日志。`file:` / `javascript:` / UNC 这类一律拒绝执行 |
| 复制 | 面板行内、右键、`Ctrl+C`、菜单四个入口，字节一致；CRLF 统一，剪贴板被占用时重试并兜底落盘 |
| 日程 | `.ics` / `.csv` / `.json` / adb 输出统一导入（编码嗅探、重复事件展开、去重、跨来源冲突报告），预览页勾着选 |
| 对外 | 命名管道 `\\.\pipe\win-island`：`ping` `list` `text` `copy` `config` `config.set` `request`；`/api/schedule` `/api/week` 只绑 127.0.0.1 |
| 全屏 | 前台铺满一屏时三档：照常悬浮 / 缩成 6px 把手 / 整条隐藏 |

## 目录结构

```
win-island/
├─ bin/win-island.exe          编译出来的启动器（csc.exe + 版本资源 + 图标）
├─ src/
│  ├─ capture/                 抓取层：capture.mjs（轮询通知库）+ api.mjs（命名管道）
│  ├─ island/                  渲染层：island.ps1 + prefs.ps1（配置）+ geometry.ps1（纯算术）+ activate-lib.ps1（Win32）
│  ├─ schedule/                日程：解析 / 存储 / 导入 / 预览页 / 手机拉取 / 课表生成 / 聚合
│  └─ launcher/                启动器源码（WinIsland.cs + win-island.rc）
├─ scripts/                    build / launch / stop / lint / bom / test-all / precheck-publish
├─ test/                       五套自证判据 + 合成的 fixture
├─ tools/                      探针：send-test / snap / ui-probe / drag-bar / probe-windows …
├─ docs/                       USAGE.md / CONFIG.md / ARCHITECTURE.md
└─ assets/icon.ico
```

运行时数据一个都不在仓库里：通知正文、已读账本、日程、导入库全在
`%LOCALAPPDATA%\win-island\`，`.gitignore` 拦着。

## 构建

```powershell
npm install            # 没有第三方依赖，这一步只是让 npm script 可用
node scripts\build.mjs              # 图标 → 版本资源 → csc → bin/win-island.exe
node scripts\build.mjs --release    # 顺带按白名单打包 dist/win-island
node scripts\test-all.mjs           # 全部自证判据
node scripts\test-all.mjs --unit    # 只跑不碰桌面的那几套
```

## 自证判据

别信 README 说的，跑一遍（后两套会真的动鼠标和剪贴板）：

| 命令 | 判据 |
| --- | --- |
| `node test\cal-test.mjs --expect 59` | 解析层：编码 / 时区 / 重复规则 / 提醒 / 字段映射 / 坏数据 |
| `node test\cal-flow-test.mjs --expect 51` | 全流程 + 真 HTTP：预览不写库 → 去重 → 冲突 → 展开 → 并进 `agenda.json` → 勾几条写几条 |
| `node test\prefs-test.mjs --expect 44` | 配置项：文档 ↔ `$PrefsSpec` 逐字一致、非法值回落、写盘无 BOM 且只动 `island` 段 |
| `node test\api-test.mjs` | 另一个进程走管道：拿全文、写剪贴板、读写配置、驱动岛屿动作 |
| `node test\copy-test.mjs` | 真点面板行尾「复制」，逐行比对系统剪贴板字节，要求裸 LF = 0 |

判据是**渲染出来的像素、系统剪贴板里的字节、盘上的 `config.json`**，不是日志里那句「已复制」。

## 数据与隐私

通知正文里有群名、邮件主题这类东西，所以：

- 运行时的一切只写 `%LOCALAPPDATA%\win-island\`，仓库里一个数据文件都没有。
- 发布包由 `scripts/pack-release.mjs` 按**白名单**生成，源码里那几处真课表常量在进包前换成示例。
- 出门前还有一道 `scripts/precheck-publish.mjs`：递归扫发布包，能识别到人的（名单在本地私有文件里，
  那个文件本身不许进包）和密钥形状的一起报，**一条没有才算过关**。
- 信任边界要说实话：**同一个 Windows 账户下的任何进程**都能连上 `\\.\pipe\win-island` 读到通知正文，
  和它直接去读 `queue.jsonl` 是同一道墙。这不是「已鉴权的 API」。
- 导入的日程文本、管道进出的文本只当数据用：不拼路径、不当链接点开。

## 已知做不到

- 应用自己画的气泡 / 悬浮窗（不走通知中心的）抓不到，库里根本没有行。
- 在 设置 > 通知 里关掉「在通知中心显示」的应用、专注助手 / 免打扰期间的通知，不入库。
- 通知库里没有任何「已读 / 已点 / 已清除」列，「未读」只能岛屿自己记账；
  「系统侧消失」和「你处理过了」分不开，所以只报前者。
- 右下角原生 toast 还在弹（两处都显示）；手机日历没有「不碰手机设置就自动同步」的方案。
- 没有开机自启（自己挂计划任务，笔记本注意 `DisallowStartIfOnBatteries`）。

完整列表在 [`docs/USAGE.md` 第 10 节](docs/USAGE.md#10-已知做不到别当-bug-问)。

## 许可

MIT，见 [`LICENSE`](LICENSE)。贡献前先看 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
