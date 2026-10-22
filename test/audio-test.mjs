#!/usr/bin/env node
// 频谱这一层的验收，两半：
//   A 引擎：子进程里跑 test/audio-harness.ps1 —— 已知频率落对格、随纯音起落、停顿归零
//   B 活着的岛：管道开 audioOn → {"cmd":"audio"} 拿到真数据 → 屏幕上亮像素真的变多
//
// 判据为什么这么挑（不是「脚本没报错」，也不是「柱子在动」）：
//   「柱子在动」放段背景音乐也能过，证明不了频率映射是对的。所以这里灌的是我们自己合成的
//   250/440/1000/4000/8000Hz 正弦（五个点铺到 12 格里的第 3/4/6/9/10 格），要求：
//     谱峰频率 == 注入频率 ±2%（中位数口径）、谱峰所在格 == 该频率应在格、且至少六成帧锁在那格、
//     该格是全场 12 格里最亮的、最亮格随频率单调上移。
//   为什么不写「纯音要把该格抬到基线的 2 倍」或「停音后回落到 0.6×」：这台机器随时可能在放别的东西，
//   低中频那一格自己就能到 0.45，而 16 bit 满幅只有 1.0 —— 那种倍数式判据在响环境里根本不可满足，
//   挂了跟引擎对不对无关（实测：250Hz 停音后 0.2732 ← 纯音 0.4108，比值 0.66，正是环境底不是余势）。
//   换成不依赖环境的三条：绝对高度（≥0.30，柱子立到小条三成）+ 贴着激励取的前后对照的绝对差
//   （同一格「放音 − 前置对照 ≥0.10」且「停音后落回对照 +0.08 以内」）。对照贴着取，
//   开跑时的基线代表不了 30 秒后那段视频。
//   「归零」这一条放在引擎侧的停顿衰减上验 —— 纯音正响时停掉抓取，此后不再有新分析窗，
//   柱子必须自己一路压到 0，冻在最后一帧就是不过；这条在响环境下也成立。
//   B 那半为什么数像素：日志里 bands=[…] 只证明算对了，证明不了那 12 根柱子真画到了屏幕上
//   （XAML 少一段、可见性判错、画刷没挂上，都能「数据全对而屏幕上什么都没有」，这岛真发生过）。
//   数的范围是渲染层自己报的那块矩形（audio.json 的 barRect）而不是整窗：窗口是透的，
//   整窗计数会把桌面上透出来的东西一起数进来（实测过一次假信号，亮像素反而「变少」）。
//   B2 出声用「门控配对」而不是「前后各数一次」：和弦以峰值 0.5（≈ -6dBFS）明暗交替放 6 对
//   （on/off 各 900ms，段首 350ms 不算，柱子要从上一段的压零斜坡里走出来），每次 on 和紧挨着的 off
//   配对相减 —— 环境声和这个门不相关，进的是两边共同的底，一减就抵消。
//   于是激励可以小声（先前为了压过环境把幅度拧到 2.5，削波且吵到人），判据反而更硬：
//   要求 6 对全部同号、均值差 ≥12 个亮像素、且至少 4 对内部完全分离（on 最少一帧 > off 最多一帧 +8）。
//   为什么是「≥4 对」而不是「6 对全分离」：2026-09-27 实测 6 对里 5 对分得很开（间距 21~155），
//   第 6 对 −12 —— 那一对的 off 段里环境自己响了一下。分离度是环境的性质，把它写成硬条件等于让判据
//   去赌别人什么时候出声；同号 + 均值 ≥12 这两条才是这一段的因果（实测均值 100.5，on 中位 285 / off 186）。
//   B7（声音不在默认设备上）除了看那一行的窗数在涨，还要求响应**长成 6000Hz 那一格**：
//   该格 on−off 中位 ≥0.15 且比其余 11 格的中位高 ≥0.08（两边先夹到 0 以上再相减 —— 环境在 on 段里
//   变轻时其余格是负的中位差，拿负数当被减数会把「一格都没涨」算成 0.1 的「形状」）。
//   激励用 6000Hz 而不是 1000Hz：柱高是 dB 口径，环境底在低中频自己就能起伏 0.1~0.4，
//   那种环境下任何绝对上限测的都是房间静不静。挪的是激励的位置，门限一个字没动。
//
//   node audio-test.mjs            两半都跑（B 要求岛屿正用新代码在跑：scripts/launch.ps1）
//   node audio-test.mjs --engine   只跑 A（不动岛、不碰配置）
//   node audio-test.mjs --live     只跑 B
//   node audio-test.mjs --expect N 同时要求分母是 N 条
//
// 这个文件不含任何真实通知/日程内容，可以进公开仓库。合成 WAV 只落在 %TEMP%，测完即弃。
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const D = join(process.env.LOCALAPPDATA, 'win-island');
const PIPE = '\\\\.\\pipe\\win-island';
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;
const ONLY_ENGINE = ARGS.includes('--engine');
const ONLY_LIVE = ARGS.includes('--live');
// 扫的频率：低频两格、中频一格、高频两格，覆盖 12 格里的 3/4/6/9/10 五格。
// 只测 440/1000/4000 的话，「最亮格随频率上移」这条只有三个点，中间那段映射错了也照过。
const FREQS = [250, 440, 1000, 4000, 8000];
// B7 用的单频激励。为什么不用 1000Hz（第一版就是 1000）：对照臂要证的是「只听默认设备时，
// 这一格的响应塌掉、而且不再成形状」，而 800~1318Hz 那一格正是人声/音乐的主活动区 ——
// 2026-09-27 两次实测：环境自己在这一段里就能给出 0.107 的其余格中位、单对 0.395 的起伏，
// 「不成形状」被判成不过，而那和抓取设置没关系。换到 6kHz（第 11 格）：那里的背景底接近 0，
// 同一套阈值（该格 ≥0.15、比其余格高 ≥0.08 / 对照臂 ≤0.05）就只在「这台设备真的被抓到」时起作用。
// 这是把激励挪到干净的位置，不是把判据放宽 —— 门限一个字没动。
const TONE_HZ = 6000;
const TONE_AMP = 0.35;
let n = 0, bad = 0;
const fails = [];
// B 那半会临时改用户三项设置（audioOn / showUnread / trigger）。happy path 上 B5 自己还原并断言还原
// 成功；这里再兜一道：跑挂了（异常从中间穿出去）也要把这三项写回去，否则「测试失败」的代价是
// 用户的角标和悬停展开莫名其妙没了。
const orig = { got: false, restored: false, island: {} };

function eq(label, want, got) {
  n++;
  const ok = JSON.stringify(want) === JSON.stringify(got);
  if (!ok) { bad++; fails.push(label); console.log(`  FAIL ${label}\n        期望 ${JSON.stringify(want)}\n        实得 ${JSON.stringify(got)}`); }
  else console.log(`  ok   ${label} = ${JSON.stringify(got)}`);
}
function yes(label, cond, detail) {
  n++;
  if (!cond) { bad++; fails.push(label); console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); }
  else console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ask(req, timeoutMs) {
  return new Promise((res, rej) => {
    const s = net.connect(PIPE);
    let buf = '';
    const to = setTimeout(() => { s.destroy(); rej(new Error('管道 ' + Math.round((timeoutMs || 8000) / 1000) + ' 秒没回应')); }, timeoutMs || 8000);
    s.on('error', e => { clearTimeout(to); rej(e); });
    s.on('data', d => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) { clearTimeout(to); s.end(); try { res(JSON.parse(buf.slice(0, i))); } catch (e) { rej(e); } }
    });
    s.write(JSON.stringify(req) + '\n');
  });
}
function ps(file, extra) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(ROOT, file), ...(extra || [])], { encoding: 'utf8', maxBuffer: 9e6 });
}
function pix(tag) {
  const raw = ps('tools/pixel-audio.ps1', tag ? ['-Shot', tag] : []).trim().split(/\r?\n/).pop();
  return JSON.parse(raw);
}
// 数屏幕上「柱子那块矩形」里的亮像素：矩形是渲染层自己报的（见 island.ps1 的 Get-AudioBarRectPx）
function pixRect(rect, tag) {
  const args = ['-Rect', rect.join(',')];
  if (tag) args.push('-Shot', tag);
  const raw = ps('tools/pixel-audio.ps1', args).trim().split(/\r?\n/).pop();
  return JSON.parse(raw);
}

