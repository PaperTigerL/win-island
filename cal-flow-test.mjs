// cal-flow-test.mjs —— 日程导入这条链路的端到端验收：
// 合成文件（ics / Google 的 csv / vivo 那种中文表头+GBK / adb 转储）→ 解析 → 入库 → 去重/替换/冲突
// → 重复展开 → 并进入岛的 agenda.json → 预览页真的发一次 POST 导入。
// 判据是「库里真的有几条、agenda.json 真的长什么样、页面真的返回了什么」，不是「脚本没报错」。
// 全程写临时目录（WIN_ISLAND_HOME），不碰 %LOCALAPPDATA%\win-island\cal.db；fixture 都是合成的。
process.env.WIN_ISLAND_HOME = process.env.CAL_TEST_HOME || (await import('node:os')).tmpdir() + '\\cal-flow-' + Date.now();
process.env.CAL_NO_BROWSER = '1';
const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
const { join } = await import('node:path');
const HOME = process.env.WIN_ISLAND_HOME;
mkdirSync(HOME, { recursive: true });

const { parseAll, collect } = await import('./cal-import.mjs');
const { view } = await import('./calview.mjs');
const { importBatch, listRows, sourcesList, itemsFor, stats, setExcluded, dropSource, closeDb } = await import('./calstore.mjs');
const { buildAgenda, fetchAgenda } = await import('./meta.mjs');

let n = 0, bad = 0; const fails = [];
function eq(label, want, got) {
  n++;
  const ok = JSON.stringify(want) === JSON.stringify(got);
  if (!ok) { bad++; fails.push(label); console.log(`  FAIL ${label}\n        期望 ${JSON.stringify(want)}\n        实得 ${JSON.stringify(got)}`); }
  else console.log(`  ok   ${label} = ${JSON.stringify(got)}`);
}
const day = k => { const d = new Date(new Date().setHours(0, 0, 0, 0)); d.setDate(d.getDate() + k); return d; };
const icsDT = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;
const pad2 = x => String(x).padStart(2, '0');
const csvDate = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

// ---------------------------------------------------------------- 合成三份导出
const D1 = day(1); D1.setHours(10, 0, 0, 0);
const D1E = new Date(D1.getTime() + 36e5);
const D2 = day(2); D2.setHours(14, 30, 0, 0);
const XSS = '<img src=x onerror=alert(1)>';

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fixture//CN',
  'BEGIN:VEVENT', 'UID:flow-1', 'SUMMARY:周会 ' + XSS, 'LOCATION:东一301',
  'DTSTART;TZID=Asia/Shanghai:' + icsDT(D1), 'DTEND;TZID=Asia/Shanghai:' + icsDT(D1E),
  'RRULE:FREQ=WEEKLY;BYDAY=' + ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][D1.getDay()],
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:flow-2', 'SUMMARY:没写时间的日程', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');
const fIcs = join(HOME, 'flow.ics'); writeFileSync(fIcs, '\uFEFF' + ICS, 'utf8');

const CSV = ['Subject,Start Date,Start Time,End Date,End Time,All Day Event,Reminder,Attendees,Description',
  `网页同步的例会,${csvDate(D1)},${pad2(D1.getHours())}:00:00,${csvDate(D1E)},${pad2(D1E.getHours())}:00:00,False,15 minutes ahead,,`,
  `毕设开题,${csvDate(D2)},14:30:00,${csvDate(D2)},15:30:00,False,,,带打印稿`, ''].join('\r\n');
const fCsv = join(HOME, 'google.csv'); writeFileSync(fCsv, '\uFEFF' + CSV, 'utf8');

const ADB = ['Row: 0 _id=501, calendar_id=1, title=手机上的课, eventLocation=主楼 B3, description=带笔记本',
  ` , dtstart=${D1.getTime()}, dtend=${D1E.getTime()}, allDay=0, eventTimezone=Asia/Shanghai, rrule=FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][D1.getDay()]}`,
  `Row: 1 _id=502, title=全天占位, dtstart=${day(3).setHours(0, 0, 0, 0)}, allDay=1, eventTimezone=Asia/Shanghai`, ''].join('\r\n');
const fAdb = join(HOME, 'phone.out'); writeFileSync(fAdb, ADB, 'utf8');

// ---------------------------------------------------------------- 1) 解析预览不写库
console.log('\n== 1) 预览阶段不碰库');
const batches = parseAll(collect([HOME]), {});
eq('预览到几份文件', 3, batches.length);
eq('预览不写库：stats', { rows: 0, excluded: 0, sources: 0 }, (({ rows, excluded, sources }) => ({ rows, excluded, sources }))(stats()));
const icsB = batches.find(b => b.name === 'flow.ics') || { events: [] };
eq('ics 里条数', 2, icsB.events.length);
eq('没时间那条只报 no-start（标题是有的，不瞎报第二条）', ['no-start'], (view(icsB.events[1], 2).codes));
eq('标题里的尖括号原样存着（转义发生在渲染那一层）', '周会 ' + XSS, icsB.events[0].title);
eq('15 分钟提醒换算对', 15, (icsB.events[0].alarms[0] || {}).beforeMin);
eq('周会的绝对时刻就是本地 10:00', D1.getTime(), icsB.events[0].startMs);

