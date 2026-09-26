// 给别的软件开的口子：命名管道 \\.\pipe\win-island，一行 JSON 进、一行 JSON 出。
//
// 为什么是命名管道而不是 HTTP 端口：只在本机可达、不占 TCP 端口、不经防火墙，
// 也不会和 sub-updater 的状态页（8732）抢；任何语言都能连（Node net、Python、PowerShell）。
//
// 信任边界要说清楚：同一个 Windows 账户下的任何进程都能通过它读到通知正文
// （QQ 群名、邮件标题这些都在里面）。这和它本来就能读
// %LOCALAPPDATA%\win-island\queue.jsonl 是同一个边界 —— 所以这些文件绝不进公开仓库。
//
// 命令（请求和响应都是一行 JSON）：
//   {"cmd":"ping"}                                  -> {ok,pid,n,unread,at}
//   {"cmd":"list","limit":20,"unread":true}         -> {ok,n,items:[{id,app,at,title,body,lines,unread}]}
//   {"cmd":"text","id":"9437","withSource":false}    -> {ok,id,text}   拿完整正文，不动剪贴板
//   {"cmd":"copy","id":"9437"}                       -> {ok,id,chars,lines}  写进系统剪贴板
//   {"cmd":"copy","text":"..."}                       -> 同上，直接复制给它的文本
//   {"cmd":"config"}                                  -> {ok,path,island,weather,calendar}
//   {"cmd":"config.set","island":{"scale":1.2}}        -> {ok,island}   只并 island 段，别的段一个字不动
//   {"cmd":"request","action":"expand"}                -> {ok,action,at} 让岛做一次动作
// 失败一律是 {ok:false,reason:"…"}，reason 是可读的中文，不是堆栈。
//
// config.set / request 都是「写文件、岛按 mtime 轮询到再应用」，不是把指令推给岛：
// 岛本来就在盯这个文件，多开一条到岛的通道只会多一处会失败的 IO。
// 值不在这里校验 —— 校验规则只有岛上的 $PrefsSpec 一份，抄到这里就会有两套说法。
// 非法值岛会回落默认并在 island.out.log 写一行 [prefs]，config 读回来的是盘上真实那份。
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const PIPE_NAME = '\\\\.\\pipe\\win-island';
const MAXQ = 256 * 1024;      // 队列文件读上限，超了只读尾部，免得某天真吃内存

const stripBom = s => String(s).replace(/^\uFEFF/, '');

// PS 5.1 写出来的 read.json 带 BOM，node 的 JSON.parse 会直接炸，这里统一剥掉
function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(stripBom(readFileSync(file, 'utf8'))); } catch { return null; }
}

// 一条消息的「完整内容」：抓取层写队列时已经算好 copy 字段（标题+各行正文，CRLF）；
// 旧条目没这个字段，就按同样的规则现算一次，保证 API 和面板复制出来的字节一致。
export function copyTextOf(it, withSource) {
  let t = it.copy;
  if (!t) {
    const lines = Array.isArray(it.lines) && it.lines.length
      ? it.lines
      : (it.body ? [String(it.body)] : []);
    t = [it.title, ...lines].filter(Boolean).join('\r\n');
  }
  t = String(t).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  if (!withSource) return t;
  const src = `—— 来自 ${it.app} · ${it.at}`;
  return t ? `${t}\r\n${src}` : src;
}

