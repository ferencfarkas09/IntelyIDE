#!/usr/bin/env node
// Wraps a raw WKWebView snapshot (2880 x 1800) in a synthetic macOS-style window: transparent margin,
// rounded corners, soft shadow, traffic lights. Offline: resvg + templates/frame.svg, no external tools.
// Usage: node scripts/shots/frame.mjs <in.png> <out.png> [--no-frame] [--width N] [--config file]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { readHeader } from "./lib/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = join(HERE, "frame.config.json");

export const loadConfig = (file = DEFAULT_CONFIG) => JSON.parse(readFileSync(file, "utf8"));

const fill = (tpl, vars) => tpl.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
  if (!(k in vars)) throw new Error(`template variable ${k} is not provided`);
  return String(vars[k]);
});
const tpl = (name) => readFileSync(join(HERE, "templates", name), "utf8");

/** SVG document for one snapshot. frame=false gives the plain image at its own size. */
export function buildSvg(png, { frame = true, config = loadConfig() } = {}) {
  const { width: iw, height: ih } = readHeader(png);
  const image = `data:image/png;base64,${png.toString("base64")}`;
  if (!frame) return fill(tpl("plain.svg"), { W: iw, H: ih, IMAGE: image });
  const m = config.margin, r = config.radius, sw = config.stroke.width;
  const L = config.lights;
  const lights = L.colors
    .map((c, i) => `  <circle cx="${m + L.x + i * L.gap}" cy="${m + L.y}" r="${L.radius}" fill="${c}"/>`)
    .join("\n");
  return fill(tpl("frame.svg"), {
    W: iw + 2 * m, H: ih + 2 * m, M: m, IW: iw, IH: ih, R: r,
    SHADOW_BLUR: config.shadow.blur, SHADOW_Y: m + config.shadow.dy,
    SHADOW_COLOR: config.shadow.color, SHADOW_OPACITY: config.shadow.opacity,
    M_IN: m + sw / 2, IW_IN: iw - sw, IH_IN: ih - sw, R_IN: Math.max(0, r - sw / 2),
    STROKE_COLOR: config.stroke.color, STROKE_OPACITY: config.stroke.opacity, STROKE_W: sw,
    IMAGE: image, LIGHTS: lights,
  });
}

/** Render to PNG bytes; width (optional) scales to exactly that many pixels wide. */
export function renderShot(png, { frame = true, width, config } = {}) {
  const svg = buildSvg(png, { frame, config });
  const fitTo = width ? { mode: "width", value: width } : { mode: "original" };
  return Buffer.from(new Resvg(svg, { fitTo, font: { loadSystemFonts: false } }).render().asPng());
}

function main(argv) {
  const pos = [];
  const opt = { frame: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-frame") opt.frame = false;
    else if (a === "--width") opt.width = Number(argv[++i]);
    else if (a === "--config") opt.config = loadConfig(resolve(argv[++i]));
    else if (a.startsWith("--")) { console.error(`unknown option ${a}`); process.exit(2); }
    else pos.push(a);
  }
  if (pos.length !== 2 || (opt.width !== undefined && !(opt.width > 0))) {
    console.error("usage: frame.mjs <in.png> <out.png> [--no-frame] [--width N] [--config file]");
    process.exit(2);
  }
  writeFileSync(pos[1], renderShot(readFileSync(pos[0]), opt));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
