#!/usr/bin/env node
// 岛屿的「非通知」数据源：天气 + 日程。结果写成 %LOCALAPPDATA%\win-island\weather.json /
// agenda.json，渲染层只读文件。
//
// 为什么不在 island.ps1 里直接发请求：那边是 70ms 的 UI 循环，同步 Invoke-RestMethod
// 一卡，胶囊动画就掉帧；抓取层本来就是常驻 node，顺手做掉最省事。
//
// 日程走 iCalendar（.ics）这个标准，不造私有格式：手机侧任何能「导出/发布 .ics」的日历
// （Google Calendar 的公开地址、Outlook.com 的「共享->发布链接」、iPhone 第三方日历 App
// 导出的文件）都能直接喂进来，电脑这边只读不算。
//
//   node meta.mjs            常驻（一般由 capture.mjs 调用，不用单独起）
//   node meta.mjs --once     跑一轮，把天气和日程打印出来，用来验证到底通不通
//   node meta.mjs --ics f.ics 只解析一个本地 ics 文件并打印展开结果（离线单测）

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { itemsFor as localItems, stats as calStats } from './calstore.mjs';

const LAD = process.env.LOCALAPPDATA || process.env.TEMP;
export const DATA = process.env.WIN_ISLAND_HOME || join2(LAD, 'win-island');
const WEATHER = join2(DATA, 'weather.json');
const AGENDA = join2(DATA, 'agenda.json');
const GEO = join2(DATA, 'geo.json');
// 周视图单独一个文件：agenda.json 的形状是「三天窗口 + 下一条」，已经被渲染层和
// 8733 页面依赖，塞七天进去就是把那个契约改大。
const WEEKF = join2(DATA, 'week.json');
const HOLF = join2(DATA, 'holidays.json');

function join2(...p) { return p.join(process.platform === 'win32' ? '\\' : '/'); }

const DEF = {
  weather: { lat: null, lon: null, city: null, everyMin: 20, on: true },
  // week1Monday 空 = 不显示周次。教学周第 1 周哪天开学是学校定的，写在 config.json 里，
  // 不写进默认值：这个包给别人时猜一个日期比不显示更容易误导。
  calendar: { sources: [], everyMin: 30, days: 3, on: true, week1Monday: '' },
};

export function loadConfig() {
  const f = join2(DATA, 'config.json');
  let raw = {};
  if (existsSync(f)) {
    try { raw = JSON.parse(readFileSync(f, 'utf8')); }
    catch (e) {
      // 静默按默认值跑过一次，排查起来非常费时间：这里必须喊出来。
      // JSON 里 "D:\win-island\a.ics" 是非法转义，Windows 路径要用 / 或 \\。
      log(`config.json 读不懂，本轮按默认配置跑（天气自动定位、日程无源）：${e.message}。`
        + ` Windows 路径要写成 "D:/win-island/x.ics" 或 "D:\\\\win-island\\\\x.ics"`);
    }
  }
  const c = { weather: { ...DEF.weather }, calendar: { ...DEF.calendar } };
  if (raw.weather) Object.assign(c.weather, raw.weather);
  if (raw.calendar) Object.assign(c.calendar, raw.calendar);
  // 也认纯文本的日历地址：一行一个 https 或本地 .ics 路径，# 开头是注释
  const t = join2(DATA, 'calendars.txt');
  if (existsSync(t)) {
    const extra = readFileSync(t, 'utf8').split(/\r?\n/).map(s => s.trim())
      .filter(s => s && !s.startsWith('#'));
    c.calendar.sources = [...new Set([...c.calendar.sources.map(String), ...extra])];
  }
  return c;
}

let logger = s => console.log(s);
export const log = s => logger(s);

