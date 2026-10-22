// 一条命令跑完自证判据：npm test
//   node scripts/test-all.mjs            全跑（后两套要岛屿在跑：会真的动鼠标、剪贴板）
//   node scripts/test-all.mjs --unit     只跑不碰桌面的（解析/导入/配置 + 语法/BOM）
// 判据是「带期望断言数的那几套：条数 == 期望 且 失败 0」，不是「脚本没报错」——所以每条都写死期望数，
// 少一条断言就是失败（断言被人删了也算回归）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT = process.argv.includes('--unit');

function run(file, args, { expect, label } = {}) {
  const r = spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', shell: false, maxBuffer: 1.6e7 });
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.trim().split('\n').slice(-3).join('\n');
  let ok = r.status === 0;
  if (expect !== undefined) {
    const m = out.match(/分母：断言 (\d+) 条，失败 (\d+) 条/);
    if (!m) { ok = false; console.log(`  ！拿不到断言分母（脚本可能中途炸了）`); }
    else if (Number(m[1]) !== expect || Number(m[2]) !== 0) {
      ok = false;
      console.log(`  ！断言数 ${m[1]}（要 ${expect}）/ 失败 ${m[2]}`);
    }
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n${tail.split('\n').map(l => '      ' + l).join('\n')}`);
  return ok;
}

const results = [];
results.push(run('node', [join(ROOT, 'scripts', 'bom.mjs')], { label: 'BOM 检查（.ps1 必须带 BOM，否则 5.1 按 GBK 读）' }));
results.push(run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'lint.ps1')],
  { label: 'PowerShell 语法自检' }));
results.push(run('node', [join(ROOT, 'test', 'cal-test.mjs'), '--expect', '59'], { expect: 59, label: '解析层 59 条断言' }));
results.push(run('node', [join(ROOT, 'test', 'cal-flow-test.mjs'), '--expect', '51'], { expect: 51, label: '导入全流程 + 真 HTTP 51 条断言（临时 HOME，不碰真库）' }));
results.push(run('node', [join(ROOT, 'test', 'prefs-test.mjs'), '--expect', '66'], { expect: 66, label: '配置项 66 条断言（spec/文档/回落 + 热应用 + request + 游戏态 + 吸附）' }));
results.push(run('node', [join(ROOT, 'test', 'queue-test.mjs'), '--expect', '22'], { expect: 22, label: '队列 22 条断言（半行/轮转/去重 + live 对账，不启 WPF）' }));
results.push(run('node', [join(ROOT, 'test', 'notify-test.mjs'), '--expect', '43'],
  { expect: 43, label: '单向通知 43 条断言（去重/字段/无文件/哈希不变 + 只读边界，不碰真实通知文件）' }));
results.push(run('node', [join(ROOT, 'test', 'rotate-test.mjs'), '--expect', '20'],
  { expect: 20, label: 'W-6 轮转 20 条断言（>5MB 改名 .1/哈希一致/只留一份，临时目录）' }));
results.push(run('node', [join(ROOT, 'test', 'replay-test.mjs'), '--expect', '21'],
  { expect: 21, label: '回放 21 条断言（窗口/上限/幂等 + 假通知库端到端，不碰真库）' }));
results.push(run('node', [join(ROOT, 'test', 'single-instance-test.mjs'), '--expect', '9'],
  { expect: 9, label: '单实例 9 条断言（管道独占即退出码 7，不碰真库）' }));
results.push(run('node', [join(ROOT, 'test', 'geometry-test.mjs'), '--expect', '22'],
  { expect: 22, label: '几何/判定 22 条断言（游戏识别 + 拖拽吸附 + DPI 指纹，不启 WPF）' }));
results.push(run('node', [join(ROOT, 'test', 'audio-contract-test.mjs'), '--expect', '15'],
  { expect: 15, label: '频谱契约 15 条断言（引擎函数/惰性编译/gameMode 暂停/audio.json/管道/配置，不碰声卡）' }));

if (!UNIT) {
  const ping = spawnSync(join(ROOT, 'bin', 'win-island.exe'), ['status', '--json'], { encoding: 'utf8' });
  let up = false;
  try { const j = JSON.parse((ping.stdout || '').trim()); up = j.capture > 0 && j.island > 0; } catch { }
  if (!up) {
    console.log('\nFAIL  端到端两套跳不过去：岛屿没在跑。先 win-island start（或 npm start）再跑。');
    results.push(false, false);
  } else {
    results.push(run('node', [join(ROOT, 'test', 'api-test.mjs')], { label: '外部进程走管道取全文 + 写剪贴板' }));
    results.push(run('node', [join(ROOT, 'test', 'copy-test.mjs')], { label: '真点击面板行尾「复制」，逐行比对剪贴板字节' }));
    // 频谱两套：A 引擎（自己起进程放合成纯音，不动岛）+ B 活着的岛（开 audioOn、数屏幕上那块矩形里的亮像素）。
    // 需要真实音频端点，不属于 --unit —— 没声卡/纯远程会话的机器上会失败，但那本来就不是能跑频谱的机器。
    results.push(run('node', [join(ROOT, 'test', 'audio-test.mjs'), '--expect', '103'],
      { expect: 103, label: '频谱 103 条断言（已知频率落对格 + 管道快照 + 门控配对数真实屏幕像素）' }));
  }
}

const bad = results.filter(x => !x).length;
console.log(`\n合计 ${results.length} 项，失败 ${bad} 项。`);
process.exit(bad ? 1 : 0);
