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
const ROOT = join(HERE, '..');
const TOOLS = join(ROOT, 'tools');
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
    join(TOOLS, 'send-test.ps1'), '-Count', '1'],
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

  say('\n== 7. config 读回（要和盘上那一份一致，不是内存里的）==');
  const CFG = join(D, 'config.json');
  const c1 = await ask({ cmd: 'config' });
  say('  ' + JSON.stringify({ ok: c1.ok, path: c1.path, exists: c1.exists, island: Object.keys(c1.island).length }));
  if (!c1.ok) { say('  FAIL：' + c1.reason); process.exit(1); }
  const disk = () => { try { return JSON.parse(readFileSync(CFG, 'utf8')); } catch { return null; } };
  const before = disk();
  const cfgMatches = !!c1.exists === !!before && JSON.stringify(c1.island) === JSON.stringify((before || {}).island || {});
  say('  和 config.json 里的 island 段一致：' + cfgMatches);

  say('\n== 8. config.set 写一项，读回 + 别的段不受影响 ==');
  const ORIG = (c1.island || {}).dwellMs;
  const cs = await ask({ cmd: 'config.set', island: { dwellMs: 150 } });
  const w1 = disk();
  const wroteBack = cs.ok && cs.island.dwellMs === 150 && w1.island.dwellMs === 150;
  const keptOthers = JSON.stringify(w1.weather || {}) === JSON.stringify((before || {}).weather || {})
    && JSON.stringify(w1.calendar || {}) === JSON.stringify((before || {}).calendar || {});
  const noBom = readFileSync(CFG)[0] !== 0xEF;      // 带 BOM 的话这一行 readFileSync/JSON.parse 就炸了
  say('  ' + JSON.stringify(cs.island ? { dwellMs: cs.island.dwellMs } : cs));
  say('  写进去并读得回：' + wroteBack + ' / 别的段没动：' + keptOthers + ' / 无 BOM：' + noBom);
  const bad = await ask({ cmd: 'config.set', island: { madeUp: { a: 1 } } });
  const badReq = await ask({ cmd: 'config.set', island: { request: { action: 'expand' } } });
  const badNone = await ask({ cmd: 'config.set' });
  say('  值不是标量 / 想用 config.set 发指令 / 没带 island：' + [bad.reason, badReq.reason, badNone.reason].join(' | '));
  const restored = await ask({ cmd: 'config.set', island: { dwellMs: ORIG === undefined ? 0 : ORIG } });
  say('  还原成 ' + JSON.stringify(ORIG) + '：' + restored.ok + ' 盘上=' + JSON.stringify(disk().island.dwellMs));

  say('\n== 9. request 让岛做一次动作（判据是岛自己的日志，不是「文件写进去了」）==');
  const rbad = await ask({ cmd: 'request', action: 'dance' });
  say('  错动作：' + JSON.stringify(rbad));
  const at0 = Date.now();
  const r = await ask({ cmd: 'request', action: 'expand' });
  let seen = '';
  for (let i = 0; i < 12 && !seen.includes('@' + r.at); i++) {
    await sleep(500);
    // 岛屿日志是 GBK（cmd 重定向的是 PS 的 gb2312 输出），所以读用 Default、往外发前把
    // 控制台编码换成 UTF8 —— 否则中文在这一步就成乱码，「已执行」这条判据永远匹配不上。
    const lf = join(D, 'island.out.log');
    seen = sh(`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ` +
      `if (Test-Path '${lf}') { Get-Content '${lf}' -Encoding Default -Tail 40 }`);
  }
  const line = seen.split('\n').filter(x => x.includes('[prefs] request')).pop() || '';
  say('  ' + JSON.stringify(r) + ' 岛上：' + line.trim());
  const consumed = r.ok && line.includes('expand @' + r.at) && line.includes('已执行');

  const pass = same && bareLf === 0 && c2.ok && got2 === '外部程序塞进来的两行\r\n第二行'
    && cp.lines === tx.text.split('\r\n').length
    && cfgMatches && wroteBack && keptOthers && noBom
    && !bad.ok && !badReq.ok && !badNone.ok && restored.ok && disk().island.dwellMs === (ORIG === undefined ? 0 : ORIG)
    && !rbad.ok && rbad.reason.includes('expand') && consumed;
  say('\n' + (pass ? 'PASS：外部进程可以通过管道拿到全文、写进剪贴板、读写配置并驱动岛屿动作'
    : 'FAIL：见上面（岛屿没在跑的话第 9 步一定不过，那是真的没通）'));
  process.exit(pass ? 0 : 1);
}
main().catch(e => { say('异常：' + e.message); process.exit(1); });