// ---------------------------------------------------------------- 2) 入库 / 去重 / 整批替换
console.log('\n== 2) 入库、重复导入、按来源整批替换');
const r1 = importBatch(icsB.events, { source: 'flow.ics', fmt: icsB.fmt });
eq('写入数（没时间的不入库）', { added: 1, noStart: 1, dup: 0 }, { added: r1.added, noStart: r1.noStart, dup: r1.dup });
const sameFile = parseAll([{ path: fIcs, name: 'flow.ics' }], {});
const r2 = importBatch(sameFile[0].events, { source: 'flow.ics', fmt: 'ics' });
eq('同一来源再导一次：条数不涨', 1, listRows({}).length);
eq('第二次导入也是 1 条入账', 1, r2.added);
eq('来源表只有一条', 1, sourcesList().length);

// 同一批里 uid+时间撞两次 → 算重复
const dupBatch = importBatch([{ uid: 'z', startMs: D1.getTime(), title: 'a' }, { uid: 'z', startMs: D1.getTime(), title: 'a' }], { source: 'dup' });
eq('同批撞键算重复', { added: 1, dup: 1 }, { added: dupBatch.added, dup: dupBatch.dup });
eq('dup 这个来源可以整批删掉', 1, dropSource('dup'));
eq('删干净了', 0, listRows({ source: 'dup' }).length);

// ---------------------------------------------------------------- 3) 跨来源同一条只报冲突
console.log('\n== 3) 跨来源撞同一条：两边都留，只报冲突');
const csvB = parseAll([{ path: fCsv, name: 'google.csv' }], {})[0];
const rc = importBatch(csvB.events, { source: 'google.csv', fmt: csvB.fmt });
eq('csv 写入 2 条', 2, rc.added);
const same = (csvB.events[0] || {});
eq('csv 那条例会的时间戳和 ics 那条同一个绝对时刻', D1.getTime(), same.startMs);
// 上面两条 uid 不同（ics 是 flow-1，csv 没给 id 会自己编一个），所以先构造真会撞的：
const clash = importBatch([{ uid: 'flow-1', startMs: D1.getTime(), title: '手机上的同一节课' }], { source: 'phone' });
eq('跨来源同 uid+同时间 → 报 1 条冲突', 1, clash.conflicts.length);
eq('冲突里点名另一边是谁', ['flow.ics'], clash.conflicts[0].alsoIn);
eq('两边都留着，不自动合并', 2, listRows({}).filter(r => r.uid === 'flow-1').length);
eq('来源一共 3 个', 3, sourcesList().length);

// ---------------------------------------------------------------- 4) 重复规则在读的时候展开
console.log('\n== 4) 展开与勾选');
const adbB = parseAll([{ path: fAdb, name: 'phone.out' }], {})[0];
eq('adb 转储认成 adb 格式', 'adb', adbB.fmt);
const ra = importBatch(adbB.events, { source: 'phone.out', fmt: adbB.fmt });
eq('手机那份入库 2 条', 2, ra.added);
const win = [day(0).getTime(), day(21).getTime()];
const occ = itemsFor(...win);
const weekly = occ.filter(x => x.title.startsWith('周会'));
eq('每周重复的周会在 3 周窗口里出现 3 次', 3, weekly.length);
eq('每次都是同一个本地钟点', [D1.getHours() + ':00', D1.getHours() + ':00', D1.getHours() + ':00'], weekly.map(x => new Date(x.s).getHours() + ':00'));
eq('全天那条也在（第 3 天）', true, occ.some(x => x.allDay && x.title === '全天占位'));
const ids = listRows({}).filter(r => r.title === '毕设开题').map(r => r.id);
eq('勾掉一条：受影响 1 行', 1, setExcluded(ids, true));
eq('勾掉的不再展开', false, itemsFor(...win).some(x => x.title === '毕设开题'));
setExcluded(ids, false);
eq('取消勾选又回来了', true, itemsFor(...win).some(x => x.title === '毕设开题'));