// ---------- A. 引擎 ----------
async function engineHalf() {
  console.log('== A1. 引擎开起来，且抓的是系统混音 ==');
  const raw = ps('test/audio-harness.ps1').trim().split(/\r?\n/).pop();
  const H = JSON.parse(raw);
  if (!H.ok) { yes('引擎自证夹具跑通', false, H.reason); return; }
  yes('status 是 ok 而不是 not-compiled / 异常', /^ok/.test(H.status), H.status);
  const rate = +(H.status.match(/rate=(\d+)/) || [])[1] || 0;
  yes('抓到的是设备混音采样率（44.1k/48k 之一，说明真拿到了默认输出设备）',
    rate === 44100 || rate === 48000, H.status);
  // 夹具里每一段采样报的 windows 都是「那一段新增的窗数」（差值口径，不是累计），所以这里
  // 不能拿基线段去减 —— 两个数本来就是两段各自的新增量。1.8 秒 @48kHz/4096 点 ≈ 21 窗，
  // 取 ≥15 是给「真在算」留余量，又不放过「只算了两三帧就冻住」。
  // 测在放音那一段而不是安静基线：loopback 在整机完全无声时一个包都不给（实测过基线段新增 0 窗），
  // 那不是引擎躺平，是确实没声音 —— 判据要的是「我们让它响的时候它在算」。
  const first = H['t' + FREQS[0]];
  yes('放第一个纯音那 1.8 秒里新增分析窗 ≥15（引擎真在算，不是一次性快照）',
    first.windows >= 15, `${FREQS[0]}Hz 那 1.8 秒新增 ${first.windows} 窗（同期安静基线新增 ${H.baseline.windows} 窗）`);
  console.log(`  基线（这段时间不放音）bandsMax=${JSON.stringify(H.baseline.bandsMax)} 峰值=${H.baseline.max} ever=${H.baseline.ever}`);
  yes('如实报环境：要么整机安静（基线全 0），要么测到了底（基线非零）—— 不许是「没测到」',
    H.baseline.ever === true ? H.baseline.max > 0 : H.baseline.max === 0,
    H.baseline.ever ? '环境有声：归零那条改在「停顿衰减」上验，起落那条改在贴着激励的前后对照上验'
                    : '环境安静：基线确实全 0');

  console.log('\n== A2. 已知频率落对格（判据是频率，不是「在动」）==');
  const edges = H.edges, bN = H.bandsN;
  const bandOf = hz => { for (let i = 0; i < bN; i++) if (hz >= edges[i] && hz < edges[i + 1]) return i; return -1; };
  const tops = [];
  for (const hz of FREQS) {
    const t = H['t' + hz];
    const pre = H['pre' + hz];
    const b = bandOf(hz);
    yes(`${hz}Hz 时引擎报的主峰在 ${hz}Hz ±2%`, Math.abs(t.peakHz - hz) / hz < 0.02,
      `peakHz=${t.peakHz}（这一段 ${t.peakFrames} 帧的谱峰落在同一格，取中位数）`);
    yes(`${hz}Hz 时谱峰所在的那一格 = ${hz}Hz 应在的那一格`, t.peakBand === b,
      `peakBand=${t.peakBand} 应在 ${b} 格 ${(edges[b]).toFixed(0)}–${(edges[b + 1]).toFixed(0)}Hz`);
    yes(`${hz}Hz 时至少六成帧的谱峰都锁在那一格（不是偶尔撞上去）`, t.peakShare >= 0.6, `peakShare=${t.peakShare}`);
    yes(`${hz}Hz 时最亮的那一格就是 ${hz}Hz 所在的那一格`, t.top === b,
      `top=${t.top} max=${t.max}`);
    yes(`${hz}Hz 把那根柱子立到小条三成以上（≥0.30，对应 17px 里多出 ~4.6px，不是躺在地板线上）`,
      t.bandsMax[b] >= 0.30, `纯音 ${t.bandsMax[b]}`);
    // 起落两条都改成「对着贴着取的那段对照比」的绝对差，不用倍数：这台机器随时在放别的东西，
    // 低中频那一格自己就有 0.27 的底，「<0.6×」在安静环境成立、在有环境声时根本不可满足
    // （实测 250Hz：停音后 0.2732 ← 纯音 0.4108，比值 0.66 挂了 —— 挂的是环境，不是引擎）。
    // 绝对差 + 同一格的前后对照，两头都不依赖环境有多吵。
    const rise = +(t.bandsMax[b] - pre.bandsMax[b]).toFixed(4);
    yes(`${hz}Hz 把那一格抬到贴着的前置对照之上 ≥0.10（激励真进了这一格，不是「比它大一点点」）`,
      rise >= 0.10, `纯音 ${t.bandsMax[b]} − 前置对照 ${pre.bandsMax[b]} = ${rise}`);
    yes(`放 ${hz}Hz 这段时间真有新分析窗`, t.windows > 10, `${t.windows} 窗`);
    const a = H['after' + hz];
    const drop = +(t.bandsMax[b] - a.bandsMax[b]).toFixed(4);
    yes(`${hz}Hz 停音后落回去：比纯音低 ≥0.10，且回到前置对照 +0.08 以内（不是停在半空）`,
      drop >= 0.10 && a.bandsMax[b] <= pre.bandsMax[b] + 0.08,
      `纯音 ${t.bandsMax[b]} → 停音后 ${a.bandsMax[b]}（降 ${drop}），前置对照 ${pre.bandsMax[b]}`);
    tops.push(t.top);
  }
  yes(`最亮位置随频率单调上移（${FREQS.join('/')}Hz → 第 ${tops.join(' / ')} 格；噪声造不出这个随激励变化的形状）`,
    tops.every((v, i) => i === 0 || v > tops[i - 1]));

  console.log('\n== A3. 停顿归零（在「背景不安静」下也成立的那条归零判据）==');
  yes('停抓取前纯音正响', H.stall.before > 0.05, `最后一帧峰值 ${H.stall.before}`);
  yes('停抓取后（不再有新分析窗）柱子一路压到 0，而不是冻在最后一帧',
    H.stall.afterMax === 0, `${H.stallMs}ms+320ms 后 bands=${JSON.stringify(H.stall.after)}`);
}