async function get(url, ms = 9000) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { 'user-agent': 'win-island/1.0', 'accept': '*/*' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

// ---------- 定位：config 里写死就用写死的，否则按出口 IP 猜一次并缓存 ----------
async function locate(cfg) {
  if (cfg.lat && cfg.lon) return { lat: +cfg.lat, lon: +cfg.lon, city: cfg.city || '', src: 'config' };
  if (cfg.city && !cfg.lat) {
    try {
      const j = await (await get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cfg.city)}&count=1`)).json();
      const g = j.results?.[0];
      if (g) return { lat: g.latitude, lon: g.longitude, city: g.name, src: 'geocoding' };
    } catch (e) { log(`地名解析失败：${e.message}`); }
  }
  try { if (existsSync(GEO)) {
    const g = JSON.parse(readFileSync(GEO, 'utf8'));
    if (Date.now() - g.at < 7 * 864e5) return { ...g, src: 'cache' };
  } } catch {}
  for (const [url, pick] of [
    ['https://api.ip.sb/geoip', j => ({ lat: j.latitude, lon: j.longitude, city: j.city })],
    ['https://ipinfo.io/json', j => { const [a, b] = String(j.loc || '').split(','); return { lat: +a, lon: +b, city: j.city }; }],
  ]) {
    try {
      const g = pick(await (await get(url, 6000)).json());
      if (Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
        const o = { at: Date.now(), lat: g.lat, lon: g.lon, city: g.city || '' };
        writeFileSync(GEO + '.tmp', JSON.stringify(o)); renameSync(GEO + '.tmp', GEO);
        return { ...o, src: 'ip' };
      }
    } catch (e) { log(`定位 ${url} 失败：${e.message}`); }
  }
  return null;
}

// WMO 天气码 -> [中文, 符号]。符号只用 BMP 里的，Segoe UI Symbol 有，emoji 字体在 WPF 里不出色。
const WMO = {
  0: ['晴', '☀'], 1: ['晴间多云', '⛅'], 2: ['多云', '⛅'], 3: ['阴', '☁'],
  45: ['雾', '☁'], 48: ['雾凇', '☁'],
  51: ['毛毛雨', '☂'], 53: ['毛毛雨', '☂'], 55: ['毛毛雨', '☂'],
  56: ['冻雨', '☂'], 57: ['冻雨', '☂'],
  61: ['小雨', '☂'], 63: ['中雨', '☂'], 65: ['大雨', '☂'],
  66: ['冻雨', '☂'], 67: ['冻雨', '☂'],
  71: ['小雪', '❄'], 73: ['中雪', '❄'], 75: ['大雪', '❄'], 77: ['雪粒', '❄'],
  80: ['阵雨', '☂'], 81: ['阵雨', '☂'], 82: ['强阵雨', '☂'],
  85: ['阵雪', '❄'], 86: ['阵雪', '❄'],
  95: ['雷暴', '⛈'], 96: ['雷暴伴冰雹', '⛈'], 99: ['雷暴伴冰雹', '⛈'],
};
export const wmo = c => WMO[Number(c)] || ['未知天气', '☁'];

export async function fetchWeather(force = false) {
  const cfg = loadConfig().weather;
  if (!cfg.on) return null;
  if (!force && existsSync(WEATHER)) {
    try {
      const old = JSON.parse(readFileSync(WEATHER, 'utf8'));
      if (Date.now() - old.at < cfg.everyMin * 6e4) return old;
    } catch {}
  }
  const g = await locate(cfg);
  if (!g) { log('天气拿不到：定位失败（在 config.json 里写 weather.lat/lon 可以绕开）'); return null; }
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}`
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto&forecast_days=2';
    const j = await (await get(u, 10000)).json();
    const c = j.current || {};
    const [txt, glyph] = wmo(c.weather_code);
    const d = j.daily || {};
    const out = {
      at: Date.now(), tz: j.utc_offset_seconds ? j.utc_offset_seconds / 3600 : 0,
      city: cfg.city || g.city || '', lat: g.lat, lon: g.lon,
      temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature ?? c.temperature_2m),
      humi: Math.round(c.relative_humidity_2m ?? 0), code: c.weather_code, txt, glyph,
      hi: d.temperature_2m_max ? Math.round(d.temperature_2m_max[0]) : null,
      lo: d.temperature_2m_min ? Math.round(d.temperature_2m_min[0]) : null,
      rain: d.precipitation_probability_max ? Math.round(d.precipitation_probability_max[0] ?? 0) : null,
      tomorrow: d.weather_code?.[1] ? wmo(d.weather_code[1])[0] : '',
      tHi: d.temperature_2m_max?.[1] != null ? Math.round(d.temperature_2m_max[1]) : null,
      tLo: d.temperature_2m_min?.[1] != null ? Math.round(d.temperature_2m_min[1]) : null,
    };
    writeFileSync(WEATHER + '.tmp', JSON.stringify(out)); renameSync(WEATHER + '.tmp', WEATHER);
    log(`天气 ok：${out.city || '本地'} ${out.temp}° ${out.txt}（体感 ${out.feels}°，降水 ${out.rain}%）`);
    return out;
  } catch (e) {
    log('天气拉取失败：' + e.message);
    return existsSync(WEATHER) ? JSON.parse(readFileSync(WEATHER, 'utf8')) : null;
  }
}

