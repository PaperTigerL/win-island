#!/usr/bin/env node
// 几何/判定纯函数的判据：跑的是 src/island/geometry.ps1 的真实实现（PowerShell dot-source）。
// 目前覆盖「前台窗口算不算游戏/无边框全屏」（Test-GameLike）；拖拽吸附在同一个 harness 里。
//
//   node test/geometry-test.mjs
//   node test/geometry-test.mjs --expect 11
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;

const raw = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  join(HERE, 'geometry-harness.ps1')], { encoding: 'utf8', maxBuffer: 9e6 });
const line = raw.trim().split(/\r?\n/).pop();
let result;
try { result = JSON.parse(line); } catch (e) {
  console.log('拿不到 geometry-harness.ps1 的 JSON 输出：' + e.message);
  console.log(raw);
  process.exit(1);
}

let bad = 0;
for (const c of result.checks || []) {
  if (c.ok) console.log('  ok   ' + c.name);
  else { bad++; console.log('  FAIL ' + c.name + '\n        ' + c.detail); }
}
const n = (result.checks || []).length;
console.log('');
console.log('分母：断言 ' + n + ' 条，失败 ' + bad + ' 条');
if (WANT && n !== WANT) { console.log('！断言数 ' + n + '，要求 ' + WANT + ' —— 有人加了/删了断言'); bad++; }
process.exit(bad ? 1 : 0);