// ---------- B. 活着的岛（管道 + 真实屏幕像素）----------
// ---------- 出声的小工具 ----------
// 夹具从「起了进程」到「真的在放声」要一两秒（合成 + 打开播放器），按时间猜会量在静音段上，
// 那种时候读到的「没数据」是探针自己的时序，不是产品没抓到 —— 实测被这一条骗过两次。
// 所以一律等子进程亲口报 playing 之后再开始采样。
function feedLine(stream, cb) {
  let buf = '';
  stream.on('data', d => {
    buf += d.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) cb(l);
  });
}
function play(file, extra, tag = 'playing', onLine = null) {
  return new Promise((res, rej) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, file), ...extra],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', done = false;
    const st = { p, lines: [] };
    p.stderr.on('data', d => { err += d.toString('utf8'); });
    feedLine(p.stdout, l => {
      st.lines.push(l.trim());
      // 子进程后面还会打「这一段的结论」（render-endpoint 打 done frames=…），留着给判据的 detail 用：
      // 「没出声」和「出了声但引擎没抓到」是两件不同的事，得分得开。
      // onLine 和记录在同一个监听器里同步跑：'on 1' 常常和 'playing' 在同一个数据块里到，
      // 等 promise 兑现之后再挂第二个监听器就会漏掉第一段（漏了就把 on 段的样本记到 off 段上）。
      if (onLine) onLine(l);
      if (!done && l.includes(tag)) { done = true; res(st); }
    });
    p.on('exit', () => { if (!done) { done = true; rej(new Error(file + ' 没报 ' + tag + '：' + err.slice(0, 160))); } });
    // 超时的报文中途把已经收到的 stdout/stderr 都带上：2026-09-27 有一次 B8 卡在 25 秒没报 playing，
    // 光看「超时」两个字分不清是设备被上一个子进程占着、还是夹具根本没起来（同一份命令手工跑立刻出声）。
    setTimeout(() => {
      if (done) return;
      done = true; p.kill();
      rej(new Error(file + ' 25 秒内没报 ' + tag + '｜stdout=' + JSON.stringify(st.lines.slice(0, 4)) +
        '｜stderr=' + err.slice(0, 200)));
    }, 25000);
  });
}
// 引擎的分格边界（audio.ps1 的 BuildEdges：40Hz~16kHz 对数等分），拿同一个公式才知道某个频率该落第几格
const bandOf = (f, n) => {
  for (let i = 0; i < n; i++) {
    if (f >= 40 * Math.pow(400, i / n) && f < 40 * Math.pow(400, (i + 1) / n)) return i;
  }
  return -1;
};
// 往指定设备明暗交替放单频纯音，同时每 140ms 走一次管道读**整排**柱高：返回每一对的 on/off 样本、
// 「最大格」的配对差（diffs），以及逐格的配对差中位（bandMed）+ 该频率所在格（tb）。
// 为什么用「配对差」而不是「on 段比某个绝对值高」：这台机器常年有背景声（实测 bars 常年 0.5 以上），
// 绝对值判据在响环境里等于测别人放的歌；配对着减，背景声进的是两边共同的底。
// 为什么还要逐格：柱高是 dB 口径，环境里有人咳一声、「最大格」就能在 1.4 秒窗口里差出 0.11（约 5dB）——
// 那种绝对上限测的是「房间安静不安静」，不是「抓取设置有没有起作用」。真的证据带形状：激励是单频，
// 响应必须长在它那一格上，其余格只是共同的底。
async function pairedBars(epIndex, freq = 1000, amp = 0.6) {
  const ON = 1400, OFF = 1400, PAIRS = 4, GUARD = 400;
  const buckets = {};
  let cur = null;
  const st = await play('test/render-endpoint.ps1', ['-Index', String(epIndex), '-Tones', String(freq),
    '-Amp', String(amp), '-HoldMs', String(ON), '-GateMs', String(OFF), '-Pairs', String(PAIRS)],
  'playing', l => {
    if (l.startsWith('on ')) cur = { ph: 'on', k: +l.slice(3), t0: Date.now() };
    else if (l.startsWith('off ')) cur = { ph: 'off', k: +l.slice(4), t0: Date.now() };
  });
  const med = xs => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  let nB = 0;
  // 每段开头 GUARD 毫秒不算：柱子从上一段留过来要过引擎的停顿衰减（150ms）+ 250ms 的压零斜坡，
  // 那几帧画的还是旧值，不算掉就会把 on 段末尾的余势记进 off 段，把差抹平。
  while (st.p.exitCode === null) {
    const s = await ask({ cmd: 'audio' }).catch(() => null);
    if (cur && s && s.ok && Array.isArray(s.bars) && s.bars.length && Date.now() - cur.t0 > GUARD) {
      nB = s.bars.length;
      const b = buckets[cur.k] || (buckets[cur.k] = { on: [], off: [] });
      b[cur.ph].push(s.bars.map(v => +v || 0));
    }
    await sleep(140);
  }
  const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const diffs = [], thin = [], perBand = [];
  for (const k of keys) {
    const o = buckets[k].on || [], f = buckets[k].off || [];
    if (o.length < 2 || f.length < 2) { thin.push(`第${k}对 on${o.length}/off${f.length}`); continue; }
    const bd = [];
    for (let i = 0; i < nB; i++) bd.push(med(o.map(x => x[i] || 0)) - med(f.map(x => x[i] || 0)));
    perBand.push(bd);
    diffs.push(med(o.map(maxOf)) - med(f.map(maxOf)));
  }
  const bandMed = Array.from({ length: nB }, (_, i) => med(perBand.map(d => d[i])));
  const tb = bandOf(freq, nB);
  const others = bandMed.filter((_, i) => i !== tb);
  const tone = tb >= 0 ? bandMed[tb] : maxOf(bandMed);
  const otherMed = med(others);
  // 「成形状」= 激励那一格比其余格**涨**得多。两边都先夹到 0 以上再相减：
  // 环境在 on 段里自己变轻时，其余格的中位差是负的（实测 −0.101），拿负数当被减数会把
  // 「一格都没涨」(tone=0.000) 算成 0.101 的形状 —— 那是房间安静下去了，不是这台被抓住了。
  const pos = v => Math.max(0, v);
  return { diffs, thin, keys, lines: st.lines, med, buckets, bandMed, tb, tone, otherMed,
           shape: pos(tone) - pos(otherMed) };
}
// audio.json 的 sources 一行一个设备：EP0(default) {91f515a win=69 idle=359819ms rms=0.0000
// 那个设备 token 是引擎 Tail() 的结果 —— 「最后一个点之后取 8 个字符」，MMDevice 的 id 长这样：
//   {0.0.0.00000000}.{91f515ae-3702-48c9-b46f-6ecf517ecdd2}  ->  {91f515a
// 完整 id 不落盘（见 docs/CONFIG.md 的隐私那一节），测试这边用同一个算法（tailOf）才认得回是哪台。
function parseSources(s) {
  return String(s || '').split('|').map(t => {
    const m = /^\s*EP(\d+)(\(default\))?\s+(\S+)\s+win=(\d+)\s+idle=(\S+)(?:\s+rms=([\d.]+))?/.exec(t.trim());
    if (!m) return null;
    return { ep: +m[1], def: m[2] === '(default)', id: m[3], win: +m[4], idle: m[5], rms: m[6] === undefined ? -1 : +m[6], line: t.trim() };
  }).filter(Boolean);
}
const maxOf = v => (v && v.length ? Math.max(...v) : 0);
// 和 audio.ps1 的 Tail() 一条规则（判据拿端点 id 认设备用；两边不一致就会认错设备）
const tailOf = id => {
  const i = id.lastIndexOf('.');
  return (i > 0 && id.length >= i + 9) ? id.slice(i + 1, i + 9) : (id.length > 8 ? id.slice(0, 8) : id);
};
// 端点表（render-endpoint.ps1 -List 的顺序和引擎的 RebuildSources 同一套规则：默认在前）
async function endpoints() {
  const txt = await new Promise((res, rej) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(ROOT, 'test', 'render-endpoint.ps1'), '-List'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '', e = '';
    p.stdout.on('data', d => { s += d.toString('utf8'); });
    p.stderr.on('data', d => { e += d.toString('utf8'); });
    p.on('exit', () => s.trim() ? res(s) : rej(new Error('-List 空输出：' + e.slice(0, 160))));
    setTimeout(() => { if (s.trim()) res(s); else rej(new Error('-List 15 秒没输出')); }, 15000);
  });
  return txt.split(/\r?\n/).map(l => /^\s*(\d+)\s+(default\s+)?(\{.+)/.exec(l.trim()))
    .filter(Boolean).map(m => ({ i: +m[1], def: !!m[2], id: m[3] }));
}

