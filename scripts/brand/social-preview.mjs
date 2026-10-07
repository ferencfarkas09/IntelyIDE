#!/usr/bin/env node
// Builds the GitHub social preview image (public-release spec R18): assets/brand/social-preview.png, 1280 x 640.
// Same pattern as safety-flow.mjs and build-brand.mjs: outlined Sora text, colours from the app's dark theme tokens,
// every text colour checked for contrast (at least 4.5:1) against its background, resvg render with no system fonts.
// The tagline is the one-line pitch of the README (spec 5.3), so it carries "best-effort". No metadata chunks are written.
// Deterministic: same inputs, same bytes. Run from anywhere: node scripts/brand/social-preview.mjs
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { MIN_CONTRAST, contrast, loadFont, outlineLine, readTokens, wrap } from "./safety-flow.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const W = 1280;
const H = 640;
const MAX_BYTES = 1_000_000;

export const TAGLINE =
  "A desktop Git client for working across several repositories at once, with coding agents that are fenced off from committing and pushing by layered, best-effort protections.";
const FOOTER = "Alpha software  ·  macOS 13.5 or later  ·  GPL-3.0-or-later";

const t = readTokens("dark");
const colour = (name) => {
  if (!/^#[0-9a-f]{6}$/.test(t[name] ?? "")) throw new Error(`dark theme token --${name} is missing or not a solid colour`);
  return t[name];
};
const bg = colour("surface-0");
const bold = loadFont(700);
const medium = loadFont(500);

const out = [];
const checks = [];
function text(font, str, x, y, size, token, opts) {
  const ratio = contrast(colour(token), bg);
  if (ratio < MIN_CONTRAST) throw new Error(`"${str}" --${token} on --surface-0 is ${ratio.toFixed(2)}:1, below ${MIN_CONTRAST}:1`);
  checks.push(ratio);
  out.push(outlineLine(font, str, x, y, size, colour(token), opts));
}

// Mark from the canonical asset (its own gradients, no external reference), nested at the right.
const markSvg = readFileSync(join(ROOT, "assets", "brand", "mark-dark.svg"), "utf8");
const viewBox = /viewBox="([^"]+)"/.exec(markSvg)[1];
const markInner = markSvg.slice(markSvg.indexOf(">") + 1, markSvg.lastIndexOf("</svg>"));
const MARK = 400;

const x0 = 88;
text(bold, "IntelyIDE", x0, 196, 76, "text-1", { spacing: 0.02 });
wrap(medium, TAGLINE, 30, 640).forEach((line, i) => text(medium, line, x0, 272 + i * 44, 30, "text-2"));
text(medium, FOOTER, x0, 568, 18, "text-3");

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
  `<defs><radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="1000" cy="320" r="420"><stop offset="0" stop-color="${colour("accent")}" stop-opacity="0.34"/><stop offset="1" stop-color="${colour("accent")}" stop-opacity="0"/></radialGradient></defs>` +
  `<rect width="${W}" height="${H}" fill="${bg}"/><rect width="${W}" height="${H}" fill="url(#glow)"/>` +
  `<svg x="${1000 - MARK / 2}" y="${320 - MARK / 2}" width="${MARK}" height="${MARK}" viewBox="${viewBox}">${markInner}</svg>` +
  out.join("") +
  `</svg>\n`;

const png = new Resvg(svg, { fitTo: { mode: "original" }, font: { loadSystemFonts: false } }).render().asPng();
if (png.length >= MAX_BYTES) throw new Error(`social preview is ${png.length} bytes, limit ${MAX_BYTES}`);
const file = join(ROOT, "assets", "brand", "social-preview.png");
writeFileSync(file, png);
console.log(`social preview built (${W}x${H}, ${statSync(file).size} bytes, ${checks.length} text runs checked, lowest contrast ${Math.min(...checks).toFixed(2)}:1)`);
