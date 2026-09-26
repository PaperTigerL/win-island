#!/usr/bin/env node
// 抓取层：只读轮询 Windows 通知中心数据库，把新到的通知追加成 JSONL 队列给岛屿渲染。
//
// 为什么走轮询而不是官方 WinRT UserNotificationListener：那个 API 要求调用方有「包身份」，
// 实测未打包进程拿不到（IDENTITY=NONE / GetDefaultAsync 0x80131501），要走就得打包 MSIX，
// 而这台机器 dotnet 是坏 shim、没装 rust。轮询路线实测零依赖可用（普通用户权限即可）。
//
// 队列只落在 %LOCALAPPDATA%\win-island，绝不写进项目目录——那是会推到 GitHub 的工作区，
// 通知正文里有 QQ 群名、邮件主题这类东西。
//
//   node capture.mjs            常驻轮询
//   node capture.mjs --once     只跑一轮并打印，用来验证「能不能抓到」这件事
//   node capture.mjs --replay   把库里现存的通知全部灌进队列（看历史效果用）

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tickMeta } from './meta.mjs';
import { startApi } from './api.mjs';

const LAD = process.env.LOCALAPPDATA || process.env.TEMP;
const DATA = process.env.WIN_ISLAND_HOME || join(LAD, 'win-island');
const DB = join(LAD, 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
const QUEUE = join(DATA, 'queue.jsonl');
const LOG = join(DATA, 'capture.log');
const POLL = Number(process.env.WIN_ISLAND_POLL || 700);
const KEEP = Number(process.env.WIN_ISLAND_KEEP || 120);
const MODE = process.argv.slice(2)[0] || '';

// Node 22 的 node:sqlite 还要实验开关；Node 24 不用。带着开关重启一次自己，比在启动脚本里猜版本稳。
if (!process.env.WIN_ISLAND_RELAUNCHED) {
  try { await import('node:sqlite'); }
  catch {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', process.argv[1], ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, WIN_ISLAND_RELAUNCHED: '1' },
    });
    process.exit(r.status ?? 1);
  }
}
const { DatabaseSync } = await import('node:sqlite');
mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'capture.pid'), String(process.pid));

const log = s => {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} ${s}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch {}
};

// AUMID 太啰嗦，岛上是给人看的，所以留一小撮人名映射；其余原样显示
const NAME = {
  'com.qoder.app': 'Qoder',
  'WorkBuddy.WorkBuddy': 'WorkBuddy',
  'MicrosoftWindows.Client.WebExperience_cw5n1h2txyewy!Widgets': '小组件',
};

// FILETIME（自 1601 的 100ns）；数值不像 FILETIME 就原样交出去
const filetime = v => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e16) return n > 1e12 ? n : null;
  return Math.round((n - 116444736000000000) / 10000);
};

// 载荷可能是 UTF-16LE（ASCII 字符后面跟 0x00）
const decode = b => {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  const bf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return bf.length > 8 && bf[1] === 0 && bf[3] === 0 ? bf.toString('utf16le') : bf.toString('utf8');
};
const unesc = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');
const txt = s => String(s ?? '').replace(/\s+/g, ' ').trim();
// 复制要的「原样」：换行不能像 txt() 那样压成一行，否则多行消息/代码块粘出去是坏的。
// 应用写换行有两种写法（&#10; 实体，或直接把换行放进 XML 文本节点），unesc 之后都归成 \n。
const keep = s => unesc(s).replace(/\r\n?/g, '\n').trim();

