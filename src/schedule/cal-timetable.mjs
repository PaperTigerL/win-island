// 把教务系统「教学日历」那张课表表格转成 .ics，走 cal-import 那条已经验过的链路。
//
// 图里本来就没有的两样信息，在这里当常量给（改这两处就够了）：
//   1) 节次 → 具体时刻（学校作息表）；
//   2) 第 1 周对应哪一天（校历开学日）。
// 这两个值错了岛上就是错的，所以宁可写成显式常量、也不要让解析器去猜。
//
// 用法：node cal-timetable.mjs            只打印生成的 ics 到 timetable.ics
//       node cal-import.mjs timetable.ics --as 课程表 --serve   勾着看/改时刻再入库

import { writeFileSync } from 'node:fs';

const WEEK1_MONDAY = '2026-09-07';   // 示例：改成你学校第 1 周周一，图里读不出来
const TZID = 'Asia/Shanghai';

// 一门课占几节连排按学校作息给时刻。下午那档是按本校作息填的：14:30 上到 18:00，
// 也就是下午整段四节连排，不是我以为的两节。其余档自己核对，错了就改这里再重跑。
const SLOTS = {
  '1-2': ['08:00', '09:40'],
  '3-4': ['10:00', '11:40'],
  '5-8': ['14:30', '18:00'],
  '9-10': ['19:00', '20:40'],
  '11-12': ['21:00', '22:40'],
};

// day: 1=周一 … 7=周日；weeks: [起周, 止周]，闭区间
// 教师按周变的课（轮课）在这里拆成多段，岛上每一行显示的才是那一周真正的老师
const COURSES = [
  { day: 1, pair: '1-2', weeks: [2, 17], title: '示例课程A1班', teacher: '张老师', where: 'A1-101' },
  { day: 3, pair: '1-2', weeks: [2, 17], title: '示例课程A1班', teacher: '张老师', where: 'A1-101' },
  { day: 1, pair: '5-8', weeks: [2, 9], title: '示例课程B1班', teacher: '李老师', where: 'A2-202' },
  { day: 3, pair: '5-8', weeks: [10, 17], title: '示例课程C1班', teacher: '王老师', where: 'A2-203' },
  { day: 2, pair: '9-10', weeks: [2, 5], title: '示例课程D1班', teacher: '陈老师', where: 'B1-303' },
];

// 这门课整学期一个时段，但每周换老师：单开一条 + 把轮次表写进备注，比拆成 9 条好读
const ROTATION = {
  day: 4, pair: '5-8', weeks: [2, 10], title: '示例轮课1班', where: 'B2-404',
  byWeek: { 2: '赵老师', 3: '孙老师', 4: '李老师', 5: '周老师', 6: '孙老师', 7: '吴老师', 8: '郑老师', 9: '冯老师', 10: '赵老师' },
};

const WD = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

function mondayOf(week) {
  const m = new Date(WEEK1_MONDAY + 'T00:00:00');
  if (m.getDay() !== 1) throw new Error(`WEEK1_MONDAY=${WEEK1_MONDAY} 不是周一，先把它改对`);
  return new Date(m.getFullYear(), m.getMonth(), m.getDate() + (week - 1) * 7);
}
function nthWeekday(week, day) {
  const m = mondayOf(week);
  return new Date(m.getFullYear(), m.getMonth(), m.getDate() + (day - 1));
}
function fold(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 73) {
    out.push(s.slice(i, i + 73));
  }
  return out.join('\r\n ');
}
const esc = s => String(s).replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');

function event(c, i) {
  const [a, b] = c.weeks;
  const [st, et] = SLOTS[c.pair];
  const d = nthWeekday(a, c.day);
  const [sh, sm] = st.split(':').map(Number);
  const [eh, em] = et.split(':').map(Number);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh, sm);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em);
  const n = b - a + 1;
  const teacher = c.teacher ? `${c.teacher}：` : '';
  const note = c.byWeek
    ? '轮课，按周次：' + Object.entries(c.byWeek).map(([w, t]) => `第${w}周 ${t}`).join('、')
    : c.note || '';
  const uid = `tt2026qiu-${i}-${c.day}-${c.pair}-${a}-${b}@win-island`;
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART;TZID=${TZID}:${stamp(start)}`,
    `DTEND;TZID=${TZID}:${stamp(end)}`,
    `SUMMARY:${esc(`${teacher}${c.title}`)}`,
    `LOCATION:${esc(c.where || '')}`,
    note ? `DESCRIPTION:${esc(note)}` : null,
    `RRULE:FREQ=WEEKLY;BYDAY=${WD[c.day]};COUNT=${n}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    'DESCRIPTION:提前 30 分钟',
    'END:VALARM',
    'END:VEVENT',
  ].filter(Boolean).join('\r\n');
}

// 这门课整学期一个时段，但每周换老师。原来合成一条 + 把轮次表写进备注，
// 结果岛上那一行只显示课名、显示不出「这周是谁」—— 手机上的课程表周四那格是有
// 老师名的（拿手机上的课程表对照核过）。所以拆成一周一条，标题里带当周老师。
function unroll(rot) {
  const { byWeek, ...base } = rot;
  const table = Object.entries(byWeek).map(([w, t]) => `第${w}周 ${t}`).join('、');
  return Object.entries(byWeek).map(([w, t]) => ({
    ...base, weeks: [+w, +w], teacher: t, note: `轮课，这门课按周换老师：${table}`,
  }));
}

const all = [...COURSES, ...unroll(ROTATION)];
const ics = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//win-island//cal-timetable//CN',
  'CALSCALE:GREGORIAN',
  ...all.map(event),
  'END:VCALENDAR',
  '',
].join('\r\n');

const OUT = 'timetable.ics';
writeFileSync(new URL('./' + OUT, import.meta.url), ics);
console.log(`生成 ${all.length} 门课（节次对展开后）→ ${OUT}`);
console.log(`第 1 周周一 = ${WEEK1_MONDAY}；节次表 ${Object.keys(SLOTS).join(' ')} —— 这两处不对就改文件顶部常量再重跑`);
