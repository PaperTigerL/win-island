// 发布前的一道闸：扫一个目录（默认 dist/win-island），两类东西都要报：
//   1) 能识别到人的 —— 名单在旁边的 precheck-private.json，那个文件本身不许进发布包；
//   2) 密钥形状的 —— 规则是通用的，直接写在下面。
// 为什么要脚本而不是人眼看：仓库里 30 多个文件，人眼扫第三屏就开始漏；而公开的仓库撤不回来。
// 命中不等于一定有错（例如 a@x.com 是测试用的假地址），所以要人过一遍 —— 但「一条没有」才算过关。
// 用法：node precheck-publish.mjs [目录]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 默认扫发布包目录。写错这一行的后果是「扫了个不存在的目录 → 0 命中 → 报过关」，
// 所以路径不存在时当场炸而不是默默过关
const DIR = resolve(process.argv[2] || join(HERE, '..', 'dist', 'win-island'));
if (!existsSync(DIR)) { console.log(`要扫的目录不存在：${DIR}\n先跑 node scripts/pack-release.mjs`); process.exit(2); }

const SECRET = [
  ['长 base64/hex 串', '[A-Za-z0-9+/]{44,}={0,2}'],
  ['token/密码赋值', '(token|secret|api[_-]?key|password|passwd|credential)[s]?\\s*[:=]\\s*[\'"][^\'"\\s]{6,}'],
  ['URL 里带账号密码', '[a-z]{3,10}://[^\\s"\']{1,40}:[^\\s"\']{3,}@[a-z]'],
  ['带私参的代理链接', 'vmess://[A-Za-z0-9+/]|vless://[A-Za-z0-9]|trojan://[A-Za-z0-9]'],
  ['订阅拉取地址', 'sub[a-z]*\\.[a-z]{2,6}/[A-Za-z0-9_-]{16,}'],
  ['邮箱地址', '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\\.[a-z]{2,}'],
  // 机器上的家目录：里面直接就是 Windows 用户名，而用户名是能认出人的
  ['绝对家目录', 'C:\\\\Users\\\\[A-Za-z0-9._%-]{2,}'],
];
// 明显是假数据的就不算了，否则每条测试用例都要人解释一遍
const ALLOW = [/@x\.com$/i, /\.example$/i, /^example@/i, /C:\\\\Users\\\\[<%]/i,
  // 日历 RRULE 的关键字串（INTERVAL/BYDAY/BYSETPOS/...）：全大写加斜杠，正好落进 base64 的字符集
  /^[A-Z]{3,}(\/[A-Z]{2,})+$/];
const BIN = [];

const PF = join(HERE, 'precheck-private.json');
let PERSONAL = [];
if (existsSync(PF)) {
  const j = JSON.parse(readFileSync(PF, 'utf8'));
  PERSONAL = Object.entries(j).filter(([, v]) => Array.isArray(v)).map(([lab, v]) => [lab, v.join('|')]);
} else {
  console.log('！没找到 precheck-private.json —— 只跑通用密钥检查，个人信息这一类没扫（那个文件不该进发布包）');
}
// 扫描器自己的规则文件里全是这些串，不能把它自己报成泄漏
const SELF = /^(precheck-publish\.mjs|precheck-private\.json|pack-release\.mjs)$/i;

// 递归列全部文件：发布包从 v1 起就是 src/ test/ docs/ 的嵌套结构，
// 只扫顶层等于「最可能藏东西的子目录恰好没看」
// .git/ 不参与：那里面是本机的 reflog（含本地 git 配置里的身份），不是要公开的文件内容
const walk = d => readdirSync(d, { withFileTypes: true })
  .filter(e => !(e.isDirectory() && e.name === '.git'))
  .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);

const scan = (label, pats, { onBinary = 'ascii' } = {}) => {
  let n = 0;
  for (const p of walk(DIR)) {
    if (SELF.test(basename(p))) continue;
    let buf;
    try { buf = readFileSync(p); } catch { continue; }
    const bin = buf.subarray(0, 8192).includes(0);
    // 二进制里的 ASCII 串照样扫得出来（要认出人的那些都是 ASCII），但「长 base64 串」这类
    // 文本形状的规则在图标/exe 的字节流上必报 —— 假红一多，人就学会忽略整份报告，这道闸等于没装。
    if (bin && onBinary === 'skip') { BIN.push(p.slice(DIR.length + 1)); continue; }
    const t = bin ? buf.toString('latin1') : buf.toString('utf8');
    const rel = p.slice(DIR.length + 1).replace(/\\/g, '/');
    for (const [lab, pat] of pats) {
      const m = [...new Set(t.match(new RegExp(pat, 'gi')) || [])].filter(x => !ALLOW.some(rx => rx.test(x)));
      if (!m.length) continue;
      n += m.length;
      console.log(`  ${label} ${rel.padEnd(34)}${lab.padEnd(8)}${String(m.length).padStart(3)} 种  ${m.slice(0, 4).map(x => x.slice(0, 46)).join(' ⏎ ')}`);
    }
  }
  return n;
};

console.log(`扫描：${DIR}`);
console.log(`文件 ${walk(DIR).length} 个（递归）`);
const a = scan('个人', PERSONAL);
const b = scan('密钥', SECRET, { onBinary: 'skip' });
console.log(`\n个人信息 ${a} 处，密钥形状 ${b} 处。`);
if (BIN.length) console.log(`二进制 ${BIN.length} 个只按个人信息规则扫过（密钥形状规则对字节流没意义）：${BIN.join(', ')}`);
console.log(a + b === 0 && PERSONAL.length ? '过关：可以进公开仓库。' : '上面这些要人过一遍再决定。');
process.exit(a + b === 0 && PERSONAL.length ? 0 : 1);