// ---------- iCalendar ----------
// 只实现日程真正需要的子集，不支持的（RECURRENCE-ID 改期、EXDATE、复杂 BYSETPOS）会如实
// 记进 skip 计数，不假装解析成功。
function unfold(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\r/g, '').split('\n');
}
function unesc(s) {
  return String(s).replace(/\\\\/g, '\u0000').replace(/\\[;,]/g, m => m[1])
    .replace(/\u0000/g, '\\').replace(/\\n/gi, ' ').trim();
}
// 一行 "DTSTART;TZID=Asia/Shanghai:20260926T080000" -> {name, params, value}
function prop(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const parts = line.slice(0, i).split(';');
  const name = parts[0].trim().toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    if (k && v) params[k.trim().toUpperCase()] = v.trim();
  }
  return { name, params, value: line.slice(i + 1).trim() };
}
const pad = (s, n) => String(s).padStart(n, '0');

// 返回 {y,m,d,h,mi,utc} —— 一律拆成「墙上时间」字段，utc=true 表示带 Z，要换算成本地墙钟
function icsDT(value, params) {
  const v = String(value).trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, allDay: true };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const o = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], allDay: false };
  if (m[7] === 'Z') {
    const dt = new Date(Date.UTC(o.y, o.mo - 1, o.d, o.h, o.mi));
    return { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes(), allDay: false, fromUtc: true };
  }
  // 带命名时区的：这台机器上的日历基本都是本机时区排的课表，按本地墙钟处理；
  // 真要跨时区就在 config 里把该源关掉，别猜一个偏移糊弄过去。
  if (params?.TZID) o.tzid = params.TZID;
  return o;
}
const toMs = o => new Date(o.y, o.mo - 1, o.d, o.h || 0, o.mi || 0).getTime();

