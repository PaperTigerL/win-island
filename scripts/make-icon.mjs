// 生成 assets/icon.ico（16/32/48/256 四档，32bpp BGRA + AND 掩码，纯手写字节，不引第三方库）。
// 画的是这个软件本身：深色圆角方块 + 顶部正中一枚亮色胶囊。
// 为什么要自己画：这台机器没有图标编辑器，而带图标的 exe 才像个正经程序（资源段见 src/launcher/win-island.rc）。
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
mkdirSync(OUT, { recursive: true });

const SIZES = [16, 32, 48, 256];

// 圆角矩形软边：返回 0..1 的覆盖度
function roundRect(px, py, x0, y0, w, h, r) {
  const cx = Math.min(Math.max(px, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(py, y0 + r), y0 + h - r);
  const d = Math.hypot(px - cx, py - cy);
  return Math.max(0, Math.min(1, r + 0.5 - d));
}
function mix(a, b, t) { return a + (b - a) * t; }

function render(n) {
  // 每像素 4 字节 BGRA，自下而上存
  const body = Buffer.alloc(n * n * 4);
  const mask = Buffer.alloc(Math.ceil(n / 32) * 4 * n); // AND 掩码：1bpp，全 0 = 不遮
  const S = n / 16;                       // 逻辑坐标按 16 格设计，缩放不糊
  const rad = 4.2 * S;                    // 外框圆角
  const pillW = 8.4 * S, pillH = 2.9 * S, pillR = pillH / 2;
  const pillX = (n - pillW) / 2, pillY = 2.4 * S;
  const dotR = 0.85 * S;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5, py = y + 0.5;
      const cover = roundRect(px, py, 0.6 * S, 0.6 * S, n - 1.2 * S, n - 1.2 * S, rad);
      if (cover <= 0) continue;
      // 背景：上浅下深的玻璃渐变
      const t = py / n;
      let r = mix(0x2a, 0x11, t), g = mix(0x2e, 0x0d, t), b = mix(0x3a, 0x14, t);
      // 描边
      const edge = roundRect(px, py, 1.1 * S, 1.1 * S, n - 2.2 * S, n - 2.2 * S, rad - 0.5 * S);
      if (edge < 0.35) { r = 0x5a; g = 0x63; b = 0x76; }
      // 胶囊
      const pc = roundRect(px, py, pillX, pillY, pillW, pillH, pillR);
      if (pc > 0) {
        const k = Math.max(0, Math.min(1, (py - pillY) / pillH));
        r = Math.round(mix(0x8f, 0x5c, k)); g = Math.round(mix(0xc4, 0x86, k)); b = Math.round(mix(0xff, 0xd6, k));
      }
      // 胶囊右边一个小圆点（未读数的位置感）
      const dx = px - (pillX + pillW - 1.5 * S), dy = py - (pillY + pillH / 2);
      if (Math.hypot(dx, dy) < dotR) { r = 0x14; g = 0x17; b = 0x1e; }
      const o = ((n - 1 - y) * n + x) * 4;
      body[o] = b; body[o + 1] = g; body[o + 2] = r; body[o + 3] = Math.round(255 * cover);
    }
  }
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(n, 4);
  hdr.writeInt32LE(n * 2, 8);   // ICO 的惯例：高度写两倍（图像 + 掩码）
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  return Buffer.concat([hdr, body, mask]);
}

const images = SIZES.map(render);
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(SIZES.length, 4);
let off = 6 + 16 * SIZES.length;
const entries = SIZES.map((n, i) => {
  const e = Buffer.alloc(16);
  e[0] = n >= 256 ? 0 : n; e[1] = n >= 256 ? 0 : n;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(off, 12);
  off += images[i].length;
  return e;
});
const ico = Buffer.concat([dir, ...entries, ...images]);
writeFileSync(join(OUT, 'icon.ico'), ico);
console.log(`assets/icon.ico：${SIZES.join('/')} px，${ico.length} 字节`);
