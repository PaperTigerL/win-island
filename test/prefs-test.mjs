#!/usr/bin/env node
// 配置项这一层的验收：三件事必须同时成立 ——
//   1) 文档里那张表和代码里的 $PrefsSpec 逐字一致（文档漂了就红）；
//   2) 每个配置项都真的被 island.ps1 读了（写了 spec 却没人读的项 = 假的可配置）；
//   3) 非法值真的按 spec 回落/夹取，且写盘是无 BOM、只动 island 段 —— 这半截在 PowerShell 里跑，
//      因为回落逻辑只有一份实现（prefs.ps1），测试里重算一遍等于只测了我自己的副本。
//
//   node prefs-test.mjs                全跑
//   node prefs-test.mjs --expect 56    同时要求分母是 56 条
//
// 这个文件不含任何真实通知/日程内容，可以进公开仓库。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;
let n = 0, bad = 0;
const fails = [];

function eq(label, want, got) {
  n++;
  const ok = JSON.stringify(want) === JSON.stringify(got);
  if (!ok) { bad++; fails.push(label); console.log(`  FAIL ${label}\n        期望 ${JSON.stringify(want)}\n        实得 ${JSON.stringify(got)}`); }
  else console.log(`  ok   ${label} = ${JSON.stringify(got)}`);
}
function has(label, hay, needle) {
  n++;
  const ok = String(hay).includes(needle);
  if (!ok) { bad++; fails.push(label); console.log(`  FAIL ${label}\n        缺关键字 ${JSON.stringify(needle)}\n        实得 ${JSON.stringify(String(hay).slice(0, 220))}`); }
  else console.log(`  ok   ${label}`);
}