// 展开 RRULE。只认 FREQ=DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL + BYDAY + COUNT + UNTIL，
// 这已经覆盖课程表/周会这类真实日程；BYMONTHDAY 也认。
export function expand(ev, fromMs, untilMs) {
  const r = ev.rrule || {};
  const freq = String(r.FREQ || '').toUpperCase();
  const step = Math.max(1, +r.INTERVAL || 1);
  const base = toMs(ev.dt);
  const out = [];
  const cnt = r.COUNT ? +r.COUNT : 0;
  const until = r.UNTIL ? toMs(icsDT(r.UNTIL, {})) : Infinity;
  const days = Math.ceil((untilMs - base) / 864e5) + 3;
  if (base > untilMs) return out;
  const byday = String(r.BYDAY || '').split(',').map(s => s.trim().replace(/^[+-]?\d+/, '').toUpperCase()).filter(Boolean);
  const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  let n = 0;
  for (let k = 0; k <= days + 400; k++) {
    const cand = new Date(base + k * 864e5);
    cand.setHours(ev.dt.h || 0, ev.dt.mi || 0, 0, 0);
    if (!freq) {
      out.push(cand.getTime());
      break;
    }
    let hit = false, idx = 0;
    const dayDiff = Math.floor((new Date(cand.getFullYear(), cand.getMonth(), cand.getDate())
      - new Date(ev.dt.y, ev.dt.mo - 1, ev.dt.d)) / 864e5);
    if (freq === 'DAILY') { hit = dayDiff >= 0 && dayDiff % step === 0; idx = dayDiff / step; }
    else if (freq === 'WEEKLY') {
      // 以周一为一周起点算周差，才和「每周三」这种课表对得上
      const cs = (cand.getDay() + 6) % 7, bs = (new Date(ev.dt.y, ev.dt.mo - 1, ev.dt.d).getDay() + 6) % 7;
      const cw = Math.floor((dayDiff - cs + 7) / 7), bw = Math.floor((-bs + 7) / 7);
      const weeks = cw - bw;
      const want = byday.length ? byday.includes(wd[cand.getDay()]) : cand.getDay() === new Date(ev.dt.y, ev.dt.mo - 1, ev.dt.d).getDay();
      hit = dayDiff >= 0 && weeks >= 0 && weeks % step === 0 && want;
      idx = weeks * step + (want ? 1 : 0);
    } else if (freq === 'MONTHLY') {
      const md = (cand.getFullYear() - ev.dt.y) * 12 + (cand.getMonth() - (ev.dt.mo - 1));
      const dom = r.BYMONTHDAY ? +String(r.BYMONTHDAY).split(',')[0] : ev.dt.d;
      hit = md >= 0 && md % step === 0 && cand.getDate() === Math.min(dom, new Date(cand.getFullYear(), cand.getMonth() + 1, 0).getDate());
      idx = md / step;
    } else if (freq === 'YEARLY') {
      const yd = cand.getFullYear() - ev.dt.y;
      hit = yd >= 0 && yd % step === 0 && cand.getMonth() === ev.dt.mo - 1 && cand.getDate() === ev.dt.d;
      idx = yd / step;
    } else { hit = dayDiff === 0; }
    if (!hit) continue;
    const t = cand.getTime();
    if (cnt && n >= cnt) break;
    if (t > until) break;
    if (t >= fromMs - (ev.dur || 0)) out.push(t);
    n++;
    if (out.length > 500) break;
  }
  return out;
}

export function parseIcs(text) {
  const events = [], skip = [];
  let cur = null;
  for (const raw of unfold(text)) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur) {
        const s = cur.SUMMARY ? unesc(cur.SUMMARY.value) : '';
        const dt = cur.DTSTART ? icsDT(cur.DTSTART.value, cur.DTSTART.params) : null;
        if (!dt) skip.push('没有 DTSTART');
        else if (cur['RECURRENCE-ID'] || cur.RDATE) skip.push('改期/追加实例没解析');
        else {
          const de = cur.DTEND ? icsDT(cur.DTEND.value, cur.DTEND.params) : null;
          let dur = 0;
          if (de) dur = Math.max(0, toMs(de) - toMs(dt));
          else if (cur.DURATION) {
            const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(String(cur.DURATION.value));
            if (m) dur = (+m[1] || 0) * 36e5 + (+m[2] || 0) * 6e4;
          }
          if (dt.allDay) dur = 0;
          const rr = cur.RRULE ? Object.fromEntries(String(cur.RRULE.value).split(';').map(p => {
            const [k, v] = p.split('='); return [k.toUpperCase(), v];
          })) : null;
          events.push({
            title: s || '（无标题）', where: cur.LOCATION ? unesc(cur.LOCATION.value) : '',
            dt, dur, allDay: !!dt.allDay, rrule: rr, uid: cur.UID ? cur.UID.value : '',
          });
        }
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const p = prop(line);
    if (p) cur[p.name] = { value: p.value, params: p.params };
  }
  return { events, skip };
}

