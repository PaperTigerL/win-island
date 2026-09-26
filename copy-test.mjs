#!/usr/bin/env node
// 端到端验「复制这条」：真发一条多行通知 -> 真用鼠标右键开行菜单 -> 真点那个菜单项 ->
// 读回系统剪贴板逐行比对。
// 判据只有剪贴板里那串字节：岛屿日志里的「已复制 N 行」是它自己写的，证明不了系统里真拿到了。
// 顺带留一个对照组：跑之前先把剪贴板设成 SENTINEL，剪贴板没被改写时测试必须判失败。
//
//   node copy-test.mjs              全流程
//   node copy-test.mjs --keep       跑完不把未读清零（留着人看面板）
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const D = join(process.env.LOCALAPPDATA, 'win-island');
const TMP = f => join(D, f);
const KEEP = process.argv.includes('--keep');

const sh = (cmd, env) => execFileSync('powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
  { encoding: 'utf8', maxBuffer: 9e6, env: { ...process.env, ...env } });
// PowerShell 控制台是 GBK，中文经管道会花掉；一律让脚本自己写 UTF-8 文件再读
const outFile = (cmd, f, env) => { sh(`${cmd} | Out-File -Encoding utf8 '${f}'`, env); return readFileSync(f, 'utf8'); };
const ps1 = (name, args = '', env) => outFile(`& '${join(HERE, name)}' ${args}`, TMP(name.replace('.ps1', '') + '-out.txt'), env);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = s => console.log(s);

// 通知正文：多行 + 中文 + && + 代码块 + 行首缩进。& 在 XML 里必须写成 &amp;，
// 所以要一并验「转义还原后是原样」。
const BODY_LINES = [
  '复制测试 · 多行正文',
  '1. 剪贴板走 UnicodeText',
  '2. 保留换行与中文，还原 &amp; 这种实体',
  '```',
  'if (a && b) {',
  '    copy("第三行有两个空格缩进");',
  '}',
  '```',
];
const XML_BODY = BODY_LINES.join('\n').replace(/&/g, '&amp;');
const TITLE = 'Island test copy';

async function main() {
  say('== 0. 剪贴板设为对照值 ==');
  sh(`[void](Set-Clipboard -Value 'SENTINEL-未复制')`);
  const before = clip();
  say('  现在剪贴板 = ' + JSON.stringify(before));
  if (!before.includes('SENTINEL')) { say('  对照值没设上，后面就判不出真假'); process.exit(1); }

  say('\n== 1. 未读清零（不然后面数不准）==');
  say('  ' + oneLine(ps1('ui-probe.ps1', '-Swipe')));
  await sleep(400);
  say('  ' + oneLine(ps1('ui-probe.ps1', '-ClickRead')));
  await sleep(400);
  const cleared = ps1('ui-probe.ps1', '');
  say('  清零后：' + oneLine(cleared));

  say('\n== 2. 发一条多行通知 ==');
  say('  ' + oneLine(ps1('send-test.ps1', '-Count 1',
    { WI_TITLE: TITLE, WI_BODY: XML_BODY })));
  await sleep(3200);          // 抓取层轮询 + 渲染

  say('\n== 3. 队列里这条长什么样 ==');
  const q = readFileSync(join(D, 'queue.jsonl'), 'utf8').split('\n').filter(Boolean);
  const last = JSON.parse(q[q.length - 1]);
  say(`  id=${last.id} title=${JSON.stringify(last.title)}`);
  say(`  body(显示用单行)=${JSON.stringify(last.body)}`);
  say(`  lines(复制用)=${JSON.stringify(last.lines)}`);
  if (!Array.isArray(last.lines) || last.lines.length < 2) {
    say('  FAIL：队列里这条没有多行 lines —— 抓取层没带上新字段（capture.mjs 是否已重启？）');
    process.exit(1);
  }

  say('\n== 4. 展开面板，找那一行 ==');
  say('  ' + oneLine(ps1('ui-probe.ps1', '-Swipe')));
  await sleep(450);
  const rows = ps1('ui-probe.ps1', '');
  say('  ' + oneLine(rows));

  say('\n== 5. 鼠标移到那一行、点行尾「复制」（他日常的手法）==');
  // 一个进程里做完：上滑撑面板 -> 按标题定位行 -> 悬停显形 -> 真点那颗 chip
  say('  ' + oneLine(ps1('ui-probe.ps1',
    `-CopyRow 0 -CopyMatch '${TITLE.replace(/'/g, '')}' -CopyVia chip`)));
  let r1 = check('chip 点击复制');

  say('\n== 5b. 右键这一行 -> 菜单「复制这条（完整正文）」（对照组，走的是另一条入口）==');
  say('  ' + oneLine(ps1('ui-probe.ps1',
    `-CopyRow 0 -CopyMatch '${TITLE.replace(/'/g, '')}' -CopyVia menu`)));
  let r2 = check('右键菜单复制');

  say('\n' + ((r1 && r2)
    ? 'PASS：两条入口都把多行原文逐字送进了剪贴板，行尾全是 CRLF（含缩进、&&、代码块）'
    : 'FAIL：见上面逐行结果'));
  process.exit(r1 && r2 ? 0 : 1);
}

