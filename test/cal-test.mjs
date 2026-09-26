// calparse.mjs 的验收：拿各家「真实导出会长什么样」的字节喂它，而不是拿理想化的输入。
// 跑法：node cal-test.mjs                 全跑
//      node cal-test.mjs ics              只跑某一类
//      node cal-test.mjs --expect 58      同时要求分母是 58 条
// 判据是每条断言的期望值/实测值都打出来，最后给真实分母（多少条断言、过了几条）。
// 这个文件不含任何真实通知/日程内容， fixture 都是合成的，可以进公开仓库。
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseAny, decodeBytes } from '../src/schedule/calparse.mjs';
// expandOccurrences 是这一层该有但还没写的东西：用命名空间导入才不至于在 import 阶段就炸，
// 让它作为「整块缺失」被记成一条失败断言，而不是让整份测试跑不起来。
import * as CP from '../src/schedule/calparse.mjs';
const expandOccurrences = typeof CP.expandOccurrences === 'function' ? CP.expandOccurrences : null;

// 参数：[--expect N] [只跑某一类]
const ARGS = process.argv.slice(2);
let WANT = 0;
const POS = [];
for (let i = 0; i < ARGS.length; i++) {
  if (ARGS[i] === '--expect') { WANT = +ARGS[++i] || 0; continue; }
  if (ARGS[i].startsWith('-')) continue;
  POS.push(ARGS[i]);
}
const ONLY = POS[0] || '';
const DIR = mkdtempSync(join(tmpdir(), 'cal-fixture-'));
let n = 0, bad = 0;
const fails = [];

function eq(group, label, want, got) {
  if (ONLY && group !== ONLY) return;
  n++;
  const ok = JSON.stringify(want) === JSON.stringify(got);
  if (!ok) { bad++; fails.push(`${group} / ${label}`); console.log(`  FAIL ${label}\n        期望 ${JSON.stringify(want)}\n        实得 ${JSON.stringify(got)}`); }
  else console.log(`  ok   ${label} = ${JSON.stringify(got)}`);
}

// 断言「有这条问题」：按 code 找，不看顺序
function hasIssue(group, label, list, code) {
  if (ONLY && group !== ONLY) return;
  n++;
  const hit = list.some(x => x.code === code);
  if (!hit) { bad++; fails.push(`${group} / ${label}`); console.log(`  FAIL ${label}：期望有问题 ${code}，实际只有 ${JSON.stringify(list.map(x => x.code))}`); }
  else console.log(`  ok   ${label}（${code}）`);
}

const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

