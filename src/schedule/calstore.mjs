// calstore.mjs —— 解析出来的日程放在哪儿。
// 一台机器一个 cal.db，只在 %LOCALAPPDATA%\win-island 里（日程正文不进仓库）。
// 三条规矩：
//   1) 按「来源」整批替换：同一个文件、同一台手机再导一次，这批旧的全作废，不会越导越多。
//   2) 去重键是 (source, uid, start_ms)，同一批里撞上了算重复，不报错。
//   3) 跨来源撞 uid（手机和网页各有一份同一条）两边都留，只报冲突让人判，绝不自动合并。
// 重复规则存 rrule 原文，展开发生在读的时候——改了规则不用重新导入。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expandOccurrences } from './calparse.mjs';

const LAD = process.env.LOCALAPPDATA || process.env.TEMP;
export const DATA = process.env.WIN_ISLAND_HOME || join(LAD, 'win-island');
export const CALDB = join(DATA, 'cal.db');

const DDL = `
CREATE TABLE IF NOT EXISTS src(
  name TEXT PRIMARY KEY, fmt TEXT, enc TEXT, n INTEGER, at INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS ev(
  id INTEGER PRIMARY KEY, source TEXT, uid TEXT, nid TEXT,
  title TEXT, loc TEXT, note TEXT, categories TEXT,
  allday INTEGER, start_ms INTEGER, end_ms INTEGER, dur_ms INTEGER, tz TEXT,
  rrule TEXT, rdate TEXT, exdate TEXT, seq INTEGER, status TEXT,
  attendees TEXT, alarms TEXT, issues TEXT, excluded INTEGER DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ev ON ev(source, uid, start_ms);
CREATE INDEX IF NOT EXISTS ix_ev ON ev(start_ms);
`;

// sqlite 只收 null/number/string/bigint/bytes：布尔和 undefined 会当场抛，统一过一遍。
const v = x => (x === undefined || x === null ? null
  : typeof x === 'boolean' ? (x ? 1 : 0)
  : typeof x === 'number' ? x : String(x));
const J = x => (x === undefined || x === null ? null : JSON.stringify(x));
const uj = (s, d) => { try { const x = JSON.parse(s); return x == null ? d : x; } catch { return d; } };

let handle = null, handlePath = '';
export function getDb(p = CALDB) {
  if (handle && handlePath === p) return handle;
  mkdirSync(p === CALDB ? DATA : join(p, '..'), { recursive: true });
  handle = new DatabaseSync(p);
  handlePath = p;
  handle.exec('PRAGMA journal_mode=WAL;');
  handle.exec(DDL);
  return handle;
}
export function closeDb() { try { handle && handle.close(); } catch {} handle = null; handlePath = ''; }

export function rowToEv(r) {
  return {
    id: r.id, source: r.source, uid: r.uid, nativeId: r.nid,
    title: r.title || '', location: r.loc || '', note: r.note || '', categories: r.categories || '',
    allDay: !!r.allday, startMs: r.start_ms, endMs: r.end_ms, durMs: r.dur_ms, tz: r.tz,
    rrule: uj(r.rrule, null), rdate: r.rdate || '', exdate: r.exdate || '',
    seq: r.seq || 0, status: r.status || '',
    attendees: uj(r.attendees, []), alarms: uj(r.alarms, []), issueList: uj(r.issues, []),
    excluded: !!r.excluded,
  };
}

