#!/usr/bin/env node
// 日程导入的解析层：把各种来源的日程数据统一成一种「规范化事件」。
//
// 设计约束（都是踩出来的）：
// 1. 纯函数、不碰网络不碰磁盘 —— 这样每一类来源都能离线拿 fixture 验收。
// 2. 解析失败不静默丢：每条问题都带「位置 + 原因 + 建议修正」，交给预览页让人勾选/改。
//    静默跳过会让用户以为「导入成功但少了几条」，那种数最难查。
// 3. 时间一律产出两个东西：startMs（按本机时区解释的绝对时刻，岛屿那边直接用）
//    和 wall/tz（原始墙上时间与时区名，去重和显示要靠它）。绝对时刻来源（Android
//    provider 的 epoch 毫秒）不需要猜时区，是最可信的一类。

// ---------- 编码 ----------
// 每条都是四元组 [b0,b1,b2,name]。原来 UTF-16 那两项只写了三个元素，解构出来 name=undefined，
// 命中 BOM 反而当场 TypeError —— 带 BOM 的 UTF-16 文件一份都读不进来。
const BOMS = [
  [0xEF, 0xBB, 0xBF, 'utf-8-bom'],
  [0xFF, 0xFE, null, 'utf-16le-bom'],
  [0xFE, 0xFF, null, 'utf-16be-bom'],
];

export function decodeBytes(buf) {
  for (const [b0, b1, b2, name] of BOMS) {
    if (buf[0] !== b0 || buf[1] !== b1) continue;
    if (b2 != null && buf[2] !== b2) continue;
    const body = buf.subarray(name === 'utf-8-bom' ? 3 : 2);
    const enc = name === 'utf-8-bom' ? 'utf-8' : (name.endsWith('be-bom') ? 'utf-16be' : 'utf-16le');
    return { text: tryDecodeLoose(body, enc) || '', enc: name, bom: true };
  }
  // 无 BOM：先严格试 UTF-8（fatal），失败才试 GBK，再退 UTF-16 启发式，最后 latin1 兜底。
  // 关键是用「严格失败」当判据：原来 tryDecode 在 fatal 抛错后又宽松解一遍，
  // 于是 UTF-8 永远“成功”（带一堆 U+FFFD），GBK 那一支根本走不到 —— 中文 CSV 整列全空。
  const asUtf8 = tryDecodeStrict(buf, 'utf-8');
  if (asUtf8 != null) return { text: stripZwsp(asUtf8), enc: 'utf-8', bom: false };
  const asGbk = tryDecodeLoose(buf, 'gbk');
  if (asGbk != null && !hasReplacement(asGbk)) return { text: asGbk, enc: 'gbk', bom: false };
  if (isUtf16(buf)) {
    const be = buf[0] === 0 && buf[1] !== 0;
    return { text: tryDecodeLoose(buf, be ? 'utf-16be' : 'utf-16le') || '', enc: be ? 'utf-16be' : 'utf-16le', bom: false };
  }
  return { text: tryDecodeLoose(buf, 'latin1') || '', enc: 'latin1-guessed', bom: false };
}
function tryDecodeStrict(buf, enc) {
  try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch { return null; }
}
function tryDecodeLoose(buf, enc) {
  try { return new TextDecoder(enc).decode(buf); } catch { return null; }
}
const hasReplacement = s => s.includes('\uFFFD');
const stripZwsp = s => s.replace(/^\uFEFF/, '');
function isUtf16(buf) {
  let zeros = 0, n = 0;
  for (let i = 1; i < Math.min(buf.length, 400); i += 2) { n++; if (buf[i] === 0) zeros++; }
  return n > 4 && zeros / n > 0.6;
}

// ---------- 格式嗅探 ----------
export function sniff(buf, hintName = '') {
  const { text, enc } = decodeBytes(buf);
  const head = text.slice(0, 4000);
  const t = head.replace(/^\s+/, '');
  let fmt = null, note = '';
  if (/^BEGIN:VCALENDAR/i.test(t)) fmt = 'ics';
  else if (/^\{/.test(t) && /"events"\s*:/i.test(t)) fmt = 'json:calendar';
  else if (/^[[{]/.test(t)) fmt = 'json';
  else if (/^\s*Row:\s*\d+\s+\S+=/im.test(t) || (/_id=/.test(t) && /\bdtstart=/i.test(t))) fmt = 'adb';
  // ↑ 原来只认「整行被 {} 包住」的形态，而 `content query` 实际输出是
  //   "Row: 0 _id=1, calendar_id=1, ..."，没有大括号 -> 一路掉到 csv 分支，
  //   手机数据会被当成 CSV 切出一堆垃圾行，比报错更难发现。
  else if (/(^|\n)\s*(BEGIN:VEVENT)/i.test(head)) fmt = 'ics';
  else if (countSep(t.split('\n')[0] || '') >= 1 && !/^\s*$/.test(t.split('\n')[0])) fmt = 'csv';
  if (!fmt && /\.(ics|ifb)$/i.test(hintName)) fmt = 'ics';
  if (!fmt && /\.csv$/i.test(hintName)) fmt = 'csv';
  if (!fmt && /\.json$/i.test(hintName)) fmt = 'json';
  return { text, enc, fmt, note, head: t.slice(0, 200) };
}
const countSep = line => [',', ';', '\t'].map(c => line.split(c).length - 1).sort((a, b) => b - a)[0];

// ---------- 公共时间工具 ----------
const pad = (s, n = 2) => String(s).padStart(n, '0');
export const wallToMs = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

// 本机 IANA 时区名。展开重复事件时要先确定「按哪个时区的墙钟逐日推进」，
// 用 Intl 拿名字、再用 msFromWallInTz 换算，才不用自己维护偏移和夏令时。
export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || null;
const pad2 = n => String(n).padStart(2, '0');

// 时区名 -> 该时区下「此刻」的墙钟字段。用 Intl 而不是手算偏移，才不用维护 DST 表。
export function wallInTz(ms, tz) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
    return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second || 0 };
  } catch { return null; }
}
// 某个时区下的墙钟 -> 绝对时刻（二分/迭代求不动点，避开 DST 表）
export function msFromWallInTz(w, tz) {
  const guess = wallToMs(w.y, w.mo, w.d, w.h, w.mi, w.s);
  if (!tz || /local|floating/i.test(tz)) return guess;
  let lo = guess - 26 * 36e5, hi = guess + 26 * 36e5, best = guess;
  const key = x => `${x.y}-${x.mo}-${x.d} ${x.h}:${x.mi}`;
  for (let i = 0; i < 6 && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const w2 = wallInTz(mid, tz);
    if (!w2) return guess;
    const a = `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}`;
    const b = `${w2.y}-${pad(w2.mo)}-${pad(w2.d)} ${pad(w2.h)}:${pad(w2.mi)}`;
    best = mid;
    if (b === a) break;
    if (b < a) lo = mid + 1; else hi = mid - 1;
  }
  return best;
}
const TZ_ALIAS = {
  '中国标准时间': 'Asia/Shanghai', '中国大陆标准时间': 'Asia/Shanghai', '(UTC+08:00) 北京': 'Asia/Shanghai',
  '北京, 重庆, 香港, 乌鲁木齐': 'Asia/Shanghai', '台北, 吉隆坡, 新加坡': 'Asia/Singapore',
  '香港时间': 'Asia/Hong_Kong', '东京': 'Asia/Tokyo', '伦敦': 'Europe/London', '东部时间(美国与加拿大)': 'America/New_York',
  'UTC': 'UTC', 'GMT': 'UTC', 'Z': 'UTC',
};
export function normTz(name) {
  if (!name) return null;
  const s = String(name).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (TZ_ALIAS[s]) return TZ_ALIAS[s];
  for (const k of Object.keys(TZ_ALIAS)) if (s.includes(k)) return TZ_ALIAS[k];
  if (/^[A-Za-z]+\/[A-Za-z_\-/]+$/.test(s)) return s;
  const m = /^UTC([+-])(\d{1,2})(:?(\d{2}))?$/.exec(s);
  if (m) return `Etc/GMT${m[1] === '+' ? '-' : '+'}${m[2]}`;   // Etc 区符号是反的
  return null;
}

