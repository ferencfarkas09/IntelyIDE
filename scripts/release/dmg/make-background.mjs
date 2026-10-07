#!/usr/bin/env node
// Deterministic DMG background art (660x400 @1x, 1320x800 @2x) for the IntelyIDE installer window.
// Contract: (design notes: release-packaging-spec) 5.3 - icon centres (165,185) and (495,185); the LABEL BAND under both
// icons is a mid-tone chip (relative luminance 0.170-0.190) because Finder draws labels in black or white.
// Rasterised with headless Chromium (playwright-core from .scratch/pw), Sora embedded from @fontsource/sora.
// Usage: node make-background.mjs [outDir]   (writes bg.png, bg@2x.png, background.tiff)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
export const W = 660, H = 400;
export const ICONS = { app: [165, 185], apps: [495, 185] };
// Label band: chips under each icon; the check samples the inner area (see check-background.mjs).
export const CHIP = { w: 176, h: 36, top: 252, r: 18 };
export const CHIP_FILL = "#77727f"; // slate-violet, relative luminance ~0.178

const sora = (w) => pathToFileURL(path.join(ROOT, `node_modules/@fontsource/sora/files/sora-latin-${w}-normal.woff2`)).href;
const brand = (f) => pathToFileURL(path.join(ROOT, "assets/brand", f)).href;

function html() {
  const [ax, ay] = ICONS.app, [bx, by] = ICONS.apps;
  const chip = (cx) => `<rect x="${cx - CHIP.w / 2}" y="${CHIP.top}" width="${CHIP.w}" height="${CHIP.h}" rx="${CHIP.r}" fill="${CHIP_FILL}"/>
    <rect x="${cx - CHIP.w / 2 + .5}" y="${CHIP.top + .5}" width="${CHIP.w - 1}" height="${CHIP.h - 1}" rx="${CHIP.r - .5}" fill="none" stroke="#ffffff" stroke-opacity=".16"/>`;
  const x0 = ax + 84, x1 = bx - 84, y = ay - 6;
  return `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Sora;font-weight:400;src:url(${sora(400)})}
@font-face{font-family:Sora;font-weight:600;src:url(${sora(600)})}
@font-face{font-family:Sora;font-weight:700;src:url(${sora(700)})}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#15141d}
svg{display:block}
text{font-family:Sora,sans-serif;text-rendering:geometricPrecision}
</style>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<defs>
 <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1a27"/><stop offset="1" stop-color="#111018"/></linearGradient>
 <radialGradient id="glow" cx="330" cy="150" r="300" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7c4dff" stop-opacity=".26"/><stop offset=".55" stop-color="#7c4dff" stop-opacity=".08"/><stop offset="1" stop-color="#7c4dff" stop-opacity="0"/></radialGradient>
 <radialGradient id="glow2" cx="560" cy="420" r="260" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d946ef" stop-opacity=".12"/><stop offset="1" stop-color="#d946ef" stop-opacity="0"/></radialGradient>
 <linearGradient id="arrow" gradientUnits="userSpaceOnUse" x1="${x0}" y1="0" x2="${x1}" y2="0"><stop offset="0" stop-color="#a78bfa" stop-opacity="0"/><stop offset=".45" stop-color="#a78bfa" stop-opacity=".75"/><stop offset="1" stop-color="#e9d5ff" stop-opacity=".95"/></linearGradient>
 <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
 <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect width="${W}" height="${H}" fill="url(#glow2)"/>
<!-- soft pedestals behind the icons -->
<ellipse cx="${ax}" cy="${ay + 8}" rx="92" ry="78" fill="#7c4dff" opacity=".07" filter="url(#soft)"/>
<ellipse cx="${bx}" cy="${by + 8}" rx="92" ry="78" fill="#7c4dff" opacity=".07" filter="url(#soft)"/>
<!-- header -->
<image href="${brand("lockup-horizontal-dark.svg")}" x="28" y="22" width="132" height="29.2"/>
<text x="${W / 2}" y="82" text-anchor="middle" font-size="21" font-weight="600" fill="#f4f2fb" letter-spacing="-.2">Drag IntelyIDE to Applications</text>
<text x="${W / 2}" y="103" text-anchor="middle" font-size="11.5" font-weight="400" fill="#a6a2bd">Húzd az IntelyIDE-t az Alkalmazások mappába</text>
<rect x="60" y="116" width="540" height="1" fill="url(#rule)" opacity=".0"/>
<!-- arrow, aligned to the icon centres' vertical axis -->
<g fill="none" stroke="url(#arrow)" stroke-linecap="round" stroke-linejoin="round">
 <path d="M${x0} ${y} H${x1 - 2}" stroke-width="2.5"/>
 <path d="M${x1 - 12} ${y - 11} L${x1} ${y} L${x1 - 12} ${y + 11}" stroke-width="3"/>
</g>
<!-- label band chips (mid-tone, see header) -->
${chip(ax)}
${chip(bx)}
<!-- footer -->
<rect x="60" y="340" width="540" height="1" fill="url(#rule)"/>
<text x="${W / 2}" y="361" text-anchor="middle" font-size="9.6" fill="#a6a2bd">First launch: if macOS blocks the app, open System Settings › Privacy &amp; Security › Open Anyway</text>
<text x="${W / 2}" y="379" text-anchor="middle" font-size="9.6" fill="#8a86a3">GPL-3.0-or-later  ·  github.com/ferencfarkas09/IntelyIDE</text>
</svg>`;
}

/** Render the background; returns {1: Buffer, 2: Buffer} PNGs (660x400 and 1320x800). */
export async function renderBackground() {
  const req = createRequire(path.join(ROOT, ".scratch/pw/package.json"));
  const { chromium } = req("playwright-core");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intely-bg-"));
  const file = path.join(tmp, "bg.html");
  fs.writeFileSync(file, html());
  // The pinned headless shell (chromium_headless_shell-1228) when present, else the system Chrome (as scripts/shots do).
  const shell = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-x64/chrome-headless-shell");
  const launch = fs.existsSync(shell) ? { executablePath: shell } : { channel: "chrome" };
  const browser = await chromium.launch({ ...launch, headless: true, args: ["--disable-gpu", "--hide-scrollbars", "--font-render-hinting=none"] });
  const out = {};
  try {
    for (const s of [1, 2]) {
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: s, colorScheme: "dark" });
      const page = await ctx.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      out[s] = await page.screenshot({ type: "png", omitBackground: false });
      await ctx.close();
    }
  } finally { await browser.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] || ".");
  fs.mkdirSync(outDir, { recursive: true });
  const r = await renderBackground();
  fs.writeFileSync(path.join(outDir, "bg.png"), r[1]);
  fs.writeFileSync(path.join(outDir, "bg@2x.png"), r[2]);
  execFileSync("tiffutil", ["-cathidpicheck", path.join(outDir, "bg.png"), path.join(outDir, "bg@2x.png"), "-out", path.join(outDir, "background.tiff")]);
  console.log(`wrote ${outDir}/{bg.png,bg@2x.png,background.tiff}`);
}