// 通知载荷是 Adaptive Toast XML。正文常在 <text> 里而不是 <title>，两种都要认。
function parse(xml) {
  const out = { title: '', body: '', lines: [], copy: '', icon: '', launch: '', activation: '', actions: [] };
  const t = /<title[^>]*>([^<]*)<\/title>/i.exec(xml);
  if (t) out.title = txt(unesc(t[1]));
  const raws = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/gi)].map(m => keep(m[1])).filter(Boolean);
  const one = raws.map(s => txt(s));
  if (!out.title && one.length) { out.title = one.shift(); raws.shift(); }
  out.body = one.join(' · ');
  // 一个 <text> 里可以有多行，这里摊平成「一行一个元素」：面板、复制、API 都按行处理，
  // 不必再猜元素内部还有换行。踩过一次 —— 整段正文当成 1 项复制出去，剪贴板里 7 个换行是 LF、
  // 只有 2 个是 CRLF，粘到记事本/微信就成一坨（2026-09-26）。行尾在这里一次定成 CRLF。
  const lines = raws.flatMap(s => s.split('\n'));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  out.lines = lines;
  out.copy = [out.title, ...lines].filter(Boolean).join('\r\n');
  if (!out.body) {
    // 有些应用不用静态 XML，而是把内容留在绑定占位符里，运行时才填
    const bind = /\{(Notification\.[^}]*)\}/i.exec(xml);
    if (bind) out.body = '(内容由应用延迟填充)';
  }
  const img = /<image[^>]*\bsrc="([^"]+)"/i.exec(xml);
  if (img) out.icon = img[1];
  // 点通知要跳到哪，全看这两个属性：launch 是协议串，activationType 决定用哪种方式打开。
  const root = /<toast([^>]*)>/i.exec(xml);
  if (root) {
    const lz = /\blaunch="([^"]*)"/i.exec(root[1]);
    if (lz) out.launch = txt(unesc(lz[1])).slice(0, 300);
    const ac = /\bactivationType="([^"]*)"/i.exec(root[1]);
    if (ac) out.activation = txt(ac[1]).toLowerCase();
  }
  for (const a of xml.matchAll(/<action[^>]*content="([^"]*)"[^>]*>/gi)) out.actions.push(txt(unesc(a[1])));
  return out;
}

const SELECT = `
  SELECT n."Id" AS Id,
         CAST(n."ArrivalTime" AS TEXT) AS At,
         n."PayloadType" AS Kind,
         n."Payload" AS Payload,
         h."PrimaryId" AS App
    FROM Notification n
    LEFT JOIN NotificationHandler h ON h."RecordId" = n."HandlerId"
   ORDER BY n."ArrivalTime" DESC
   LIMIT ?`;

function openDb() { return new DatabaseSync(DB, { readOnly: true }); }

function poll(db, since, limit) {
  // int64 直接绑进 JS 会 RangeError（超过 2^53），所以时间一律走文本再 CAST 回整数
  const rows = db.prepare(SELECT).all(limit);
  const out = [];
  for (const r of rows.reverse()) {
    const ms = filetime(r.At);
    if (since && (!ms || ms <= since)) continue;
    if (String(r.Kind || '').toLowerCase() !== 'xml') continue;
    const p = parse(decode(r.Payload));
    if (!p.title && !p.body) continue;
    out.push({
      id: String(r.Id),
      app: NAME[r.App] || txt(r.App) || '未知应用',
      appId: txt(r.App),                     // 原始 AUMID，点开的兜底要靠它
      title: p.title || (NAME[r.App] || r.App || ''),
      body: p.body,
      lines: p.lines,                   // 原样换行的正文，「复制」用
      copy: p.copy,                     // 标题+正文的完整文本（CRLF），面板和 API 共用一份
      ms,
      at: ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '',
      launch: p.launch,
      activation: p.activation,
      actions: p.actions.slice(0, 3),
    });
  }
  return out;
}

function enqueue(items) {
  if (!items.length) return;
  try {
    if (existsSync(QUEUE) && statSync(QUEUE).size > 512 * 1024) {
      const tail = readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).slice(-KEEP);
      writeFileSync(QUEUE + '.tmp', tail.join('\n') + '\n');
      renameSync(QUEUE + '.tmp', QUEUE);
    }
    appendFileSync(QUEUE, items.map(i => JSON.stringify(i)).join('\n') + '\n');
  } catch (e) { log('写队列失败 ' + e.message); }
}

