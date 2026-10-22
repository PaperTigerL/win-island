// 一条命令出可运行的东西：图标 → 资源段 → csc 编出 bin/win-island.exe → （--release 再打发布包 + zip）
//
// 为什么用系统自带的 csc.exe 而不是 dotnet：这台机器的 dotnet 是个坏 shim（未打包进程
// 拿不到包身份，WinRT 那条路实测走不通），也没有 rust/cargo。csc 4.8 是 .NET Framework 4.8
// 自带的，Windows 10/11 上默认就有，编出来的 exe 不需要额外运行时。
// 语法上限是 C# 5，所以 src/launcher/WinIsland.cs 里没有字符串内插和 ?. 。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const B = join(ROOT, 'build');
const BIN = join(ROOT, 'bin');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
// windres 只是把版本信息和图标塞进 exe，找不到就退回到 PATH 上找一个（没有也能编，只是 exe 没图标）
const WINDRES = process.env.WINDRES ||
  ['D:\\mingw64\\bin\\windres.exe', 'C:\\mingw64\\bin\\windres.exe', 'C:\\msys64\\mingw64\\bin\\windres.exe']
    .find(existsSync) || 'windres';
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VER = pkg.version;
const RELEASE = process.argv.includes('--release');

function sh(file, args) {
  console.log(`$ ${file} ${args.join(' ')}`);
  try {
    const out = execFileSync(file, args, { encoding: 'utf8', maxBuffer: 9e6, stdio: ['ignore', 'pipe', 'pipe'] });
    if (out && out.trim()) console.log(out.trim());
    return 0;
  } catch (e) {
    const so = (e.stdout || '') + (e.stderr || '');
    if (so.trim()) console.log(so.trim());
    console.error(`命令失败：${file}（退出码 ${e.status}）`);
    process.exit(1);
  }
}
function kb(p) { return (statSync(p).size / 1024).toFixed(1) + ' KB'; }

mkdirSync(B, { recursive: true });
mkdirSync(BIN, { recursive: true });

if (!existsSync(CSC)) { console.error(`没有 ${CSC}：这台机器上没有 .NET Framework 4.8 的编译器`); process.exit(1); }

// 1) 图标
const ICO = join(ROOT, 'assets', 'icon.ico');
if (!existsSync(ICO)) sh(process.execPath, [join(ROOT, 'scripts', 'make-icon.mjs')]);
console.log(`图标 assets/icon.ico ${kb(ICO)}`);

// 2) 版本信息资源：模板换版本 → windres → .res
let HAVE_RES = null;
try {
  const [a, b, c] = VER.split('.').map(x => parseInt(x, 10) || 0);
  let rc = readFileSync(join(ROOT, 'src', 'launcher', 'win-island.rc'), 'utf8')
    .replace(/@VERNUM@/g, `${a}, ${b}, ${c}, 0`)
    .replace(/@VERSION@/g, VER);
  writeFileSync(join(B, 'win-island.rc'), rc);
  copyFileSync(ICO, join(B, 'icon.ico'));   // .rc 里 ICON "icon.ico" 按 .rc 同目录找
  // 这里不用 sh()：sh() 失败就直接退出，而 windres 缺失是可跳过的降级
  execFileSync(WINDRES, ['-J', 'rc', '-c', '65001', '-i', join(B, 'win-island.rc'), '-O', 'res', '-o', join(B, 'version-info.res')]);
  HAVE_RES = join(B, 'version-info.res');
  console.log(`资源段 build/version-info.res ${kb(HAVE_RES)}`);
} catch (e) {
  console.log(`没有 windres（${WINDRES}）：跳过版本资源，exe 照常能跑，只是没有图标和版本号`);
}

// 3) 编译
// /target:winexe 而不是 exe：这个启动器要在「登录时」被计划任务拉起来（见 scripts/autostart.ps1），
// 是控制台程序就会在登录瞬间闪一个黑框；winexe 不申请控制台，但从终端里跑仍然能往终端输出
// （stdout 句柄是继承来的），所以 win-island status 该看得见还是看得见 —— 改完实测过。
const EXE = join(BIN, 'win-island.exe');
sh(CSC, [
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
  `/out:${EXE}`,
  ...(HAVE_RES ? [`/win32res:${HAVE_RES}`] : []),
  '/r:System.Core.dll',
  join(ROOT, 'src', 'launcher', 'WinIsland.cs'),
]);
console.log(`编译完成 bin/win-island.exe ${kb(EXE)}`);

// 4) 冒烟：跑一下 status（会读数据目录 + 试连管道），再确认版本资源真的进来了。
//    这条同时是 /target:winexe 的自证：换成 GUI 子系统程序后，如果 stdout 接不上继承的管道，
//    这里拿到的就是空串 —— 「登录时不闪黑框」和「终端里看得见输出」不能只留一个。
//    status 退出码 0 = 两层都在跑，3 = 没在跑（构建时岛通常就是停着的），两个都算 exe 正常说话。
//    用 execFileSync 的话退出码 3 会抛异常，等于「岛没开着就构建不了」—— 这里必须用 spawnSync。
const sm = spawnSync(EXE, ['status'], { encoding: 'utf8' });
if (sm.error) throw sm.error;
if (sm.status !== 0 && sm.status !== 3) {
  console.error(`status 退出码不该是 ${sm.status}：\n${sm.stdout}\n${sm.stderr}`);
  process.exit(1);
}
if (!sm.stdout.includes('win-island') || !sm.stdout.includes('island.ps1')) {
  console.error('status 的 stdout 是空的 / 不完整：构建冒烟不通过');
  process.exit(1);
}
console.log('--- win-island status (exit=' + sm.status + ') ---\n' + sm.stdout.trim());
if (HAVE_RES) {
  const info = readFileSync(EXE);
  if (!info.includes(Buffer.from('win-island', 'utf16le'))) {
    console.error('exe 里找不到产品名，资源段可能没进去');
    process.exit(1);
  }
}

if (RELEASE) {
  console.log('\n=== 发布包 ===');
  // 打包器按 .gitignore 是维护者私有文件（白名单 + 真实名单脱敏），公开仓库里没有。
  // 这里显式报清楚，别让人在编译完之后才看到一个 ENOENT。
  const pack = join(ROOT, 'scripts', 'pack-release.mjs');
  if (!existsSync(pack)) {
    console.error('这个仓库没有 scripts/pack-release.mjs（.gitignore 排除的维护者私有打包器），--release 出不了包。');
    console.error('公开仓库只能跑 node scripts/build.mjs；要出包请在维护者工作副本里跑 --release。');
    process.exit(2);
  }
  const extra = process.argv.includes('--with-node') ? ['--with-node'] : [];
  sh(process.execPath, [pack, ...extra]);
} else {
  console.log('\n（要连发布包一起出：npm run build -- --release；带上可移植的 node：--release --with-node）');
}