// events 是 calparse.parseAny() 的规范化事件数组；返回一份可核对的入账统计。
export function importBatch(events, { source = '未命名来源', fmt = '', enc = '', note = '', append = false } = {}) {
  const db = getDb();
  const out = { source, added: 0, dup: 0, noStart: 0, conflicts: [], carried: 0 };
  // 上一次在这来源里勾掉过的，这次替换后仍然勾掉——不然每次重导都要重新挑一遍。
  const prev = new Map(db.prepare('SELECT uid, start_ms, excluded FROM ev WHERE source=?').all(source)
    .map(r => [`${r.uid}|${r.start_ms}`, r.excluded]));
  if (!append) db.prepare('DELETE FROM ev WHERE source=?').run(source);
  const ins = db.prepare(`INSERT INTO ev(source,uid,nid,title,loc,note,categories,allday,start_ms,end_ms,dur_ms,tz,
    rrule,rdate,exdate,seq,status,attendees,alarms,issues,excluded)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const cross = db.prepare('SELECT source FROM ev WHERE uid=? AND start_ms=? AND source<>?');
  const seen = new Set();
  for (const ev of events) {
    // 没有开始时刻的不入库：库里按 start_ms 排，「读不懂时间」和「重复导入」得是两回事。
    if (ev.startMs == null) { out.noStart++; continue; }
    const uid = String(ev.uid || ev.nativeId || `t:${ev.title || ''}:${ev.startMs}`);
    const key = `${uid}|${ev.startMs}`;
    if (seen.has(key)) { out.dup++; continue; }
    seen.add(key);
    const others = cross.all(uid, ev.startMs, source).map(r => r.source);
    if (others.length) out.conflicts.push({ uid, startMs: ev.startMs, title: ev.title || '', alsoIn: others });
    const excluded = prev.get(key) ? 1 : 0;
    if (excluded) out.carried++;
    ins.run(source, uid, v(ev.nativeId), v(ev.title), v(ev.location), v(ev.note), v(ev.categories),
      v(ev.allDay), v(ev.startMs), v(ev.endMs), v(ev.durMs), v(ev.tz),
      J(ev.rrule), v(ev.rdate), v(ev.exdate), v(ev.seq || 0), v(ev.status),
      J(ev.attendees || []), J(ev.alarms || []), J(ev.issueList || ev.issues || []), v(excluded));
    out.added++;
  }
  db.prepare('INSERT OR REPLACE INTO src(name,fmt,enc,n,at,note) VALUES(?,?,?,?,?,?)')
    .run(source, v(fmt), v(enc), out.added, Date.now(), v(note));
  return out;
}

export function listRows({ source = '', limit = 0, from = 0 } = {}) {
  const db = getDb();
  const q = ['SELECT * FROM ev'];
  const p = [];
  const wh = [];
  if (source) { wh.push('source=?'); p.push(source); }
  if (from) { wh.push('start_ms>=?'); p.push(from); }
  if (wh.length) q.push('WHERE ' + wh.join(' AND '));
  q.push('ORDER BY start_ms');
  if (limit) q.push('LIMIT ' + Math.max(1, Math.floor(limit)));
  return db.prepare(q.join(' ')).all(...p).map(rowToEv);
}

export function sourcesList() {
  return getDb().prepare('SELECT * FROM src ORDER BY at DESC').all();
}

export function setExcluded(ids, flag) {
  if (!ids || !ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  return getDb().prepare(`UPDATE ev SET excluded=? WHERE id IN (${ph})`).run(v(!!flag), ...ids.map(Number)).changes;
}

export function dropSource(name) {
  const db = getDb();
  const n = db.prepare('DELETE FROM ev WHERE source=?').run(name).changes;
  db.prepare('DELETE FROM src WHERE name=?').run(name);
  return n;
}

const hhmm = t => { const d = new Date(t); const p = x => String(x).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; };

// 给岛屿用的那段：把库里这窗口内真的会发生的时刻展开成条目（含重复事件的每一次）。
// 输出形状和 meta.mjs 原来的 items 一致，所以 agenda.json 的契约没变。
export function itemsFor(fromMs, toMs) {
  const out = [];
  for (const r of listRows({ from: 0 })) {
    if (r.excluded || r.startMs == null || r.startMs >= toMs) continue;
    const ev = { ...r };
    const dur = ev.durMs || (ev.allDay ? 864e5 - 1 : 36e5);
    for (const t of expandOccurrences(ev, fromMs, toMs)) {
      if (t + (ev.allDay ? 0 : dur) < fromMs && t < fromMs) continue;
      out.push({
        s: t, e: ev.allDay ? t : t + dur, st: hhmm(t), et: ev.allDay ? '' : hhmm(t + dur),
        day: new Date(t).getDate(), title: ev.title || '（无标题）', where: ev.location || '',
        allDay: ev.allDay, src: ev.source,
      });
    }
  }
  return out;
}

export function stats() {
  const db = getDb();
  const n = db.prepare('SELECT COUNT(*) c FROM ev').get().c;
  const ex = db.prepare('SELECT COUNT(*) c FROM ev WHERE excluded=1').get().c;
  const s = db.prepare('SELECT COUNT(*) c FROM src').get().c;
  return { rows: n, excluded: ex, sources: s, path: handlePath || CALDB };
}
