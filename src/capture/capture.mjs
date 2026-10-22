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
import { execFileSync, spawnSync } from 'node:child_process';
import { tickMeta } from '../schedule/meta.mjs';
import { PIPE_NAME, startApi } from './api.mjs';
import { normalizeReplayConfig, selectReplay } from './replay.mjs';

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

const log = s => {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} ${s}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch {}
};

// 回放窗口只认 config.json 的 capture 段（island 段是给渲染层的，别混在一起）。
// 读不懂不是错误：按默认窗口跑，并在 capture.log 记一句，省得「改了配置没反应」查不到。
const CONFIG = join(DATA, 'config.json');
function readCaptureConfig() {
  try {
    if (!existsSync(CONFIG)) return {};
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
    return cfg && typeof cfg.capture === 'object' && cfg.capture ? cfg.capture : {};
  } catch (e) {
    log('config.json 读不懂，回放按默认窗口：' + e.message);
    return {};
  }
}

// 单实例保护的第一道：pid 文件。Windows 的 pid 会被复用，所以「活着」还不够，
// 必须确认那个 pid 真的是 node 进程，否则一份陈旧的 pid 文件会永远挡住启动。
// 真正的锁是第二道（命名管道独占，见下面 startApi），pid 只是让退出信息更好读、并挡住
// 「有人换了管道名却共用同一个数据目录」这种实验配置。
function liveCapturePid() {
  try {
    const pf = join(DATA, 'capture.pid');
    if (!existsSync(pf)) return null;
    const pid = Number(readFileSync(pf, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    try { process.kill(pid, 0); } catch { return null; }        // 进程不在了 = 旧 pid 文件
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    return /^"node\.exe"/i.test(out.trim()) ? pid : null;
  } catch { return null; }
}

// 队列里已经有哪些 id —— 回放幂等的判据。轮转只留最近 KEEP 条，所以更老的补录 id
// 可能已经不在文件里；岛屿那边按 id 去重兜底，不会画重复行。
function queuedIds() {
  const ids = new Set();
  try {
    if (!existsSync(QUEUE)) return ids;
    for (const ln of readFileSync(QUEUE, 'utf8').split('\n')) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln.replace(/^\uFEFF/, ''));
        if (o && o.id !== undefined && o.id !== null) ids.add(String(o.id));
      } catch {}
    }
  } catch (e) { log('读队列做回放去重失败（按空算）：' + e.message); }
  return ids;
}

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
    // 上一次写入如果被强杀，队列末尾可能留着没有换行的半行。直接 append 会把新行拼在
    // 半行后面，岛屿按「只吃完整行」会把两行一起判成坏行，新通知也跟着丢 —— 先补一个换行，
    // 让半行成为独立的一行（解析失败就跳过），新行从自己的行首开始。
    let lead = '';
    if (existsSync(QUEUE) && statSync(QUEUE).size > 0) {
      const tail = readFileSync(QUEUE);
      if (tail.length && tail[tail.length - 1] !== 0x0A) {
        lead = '\n';
        log('队列末尾缺换行，补一个（上次写入可能被中断）');
      }
    }
    appendFileSync(QUEUE, lead + items.map(i => JSON.stringify(i)).join('\n') + '\n');
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
  // 手工回放和停机回放是同一件事：旧条目一律标 backfilled，面板上才分得清「刚到的」和「翻出来的」
  if (MODE === '--replay') {
    enqueue(items.map(i => ({ ...i, backfilled: true })));
    console.log('已灌入 ' + QUEUE);
  }
  process.exit(0);
}

let db;
try { db = openDb(); } catch (e) { log('打不开通知库：' + e.message); process.exit(1); }