// ---------- iCalendar ----------
function unfold(text) {
  return String(text).replace(/\r\n[ \t]/g, '').replace(/\r[ \t]/g, '').replace(/\r/g, '').split('\n');
}
function unesc(s) {
  // \n / \N 是正文里的换行（RFC 5545），不是空白：原来压成空格再 \s+ 归一，
  // 多行备注就糊成一行 —— 和通知那边踩过的同一个坑。所以只归一水平空白，换行留着。
  return String(s).replace(/\\\\/g, '\u0000')
    .replace(/\\[nN]/g, '\n')
    .replace(/\\[;,]/g, m => m[1])
    .replace(/\u0000/g, '\\')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}
// 参数切分要认引号：SUMMARY;X-PROP="a;b":...  这种分号在引号里不能切
function splitParams(s) {
  const out = []; let cur = '', q = false;
  for (const ch of s) {
    if (ch === '"') { q = !q; cur += ch; continue; }
    if (ch === ';' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function prop(line) {
  let i = line.indexOf(':'), q = false, from = 0;
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '"') q = !q;
    if (line[k] === ':' && !q) { i = k; break; }
  }
  if (i < 0) return null;
  const parts = splitParams(line.slice(0, i));
  const name = parts[0].trim().toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const [k, ...v] = p.split('=');
    if (k && v.length) params[k.trim().toUpperCase()] = v.join('=').trim().replace(/^"|"$/g, '');
  }
  return { name, params, value: line.slice(i + 1).trim() };
}
const ICS_DT = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;
function icsDT(value, params) {
  const m = ICS_DT.exec(String(value).trim());
  if (!m) return null;
  const w = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  const allDay = !m[4];
  if (m[7] === 'Z') return { ...w, allDay, tz: 'UTC', abs: true };
  const tz = normTz(params?.TZID) || normTz(params?.TZ) || null;
  return { ...w, allDay, tz, abs: false };
}
export function icsToMs(dt) {
  // 带 Z 的是 UTC 墙钟，必须用 Date.UTC 构造。原来走 wallToMs = new Date(y,mo,d,...)，
  // 那是「本机时区的墙钟」—— 在本机 UTC+8 上每条 Z 时间都早 8 小时，
  // 而且换台机器结果还不一样（这种随机器变的错最难查）。
  if (dt.abs) return Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi, dt.s);
  return msFromWallInTz(dt, dt.tz);
}
function icsDur(v) {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * 864e5 + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1000;
  return m[1] ? -ms : ms;
}
const ALARM_METHOD = { DISPLAY: '弹窗', AUDIO: '声音', EMAIL: '邮件', PROCEDURE: '流程' };

