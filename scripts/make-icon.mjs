// 生成 assets/icon.ico（16/20/24/32/48/256 六档，32bpp BGRA + AND 掩码，纯手写字节，不引第三方库）。
// 画的是这个软件本身：蓝色圆角方块 + 一枚白色胶囊 + 右上角未读点。
// 为什么要自己画：这台机器没有图标编辑器，而带图标的 exe 才像个正经程序（资源段见 src/launcher/win-island.rc）。
// 为什么机身是蓝的不是黑的：托盘那格在浅色弹层和深色任务栏上都会出现，
// 近黑的机身在深色任务栏上直接消失（2026-09-27 用户说「没有图标太丑」时就是这颗黑块）。
// 24 这一档不能省：150% DPI 下 SystemInformation.SmallIconSize 报的就是 24。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
mkdirSync(OUT, { recursive: true });

const SIZES = [16, 20, 24, 32, 48, 256];

// 圆角矩形软边：返回 0..1 的覆盖度
function roundRect(px, py, x0, y0, w, h, r) {
  const cx = Math.min(Math.max(px, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(py, y0 + r), y0 + h - r);
  const d = Math.hypot(px - cx, py - cy);
  return Math.max(0, Math.min(1, r + 0.5 - d));
}
function mix(a, b, t) { return a + (b - a) * t; }
function circle(px, py, cx, cy, r) { return Math.max(0, Math.min(1, r + 0.5 - Math.hypot(px - cx, py - cy))); }

// 逻辑坐标一律按 16 格设计，再按 S 放大 —— 换尺寸时形状不变。
// 三形的比例是量出来的：未读点在 16 格里超过 6 格宽就吃掉胶囊，胶囊低于 3 格高就在 16px 上断成两条。
const TILE = { x: 0.6, y: 0.6, s: 14.8, r: 3.4 };
const CAP = { w: 8.8, h: 3.2, y: 7.0, r: 1.6 };          // 胶囊：水平居中，中心在 8.6
const BADGE = { cx: 11.6, cy: 4.2, ring: 2.5, dot: 1.7 }; // 未读点：右上角，留一圈白环和机身分开

function render(n) {
  // 每像素 4 字节 BGRA，自下而上存
  const body = Buffer.alloc(n * n * 4);
  const mask = Buffer.alloc(Math.ceil(n / 32) * 4 * n); // AND 掩码：1bpp，全 0 = 不遮
  const S = n / 16;
  const capX = (16 - CAP.w) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = (x + 0.5) / S, py = (y + 0.5) / S;     // 取像素中心，换算回 16 格
      const cover = roundRect(px, py, TILE.x, TILE.y, TILE.s, TILE.s, TILE.r);
      if (cover <= 0) continue;
      // 机身：上浅下深的蓝
      const t = (py - TILE.y) / TILE.s;
      let r = Math.round(mix(0x4d, 0x1e, t)), g = Math.round(mix(0x9b, 0x63, t)), b = Math.round(mix(0xff, 0xd6, t));
      // 描边：收深一档，浅色弹层上才有边界
      const edge = roundRect(px, py, TILE.x + 0.45, TILE.y + 0.45, TILE.s - 0.9, TILE.s - 0.9, TILE.r - 0.45);
      if (edge < 0.4) { r = 0x18; g = 0x4f; b = 0xa8; }
      // 胶囊
      const pc = roundRect(px, py, capX, CAP.y, CAP.w, CAP.h, CAP.r);
      if (pc > 0) {
        const k = Math.max(0, Math.min(1, (py - CAP.y) / CAP.h));
        r = Math.round(mix(0xff, 0xd3, k)); g = Math.round(mix(0xff, 0xe6, k)); b = 255;
      }
      // 未读点（白环 + 红心）
      const ring = circle(px, py, BADGE.cx, BADGE.cy, BADGE.ring);
      if (ring > 0) { r = 0xff; g = 0xff; b = 0xff; }
      const dot = circle(px, py, BADGE.cx, BADGE.cy, BADGE.dot);
      if (dot > 0) { r = 0xf2; g = 0x41; b = 0x4d; }
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