const hhmm = t => { const d = new Date(t); return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`; };

// 入参是已经取到正文的源：[{name, text}]。取文本（网络/磁盘）和解析分开，出错才分得清是
// 拉不到还是读不懂。
export function buildAgenda(sources, now = Date.now()) {
  const from = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const to = from + 3 * 864e5;
  const items = [];
  const errs = [];
  const srcs = [];
  for (const { name = '', text = '' } of sources) {
    try {
      if (!text.trim()) { errs.push(`${name || '未命名源'}：没取到内容`); srcs.push({ name, events: 0, items: 0 }); continue; }
      const { events, skip } = parseIcs(text);
      const before = items.length;
      for (const ev of events) {
        for (const t of expand(ev, from, to)) {
          const e = t + (ev.allDay ? 0 : ev.dur);
          if (e < now || t >= to) continue;
          items.push({
            s: t, e, st: hhmm(t), et: hhmm(e), day: new Date(t).getDate(),
            title: ev.title, where: ev.where, allDay: ev.allDay, src: name,
          });
        }
      }
      srcs.push({ name, events: events.length, items: items.length - before });
      if (skip.length) errs.push(`${name}：${skip.length} 条改期/追加类事件没解析`);
    } catch (e) { errs.push(`${name}：${e.message}`); }
  }
  // 本机导入的日程（cal.db）也并进同一份清单：agenda.json 的形状一个字段没变，只是多几条目。
  // 库读不到就算了（没导过、或者被别的进程占着），不能让日程段因为导入层的问题整个消失。
  try {
    const loc = localItems(from, to).filter(x => x.e >= now && x.s < to);
    if (loc.length) { items.push(...loc); srcs.push({ name: '本机导入', events: loc.length, items: loc.length }); }
  } catch (e) { errs.push(`本机日程库：${e.message}`); }
  items.sort((a, b) => (a.allDay ? 1 : 0) - (b.allDay ? 1 : 0) || a.s - b.s);
  const dayName = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const days = [];
  for (let i = 0; i < 3; i++) {
    const d0 = new Date(new Date(now + i * 864e5).setHours(0, 0, 0, 0)).getTime();
    const d1 = d0 + 864e5;
    const ev = items.filter(x => x.s >= d0 && x.s < d1);
    if (ev.length) days.push({ date: dayName(d0), offset: i, events: ev });
  }
  const next = items.find(x => x.s >= now) || null;
  return {
    at: now, n: items.length, days, srcs,
    next: next ? { ...next, inMin: Math.round((next.s - now) / 6e4), today: new Date(next.s).getDate() === new Date(now).getDate() } : null,
    errors: errs,
  };
}

// ---- 教学周 + 假期：给「展开看整周课表」用的一份数据 ---------------------------
// 为什么还要再拉一个外部接口：cal.db 里只有「哪天几点有课」，「那天放不放假、
// 是不是调休补班」库里根本没有，问不出来。timor.tech 这份把法定假日和补班放在
// 同一张 holiday 表里（holiday:true 是放、false 是补班），一次请求两样都齐。
const WDN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`; };

// 本周一 00:00 起七天。每天的时刻都从「当天 setHours(0,0,0,0)」重算，
// 不用 monday + i*864e5 直接推 —— 那样跨到有时区的夏令时会错一格。
export function weekWindow(now = Date.now()) {
  const t = new Date(new Date(now).setHours(0, 0, 0, 0));
  const off = (t.getDay() + 6) % 7;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(new Date(t.getTime() + ((i - off) * 864e5)).setHours(0, 0, 0, 0)).getTime();
    // 标签用每一天自己的月/日：12/29 起那种跨月周，全按 t 的月份算会统一标错
    const x = new Date(d);
    days.push({ ms: d, iso: ymd(d), label: `${x.getMonth() + 1}/${x.getDate()}` });
  }
  return { monday: days[0].ms, to: days[6].ms + 864e5, off, days };
}