// 剪贴板：Node 自己没有剪贴板，走一次 PowerShell Set-Clipboard。
// 文本经临时 UTF-8 文件传，不走命令行 —— 命令行里 & ; " 和换行都会被切错（中文还会受控制台编码影响）。
export function setClipboard(text) {
  if (!text) return '没有可复制的内容';
  const f = join(tmpdir(), `win-island-clip-${process.pid}.txt`);
  try {
    writeFileSync(f, text, 'utf8');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$t=[System.IO.File]::ReadAllText('${f}',[System.Text.Encoding]::UTF8); Set-Clipboard -Value $t`],
      { timeout: 15000, windowsHide: true });
    return null;
  } catch (e) {
    // 失败最常见的原因是别人正开着剪贴板（OpenClipboard 是独占锁），调用方可以重试
    return '写剪贴板失败：' + String(e.message || e).slice(0, 200);
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

// 岛认的一次性动作。这一份和 island.ps1 里 Invoke-PrefsRequest 的 switch 必须逐字一致，
// test/prefs-test.mjs 会对着两处源码比，漂了就红 —— 校验放在这里是为了给调用方一个当场回话，
// 而不是把错动作甩给岛、只写进调用方看不见的 island.out.log。
export const ISLAND_ACTIONS = ['expand', 'collapse', 'pause', 'resume', 'recenter', 'pill'];

const configFile = data => join(data, 'config.json');

// 先写 .tmp 再改名：岛是按 mtime 轮询这个文件的，读到半截 JSON 会整轮回落默认值，
// 面板上就是一次看得见的闪。无 BOM 同 prefs.ps1 的规矩（node 侧 JSON.parse 认 BOM，PS 不认）。
function writeConfig(data, cfg) {
  const f = configFile(data), tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  try { unlinkSync(f); } catch {}
  renameSync(tmp, f);
}

function loadState(DATA) {
  const qf = join(DATA, 'queue.jsonl');
  if (!existsSync(qf)) return { items: [], done: new Set() };
  let txt = '';
  try {
    const size = statSync(qf).size;
    if (size > MAXQ) {
      const fd = readFileSync(qf, 'utf8');
      txt = fd.slice(Math.max(0, fd.length - MAXQ));
      const nl = txt.indexOf('\n') + 1;
      txt = txt.slice(nl);                        // 丢掉可能被截断的第一行
    } else txt = readFileSync(qf, 'utf8');
  } catch (e) { return { items: [], done: new Set(), err: e.message }; }
  const items = [];
  for (const ln of txt.split('\n')) {
    if (!ln.trim()) continue;
    try { const o = JSON.parse(stripBom(ln)); if (o && o.id) items.push(o); } catch {}
  }
  const st = readJson(join(DATA, 'read.json')) || { opened: [], dismissed: [], gone: [] };
  const done = new Set([...(st.opened || []), ...(st.dismissed || []), ...(st.gone || [])].map(String));
  return { items, done };
}

// opts: { data, log }
export function startApi({ data, log = () => {} }) {
  let srv = null;
  try {
    srv = net.createServer(sock => {
      let buf = '';
      sock.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let resp;
          try { resp = handle(JSON.parse(line)); }
          catch (e) { resp = { ok: false, reason: '请求不是一行 JSON：' + e.message }; }
          sock.write(JSON.stringify(resp) + '\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.on('error', e => log('API 管道出错：' + e.message));
    srv.listen(PIPE_NAME);
  } catch (e) {
    log('API 管道没起来（不影响通知主链路）：' + e.message);
    return null;
  }
  log(`API 已监听 ${PIPE_NAME}`);
  return srv;

  function handle(req) {
    const cmd = String(req.cmd || '').toLowerCase();
    const { items, done, err } = loadState(data);
    if (err) return { ok: false, reason: '读队列失败：' + err };
    const isUnread = it => !done.has(String(it.id));
    const byId = id => items.find(x => String(x.id) === String(id));
    switch (cmd) {
      case 'ping':
        return { ok: true, pid: process.pid, at: new Date().toISOString(),
                 n: items.length, unread: items.filter(isUnread).length };
      case 'list': {
        const limit = Math.max(1, Math.min(500, Number(req.limit) || 50));
        let src = req.unread === false ? items : items.filter(isUnread);
        src = src.slice(-limit);
        return {
          ok: true, n: src.length,
          items: src.map(it => ({
            id: String(it.id), app: it.app, at: it.at, title: it.title,
            body: it.body, lines: it.lines || [], unread: isUnread(it),
          })),
        };
      }
      case 'text': {
        const it = byId(req.id);
        if (!it) return { ok: false, reason: `队列里没有 id=${req.id}（先 list 看有哪些）` };
        return { ok: true, id: String(it.id), text: copyTextOf(it, req.withSource === true) };
      }
      case 'copy': {
        let text = req.text ? String(req.text) : '';
        let id = req.id;
        if (!text) {
          const it = byId(req.id);
          if (!it) return { ok: false, reason: `队列里没有 id=${req.id}（先 list 看有哪些）` };
          text = copyTextOf(it, req.withSource === true);
          id = String(it.id);
        }
        if (!text.trim()) return { ok: false, reason: '这条没有可复制的文本' };
        const bad = setClipboard(text);
        if (bad) return { ok: false, reason: bad };
        return { ok: true, id: String(id || ''), chars: text.length,
                 lines: text.split('\r\n').length };
      }
      case 'config': {
        // 还没有 config.json 不是错误 —— 那正是「全默认值」的状态，调用方拿到空段就行
        const cfg = readJson(configFile(data)) || {};
        return { ok: true, path: configFile(data), exists: existsSync(configFile(data)),
                 island: cfg.island || {}, weather: cfg.weather || {}, calendar: cfg.calendar || {} };
      }
      case 'config.set': {
        const patch = req.island;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch))
          return { ok: false, reason: 'config.set 要带 island 段：{"cmd":"config.set","island":{"scale":1.2}}' };
        const keys = Object.keys(patch);
        if (!keys.length) return { ok: false, reason: 'island 段是空的，没东西可写' };
        if (keys.length > 32) return { ok: false, reason: `一次最多改 32 项，这次给了 ${keys.length} 项` };
        for (const k of keys) {
          if (!/^[a-z][a-z0-9]{0,31}$/i.test(k)) return { ok: false, reason: `配置项名不合法：${k}` };
          if (k === 'request') return { ok: false, reason: 'request 是一次性指令，走 {"cmd":"request","action":"…"}' };
          const v = patch[k];
          if (v === null || typeof v === 'object') return { ok: false, reason: `配置项 ${k} 的值要是一个标量（数字/字符串/真假）` };
        }
        const cfg = readJson(configFile(data)) || {};
        cfg.island = { ...(cfg.island || {}), ...patch };
        try { writeConfig(data, cfg); } catch (e) { return { ok: false, reason: '写 config.json 失败：' + e.message }; }
        return { ok: true, island: cfg.island, note: '值由岛上的 $PrefsSpec 校验，超出范围会被夹回并写进 island.out.log' };
      }
      case 'request': {
        const a = String(req.action || '').toLowerCase();
        if (!ISLAND_ACTIONS.includes(a))
          return { ok: false, reason: `action 只认 ${ISLAND_ACTIONS.join('/')}，给的是「${req.action || '（空）'}」` };
        const cfg = readJson(configFile(data)) || {};
        const at = new Date().toISOString();
        cfg.island = { ...(cfg.island || {}), request: { action: a, at } };
        try { writeConfig(data, cfg); } catch (e) { return { ok: false, reason: '写 config.json 失败：' + e.message }; }
        return { ok: true, action: a, at };
      }
      default:
        return { ok: false, reason: '命令不认识：ping / list / text / copy / config / config.set / request' };
    }
  }
}
