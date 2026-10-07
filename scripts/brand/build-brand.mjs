#!/usr/bin/env node
// Builds every brand asset from the B2 geometry in ./geometry.mjs:
//   assets/brand/*.svg + png/*.png        canonical sources and rasters (wordmark outlined from Sora, no runtime font)
//   src-tauri/icons/*                      icon.icns / icon.ico / png set via `tauri icon`
//   ui/public/brand/*                      favicon + logo copies served by Vite
//   ui/src/ui-kit/brandGeometry.ts         layout data that BrandMark.tsx renders
// Deterministic: same inputs, same bytes. Run from anywhere: node scripts/brand/build-brand.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import { Resvg } from "@resvg/resvg-js";
import * as G from "./geometry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const at = (...p) => join(ROOT, ...p);
const BRAND = at("assets", "brand");
const PNG = join(BRAND, "png");
const PUBLIC = at("ui", "public", "brand");
const ICONS = at("src-tauri", "icons");
for (const d of [PNG, PUBLIC, ICONS]) mkdirSync(d, { recursive: true });

const num = (n) => String(Math.round(n * 100) / 100);
const write = (file, text) => writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);

function loadFont(weight) {
  const buf = readFileSync(at("node_modules", "@fontsource", "sora", "files", `sora-latin-${weight}-normal.woff`));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
const bold = loadFont(700);
const medium = loadFont(500);

/** Outlines `text` at `size`, baseline y = 0, x starting at 0. `split` closes the first path after that many glyphs. */
function outline(font, text, size, spacingEm, split = text.length) {
  const k = size / font.unitsPerEm;
  const parts = [new opentype.Path(), new opentype.Path()];
  let x = 0;
  let prev;
  [...text].forEach((ch, i) => {
    const glyph = font.charToGlyph(ch);
    if (prev) x += font.getKerningValue(prev, glyph) * k;
    parts[i < split ? 0 : 1].extend(glyph.getPath(x, 0, size));
    x += glyph.advanceWidth * k + spacingEm * size;
    prev = glyph;
  });
  return parts.map((p) => {
    const b = p.getBoundingBox();
    return { d: p.toPathData(1), x1: b.x1, x2: b.x2, y1: b.y1, y2: b.y2 };
  });
}

const capHeight = (font, size) => -font.charToGlyph("H").getPath(0, 0, size).getBoundingBox().y1;
/** Distance from a line box top (line-height 1) to its baseline, as the browser lays the source lockups out. */
const baselineInBox = (size) => (size - (G.TEXT.ascent + G.TEXT.descent) * size) / 2 + G.TEXT.ascent * size;

/** Wordmark + subtitle block. Returns paths positioned with the title baseline at y = 0. */
function textBlock({ title, sub, gap }) {
  const [intely, ide] = outline(bold, "INTELYIDE", title, G.TEXT.titleLetterSpacing, 6);
  const [subPath] = outline(medium, "INTELYSWITCH IDE", sub, G.TEXT.subLetterSpacing);
  const subBase = title + gap + baselineInBox(sub) - baselineInBox(title);
  return { intely, ide, sub: subPath, subBase, cap: capHeight(bold, title) };
}

const shift = (p, dx, dy) => ({ d: translateD(p.d, dx, dy), x1: p.x1 + dx, x2: p.x2 + dx, y1: p.y1 + dy, y2: p.y2 + dy });
function translateD(d, dx, dy) {
  // opentype emits absolute M/L/Q/C/Z with x y pairs; a minus sign doubles as the separator, so re-add one for positives.
  let i = 0;
  return d
    .replace(/-?\d*\.?\d+/g, (m) => {
      const v = parseFloat(m) + (i++ % 2 === 0 ? dx : dy);
      return (v < 0 ? "" : " ") + num(v);
    })
    .replace(/([A-Za-z]) /g, "$1");
}

/** Lays out the lockup in final coordinates; returns everything needed to emit the SVG or the TS data. */
function layoutLockup(kind) {
  const s = G.TEXT[kind];
  const k = s.markScale;
  const tb = textBlock(s);
  const bounds = G.MARK_BOUNDS;
  if (kind === "horizontal") {
    const mark = { tx: -bounds.x1 * k, ty: -150 * k, scale: k };
    const baseline = -(tb.subBase - tb.cap) / 2;
    const left = (bounds.x2 - bounds.x1) * k + s.markGap;
    const dx = left - tb.intely.x1;
    return finish(mark, shift(tb.intely, dx, baseline), shift(tb.ide, dx, baseline), shift(tb.sub, left - tb.sub.x1, baseline + tb.subBase), k);
  }
  const mark = { tx: -156 * k, ty: -bounds.y1 * k, scale: k };
  const baseline = (bounds.y2 - bounds.y1) * k + s.markGap + tb.cap;
  const dx = -(tb.intely.x1 + tb.ide.x2) / 2;
  return finish(mark, shift(tb.intely, dx, baseline), shift(tb.ide, dx, baseline), shift(tb.sub, -(tb.sub.x1 + tb.sub.x2) / 2, baseline + tb.subBase), k);
}

function finish(mark, intely, ide, sub, k) {
  const bounds = G.MARK_BOUNDS;
  const markBox = { x1: mark.tx + bounds.x1 * k, x2: mark.tx + bounds.x2 * k, y1: mark.ty + bounds.y1 * k, y2: mark.ty + bounds.y2 * k };
  const all = [markBox, intely, ide, sub];
  const pad = G.TEXT.padding;
  const x1 = Math.floor(Math.min(...all.map((b) => b.x1)) - pad);
  const y1 = Math.floor(Math.min(...all.map((b) => b.y1)) - pad);
  const x2 = Math.ceil(Math.max(...all.map((b) => b.x2)) + pad);
  const y2 = Math.ceil(Math.max(...all.map((b) => b.y2)) + pad);
  return { viewBox: [x1, y1, x2 - x1, y2 - y1], mark, intely: intely.d, ide: ide.d, ideX: [ide.x1, ide.x2], sub: sub.d };
}

// ---- SVG assembly ---------------------------------------------------------

const grad = (id, b) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${b.x1}" y1="${b.y}" x2="${b.x2}" y2="${b.y}"><stop offset="0" stop-color="${b.from}"/><stop offset="1" stop-color="${b.to}"/></linearGradient>`;

/** The mark in its own 300 x 300 units. `ink` colours the cursor and spark. */
function markShapes({ idp, small = false, ink, shadow = 0 }) {
  const bars = small ? G.SMALL_BARS : G.BARS;
  const bw = small ? G.SMALL_BAR_WIDTH : G.BAR_WIDTH;
  const cursor = small ? G.SMALL_CURSOR : G.CURSOR;
  const defs = bars.map((b, i) => grad(`${idp}-${i + 1}`, b)).join("");
  const filter = shadow
    ? `<filter id="${idp}-sh" x="-20%" y="-30%" width="140%" height="160%"><feDropShadow dx="0" dy="${G.SHADOW.dy}" stdDeviation="${G.SHADOW.blur}" flood-color="${G.SHADOW.color}" flood-opacity="${shadow}"/></filter>`
    : "";
  const lines = bars.map((b, i) => `<path d="${b.d}" fill="none" stroke="url(#${idp}-${i + 1})" stroke-width="${bw}" stroke-linecap="round"/>`).join("");
  const cur = `<path d="${cursor.d}" fill="none" stroke="${ink}" stroke-width="${cursor.width}" stroke-linecap="round"/>`;
  const spark = small ? "" : `<path d="${G.SPARK.d}" transform="${G.SPARK.transform}" fill="${ink}"/>`;
  const body = shadow ? `<g filter="url(#${idp}-sh)">${lines}${cur}</g>${spark}` : `${lines}${cur}${spark}`;
  return { defs: defs + filter, body };
}

const svgDoc = (viewBox, label, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(" ")}" width="${viewBox[2]}" height="${viewBox[3]}" role="img" aria-label="${label}">${inner}</svg>`;

function markSvg(theme, small) {
  const p = G.PALETTE[theme];
  const m = markShapes({ idp: "m", small, ink: p.ink, shadow: small ? 0 : p.shadow });
  return svgDoc(small ? G.SMALL_VIEWBOX : G.MARK_VIEWBOX, "IntelyIDE", `<defs>${m.defs}</defs>${m.body}`);
}

function lockupSvg(kind, theme) {
  const p = G.PALETTE[theme];
  const L = layoutLockup(kind);
  const m = markShapes({ idp: "m", ink: p.ink, shadow: p.shadow });
  const { tx, ty, scale } = L.mark;
  const gid = "ide";
  const gradient = `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${num(L.ideX[0])}" y1="0" x2="${num(L.ideX[1])}" y2="0"><stop offset="0" stop-color="${p.ideA}"/><stop offset="1" stop-color="${p.ideB}"/></linearGradient>`;
  return svgDoc(
    L.viewBox,
    "IntelyIDE",
    `<defs>${m.defs}${gradient}</defs><g transform="translate(${num(tx)} ${num(ty)}) scale(${scale})">${m.body}</g>` +
      `<path d="${L.intely}" fill="${p.ink}"/><path d="${L.ide}" fill="url(#${gid})"/><path d="${L.sub}" fill="${p.sub}"/>`,
  );
}

/** App icon tile. `inset` follows the macOS icon grid (824 of 1024); flat fills the canvas. */
function tileSvg({ inset, small }) {
  const S = 1024;
  const T = S - 2 * inset;
  const r = T * 0.225;
  const markPx = T * (small ? 0.78 : 0.722);
  const k = markPx / 300;
  const vb = small ? G.SMALL_VIEWBOX : G.MARK_VIEWBOX;
  const m = markShapes({ idp: "m", small, ink: "#FFFFFF", shadow: small ? 0 : 0.5 });
  const mx = inset + (T - markPx) / 2 - vb[0] * k;
  const my = inset + (T - markPx) / 2;
  const bw = num(T / 360);
  const tileShadow = inset
    ? `<filter id="ts" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#0E0419" flood-opacity="0.5"/></filter>`
    : "";
  return svgDoc(
    [0, 0, S, S],
    "IntelyIDE app icon",
    `<defs><radialGradient id="tg" gradientUnits="userSpaceOnUse" cx="${num(inset + T / 2)}" cy="${num(inset + T * 0.35)}" r="${num(T * 0.82)}"><stop offset="0" stop-color="${G.TILE.from}"/><stop offset="0.72" stop-color="${G.TILE.to}"/></radialGradient>${tileShadow}${m.defs}</defs>` +
      `<rect x="${inset}" y="${inset}" width="${T}" height="${T}" rx="${num(r)}" fill="url(#tg)"${inset ? ' filter="url(#ts)"' : ""}/>` +
      `<rect x="${num(inset + T / 720)}" y="${num(inset + T / 720)}" width="${num(T - T / 360)}" height="${num(T - T / 360)}" rx="${num(r - T / 720)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="${bw}"/>` +
      `<g transform="translate(${num(mx)} ${num(my)}) scale(${num(k)})">${m.body}</g>`,
  );
}

// ---- Outputs ---------------------------------------------------------------

const sources = {
  "mark-dark.svg": markSvg("dark", false),
  "mark-light.svg": markSvg("light", false),
  "mark-small-dark.svg": markSvg("dark", true),
  "mark-small-light.svg": markSvg("light", true),
  "lockup-horizontal-dark.svg": lockupSvg("horizontal", "dark"),
  "lockup-horizontal-light.svg": lockupSvg("horizontal", "light"),
  "lockup-stacked-dark.svg": lockupSvg("stacked", "dark"),
  "lockup-stacked-light.svg": lockupSvg("stacked", "light"),
  "app-icon.svg": tileSvg({ inset: 100, small: false }),
  "app-icon-flat.svg": tileSvg({ inset: 0, small: false }),
  "app-icon-flat-small.svg": tileSvg({ inset: 0, small: true }),
};
for (const [name, svg] of Object.entries(sources)) write(join(BRAND, name), svg);

const raster = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } }).render().asPng();
// 1024..128 follow the macOS icon grid; 64 is the flat tile with the full mark; 32 and 16 use the simplified mark.
const rasterSource = (size) => (size >= 128 ? sources["app-icon.svg"] : size === 64 ? sources["app-icon-flat.svg"] : sources["app-icon-flat-small.svg"]);
for (const size of [1024, 512, 256, 128, 64, 32, 16]) writeFileSync(join(PNG, `app-icon-${size}.png`), raster(rasterSource(size), size));