export function parseIcs(text, source = 'ics') {
  const events = [], issues = [];
  let line, cur = null, alarms = null, vtz = 0, idx = 0, inAlarm = false;
  const feed = raw => {
    line = raw.trim();
    if (!line) return;
    if (/^BEGIN:VTIMEZONE$/i.test(line)) { vtz++; return; }
    if (/^END:VTIMEZONE$/i.test(line)) { vtz = Math.max(0, vtz - 1); return; }
    if (vtz) return;                                     // 时区定义块整个跳过
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = {}; alarms = []; idx++; return; }
    if (/^END:VEVENT$/i.test(line)) { if (cur) events.push(finish(cur, alarms, source, idx, issues)); cur = null; alarms = null; return; }
    if (/^BEGIN:VALARM$/i.test(line)) { inAlarm = true; if (alarms) alarms.push({}); return; }
    if (/^END:VALARM$/i.test(line)) { inAlarm = false; return; }
    if (!cur) return;
    const p = prop(line);
    if (!p) return;
    if (inAlarm) {
      const a = alarms[alarms.length - 1]; if (!a) return;
      if (p.name === 'TRIGGER') a.trigger = p.value, a.triggerDur = icsDur(p.value), a.related = (p.params.RELATED || 'START').toUpperCase();
      if (p.name === 'ACTION') a.action = p.value.toUpperCase();
      if (p.name === 'DESCRIPTION') a.desc = unesc(p.value);
      return;
    }
    if (p.name === 'ATTENDEE') { (cur._att ||= []).push((p.params.CN ? unesc(p.params.CN) : '') + (p.value.startsWith('mailto:') ? p.value.slice(7) : p.value)); return; }
    cur[p.name] = { value: p.value, params: p.params };
  };
  const lines = unfold(text);
  for (const raw of lines) feed(raw);
  if (!lines.some(l => /^BEGIN:VEVENT$/i.test(l.trim())))
    issues.push({ where: source, code: idx ? 'no-vevent' : 'empty',
      msg: idx ? '有 BEGIN:VEVENT 但一条都没闭合' : '文件里一个 VEVENT 都没有（空文件、或者根本不是日历文件）' });
  if (cur) issues.push({ where: `${source} > 文件结尾`, code: 'unclosed-vevent', msg: 'VEVENT 没有 END:VEVENT 就遇到文件结尾，最后一条按已解析字段处理' });
  return { events, issues };
}

function finish(cur, alarms, source, idx, issues) {
  const where = uid => `${source} > VEVENT#${idx}${uid ? ` (UID=${uid})` : ''}`;
  const uid = cur.UID ? cur.UID.value.trim() : '';
  const st = cur.DTSTART ? icsDT(cur.DTSTART.value, cur.DTSTART.params) : null;
  const ev = {
    source, uid, nativeId: uid,
    title: cur.SUMMARY ? unesc(cur.SUMMARY.value) : '',
    location: cur.LOCATION ? unesc(cur.LOCATION.value) : '',
    note: cur.DESCRIPTION ? unesc(cur.DESCRIPTION.value) : '',
    categories: cur.CATEGORIES ? unesc(cur.CATEGORIES.value) : '',
    attendees: (cur._att || []).slice(0, 20),
    alarms: (alarms || []).filter(a => a.trigger).map(a => ({
      beforeMin: a.triggerDur != null ? Math.round(Math.abs(a.triggerDur) / 6e4) : null,
      method: ALARM_METHOD[a.action] || a.action || '提醒', at: a.triggerDur == null ? a.trigger : null,
    })),
    rrule: cur.RRULE ? rruleOf(cur.RRULE.value) : null,
    rdate: cur.RDATE ? cur.RDATE.value : '', exdate: cur.EXDATE ? cur.EXDATE.value : '',
    seq: cur.SEQUENCE ? +cur.SEQUENCE.value || 0 : 0,
    status: cur.STATUS ? cur.STATUS.value.toUpperCase() : '',
    raw: { dtstart: cur.DTSTART?.value || '', dtend: cur.DTEND?.value || '', dur: cur.DURATION?.value || '' },
    issues: [],
  };
  const iss = ev.issues;
  if (!st) {
    iss.push({ code: 'no-start', msg: '没有可解析的 DTSTART', where: where(uid) });
    return ev;
  }
  ev.allDay = !!st.allDay;
  ev.tz = st.tz || (st.abs ? 'UTC' : null);
  ev.startMs = icsToMs(st);
  let endMs = null;
  if (cur.DTEND) { const e = icsDT(cur.DTEND.value, cur.DTEND.params); if (e) endMs = icsToMs(e); }
  else if (cur.DURATION) { const d = icsDur(cur.DURATION.value); if (d != null) endMs = ev.startMs + d; }
  if (endMs == null) endMs = ev.allDay ? ev.startMs + 864e5 - 1 : ev.startMs;
  if (ev.allDay && endMs > ev.startMs) endMs = endMs - 1;               // ics 全天 DTEND 是排他的次日零点
  if (endMs < ev.startMs) {
    iss.push({ code: 'end-before-start', msg: `结束(${new Date(endMs).toLocaleString('zh-CN')})早于开始，按开始+60 分钟纠正`, where: where(uid) });
    endMs = ev.startMs + 36e5;
  }
  ev.endMs = endMs;
  ev.durMs = endMs - ev.startMs;
  if (!ev.title) iss.push({ code: 'no-title', msg: '没有 SUMMARY，显示为「（无标题）」', where: where(uid) });
  // 全天事件本来就没有「时刻」，报一句「按本机时区解释」只是噪音
  if (!st.abs && !st.tz && !st.allDay) iss.push({ code: 'tz-assumed', msg: 'DTSTART 没带时区，按本机时区解释', where: where(uid) });
  if (ev.rrule && ev.rrule._unsupported.length) {
    iss.push({ code: 'rrule-unsupported', msg: `重复规则里的 ${ev.rrule._unsupported.join('/')} 不支持，展开结果可能偏少`, where: where(uid) });
  }
  if (cur['RECURRENCE-ID']) iss.push({ code: 'recurrence-override', msg: '这条是「单条改期」实例，暂不按覆盖处理', where: where(uid) });
  return ev;
}
function rruleOf(v) {
  const o = {};
  for (const part of String(v).split(';')) {
    const [k, ...r] = part.split('=');
    if (k && r.length) o[k.toUpperCase()] = r.join('=');
  }
  o._unsupported = ['BYSETPOS', 'BYYEARDAY', 'BYWEEKNO', 'WKST'].filter(x => o[x]);
  return o;
}

