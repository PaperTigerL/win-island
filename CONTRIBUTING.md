# 贡献指南

先说这条项目最在意的一件事：**判据只能是端到端的真结果**。
日志里那句「已复制」「已应用」「启动成功」都不算数 —— 渲染出来的像素、系统剪贴板里的字节、
盘上那份 `config.json` 才算。改界面前后的截图、改配置前后的文件内容，请一起带上。

## 环境

- Windows 11（通知库表结构按 10.0.26200 实测过）
- Node 22+（`node:sqlite`；22 上要实验开关，`capture.mjs` 会带 `--experimental-sqlite` 重启自己一次）
- PowerShell 5.1（系统自带）
- 不需要管理员权限，也不需要装任何第三方包（`npm install` 只为跑 npm script）

```powershell
npm start         # = powershell -File scripts\launch.ps1
npm run stop
npm test          # 全部自证判据
npm run lint      # BOM + PowerShell 语法
npm run build     # 编 bin\win-island.exe
```

## 目录规矩

| 放哪 | 放什么 |
| --- | --- |
| `src/capture/` `src/island/` `src/schedule/` `src/launcher/` | 四层实现，按层而不是按文件类型分 |
| `scripts/` | 构建、启停、检查、打包这类「对项目本身动手」的 |
| `tools/` | 调试探针（真发通知、截图、UIA 点击、拖拽） |
| `test/` | 自证判据，fixture 全合成 |
| `docs/` | 手册、配置表、架构说明 |
| **不该出现** | 任何运行时数据、日志、dump、真实日程 |

## 加一个配置项（必须四处一起动）

1. `src/island/prefs.ps1` 的 `$PrefsSpec` 加一项：`type` / `default` /（枚举 `values`、数字 `min`/`max`）/ `doc`。
   `doc` 是给文档用的，别写废话。
2. `docs/CONFIG.md` 那张表加一行，**类型、默认、范围、说明四列逐字照 spec**。
   `test/prefs-test.mjs` 会对着这两处逐字比，漂了就红。
3. `src/island/island.ps1` 里真的去读它（`$p.<key>`）—— 测试会检查「spec 里有但没人读」的假可配置项。
4. 如果它和其他项有硬冲突（比如 `trigger=click` 必须关掉穿透），写在 `Apply-PrefImplications` 里，
   不要在实现层到处打补丁。

改完跑 `node test\prefs-test.mjs`，并把 `--expect` 的分母同步到 `scripts/test-all.mjs`。

## 加一条管道命令

`src/capture/api.mjs` 的 `handle()` 里加 `case`，并且：

- 顶部注释里的命令表同步（那是别人抄的样板）。
- `docs/USAGE.md` 第 5 节 + `docs/CONFIG.md` 对应小节同步。
- `test/api-test.mjs` 加断言，判据要能落到盘上或系统状态上（不是「回话没报错」）。
- 失败一律 `{ok:false,reason:"可读的中文"}`，不给堆栈。

## 改渲染层之前要知道的坑

这些都是踩过之后写进代码注释的，别再踩：

- **`.ps1` 必须 UTF-8 带 BOM**。PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解，中文注释最后一个字节可能变成
  反引号，把下一行（比如 `param` 那行）吞掉 —— 症状是参数静默变 null，**不是报错**。
  改完任何 `.ps1` 跑 `node scripts\bom.mjs`。
- **`config.json` 必须无 BOM**，并且写完要原子替换（`.tmp` + 改名）。岛屿按 mtime 轮询它，
  读到半截 JSON 会整轮回落默认值，面板上就是一次看得见的闪。
- **DIP ≠ 物理像素**。WPF 的 `Left/Top/Width` 是 DIP，`Forms.Screen` 和 Win32 光标坐标是像素，
  125%/150% 缩放的机器上差 1.25/1.5 倍。换算只走 `geometry.ps1`。
- **.NET Framework 的 WPF 没有公开 `StackPanel.Direction`**，也**没有公开 `MouseDevice.GetMouseState()`**。
  向上生长靠重排 `root.Children`；按键状态靠 Win32 `GetAsyncKeyState`。
- **菜单开着的时候别抢置顶**（`Test-MenuUp` / `Sync-Topmost`），否则菜单被压到窗口下面。
- **重启岛屿只走 `scripts\launch.ps1`**。手工 `Start-Process` 起的实例出现过
  「进程活着、窗口从不显示」的静默失效；而且两个子进程都必须带 `-RedirectStandardOutput`，
  否则它们继承调用方的 stdout 句柄，谁用管道调这个脚本就永远等不到 EOF。

## 注释与提交信息

注释只写**为什么**和**踩过的坑**，不复述代码在干什么。日期和现象可以留（「2026-09-26 实测」这种），
因为它解释了这段丑代码为什么不能删。提交信息说清动了哪一层、为什么。

## 自证

提 PR 前跑：

```powershell
node scripts\test-all.mjs            # 全跑（会真的动鼠标、剪贴板）
node scripts\test-all.mjs --unit     # 只跑不碰桌面的那几套
```

改到界面 / 交互的，额外跑对应的探针：`tools\snap.ps1`（截图）、`tools\ui-probe.ps1`（真右键真点）、
`tools\drag-bar.ps1`（真拖拽真滚轮，用户正在动鼠标时它会诚实退出而不是给你一个假绿）。

## 发布（维护者做，贡献者不用）

1. `node scripts\build.mjs --release` → 生成 `dist/win-island`（白名单 + 脱敏 + 禁入自检）。
2. `node scripts\precheck-publish.mjs` → **硬闸**：个人信息和密钥形状各 0 处才过关；
   命中不等于一定有错，但要逐条看。
3. 只在 `dist/win-island` 里 `git commit` / `git push`。**不要在开发目录里 `git init`** ——
   那里全是真数据、真名字和私有草稿探针（`scratch/`、`scripts/precheck-private.json`、
   `scripts/pack-release.mjs`、真课表 `.ics`），一次误 push 撤不回来。
4. `gh release create v1.0.0 dist/win-island.zip`，Release 的 zip 就是那份白名单包。

这条链路的白名单是**故意反直觉**的：新增文件必须显式加进 `pack-release.mjs` 的 `SHIP` 才会出门。
漏加顶多少发一个探针，漏挡一个真数据就是别人身份外流。