// ui/public/brand: favicon (the simplified mark on the flat tile) and the logo copies.
write(join(PUBLIC, "favicon.svg"), sources["app-icon-flat-small.svg"]);
copyFileSync(join(PNG, "app-icon-32.png"), join(PUBLIC, "favicon.png"));
for (const name of Object.keys(sources)) if (/^(mark|lockup)-/.test(name) && !name.includes("small")) write(join(PUBLIC, name), sources[name]);

// src-tauri/icons: let `tauri icon` render into a scratch dir, keep the macOS set only (no Android / iOS / Store logos).
const scratch = at(".scratch", "tauri-icons");
rmSync(scratch, { recursive: true, force: true });
execFileSync("pnpm", ["exec", "tauri", "icon", join(PNG, "app-icon-1024.png"), "-o", scratch], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
for (const name of ["icon.icns", "icon.ico", "icon.png", "32x32.png", "128x128.png", "128x128@2x.png"]) copyFileSync(join(scratch, name), join(ICONS, name));
copyFileSync(join(PNG, "app-icon-32.png"), join(ICONS, "32x32.png"));
// `tauri icon` writes a different icns byte stream on every run; iconutil is deterministic and keeps the small cuts at 16 / 32 / 64 px.
if (process.platform === "darwin") {
  const iconset = join(scratch, "icon.iconset");
  mkdirSync(iconset, { recursive: true });
  for (const [name, px] of [["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64], ["128x128", 128], ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512], ["512x512", 512], ["512x512@2x", 1024]]) {
    writeFileSync(join(iconset, `icon_${name}.png`), raster(rasterSource(px), px));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(ICONS, "icon.icns")]);
}
rmSync(scratch, { recursive: true, force: true });

// Layout and mark data for BrandMark.tsx.
const full = { viewBox: G.MARK_VIEWBOX, bars: G.BARS, barWidth: G.BAR_WIDTH, cursor: G.CURSOR, spark: G.SPARK };
const small = { viewBox: G.SMALL_VIEWBOX, bars: G.SMALL_BARS, barWidth: G.SMALL_BAR_WIDTH, cursor: G.SMALL_CURSOR };
const geometry = { horizontal: layoutLockup("horizontal"), stacked: layoutLockup("stacked") };
const ts = `// Generated by scripts/brand/build-brand.mjs (mark data from scripts/brand/geometry.mjs, wordmark outlined from Sora). Do not edit.
export interface MarkBar {
  d: string;
  x1: number;
  x2: number;
  y: number;
  from: string;
  to: string;
}
export interface MarkData {
  viewBox: [number, number, number, number];
  bars: MarkBar[];
  barWidth: number;
  cursor: { d: string; width: number };
  spark?: { d: string; transform: string };
}
export interface LockupLayout {
  viewBox: [number, number, number, number];
  /** Transform of the 300 x 300 mark: translate(tx ty) scale(scale). */
  mark: { tx: number; ty: number; scale: number };
  /** Outlined "INTELY", "IDE" and the subtitle; \`ideX\` is the gradient run of "IDE". */
  intely: string;
  ide: string;
  ideX: [number, number];
  sub: string;
}

export const MARK: MarkData = ${JSON.stringify(full, null, 2)};
export const MARK_SMALL: MarkData = ${JSON.stringify(small, null, 2)};
export const LOCKUPS: Record<"horizontal" | "stacked", LockupLayout> = ${JSON.stringify(geometry, null, 2)};
`;
write(at("ui", "src", "ui-kit", "brandGeometry.ts"), ts);
console.log(`brand assets built (${Object.keys(sources).length} svg, 7 png)`);
