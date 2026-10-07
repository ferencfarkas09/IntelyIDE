#!/usr/bin/env node
// Unit-style check of the DMG background: renders it (1x and 2x) and asserts that the label band under both icons
// has relative luminance 0.170-0.190 everywhere (so Finder's black or white labels keep >= 4.4:1 contrast), that the
// art is 660x400 / 1320x800 and that the rest of the canvas stays dark. Usage: node check-background.mjs
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { renderBackground, W, H, ICONS, CHIP } from "./make-background.mjs";

function decode(png) {
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  let off = 8, width = 0, height = 0, ct = 0; const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.toString("ascii", off + 4, off + 8), d = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { width = d.readUInt32BE(0); height = d.readUInt32BE(4); assert.equal(d[8], 8); ct = d[9]; assert.equal(d[12], 0); }
    if (type === "IDAT") idat.push(d);
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3; assert.ok(ct === 6 || ct === 2);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * bpp, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, bpp, px };
}
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

const out = await renderBackground();
let min = 1, max = 0;
for (const s of [1, 2]) {
  const { width, height, bpp, px } = decode(out[s]);
  assert.deepEqual([width, height], [W * s, H * s]);
  const at = (x, y) => { const i = (y * width + x) * bpp; return lum(px[i], px[i + 1], px[i + 2]); };
  // inner area of each chip (inset from the antialiased edge and the 1px highlight border)
  for (const [cx] of Object.values(ICONS)) {
    for (let y = CHIP.top + 6; y <= CHIP.top + CHIP.h - 6; y++) for (let x = cx - CHIP.w / 2 + 22; x <= cx + CHIP.w / 2 - 22; x++) {
      const L = at(Math.round(x * s), Math.round(y * s)); min = Math.min(min, L); max = Math.max(max, L);
      assert.ok(L >= 0.17 && L <= 0.19, `label band luminance ${L.toFixed(4)} at ${x},${y} @${s}x outside 0.170-0.190`);
    }
  }
  // the title area and footer stay dark (premium look, text contrast)
  for (const [x, y] of [[20, 20], [640, 20], [20, 200], [640, 200], [330, 330], [20, 390], [640, 390]]) assert.ok(at(x * s, y * s) < 0.04, `canvas too bright at ${x},${y}`);
}
const cr = (L, ref) => ((Math.max(L, ref) + 0.05) / (Math.min(L, ref) + 0.05)).toFixed(2);
console.log(`label band luminance ${min.toFixed(4)}..${max.toFixed(4)} (1x+2x); contrast vs white ${cr(min, 1)}..${cr(max, 1)}, vs black ${cr(min, 0)}..${cr(max, 0)}`);
console.log("check-background: ok");
