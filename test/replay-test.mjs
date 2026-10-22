#!/usr/bin/env node
// 回放（P0-1）的判据：窗口 / 上限 / 幂等 / backfilled 标记，外加一次真实的端到端启动。
//
// 端到端用**假通知库**：临时目录里自己建一份最小 schema 的 wpndatabase.db（列就是 capture.mjs
// SELECT 到的那几个），LOCALAPPDATA 和 WIN_ISLAND_HOME 都指到临时目录，管道名用 WIN_ISLAND_PIPE
// 换掉 —— 不读不写用户真实通知库，也不碰正在跑的那份实例。
//
//   node test/replay-test.mjs
//   node test/replay-test.mjs --expect 20
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

// Node 22 的 node:sqlite 要实验开关；缺开关就带开关重启一次自己（和 capture.mjs 同一个办法）
if (!process.env.WI_REPLAY_TEST) {
  let ok = true;
  try { await import('node:sqlite'); } catch { ok = false; }
  if (!ok) {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', SELF, ...ARGS], {
      stdio: 'inherit', env: { ...process.env, WI_REPLAY_TEST: '1' },
    });
    process.exit(r.status ?? 1);
  }
}
const { DatabaseSync } = await import('node:sqlite');
const { normalizeReplayConfig, selectReplay } = await import(pathToFileURL(join(ROOT, 'src', 'capture', 'replay.mjs')).href);

let n = 0, bad = 0;
const fails = [];
function eq(label, want, got) {
  n++;
  const ok = JSON.stringify(want) === JSON.stringify(got);
  if (!ok) { bad++; fails.push(label); console.log(`  FAIL ${label}\n        期望 ${JSON.stringify(want)}\n        实得 ${JSON.stringify(got)}`); }
  else console.log('  ok   ' + label);
}

// ---------- 1. 纯函数：窗口 / 上限 / 去重 / 标记 ----------
const NOW = 1_700_000_000_000;
const mk = (id, agoMin, extra) => ({ id: String(id), ms: NOW - agoMin * 60000, title: 'T' + id, app: 'A', at: '12:00:00', ...extra });

const d0 = normalizeReplayConfig({});
eq('默认窗口 = 10 分钟 / 20 条', { minutes: 10, max: 20 }, { minutes: d0.minutes, max: d0.max });
const d1 = normalizeReplayConfig({ replayMinutes: '5', replayMax: '0' });
eq('字符串数字要收、0 = 关闭', { minutes: 5, max: 0 }, { minutes: d1.minutes, max: d1.max });
const d2 = normalizeReplayConfig({ replayMinutes: 'abc', replayMax: 999 });
eq('非法值回落默认 / 越界夹到上限', { minutes: 10, max: 200, issues: 2 }, { minutes: d2.minutes, max: d2.max, issues: d2.issues.length });

const picked1 = selectReplay([mk(1, 30), mk(2, 9), mk(3, 1)], { now: NOW, minutes: 10, max: 20, haveIds: [] });
eq('窗口外的历史不回放', ['2', '3'], picked1.map(x => x.id));
eq('按时间升序返回', true, picked1[0].ms < picked1[1].ms);

const many = [1, 2, 3, 4, 5].map(i => mk(100 + i, 5 - i * 0.5));   // 最近的是 105
const picked2 = selectReplay(many, { now: NOW, minutes: 10, max: 3, haveIds: [] });
eq('超过上限保留最新的 N 条', ['103', '104', '105'], picked2.map(x => x.id));
eq('补录条目全部带 backfilled=true', [true, true, true], picked2.map(x => x.backfilled === true));

const picked3 = selectReplay([mk(7, 2), mk(8, 1)], { now: NOW, minutes: 10, max: 20, haveIds: new Set(['7']) });
eq('队列里已有的 id 按幂等跳过', ['8'], picked3.map(x => x.id));
eq('minutes=0 关闭回放', [], selectReplay([mk(9, 1)], { now: NOW, minutes: 0, max: 20, haveIds: [] }));
eq('max=0 关闭回放', [], selectReplay([mk(9, 1)], { now: NOW, minutes: 10, max: 0, haveIds: [] }));
eq('未来时间（时钟漂移/坏行）不回放', [],
  selectReplay([{ id: '10', ms: NOW + 120000 }], { now: NOW, minutes: 10, max: 20, haveIds: [] }));
eq('没有 ms 的坏行跳过', [], selectReplay([{ id: '11', ms: null }], { now: NOW, minutes: 10, max: 20, haveIds: [] }));
eq('同一毫秒按 id 数字升序（结果可复现）', ['21', '22'],
  selectReplay([{ id: '22', ms: NOW - 60000 }, { id: '21', ms: NOW - 60000 }], { now: NOW, minutes: 10, max: 20, haveIds: [] }).map(x => x.id));