// 「这条通知还在通知中心里吗」的唯一凭据。实测 Notification 表没有任何已读/已点/已清除列
// （probe-schema.mjs 看过所有表），行被删掉就是用户在系统里划掉或到期了，二者分不开，
// 所以岛屿那边只把它标成「已消失」，不当成「已处理」。
const LIVE = join(DATA, 'live.json');
let liveAt = 0;
// 写快照是 rename 覆盖，杀毒/索引器正持有 live.json 时会 EPERM（2026-09-26 实测到一次），
// 一次失败就足够让岛屿拿旧快照去对账，所以重试三次再抛。
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function writeLive(db, now) {
  if (now - liveAt < 3000) return;
  liveAt = now;
  const ids = db.prepare(`SELECT "Id" AS I FROM "Notification"`).all().map(r => String(r.I));
  const body = JSON.stringify({ at: now, n: ids.length, ids });
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(LIVE + '.tmp', body);
      renameSync(LIVE + '.tmp', LIVE);
      return;
    } catch (e) {
      if (i === 2) throw e;
      sleepSync(120);
    }
  }
}

if (!existsSync(DB)) { log('找不到通知库：' + DB); process.exit(1); }

if (MODE === '--once' || MODE === '--replay') {
  const db = openDb();
  const items = poll(db, MODE === '--replay' ? 0 : 0, 40);
  db.close();
  console.log(`抓到 ${items.length} 条：`);
  for (const i of items) console.log(`  [${i.app}] ${i.at}  ${i.title}  |  ${i.body}`);
  if (MODE === '--replay') { enqueue(items); console.log('已灌入 ' + QUEUE); }
  process.exit(0);
}

let db;
try { db = openDb(); } catch (e) { log('打不开通知库：' + e.message); process.exit(1); }
const w = db.prepare(`SELECT CAST(MAX("ArrivalTime") AS TEXT) AS W FROM Notification`).get();
let watermark = filetime(w.W) || Date.now();          // 启动前的旧通知不重放，免得开机就糊一屏历史
log(`抓取层启动 pid=${process.pid} 轮询=${POLL}ms 水位线=${new Date(watermark).toLocaleString('zh-CN', { hour12: false })}`);

const seen = new Set();
for (const it of poll(db, watermark, 200)) seen.add(it.id);

// 天气/日程自带节流（config 里的 everyMin），这里只是每 30 秒问一次「到点了没」。
// 失败不影响通知主链路，所以单独 catch 掉，也不阻塞本轮。
let metaAt = 0;
const metaTick = async () => {
  const now = Date.now();
  if (now - metaAt < 30000) return;
  metaAt = now;
  try { await tickMeta(); } catch (e) { log('天气/日程这轮没跑成：' + e.message); }
};

const tick = async () => {
  try {
    const items = poll(db, watermark, 50).filter(i => !seen.has(i.id));
    for (const i of items) {
      seen.add(i.id);
      const lag = i.ms ? Date.now() - i.ms : -1;
      log(`抓到 [${i.app}] ${i.title} | ${i.body}  入库延迟=${lag}ms`);
      if (i.ms > watermark) watermark = i.ms;
    }
    // 顺序很重要：先更新 live.json 再落队列。反过来会留一个窗口 —— 队列里已经有这条、
    // 快照里还没有，岛屿的对账就把它判成「系统侧消失」，面板里那行直接消失，人连复制的机会都没有
    // （2026-09-26 实测：id=9437 落进队列 0.7 秒后就进了 gone 名单）。
    if (items.length) liveAt = 0;           // 有新通知就别等 3 秒的节流窗口
    writeLive(db, Date.now());
    enqueue(items);
    if (seen.size > 3000) { const a = [...seen].slice(-1500); seen.clear(); a.forEach(x => seen.add(x)); }
  } catch (e) {
    // 库文件被系统重写/换页时会临时失败，重开一次连接而不是退出
    log('本轮出错：' + e.message);
    try { db.close(); } catch {}
    try { db = openDb(); } catch {}
  }
};

process.on('SIGINT', () => { try { db.close(); } catch {} process.exit(0); });
// 对外 API：常驻模式才开；--once/--replay 是一次性命令，不该占着管道
startApi({ data: DATA, log });
for (;;) { await tick(); metaTick(); await new Promise(r => setTimeout(r, POLL)); }