// ---------- 重复展开 ----------
// 规范化事件 -> 「一段时间窗里真正会发生的每一件事」的起始时刻列表。
// 没有这一步，岛上「今天」这一段就是空的 —— 课表、周会全是重复事件，占真实日程的大头。
// 三条刻意为之的规则：
// 1. 按墙钟逐日推进再用 ev.tz 换算成绝对时刻，才不会被夏令时/跨月坑到（直接加 k*864e5
//    在 DST 切换那天会整体漂一小时）。
// 2. 窗口是 [fromMs, toMs)，含头不含尾，和调用方按天切片的口径一致。
// 3. COUNT 从 DTSTART 那天开始数（含 DTSTART），UNTIL 是绝对时刻上限；EXDATE 扣掉、RDATE 补上。
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function icsDateList(v, tz) {
  const out = new Set();
  for (const part of String(v || '').split(',')) {
    const dt = icsDT(part.trim(), { TZID: tz || '' });
    if (dt) out.add(icsToMs(dt));
  }
  return out;
}

export function expandOccurrences(ev, fromMs, toMs, cap = 500) {
  if (ev == null || ev.startMs == null) return [];
  const inWin = t => t >= fromMs && t < toMs;
  const r = ev.rrule || {};
  const freq = String(r.FREQ || '').toUpperCase();

  if (!freq) {                                    // 不重复：RDATE 也要单独算（有人用它列举几次）
    const one = [ev.startMs].filter(inWin);
    const extra = [...icsDateList(ev.rdate, ev.tz)].filter(inWin).sort((a, b) => a - b);
    return [...new Set([...one, ...extra])];
  }

  const step = Math.max(1, +r.INTERVAL || 1);
  const count = r.COUNT ? Math.max(0, +r.COUNT) : 0;
  const until = r.UNTIL ? icsToMs(icsDT(String(r.UNTIL).replace(/-Z$/, 'Z'), { TZID: ev.tz || '' })) : Infinity;
  const ex = icsDateList(ev.exdate, ev.tz);
  const byDayRaw = String(r.BYDAY || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const byDay = byDayRaw.map(s => s.replace(/^[+-]?\d+/, '')).filter(d => WD.includes(d));
  const ordinalDay = new Map();                   // MONTHLY 的「第 2 个周一」= 2MO
  for (const s of byDayRaw) { const m = /^([+-]?\d+)([A-Z]{2})$/.exec(s); if (m) ordinalDay.set(m[2], +m[1]); }
  const base = wallInTz(ev.startMs, ev.tz || localTz());
  const baseDay = new Date(base.y, base.mo - 1, base.d);
  const dom = r.BYMONTHDAY ? Math.abs(+String(r.BYMONTHDAY).split(',')[0]) : base.d;
  const out = [];
  let seen = 0;                                   // 已经发生过的次数（用来执行 COUNT），与是否在窗口内无关

  for (let k = 0; k <= 4000; k++) {               // 4000 天 ≈ 11 年，比任何合理窗口都长
    const cand = new Date(baseDay.getFullYear(), baseDay.getMonth(), baseDay.getDate() + k);
    if (cand.getTime() > toMs) break;             // 只关心窗口内，窗口外再多的重复也不看
    const dayDiff = Math.round((cand - baseDay) / 864e5);
    if (dayDiff < 0) continue;
    const months = (cand.getFullYear() - baseDay.getFullYear()) * 12 + (cand.getMonth() - baseDay.getMonth());
    const lastDom = new Date(cand.getFullYear(), cand.getMonth() + 1, 0).getDate();
    let hit = false;
    if (freq === 'DAILY') hit = dayDiff % step === 0;
    else if (freq === 'WEEKLY') {
      const week = Math.floor((dayDiff + ((baseDay.getDay() + 6) % 7)) / 7);
      hit = week % step === 0 && (byDay.length ? byDay.includes(WD[cand.getDay()]) : cand.getDay() === baseDay.getDay());
    } else if (freq === 'MONTHLY') {
      if (byDay.length) {
        const wd = WD[cand.getDay()];
        if (!byDay.includes(wd)) hit = false;
        else {
          const ord = ordinalDay.get(wd);         // 2MO = 当月第 2 个周一；-1FR = 最后一个周五
          if (ord == null) hit = months % step === 0;
          else if (ord > 0) hit = months % step === 0 && Math.ceil(cand.getDate() / 7) === ord;
          else hit = months % step === 0 && Math.ceil((lastDom - cand.getDate() + 1) / 7) === -ord;
        }
      } else hit = months % step === 0 && cand.getDate() === Math.min(dom, lastDom);   // 31 号在小月顺延到最后一天
    } else if (freq === 'YEARLY') {
      const years = cand.getFullYear() - baseDay.getFullYear();
      hit = years % step === 0 && cand.getMonth() === baseDay.getMonth() && cand.getDate() === baseDay.getDate();
    } else hit = dayDiff === 0;
    if (!hit) continue;

    const wall = { ...base, y: cand.getFullYear(), mo: cand.getMonth() + 1, d: cand.getDate() };
    const t = msFromWallInTz(wall, ev.tz || null);
    if (t > until) break;
    seen++;
    if (ex.has(t) || ex.has(msFromWallInTz(wall, null))) continue;   // EXDATE 可能写本地日也可能写 tz 日
    if (inWin(t)) { out.push(t); if (out.length >= cap) break; }
    if (count && seen >= count) break;
  }
  for (const t of icsDateList(ev.rdate, ev.tz)) if (inWin(t)) out.push(t);
  return [...new Set(out)].sort((a, b) => a - b);
}

// ---------- CSV ----------
const COLS = {
  title: ['subject', 'summary', 'title', 'all day subject', '主题', '标题', '日程名称', '事件标题', '事项'],
  start: ['start date', 'start time', 'dtstart', 'start', 'start datetime', '开始时间', '开始日期', '起始时间'],
  end: ['end date', 'end time', 'dtend', 'end', 'end datetime', '结束时间', '结束日期', '截止时间'],
  allDay: ['all day event', 'all day', 'allday', '全天', '是否全天'],
  rrule: ['repeat details', 'recurrence', 'rrule', 'repeat', '重复', '重复规则'],
  alarm: ['reminder', 'alarm', 'reminders', '提醒', '闹钟', '提醒时间'],
  tz: ['time zone', 'timezone', 'event timezone', '时区', '开始时区'],
  location: ['location', 'event location', 'place', '地点', '位置', '场所'],
  note: ['description', 'details', 'note', 'notes', '备注', '说明', '详情', '内容'],
  attendee: ['attendees', 'attendee', 'participants', '参与人', '参与者', '参加人'],
  categories: ['categories', 'category', 'labels', 'label', '分类', '标签', '群组'],
  uid: ['uid', 'id', '_id', 'guid', '编号', '标识'],
};
const CN_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function splitCsvLine(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
      continue;
    }
    if (c === '"') { q = true; continue; }
    if (c === sep) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
function sniffSep(headerLine) {
  const cand = [',', ';', '\t'].map(c => ({ c, n: splitCsvLine(headerLine, c).length }));
  cand.sort((a, b) => b.n - a.n);
  return cand[0].n > 1 ? cand[0].c : ',';
}
// 模糊列名匹配：完全等值 -> 前缀 -> 编辑距离。匹配不上的列要报出来，不能静默丢列。
function near(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 0;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - dp[m][n] / Math.max(m, n);
}
function mapCols(header) {
  const map = {}, used = new Set(), unmatched = [];
  const h = header.map(x => String(x).toLowerCase().replace(/^\ufeff/, '').trim());
  for (const [key, names] of Object.entries(COLS)) {
    let best = -1, score = 0;
    h.forEach((c, i) => {
      if (used.has(i) || !c) return;
      let s = names.includes(c) ? 1 : names.some(n => c.includes(n) || n.includes(c)) ? 0.9 : Math.max(...names.map(n => near(c, n)));
      if (s > score) { score = s; best = i; }
    });
    if (best >= 0 && score >= 0.75) { map[key] = best; used.add(best); }
  }
  h.forEach((c, i) => { if (c && !used.has(i)) unmatched.push(c); });
  return { map, unmatched, score: used.size };
}
// 中文/各家导出的日期时间：一次调用尽量把「日期列 + 时间列」合成一个绝对时刻
export function parseDateTime(str, timeStr, tzName, ymdHint) {
  const s = `${String(str || '').trim()} ${String(timeStr || '').trim()}`.trim();
  if (!s || /^(|0|false|no|否|无)$/.test(s)) return null;
  // ISO 8601 单独一条快路：带 Z 或 ±hh:mm 的是绝对时刻，必须直接算，不能退到「本机墙钟」——
  // Google Calendar API 的 start.dateTime 就是这种，之前整列读成 null。
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(s);
  if (iso) {
    const tz = normTz(tzName);
    if (!iso[4]) {                                // 只有日期 = 全天
      const w = { y: +iso[1], mo: +iso[2], d: +iso[3], h: 0, mi: 0, s: 0 };
      return { startMs: msFromWallInTz(w, tz), allDay: true, tz: tz || null, wall: w };
    }
    const w = { y: +iso[1], mo: +iso[2], d: +iso[3], h: +iso[4], mi: +iso[5], s: +(iso[6] || 0) };
    if (iso[7]) {
      const abs = Date.parse(`${w.y}-${pad2(w.mo)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}:${pad2(w.s)}${String(iso[7]).toUpperCase()}`);
      return { startMs: Number.isFinite(abs) ? abs : null, allDay: false,
               tz: /^Z$/i.test(iso[7]) ? 'UTC' : `GMT${iso[7]}`, wall: w };
    }
    return { startMs: msFromWallInTz(w, tz), allDay: false, tz: tz || null, wall: w };
  }
  // 日期后面可能夹着「下午/上午」这类中文上下午标记，正则要容得下它
  let m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[ T]+(?:凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?)?)?$/i.exec(s);
  let y, mo, d, h, mi, sec = 0;
  if (m) { [y, mo, d, h, mi, sec] = [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)]; }
  else {
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[ T]+(?:凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*([ap])\.?m\.?)?$/i.exec(s);
    if (!m) return null;
    y = +m[3]; if (y < 100) y += 2000;
    const a = +m[1], b = +m[2];
    if (a > 12) { mo = b; d = a; } else { mo = a; d = b; }            // 美式 M/D 优先，日期>12 时按 D/M
    h = +(m[4] || 0); mi = +(m[5] || 0); sec = +(m[6] || 0);
  }
  // AM/PM 两条分支都要生效：Google 导出的 CSV 写「9:00 PM」，之前只在美式那支里换算，
  // 走日期分支的那条会把 21:00 记成 09:00。
  if (/p/i.test(m[7] || '') && h < 12) h += 12;
  if (/a/i.test(m[7] || '') && h === 12) h = 0;
  // 「下午 2:00」这种中文上下午
  if (/[上下]午/.test(s) && !m[7]) { if (/下午/.test(s) && h < 12) h += 12; if (/上午/.test(s) && h === 12) h = 0; }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const tz = normTz(tzName);
  const w = { y, mo, d, h, mi, s: sec };
  return { startMs: msFromWallInTz(w, tz), allDay: !(/\d/.test(String(timeStr || '')) || /[:T]/.test(String(str || ''))), tz: tz || null, wall: w };
}
function cnRepeat(v) {
  const s = String(v || '').trim();
  if (!s || /^(每天|每日)$/.test(s)) return s ? 'FREQ=DAILY' : null;
  // 「每周 周一」「每星期周一」这种中间有空格、周字重复的写法在 vivo 导出的表里常见
  if (/每周\s*周?[一二三四五六日]/.test(s) || /每\s*星期\s*[一二三四五六日]/.test(s)) {
    const days = [...s.matchAll(/(?:周|星期)\s*([一二三四五六日])/g)].map(m => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][CN_WEEK.indexOf('周' + m[1])]);
    return `FREQ=WEEKLY;BYDAY=${[...new Set(days)].join(',')}`;
  }
  if (/每月/.test(s)) return 'FREQ=MONTHLY';
  if (/每年/.test(s)) return 'FREQ=YEARLY';
  if (/工作日|周一至周五|周一到周五/.test(s)) return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if (/每周|每\s*星期|一\s*周一次/.test(s)) return 'FREQ=WEEKLY';
  if (/^FREQ=/i.test(s)) return s.toUpperCase();
  // 英文导出（Google Calendar 的 Repeat Details 写「Weekly on Monday」这种）
  const en = s.toLowerCase();
  const days = [...new Set(Object.entries(EN_DAY).filter(([w]) => new RegExp(`\\b${w}s?\\b`).test(en)).map(([, v]) => v))];
  if (/everyday|\bdaily\b/.test(en)) return 'FREQ=DAILY';
  if (/\bweekly\b/.test(en)) return `FREQ=WEEKLY${days.length ? `;BYDAY=${days.join(',')}` : ''}`;
  if (/\bmonthly\b/.test(en)) return 'FREQ=MONTHLY';
  if (/every year|\byearly\b|annually/.test(en)) return 'FREQ=YEARLY';
  if (/every weekday|weekdays/.test(en)) return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if (days.length) return `FREQ=WEEKLY;BYDAY=${days.join(',')}`;   // 只写了「Monday, Wednesday」
  return null;
}
function cnAlarm(v) {
  const s = String(v || '');
  let m = /提前\s*(\d+)\s*(分钟|小时|天|min|h|d)/i.exec(s);
  // 之前拿「单位」那组去取数字，中文单位里没有数字，结果永远算出 0 分钟。
  if (m) return [{ beforeMin: +m[1] * (/天|d/i.test(m[2]) ? 1440 : /小时|h/i.test(m[2]) ? 60 : 1), method: '弹窗' }];
  m = /(\d+)\s*(分钟|小时|天|min|minute|minutes|sec|秒|hour|hours|hr|h|day|days|d)\b/i.exec(s);
  if (m) {
    const u = m[2].toLowerCase();
    const mult = /^(天|day|d)/.test(u) ? 1440 : /^(小时|hour|hr|h)/.test(u) ? 60 : 1;
    return [{ beforeMin: +m[1] * mult, method: '弹窗' }];   // Google 导出写「30 minutes ahead」
  }
  if (/提醒|闹钟|alarm|remind/i.test(s)) return [{ beforeMin: 15, method: '弹窗' }];
  return [];
}
const EN_DAY = { sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA' };

export function parseCsv(text, source = 'csv') {
  const issues = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return { events: [], issues: [{ where: source, code: 'empty', msg: '文件里没有内容行' }] };
  const sep = sniffSep(lines[0]);
  const header = splitCsvLine(lines[0], sep);
  const { map, unmatched } = mapCols(header);
  if (!('start' in map)) issues.push({ where: `${source} > 表头`, code: 'no-start-column', msg: `找不到开始时间列（表头：${header.join(' | ').slice(0, 120)}）` });
  if (!('title' in map)) issues.push({ where: `${source} > 表头`, code: 'no-title-column', msg: '找不到标题列，导入后会显示成「（无标题）」' });
  if (unmatched.length) issues.push({ where: `${source} > 表头`, code: 'column-unmapped', msg: `这些列没认出来，会被忽略：${unmatched.join('、')}` });
  const events = [];
  // 「Start Date / Start Time」分两列（Google 导出的样子）：只吃 Date 那一列的话，
  // 每条事件都会落到 00:00，岛上的日程时间全错但不会报错 —— 所以要把配对的「时间列」找出来。
  const usedCols = new Set(Object.values(map));
  const timeColFor = side => {
    const words = side === 'start' ? ['start', '开始'] : ['end', '结束'];
    return header.findIndex((c, i) => {
      if (usedCols.has(i)) return false;
      const h = String(c).toLowerCase();
      // 「Start Time」按 side 配对；只有一个孤零零的「时间」列时，认成开始时间
      return /time|时间/.test(h) && (words.some(w => h.includes(w)) || !/[a-z]/.test(h));
    });
  };
  const tm = { start: timeColFor('start'), end: timeColFor('end') };
  for (const k of ['start', 'end']) if (tm[k] >= 0) usedCols.add(tm[k]);
  // row 必须声明在 at 的外层作用域：原来它是 for 块里的 const，而 at 定义在循环外面 ——
  // 闭包按定义处的作用链抓变量，那次数的 row 根本不在链上，CSV 直接 ReferenceError、0 条。
  let row = [];
  const at = k => (map[k] == null ? '' : (row[map[k]] || ''));
  const atm = k => (tm[k] < 0 ? '' : (row[tm[k]] || ''));
  for (let i = 1; i < lines.length; i++) {
    row = splitCsvLine(lines[i], sep);
    if (row.length === 1 && !row[0]) continue;
    const where = `${source} > 第 ${i + 1} 行`;
    if (row.length < header.length - 2) {
      issues.push({ where, code: 'short-row', msg: `只有 ${row.length} 列，表头有 ${header.length} 列（多半是正文里有没转义的逗号）` });
    }
    const st = parseDateTime(at('start'), atm('start'), at('tz'));
    const ev = {
      source, uid: at('uid') || '', nativeId: at('uid') || '',
      title: at('title'), location: at('location'), note: at('note'),
      categories: at('categories'),
      attendees: at('attendee') ? at('attendee').split(/[,;、]/).map(s => s.trim()).filter(Boolean).slice(0, 20) : [],
      alarms: cnAlarm(at('alarm')), rrule: cnRepeat(at('rrule')) ? { ...rruleOf(cnRepeat(at('rrule'))), _unsupported: [] } : null,
      rdate: '', exdate: '', seq: 0, status: '', issues: [], raw: { dtstart: at('start'), dtend: at('end') },
      allDay: /^(1|true|yes|是|全天)$/i.test(at('allDay')) || !st || !!st.allDay,
      tz: st?.tz || null,
    };
    if (!st) { ev.issues.push({ where, code: 'no-start', msg: `开始时间读不懂：「${at('start')}」` }); ev.startMs = null; }
    else {
      ev.startMs = st.startMs;
      const en = parseDateTime(at('end'), atm('end'), at('tz'));
      ev.endMs = en ? en.startMs : st.startMs + (ev.allDay ? 864e5 - 1 : 36e5);
      if (ev.endMs < ev.startMs) { ev.issues.push({ where, code: 'end-before-start', msg: '结束早于开始，按开始+60 分钟纠正' }); ev.endMs = ev.startMs + 36e5; }
      ev.durMs = ev.endMs - ev.startMs;
    }
    if (!ev.title) ev.issues.push({ where, code: 'no-title', msg: '标题为空' });
    if (!ev.uid) ev.uid = 'csv:' + i + ':' + (ev.title || '') + ':' + (ev.startMs || '');
    ev.nativeId = ev.uid;
    events.push(ev);
  }
  return { events, issues };
}

// ---------- JSON ----------
// 认三种形状：Google Calendar API 的 items、CalendarProvider 的 events 数组、自定义简化数组
export function parseJson(text, source = 'json') {
  const issues = [];
  let o;
  try { o = JSON.parse(text); } catch (e) { return { events: [], issues: [{ where: source, code: 'json-broken', msg: `JSON 读不懂：${e.message}` }] }; }
  const arr = Array.isArray(o) ? o : (o.events || o.items || o.data?.events || o.data || o.results || []);
  if (!Array.isArray(arr) || !arr.length) return { events: [], issues: [{ where: source, code: 'no-events', msg: 'JSON 里找不到事件数组（试过 events/items/data/results）' }] };
  const events = [];
  arr.forEach((x, i) => {
    const where = `${source} > 第 ${i + 1} 个事件`;
    const pick = (...ks) => { for (const k of ks) { if (x[k] != null && x[k] !== '') return x[k]; } return null; };
    const ev = {
      source, nativeId: String(pick('_id', 'id', 'uid', 'guid', 'eventId') ?? i), issues: [],
      title: String(pick('title', 'summary', 'Subject', 'name') ?? ''),
      location: String(pick('eventLocation', 'location', 'place', '地点') ?? ''),
      note: String(pick('description', 'note', 'notes', '备注') ?? ''),
      categories: String(pick('categories', 'category', 'labels', '分类', '标签') ?? ''),
      attendees: (() => { const a = pick('attendees', 'participants', '参与人'); if (!a) return []; if (typeof a === 'string') return a.split(/[,;、]/).map(s => s.trim()).filter(Boolean); return a.map(p => typeof p === 'string' ? p : (p.name || p.email || '')).filter(Boolean).slice(0, 20); })(),
      alarms: (() => {
        const a = pick('reminders', 'alarms', '提醒');
        if (!a) return [];
        if (typeof a === 'string') return cnAlarm(a);
        return a.map(r => ({ beforeMin: r.minutes ?? r.beforeMin ?? r.minutesBefore ?? null, method: r.method ?? '弹窗' }));
      })(),
      rrule: pick('rrule', 'RRULE', 'recurrence') ? { ...rruleOf(String(pick('rrule', 'RRULE', 'recurrence'))), _unsupported: [] } : null,
      rdate: String(pick('rdate', 'RDATE') ?? ''), exdate: String(pick('exdate', 'EXDATE') ?? ''),
      seq: +pick('sequence', 'seq', 'version') || 0, status: '', issues2: [], raw: {}, allDay: false, tz: null,
    };
    const sd = pick('dtstart', 'start', 'startTime', 'start_ms', 'startMs', '开始时间');
    const ed = pick('dtend', 'end', 'endTime', 'end_ms', 'endMs', '结束时间');
    const tzName = pick('eventTimezone', 'event_timezone', 'timeZone', 'timezone', 'tz', '时区');
    // Google 的形状是 start:{dateTime:'…',timeZone:'…'}、全天是 {date:'…'}；
    // 有的备份写 {ms:…}。不先摊平，String(v) 会得出「[object Object]」，然后整条被判成没时间。
    const flat = v => {
      if (v == null || typeof v !== 'object' || Array.isArray(v)) return { v, tz: tzName, allDay: false };
      if (v.dateTime) return { v: v.dateTime, tz: v.timeZone || v.timeZoneId || tzName, allDay: false };
      if (v.date) return { v: v.date, tz: tzName, allDay: true };
      if (v.ms != null) return { v: v.ms, tz: tzName, allDay: !!v.allDay };
      if (v.start != null) return { v: v.start, tz: tzName, allDay: !!v.allDay };
      return { v: null, tz: tzName, allDay: false };
    };
    const toAbs = (v, tzn = tzName) => {
      if (v == null) return null;
      if (typeof v === 'number') return v > 1e11 ? v : v * 1000;                 // 毫秒或秒
      const s = String(v);
      if (/^\d{13}$/.test(s)) return +s;
      if (/^\d{10}$/.test(s)) return +s * 1000;
      if (/^\d{8}T\d{6}Z$/.test(s)) return icsToMs(icsDT(s, {}) || {});
      if (/^\d{8}T\d{6}$/.test(s)) return icsToMs(icsDT(s, { TZID: tzName }) || {});
      const iso = Date.parse(s);
      if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(s)) return iso;
      const dt = parseDateTime(s, '', tzn);
      return dt ? dt.startMs : null;
    };
    const S = flat(sd), E = flat(ed);
    ev.startMs = toAbs(S.v, S.tz);
    ev.endMs = toAbs(E.v, E.tz);
    const ad = pick('allDay', 'all_day', 'isAllDay', '全天');
    ev.allDay = ad === 1 || ad === true || ad === '1' || ad === 'true' || ad === '是' || S.allDay
      || (typeof sd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sd.trim()));
    if (ev.startMs == null) ev.issues.push({ where, code: 'no-start', msg: `开始时间读不懂：「${JSON.stringify(S.v ?? sd)}」` });
    else if (ev.endMs == null) ev.endMs = ev.startMs + (ev.allDay ? 864e5 - 1 : 36e5);
    if (ev.endMs < ev.startMs) { ev.issues.push({ where, code: 'end-before-start', msg: '结束早于开始，按开始+60 分钟纠正' }); ev.endMs = ev.startMs + 36e5; }
    if (ev.startMs != null) ev.durMs = ev.endMs - ev.startMs;
    ev.tz = normTz(S.tz) || null;
    if (!ev.tz && ev.startMs == null) ev.issues.push({ where, code: 'tz-assumed', msg: '没给时区，按本机时区解释' });
    if (!ev.title) ev.issues.push({ where, code: 'no-title', msg: '标题为空' });
    ev.uid = ev.nativeId;
    events.push(ev);
  });
  return { events, issues };
}

