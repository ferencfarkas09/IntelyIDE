#!/usr/bin/env node
// Builds the safety diagram of the README (public-release spec R18):
//   assets/diagrams/safety-flow-light.svg, assets/diagrams/safety-flow-dark.svg
// Hand-laid vector art with outlined text (Sora, same pattern as build-brand.mjs): no <text>, no font, no external reference.
// Colours are read from the app's own theme tokens (ui/src/theme/tokens.css) and every text colour is checked against the
// background it sits on (WCAG contrast, at least 4.5:1); the build fails instead of writing a low-contrast file.
// Deterministic: same inputs, same bytes. Run from anywhere: node scripts/brand/safety-flow.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import opentype from "opentype.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const at = (...p) => join(ROOT, ...p);
export const MIN_CONTRAST = 4.5;

// ---- theme tokens ----------------------------------------------------------

/** Reads the custom properties of the first `[data-theme="<theme>"]` block of tokens.css (solid hex and rgba values are kept). */
export function readTokens(theme, css = readFileSync(at("ui", "src", "theme", "tokens.css"), "utf8")) {
  const head = css.search(new RegExp(`^\\[data-theme="${theme}"\\]`, "m"));
  if (head < 0) throw new Error(`tokens.css has no [data-theme="${theme}"] block`);
  const body = css.slice(css.indexOf("{", head) + 1, css.indexOf("\n}", head));
  const tokens = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|rgba\([^)]*\))\s*;/g)) tokens[m[1]] = m[2].toLowerCase();
  return tokens;
}

const toHex = (n) => `#${n.toString(16).padStart(6, "0")}`;
/** Resolves a token to a solid #rrggbb; an rgba() token is composited over the solid colour `over`. */
export function solid(value, over) {
  const m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value);
  if (!m) return value;
  const o = parseInt(over.slice(1), 16);
  const a = Number(m[4]);
  const mixc = (fg, bg) => Math.round(fg * a + bg * (1 - a));
  return toHex((mixc(+m[1], (o >> 16) & 255) << 16) | (mixc(+m[2], (o >> 8) & 255) << 8) | mixc(+m[3], o & 255));
}

const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
/** WCAG 2.x contrast ratio of two #rrggbb colours. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---- outlined text ---------------------------------------------------------

const fonts = {};
export function loadFont(weight) {
  fonts[weight] ??= (() => {
    const buf = readFileSync(at("node_modules", "@fontsource", "sora", "files", `sora-latin-${weight}-normal.woff`));
    return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  })();
  return fonts[weight];
}

/** Advance width of `str` at `size` px, kerning included. */
export function measure(font, str, size, spacing = 0) {
  const k = size / font.unitsPerEm;
  let x = 0;
  let prev;
  for (const ch of str) {
    const g = font.charToGlyph(ch);
    if (prev) x += font.getKerningValue(prev, g) * k;
    x += g.advanceWidth * k + spacing * size;
    prev = g;
  }
  return x - spacing * size;
}

