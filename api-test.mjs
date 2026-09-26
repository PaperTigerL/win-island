#!/usr/bin/env node
// 验 API：站在「别的软件」的位置上连管道、发命令、读回剪贴板。
// 判据不是「脚本没报错」，而是：copy 之后系统剪贴板里的字节 == text 命令返回的字节，
// 而且和面板里那条通知的原文逐字一致（跑之前先设对照值 SENTINEL）。
//
//   node api-test.mjs            全流程（会自己发一条多行测试通知）
//   node api-test.mjs --id 9437  只对指定 id 验
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const D = join(process.env.LOCALAPPDATA, 'win-island');
const PIPE = '\\\\.\\pipe\\win-island';
const say = console.log;

function sh(cmd) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
    { encoding: 'utf8', maxBuffer: 9e6 });
}
function clip() {
  const f = join(D, 'api-clip.txt');
  sh(`$t = '' + (Get-Clipboard -Raw); [void][System.IO.File]::WriteAllText('${f}', $t, (New-Object System.Text.UTF8Encoding($false)))`);
  return readFileSync(f, 'utf8');
}
// 一次连接 = 一行 JSON 进、一行 JSON 出（服务端按 \n 切帧）
function ask(req) {
  return new Promise((res, rej) => {
    const s = net.connect(PIPE);
    let buf = '';
    const to = setTimeout(() => { s.destroy(); rej(new Error('管道 5 秒没回应')); }, 5000);
    s.on('error', e => { clearTimeout(to); rej(e); });
    s.on('data', d => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) { clearTimeout(to); s.end(); try { res(JSON.parse(buf.slice(0, i))); } catch (e) { rej(e); } }
    });
    s.on('end', () => {});
    s.write(JSON.stringify(req) + '\n');
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  say('== 0. 对照值 ==');
  sh(`[void](Set-Clipboard -Value 'SENTINEL-未复制')`);
  say('  剪贴板 = ' + JSON.stringify(clip()));

  say('\n== 1. ping ==');
  const p = await ask({ cmd: 'ping' });
  say('  ' + JSON.stringify(p));
  if (!p.ok) { say('  FAIL：ping 就不通，管道没起来（capture.mjs 是否用新代码重启了？）'); process.exit(1); }

  say('\n== 2. 发一条多行通知，等它进队列 ==');
  const body = ['API 测试 · 多行', '第二行含中文与 && 符号', '    缩进行', '尾行']
    .join('\n').replace(/&/g, '&amp;');
  writeFileSync(join(D, 'api-body.txt'), body, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(HERE, 'send-test.ps1'), '-Count', '1'],
    { env: { ...process.env, WI_TITLE: 'Island api test', WI_BODY: body } });
  await sleep(2600);

  say('\n== 3. list（默认只给未读）==');
  const l = await ask({ cmd: 'list', limit: 10 });
  say('  n=' + l.n + '  ' + l.items.map(i => `${i.id}:${i.title.slice(0, 18)}`).join(' | '));
  const hit = l.items.filter(i => String(i.title).startsWith('Island api test')).pop();
  if (!hit) { say('  FAIL：未读列表里没有刚发的那条（这就是「复制不到」的上游原因）'); process.exit(1); }

  say('\n== 4. text 取全文 ==');
  const tx = await ask({ cmd: 'text', id: hit.id });
  say('  ' + JSON.stringify(tx.text));
  if (!tx.ok) { say('  FAIL：' + tx.reason); process.exit(1); }

  say('\n== 5. copy 写剪贴板，再读回来逐字节比 ==');
  const cp = await ask({ cmd: 'copy', id: hit.id });
  say('  ' + JSON.stringify(cp));
  await sleep(300);
  const got = clip();
  const same = got === tx.text;
  say('  剪贴板 ' + got.length + ' 字 / text 返回 ' + tx.text.length + ' 字 / 完全相等=' + same);
  if (!same) {
    say('  --- 剪贴板 ---'); say(JSON.stringify(got));
    say('  --- text ---'); say(JSON.stringify(tx.text));
  }
  const bareLf = (got.replace(/\r\n/g, '').match(/\n/g) || []).length;
  say('  裸 LF ' + bareLf + ' 个（要 0）');

  say('\n== 6. copy 直接给文本（不经过通知）==');
  const c2 = await ask({ cmd: 'copy', text: '外部程序塞进来的两行\r\n第二行' });
  await sleep(300);
  const got2 = clip();
  say('  ' + JSON.stringify(c2) + ' -> 剪贴板 ' + JSON.stringify(got2));

  const pass = same && bareLf === 0 && c2.ok && got2 === '外部程序塞进来的两行\r\n第二行'
    && cp.lines === tx.text.split('\r\n').length;
  say('\n' + (pass ? 'PASS：外部进程可以通过管道拿到全文并写进系统剪贴板'
    : 'FAIL：见上面'));
  process.exit(pass ? 0 : 1);
}
main().catch(e => { say('异常：' + e.message); process.exit(1); });