// ---------------------------------------------------------------- iCalendar
// 一份「什么怪事都有」的 ics：UTC / TZID / 浮空本地时间 / 全天 / 折叠行 / 转义 /
// VALARM / RRULE(COUNT,BYDAY,BYSETPOS) / 结束早于开始 / 缺 DTSTART / RECURRENCE-ID
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fixture//CN',
  // 1) UTC
  'BEGIN:VEVENT', 'UID:utc-1', 'SUMMARY:UTC 例会', 'DTSTART:20260928T130000Z', 'DTEND:20260928T140000Z',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:提醒', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT',
  // 2) TZID —— 和 1) 是同一个绝对时刻，用来验证时区真的换算了而不是当成本地时间
  'BEGIN:VEVENT', 'UID:tzid-1', 'SUMMARY:上海 21:00', 'DTSTART;TZID=Asia/Shanghai:20260928T210000', 'DURATION:PT1H', 'END:VEVENT',
  // 3) 全天三天（DTEND 是排他的次日）
  'BEGIN:VEVENT', 'UID:allday-1', 'SUMMARY:出差', 'DTSTART;VALUE=DATE:20260926', 'DTEND;VALUE=DATE:20260929', 'END:VEVENT',
  // 4) 折叠行 + 转义（\, 和 \n）+ 未转义的 &
  //    RFC 5545 的折叠是「换行 + 行首一个空格」，不是反斜杠；这里把一句中文从中间折断。
  'BEGIN:VEVENT', 'UID:fold-1',
  'SUMMARY:项目\\,评审\\n第二行 关于 A&B',
  'DESCRIPTION:这一行开头有一个空格\\, 属于折叠续',
  ' 行，拼回去应该是一整句没有多余空格',
  'DTSTART:20260930T013000Z', 'END:VEVENT',
  // 5) 浮空本地时间（没 Z 没 TZID）
  'BEGIN:VEVENT', 'UID:floating-1', 'SUMMARY:浮空 08:00', 'DTSTART:20261001T080000', 'END:VEVENT',
  // 6) 每周三五，COUNT=6
  'BEGIN:VEVENT', 'UID:rr-1', 'SUMMARY:课表 每周三五', 'DTSTART;TZID=Asia/Shanghai:20260928T183000',
  'DTEND;TZID=Asia/Shanghai:20260928T200000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6', 'END:VEVENT',
  // 7) BYSETPOS 不支持 -> 要报出来
  'BEGIN:VEVENT', 'UID:rr-2', 'SUMMARY:奇怪的重复', 'DTSTART:20261001T000000Z', 'RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR', 'END:VEVENT',
  // 8) 结束早于开始
  'BEGIN:VEVENT', 'UID:bad-1', 'SUMMARY:时间倒挂', 'DTSTART:20261005T100000Z', 'DTEND:20261005T090000Z', 'END:VEVENT',
  // 9) 没有 DTSTART
  'BEGIN:VEVENT', 'UID:nostart-1', 'SUMMARY:没开始时间', 'END:VEVENT',
  // 10) 单条改期实例
  'BEGIN:VEVENT', 'UID:ovr-1', 'SUMMARY:改期来的实例', 'DTSTART:20261008T070000Z', 'RECURRENCE-ID:20261008T060000Z', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

{
  const r = parseAny(Buffer.from('\uFEFF' + ICS, 'utf8'), { name: 'mixed.ics' });
  console.log(`\n== ics：解析出 ${r.events.length} 条（写进去 10 个 VEVENT），编码 ${r.enc}，BOM ${r.bom}`);
  const by = k => r.events.find(e => e.uid === k) || {};
  eq('ics', '条数', 10, r.events.length);
  eq('ics', 'BOM 认出来', true, !!r.bom);
  eq('ics', 'UTC 那条 startMs', U(2026, 9, 28, 13), by('utc-1').startMs);
  eq('ics', 'TZID Asia/Shanghai 21:00 -> 同一个绝对时刻', by('utc-1').startMs, by('tzid-1').startMs);
  eq('ics', 'TZID 那条 tz 字段', 'Asia/Shanghai', by('tzid-1').tz);
  eq('ics', 'VALARM 提前分钟', 15, (by('utc-1').alarms[0] || {}).beforeMin);
  eq('ics', 'DURATION 推出来的时长', 3600000, by('tzid-1').durMs);
  eq('ics', '全天标记', true, by('allday-1').allDay);
  eq('ics', '全天事件不该报「按本机时区解释」', false, (by('allday-1').issueList || []).some(x => x.code === 'tz-assumed'));
  eq('ics', '全天三天 endMs = start+3d-1ms', 3 * 864e5 - 1, by('allday-1').endMs - by('allday-1').startMs);
  eq('ics', '折叠行拼回去（不吞换行、不留续行空格）',
    '这一行开头有一个空格, 属于折叠续行，拼回去应该是一整句没有多余空格', by('fold-1').note);
  eq('ics', 'SUMMARY 里的 \\, 和 \\n', '项目,评审\n第二行 关于 A&B', by('fold-1').title);
  hasIssue('ics', '浮空时间要报「按本机时区解释」', by('floating-1').issueList || [], 'tz-assumed');
  eq('ics', '浮空那条按本机时区读成 08:00', new Date('2026-10-01T08:00').getTime(), by('floating-1').startMs);
  eq('ics', 'RRULE 解析', 'WEEKLY', by('rr-1').rrule.FREQ);
  eq('ics', 'RRULE BYDAY', 'MO,WE,FR', by('rr-1').rrule.BYDAY);
  eq('ics', 'RRULE COUNT', '6', by('rr-1').rrule.COUNT);
  hasIssue('ics', 'BYSETPOS 要报不支持', by('rr-2').issueList || [], 'rrule-unsupported');
  hasIssue('ics', '结束早于开始要报', by('bad-1').issueList || [], 'end-before-start');
  eq('ics', '结束早于开始要被纠正成 +60 分钟', 3600000, by('bad-1').durMs);
  hasIssue('ics', '缺 DTSTART 要报', by('nostart-1').issueList || [], 'no-start');
  hasIssue('ics', 'RECURRENCE-ID 要报没按覆盖处理', by('ovr-1').issueList || [], 'recurrence-override');
}

