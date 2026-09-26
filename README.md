# win-island —— 把 Windows 所有软件的通知收进顶部一枚胶囊

HyperOS / 灵动岛那种观感：任何走 Windows 通知中心（右下角 toast）的通知，都会同时出现在
屏幕顶部正中的一枚胶囊里 —— 应用角标 + 标题 + 正文，几秒后自动收起，鼠标停在上面不消失。
往上滑展开一块面板：时钟 + 天气、未读列表、今天的日程（可切到整周课表）。

零安装：只要 Node 22+ 和系统自带的 PowerShell 5.1，没有编译、没有依赖、没有管理员权限。

## 快速开始

```powershell
# 1) 起（抓取层 + 岛屿两个进程）
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1

# 2) 发几条测试通知看整条链路
powershell -NoProfile -ExecutionPolicy Bypass -File .\send-test.ps1 -Count 3

# 3) 停
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
```

鼠标移到胶囊上**向上滑**（或直接点它）就展开面板。右键胶囊 / 托盘图标：暂停、重看上一条、
打开数据目录、退出。详细用法全在 [`README-用法.txt`](README-用法.txt)。

## 环境

- Windows 11（通知库 `wpndatabase.db` 的表结构按 10.0.26200 实测）
- Node 22+。`node:sqlite` 在 22 上还要实验开关 —— `capture.mjs` 起自己时会检测并带 `--experimental-sqlite`
  重启一次，Node 24 就不需要，所以启动脚本里不用猜版本
- PowerShell 5.1（系统自带）。**`.ps1` 必须是 UTF-8 带 BOM**，改完任何脚本跑一次 `node bom.mjs`

## 能抓到的边界（先说不能的）

只有**走 Windows 通知中心**的通知在库里。实测抓到过：QQ(NTQQ)、QQ邮箱、B站客户端、WorkBuddy、
NVIDIA、Windows 安全中心、VSCode、WSL、WPS、OneDrive。抓不到：

- 应用自己画的气泡 / 悬浮窗（没进通知中心就没有数据）
- 在「设置 → 通知」里被关掉「在通知中心显示」的应用
- 专注助手 / 免打扰期间到的通知（系统直接不入库）

**点开胶囊跳回来源应用**按三级走：通知载荷里的 `launch` 协议串（复用系统自己那套深链）→
按 AUMID 唤到前台（商店包走 `shell:AppsFolder\`，Win32 应用的 AUMID 常常就是 exe 路径）→
都没有就只写日志，不猜。`file:` / `javascript:` / `vbscript:` / `about:` / `search-ms:` /
`ms-msdt:` / UNC 开头的 launch 一律拒绝执行 —— 那是"别的应用写进数据库的一行字符串"，
不该有权力让我们的进程替它拉起本地文件或脚本。

## 数据与隐私

运行时的一切（通知正文、已读账本、日程、导入的库）只写
`%LOCALAPPDATA%\win-island\`，**仓库里一个数据文件都没有**，`.gitignore` 也拦着。
即便如此仍要说清信任边界：**同一个 Windows 账户下的任何进程**都能连上
`\\.\pipe\win-island` 读到通知正文，和它直接去读 `%LOCALAPPDATA%` 里那个 jsonl 是同一道墙。
通知正文里的内容（群名、邮件主题）属于你自己，别把数据目录分享出去。

## 日程 / 课表

面板下面那段日程有两条来源：订阅链接（`.ics` URL，写在 `config.json`）和本机导入
（`cal-import.mjs`，认 `.ics` / `.csv` / `.json` / adb `content query` 输出，编码 UTF-8/GBK/UTF-16
自动判，字段名按同义词表映射）。导入是「先预览、再确认」：

```powershell
node cal-import.mjs 你的文件.ics            # 只预览，库里一个字不动
node cal-import.mjs 你的文件.ics --serve    # 开 http://127.0.0.1:8733/ 勾着选、改异常时间
node cal-import.mjs 你的文件.ics --as 来源名 --commit
```

`--commit` / `--drop` / `--exclude` 之后岛上立刻是新的（两份日程文件一起重建）。
「本周课表」是整周展开视图，含每天**放假 / 调休补班**标记（法定节假日数据取
`timor.tech`，按年缓存）。机器可读接口：`GET http://127.0.0.1:8733/api/schedule`、
`/api/week`（只绑 127.0.0.1）。教务那张课表表格可以先用 `cal-timetable.mjs` 转成 `.ics`
再走上面的导入 —— 里面 `WEEK1_MONDAY`（第 1 周周一）和 `SLOTS`（第几节 → 几点）两个常量
必须按你学校自己填，图里读不出来。

## 自证判据（别信我说的，跑这四条）

```powershell
node cal-test.mjs          # 解析层，59 条断言
node cal-flow-test.mjs     # 全流程 + 真 HTTP，51 条断言（用临时 HOME，不碰你的库）
node api-test.mjs          # 外部进程走管道取全文 + 写剪贴板
node copy-test.mjs         # 真点击面板行尾「复制」，逐行比对系统剪贴板字节
```

后两条会真的动鼠标和剪贴板 —— 那才是判据，日志里那句「已复制」不算。

## 还做不到

- 通知库里**没有任何「已读 / 已点 / 已清除」列**，"未读"只能岛屿自己记账；
  条目从系统侧消失 = 你划掉了或者它到期了，这两者分不开，所以只标「系统侧消失」，不谎报成「已处理」。
- 没有开机自启（要加就自己挂个计划任务，笔记本注意 `DisallowStartIfOnBatteries`）。
- 补班那天到底按周几的课表上，公开接口给不出来；学校自己放的假（运动会、小学期）也不在表里。
- 手机日程同步：唯一稳的路是手机上手动导出到"下载"目录再 `cal-pull.mjs`。MTP 看不到应用私有库，
  `content://com.android.calendar/events` 走 adb 能不能拿到取决于厂商，未实测。

完整列表在 `README-用法.txt` 末尾「还做不到」那一节。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