/** Greedy word wrap to `maxWidth` px. */
export function wrap(font, str, size, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of str.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(font, next, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const num = (n) => String(Math.round(n * 100) / 100);

/** Path commands as an SVG `d` string with one decimal. (opentype.js 2.0 `toPathData` can print NaN for some quadratic commands.) */
function pathData(path) {
  const n = (v) => {
    const r = Math.round(v * 10) / 10;
    return String(Object.is(r, -0) ? 0 : r);
  };
  return path.commands
    .map((c) => {
      if (c.type === "Z") return "Z";
      if (c.type === "Q") return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
      if (c.type === "C") return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
      return `${c.type}${n(c.x)} ${n(c.y)}`;
    })
    .join("");
}

/** One line of outlined text as a <path>; `anchor` is start | middle | end; baseline at y. */
export function outlineLine(font, str, x, y, size, fill, { anchor = "start", spacing = 0 } = {}) {
  const w = measure(font, str, size, spacing);
  let cx = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  const k = size / font.unitsPerEm;
  const path = new opentype.Path();
  let prev;
  for (const ch of str) {
    const g = font.charToGlyph(ch);
    if (prev) cx += font.getKerningValue(prev, g) * k;
    path.extend(g.getPath(cx, y, size));
    cx += g.advanceWidth * k + spacing * size;
    prev = g;
  }
  return `<path d="${pathData(path)}" fill="${fill}"/>`;
}

// ---- the diagram -----------------------------------------------------------

const W = 1200;
const H = 590;

function build(theme) {
  const t = readTokens(theme);
  const need = (name, over = t["surface-1"]) => {
    if (!t[name]) throw new Error(`theme token --${name} is missing in the ${theme} theme`);
    return solid(t[name], over);
  };
  const medium = loadFont(500);
  const semibold = loadFont(600);
  const bold = loadFont(700);
  const out = [];

  /** Text with its background declared: the contrast is computed here and a failure aborts the build. */
  const text = (font, str, x, y, size, fgToken, bgToken, opts) => {
    const ratio = contrast(need(fgToken), need(bgToken));
    if (ratio < MIN_CONTRAST) throw new Error(`${theme}: "${str}" --${fgToken} on --${bgToken} is ${ratio.toFixed(2)}:1, below ${MIN_CONTRAST}:1`);
    contrasts.push({ theme, text: str, fg: fgToken, bg: bgToken, ratio });
    out.push(outlineLine(font, str, x, y, size, need(fgToken), opts));
  };
  const lines = (font, str, x, y, size, lead, fgToken, bgToken, maxWidth) => {
    const ls = wrap(font, str, size, maxWidth);
    ls.forEach((l, i) => text(font, l, x, y + i * lead, size, fgToken, bgToken));
    return ls.length;
  };
  const rect = (x, y, w, h, r, fill, stroke, extra = "") =>
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${need(fill)}"${stroke ? ` stroke="${need(stroke)}" stroke-width="1.5"` : ""}${extra}/>`);
  const arrow = (x1, y1, x2, y2) => {
    const c = need("text-2");
    const dx = Math.sign(x2 - x1);
    const dy = Math.sign(y2 - y1);
    const hx = x2 - dx * 12;
    const hy = y2 - dy * 12;
    out.push(`<path d="M${x1} ${y1} L${hx} ${hy}" stroke="${c}" stroke-width="2.5" stroke-linecap="round" fill="none"/>`);
    out.push(`<path d="M${x2} ${y2} L${hx - dy * 7} ${hy + dx * 7} L${hx + dy * 7} ${hy - dx * 7} Z" fill="${c}"/>`);
  };

  rect(0, 0, W, H, 0, "surface-0");

  // Header.
  text(bold, "How an agent run is fenced in", 40, 62, 30, "text-1", "surface-0");
  text(medium, "Layered, best-effort protections: defence in depth, not one lock, and not a sandbox.", 40, 94, 16, "text-2", "surface-0");

  // Agent.
  rect(40, 160, 210, 270, 12, "surface-2", "border-strong");
  text(bold, "Coding agent", 62, 204, 21, "text-1", "surface-2");
  lines(medium, "Reads and edits files in the repositories you registered, runs read-only Git, and asks you before anything else.", 62, 236, 14, 21, "text-2", "surface-2", 166);

  // Layers panel.
  rect(310, 128, 560, 440, 16, "surface-1", "border-strong");
  text(bold, "BEST-EFFORT LAYERS", 336, 162, 13, "accent-text", "surface-1", { spacing: 0.12 });
  const layers = [
    ["1", "Policy hard stops", "Commit, push, merge, reset, rebase, checkout and edits to .git, hooks and lockfiles are refused before the tool runs.", false],
    ["2", "Host allow-list", "Git that the agent starts is checked on the host: only read-only commands pass.", false],
    ["3", "Git shim", "A wrapper first on the agent's PATH. A speed bump, not the lock: an absolute path such as /usr/bin/git walks around it.", true],
    ["4", "Test jail", "A read-only mode for contributors and tests that refuses commits, pushes and saves.", false],
  ];
  layers.forEach(([n, title, body, bump], i) => {
    const y = 178 + i * 96;
    if (bump) rect(332, y, 516, 86, 10, "surface-2", "warn", ' stroke-dasharray="7 5"');
    else rect(332, y, 516, 86, 10, "surface-2", "border");
    const fg = bump ? "warn" : "accent-text";
    text(bold, n, 354, y + 33, 20, fg, "surface-2");
    text(bold, title, 384, y + 33, 18, "text-1", "surface-2");
    if (bump) text(semibold, "SPEED BUMP", 828, y + 32, 12, "warn", "surface-2", { anchor: "end", spacing: 0.1 });
    lines(medium, body, 384, y + 55, 13, 18, "text-2", "surface-2", 440);
  });

  // Working tree and the person.
  rect(930, 160, 230, 150, 12, "surface-2", "border-strong");
  text(bold, "Working tree", 952, 204, 21, "text-1", "surface-2");
  lines(medium, "Your repositories on disk. A Rewind snapshot is taken before each run.", 952, 236, 14, 21, "text-2", "surface-2", 188);

  rect(930, 396, 230, 172, 12, "surface-2", "accent-border");
  text(bold, "You", 952, 440, 21, "text-1", "surface-2");
  [["Commit", 952], ["Push", 1050]].forEach(([label, x]) => {
    const w = Math.ceil(measure(semibold, label, 14)) + 28;
    rect(x, 456, w, 34, 8, "accent");
    text(semibold, label, x + w / 2, 478, 14, "text-on-accent", "accent", { anchor: "middle" });
  });
  lines(medium, "These two buttons belong to the person, not to the agent.", 952, 520, 14, 20, "text-2", "surface-2", 188);

  // Arrows: agent -> layers -> working tree; person -> working tree.
  arrow(252, 295, 306, 295);
  arrow(872, 235, 926, 235);
  arrow(1045, 392, 1045, 314);

  const sr = "Diagram: the agent's requests pass four best-effort layers (policy hard stops, host allow-list, a Git shim that is only a speed bump, and a test jail) before they reach the working tree. The Commit and Push buttons belong to the person.";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${sr}"><title>How an agent run is fenced in (best-effort)</title>${out.join("")}</svg>\n`;
}

export const contrasts = [];

export function buildAll() {
  contrasts.length = 0;
  return { light: build("light"), dark: build("dark") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const svgs = buildAll();
  const dir = at("assets", "diagrams");
  mkdirSync(dir, { recursive: true });
  for (const theme of ["light", "dark"]) writeFileSync(join(dir, `safety-flow-${theme}.svg`), svgs[theme]);
  const min = Math.min(...contrasts.map((c) => c.ratio));
  console.log(`safety diagrams built (2 svg, ${contrasts.length} text runs checked, lowest contrast ${min.toFixed(2)}:1, minimum ${MIN_CONTRAST}:1)`);
}