// ---------------------------------------------------------------- 重复展开
// 展不开等于「岛上今天没日程」，这层比解析更容易出错，单独测。
{
  const r = parseAny(Buffer.from(ICS, 'utf8'), { name: 'mixed.ics' });
  const by = k => r.events.find(e => e.uid === k);
  console.log('\n== 重复展开 expandOccurrences ==');
  if (!expandOccurrences) {
    console.log('  calparse.mjs 还没有导出 expandOccurrences（这一步整块缺失）');
    n++; bad++; fails.push('ics-expand / 没有导出');
  } else {
    // 9/28 是周一。WEEKLY;BYDAY=MO,WE,FR;COUNT=6 从 9/28 起 = 9/28、9/30、10/2、10/5、10/7、10/9
    const got = expandOccurrences(by('rr-1'), U(2026, 9, 28), U(2026, 10, 31));
    eq('ics-expand', '每周三五 COUNT=6 的日期', ['09-28', '09-30', '10-02', '10-05', '10-07', '10-09'],
      got.map(t => new Date(t + 8 * 36e5).toISOString().slice(5, 10)));
    const daily = { ...by('floating-1'), rrule: { FREQ: 'DAILY', INTERVAL: '2' } };
    // 窗口含头不含尾：10/1、10/3、10/5、10/7、10/9 在 [10/1, 10/11) 内，10/11 那天不算
    eq('ics-expand', '每 2 天，10 天窗口内出现几次', 5, expandOccurrences(daily, U(2026, 10, 1), U(2026, 10, 11)).length);
    eq('ics-expand', '不重复的事件也返回一次', 1, expandOccurrences(by('utc-1'), U(2026, 9, 1), U(2026, 12, 1)).length);
    eq('ics-expand', '窗口外不返回', 0, expandOccurrences(by('utc-1'), U(2026, 11, 1), U(2026, 12, 1)).length);
  }
}

// ---------------------------------------------------------------- CSV
const GCSV = [
  'Event,Subject,Start Date,All Day Event,Description,Location,Start Time,End Date,Reminder,End Time,Participants,Repeat Details',
  '1,英文例会,2026/9/28,,带 Z 的那种,,9:00 PM,2026/9/28,30 minutes ahead,10:00 PM,"张三, 李四",',
  '2,全天体检,2026/9/29,True,,,,,,False,0,Weekly on Monday,',
  '',
].join('\r\n');

{
  const r = parseAny(Buffer.from('\uFEFF' + GCSV, 'utf8'), { name: 'google.csv' });
  console.log(`\n== csv(Google 导出样式，日期与时间分两列)：${r.events.length} 条，编码 ${r.enc}`);
  eq('csv', '条数', 2, r.events.length);
  const a = r.events[0] || {}, b = r.events[1] || {};
  eq('csv', '标题列认对', '英文例会', a.title);
  // Google 的 9:00 PM 在「Start Time」列里。只吃 Start Date 的话这条会变成 00:00。
  // Google 的 9:00 PM 在「Start Time」列里。只吃 Start Date 那条列的话这条会落到 00:00。
  eq('csv', '日期列+时间列合起来 = 21:00 本地', new Date(2026, 8, 28, 21, 0).getTime(), a.startMs);
  eq('csv', '全天列 True 认出来', true, !!b.allDay);
  eq('csv', '提醒 30 minutes ahead', 30, ((a.alarms||[])[0] || {}).beforeMin);
  eq('csv', '参与者拆开了', ['张三', '李四'], a.attendees);
  eq('csv', 'Weekly on Monday 认成 WEEKLY/MO', 'MO', (a.rrule || b.rrule || {}).BYDAY);
}

