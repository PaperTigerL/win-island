#!/usr/bin/env node
// 频谱合并的「契约级」判据（不碰桌面、不需要音频端点）：跑在 --unit 里。
// 真频谱本身要真实声卡和屏幕（test/audio-test.mjs，非 --unit）；这里守的是更便宜、更容易漏的那半边：
// 引擎函数齐不齐、岛有没有 dot-source 并接上 gameMode 暂停钩子、audio.json 的键还在不在、
// 管道 audio 命令有没有实现、配置项和文档有没有掉队。任何一处被改回旧状态，这里先红。
//
//   node test/audio-contract-test.mjs
//   node test/audio-contract-test.mjs --expect 15
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const WANT = ARGS.includes('--expect') ? (+ARGS[ARGS.indexOf('--expect') + 1] || 0) : 0;
const read = p => readFileSync(join(ROOT, p), 'utf8');
const BT = String.fromCharCode(96);

const AUDIO = existsSync(join(ROOT, 'src', 'island', 'audio.ps1')) ? read('src/island/audio.ps1') : '';
const ISLAND = read('src/island/island.ps1');
const API = read('src/capture/api.mjs');
const SPEC = read('src/island/prefs.ps1');
const DOC = read('docs/CONFIG.md');

let bad = 0;
function ok(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { bad++; console.log('  FAIL ' + name + (detail ? '\n        ' + detail : '')); }
}

// 1) 引擎文件与公开函数
const fns = ['Ensure-IslandAudioType', 'Start-IslandAudio', 'Stop-IslandAudio', 'Get-IslandAudioLevels',
  'Get-IslandAudioBars', 'Get-IslandAudioSnapshot', 'Get-IslandAudioStatus', 'Get-IslandAudioSources',
  'Set-IslandAudioCap', 'Get-IslandAudioCap', 'Get-IslandAudioBandEdges'];
const missing = fns.filter(f => !new RegExp('^function ' + f + '\\b', 'm').test(AUDIO));
ok('audio.ps1 的 11 个公开函数都在', missing.length === 0, '缺：' + missing.join(', '));

// 2) 惰性编译：audioOn=false 时不该多花一秒在 Add-Type 上
const ensureAt = AUDIO.indexOf('function Ensure-IslandAudioType');
const firstFnAfterEnsure = AUDIO.indexOf('\nfunction ', ensureAt + 10);
const ensureBody = AUDIO.slice(ensureAt, firstFnAfterEnsure < 0 ? AUDIO.length : firstFnAfterEnsure);
const addTypeCount = (AUDIO.match(/Add-Type -TypeDefinition/g) || []).length;
ok('引擎是惰性编译（Add-Type 只在 Ensure 里）',
  addTypeCount === 1 && /Add-Type -TypeDefinition/.test(ensureBody));

// 3) 岛 dot-source 了引擎
ok('island.ps1 dot-source audio.ps1', /\. \(Join-Path \$PSScriptRoot 'audio\.ps1'\)/.test(ISLAND));

// 4) gameMode 暂停钩子两侧都在（审计留的是 Set-AudioVizPaused，运行副本要补 Set-AudioLevelPaused）
ok('gameMode 钩子 Set-AudioVizPaused 仍在且会找适配层',
  /function Set-AudioVizPaused/.test(ISLAND) && /Get-Command Set-AudioLevelPaused/.test(ISLAND));
ok('适配层 Set-AudioLevelPaused 已定义', /^function Set-AudioLevelPaused/m.test(ISLAND));

// 5) tick 在暂停期间不画柱子（否则暂停只是空钩子）
ok('tick 里用 AudioVizPaused 门控 Sync-Audio',
  /if \(\$script:P\.audioOn -and -not \$script:AudioVizPaused\)/.test(ISLAND) &&
  /Sync-AudioJson/.test(ISLAND));

// 6) audio.json 是进程间契约，键一个不少
const snap = AUDIO.slice(AUDIO.indexOf('function Get-IslandAudioSnapshot'));
const keys = ['bands', 'bars', 'level', 'peakHz', 'windows', 'idleMs', 'sources', 'status', 'at'];
const missKeys = keys.filter(k => !new RegExp('\\b' + k + '\\s+=').test(snap));
ok('audio.json 快照键齐全', missKeys.length === 0, '缺：' + missKeys.join(', '));

// 7) 暂停时写的是 paused 而不是 closed（API 调用方要分得清）
ok('暂停态 status 写 paused (gameMode)', /'paused \(gameMode\)'/.test(ISLAND));

// 8) 管道 audio 命令
ok('api.mjs 实现 case audio', /case 'audio':/.test(API));
ok('api.mjs 命令表/错误提示带 audio', /config\.set \/ request \/ audio/.test(API));

// 9) 8 个配置项：spec / 文档 / 岛都真的有
const AUDIO_KEYS = ['audioOn', 'audioBands', 'audioAllDevices', 'audioGain', 'audioStallMs',
  'audioFloorDb', 'audioShowBar', 'audioHideMs'];
const noSpec = AUDIO_KEYS.filter(k => !new RegExp('^  ' + k + '\\s+=', 'm').test(SPEC));
const noDoc = AUDIO_KEYS.filter(k => !DOC.includes('| ' + BT + k + BT + ' |'));
const noUse = AUDIO_KEYS.filter(k => !new RegExp('\\$p\\.' + k + '\\b|\\$script:P\\.' + k + '\\b').test(ISLAND));
ok('8 个 audio 配置项在 $PrefsSpec', noSpec.length === 0, '缺：' + noSpec.join(', '));
ok('8 个 audio 配置项在 docs/CONFIG.md', noDoc.length === 0, '缺：' + noDoc.join(', '));
ok('8 个 audio 配置项都被 island.ps1 读', noUse.length === 0, '缺：' + noUse.join(', '));

// 10) 真频谱判据在非 --unit 那半边，文件不能丢
ok('test/audio-test.mjs + 两个 harness + pixel-audio 都在',
  existsSync(join(ROOT, 'test', 'audio-test.mjs')) &&
  existsSync(join(ROOT, 'test', 'audio-harness.ps1')) &&
  existsSync(join(ROOT, 'test', 'render-endpoint.ps1')) &&
  existsSync(join(ROOT, 'tools', 'pixel-audio.ps1')));

// 11) 托盘图标用 ico 同档帧（P2-9）
ok('托盘图标读 assets/icon.ico 同档帧',
  /SmallIconSize/.test(ISLAND) && /System\.Drawing\.Icon\(\$script:IconFile/.test(ISLAND));

const n = 15;
console.log('');
console.log('分母：断言 ' + n + ' 条，失败 ' + bad + ' 条');
if (WANT && n !== WANT) { console.log('！断言数 ' + n + '，要求 ' + WANT + ' —— 有人加了/删了断言'); bad++; }
process.exit(bad ? 1 : 0);