const PREFS = readFileSync(join(ROOT, 'src', 'island', 'prefs.ps1'), 'utf8');
const ISLAND = readFileSync(join(ROOT, 'src', 'island', 'island.ps1'), 'utf8');
const DOC = readFileSync(join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
const API = readFileSync(join(ROOT, 'src', 'capture', 'api.mjs'), 'utf8');

// ---------- 1. 把 $PrefsSpec 抠出来 ----------
function parseSpec(src) {
  const a = src.indexOf('$PrefsSpec = [ordered]@{');
  if (a < 0) throw new Error('没找到 $PrefsSpec');
  const body = src.slice(a, src.indexOf('\n}\n', a));
  const spec = new Map();
  const re = /^ {2}([a-zA-Z][\w]*)\s*=\s*@\{/gm;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ key: m[1], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const seg = body.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : body.length);
    const type = (seg.match(/type = '(\w+)'/) || [])[1];
    const def = (seg.match(/default = ('[^']*'|-?[\d.]+|\$?\w+|\[[^\]]+\][^;\n]+)/) || [])[1];
    const doc = (seg.match(/doc = '([^']*)'/) || [])[1];
    const min = seg.match(/min = (-?[\d.]+)/), max = seg.match(/max = (-?[\d.]+)/);
    const vseg = seg.match(/values = ([^;]*?)(?=\n\s*(?:doc|min|max)\s*=)/);
    const values = vseg ? [...vseg[1].matchAll(/'([^']*)'/g)].map(x => x[1]) : null;
    spec.set(marks[i].key, {
      type, doc, values,
      def: def === '$true' ? 'true' : def === '$false' ? 'false' : String(def).replace(/'/g, ''),
      min: min ? min[1] : null, max: max ? max[1] : null,
    });
  }
  return spec;
}
const spec = parseSpec(PREFS);

// ---------- 2. 把 docs/CONFIG.md 那张表抠出来 ----------
function parseDoc(md) {
  const out = new Map();
  for (const line of md.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('| `')) continue;
    const c = line.split('|').slice(1, -1).map(s => s.trim());
    if (c.length !== 5) continue;
    const tick = s => s.replace(/`/g, '');
    const nums = c[3].match(/-?\d+(?:\.\d+)?/g);
    out.set(tick(c[0]), {
      type: c[1], def: tick(c[2]),
      values: c[3].startsWith('`') ? [...c[3].matchAll(/`([^`]*)`/g)].map(x => x[1]) : null,
      min: nums && /~/.test(c[3]) ? nums[0] : null,
      max: nums && /~/.test(c[3]) ? nums[nums.length - 1] : null,
      doc: c[4],
    });
  }
  return out;
}
const doc = parseDoc(DOC);

console.log('== 1. spec 本身 ==');
eq('spec 有 29 个配置项', 29, spec.size);
const badType = [...spec].filter(([, v]) => !['enum', 'int', 'real', 'bool'].includes(v.type)).map(([k]) => k);
eq('每项 type 都是已知类型', [], badType);
const noDoc = [...spec].filter(([, v]) => !v.doc || v.doc.length < 8).map(([k]) => k);
eq('每项都有 doc（写给 CONFIG.md 用）', [], noDoc);

console.log('\n== 2. 文档与 spec 逐项对齐 ==');
eq('文档表里的键集合 == spec 的键集合', [...spec.keys()].sort(), [...doc.keys()].sort());
const drift = [];
for (const [k, s] of spec) {
  const d = doc.get(k);
  if (!d) { drift.push(`${k}：文档里没有这一行`); continue; }
  if (d.type !== s.type) drift.push(`${k}：类型 ${s.type} != ${d.type}`);
  if (d.def !== s.def) drift.push(`${k}：默认 ${s.def} != ${d.def}`);
  if (s.doc !== d.doc) drift.push(`${k}：说明文字不一致（spec「${s.doc}」/ 文档「${d.doc}」）`);
  if (s.type === 'enum') {
    if (!d.values || d.values.join(',') !== s.values.join(','))
      drift.push(`${k}：取值表 ${s.values.join('/')} != ${(d.values || []).join('/')}`);
  } else if (s.type === 'int' || s.type === 'real') {
    if (String(d.min) !== String(s.min) || String(d.max) !== String(s.max))
      drift.push(`${k}：范围 ${s.min}~${s.max} != ${d.min}~${d.max}`);
  } else if (s.type === 'bool' && d.doc === undefined) {
    drift.push(`${k}：布尔项没写 true / false`);
  }
}
eq('每一项的类型/默认/范围/说明都和 spec 对得上', [], drift);
const docKeys = [...doc.keys()];
const extraRows = docKeys.filter(k => !spec.has(k) && !['on', 'everyMin', 'city', 'lat / lon', 'sources', 'everyMin ', 'days', 'week1Monday'].includes(k));
eq('文档表里没有 spec 之外的 island 项', [], extraRows);

console.log('\n== 3. 每个配置项真的被读了 ==');
const dead = [...spec.keys()].filter(k => !new RegExp(`\\$p\\.${k}\\b|\\$script:P\\.${k}\\b|\\$p\\['${k}'\\]`).test(ISLAND));
eq('spec 里没有「写了但 island.ps1 从不读」的假可配置项', [], dead);
const inPrefs = [...spec.keys()].filter(k => !new RegExp(`^ {2}${k}\\s+=`, 'm').test(PREFS));
eq('spec 里每项都能从 prefs.ps1 定位到', [], inPrefs);

console.log('\n== 4. 非法值回落 / 夹取 / 联动（在 PowerShell 里跑真实现）==');
const raw = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  join(ROOT, 'test', 'prefs-harness.ps1')], { encoding: 'utf8', maxBuffer: 9e6 });
const H = JSON.parse(raw.trim().split(/\r?\n/).pop());
const cs = Object.fromEntries(H.cases.map(c => [c.name, c]));
const joined = a => (a || []).join(' ⏎ ');

eq('空配置 = 全默认（anchor/scale/pollMs）', ['top-center', 1, 70],
  [cs.empty.values.anchor, cs.empty.values.scale, cs.empty.values.pollMs]);
eq('类型全错：scale/wide/anchor/holdMs 回落默认', ['top-center', 1, 470, 6000],
  [cs.wrongtype.values.anchor, cs.wrongtype.values.scale, cs.wrongtype.values.wide, cs.wrongtype.values.holdMs]);