// 单实例保护（P1-10）：两份抓取层同时跑会 append 同一个 queue.jsonl，每条通知重复入库，
// capture.pid 也会被后启动者覆盖。这里先按 pid 文件挡一道，再靠命名管道的独占性当真正的锁：
// 第二份 listen 必然 EADDRINUSE，抢不到就以 7 退出，且不写 pid、不动队列。
//
// 为什么抢不到要重试 3 秒：restart = stop.ps1 强杀旧进程 + 立刻 launch，新进程起来时旧进程
// 可能还没放掉管道（或被 pid 文件挡着）。只试一次会让「重启」偶发失败；重试期间不刷错误日志。
const trySleep = ms => new Promise(r => setTimeout(r, ms));
let api = null;
let conflict = '';
for (let attempt = 0; attempt < 12; attempt++) {
  const otherPid = liveCapturePid();
  if (otherPid) {
    conflict = `另一份抓取层还在跑（pid=${otherPid}）`;
  } else {
    const cand = startApi({ data: DATA, log, quiet: true });
    if (await cand.ready) { api = cand; break; }
    conflict = `管道 ${PIPE_NAME} 被占用（${cand.reason || '未知原因'}）`;
  }
  if (attempt < 11) await trySleep(250);
}
if (!api) {
  log(`单实例保护：${conflict}；等了约 3 秒仍抢不到，这次不启动（不覆盖 pid、不碰队列）。退出码 7`);
  try { db.close(); } catch {}
  process.exit(7);
}

const w = db.prepare(`SELECT CAST(MAX("ArrivalTime") AS TEXT) AS W FROM Notification`).get();
let watermark = filetime(w.W) || Date.now();          // 启动前的旧通知不重放，免得开机就糊一屏历史
log(`抓取层启动 pid=${process.pid} 轮询=${POLL}ms 水位线=${new Date(watermark).toLocaleString('zh-CN', { hour12: false })}`);
// pid 只在常驻模式写，而且只在**抢到锁之后**写。--once / --replay 是排查用的一次性命令，它们也写
// pid 的话，跑一次 `capture.mjs --once` 就会把正在常驻那一层的 pid 覆盖成自己的、然后退出 ——
// 之后 status 报「抓取层没在跑」，stop.ps1 也按这个 pid 停不掉真进程（2026-10-21 审计复现）。
writeFileSync(join(DATA, 'capture.pid'), String(process.pid));

// P0-1：启动水位线取的是「库里最大的 ArrivalTime」，这就假设了抓取层没有停过。停机期间到达的
// 通知 ArrivalTime 比水位线小，会被 poll 当成历史永久跳过（2026-10-21 17:30 两条有正文的通知在
// 18:01 重启后消失）。这里在进入主循环前补一轮：最近 replayMinutes 分钟、最多 replayMax 条、
// 队列里没有的才补，全部标 backfilled=true。水位线不动，所以补过的行不会被下一轮 poll 再发一次。
const RC = normalizeReplayConfig(readCaptureConfig());
for (const msg of RC.issues) log('[capture] ' + msg);
const backlog = selectReplay(poll(db, 0, Math.min(4000, RC.max * 20 + 50)), {
  now: Date.now(), minutes: RC.minutes, max: RC.max, haveIds: queuedIds(),
});
if (backlog.length) {
  log(`回放最近 ${RC.minutes} 分钟 ${backlog.length} 条（上限 ${RC.max}，队列里已有的按 id 跳过，标 backfilled）`);
  liveAt = 0;                                  // 补录也算「有变化」，别等 live.json 的 3 秒节流
  writeLive(db, Date.now());                   // 顺序同主循环：先快照再落队列
  enqueue(backlog);
} else {
  log(`这轮没有可回放的（窗口 ${RC.minutes} 分钟 / 上限 ${RC.max} 条；任一项为 0 = 关闭）`);
}

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
// 对外 API 在上面抢锁时就已经开好了（常驻模式才走到这里；--once/--replay 是一次性命令，不占管道）
for (;;) { await tick(); metaTick(); await new Promise(r => setTimeout(r, POLL)); }
