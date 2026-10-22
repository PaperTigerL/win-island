#!/usr/bin/env node
// 单向通知接入的判据：
//   1) fixture 3 条唯一（重复 id 只显示一条、坏行不挡后一行）；
//   2) 归一化字段完整（id 前缀 / app / title / body / level / ms / at / notifyOnly）；
//   3) 读前读后源文件 SHA-256 一致（测试侧在 PowerShell 退出后再独立算一次）；
//   4) 无文件静默、notify.path 解析与回落、换路径清空去重表；
//   5) notify.ps1 里没有任何写盘/联网/起进程的代码路径；island.ps1 的集成点都在。
//
//   node test/notify-test.mjs
//   node test/notify-test.mjs --expect 40
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;

// fixture 由测试侧创建并保留到 PowerShell 退出之后：这样才能独立复算「读前读后哈希一致」。
const fxDir = mkdtempSync(join(tmpdir(), 'win-island-notify-node-'));
const fx = join(fxDir, 'notifications.jsonl');
const FX = [
  '{"id":"a1","ts":"2026-10-22T15:00:00+08:00","from":"redalert","title":"第一条","body":"正文一","level":"info"}',
  '{"id":"a2","ts":"2026-10-22T15:01:00+08:00","from":"steward","title":"second","body":"body two","level":"warn"}',
  '{"id":"a1","ts":"2026-10-22T15:02:00+08:00","from":"redalert","title":"重复的那条","body":"不该出现","level":"info"}',
  'not-json-at-all',
  '{"id":"a3","ts":"2026-10-22T15:03:00+08:00","from":"infra","title":"third","body":"body three","level":"error"}',
];
writeFileSync(fx, FX.join('\n') + '\n', 'utf8');
const beforeHash = createHash('sha256').update(readFileSync(fx)).digest('hex').toUpperCase();

let result;
process.on('exit', () => {
  try { rmSync(fxDir, { recursive: true, force: true }); } catch { }
  try { if (result && result.tmp) rmSync(result.tmp, { recursive: true, force: true }); } catch { }
});

const raw = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  join(HERE, 'notify-harness.ps1'), '-Fixture', fx], { encoding: 'utf8', maxBuffer: 9e6 });
const line = raw.trim().split(/\r?\n/).pop();
try { result = JSON.parse(line); } catch (e) {
  console.log('拿不到 notify-harness.ps1 的 JSON 输出：' + e.message);
  console.log(raw);
  process.exit(1);
}

let bad = 0;
for (const c of result.checks || []) {
  if (c.ok) console.log('  ok   ' + c.name);
  else { bad++; console.log('  FAIL ' + c.name + '\n        ' + c.detail); }
}
const n = (result.checks || []).length;

function eq(label, want, got) {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  if (!ok) { bad++; console.log(`  FAIL ${label}\n        期望 ${JSON.stringify(want)}\n        实得 ${JSON.stringify(got)}`); }
  else console.log(`  ok   ${label} = ${JSON.stringify(got)}`);
}
function has(label, hay, needle) { eq(label, true, String(hay).includes(needle)); }
function hasNot(label, hay, needle) { eq(label, false, String(hay).includes(needle)); }

// 测试进程退出后再独立算一次哈希：证明读操作确实没改源文件
let afterHash = '';
try { afterHash = createHash('sha256').update(readFileSync(fx)).digest('hex').toUpperCase(); } catch { }
eq('PowerShell 侧读前哈希 == 测试侧读前哈希', result.hashBefore, beforeHash);
eq('PowerShell 侧读前哈希 == 读后哈希', result.hashBefore, result.hashAfter);
eq('测试侧退出后重算哈希 == 读前哈希', result.hashBefore, afterHash);

const NOTIFY = readFileSync(join(ROOT, 'src', 'island', 'notify.ps1'), 'utf8');
const ISLAND = readFileSync(join(ROOT, 'src', 'island', 'island.ps1'), 'utf8');
const DOC = readFileSync(join(ROOT, 'docs', 'CONFIG.md'), 'utf8');

console.log('\n== 只读边界（源码级） ==');
const writeApis = ['Set-Content', 'Add-Content', 'Out-File', 'WriteAllText', 'WriteAllBytes',
  'AppendAllText', 'AppendAllLines', 'FileMode::Create', 'FileMode::Append'];
const netApis = ['Invoke-WebRequest', 'Invoke-RestMethod', 'HttpClient', 'WebClient', 'WebRequest',
  'curl.exe', 'wget', 'TcpClient'];
const procApis = ['Start-Process', 'System.Diagnostics.Process', 'ProcessStartInfo', 'Invoke-Expression', 'iex '];
eq('notify.ps1 没有写盘 API', [], writeApis.filter(x => NOTIFY.includes(x)));
eq('notify.ps1 没有联网 API', [], netApis.filter(x => NOTIFY.includes(x)));
eq('notify.ps1 没有起进程/执行字符串的 API', [], procApis.filter(x => NOTIFY.includes(x)));
has('只读打开源文件（FileAccess.Read）', NOTIFY, '[System.IO.FileAccess]::Read');
has('不占用写者（共享 ReadWrite/Delete）', NOTIFY, '[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete');

console.log('\n== island.ps1 集成点 ==');
has('dot-source notify.ps1', ISLAND, ". (Join-Path $PSScriptRoot 'notify.ps1')");
has('Open-Source 对 notifyOnly 提前返回', ISLAND, 'if ($item.notifyOnly) {');
has('未读列表合并队列 + 外部通知', ISLAND, 'Get-AllItems | Where-Object');
has('账本保留非数字 id 不抛 [int64]', ISLAND, '[int64]::TryParse([string]$k, [ref]$n)');
has('live 对账仍只吃队列条目', ISLAND, 'Get-LiveDiff -All $script:All');
has('主循环每秒调 Sync-Notify', ISLAND, 'Sync-Notify        # 外部通知');
has('启动时静默入账并记录路径', ISLAND, '外部通知 path=$($script:NotifyPath) 存在=');
has('notify.path 热加载', ISLAND, '$np = Get-NotifyPath $script:ConfigFile $script:NotifyDefaultPath');
has('文档写了 notify 只读段', DOC, '## `notify` 段（单向：只读）');
has('文档写了默认路径', DOC, 'D:/OpenSource/lab/sup/group/out/agent-hub/notifications.jsonl');

console.log(`\n分母：断言 ${n + 18} 条，失败 ${bad} 条`);
const total = n + 18;
if (WANT && total !== WANT) { console.log(`！断言数 ${total}，要求 ${WANT} —— 有人加了/删了断言`); bad++; }
process.exit(bad ? 1 : 0);