// ---------- adb content query dump ----------
// 输出形如：Row: 0 _id=17, title=周会, dtstart=1790000000000, allDay=0
// 值里可能有逗号，所以只能按「下一个 key=」的边界切，不能按逗号切。
const KEY = /(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)=/g;
export function splitAdmRow(body) {
  const marks = [];
  KEY.lastIndex = 0;
  let m;
  while ((m = KEY.exec(body))) marks.push({ k: m[1], at: m.index + (m[0].startsWith(',') ? 1 : 0) + (m[0].match(/^\s*/)?.[0].length || 0) });
  const out = {};
  for (let i = 0; i < marks.length; i++) {
    const s = body.indexOf('=', marks[i].at) + 1;
    const e = i + 1 < marks.length ? body.slice(marks[i + 1].at - 1, marks[i + 1].at).startsWith(',')
      ? body.lastIndexOf(',', marks[i + 1].at) : marks[i + 1].at : body.length;
    out[marks[i].k] = body.slice(s, e).trim();
  }
  return out;
}
export function parseAdbDump(text, source = 'adb') {
  const issues = [];
  // content query 一行一条，但备注/标题里有换行时那条会被拆成多行（下一行没有 Row: 前缀）。
  // 先拼回上一行，否则一行事件会被切成好几行假的。看起来还是字段列表的按字段拼，
  // 不像的按原文换行拼回去当值的一部分。
  const logical = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!logical.length || /^\s*Row:\s*\d+\s\S*=/.test(line)) { logical.push(line); continue; }
    if (/^\s*,?\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line)) logical[logical.length - 1] += line;
    else logical[logical.length - 1] += '\n' + line;
  }
  const rows = [];
  for (const line of logical) {
    // 值里可能带真换行（上面拼回来的），. 不跨行会整条丢掉，所以这里用 [\s\S]
    const m = /^\s*(?:Row:\s*\d+\s+)?\{?([\s\S]*?)\}?\s*$/.exec(line);
    if (!m || !m[1].includes('=')) continue;
    rows.push(splitAdmRow(m[1]));
  }
  if (!rows.length) return { events: [], issues: [{ where: source, code: 'no-rows', msg: '没有解析到任何一行 content query 输出' }] };
  const events = rows.map((r, i) => {
    const where = `${source} > 第 ${i + 1} 行 (_id=${r._id ?? '?'})`;
    const st = r.dtstart != null ? +r.dtstart : null;
    const en = r.dtend != null ? +r.dtend : null;
    const ev = {
      source, nativeId: String(r._id ?? i), uid: String(r._id ?? i), issues: [],
      title: r.title || '', location: r.eventLocation || '', note: r.description || '',
      categories: r.eventColorCategory || r.categories || '',
      allDay: r.allDay === '1' || r.allDay === 'true',
      startMs: Number.isFinite(st) ? st : null,
      endMs: Number.isFinite(en) ? en : null,
      tz: normTz(r.eventTimezone) || r.eventTimezone || null,
      rrule: r.rrule ? { ...rruleOf(r.rrule), _unsupported: [] } : null,
      rdate: r.rdate || '', exdate: r.exception || '', seq: +r.version || 0,
      status: r.status || '', attendees: [], alarms: [], raw: { dtstart: r.dtstart, dtend: r.dtend },
    };
    if (ev.startMs == null) ev.issues.push({ where, code: 'no-start', msg: `dtstart 不是数字：「${r.dtstart}」` });
    else if (ev.endMs == null) ev.endMs = ev.startMs + (ev.allDay ? 864e5 - 1 : 36e5);
    if (ev.endMs < ev.startMs) { ev.issues.push({ where, code: 'end-before-start', msg: '结束早于开始，按开始+60 分钟纠正' }); ev.endMs = ev.startMs + 36e5; }
    if (ev.startMs != null) ev.durMs = ev.endMs - ev.startMs;
    if (!ev.title) ev.issues.push({ where, code: 'no-title', msg: '标题为空' });
    return ev;
  });
  return { events, issues };
}

