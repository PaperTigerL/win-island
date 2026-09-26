// 发布前的一道闸：扫一个目录（默认 dist/win-island），两类东西都要报：
//   1) 能识别到人的 —— 名单在旁边的 precheck-private.json，那个文件本身不许进发布包；
//   2) 密钥形状的 —— 规则是通用的，直接写在下面。
// 为什么要脚本而不是人眼看：仓库里 30 多个文件，人眼扫第三屏就开始漏；而公开的仓库撤不回来。
// 命中不等于一定有错（例如 a@x.com 是测试用的假地址），所以要人过一遍 —— 但「一条没有」才算过关。
// 用法：node precheck-publish.mjs [目录]
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.argv[2] || join(HERE, 'dist', 'win-island');

const SECRET = [
  ['长 base64/hex 串', '[A-Za-z0-9+/]{44,}={0,2}'],
  ['token/密码赋值', '(token|secret|api[_-]?key|password|passwd|credential)[s]?\\s*[:=]\\s*[\'"][^\'"\\s]{6,}'],
  ['URL 里带账号密码', '[a-z]{3,10}://[^\\s"\']{1,40}:[^\\s"\']{3,}@[a-z]'],
  ['带私参的代理链接', 'vmess://[A-Za-z0-9+/]|vless://[A-Za-z0-9]|trojan://[A-Za-z0-9]'],
  ['订阅拉取地址', 'sub[a-z]*\\.[a-z]{2,6}/[A-Za-z0-9_-]{16,}'],
  ['邮箱地址', '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\\.[a-z]{2,}'],
];
// 明显是假数据的就不算了，否则每条测试用例都要人解释一遍
const ALLOW = [/@x\.com$/i, /\.example$/i, /^example@/i];

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

const scan = (label, pats) => {
  let n = 0;
  for (const f of readdirSync(DIR)) {
    if (SELF.test(f)) continue;
    let t;
    try { if (!statSync(join(DIR, f)).isFile()) continue; t = readFileSync(join(DIR, f), 'utf8'); } catch { continue; }
    for (const [lab, p] of pats) {
      const m = [...new Set(t.match(new RegExp(p, 'gi')) || [])].filter(x => !ALLOW.some(rx => rx.test(x)));
      if (!m.length) continue;
      n += m.length;
      console.log(`  ${label} ${f.padEnd(24)}${lab.padEnd(16)}${String(m.length).padStart(3)} 种  ${m.slice(0, 4).map(x => x.slice(0, 46)).join(' ⏎ ')}`);
    }
  }
  return n;
};

console.log(`扫描：${DIR}`);
const a = scan('个人', PERSONAL);
const b = scan('密钥', SECRET);
console.log(`\n个人信息 ${a} 处，密钥形状 ${b} 处。`);
console.log(a + b === 0 && PERSONAL.length ? '过关：可以进公开仓库。' : '上面这些要人过一遍再决定。');
process.exit(a + b === 0 && PERSONAL.length ? 0 : 1);
