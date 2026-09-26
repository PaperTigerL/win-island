// calview.mjs —— 「一条日程该显示成什么样」只有这一份口径：命令行、预览页、岛上的日程段都用它。
// 单独成模块是为了断开 cal-import ↔ cal-preview 的循环 import（绕进去过，常驻进程会自己退出）。
// 这里只做展示，不碰库、不碰网络；正文一律原样带出，转义发生在渲染那一层。
const p2 = x => String(x).padStart(2, '0');
export const whenCn = ms => {
  if (ms == null) return '（没时间）';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}(${['日', '一', '二', '三', '四', '五', '六'][d.getDay()]}) ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const WD_CN = { SU: '日', MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六' };
// rrule → 一句人话，只覆盖展开层真的支持的几种；认不出的原样带出来，不猜。
export function repeatCn(rr) {
  if (!rr || !rr.FREQ) return '';
  const f = { DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月', YEARLY: '每年' }[rr.FREQ] || rr.FREQ;
  const n = rr.INTERVAL && +rr.INTERVAL !== 1 ? `${f}×${rr.INTERVAL}` : f;
  const raw = String(rr.BYDAY || '');
  const days = raw.split(',').filter(Boolean).map(s => '周' + (WD_CN[s.replace(/^[+-]?\d+/, '')] || s)).join('、');
  const ord = /(?:^|,)[+-]?\d+[A-Z]{2}/.test(raw) ? '（第几个/最后一个）' : '';
  const tail = rr.COUNT ? `，共 ${rr.COUNT} 次` : rr.UNTIL ? `，直到 ${rr.UNTIL}` : '';
  return `${n}${days ? ' ' + days + ord : ''}${tail}`;
}
export const alarmCn = list => (list || []).map(a => (a.beforeMin == null ? '提醒' : `提前 ${a.beforeMin} 分钟`)).join('、');

// ev 可以是解析层的原始事件，也可以是库里读出来的行（字段名一致）。
export function view(ev, i = 1) {
  const issues = ev.issueList || ev.issues || [];
  return {
    i, source: ev.source, uid: ev.uid, id: ev.id ?? null,
    title: ev.title || '（无标题）', when: whenCn(ev.startMs), end: whenCn(ev.endMs),
    allDay: !!ev.allDay, repeat: ev.rrule ? repeatCn(ev.rrule) : (ev.repeat || ''),
    alarm: ev.alarms ? alarmCn(ev.alarms) : (ev.alarm || ''),
    where: ev.location || '', note: ev.note || '',
    attendees: Array.isArray(ev.attendees) ? ev.attendees.join('、') : String(ev.attendees || ''),
    categories: ev.categories || '', tz: ev.tz || '', startMs: ev.startMs, endMs: ev.endMs,
    issues: issues.map(x => `${x.msg || x.code}（${x.code}）`),
    codes: issues.map(x => x.code),
  };
}
