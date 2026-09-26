// cal-pull.mjs —— 手机（iQOO / OriginOS）那头的取数：能自动化的只有 adb，其余都得他手动点。
// 每一步都把「卡在哪」原样打出来，不猜、不假装拉到了。
//   node cal-pull.mjs                 只诊断 + 拉一份到 %LOCALAPPDATA%\win-island\cal-inbox\
//   node cal-pull.mjs --import        拉完直接进预览/入库（等价于 cal-import --commit --as 手机）
//   node cal-pull.mjs --via-files     跳过 content query，只从 /sdcard/Download 里捡他手动导出的 ics/csv
// 权限这件事的机制：content query 是以 shell uid(2000) 跑的，OriginOS 给 READ_CALENDAR 是否放行
// 要在真机上验一次才知道；被拒时输出里会有 Permission Denial，这条分支就是给它准备的。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { decodeBytes } from './calparse.mjs';
import { DATA } from './calstore.mjs';

const INBOX = join(DATA, 'cal-inbox');
const PROJ_EVENTS = '_id:calendar_id:title:eventLocation:description:dtstart:dtend:allDay:eventTimezone:rrule:eventColorCategory:status';
const CAND = [
  'adb',
  join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:\\platform-tools\\adb.exe', 'D:\\platform-tools\\adb.exe',
  join(process.env.USERPROFILE || '', 'scoop', 'shims', 'adb.exe'),
];

