#!/usr/bin/env node
// 只读探通知库的表结构。做「哪些通知算看过」时需要知道系统自己有没有存已读/已清除标记，
// 有就用系统的，没有才自己记账 —— 自己记的账只能覆盖「点过岛屿」的那部分，是残缺的。
// 用法： node probe-schema.mjs            所有表 + 列名
//       node probe-schema.mjs Notification 只看某张表的完整建表语句 + 行数
import { spawnSync } from 'node:child_process';
if (!process.env.WIN_ISLAND_RELAUNCHED) {
  try { await import('node:sqlite'); }
  catch {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', process.argv[1], ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, WIN_ISLAND_RELAUNCHED: '1' } });
    process.exit(r.status ?? 1);
  }
}
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB = join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
const db = new DatabaseSync(DB, { readOnly: true });
const want = process.argv[2] || '';
const tabs = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name`).all();
for (const t of tabs) {
  if (want && t.name !== want) continue;
  const n = db.prepare(`SELECT COUNT(*) AS C FROM "${t.name}"`).get().C;
  console.log(`\n== ${t.name}  行数=${n}`);
  console.log(t.sql);
  if (want) {
    const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all();
    // 必须逐列 CAST 成文本：Notification 的 GUID/INT64 列（如 DataVersion）超出 JS 安全整数，
    // 直接 SELECT * 会 RangeError: Value is too large
    const sel = cols.map(c => `"${c.name}" IS NULL AS N_${c.name}, CAST("${c.name}" AS TEXT) AS "${c.name}"`).join(', ');
    console.log('-- 列采样（前 3 行，BLOB 显示为长度）--');
    for (const r of db.prepare(`SELECT ${sel} FROM "${t.name}" LIMIT 3`).all()) {
      const o = {};
      for (const c of cols) {
        const v = r[c.name];
        o[c.name] = r['N_' + c.name] ? null : (c.type.toUpperCase() === 'BLOB' && typeof v === 'string' ? `<blob ${Math.floor(v.length / 2)}B>` : (typeof v === 'string' && v.length > 90 ? v.slice(0, 90) + '…' : v));
      }
      console.log(JSON.stringify(o, null, 0));
    }
  }
}
db.close();
