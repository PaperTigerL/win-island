// cal-import.mjs —— 导入流程的命令行那一半：选文件 → 解析预览 → 确认导入。
// 不带 --commit 时只读不写（预览），这样「解析预览」这一步出问题也不会把库搞脏。
//   node cal-import.mjs D:\xx\日程.ics              预览
//   node cal-import.mjs D:\xx                        预览整个目录里的日程文件
//   node cal-import.mjs a.ics b.csv --commit         直接入库（默认全都要）
//   node cal-import.mjs a.ics --as 手机 --commit     指定来源名（同名会整批替换旧的）
//   node cal-import.mjs --serve a.ics                开预览页 http://127.0.0.1:8733/ 勾着选
//   node cal-import.mjs --list / --drop 来源名 / --stats
// 这个文件不含真实日程内容，写库只写 %LOCALAPPDATA%\win-island\cal.db。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseAny } from './calparse.mjs';
import { importBatch, sourcesList, dropSource, setExcluded, stats, closeDb, CALDB } from './calstore.mjs';
import { view, whenCn } from './calview.mjs';
import { serve } from './cal-preview.mjs';

const CAND = /\.(ics|ical|ifb|csv|tsv|txt|json|out|xml)$/i;

// 目录就往里找一层，够手机导出/下载目录用了；递归会把他整块盘都扫一遍。
export function collect(paths = []) {
  const out = [];
  for (const p of paths) {
    if (!existsSync(p)) { out.push({ path: p, name: basename(p), missing: true }); continue; }
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p)) if (CAND.test(f) && statSync(join(p, f)).isFile()) out.push({ path: join(p, f), name: f });
    } else out.push({ path: p, name: basename(p) });
  }
  return out;
}

// 一个文件 → 一批规范化事件。format 空着就是让它自己嗅探。
export function parseOne(file, { format = '' } = {}) {
  const buf = readFileSync(file.path);
  const r = parseAny(buf, { name: file.name, format });
  return { name: file.name, path: file.path, bytes: buf.length, fmt: r.fmt, enc: r.enc, bom: !!r.bom, events: r.events, issues: r.issues };
}
export function parseAll(files, opt = {}) {
  return files.map(f => f.missing
    ? { name: f.name, path: f.path, missing: true, events: [], issues: [{ where: f.name, code: 'missing-file', msg: `找不到文件：${f.path}` }] }
    : parseOne(f, opt));
}

export function previewText(batches) {
  const L = [];
  let tot = 0, bad = 0;
  for (const b of batches) {
    L.push(`\n【${b.name}】格式 ${b.fmt || '?'}，编码 ${b.enc || '?'}，${b.events.length} 条`);
    for (const x of b.issues || []) L.push(`  ！${x.msg || x.code}`);
    b.events.forEach((ev, i) => {
      const v = view(ev, i + 1); tot++;
      if (v.codes.length) bad++;
      L.push(`  ${String(i + 1).padStart(3)} ${v.when}${v.allDay ? ' 全天' : ' → ' + v.end} ${v.title}`
        + `${v.repeat ? ` ⟳${v.repeat}` : ''}${v.alarm ? ` ⏰${v.alarm}` : ''}${v.where ? ` @${v.where}` : ''}`);
      for (const m of v.issues) L.push(`        ！${m}`);
    });
  }
  L.push(`\n合计 ${tot} 条，其中 ${bad} 条有问题需要人看一眼。`);
  return L.join('\n');
}

// 真正写库。picked 是「第几条要」（1 起）——预览页勾完传过来，命令行默认全要。
export function commitBatch(b, { as = '', picked = null } = {}) {
  const source = as || b.name;
  const keep = picked ? b.events.filter((_, i) => picked.includes(i + 1)) : b.events;
  const r = importBatch(keep, { source, fmt: b.fmt, enc: b.enc, note: b.path || '' });
  return { ...r, total: b.events.length, skipped: b.events.length - keep.length };
}

const ARGS = process.argv.slice(2);
const flag = n => ARGS.includes(n);
const val = (n, d = '') => { const i = ARGS.indexOf(n); return i >= 0 ? (ARGS[i + 1] || d) : d; };
const POS = ARGS.filter((a, i) => !a.startsWith('--') && !(ARGS[i - 1] || '').startsWith('--'));

const SELF = /cal-import\.mjs$/i.test(process.argv[1] || '');

// 库一变动就当场把两份日程文件都重建：抓取层最长 30 分钟才自己醒一次，
// 等它的话「岛上看到的」和「刚改完的库」会对不上半小时，删完来源却还看得见课最难查。
export async function afterWrite() {
  const { rebuildSchedule } = await import('./meta.mjs');
  const { ag, wk } = await rebuildSchedule();
  if (ag) console.log(`日程已重建：${ag.n} 条近期事件，下一个 ${ag.next ? ag.next.st + ' ' + ag.next.title : '无'}${ag.errors && ag.errors.length ? '（' + ag.errors.join('；') + '）' : ''}`);
  if (wk) console.log(`整周已重建：第${wk.weekNo || '?'}周 ${wk.monday} 起，${wk.n} 节`);
}

if (SELF) {
  if (flag('--list')) {
    for (const s of sourcesList()) console.log(`${whenCn(s.at)}  ${s.name}  ${s.n} 条  格式 ${s.fmt}  ${s.note || ''}`);
    if (!sourcesList().length) console.log('库里还没有来源。');
  } else if (flag('--stats')) {
    console.log(JSON.stringify(stats()));
  } else if (flag('--drop')) {
    const n = val('--drop'); console.log(`从「${n}」删掉 ${dropSource(n)} 条（来源记录一并删）`);
    await afterWrite();
  } else if (flag('--exclude')) {
    const ids = val('--exclude').split(',').map(x => +x).filter(Number.isFinite);
    console.log(`标记 ${setExcluded(ids, true)} 条不显示`);
    await afterWrite();
  } else if (POS.length) {
    const batches = parseAll(collect(POS), { format: val('--format') });
    console.log(previewText(batches));
    if (flag('--serve')) {
      await serve(batches, { port: +val('--port', '8733') || 8733, as: val('--as') });
    } else if (flag('--commit')) {
      for (const b of batches) {
        const r = commitBatch(b, { as: val('--as') });
        console.log(`入库「${r.source}」：新写 ${r.added} 条，重复 ${r.dup} 条，没时间跳过 ${r.noStart} 条，沿用上次勾掉 ${r.carried} 条`);
        for (const c of r.conflicts) console.log(`  ！跨来源同一条：${c.title} @ ${whenCn(c.startMs)}，${c.alsoIn.join('/')} 里也有一份`);
      }
      await afterWrite();
      console.log(`库在 ${stats().path}`);
    } else {
      console.log('（这只是预览，库里一个字没动。要写进去加 --commit，要看/勾着选加 --serve）');
    }
  } else {
    console.log('用法：node cal-import.mjs <文件或目录> [--as 来源名] [--format ics|csv|json|adb] [--commit|--serve|--list|--drop 名|--stats]');
    console.log(`库：${CALDB}`);
  }
  closeDb();
}
