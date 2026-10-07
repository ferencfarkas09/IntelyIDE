import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSvg, loadConfig, renderShot } from "../frame.mjs";
import { encodePng, listChunks, pixelAt, readHeader, readPng, sha256 } from "../lib/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAME_CLI = join(HERE, "..", "frame.mjs");

function raw2880() {
  const w = 2880, h = 1800;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    px[o] = 30 + ((x >> 6) & 63); px[o + 1] = 40 + ((y >> 6) & 63); px[o + 2] = 90; px[o + 3] = 255;
  }
  return encodePng(w, h, px);
}
const src = raw2880();

test("framed output is 3008 x 1928, corners transparent, window opaque", () => {
  const out = renderShot(src);
  assert.deepEqual([readHeader(out).width, readHeader(out).height], [3008, 1928]);
  const img = readPng(out);
  assert.equal(pixelAt(img, 0, 0)[3], 0, "canvas corner");
  assert.equal(pixelAt(img, 3007, 1927)[3], 0, "canvas opposite corner");
  assert.ok(pixelAt(img, 64 + 1, 64 + 1)[3] < 128, "rounded window corner shows through");
  assert.equal(pixelAt(img, 1504, 964)[3], 255, "window centre");
  assert.ok(pixelAt(img, 1504, 1928 - 40)[3] > 0, "soft shadow below the window");
});

test("traffic lights are drawn at the configured positions", () => {
  const cfg = loadConfig();
  const img = readPng(renderShot(src));
  const [r, g, b] = pixelAt(img, cfg.margin + cfg.lights.x, cfg.margin + cfg.lights.y);
  assert.deepEqual([r, g, b], [0xff, 0x5f, 0x57]);
  const [r2, g2] = pixelAt(img, cfg.margin + cfg.lights.x + 2 * cfg.lights.gap, cfg.margin + cfg.lights.y);
  assert.deepEqual([r2, g2], [0x28, 0xc8]);
});

test("output bytes are deterministic and carry no metadata chunks", () => {
  const a = renderShot(src);
  const b = renderShot(src);
  assert.equal(sha256(a), sha256(b));
  const names = listChunks(a);
  for (const bad of ["tEXt", "iTXt", "zTXt", "eXIf"]) assert.ok(!names.includes(bad), bad);
});

test("--no-frame keeps 2880 x 1800 and the pixels", () => {
  const out = renderShot(src, { frame: false });
  assert.deepEqual([readHeader(out).width, readHeader(out).height], [2880, 1800]);
  assert.deepEqual(pixelAt(readPng(out), 0, 0), pixelAt(readPng(src), 0, 0));
});

test("downscale gives exactly the requested width", () => {
  const framed = readHeader(renderShot(src, { width: 1600 }));
  assert.equal(framed.width, 1600);
  assert.equal(framed.height, Math.round((1928 * 1600) / 3008));
  assert.equal(readHeader(renderShot(src, { frame: false, width: 1600 })).width, 1600);
});

test("svg template has no unfilled placeholders", () => {
  assert.ok(!/\{\{|\}\}/.test(buildSvg(src)));
  assert.ok(!/\{\{|\}\}/.test(buildSvg(src, { frame: false })));
});

test("CLI frames a file and honours --no-frame", () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-test-"));
  try {
    writeFileSync(join(dir, "in.png"), src);
    execFileSync("node", [FRAME_CLI, join(dir, "in.png"), join(dir, "a.png")]);
    execFileSync("node", [FRAME_CLI, join(dir, "in.png"), join(dir, "b.png"), "--no-frame"]);
    assert.equal(readHeader(readFileSync(join(dir, "a.png"))).width, 3008);
    assert.equal(readHeader(readFileSync(join(dir, "b.png"))).width, 2880);
    assert.throws(() => execFileSync("node", [FRAME_CLI, join(dir, "in.png")], { stdio: "pipe" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