// 逐行比对：期望 = 标题 + 正文各行（+ 测试通知自带的那行 seq=…，只允许它在尾部）
function check(what) {
  const got = clip();
  const g = got.split('\r\n');
  // send-test.ps1 的标题带序号「#$i」，这里发的是 1 条，所以实际标题就是它
  const want = [`${TITLE} #1`, ...BODY_LINES];
  const bareLf = (got.replace(/\r\n/g, '').match(/\n/g) || []).length;
  let pass = g.length >= want.length && bareLf === 0;
  say(`  【${what}】剪贴板 ${got.length} 字 / ${g.length} 行；裸 LF ${bareLf} 个（要 0）`);
  for (let i = 0; i < want.length; i++) {
    const ok = g[i] === want[i];
    if (!ok) pass = false;
    say(`  <${i}> ${ok ? 'OK  ' : 'FAIL'} 期望 ${JSON.stringify(want[i])}` +
        (ok ? '' : ` / 实得 ${JSON.stringify(g[i])}`));
  }
  for (let i = want.length; i < g.length; i++) {
    const tail = /^seq=\d+ sent=\d\d:\d\d:\d\d\.\d\d\d$/.test(g[i]);
    if (!tail) pass = false;
    say(`  <${i}> ${tail ? 'OK  ' : 'FAIL'} 尾部 ${JSON.stringify(g[i])}`);
  }
  return pass;
}

function clip() {
  const f = TMP('clip-read.txt');
  // 用不带 BOM 的 UTF8 写：[Text.Encoding]::UTF8 会带 U+FEFF，读回来会假报「首行多个不可见字符」
  sh(`$t = '' + (Get-Clipboard -Raw); [void][System.IO.File]::WriteAllText('${f}', $t, (New-Object System.Text.UTF8Encoding($false)))`);
  return readFileSync(f, 'utf8');
}
function oneLine(s) { return String(s).replace(/\s+$/, '').split(/\r?\n/).filter(x => x.trim()).join(' ⏎ '); }
function rowIndexOf(rows, title) {
  for (const ln of rows.split(/\r?\n/)) {
    const m = /^\s*\[(\d+)\]/.exec(ln);
    if (m && ln.includes(title)) return +m[1];
  }
  return -1;
}
if (!existsSync(join(HERE, 'ui-probe.ps1'))) { say('找不到 ui-probe.ps1，要在 D:\\win-island 下跑'); process.exit(1); }
main().catch(e => { say('异常：' + e.message + '\n' + (e.stdout || '') + (e.stderr || '') + (e.output || '')); process.exit(1); });