let holWarned = '';
// 缺哪个年补哪个年；拉不到的年记一笔失败时间，半小时内不再敲（他这边网络时好时坏，
// 每轮都撞一个死接口会把日志刷满、也会拖慢这一轮）。
async function ensureHolidays(isos) {
  let cur = { at: 0, days: {}, miss: {} };
  try { cur = JSON.parse(readFileSync(HOLF, 'utf8')); } catch {}
  const have = new Set(Object.keys(cur.days || {}).map(k => String(k).slice(0, 4)));
  const want = [...new Set(isos.map(k => String(k).slice(0, 4)))].filter(y => !have.has(y))
    .filter(y => !(cur.miss && cur.miss[y] && Date.now() - cur.miss[y] < 18e5));
  const days = { ...(cur.days || {}) };
  const miss = { ...(cur.miss || {}) };
  let touched = false;
  for (const y of want) {
    try {
      const j = await (await get(`https://timor.tech/api/holiday/year/${y}`, 12000)).json();
      if (!j || j.code !== 0 || !j.holiday) throw new Error(`接口 code=${j && j.code}`);
      for (const [k, v] of Object.entries(j.holiday)) {
        const iso = `${y}-${k}`;
        days[iso] = v.holiday
          ? { kind: 'rest', name: String(v.name || '放假') }
          : { kind: 'work', name: String(v.name || '补班'), target: String(v.target || '') };
      }
      delete miss[y];
      touched = true;
      log(`假期数据 ok：${y} 年 ${Object.keys(j.holiday).length} 条`);
    } catch (e) {
      miss[y] = Date.now();
      touched = true;
      if (holWarned !== y + e.message) { holWarned = y + e.message; log(`假期数据拉不到 ${y}：${e.message}`); }
    }
  }
  if (touched || !existsSync(HOLF)) {
    const out = { at: Date.now(), days, miss };
    writeFileSync(HOLF + '.tmp', JSON.stringify(out)); renameSync(HOLF + '.tmp', HOLF);
  }
  return days;
}

// 远程源展开到这个窗口。和 buildAgenda 里那段几乎一样，但故意不复用：
// 那份的过滤条件是「已经过去的丢掉」，周视图要的正好是包括已经上完的那几天，
// 而且 agenda.json 是被测试和 8733 页面钉住的契约，不能为了这里改它。
function occurrences(sources, from, to) {
  const items = [], errs = [];
  for (const { name = '', text = '' } of sources) {
    try {
      if (!text.trim()) continue;
      const { events } = parseIcs(text);
      for (const ev of events) {
        for (const t of expand(ev, from, to)) {
          const e = t + (ev.allDay ? 0 : ev.dur);
          if (e < from || t >= to) continue;
          items.push({
            s: t, e, st: hhmm(t), et: hhmm(e), title: ev.title, where: ev.where,
            allDay: ev.allDay, src: name,
          });
        }
      }
    } catch (e) { errs.push(`${name}：${e.message}`); }
  }
  try {
    for (const x of localItems(from, to)) {
      if (x.e < from || x.s >= to) continue;
      items.push(x);
    }
  } catch (e) { errs.push(`本机日程库：${e.message}`); }
  items.sort((a, b) => (a.allDay ? 1 : 0) - (b.allDay ? 1 : 0) || a.s - b.s);
  return { items, errs };
}