// vivo 那边导出的中文表头 + GBK 编码（国内老 app 常见）
{
  const CN = ['主题,开始时间,结束时间,是否全天,重复,提醒,地点,备注,参与者,日程ID',
    '课题组组会,2026/9/28 14:00,2026/9/28 15:30,否,每周 周一,提前15分钟,东一301,讲进度,王老师; 小李,8801',
    '毕设开题,2026/10/12 下午2:30,2026/10/12 下午3:30,否,,,主楼 B3,带打印稿,,8802',
    '坏的一行,不是日期,2026/9/28 15:30,否,,,,,,8803', ''].join('\r\n');
  const f = join(DIR, 'vivo-gbk.csv');
  writeFileSync(f, CN, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `$t=[System.IO.File]::ReadAllText('${f}',[System.Text.Encoding]::UTF8);` +
    `[System.IO.File]::WriteAllText('${f}', $t, [System.Text.Encoding]::GetEncoding('GB2312'))`]);
  const r = parseAny(readFileSync(f), { name: 'vivo-gbk.csv' });
  console.log(`\n== csv(中文表头 + GBK)：${r.events.length} 条，编码 ${r.enc}`);
  eq('csv-cn', 'GBK 认得出来', true, /gb/i.test(String(r.enc)));
  eq('csv-cn', '条数', 3, r.events.length);
  const e = r.events[0] || {};
  eq('csv-cn', '中文表头映射到标题', '课题组组会', e.title);
  eq('csv-cn', '2026/9/28 14:00 本地', new Date(2026, 8, 28, 14, 0).getTime(), e.startMs);
  eq('csv-cn', '下午2:30 认成 14:30', new Date(2026, 9, 12, 14, 30).getTime(), (r.events[1] || {}).startMs);
  eq('csv-cn', '「每周 周一」展开成 BYDAY', 'MO', (e.rrule || {}).BYDAY);
  eq('csv-cn', '「提前15分钟」是提前 15 分钟不是 0', 15, (e.alarms[0] || {}).beforeMin);
  eq('csv-cn', '地点/备注/参与者都拿到了', ['东一301', '讲进度', 2], [e.location, e.note, e.attendees.length]);
  hasIssue('csv-cn', '日期列是「不是日期」要报问题', (r.events[2] || {}).issueList || [], 'no-start');
}

// ---------------------------------------------------------------- JSON
{
  const J = JSON.stringify({ items: [
    { id: 'j1', summary: 'JSON 会议', location: '线上',
      start: { dateTime: '2026-09-28T21:00:00+08:00' }, end: { dateTime: '2026-09-28T22:00:00+08:00' },
      attendees: [{ email: 'a@x.com' }, { displayName: '王老师', email: 'b@x.com' }] },
    { id: 'j2', summary: 'JSON 全天', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } },
    { id: 'j3', summary: '没时间的', start: {} },
  ] });
  const r = parseAny(Buffer.from(J, 'utf8'), { name: 'google.json' });
  console.log(`\n== json(Google Calendar API 样式)：${r.events.length} 条，识别格式 ${r.fmt}`);
  eq('json', '条数', 3, r.events.length);
  eq('json', '+08:00 换算成本机无关的绝对时刻', U(2026, 9, 28, 13), (r.events[0] || {}).startMs);
  eq('json', 'date 形式是全天', true, !!(r.events[1] || {}).allDay);
  hasIssue('json', '空 start 要报', (r.events[2] || {}).issueList || [], 'no-start');
}