eq('类型全错：布尔「maybe」回落默认 true', true, cs.wrongtype.values.clickThrough);
eq('类型全错：报 4 条校正', 4, (cs.wrongtype.issues.filter(x => /不是(数字|整数|布尔)/.test(x) || /只认/.test(x)).length));
eq('越界：夹到上下限而不是原样收', [60, -32768, 1.8, 20, 600000, 260],
  [cs.clamped.values.hotPx, cs.clamped.values.x, cs.clamped.values.scale,
   cs.clamped.values.pollMs, cs.clamped.values.holdMs, cs.clamped.values.wide]);
has('越界报告写明按了多少', joined(cs.clamped.issues), '超过上限');
has('越界报告写下限那一侧', joined(cs.clamped.issues), '小于下限');
eq('宽松解析："70" 收成 70、"CLICK" 收小写、0 收成 false', [70, 'click', false],
  [cs.lenient.values.pollMs, cs.lenient.values.trigger, cs.lenient.values.animOn]);
eq('"yes" 收成布尔 true', true, cs.lenient.values.clickThrough === false);   // trigger=click 会把它压成 false
eq('联动：trigger=click 时穿透自动关掉', [false, 'click'], [cs['imply-click'].values.clickThrough, cs['imply-click'].values.trigger]);
has('联动要说清是谁压的', joined(cs['imply-click'].issues), '自动置为 false');
eq('联动：trigger=longpress 同理', false, cs['imply-press'].values.clickThrough);
eq('联动：animOn=false 把三个时长归零', [0, 0, 0],
  [cs['imply-anim'].values.fadeMs, cs['imply-anim'].values.animMs, cs['imply-anim'].values.slidePx]);
eq('不认识的键：忽略它但其余项照常生效', 'bottom-center', cs.unknown.values.anchor);
has('不认识的键要报出来', joined(cs.unknown.issues), '不是已知项');
eq('整份 JSON 坏了：这一轮全按默认跑', ['top-center', 1], [cs.broken.values.anchor, cs.broken.values.scale]);
has('坏了要说「读不懂」而不是抛出去', joined(cs.broken.issues), '读不懂');

console.log('\n== 5. 写盘（原子、无 BOM、只动 island 段）==');
const W = H.write;
eq('config.json 首字节不是 BOM（0xEF）—— node 那边 JSON.parse 才不炸', false, W.bomFirstByte === 239);
eq('一次写完 anchor/x/y（不许出现「free 但坐标还是 -1」的半套状态）', ['free', 120, 40], [W.anchor, W.x, W.y]);
eq('没动 scale 就还是原值', 1, W.scale);
eq('weather 段一个字没动（读盘改 island 再整体写回）', '示例市', W.keptWeatherCity);
eq('calendar 段一个字没动', 1, W.keptCalendarSources);
has('写未知键当场拒绝而不是静默收下', W.unknownKeyThrew, '不是已知配置项');
eq('原子替换后不留 .tmp', false, W.tmpLeft);

console.log('\n== 6. 对外动作表和实现一致 ==');
const actions = (API.match(/ISLAND_ACTIONS = \[([^\]]*)\]/) || ['', ''])[1].match(/'([^']*)'/g).map(s => s.replace(/'/g, ''));
const sw = ISLAND.slice(ISLAND.indexOf('function Invoke-PrefsRequest'));
const impl = [...sw.slice(0, sw.indexOf('} catch')).matchAll(/^\s{6}'(\w+)'\s+\{/gm)].map(x => x[1]);
eq('管道 request 认的动作 == 岛上 switch 真的会做的动作', impl.sort(), actions.slice().sort());
eq('动作表就是这六个', ['collapse', 'expand', 'pause', 'pill', 'recenter', 'resume'], actions.slice().sort());
for (const a of actions) has(`docs/CONFIG.md 里写了 ${a}`, DOC, '`' + a + '`');
for (const c of ['config', 'config.set', 'request']) has(`管道命令 ${c} 有实现`, API, `case '${c}'`);
has('管道命令表写进了文档', DOC, 'config.set');

console.log(`\n分母：断言 ${n} 条，失败 ${bad} 条`);
if (WANT && n !== WANT) { console.log(`！断言数 ${n}，要求 ${WANT} —— 有人加了/删了断言`); bad++; }
if (bad) console.log('未过：\n  ' + fails.join('\n  '));
process.exit(bad ? 1 : 0);