export function buildWeek(sources = [], now = Date.now(), hols = {}) {
  const cfg = loadConfig().calendar;
  const w = weekWindow(now);
  const { items, errs } = occurrences(sources, w.monday, w.to);
  const days = w.days.map((d, i) => {
    const h = hols[d.iso];
    return {
      i, iso: d.iso, date: d.label, wd: WDN[i], today: i === w.off,
      past: d.ms + 864e5 <= now,
      rest: h && h.kind === 'rest' ? h.name : '', work: h && h.kind === 'work' ? h.name : '',
      events: items.filter(x => x.s >= d.ms && x.s < d.ms + 864e5),
    };
  });
  let weekNo = null;
  const w1 = cfg.week1Monday ? Date.parse(`${cfg.week1Monday}T00:00:00`) : NaN;
  if (Number.isFinite(w1)) {
    const n = Math.round((w.monday - w1) / (7 * 864e5)) + 1;
    // 超出一个学期正常范围就当没设过：宁可不显示周次，也不显示一个「第 -3 周」
    if (n >= 1 && n <= 30) weekNo = n;
  }
  return { at: now, monday: w.days[0].iso, weekNo, todayIdx: w.off, n: items.length, days, errors: errs };
}

// fetchAgenda 拉到的源文本留一份在这里：周视图紧接着同一轮要建，没有它就只能出本机那部分。
// 进程刚起来时它是 null —— 那种情况下面会退化成「只读库」，不会去多敲一次网络。
let LAST_TEXTS = null;

