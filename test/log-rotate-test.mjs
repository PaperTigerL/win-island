#!/usr/bin/env node
// 运行期 capture.log 轮转的判据：>5MB 改名 .1、内容哈希一致、只留一份历史、<=5MB 不动。
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotateIfNeeded, DEFAULT_MAX_BYTES } from '../src/capture/log-rotate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;
const MB = 1024 * 1024;
const tmp = mkdtempSync(join(tmpdir(), 'win-island-logrotate-'));
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

eq('默认阈值是 5MB', DEFAULT_MAX_BYTES, 5 * MB);
eq('文件不存在返回 null', rotateIfNeeded(P('missing.log')), null);

writeFileSync(P('exact.log'), Buffer.alloc(DEFAULT_MAX_BYTES, 0x61));
eq('正好 5MB 不轮转', rotateIfNeeded(P('exact.log')), null);
eq('正好 5MB 文件仍在、无 .1', [existsSync(P('exact.log')), existsSync(P('exact.log.1'))], [true, false]);

writeFileSync(P('big.log'), Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x62));
const before = sha(P('big.log'));
const r1 = rotateIfNeeded(P('big.log'));
eq('超过 5MB 返回轮转信息', [r1.file, r1.bytes, r1.to], [P('big.log'), DEFAULT_MAX_BYTES + 1, P('big.log.1')]);
eq('轮转后 .1 存在、当前文件消失', [existsSync(P('big.log.1')), existsSync(P('big.log'))], [true, false]);
eq('轮转前后内容哈希一致', sha(P('big.log.1')), before);

writeFileSync(P('big.log'), Buffer.alloc(DEFAULT_MAX_BYTES + 2, 0x63));
const r2 = rotateIfNeeded(P('big.log'));
eq('第二次轮转替换旧 .1', [r2.bytes, statSync(P('big.log.1')).size], [DEFAULT_MAX_BYTES + 2, DEFAULT_MAX_BYTES + 2]);
eq('历史只留一份（没有 .2 / .1.1）', [existsSync(P('big.log.2')), existsSync(P('big.log.1.1'))], [false, false]);

writeFileSync(P('small.log'), Buffer.alloc(1024, 0x64));
eq('自定义更小阈值生效', [rotateIfNeeded(P('small.log'), 100) !== null, existsSync(P('small.log.1'))], [true, true]);

console.log('');
console.log('分母：断言 ' + n + ' 条，失败 ' + bad + ' 条');
if (WANT && n !== WANT) { console.log('！断言数 ' + n + '，要求 ' + WANT + ' —— 有人加了/删了断言'); bad++; }
process.exit(bad ? 1 : 0);