// ---------- 统一入口 ----------
export function parseAny(buf, { name = '', format = '' } = {}) {
  const s = sniff(buf, name);
  const fmt = format && format !== 'auto' ? format : s.fmt;
  const src = name || fmt || 'unknown';
  const empty = { events: [], issues: [] };
  let r;
  try {
    if (fmt === 'ics') r = parseIcs(s.text, src);
    else if (fmt === 'csv') r = parseCsv(s.text, src);
    else if (fmt === 'json' || fmt === 'json:calendar') r = parseJson(s.text, src);
    else if (fmt === 'adb') r = parseAdbDump(s.text, src);
    else return { ...empty, fmt: null, enc: s.enc, head: s.head, issues: [{ where: src, code: 'unknown-format', msg: `认不出格式。开头是「${s.head.slice(0, 80)}」；可以用 --format ics|csv|json|adb 强制指定` }] };
  } catch (e) {
    return { ...empty, fmt, enc: s.enc, issues: [{ where: src, code: 'parser-crashed', msg: `解析器在 ${fmt} 上崩了：${e.message}` }] };
  }
  for (const ev of r.events) {
    const all = [...(ev.issues || []), ...r.issues.filter(x => x.where === src)];
    ev.issueList = all;
    ev.flags = [...new Set(all.map(x => x.code))];
  }
  return { ...r, fmt, enc: s.enc, bom: /bom/i.test(s.enc), issues: r.issues };
}
