// PowerShell 5.1 会把「无 BOM 的 UTF-8」.ps1 当 GBK 读，里面的中文字符串直接炸解析器。
// 用编辑工具改过 .ps1 之后跑一下：node bom.mjs
// （写成文件而不是 node -e，是因为这个 shell 会把命令行里的 ! 转义成 \!，把脚本内容搞坏）
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

for (const f of readdirSync('.').filter(x => x.endsWith('.ps1'))) {
  const b = readFileSync(f);
  if (b[0] !== 0xEF || b[1] !== 0xBB || b[2] !== 0xBF) {
    writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), b]));
    console.log(`补了 BOM: ${f}`);
  } else {
    console.log(`BOM 已在: ${f}`);
  }
}
