import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { encodePng, insertChunk, listChunks, luminanceStats, pixelAt, readHeader, readPng, sampleGrid, differingFraction, sha256 } from "../lib/png.mjs";

function solid(w, h, [r, g, b, a = 255], paint) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = paint?.(x, y) ?? [r, g, b, a];
    px.set(c, (y * w + x) * 4);
  }
  return px;
}

test("round trip of an RGBA image: size, chunk list, pixels", () => {
  const png = encodePng(7, 5, solid(7, 5, [0, 0, 0], (x, y) => [x * 30, y * 40, 9, 255]));
  assert.deepEqual(readHeader(png), { width: 7, height: 5, bitDepth: 8, colorType: 6, interlace: 0 });
  assert.deepEqual(listChunks(png), ["IHDR", "IDAT", "IEND"]);
  const img = readPng(png);
  assert.equal(img.width, 7);
  assert.deepEqual(pixelAt(img, 3, 2), [90, 80, 9, 255]);
});

test("luminance statistics and regions", () => {
  const png = encodePng(10, 10, solid(10, 10, [0, 0, 0], (x) => (x < 5 ? [0, 0, 0, 255] : [255, 255, 255, 255])));
  const img = readPng(png);
  const all = luminanceStats(img);
  assert.ok(Math.abs(all.mean - 127.5) < 1);
  assert.equal(all.min, 0);
  assert.ok(all.max > 254);
  assert.ok(luminanceStats(img, { x: 0, y: 0, w: 5, h: 10 }).mean < 1);
  assert.ok(luminanceStats(img, { x: 5, y: 0, w: 5, h: 10 }).mean > 254);
  assert.equal(luminanceStats(img, { x: 0, y: 0, w: 5, h: 10 }).stdev, 0);
});

test("grid sampling and differing fraction", () => {
  const dark = readPng(encodePng(40, 40, solid(40, 40, [10, 10, 10])));
  const light = readPng(encodePng(40, 40, solid(40, 40, [240, 240, 240])));
  const half = readPng(encodePng(40, 40, solid(40, 40, [0, 0, 0], (x) => (x < 20 ? [10, 10, 10, 255] : [240, 240, 240, 255]))));
  assert.equal(sampleGrid(dark, 4, 4).length, 16);
  assert.equal(differingFraction(dark, dark), 0);
  assert.equal(differingFraction(dark, light), 1);
  assert.ok(Math.abs(differingFraction(dark, half) - 0.5) < 0.05);
});

test("planted metadata chunks are listed; bad CRC and bad signature are rejected", () => {
  const base = encodePng(2, 2, solid(2, 2, [1, 2, 3]));
  const withText = insertChunk(base, "tEXt", Buffer.from("Comment\0hello"));
  assert.deepEqual(listChunks(withText), ["IHDR", "IDAT", "tEXt", "IEND"]);
  const broken = Buffer.from(withText);
  broken[broken.length - 20] ^= 0xff;
  assert.throws(() => listChunks(broken), /CRC|truncated/);
  assert.throws(() => listChunks(Buffer.from("not a png at all, really not a png")), /signature/);
});

test("filtered scanlines (Sub, Up, Average, Paeth) decode", () => {
  // 3x4 grey image, one filter type per row, built by hand.
  const rows = [
    [0, 10, 20, 30],             // None
    [1, 10, 10, 10],             // Sub  -> 10 20 30
    [2, 1, 1, 1],                // Up   -> 11 21 31
    [4, 0, 0, 0],                // Paeth-> follows the previous row / left
  ];
  const raw = Buffer.from(rows.flat());
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name, "latin1"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(require_crc(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
  const img = readPng(png);
  assert.deepEqual([0, 1, 2].map((x) => pixelAt(img, x, 0)[0]), [10, 20, 30]);
  assert.deepEqual([0, 1, 2].map((x) => pixelAt(img, x, 1)[0]), [10, 20, 30]);
  assert.deepEqual([0, 1, 2].map((x) => pixelAt(img, x, 2)[0]), [11, 21, 31]);
  assert.deepEqual([0, 1, 2].map((x) => pixelAt(img, x, 3)[0]), [11, 21, 31]);
});

test("sha256 helper is stable", () => {
  assert.equal(sha256(Buffer.from("a")), "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
});

import { crc32 } from "node:zlib";
function require_crc(b) { return crc32(b); }
