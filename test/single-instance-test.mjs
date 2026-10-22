#!/usr/bin/env node
// 单实例保护（P1-10）的判据：两份抓取层不能同时跑。
//
// 验证三件事：
//   1) 命名管道被占时 startApi 的 ready=false（这是真正的锁）；
//   2) 释放后能正常监听、ping 通；
//   3) 真起两个抓取层进程：第二份以退出码 7 退出，不覆盖 capture.pid、不往队列写；
//      把 pid 文件删掉再起第三份，仍然靠管道独占退出（说明不是只靠 pid 文件）。
//
// 全程临时 LOCALAPPDATA + 临时 WIN_ISLAND_HOME + 唯一 WIN_ISLAND_PIPE，不碰用户的实例和真库。
//
//   node test/single-instance-test.mjs
//   node test/single-instance-test.mjs --expect 9
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SELF = fileURLToPath(import.meta.url);
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;

// Node 22 的 node:sqlite 要实验开关；缺开关就带开关重启一次自己
if (!process.env.WI_SINGLE_TEST) {
  let ok = true;
  try { await import('node:sqlite'); } catch { ok = false; }
  if (!ok) {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', SELF, ...ARGS], {
      stdio: 'inherit', env: { ...process.env, WI_SINGLE_TEST: '1' },
    });
    process.exit(r.status ?? 1);
  }
}
const { DatabaseSync } = await import('node:sqlite');

let n = 0, bad = 0;
const fails = [];
function eq(label, want, got) {
  n++;
  const ok = JSON.stringify(want) === JSON.stringify(got);
  if (!ok) { bad++; fails.push(label); console.log(`  FAIL ${label}\n        期望 ${JSON.stringify(want)}\n        实得 ${JSON.stringify(got)}`); }
  else console.log('  ok   ' + label);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TMP = mkdtempSync(join(tmpdir(), 'win-island-single-'));
const LAD = join(TMP, 'localappdata');
const HOME = join(TMP, 'home');
const DBF = join(LAD, 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
mkdirSync(dirname(DBF), { recursive: true });
mkdirSync(HOME, { recursive: true });
{
  const db = new DatabaseSync(DBF);
  db.exec('CREATE TABLE Notification (Id INTEGER PRIMARY KEY, HandlerId INTEGER, PayloadType TEXT, Payload BLOB, ArrivalTime INT64);');
  db.exec('CREATE TABLE NotificationHandler (RecordId INTEGER, PrimaryId TEXT);');
  db.close();
}
const PIPE = `\\\\.\\pipe\\win-island-single-test-${process.pid}`;
process.env.WIN_ISLAND_PIPE = PIPE;
const { startApi } = await import(pathToFileURL(join(ROOT, 'src', 'capture', 'api.mjs')).href);

// ---------- 1. 管道被占：ready=false ----------
const blocker = net.createServer();
await new Promise((res, rej) => { blocker.once('error', rej); blocker.listen(PIPE, res); });
const logs = [];
const a = startApi({ data: HOME, log: s => logs.push(s) });
eq('管道被占时 ready=false', false, await a.ready);
eq('失败日志说得清是管道问题', true, logs.some(s => s.includes('管道')));

// ---------- 2. 释放后能监听、ping 通 ----------
await new Promise(r => blocker.close(r));
await sleep(200);
const b = startApi({ data: HOME, log: s => logs.push(s) });
eq('管道释放后 ready=true', true, await b.ready);
const ping = await new Promise((resolve, reject) => {
  const c = net.connect(PIPE, () => c.write(JSON.stringify({ cmd: 'ping' }) + '\n'));
  let buf = '';
  const timer = setTimeout(() => { try { c.destroy(); } catch {} reject(new Error('ping 超时')); }, 8000);
  c.on('data', d => {
    buf += d.toString('utf8');
    if (buf.includes('\n')) {
      clearTimeout(timer);
      try { resolve(JSON.parse(buf.split('\n')[0])); } catch (e) { reject(e); }
      c.end();
    }
  });
  c.on('error', e => { clearTimeout(timer); reject(e); });
});
eq('拿到锁后 ping 能通', true, ping.ok === true);
await new Promise(r => b.srv.close(r));

// ---------- 3. 真起两个进程：第二份退出码 7 ----------
const CAPTURE = join(ROOT, 'src', 'capture', 'capture.mjs');
const env = { ...process.env, LOCALAPPDATA: LAD, WIN_ISLAND_HOME: HOME, WIN_ISLAND_PIPE: PIPE, WIN_ISLAND_POLL: '700' };
const pidFile = join(HOME, 'capture.pid');
const child1 = spawn(process.execPath, [CAPTURE], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let firstPid = 0;
for (let i = 0; i < 100; i++) {
  if (existsSync(pidFile)) { firstPid = Number(readFileSync(pidFile, 'utf8').trim()); if (firstPid > 0) break; }
  await sleep(200);
}
eq('第一份写了 capture.pid 且指向活着的进程', true, (() => {
  if (!firstPid) return false;
  try { process.kill(firstPid, 0); return true; } catch { return false; }
})());

function spawnSecond() {
  const c = spawn(process.execPath, [CAPTURE], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return new Promise(resolve => c.on('exit', code => resolve(code)));
}
const code2 = await spawnSecond();
eq('第二份抓取层以退出码 7 退出', 7, code2);
eq('第二份没有覆盖 capture.pid', firstPid, Number(readFileSync(pidFile, 'utf8').trim()));
const queueFile = join(HOME, 'queue.jsonl');
const qLines = existsSync(queueFile) ? readFileSync(queueFile, 'utf8').split('\n').filter(Boolean).length : 0;
eq('第二份没有往队列里写', 0, qLines);

rmSync(pidFile, { force: true });                   // 去掉 pid 文件，逼它走管道独占那条路
const code3 = await spawnSecond();
eq('没有 pid 文件时仍靠管道独占退出（退出码 7）', 7, code3);

try { spawnSync('taskkill', ['/PID', String(child1.pid), '/T', '/F'], { windowsHide: true }); } catch {}
await sleep(600);
// 抓取层可能刚起过 meta.mjs（日历库 cal.db 有句柄），第一次删不掉不算失败：临时目录留给系统清
try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
console.log(`\n分母：断言 ${n} 条，失败 ${bad} 条`);
if (WANT && n !== WANT) { console.log(`！断言数 ${n}，要求 ${WANT} —— 有人加了/删了断言`); bad++; }
if (bad) console.log('未过：\n  ' + fails.join('\n  '));
process.exit(bad ? 1 : 0);