// 取源正文（网络/磁盘）和解析分开：出错才分得清是拉不到还是读不懂。
// 原来这段埋在 fetchAgenda 里，周视图也要同一份正文，抽出来共用。
async function collectTexts(cfg) {
  const texts = [];
  if (!cfg.on) return texts;
  for (const s of cfg.sources || []) {
    if (/^https?:/i.test(s)) {
      try { texts.push({ name: s.replace(/^https?:\/\//, '').slice(0, 40), text: await (await get(s, 12000)).text() }); }
      catch (e) { log(`日历源拉取失败 ${s.slice(0, 50)}：${e.message}`); texts.push({ name: s.replace(/^https?:\/\//, '').slice(0, 40), text: '' }); }
    } else if (existsSync(s)) {
      texts.push({ name: basename(s), text: readFileSync(s, 'utf8') });
    } else {
      texts.push({ name: basename(s), text: '' });
      log(`日历源找不到文件：${s}`);
    }
  }
  return texts;
}

export async function fetchWeek(force = false) {
  const cfg = loadConfig().calendar;
  const w = weekWindow();
  if (!force && existsSync(WEEKF)) {
    // 假期标签每天要变（今天的「放假」到明天就该没了），所以过期判据按「同一天」而不是按周
    try {
      const old = JSON.parse(readFileSync(WEEKF, 'utf8'));
      if (old.monday === w.days[0].iso && old.todayIdx === w.off && Date.now() - old.at < 30 * 6e4) return old;
    } catch {}
  }
  const hols = await ensureHolidays(w.days.map(d => d.iso));
  // 进程刚起来、这一轮还没拉过远程源时，去拉一次：退化成「只有本机库」的话，
  // 订阅来的课会在整周视图里凭空少掉，而那看起来就像课表错了。
  if (LAST_TEXTS === null) LAST_TEXTS = await collectTexts(cfg);
  const a = buildWeek(LAST_TEXTS, Date.now(), hols);
  writeFileSync(WEEKF + '.tmp', JSON.stringify(a)); renameSync(WEEKF + '.tmp', WEEKF);
  return a;
}

export async function fetchAgenda(force = false) {
  const cfg = loadConfig().calendar;
  let localN = 0;
  try { localN = calStats().rows; } catch {}
  const sources = cfg.on ? cfg.sources : [];
  if (!cfg.on && !localN) return null;
  // 只有本机导入的日程（没订阅链接、或者日历开关没开）：也得出一份 agenda，
  // 不然「没配远程源」会把导入进来的日程一起关掉。
  if (!sources.length && localN) {
    LAST_TEXTS = [];
    const a = buildAgenda([]);
    writeFileSync(AGENDA + '.tmp', JSON.stringify(a)); renameSync(AGENDA + '.tmp', AGENDA);
    return a;
  }
  if (!cfg.sources.length) {
    if (existsSync(AGENDA)) { try { if (Date.now() - JSON.parse(readFileSync(AGENDA, 'utf8')).at < 6 * 36e5) return JSON.parse(readFileSync(AGENDA, 'utf8')); } catch {} }
    const a = { at: Date.now(), n: 0, days: [], next: null, errors: [], unconfigured: true };
    writeFileSync(AGENDA + '.tmp', JSON.stringify(a)); renameSync(AGENDA + '.tmp', AGENDA);
    return a;
  }
  if (!force && existsSync(AGENDA)) {
    try { const old = JSON.parse(readFileSync(AGENDA, 'utf8')); if (Date.now() - old.at < cfg.everyMin * 6e4) return old; } catch {}
  }
  const texts = await collectTexts(cfg);
  const a = buildAgenda(texts);
  a.errors = [...a.errors];
  LAST_TEXTS = texts;
  writeFileSync(AGENDA + '.tmp', JSON.stringify(a)); renameSync(AGENDA + '.tmp', AGENDA);
  log(`日程 ok：${a.n} 个近期事件${a.next ? `，下一个 ${a.next.st} ${a.next.title}` : ''}${a.errors.length ? '（' + a.errors.join('；') + '）' : ''}`);
  return a;
}

// 动过库之后重建这两份，一律走这里，别各处自己拼：
// 顺序必须和 tickMeta 一样（整周那份吃的是 agenda 这一轮留下的源正文），
// 而且只重建一份就会出现「今日安排是新的、本周课表还是旧的」——同一次导入出两个版本，最难查。
export async function rebuildSchedule() {
  const ag = await fetchAgenda(true).catch(e => ({ n: null, errors: ['日程重建失败：' + e.message] }));
  const wk = await fetchWeek(true).catch(e => null);
  return { ag, wk };
}

export async function tickMeta() {
  await fetchWeather();
  await fetchAgenda();
  // 顺序不能反：fetchWeek 吃的是 fetchAgenda 这一轮留下的源正文
  await fetchWeek();
}

const MODE = process.argv.slice(2)[0] || '';
// 只认「命令行跑的就是我」：capture.mjs 会 import 这个模块，它自己的 --once/--replay
// 参数会漏进 process.argv，判据写成 MODE 非空就会把抓取层顶掉。
const SELF = /meta\.mjs$/i.test(process.argv[1] || '');
if (SELF) {
  mkdirSync(DATA, { recursive: true });
  if (MODE === '--ics') {
    console.log(JSON.stringify(buildAgenda([{ name: basename(process.argv[3] || ''), text: readFileSync(process.argv[3], 'utf8') }]), null, 1));
  } else if (MODE === '--week') {
    const wk = await fetchWeek(true);
    console.log(JSON.stringify({ monday: wk.monday, weekNo: wk.weekNo, todayIdx: wk.todayIdx, n: wk.n, errors: wk.errors }, null, 1));
    for (const d of wk.days) {
      const flag = [d.today ? '◀今天' : '', d.rest ? `放假:${d.rest}` : '', d.work ? `补班:${d.work}` : ''].filter(Boolean).join(' ');
      console.log(`${d.wd} ${d.date} ${flag}`);
      for (const e of d.events) console.log(`    ${e.st}${e.et ? '-' + e.et : ''} ${e.title}${e.where ? ' @' + e.where : ''} [${e.src}]`);
    }
  } else {
    const w = await fetchWeather(true);
    console.log('天气：', w ? `${w.city} ${w.temp}° ${w.txt} 体感${w.feels}° 湿度${w.humi}% ${w.lo}~${w.hi}° 降水${w.rain}% 明天${w.tomorrow}` : '拿不到');
    const a = await fetchAgenda(true);
    console.log('日程：', a ? `${a.n} 条，下一个 ${a.next ? a.next.st + ' ' + a.next.title : '无'}${a.errors?.length ? ' 问题：' + a.errors.join('；') : ''}` : '未启用');
    if (a?.days) for (const d of a.days) console.log(`  ${d.date}  ${d.events.map(e => `${e.st} ${e.title}`).join(' / ')}`);
  }
  process.exit(0);
}
