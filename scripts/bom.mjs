// PowerShell 5.1 会把「无 BOM 的 UTF-8」.ps1 当 GBK 读，里面的中文字符串直接炸解析器。
// 而且症状不一定是报错：中文注释最后一个字节可能是 0x60（反引号 = 行续接），
// 会把下一行的 param(...) 一起吞进注释，参数静默变成 $null。
// 用编辑工具改过任何 .ps1 之后跑一下：node scripts/bom.mjs
// （写成文件而不是 node -e，是因为这个 shell 会把命令行里的 ! 转义成 \!，把脚本内容搞坏）
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['dist', 'scratch', 'bin', 'node_modules', '.git']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ps1')) out.push(p);
  }
  return out;
}

let fixed = 0;
for (const f of walk(ROOT).sort()) {
  const b = readFileSync(f);
  const rel = f.slice(ROOT.length + 1);
  if (b[0] !== 0xEF || b[1] !== 0xBB || b[2] !== 0xBF) {
    writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), b]));
    console.log(`补了 BOM: ${rel}`);
    fixed++;
  } else {
    console.log(`BOM 已在: ${rel}`);
  }
}
console.log(fixed ? `共补 ${fixed} 个，再跑一次应当全部「已在」。` : '全部 .ps1 都带 BOM。');
