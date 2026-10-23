#!/usr/bin/env node
// P2-4 的源码级判据：未读列表左键只认鼠标下真正命中的 ListBoxItem，
// 空白/滚动条不能拿上一次 SelectedItem 去跳来源应用；复制分支保留。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;
const src = readFileSync(join(ROOT, 'src', 'island', 'island.ps1'), 'utf8');
const start = src.indexOf('$script:list.Add_MouseLeftButtonUp({');
const end = src.indexOf('$script:list.Add_MouseRightButtonUp({', start);
const block = start >= 0 && end > start ? src.slice(start, end) : '';

let n = 0, bad = 0;
function check(label, ok, detail) {
  n++;
  if (!ok) { bad++; console.log('  FAIL ' + label + (detail ? '\n        ' + detail : '')); }
  else console.log('  ok   ' + label);
}

check('能定位 list 左键处理器', block.length > 0);
check('用 ContainerFromPoint 取鼠标下的行', block.includes('ContainerFromPoint($pt)'));
check('命中不到行时直接 return', /if \(-not \$row\) \{ return \}/.test(block));
check('不再用 SelectedItem 作为跳转目标', !block.includes('list.SelectedItem'));
check('跳转用命中行的 raw', block.includes('Open-Source $row.raw'));
check('复制按钮分支保留', block.includes("$o.Text -eq '复制'"));
check('复制分支仍然只复制不跳转', /Copy-Message \$it\.raw \$false[\s\S]{0,40}return/.test(block));

console.log('');
console.log('分母：断言 ' + n + ' 条，失败 ' + bad + ' 条');
if (WANT && n !== WANT) { console.log('！断言数 ' + n + '，要求 ' + WANT + ' —— 有人加了/删了断言'); bad++; }
process.exit(bad ? 1 : 0);