// ---------------------------------------------------------------- 5) 并进入岛的 agenda.json（契约不变）
console.log('\n== 5) agenda.json 的契约');
const a = buildAgenda([], Date.now());
eq('字段一个没多一个没少', ['at', 'n', 'days', 'srcs', 'next', 'errors'], Object.keys(a));
eq('远端源为 0 时本机库照样出条目', true, a.n > 0);
eq('来源里标了「本机导入」', true, (a.srcs[0] || {}).name === '本机导入');
eq('全天那条排在所有有时点条目之前', true, (() => {
  const list = a.days.flatMap(d => d.events);
  const firstTimed = list.findIndex(x => !x.allDay);
  return firstTimed < 0 || !list.slice(firstTimed).some(x => x.allDay);
})());
eq('next 给了 inMin 和 today', true, !!(a.next && 'inMin' in a.next && 'today' in a.next));
eq('条目形状和原来一致', ['s', 'e', 'st', 'et', 'day', 'title', 'where', 'allDay', 'src'], Object.keys(a.days.flatMap(d => d.events)[0] || {}));
const af = await fetchAgenda(true);
eq('fetchAgenda 在「没配日历订阅但本机有库」时也照出', true, !!af && af.n > 0);
eq('agenda.json 真落到临时 HOME 里', true, existsSync(join(HOME, 'agenda.json')));
eq('落盘的 JSON 可解析且条数一致', af.n, JSON.parse(readFileSync(join(HOME, 'agenda.json'), 'utf8')).n);

// ---------------------------------------------------------------- 6) 预览页：真的 GET + POST
console.log('\n== 6) 预览页');
const { serve } = await import('./cal-preview.mjs');
const P = 8799;
const batches2 = parseAll([{ path: fIcs, name: '页面导入.ics' }], {});
serve(batches2, { port: P });
const base = `http://127.0.0.1:${P}/`;
let res = await fetch(base).catch(() => null);
for (let i = 0; i < 40 && !res; i++) { await new Promise(r => setTimeout(r, 100)); res = await fetch(base).catch(() => null); }
eq('首页 200', 200, res && res.status);
const body = res ? await res.text() : '';
eq('标题里的 <img> 被转义了（不让日程正文当 HTML 执行）', true, !/<img src=x/.test(body) && /&lt;img/.test(body));
eq('页面上能看到来源名', true, /页面导入\.ics/.test(body));
const before = listRows({ source: '页面导入.ics' }).length;
const form = new URLSearchParams();
form.set('k_0:0', 'on');                                    // 勾第 1 条
                                                                       // 第 2 条（没时间）不勾
const r3 = await fetch(base + 'import', { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
eq('POST /import 返回 200', 200, r3.status);
const after = listRows({ source: '页面导入.ics' }).length;
eq('勾 1 条就只写 1 条', before + 1, after);
eq('回执里说了写了几条', true, /写入 1 条/.test(await r3.text()));
const api = await fetch(base + 'api/schedule').then(r => r.json());
eq('/api/schedule 返回的是同一份 agenda 形状', ['at', 'n', 'days', 'srcs', 'next', 'errors'], Object.keys(api));
eq('/api/schedule 有内容', true, api.n > 0);

// 库里那一栏的勾选框是真能用的：取消勾 → 岛上不再显示这条（数据还在）
const from0 = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
const stored = listRows({ from: from0 - 864e5 });
const target = stored.find(r => r.title === '全天占位');
eq('页面上列得出的那条在', true, !!target);
const n0 = itemsFor(day(0).getTime(), day(21).getTime()).filter(x => x.title === '全天占位').length;
const form2 = new URLSearchParams();
for (const r of stored) if (r.id !== target.id) form2.set('s_' + r.id, 'on');
const r4 = await fetch(base + 'hide', { method: 'POST', body: form2.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
eq('POST /hide 返回 200', 200, r4.status);
eq('取消勾之后不再展开', 0, itemsFor(day(0).getTime(), day(21).getTime()).filter(x => x.title === '全天占位').length);
form2.set('s_' + target.id, 'on');
await fetch(base + 'hide', { method: 'POST', body: form2.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
eq('重新勾上又回来了', n0, itemsFor(day(0).getTime(), day(21).getTime()).filter(x => x.title === '全天占位').length);
eq('库里那条只是被标记，没被删', 1, listRows({}).filter(r => r.title === '全天占位').length);
const page2 = await (await fetch(base)).text();
eq('页面把库里那一栏包成了能提交的表单', true, /action="\/hide"/.test(page2));
closeDb();
const WANT = +process.argv[process.argv.indexOf('--expect') + 1] || 0;
if (WANT && n !== WANT) { bad++; fails.push(`分母 / 断言 ${n} 条 != --expect ${WANT} 条（有断言没跑到）`); }
console.log(`\n分母：断言 ${n} 条，失败 ${bad} 条 -> ${bad === 0 ? 'PASS' : 'FAIL'}`);
if (bad) console.log('没过的：\n  ' + fails.join('\n  '));
console.log(`（临时 HOME：${HOME}，没碰真实库；要人看的话 ${base}）`);
process.exit(bad ? 1 : 0);