async function liveHalf() {
  console.log('== B0. 抓取层先答话 ==');
  // 判据是「API 应答不慢」本身：岛刚重启时抓取层在做首轮队列加载 + 天气/日程刷新，
  // 那会儿管道连上却几秒不答话（实测发生过一次）。频谱这条链路对外就靠这一根管道，
  // 所以这里把它当判据测，而不是当噪声重试到通为止。
  let lat = -1, p = null;
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    try { p = await ask({ cmd: 'ping' }); lat = Date.now() - t0; } catch (e) { lat = 9999; p = { reason: e.message }; }
    if (p && p.ok) break;
    await sleep(2000);
  }
  yes('ping 答话了（抓取层活着、管道在听）', p && p.ok === true, JSON.stringify(p && (p.pid || p.reason)));
  yes('ping 一次答话不超过 3 秒（超过就是抓取层把自己堵住了，外部软件等不到频谱）', lat < 3000, lat + 'ms');

  console.log('\n== B1. 管道：开频谱、取快照 ==');
  const cfg0 = await ask({ cmd: 'config' });
  if (!cfg0.ok) { yes('管道 ping 得通、config 读得到', false, JSON.stringify(cfg0)); return; }
  const wasOn = !!cfg0.island.audioOn;
  const wasUnread = cfg0.island.showUnread !== false;
  const wasTrigger = String(cfg0.island.trigger || 'hover');
  orig.island = { audioOn: wasOn, showUnread: wasUnread, trigger: wasTrigger };
  orig.got = true;
  console.log(`  现值 audioOn=${wasOn} showUnread=${wasUnread} trigger=${wasTrigger}（测完还原成这三个）`);

  // 测期间把「未读 N」角标收掉：柱子排在角标前面，柱子一收角标就左移进同一块屏幕位置（实测数到
  // 43 个亮像素比静采还多 —— 那是角标进来了，不是柱子没收）。小条里只有它是「会随柱子收放而挪位」
  // 的元素，收掉它这块对照才干净；测完还原，不动用户的配置。
  const hideBadge = await ask({ cmd: 'config.set', island: { showUnread: false } });
  yes('config.set 收得住角标（对照才不受布局左移污染）', hideBadge.ok === true, JSON.stringify(hideBadge && hideBadge.island && hideBadge.island.showUnread));
  // 再把触发方式锁成 manual（只认托盘和管道）：这套判据要数屏幕上固定的那块矩形，而鼠标碰巧压过
  // 小条就会把面板展开 —— 同一块屏幕位置上换成了别的内容（实测过一次整段作废：面板 602px 高，
  // 「未读」列表盖住了柱子那块）。这不是判据太严，是有人在用这台机器；锁掉触发、测完还原。
  const lockTrig = await ask({ cmd: 'config.set', island: { trigger: 'manual' } });
  yes('config.set 把触发方式锁成 manual（鼠标经过不会再展开面板，数像素期间小条保持常驻）',
    lockTrig.ok === true && lockTrig.island.trigger === 'manual', JSON.stringify(lockTrig && lockTrig.island && lockTrig.island.trigger));

  const off = await ask({ cmd: 'config.set', island: { audioOn: false } });
  yes('config.set 写 audioOn=false 成功（先量「没柱子」的那个状态）', off.ok === true, JSON.stringify(off));
  await sleep(1400);
  const litBase = pix();
  yes('岛窗口在屏幕上（拿得到矩形才谈得上像素）', litBase.ok === true, JSON.stringify(litBase));

  const on = await ask({ cmd: 'config.set', island: { audioOn: true } });
  yes('config.set 写 audioOn=true 成功', on.ok === true, JSON.stringify(on));
  let a = null;
  for (let i = 0; i < 90; i++) {
    a = await ask({ cmd: 'audio' });
    if (a.ok && /^ok/.test(String(a.status || '')) && !a.stale) break;
    if (String(a.reason || '').includes('不认识')) { a.reason = '抓取层还是老代码：先 scripts/launch.ps1 重启再跑这一半'; break; }
    await sleep(400);
  }
  yes('{"cmd":"audio"} 回的是就绪状态而不是「没起来 / not compiled」',
    a && a.ok === true && /^ok/.test(String(a.status || '')), JSON.stringify(a && (a.status || a.reason)));
  yes('快照里 on=true、ageMs<3000（岛每半秒原子替换 audio.json，不是躺一份旧的）',
    a && a.on === true && a.ageMs < 3000, a && `on=${a.on} ageMs=${a.ageMs}`);
  yes('bands 长度 = 配置格数，且每格都在 0~1',
    a && Array.isArray(a.bands) && a.bands.length === a.bandsN && a.bands.every(v => v >= 0 && v <= 1),
    a && `${a.bands.length} 格 bandsN=${a.bandsN}`);
  // 「引擎活着」这条挪到 B2 的门控放音段上去验，不在这儿干等 900ms：
  // loopback 在整机完全无声时一个包都不给，windows 计数本来就不动（实测这次跑的时候环境全 0，
  // 11582 → 11582）。无声段数不出「活着」，只数得出「环境安静」——那是设备的性质不是引擎的。
  // 判据一个字没放宽：还是要求两次取管道之间真的有新分析窗，只是把它挂在同一场放音上（不额外出声）。
  const w0 = a ? a.windows : 0;
  const a2 = await ask({ cmd: 'audio' });
  yes('音频快照带 windows 计数（B2 要靠它在放音段之间比增量）',
    typeof a2.windows === 'number' && a2.windows >= w0, `${w0} → ${a2.windows}`);
  // 这一刻机器大概率是安静的，所以这里**不**要求 barRect —— 柱子已经改成「有声音才占位」，
  // 安静时那块矩形本来就该缺席（B6 正面测这条）。这里验的是两份口径都从管道出得来。
  yes('快照里有 bars 这一份柱高（显示口径），长度 = 格数且每格 0~1',
    Array.isArray(a.bars) && a.bars.length === a.bandsN && a.bars.every(v => v >= 0 && v <= 1),
    a && `${(a.bars || []).length} 格 barsN=${a.bandsN}`);
  // bars 是 dB 折算出来的，没有折算用的那一档就解不开：所以 floorDb 必须和 bands/bars 一起在快照里
  yes('快照里带 floorDb（柱高的折算档位，外部拿它才能把 bars 还原成物理量）',
    typeof a.floorDb === 'number' && a.floorDb > 0 && a.floorDb <= 120, a && `floorDb=${a.floorDb}`);
  const srcLines = String(a.sources || '').split('|').map(s => s.trim()).filter(Boolean);
  yes('快照里逐设备报 sources（哪台在响、出过多少窗、rms 多少），至少一台',
    srcLines.length >= 1 && srcLines.every(s => /^EP\d/.test(s) && /win=\d+/.test(s) && /rms=/.test(s)),
    JSON.stringify(srcLines));

  console.log('\n== B2. 屏幕像素：柱子真的画出来了 ==');
  // 只数渲染层自己报出来的那块（audio.json 的 barRect），不数整窗。整窗当判据错过一次：
  // 窗口是透的，桌面内容从后面混进来 —— 频谱一开小条变宽、透出来的东西跟着换，整窗「亮像素」
  // 反而从 204 掉到 174，比不放音还少。那种数法把真功能判成假阴性，桌面碰巧变暗时还会判成假阳性。
  // 矩形不再在这儿从快照拿：柱子改成「有声音才占位」之后，安静那一刻 barRect 本来就不出现，
  // 拿不到就整段判据作废（那是判据挑错了时刻，不是产品坏了）。改成从下面门控放音的**有声段**里
  // 取渲染层自报的矩形 —— 坐标仍然由渲染层给，判据不猜。
  let R = null;
  const barsSeen = [];
  // 这一场是全套测试里唯一「用屏幕像素当判据」的地方，出声只有这里：和弦以峰值 0.5 明暗交替放
  // 6 对（on/off 各 900ms），亮像素由常驻采样器每 120ms 记一次（单次起 powershell 要 0.7 秒，
  // 那个节奏跟不上一段一段的门）。为什么配对着减而不是前后各数一次，见文件头。
  // 每段 900ms 而不是 700ms：减去 GUARD 之后 on 段只剩三四个采样帧，某一对的中位数就会和
  // off 段打平（实测 5 对里第 3 对差值正好 0 —— 那是帧数太少，不是柱子没动）。
  const CHORD = [200, 500, 1200, 3000, 6000];
  const PAIRS = 6, ONMS = 900, OFFMS = 900, GUARD = 350;
  const med = xs => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const buckets = {};                 // k -> { on: [lit…], off: [lit…] }
  let cur = null;
  const watcher = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(ROOT, 'tools', 'pixel-audio.ps1'), '-Watch', '120', '-For', '21000'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  // 每段开头 GUARD 毫秒不算：柱子从上一段留过来要过引擎的 EMA 和停顿衰减（150ms+250ms），
  // 那几帧画的还是旧值 —— 不算掉就会把「on 段末尾的余势」记进 off 段，把差值抹平。
  const feedLit = l => {
    let j = null;
    try { j = JSON.parse(l); } catch { return; }
    if (!cur || !j || typeof j.lit !== 'number') return;
    if (Date.now() - cur.t0 < GUARD) return;
    const b = buckets[cur.k] || (buckets[cur.k] = { on: [], off: [] });
    b[cur.ph].push(j.lit);
  };
  feedLine(watcher.stdout, feedLit);
  // 同一段放音期间，每 300ms 走一次管道读 windows：这是「岛里的引擎活着」的现场证据
  // （B1 那句挪到这里）。数的是放音那 7 秒 —— 48kHz/4096 点 ≈ 21 窗/秒，五段 on 共 3.5 秒
  // 就有 ~70 窗，而阈值只取 15：引擎哪怕只在一半的 on 段里干活也过，整条冻住才不过。
  const wObs = [];
  let polling = true;
  const poll = setInterval(() => {
    ask({ cmd: 'audio' }).then(s => {
      if (!polling || !s || !s.ok) return;
      if (typeof s.windows === 'number') wObs.push(s.windows);
      if (!R && Array.isArray(s.barRect)) R = s.barRect;         // 有声段里渲染层一报就抓住
      if (Array.isArray(s.bars) && s.bars.length) barsSeen.push(Math.max(...s.bars));
    }).catch(() => { });
  }, 300);
  const played = await new Promise(res => {
    const t = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(ROOT, 'test', 'audio-harness.ps1'), '-Tones', CHORD.join(','), '-Amp', '0.5',
      '-HoldMs', String(ONMS), '-GateMs', String(OFFMS), '-Pairs', String(PAIRS)],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let done = false;
    // 等子进程亲口报「这一段的门开了」再分桶：合成音频要一两秒，按时间猜会量在静音段上
    feedLine(t.stdout, l => {
      if (l.startsWith('on ')) { cur = { ph: 'on', k: +l.slice(3), t0: Date.now() }; }
      else if (l.startsWith('off ')) { cur = { ph: 'off', k: +l.slice(4), t0: Date.now() }; }
    });
    t.on('exit', () => { if (!done) { done = true; res(true); } });
    setTimeout(() => { if (!done) { done = true; t.kill(); res(false); } }, 32000);
  });
  await sleep(900);                       // 最后一段的 off 也要采到
  cur = null;
  watcher.kill();
  polling = false;                        // 先关闸再清定时器：在途那次回包不许再进桶
  clearInterval(poll);
  const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const onAll = [], offAll = [], diffs = [], seps = [];
  for (const k of keys) {
    const o = (buckets[k].on || []).filter(v => v >= 0), f = (buckets[k].off || []).filter(v => v >= 0);
    onAll.push(...o); offAll.push(...f);
    if (o.length && f.length) {
      diffs.push(med(o) - med(f));
      seps.push(Math.min(...o) - Math.max(...f));   // 这一对里「最差的一帧」离「最好的一帧」多远
    }
  }
  const silent = offAll;
  yes('放音那 7 秒里走管道读到的 windows 涨了 ≥15（岛里的引擎活着，不是一份躺着的快照）',
    wObs.length >= 4 && (Math.max(...wObs) - Math.min(...wObs)) >= 15,
    `${wObs.length} 次取样 ${Math.min(...wObs)} → ${Math.max(...wObs)}（起点 ${w0}）`);
  const pairs = keys.map(k => ({ k, on: (buckets[k].on || []).filter(v => v >= 0), off: (buckets[k].off || []).filter(v => v >= 0) }));
  const thin = pairs.filter(p => p.on.length < 3 || p.off.length < 3).map(p => `第${p.k}对 on${p.on.length}/off${p.off.length}`);
  yes('门控跑完了，每一对都采到 ≥3 帧 on 和 ≥3 帧 off（对内帧太少时中位数会打平，那是采样器或夹具掉了，不是柱子没动）',
    played === true && pairs.length >= 4 && thin.length === 0,
    `${pairs.length} 对：on ${onAll.length} 帧 / off ${offAll.length} 帧${thin.length ? '；偏少：' + thin.join(' ') : ''}`);
  yes('放音期间渲染层报出了柱子矩形 barRect（坐标由渲染层给，判据不猜；安静时它本该缺席）',
    Array.isArray(R) && R.length === 4 && R[2] >= 12 && R[3] >= 8, JSON.stringify(R));
  yes('barRect 落在窗口矩形之内（越界说明 DPI/缩放换算错了，数到桌上的蓝东西就是假信号）',
    R && litBase.ok === true && R[0] >= 0 && R[1] >= 0 && R[0] + R[2] <= litBase.rect[2] && R[1] + R[3] <= litBase.rect[3],
    `barRect=${JSON.stringify(R)} 窗口=${JSON.stringify(litBase.rect)}`);
  yes('柱子地板本身就占着亮像素（这块矩形真的盖着柱子，不是数在小条空白处）',
    med(offAll) >= 10, `off 段中位数 ${med(offAll)} / 矩形 ${R ? R[2] + 'x' + R[3] + '=' + R[2] * R[3] : '没拿到'} 像素`);
  yes('每一次「放音段」的中位数都比紧挨着的那次「静默段」高（配对同号，环境声和这个门不相关）',
    diffs.length >= 4 && diffs.every(d => d > 0), JSON.stringify(diffs.map(d => +d.toFixed(1))));
  yes('配对差平均 ≥12 个亮像素（每根柱子约 5px 宽 × 17px 高，等于三根柱子各立起五成）',
    diffs.length > 0 && diffs.reduce((a, b) => a + b, 0) / diffs.length >= 12,
    `均值 ${(diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length)).toFixed(1)}，on 中位 ${med(onAll)} vs off 中位 ${med(offAll)}`);
  yes('而且每一对内部完全分离：放音段最少的一帧也比静默段最多的一帧多 ≥8 个亮像素（≥4 对成立，不是某一帧撞高）',
    seps.filter(s => s >= 8).length >= 4, `逐对最小间距 ${JSON.stringify(seps)}`);

  console.log('\n== B3. 落盘的那份只有频段能量（隐私闸）==');
  const buf = readFileSync(join(D, 'audio.json'));
  yes('audio.json 首字节不是 BOM（管道那边 node JSON.parse 才不炸）', buf[0] !== 0xEF);
  const j = JSON.parse(buf.toString('utf8'));
  const allowed = ['bands', 'bars', 'floorDb', 'level', 'peakHz', 'windows', 'idleMs', 'status', 'sources', 'at', 'on', 'bandsN', 'barRect'];
  yes('键集合不越界：只有频段能量/柱高、几个统计数和一块矩形，没有别的东西被写下来',
    Object.keys(j).every(k => allowed.includes(k)), Object.keys(j).join(','));
  // 只有两处可能是字符串：status（一句 "ok rate=… "）和 sources（逐设备一行 + 截断设备 token）。
  // 所以这一条判的是「这两个字段各自都长不出音频内容/文本/路径」：sources 必须逐行严格成形，
  // 设备 token 只许是十六进制/花括号/短横这一类（≤16 字符，装不下一句歌词、也装不下路径）。
  const strs = Object.entries(j).filter(([, v]) => typeof v === 'string').map(([k]) => k).sort().join(',');
  const srcShape = String(j.sources || '').split('|')
    .every(s => /^\s*EP\d+(\(default\))? [0-9a-f{}.-]{1,16} win=\d+ idle=(never|\d+ms)( rms=[\d.]+)?( err=[^\\:]{0,40})?\s*$/.test(s));
  yes('这里只有 status / sources 两个字符串，sources 逐行严格成形且设备 token 是截断的短十六进制（不落完整端点名、不落任何音频内容）',
    strs === 'sources,status' && srcShape,
    JSON.stringify({ keys: strs, lines: String(j.sources || '').split('|').map(s => s.trim()) }));
  yes('没有超过 96 字符的字符串字段（音频内容/歌词/应用名都不可能藏在这里）',
    Object.values(j).filter(v => typeof v === 'string').every(s => s.length <= 96),
    JSON.stringify(Object.entries(j).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${k}:${v.length}`)));

  console.log('\n== B4. 关掉再打开：引擎要真的重开，而不是认了那句旧 status ==');
  // 回归：Stop() 曾经只置 run=false、不改 status，于是「已经开着」的判断被上一次成功留下的
  // "ok rate=…" 骗过去，关一下再开之后没有线程在跑，柱子永远躺平而管道里一切正常。
  // 为什么这一段必须自己出声：loopback 在整机安静时一个包都不给，安静里 windows 本来就不涨，
  // 那条「重开后要涨」的判据就没有激励了 —— 挂一段门控和弦上去，测的才是同一条路。
  const wBefore = a2.windows;
  await ask({ cmd: 'config.set', island: { audioOn: false } });
  await sleep(1500);
  await ask({ cmd: 'config.set', island: { audioOn: true } });
  let wAfter = 0, st2 = '';
  const st4 = await play('test/audio-harness.ps1', ['-Tones', '1000,3000', '-Amp', '0.5',
    '-HoldMs', '700', '-GateMs', '400', '-Pairs', '14']);
  try {
    for (let i = 0; i < 40; i++) {
      const b = await ask({ cmd: 'audio' });
      st2 = String(b.status || '');
      if (b.ok && /^ok/.test(st2)) { wAfter = b.windows; if (wAfter > wBefore + 3) break; }
      await sleep(400);
    }
  } finally { st4.p.kill(); }
  yes('重新打开后分析窗继续往前涨（引擎真被重开了，不是躺着的旧计数）',
    wAfter > wBefore + 3, `windows ${wBefore} → ${wAfter}（status=${st2.slice(0, 24)}）`);

  console.log('\n== B6. 有声音才占位：越过 audioShowBar 就出现、安静满 audioHideMs 就收起、再出声又回来 ==');
  // 「该不该占位」这条规则的输入是「柱高有没有越过 audioShowBar」，所以判据要动这个输入本身。
  // 为什么不等环境自己安静下来：这台机器常年有背景声（2026-09-27 实测：bilibili/QQ/WorkBuddy 的
  // 会话一直 ACTIVE，回环流每 20~80ms 出一个分析窗，bars 常年 0.5 以上），拿「等一段安静」当
  // 前置条件等于把判据挂在别人什么时候停手上 —— 那种写法要么永远跑不到「收起」那一半，
  // 要么在某次偶然安静时跑到、下次又测不到。抬起/放低门限是同一件事的可控版本，两个方向都必然出现一次。
  const HIDE = 600, SHOW_HI = 0.97, SHOW_LO = 0.02;
  const wasHide = cfg0.island.audioHideMs === undefined ? 1200 : +cfg0.island.audioHideMs;
  const wasShow = cfg0.island.audioShowBar === undefined ? 0.06 : +cfg0.island.audioShowBar;
  orig.island.audioHideMs = wasHide;
  orig.island.audioShowBar = wasShow;
  const setHi = await ask({ cmd: 'config.set', island: { audioHideMs: HIDE, audioShowBar: SHOW_HI } });
  yes('config.set 改得动这两项：audioHideMs=' + HIDE + 'ms、audioShowBar 抬到 ' + SHOW_HI + '（现场没有任何东西够得着它）',
    setHi.ok === true && setHi.island.audioHideMs === HIDE && setHi.island.audioShowBar === SHOW_HI,
    JSON.stringify({ hide: setHi.island && setHi.island.audioHideMs, show: setHi.island && setHi.island.audioShowBar }));
  // 收起要等满宽限期，所以头一段还在场是正常的；判的是「收下去之后站不站得住」。
  // 这里不能一见到缺席就 break —— 那样「缺席 ≥3 个样本」永远凑不齐（判据自己把自己做死了）。
  const wA = (await ask({ cmd: 'audio' })).windows;
  const S1 = [];
  const t1 = Date.now();
  let over = 0;                              // 采样期间真越过新门限的帧数（环境那么响的话会有）
  while (Date.now() - t1 < 7000) {
    const s = await ask({ cmd: 'audio' });
    if (s && s.ok) {
      const b = maxOf(s.bars);
      if (b >= SHOW_HI) over++;
      S1.push({ t: Date.now() - t1, bars: b, rect: !!s.barRect, on: s.on, status: String(s.status || ''), idle: +s.idleMs || 0, windows: s.windows });
    }
    await sleep(150);
  }
  const last1 = S1[S1.length - 1];
  const gone = S1.filter(s => !s.rect).length;
  // 尾部连续 4 个样本（≈1.5 秒）都不在：单次缺席可能是「刚巧那一帧在收起的临界上」，站得住才是规则在起作用
  const tailAbsent = S1.length >= 4 && S1.slice(-4).every(s => !s.rect);
  yes('抬高门限之后 barRect 真的收掉了，而且收住之后站得住（尾部连续 4 个样本 ≈1.5 秒都不在场）',
    !!last1 && tailAbsent && gone >= 4,
    `缺席 ${gone}/${S1.length} 个样本，尾段 ${S1.slice(-4).map(s => s.rect ? '在场' : '缺席').join('/')}；期间柱高越过 ${SHOW_HI} 的帧 ${over} 个（>0 就说明现场确实有东西够得着新门限，收起不了不是 bug）`);
  yes('收起不是因为抓取死了：on=true、status 还是 ok、分析窗还在往前涨',
    !!last1 && last1.on === true && /^ok/.test(last1.status) &&
    (last1.windows - wA >= 3 || last1.idle < 2000),
    S1.length ? `windows ${wA} → ${last1.windows}，idleMs=${last1.idle}，status=${last1.status.slice(0, 22)}` : '没有样本');
  const setLo = await ask({ cmd: 'config.set', island: { audioShowBar: SHOW_LO } });
  const S2 = [];
  const t2 = Date.now();
  while (Date.now() - t2 < 6000) {
    const s = await ask({ cmd: 'audio' });
    if (s && s.ok) S2.push({ t: Date.now() - t2, bars: maxOf(s.bars), rect: !!s.barRect });
    if (S2.length && S2[S2.length - 1].rect) break;
    await sleep(150);
  }
  const last2 = S2[S2.length - 1];
  yes('把门限放回 ' + SHOW_LO + '（同一台机器、同一段背景声，只动这一个数）之后 barRect 又出现了',
    setLo.ok === true && setLo.island.audioShowBar === SHOW_LO && !!last2 && last2.rect === true,
    S2.length ? `第 ${last2.t}ms 回到场，bars_max=${last2.bars.toFixed(3)} ≥ ${SHOW_LO}` : '一个样本都没取到');
  yes('两个方向各跑到一次（在场/缺席都出现过），所以这条规则不是恒真也不是恒假',
    S1.some(s => !s.rect) && S2.some(s => s.rect),
    `抬门限后缺席 ${S1.filter(s => !s.rect).length} 个样本 → 放低后在场 ${S2.filter(s => s.rect).length} 个`);
  const back6 = await ask({ cmd: 'config.set', island: { audioHideMs: wasHide, audioShowBar: wasShow } });
  yes('还原 audioHideMs / audioShowBar（' + wasHide + 'ms / ' + wasShow + '）',
    back6.ok === true && back6.island.audioHideMs === wasHide && back6.island.audioShowBar === wasShow,
    JSON.stringify({ hide: back6.island && back6.island.audioHideMs, show: back6.island && back6.island.audioShowBar }));

  console.log('\n== B7. 声音不在默认设备上时也要看得见（对照臂：只听默认设备时应当看不见）==');
  const eps = await endpoints();
  const wasAll = cfg0.island.audioAllDevices === undefined ? true : !!cfg0.island.audioAllDevices;
  orig.island.audioAllDevices = wasAll;
  if (eps.length < 2) {
    console.log(`  这台机器只有 ${eps.length} 台活动输出设备，B7 不适用（这一段一条断言都不算进分母）`);
  } else {
    const other = eps.find(e => !e.def) || eps[1];
    const onAll = await ask({ cmd: 'config.set', island: { audioAllDevices: true } });
    yes('config.set 把抓取范围设成「所有活动设备」', onAll.ok === true && onAll.island.audioAllDevices === true,
      JSON.stringify(onAll && onAll.island));
    await sleep(1200);
    // 臂一：抓全部 —— 往非默认那台明暗交替放 1000Hz。两条各自独立：
    //   (a) 那一行**自己**的窗数在涨（证明那条回环流真的开着、真的在出数据）；
    //   (b) 柱高跟着这个门走（证明抓到的东西进了显示，不只是计数）。
    // 基线取那一台自己的累计窗数（不是全局 windows、也不是 0）：非默认那台的计数可能是上一轮留下的老数，
    // 拿 0 当基线会让「110 − 0 ≥ 10」白过 —— 要测的是「这几秒里它自己多出了窗」。
    const base0 = parseSources((await ask({ cmd: 'audio' })).sources)
      .find(x => x.id === tailOf(other.id)) || { win: 0, line: '(那台还没被抓)' };
    const r1 = await pairedBars(other.i, TONE_HZ, TONE_AMP);
    const after1 = parseSources((await ask({ cmd: 'audio' })).sources);
    const mine1 = after1.find(x => x.id === tailOf(other.id)) || after1[other.i];
    const grow1 = mine1 ? mine1.win - base0.win : -1;
    yes(`往非默认设备（EP${other.i} ${tailOf(other.id)}）放音那 11 秒里，那一行自己的窗数涨了 ≥10（那条流真在出数据）`,
      grow1 >= 10, `基线「${base0.line}」→ 现在「${mine1 ? mine1.line : '没有这一行'}」`);
    yes('这一台的声真的进了柱高：每一对「放音段 − 紧挨着的静音段」都 >0，且中位差 ≥0.15（背景声和这个门不相关，一减就抵消）',
      r1.thin.length === 0 && r1.diffs.length >= 3 && r1.diffs.every(d => d > 0) &&
      r1.med(r1.diffs) >= 0.15, `逐对差 ${JSON.stringify(r1.diffs.map(d => +d.toFixed(3)))}${r1.thin.length ? '；帧偏少：' + r1.thin.join(' ') : ''}；${r1.lines.filter(l => l.startsWith('done')).join('')}`);
    // 形状：激励只有一个频率，所以响应必须长在它那一格（12 格里第 tb+1 格），其余格只是共同的底。
    // 这一条不看绝对高度，环境多响都不影响「响在哪一格」，所以它是这一段里唯一不会被背景声污染的正面证据。
    yes(`而且响应真的长在 ${TONE_HZ}Hz 那一格（第 ${r1.tb + 1} 格）：那一格的中位差 ≥0.15，且比其余 11 格的涨幅高 ≥0.08（不是别处碰巧响）`,
      r1.tb >= 0 && r1.tone >= 0.15 && r1.shape >= 0.08,
      `第 ${r1.tb + 1} 格 ${r1.tone.toFixed(3)} vs 其余格涨幅中位 ${r1.otherMed.toFixed(3)}（形状 ${r1.shape.toFixed(3)}）；逐格 ${JSON.stringify(r1.bandMed.map(d => +d.toFixed(2)))}`);
    // 臂二（对照）：只抓默认设备 —— 同一台机器、同一个激励、同一套配对，柱高就不该跟着这个门动。
    // 少了这一臂，臂一「过了」也可能只是背景声恰好在同一时刻变响。
    const onOne = await ask({ cmd: 'config.set', island: { audioAllDevices: false } });
    yes('config.set 退回「只听默认设备」', onOne.ok === true && onOne.island.audioAllDevices === false,
      JSON.stringify({ all: onOne.island && onOne.island.audioAllDevices }));
    let src1 = [];
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      src1 = parseSources((await ask({ cmd: 'audio' })).sources);
      if (src1.length === 1) break;
    }
    yes('只听默认设备时 sources 只剩一行，而且那行就是默认那台（非默认那台连被看的资格都没有）',
      src1.length === 1 && src1[0].def === true, JSON.stringify(src1.map(x => x.line)));
    const r2 = await pairedBars(other.i, TONE_HZ, TONE_AMP);
    // 对照臂为什么不写「每对差 ≤0.05」：柱高是 dB 口径，默认那台上背景声自己在 1.4 秒里起伏 5dB
    // 就是 0.11（2026-09-27 实测这一臂出过 0.084 / 0.114，同期 sources 里 EP0 的 rms 有 0.257 —— 房间在响）。
    // 那条绝对上限测的是「房间静不静」，不是「抓取设置起没起作用」，写出来就是把判据交给环境。
    // 换成两条与环境无关的：① 同一个频率格的响应必须塌下去（比抓全部那臂小 ≥0.10，且掉到不足三分之一）；
    // ② 这一臂不再成形状（那一格不比其余格高出 ≥0.05）—— 形状消失才是「这条流根本没被读」的样子。
    yes(`对照臂成立：同一格（第 ${r1.tb + 1} 格 / ${TONE_HZ}Hz）的响应只在抓全部设备时有——只听默认设备时它塌到 ≤ 抓全部那臂的三分之一以下、比那一臂小 ≥0.10、绝对值 ≤0.05，并且不再成形状（那一格的涨幅不比其余格高 ≥0.05）`,
      r2.diffs.length >= 3 && r2.tone <= r1.tone - 0.10 && r2.tone * 3 <= r1.tone &&
      r2.tone <= 0.05 && r2.shape <= 0.05,
      `只默认那台：第 ${r2.tb + 1} 格 ${r2.tone.toFixed(3)}（其余格涨幅中位 ${r2.otherMed.toFixed(3)}，形状 ${r2.shape.toFixed(3)}）vs 抓全部那臂 ${r1.tone.toFixed(3)}；这一臂逐对差 ${JSON.stringify(r2.diffs.map(d => +d.toFixed(3)))}`);
    const back7 = await ask({ cmd: 'config.set', island: { audioAllDevices: wasAll } });
    yes('还原 audioAllDevices', back7.ok === true && !!back7.island.audioAllDevices === wasAll,
      JSON.stringify({ all: back7.island && back7.island.audioAllDevices }));
  }

  console.log('\n== B8. 柱高就是 audioFloorDb 那条 dB 曲线，而且这个旋钮真的管用 ==');
  // 「比例不好看」这笔账要能自己验，所以这一段不数像素、只对着管道里同一份快照的两口径算：
  // bands 是物理量（满幅正弦≈1.0），bars 是画柱子用的那份，判据是逐格 bars == (20·log10(bands)+floor)/floor，
  // 两档 floor 各验一次 —— 只有「曲线本身对得上」成立，改 floor 才是「换斜率」而不是「换一套算法」。
  // 为什么不用 bands > 0.02 那种硬阈值当显示下限：老代码就是这么干的，于是那个数同时是「可见」
  // 和「该不该出现」两件事，小声内容永远进不来。现在两件事分开（B6 测出现/收起，这里测高度）。
  // 激励故意小声（峰值 0.09 ≈ -21dBFS）：这台机器随时可能在放别的东西，把音量拧大只是让环境
  // 相对变小，判据却会变成「比谁嗓门大」。安静代表段用「同一时刻的 bands/bars 配对」来抵消环境。
  const wasFloor = cfg0.island.audioFloorDb === undefined ? 46 : +cfg0.island.audioFloorDb;
  orig.island.audioFloorDb = wasFloor;
  const st9 = await play('test/audio-harness.ps1', ['-Tones', '200,500,1200,3000,6000', '-Amp', '0.09',
    '-HoldMs', '26000', '-Pairs', '1']);
  try {
    const curve = (v, f) => (v <= 0 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(v) + f) / f)));
    // 只认快照里自报的 floorDb：改配置到岛写下一份 audio.json 之间有一个间隔（~500ms），
    // 拿「我已经 set 过了」当事实会读到上一档的柱高 —— 实测就是这样把 dB 自校验判成偏差 0.49。
    const snap = async f => {
      for (let i = 0; i < 60; i++) {
        const s = await ask({ cmd: 'audio' });
        if (s.ok && Math.round(+s.floorDb) === f && maxOf(s.bands) > 0.035 &&
            Array.isArray(s.bars) && s.bars.length === s.bands.length) return s;
        await sleep(200);
      }
      return null;
    };
    const setF = async f => { const r = await ask({ cmd: 'config.set', island: { audioFloorDb: f } }); return r; };
    const r30 = await setF(30); const s30 = await snap(30);
    const r60 = await setF(60); const s60 = await snap(60);
    yes('config.set 改得动 audioFloorDb（30 / 60 两档都回读到，而且岛写进 audio.json 的 floorDb 也跟着变了）',
      r30.ok === true && r30.island.audioFloorDb === 30 && r60.island.audioFloorDb === 60 && !!s30 && !!s60,
      `config 回读 30/${r30.island && r30.island.audioFloorDb}、60/${r60.island && r60.island.audioFloorDb}；快照里 floorDb=${s30 && s30.floorDb} / ${s60 && s60.floorDb}`);
    const dev = (s, f) => (s ? Math.max(...s.bands.map((v, i) => Math.abs(s.bars[i] - curve(v, f)))) : 9);
    yes('逐格满足 bars = (20·log10(bands) + floor) / floor：两档各自代入，最大偏差 <0.002（柱高不是随手缩放的）',
      s30 && s60 && dev(s30, 30) < 0.002 && dev(s60, 60) < 0.002,
      `floor30 偏差 ${dev(s30, 30).toFixed(5)}，floor60 偏差 ${dev(s60, 60).toFixed(5)}`);
    // 抬起幅度这条只在「信号确实小声」时才有意义（满幅时两条曲线都顶到 1），所以先把前提写成断言：
    // 环境里别的东西压过来时这一条会如实不过，而不是悄悄白过。
    const bmax = s30 ? maxOf(s30.bands) : 1;
    yes('这段激励是小声档（bands_max ≤0.5，即满幅的一半以下；这就是用户那种「音乐声不大」的场景）',
      s30 && bmax > 0 && bmax <= 0.5, s30 && `bands_max=${bmax.toFixed(4)}（超过 0.5 就是环境里有别的声音，这段不算）`);
    yes('同一个信号，floor 从 30 调到 60 柱高真的抬起来 ≥0.05（小声内容靠它变显眼，满幅时两条曲线才重合）',
      s30 && s60 && maxOf(s60.bars) - maxOf(s30.bars) >= 0.05,
      `bars_max ${s30 && maxOf(s30.bars).toFixed(3)} → ${s60 && maxOf(s60.bars).toFixed(3)}`
      + `（同期 bands_max ${s30 && maxOf(s30.bands).toFixed(3)} → ${s60 && maxOf(s60.bands).toFixed(3)}）`);
    const px = (v, f) => 1.5 + curve(v, f) * 15.5;      // 渲染层的小条柱高：1.5 + y*15.5，共 17px
    const linPx = v => 1.5 + v * 15.5;                  // 老口径（直接拿物理量当高度）
    yes('这笔账就是「看不清」那件事：同一个物理电平，dB 口径的柱高比线性口径多 ≥2px（17px 的小条里）',
      s60 && px(maxOf(s60.bands), wasFloor) - linPx(maxOf(s60.bands)) >= 2,
      s60 && `bands_max=${maxOf(s60.bands).toFixed(4)}：线性口径 ${linPx(maxOf(s60.bands)).toFixed(1)}px → `
        + `dB 口径（默认 floor ${wasFloor}）${px(maxOf(s60.bands), wasFloor).toFixed(1)}px`);
    const backF = await ask({ cmd: 'config.set', island: { audioFloorDb: wasFloor } });
    yes('还原 audioFloorDb（回到 ' + wasFloor + '）', backF.ok === true && backF.island.audioFloorDb === wasFloor,
      JSON.stringify(backF && backF.island));
  } finally { st9.p.kill(); }

  console.log('\n== B5. 关掉之后真的收了 ==');
  // 这一条以前只在「用户原本是关着的」时才判 —— 那样它大多数时候根本没跑，等于白写。
  // 现在无条件先关一次、在同一块矩形里再数一遍（这才是「柱子收回去」的对照），最后还原成用户的现值。
  const off2 = await ask({ cmd: 'config.set', island: { audioOn: false } });
  yes('config.set 关得掉（下面那段对照要的就是这个状态）', off2.ok === true);
  await sleep(1700);
  const a3 = await ask({ cmd: 'audio' });
  yes('关掉后 audio.json 是全 0 + on=false（不给 API 留一份「看着还在响」的旧数据）',
    a3.ok === true && a3.on === false && a3.bands.every(v => v === 0),
    `on=${a3.on} status=${a3.status} bands=${JSON.stringify(a3.bands)}`);
  yes('关掉后 barRect 不再报（那块矩形已经没了，判据不会拿旧坐标去数空气）',
    a3.barRect === undefined, JSON.stringify(a3.barRect));
  await sleep(700);
  // 同一块矩形、同一个坐标再数一次：这时候柱子已经 Collapsed，矩形里应该只剩小条底色。
  // 但前提是小条还停在 B2 那个常驻态 —— 面板一旦展开，同一块屏幕位置上是别的内容（实测数到 49 个
  // 亮像素，比静采还多，那是假失败）。所以先把面板收回去，并且**等它落到常驻态**再验一次
  // （收起有动画，一次 900ms 偶尔不够；这是等前置条件稳定，不是放宽判据）。
  let coll = null, nowPix = null;
  for (let i = 0; i < 6; i++) {
    coll = await ask({ cmd: 'request', action: 'collapse' });
    await sleep(700 + i * 300);
    nowPix = pix();
    if (nowPix.ok && nowPix.rect[3] <= 40) break;
  }
  yes('测这段对照前，小条是常驻态（窗口高 = 那二十几像素；不然这块屏幕位置上是别的内容）',
    nowPix.ok === true && nowPix.rect[3] <= 40,
    `request=${JSON.stringify(coll && coll.action)} 窗口=${JSON.stringify(nowPix.rect)}`);
  const litOff = pixRect(R);
  yes('关掉后同一块矩形里的亮像素掉到静采以下（柱子真收回去了，不残留）',
    litOff.ok === true && litOff.lit < Math.min(...silent),
    `静采最少 ${Math.min(...silent)} → 关掉后 ${litOff.lit}`);
  const back = await ask({ cmd: 'config.set', island: { audioOn: wasOn } });
  yes('还原 audioOn 成功', back.ok === true);
  const backU = await ask({ cmd: 'config.set', island: { showUnread: wasUnread } });
  yes('还原 showUnread 成功（角标是用户自己的设置，测试不替他改）',
    backU.ok === true && !!backU.island.showUnread === wasUnread, `还原成 ${wasUnread}`);
  const backT = await ask({ cmd: 'config.set', island: { trigger: wasTrigger } });
  yes('还原 trigger 成功（测期间锁成 manual 只是为了不让鼠标把面板展开）',
    backT.ok === true && backT.island.trigger === wasTrigger, `还原成 ${wasTrigger}`);
  orig.restored = back.ok === true && backU.ok === true && backT.ok === true;
  if (wasOn) {
    // 还原不能只认那句 ok=true：关过就得证明再开得起来（走的是用户原值这条路）
    let w3 = 0;
    for (let i = 0; i < 40; i++) {
      const b = await ask({ cmd: 'audio' });
      w3 = b.windows || 0;
      if (b.ok && /^ok/.test(String(b.status || '')) && w3 > wBefore + 3) break;
      await sleep(400);
    }
    yes('还原成 true 之后分析窗又涨回来了（这次测试没把用户的环境改坏）',
      w3 > wBefore + 3, `windows ${wBefore} → ${w3}`);
  }
}

const t0 = Date.now();
try {
  if (!ONLY_LIVE) await engineHalf();
  if (!ONLY_ENGINE) await liveHalf();
} catch (e) {
  bad++; console.log('  FAIL 跑挂了：' + e.message);
} finally {
  // 中途抛异常时 B5 那段还原没跑到 —— 这里补一次，不许把用户的角标/悬停展开留在改过的状态上。
  if (orig.got && !orig.restored) {
    try {
      await ask({ cmd: 'config.set', island: orig.island });
      console.log('  （跑挂了，但已把 audioOn/showUnread/trigger 还原成 ' + JSON.stringify(orig.island) + '）');
    } catch (e2) {
      console.log('  ！还原也没成功（' + e2.message + '）：现在这三项可能还停在 '
        + JSON.stringify(orig.island) + ' 之外，自己 config 读一次对一下');
    }
  }
}
console.log(`\n分母：断言 ${n} 条，失败 ${bad} 条（用时 ${Math.round((Date.now() - t0) / 1000)}s）`);
if (WANT && n !== WANT) { console.log(`！断言数 ${n}，要求 ${WANT} —— 有人加了/删了断言`); bad++; }
if (bad) console.log('未过：\n  ' + fails.join('\n  '));
process.exit(bad ? 1 : 0);