export function findAdb() {
  for (const c of CAND) {
    try { const v = execFileSync(c === 'adb' ? 'adb' : c, ['version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      if (/Android Debug Bridge/i.test(v)) return { adb: c, version: v.split(/\r?\n/)[0].trim() };
    } catch { /* 这个位置没有，试下一个 */ }
  }
  return null;
}
const run = (adb, args, ms = 20000) => {
  try {
    const out = execFileSync(adb, args, { maxBuffer: 64e6, timeout: ms, windowsHide: true });
    return { ok: true, text: decodeBytes(out).text };
  } catch (e) {
    const raw = Buffer.concat([e.stdout || Buffer.alloc(0), e.stderr || Buffer.alloc(0)]);
    return { ok: false, text: decodeBytes(raw).text || e.message, denied: /Permission Denial|not allowed/i.test(decodeBytes(raw).text || '') };
  }
};

export function devices(adb) {
  const r = run(adb, ['devices', '-l']);
  if (!r.ok) return { list: [], raw: r.text };
  const list = r.text.split(/\r?\n/).slice(1)
    .map(l => /^(\S+)\s+(device|unauthorized|offline)\b(.*)$/.exec(l))
    .filter(Boolean).map(m => ({ serial: m[1], state: m[2], model: (/model:(\S+)/.exec(m[3]) || [])[1] || '' }));
  return { list, raw: r.text };
}

// content query 的转储长得和 calparse.parseAdbDump 吃的一样，直接就能喂解析器。
export function contentQuery(adb, serial, uri, projection) {
  return run(adb, ['-s', serial, 'shell', 'content', 'query', '--uri', uri, '--projection', projection], 60000);
}

// 提醒存在另一张表：不 join 进来，手机上设的闹钟就全丢了。
export function mergeReminders(events, dump) {
  if (!dump || !dump.ok) return { merged: 0, why: dump ? (dump.denied ? 'Permission Denial' : dump.text.split(/\r?\n/)[0]) : '没查' };
  const rows = dump.text.split(/\r?\n/).filter(l => /event_id=/.test(l));
  let merged = 0;
  for (const l of rows) {
    const id = /(?:^|,)\s*event_id=(\d+)/.exec(l)?.[1];
    const min = /(?:^|,)\s*(?:minutes|startDay)=(\d+)/.exec(l)?.[1];
    const ev = events.find(e => String(e.nativeId) === String(id));
    if (!ev || min == null) continue;
    ev.alarms = [...(ev.alarms || []), { beforeMin: +min, method: '弹窗' }];
    merged++;
  }
  return { merged, rows: rows.length };
}

export function pull({ adbPath = '', viaFiles = false } = {}) {
  const log = [];
  const found = adbPath ? { adb: adbPath, version: '(指定)' } : findAdb();
  if (!found) {
    log.push('这一步就没过：机器上没找到 adb（试过 PATH 和几个常见 SDK 目录）。要么装 platform-tools，要么走「手机上手动导出到「下载」目录 → 插数据线在「此电脑」里拖出来」那条路。');
    return { step: 'no-adb', log, files: [] };
  }
  log.push(`adb：${found.adb}（${found.version}）`);
  const dv = devices(found.adb);
  if (!dv.list.length) {
    log.push('没看到设备。手机那边要满足：设置 → 关于手机 → 连续点版本号开开发者选项 → 开发者选项里打开「USB 调试」；插上线后通知栏选「传输文件（MTP）」而不是「仅充电」。选「仅充电」时 adb 一个字节都看不到。');
    return { step: 'no-device', log, files: [], devices: [] };
  }
  log.push('设备：' + dv.list.map(d => `${d.serial}${d.model ? ' ' + d.model : ''} [${d.state}]`).join('、'));
  const dev = dv.list.find(d => d.state === 'device');
  if (!dev) {
    log.push(dv.list.some(d => d.state === 'unauthorized')
      ? '连上了但没授权：手机上应该弹了「允许 USB 调试吗？」，勾「一律允许」再点允许。没弹就把线拔了重插一次。'
      : '设备是 offline 状态：在手机上关掉再打开 USB 调试。');
    return { step: 'unauthorized', log, devices: dv.list };
  }
  const out = { step: 'ok', log, files: [] };
  mkdirSync(INBOX, { recursive: true });
  if (!viaFiles) {
    const ev = contentQuery(found.adb, dev.serial, 'content://com.android.calendar/events', PROJ_EVENTS);
    if (!ev.ok) {
      log.push(ev.denied
        ? `content query 被拒（Permission Denial）。机制：这条命令以 shell uid(2000) 跑，OriginOS 没给它 READ_CALENDAR。adb 给 shell 授权要手机上「USB 调试（安全设置）」打开，而那一档通常要求登录账号才能开——所以改走手动导出。`
        : `content query 失败：${ev.text.split(/\r?\n/).slice(0, 3).join(' / ')}`);
      out.step = 'denied';
    } else {
      const f = join(INBOX, 'events.out');
      writeFileSync(f, ev.text, 'utf8');
      log.push(`事件表：${ev.text.split(/\r?\n/).filter(l => /_id=/.test(l)).length} 行，落到 ${f}`);
      out.files.push(f);
      const rm = contentQuery(found.adb, dev.serial, 'content://com.android.calendar/reminders', 'event_id:minutes:method:when');
      const rf = join(INBOX, 'reminders.out');
      if (rm.ok) { writeFileSync(rf, rm.text, 'utf8'); out.reminders = rf; log.push('提醒表一并拉了：' + rf); }
      else log.push(`提醒表没拉到（不影响事件本体）：${rm.text.split(/\r?\n/)[0]}`);
    }
    const cal = contentQuery(found.adb, dev.serial, 'content://com.android.calendar/calendars', '_id:name:account_name:type');
    if (cal.ok) { writeFileSync(join(INBOX, 'calendars.out'), cal.text, 'utf8'); log.push('日历账户表也拉了一份（去重时能分清哪个日历）'); }
  }
  // 不管 content query 成不成，都再捡一遍他手动导出的文件：下载目录是 MTP 能看见的，这条路一定通。
  const ls = run(found.adb, ['-s', dev.serial, 'shell', 'ls', '-l', '/sdcard/Download']);
  if (!ls.ok) log.push('/sdcard/Download 列目录失败：' + ls.text.split(/\r?\n/)[0]);
  else {
    const hits = ls.text.split(/\r?\n/).map(l => l.trim().split(/\s+/).slice(-1)[0])
      .filter(f => /\.(ics|ifb|csv|json|txt|db)$/i.test(f) && !f.includes(' '));
    if (!hits.length) log.push('下载目录里没有 .ics/.csv/.json 这类文件（先按上面那条被拒的原因处理）。');
    for (const f of hits.slice(0, 20)) {
      const dest = join(INBOX, basename(f));
      const cp = run(found.adb, ['-s', dev.serial, 'pull', '/sdcard/Download/' + f, dest]);
      if (cp.ok && existsSync(dest) && statSync(dest).size) { out.files.push(dest); log.push(`拉下来 ${basename(f)}（${statSync(dest).size} 字节）`); }
      else log.push(`pull ${f} 没成功：${cp.text.split(/\r?\n/)[0]}`);
    }
  }
  return out;
}

if (/cal-pull\.mjs$/i.test(process.argv[1] || '')) {
  const ai = process.argv.indexOf('--adb');
  const adbPath = ai >= 0 && !String(process.argv[ai + 1] || '').startsWith('--') ? process.argv[ai + 1] : '';
  const r = pull({ adbPath, viaFiles: process.argv.includes('--via-files') });
  const files = r.files || [];
  console.log('\n' + r.log.map(l => '· ' + l).join('\n'));
  console.log(`\n结论：${r.step}${files.length ? `，取到 ${files.length} 份，目录 ${INBOX}` : '，这次一份都没取到'}`);
  if (files.length) {
    const { parseAll, commitBatch, previewText } = await import('./cal-import.mjs');
    const batches = parseAll(files.map(f => ({ path: f, name: basename(f) })), {});
    // 手机上设的提醒在另一张表里，不并进来就等于「闹钟全丢了」
    if (r.reminders && existsSync(r.reminders)) {
      const text = decodeBytes(readFileSync(r.reminders)).text;
      for (const b of batches) {
        const m = mergeReminders(b.events, { ok: true, text });
        if (m.merged) console.log(`提醒并到 ${m.merged} 条事件上（表里共 ${m.rows} 行）`);
      }
    }
    if (process.argv.includes('--import')) {
      for (const b of batches) {
        const res = commitBatch(b, { as: '手机' });
        console.log(`入库「${res.source}」：写 ${res.added} 条，重复 ${res.dup}，没时间 ${res.noStart}${res.conflicts.length ? `，冲突 ${res.conflicts.length} 条` : ''}`);
        for (const c of res.conflicts) console.log(`  ！${c.title} @ ${new Date(c.startMs).toLocaleString('zh-CN')}，${c.alsoIn.join('/')} 里也有一份`);
      }
      // 和命令行导入走同一条重建：agenda 和整周两份一起，只刷一份岛上会出两个版本
      const { afterWrite } = await import('./cal-import.mjs');
      await afterWrite();
    } else {
      console.log('\n先给一份预览（库里一个字没动）：');
      console.log(previewText(batches));
      console.log('\n看着对就加 --import 再跑一次。');
    }
  }
}
