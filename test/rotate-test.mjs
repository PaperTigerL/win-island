#!/usr/bin/env node
// W-6 日志/队列轮转的判据（跑真实 scripts/rotate.ps1，临时目录，不碰真实数据目录）：
//   - >5MB 的文件改名 .1，内容哈希逐字节一致（不丢数据）；
//   - 已有 .1 被替换，历史只留一份（没有 .2 / .1.1）；
//   - <=5MB（含正好 5MB）不动；
//   - 轮转后当前文件由子进程重新创建，不会碰 .1；
//   - 第二次轮转仍然只留一份历史。
//
//   node test/rotate-test.mjs
//   node test/rotate-test.mjs --expect 20
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;
const MB = 1024 * 1024;
const tmp = mkdtempSync(join(tmpdir(), 'win-island-rotate-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { } });

let n = 0, bad = 0;
function eq(label, want, got) {
  n++;
  const ok = JSON.stringify(want) === JSON.stringify(got);
  if (!ok) { bad++; console.log(`  FAIL ${label}\n        期望 ${JSON.stringify(want)}\n        实得 ${JSON.stringify(got)}`); }
  else console.log(`  ok   ${label} = ${JSON.stringify(got)}`);
}
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
const P = name => join(tmp, name);
function big(name, bytes, ch, tail) {
  const b = Buffer.alloc(bytes, ch);
  if (tail) Buffer.from(tail, 'utf8').copy(b, bytes - Buffer.byteLength(tail));
  writeFileSync(P(name), b);
  return sha(P(name));
}
function run() {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(ROOT, 'scripts', 'rotate.ps1'), '-DataDir', tmp], { encoding: 'utf8', maxBuffer: 9e6 });
  let out = null;
  try { out = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch { }
  return { r, out };
}

// 第一轮夹具：两个超 5MB、一个正好 5MB、一个 1MB、一个 0 字节、一个旧历史
const hIsland = big('island.out.log', 6 * MB, 0x41, 'TAIL-ISLAND-ABC');
const hQueue = big('queue.jsonl', 5 * MB + 100, 0x42, 'TAIL-QUEUE-XYZ');
writeFileSync(P('capture.log'), Buffer.alloc(5 * MB, 0x43));       // 正好 5MB：不轮转
writeFileSync(P('capture.out.log'), Buffer.alloc(1 * MB, 0x44));  // 小于阈值：不轮转
writeFileSync(P('island.err.log'), Buffer.alloc(0));              // 空文件：不碰
writeFileSync(P('island.out.log.1'), 'OLD-HISTORY');

const first = run();
eq('第一轮退出码 0', 0, first.r.status);
eq('第一轮报告轮转了 2 个文件', 2, Array.isArray(first.out) ? first.out.length : first.out);
eq('island.out.log 已改名（当前文件不存在）', false, existsSync(P('island.out.log')));
eq('island.out.log.1 存在', true, existsSync(P('island.out.log.1')));
eq('island 历史内容哈希与轮转前一致', hIsland, sha(P('island.out.log.1')));
eq('queue.jsonl 已改名', false, existsSync(P('queue.jsonl')));
eq('queue.jsonl.1 存在', true, existsSync(P('queue.jsonl.1')));
eq('queue 历史内容哈希与轮转前一致', hQueue, sha(P('queue.jsonl.1')));
eq('正好 5MB 不轮转', true, existsSync(P('capture.log')) && !existsSync(P('capture.log.1')));
eq('1MB 不轮转', true, existsSync(P('capture.out.log')) && !existsSync(P('capture.out.log.1')));
eq('空文件不轮转', true, existsSync(P('island.err.log')) && !existsSync(P('island.err.log.1')));
eq('旧 .1 被新历史替换', false, readFileSync(P('island.out.log.1'), 'utf8').includes('OLD-HISTORY'));
eq('island 没有第二份历史（无 .2）', false, existsSync(P('island.out.log.2')));
eq('queue 没有第二份历史（无 .2）', false, existsSync(P('queue.jsonl.2')));
eq('历史尾部标记完整（不丢数据）', true, readFileSync(P('island.out.log.1')).toString('utf8').endsWith('TAIL-ISLAND-ABC'));

// 模拟子进程重建当前文件：.1 一个字节都不该动
const hHistory = sha(P('island.out.log.1'));
writeFileSync(P('island.out.log'), 'new run line\n');
eq('子进程重建当前文件后 .1 不变', hHistory, sha(P('island.out.log.1')));

// 第二轮：再写一个 >5MB 的当前文件，仍然只留一份历史
const hIsland2 = big('island.out.log', 6 * MB, 0x45, 'TAIL-ISLAND-SECOND');
const second = run();
eq('第二轮退出码 0', 0, second.r.status);
eq('第二轮只报告 1 个文件', 1, Array.isArray(second.out) ? second.out.length : second.out);
eq('第二轮 .1 换成新内容', hIsland2, sha(P('island.out.log.1')));
eq('第二轮仍然只有一份历史', false, existsSync(P('island.out.log.2')));

console.log(`\n分母：断言 ${n} 条，失败 ${bad} 条`);
if (WANT && n !== WANT) { console.log(`！断言数 ${n}，要求 ${WANT} —— 有人加了/删了断言`); bad++; }
process.exit(bad ? 1 : 0);
