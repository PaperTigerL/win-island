// cal-preview.mjs —— 「解析预览（可勾选、可修正异常条目）→ 确认导入」这一屏。
// 只绑 127.0.0.1，不绑 0.0.0.0：这一页会把日程标题原样渲染出来，本机其他人都能看到，
// 何况内容里可能有课表/同事名字。
//   node cal-import.mjs 某.ics --serve            有待导条目的一版
//   node cal-preview.mjs --db                     只看库里已经有什么（能勾掉/删来源）
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRows, sourcesList, importBatch, setExcluded, stats, closeDb } from './calstore.mjs';
import { view, whenCn, repeatCn, alarmCn } from './calview.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p2 = x => String(x).padStart(2, '0');
const toInput = ms => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const fromDateInput = (s, allDay) => {
  if (!s) return null;
  const t = allDay ? new Date(s.slice(0, 10) + 'T00:00').getTime() : new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
};

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:22px 26px 60px;background:#0d1117;color:#e6edf3;
 font:14px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px;color:#8b949e;font-weight:600}
.sub{color:#8b949e;font-size:12.5px;margin-bottom:14px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 14px;margin-bottom:12px}
.row{display:grid;grid-template-columns:26px 1fr auto;gap:10px;padding:9px 6px;border-top:1px solid #21262d;align-items:start}
.row:first-child{border-top:0}
.t{font-weight:600}.m{color:#8b949e;font-size:12.5px;margin-top:2px}
.bad{color:#f85149}.warn{color:#d29922}.ok{color:#3fb950}
input[type=checkbox]{width:16px;height:16px;margin-top:3px;accent-color:#2f81f7}
input[type=datetime-local],input[type=date]{background:#0d1117;color:#e6edf3;border:1px solid #30363d;
 border-radius:6px;padding:3px 6px;font:12.5px "Segoe UI",sans-serif}
button{background:#238636;color:#fff;border:0;border-radius:7px;padding:8px 16px;font-size:14px;cursor:pointer}
button:hover{filter:brightness(1.12)}button.g{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:4px 10px;font-size:12.5px}
.top{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
code{background:#21262d;padding:1px 5px;border-radius:4px;font-size:12.5px}
`;

function pendingRows(batches) {
  const rows = [];
  for (const [bi, b] of batches.entries()) {
    (b.events || []).forEach((ev, i) => {
      const v = view(ev, i + 1);
      rows.push({ ...v, bi, idx: i, key: `${bi}:${i}`, fixable: true,
        startInput: ev.startMs != null ? toInput(ev.startMs) : '', endInput: ev.endMs != null ? toInput(ev.endMs) : '' });
    });
  }
  return rows;
}

function html({ batches = [], stored = [], srcs = [], msg = '' }) {
  const pend = pendingRows(batches);
  const badN = pend.filter(r => r.codes.length).length;
  const sec = r => {
    const cls = r.codes.length ? (r.codes.includes('no-start') ? 'bad' : 'warn') : '';
    const fix = r.stored
      ? `<span class="m">${esc(r.when)}</span>${r.excluded ? ' <span class="warn">已隐藏</span>' : ''}`
      : `<input type="${r.allDay ? 'date' : 'datetime-local'}" name="st_${esc(r.key)}" value="${esc((r.startInput || '').slice(0, r.allDay ? 10 : 16))}">`;
    // 待导的勾 = 「这条要不要」；库里的勾 = 「这条要不要在岛上显示」，两种语义分开写清楚
    const box = r.stored
      ? `<input type="checkbox" name="s_${esc(r.id)}" ${r.excluded ? '' : 'checked'} title="勾上=在岛上显示">`
      : `<input type="checkbox" name="k_${esc(r.key)}" ${r.codes.includes('no-start') ? '' : 'checked'} title="勾上=导入这条">`;
    return `<div class="row">${box}
      <div><div class="t ${cls}">${esc(r.title)}${r.allDay ? ' <span class="m">全天</span>' : ''}${r.repeat ? ` <span class="m">⟳ ${esc(r.repeat)}</span>` : ''}${r.alarm ? ` <span class="m">⏰ ${esc(r.alarm)}</span>` : ''}</div>
        <div class="m">${esc([r.where, r.attendees, r.categories].filter(Boolean).join(' · '))}${r.note ? ` · ${esc(r.note.slice(0, 90))}` : ''}</div>
        ${r.issues.length ? `<div class="${cls}">${r.issues.map(esc).join('；')}</div>` : ''}</div>
      <div>${fix}</div></div>`;
  };
  const batchCards = batches.map((b, bi) => {
    const rows = pend.filter(r => r.bi === bi);
    return `<div class="card"><h2 style="margin:0 0 6px">【${esc(b.name)}】<span class="m">格式 ${esc(b.fmt || '?')} · 编码 ${esc(b.enc || '?')} · ${rows.length} 条</span></h2>
      ${(b.issues || []).map(x => `<div class="bad">！${esc(x.msg || x.code)}</div>`).join('')}
      ${rows.map(sec).join('') || '<div class="m">这批没有条目</div>'}</div>`;
  }).join('');
  const storedCards = stored.length
    ? `<h2>库里已经有的（近 14 天，按开始时间排）</h2>
      <form method="post" action="/hide"><div class="card">
      <div class="m" style="margin:0 0 6px">这一栏的勾选框是「要不要在岛上显示」，改了点下面的应用；不会删掉库里的数据。</div>
      ${stored.map(sec).join('')}
      <button type="submit" style="margin-top:8px">按勾上的显示状态应用（共 ${stored.length} 条）</button>
      </div></form>`
    : '';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>日程导入预览</title><style>${CSS}</style></head><body>
<h1>日程导入预览</h1>
<div class="sub">待确认 <b>${pend.length}</b> 条，其中 <b class="${badN ? 'warn' : 'ok'}">${badN}</b> 条解析有问题（红=没时间，黄=其他）。
库：<code>${esc(stats().path)}</code></div>
${msg ? `<div class="card ok">${esc(msg)}</div>` : ''}
<form method="post" action="/import">
${batchCards}
<button type="submit">确认导入勾上的条目</button>
<button class="g" formaction="/ignore" type="submit">先不导入，只关掉这页</button>
</form>
${storedCards}
${srcs.length ? `<h2>来源</h2><div class="card">${srcs.map(s => `<div class="row"><span></span><div><div class="t">${esc(s.name)}</div><div class="m">${s.n} 条 · 格式 ${esc(s.fmt || '?')} · 导入于 ${esc(new Date(s.at).toLocaleString('zh-CN'))}</div></div><div></div></div>`).join('')}</div>` : ''}
<h2>给别的软件用</h2>
<div class="card"><div class="m">同一份近期日程的机器可读版：<code>GET http://127.0.0.1:${port()}/api/schedule</code>；整周课表（含每天放假/补班）：<code>GET http://127.0.0.1:${port()}/api/week</code>（都只绑 127.0.0.1）</div></div>
</body></html>`;
}

// 页面自己要知道端口（端口是启动参数决定的，藏在闭包里比全局干净）
let PORT = 8733;
const port = () => PORT;

function rowsFromDb() {
  const from = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  return listRows({ from: from - 864e5 }).map(r => ({
    key: 'db:' + r.id, i: r.id, id: r.id, stored: true, excluded: !!r.excluded,
    title: r.title || '（无标题）',
    when: `${whenCn(r.startMs)}${r.allDay ? ' 全天' : ' → ' + whenCn(r.endMs)}`,
    allDay: r.allDay, repeat: repeatCn(r.rrule), alarm: alarmCn(r.alarms),
    where: r.location, attendees: (r.attendees || []).join('、'), categories: r.categories,
    note: r.note, codes: (r.issueList || []).map(x => x.code),
    issues: (r.issueList || []).map(x => `${x.msg}（${x.code}）`), fixable: false, startInput: '', endInput: '',
  }));
}

// 库里一有改动就两份日程文件一起强制重建：整周视图自带 30 分钟缓存，
// 只重建 agenda 的话页面上「已经隐藏了」但岛上「本周课表」还挂着那节课。
async function syncIsland() {
  try {
    const m = await import('./meta.mjs');
    return await m.rebuildSchedule();
  } catch (e) { return { ag: { n: null, errors: ['日程重建失败：' + e.message] }, wk: null }; }
}

export async function serve(batches = [], { port = 8733, as = '' } = {}) {
  PORT = port;
  let last = '';
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (u.pathname === '/api/schedule' || u.pathname === '/api/week') {
      // 两个口给两份文件：agenda.json 是「三天窗口 + 下一条」，week.json 是整周（含放假/补班）。
      // 面板上看到的和别的应用拿到的必须是同一份，所以这里只做「读文件 + 原样吐出去」。
      const f = u.pathname === '/api/week' ? 'week.json' : 'agenda.json';
      try {
        const raw = readFileSync(join(stats().path, '..', f), 'utf8');
        // PS 写的 JSON 可能带 BOM，Node 的 JSON.parse 会被它炸掉；用码点判，别在源码里放不可见字符
        const a = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return send(200, 'application/json; charset=utf-8', JSON.stringify(a));
      } catch (e) { return send(503, 'application/json; charset=utf-8', JSON.stringify({ ok: false, reason: `${f} 还没生成过：` + e.message })); }
    }
    if (u.pathname === '/' ) return send(200, 'text/html; charset=utf-8', html({ batches, stored: rowsFromDb(), srcs: sourcesList(), msg: last }));
    if (req.method === 'POST' && ['/ignore', '/import', '/hide'].includes(u.pathname)) {
      let raw = '';
      req.on('data', d => { raw += d; if (raw.length > 4e6) { req.destroy(); } });
      await new Promise(r => req.on('end', r));
      if (u.pathname === '/ignore') { last = '没导入，库里没动。'; return send(200, 'text/html; charset=utf-8', html({ batches, stored: rowsFromDb(), srcs: sourcesList(), msg: last })); }
      const f = new URLSearchParams(raw);
      if (u.pathname === '/hide') {
        // 页面上列出的那批 id 才允许被这次操作改，免得伪造一个 id 就把整库都隐藏了
        const ids = rowsFromDb().map(r => r.id);
        const show = ids.filter(id => f.get('s_' + id));
        const hide = ids.filter(id => !f.get('s_' + id));
        const a = setExcluded(show, false), b = setExcluded(hide, true);
        const { ag, wk } = await syncIsland();
        last = `显示状态改了：${a} 条重新显示、${b} 条隐藏（数据还在库里）；岛上近期 ${ag && ag.n != null ? ag.n : '?'} 条、整周 ${wk ? wk.n : '?'} 节都已同步。`;
        return send(200, 'text/html; charset=utf-8', html({ batches, stored: rowsFromDb(), srcs: sourcesList(), msg: last }));
      }
      const pick = [];
      const fixed = new Map();
      for (const [bi, b] of batches.entries()) {
        for (let i = 0; i < (b.events || []).length; i++) {
          const key = `${bi}:${i}`;
          if (!f.get('k_' + key)) continue;
          const st = fromDateInput(f.get('st_' + key) || '', !!b.events[i].allDay);
          if (st != null && st !== b.events[i].startMs) {
            const old = b.events[i];
            const dur = old.endMs != null && old.startMs != null ? old.endMs - old.startMs : (old.allDay ? 864e5 - 1 : 36e5);
            b.events[i] = { ...old, startMs: st, endMs: st + dur, durMs: dur, issues: (old.issues || []).filter(x => x.code !== 'no-start') };
            fixed.set(key, st);
          }
          pick.push({ bi, i });
        }
      }
      const byBi = new Map();
      for (const { bi, i } of pick) (byBi.get(bi) || byBi.set(bi, []).get(bi)).push(i);
      const notes = [];
      for (const [bi, idxs] of byBi) {
          const r = importBatch(idxs.map(i => batches[bi].events[i]), { source: as || batches[bi].name, fmt: batches[bi].fmt, enc: batches[bi].enc, note: batches[bi].path || '' });
          notes.push(`【${r.source}】写入 ${r.added} 条（重复 ${r.dup}、没时间 ${r.noStart}${fixed.size ? `、改过时间 ${fixed.size}` : ''}）${r.conflicts.length ? `，冲突 ${r.conflicts.length} 条：${r.conflicts.map(c => c.title).join('、')}` : ''}`);
      }
      batches = [];                       // 导完就空，避免同一份再点一次写两遍
      const { ag, wk } = await syncIsland();
      last = `${notes.join('；')||'没有勾上任何条目'}；岛屿那边现在有 ${ag && ag.n != null ? ag.n : '?'} 条近期事件、整周 ${wk ? wk.n : '?'} 节。`;
      return send(200, 'text/html; charset=utf-8', html({ batches, stored: rowsFromDb(), srcs: sourcesList(), msg: last }));
    }
    send(404, 'text/plain; charset=utf-8', '只有 / 、/import、/ignore、/api/schedule、/api/week 这几个口');
  });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  console.log(`预览页：http://127.0.0.1:${port}/   （Ctrl+C 关掉；不勾不导，点「确认导入」才写库）`);
  if (!process.env.CAL_NO_BROWSER) {
    try { execFileSync('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}/`], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  return new Promise(resolve => {
    const bye = () => { srv.close(); closeDb(); resolve(); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  });
}

if (/cal-preview\.mjs$/i.test(process.argv[1] || '')) {
  const p = +process.argv[process.argv.indexOf('--port') + 1] || 8733;
  await serve([], { port: p });
}
