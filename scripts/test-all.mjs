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
results.push(run('node', [join(ROOT, 'test', 'prefs-test.mjs'), '--expect', '44'], { expect: 44, label: '配置项 44 条断言（spec ↔ 文档 ↔ 非法值回落）' }));

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
  }
}

const bad = results.filter(x => !x).length;
console.log(`\n合计 ${results.length} 项，失败 ${bad} 项。`);
process.exit(bad ? 1 : 0);
