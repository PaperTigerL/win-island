# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
