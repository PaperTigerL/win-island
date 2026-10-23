#!/usr/bin/env node
// P2-12 的判据：Save-State 只标脏、tick 合并落盘、退出无条件写；纯到期判断来自真实 state-throttle.ps1。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;
const src = readFileSync(join(ROOT, 'src', 'island', 'island.ps1'), 'utf8');

let n = 0, bad = 0;
function check(label, ok, detail) {
  n++;
  if (!ok) { bad++; console.log('  FAIL ' + label + (detail ? '\n        ' + detail : '')); }
  else console.log('  ok   ' + label);
}

const raw = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  join(HERE, 'state-throttle-harness.ps1')], { encoding: 'utf8', maxBuffer: 4e6 });
let result;
try { result = JSON.parse(raw.trim().split(/\r?\n/).pop()); } catch (e) {
  console.log('拿不到 state-throttle-harness.ps1 的 JSON：' + e.message);
  console.log(raw);
  process.exit(1);
}
for (const c of result.checks || []) check('纯函数：' + c.name, c.ok, c.detail);

function block(name, next) {
  const a = src.indexOf(`function ${name} {`);
  if (a < 0) return '';
  const b = next ? src.indexOf(`function ${next} {`, a) : src.indexOf('\n}\n', a);
  return b > a ? src.slice(a, b) : src.slice(a);
}
const save = block('Save-State', 'Flush-State');
const saveNow = block('Save-StateNow', 'Save-State');
const flush = block('Flush-State', 'Get-Unread');

check('存在 Save-StateNow 真正写盘函数', saveNow.includes('Set-Content'));
check('Save-State 只标脏、不直接 Set-Content', save.includes('StateDirty = $true') && !save.includes('Set-Content'));
check('Flush-State 用 Test-StateFlushDue 判断到期', flush.includes('Test-StateFlushDue') && flush.includes('Save-StateNow'));
check('tick 每拍调用 Flush-State', src.includes('$script:tick++\n  Flush-State'));
check('窗口关闭时无条件 Save-StateNow', /Add_Closed\(\{[\s\S]{0,80}Save-StateNow/.test(src));
check('节流窗口 500ms 且不超过 1s', /StateDelayMs\s*=\s*500/.test(src));

console.log('');
console.log('分母：断言 ' + n + ' 条，失败 ' + bad + ' 条');
if (WANT && n !== WANT) { console.log('！断言数 ' + n + '，要求 ' + WANT + ' —— 有人加了/删了断言'); bad++; }
process.exit(bad ? 1 : 0);
