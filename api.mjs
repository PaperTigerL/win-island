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
// 失败一律是 {ok:false,reason:"…"}，reason 是可读的中文，不是堆栈。
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
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
      default:
        return { ok: false, reason: '命令不认识：ping / list / text / copy' };
    }
  }
}