// ---------- 2. 端到端：假通知库 + 真抓取层 ----------
const ENOW = Date.now();          // 端到端用真实"现在"：假库里的 ArrivalTime 只有落在最近 10 分钟内才会被回放
const TMP = mkdtempSync(join(tmpdir(), 'win-island-replay-'));
const LAD = join(TMP, 'localappdata');
const HOME = join(TMP, 'home');
const DBF = join(LAD, 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
mkdirSync(dirname(DBF), { recursive: true });
mkdirSync(HOME, { recursive: true });
const ft = ms => (BigInt(Math.round(ms)) * 10000n + 116444736000000000n).toString();
const xml = (t, b) => Buffer.from(
  `<toast activationType="foreground" launch="test://open"><visual><binding template="ToastGeneric"><text>${t}</text><text>${b}</text></binding></visual></toast>`, 'utf8');

{
  const db = new DatabaseSync(DBF);
  db.exec('CREATE TABLE Notification (Id INTEGER PRIMARY KEY, HandlerId INTEGER, PayloadType TEXT, Payload BLOB, ArrivalTime INT64);');
  db.exec('CREATE TABLE NotificationHandler (RecordId INTEGER, PrimaryId TEXT);');
  db.prepare('INSERT INTO NotificationHandler (RecordId, PrimaryId) VALUES (?, ?)').run(1, 'test.app');
  const ins = db.prepare('INSERT INTO Notification (Id, HandlerId, PayloadType, Payload, ArrivalTime) VALUES (?, ?, ?, ?, ?)');
  // 9001 在 30 分钟前（窗口外）；9002-9006 在 5~1 分钟内；9007 不是 Xml；9008 没有正文
  ins.run(9001, 1, 'Xml', xml('旧标题', '窗口外'), ft(ENOW - 30 * 60000));
  for (let i = 2; i <= 6; i++) {
    ins.run(9000 + i, 1, 'Xml', xml('标题' + i, '正文' + i), ft(ENOW - (7 - i) * 60000));
  }
  ins.run(9007, 1, 'Raw', Buffer.from('not xml'), ft(ENOW - 80000));
  ins.run(9008, 1, 'Xml', Buffer.from('<toast><visual><binding><text></text></binding></visual></toast>'), ft(ENOW - 70000));
  db.close();
}
writeFileSync(join(HOME, 'config.json'), JSON.stringify({ capture: { replayMinutes: 10, replayMax: 3 } }), 'utf8');

const CAPTURE = join(ROOT, 'src', 'capture', 'capture.mjs');
let pipeSeq = 0;
function runCapture() {
  pipeSeq++;
  const env = {
    ...process.env,
    LOCALAPPDATA: LAD,
    WIN_ISLAND_HOME: HOME,
    WIN_ISLAND_PIPE: `\\\\.\\pipe\\win-island-replay-test-${process.pid}-${pipeSeq}`,
    WIN_ISLAND_POLL: '700',
  };
  return spawn(process.execPath, [CAPTURE], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}
function killTree(child) {
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const queueFile = join(HOME, 'queue.jsonl');
async function waitQueueLines(min) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(queueFile)) {
      const lines = readFileSync(queueFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length >= min) return lines;
    }
    await sleep(200);
  }
  return existsSync(queueFile) ? readFileSync(queueFile, 'utf8').split('\n').filter(Boolean) : [];
}
function readItems() {
  if (!existsSync(queueFile)) return [];
  return readFileSync(queueFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l.replace(/^\uFEFF/, '')));
}

const child1 = runCapture();
const lines1 = await waitQueueLines(1);
killTree(child1);
await sleep(400);
const items1 = readItems();
eq('端到端：补录条数受 replayMax 限制（=3）', 3, lines1.length);
eq('端到端：补的是窗口内最新的三条', ['9004', '9005', '9006'], items1.map(x => String(x.id)));
eq('端到端：补录条目都带 backfilled=true', [true, true, true], items1.map(x => x.backfilled === true));
eq('端到端：窗口外的旧行没补', false, items1.some(x => String(x.id) === '9001'));
eq('端到端：非 Xml / 空正文的没补', false, items1.some(x => ['9007', '9008'].includes(String(x.id))));
eq('端到端：常驻模式写了 capture.pid', true, existsSync(join(HOME, 'capture.pid')));

const child2 = runCapture();
await sleep(4000);
killTree(child2);
await sleep(400);
const items2 = readItems();
const ids2 = items2.map(x => String(x.id));
eq('端到端：第二次启动不重复补（按 id 幂等）', false, ids2.length !== new Set(ids2).size);
const fresh = ids2.filter(id => !items1.some(x => String(x.id) === id));
eq('端到端：第二次只补队列里还没有的更早条目（每次仍受 replayMax 限制）', ['9002', '9003'], fresh);

rmSync(TMP, { recursive: true, force: true });
console.log(`\n分母：断言 ${n} 条，失败 ${bad} 条`);
if (WANT && n !== WANT) { console.log(`！断言数 ${n}，要求 ${WANT} —— 有人加了/删了断言`); bad++; }
if (bad) console.log('未过：\n  ' + fails.join('\n  '));
process.exit(bad ? 1 : 0);