// ---------------------------------------------------------------- vivo/安卓 content query
{
  // 真实 content query 是「一行一条」，值里可以带 = 和逗号，所以不能按逗号切。
  const A = [
    'Row: 0 _id=101, calendar_id=1, title=周会, eventLocation=东一301, description=带周报来的多行备注',
    ' , dtstart=1790600400000, dtend=1790604000000, allDay=0, eventTimezone=Asia/Shanghai, rrule=FREQ=WEEKLY;BYDAY=MO, event_status=0, availability=0',
    'Row: 1 _id=102, title=标题里有=号和, 逗号的日程, dtstart=1791129600000, allDay=1, eventTimezone=Asia/Shanghai',
    '',
  ].join('\r\n');
  const r = parseAny(Buffer.from(A, 'utf8'), { name: 'adb.out' });
  console.log(`\n== adb（content query 输出）：${r.events.length} 条，识别格式 ${r.fmt}`);
  eq('adb', '条数', 2, r.events.length);
  eq('adb', 'dtstart 是绝对毫秒', 1790600400000, (r.events[0] || {}).startMs);
  eq('adb', 'nativeId', '101', (r.events[0] || {}).nativeId);
  eq('adb', '标题里含 = 和 , 没被切碎', '标题里有=号和, 逗号的日程', (r.events[1] || {}).title);
  eq('adb', '全天事件标记', true, !!(r.events[1] || {}).allDay);
  eq('adb', '缺 dtend 的全天事件补一整天', 86400000 - 1, (r.events[1] || {}).durMs);
  eq('adb', 'rrule 认出来', 'WEEKLY', ((r.events[0] || {}).rrule || {}).FREQ);
}

// ---------------------------------------------------------------- 编码与嗅探
{
  const one = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:UTF-16 的标题\r\nDTSTART:20260928T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const f16 = join(DIR, 'u16.ics');
  writeFileSync(f16, '﻿' + one, 'utf16le');
  const r = parseAny(readFileSync(f16), { name: 'u16.ics' });
  console.log(`\n== 编码/嗅探`);
  eq('enc', 'UTF-16LE 能解出标题', 'UTF-16 的标题', (r.events[0] || {}).title);
  const gb = decodeBytes(Buffer.from('主题,开始时间\r\n测试,2026/9/28 14:00\r\n', 'utf8'));
  eq('enc', '纯 ASCII 不误判成 GBK', true, /utf-?8/i.test(gb.enc));
  const mis = parseAny(Buffer.from(GCSV, 'utf8'), { name: '其实叫.ics.csv' });
  eq('sniff', '内容是 CSV 就不管扩展名', 'csv', mis.fmt);
  const junk = parseAny(Buffer.from('乱七八糟 没有结构\r\n第二行\r\n', 'utf8'), { name: 'junk.txt' });
  hasIssue('sniff', '认不出格式要给 --format 建议', junk.issues, 'unknown-format');
  const forced = parseAny(Buffer.from(ICS, 'utf8'), { name: 'x.bin', format: 'ics' });
  eq('sniff', '--format 强制指定能绕过嗅探', 10, forced.events.length);
  const empty = parseAny(Buffer.from('', 'utf8'), { name: 'empty.ics' });
  hasIssue('sniff', '空文件要报（不能静默 0 条）', empty.issues, 'empty');
}

// 断言数本身也要有判据：改坏了 fixture 让断言「悄悄少了几条」，只看 failed=0 是查不出来的。
if (WANT && n !== WANT) { bad++; fails.push(`分母 / 断言 ${n} 条 != --expect ${WANT} 条（有断言没跑到或被删了）`); console.log(`断言 ${n} 条 != --expect ${WANT} 条（有断言没跑到或被删了）`); }
console.log(`\n分母：断言 ${n} 条，失败 ${bad} 条 -> ${bad === 0 ? 'PASS' : 'FAIL'}`);
if (bad) console.log('没过的：\n  ' + fails.join('\n  '));
process.exit(bad ? 1 : 0);
