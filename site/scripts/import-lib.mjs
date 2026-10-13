// Shared by import-shots.mjs and import-opti-shots.mjs: resample one source PNG with macOS `sips`
// (never upscaling) and write <slot>-<theme>-<width>.png (+ .webp when `cwebp` is installed).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SHOTS_DIR = join(here, '../src/static/assets/img/shots');
export const PLACEHOLDER_DIR = join(here, '../src/static/assets/img/placeholders');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const hasCwebp = (() => { try { run('cwebp', ['-version']); return true; } catch { return false; } })();

export function pixelWidth(file) {
  const m = /pixelWidth:\s*(\d+)/.exec(run('sips', ['-g', 'pixelWidth', file]));
  return m ? Number(m[1]) : 0;
}

/** Writes every width <= the source width; removes stale variants of this slot/theme. Returns widths written. */
export function importOne(src, slot, theme, widths) {
  const srcW = pixelWidth(src);
  const base = `${slot}-${theme}`;
  for (const f of readdirSync(SHOTS_DIR)) if (f.startsWith(`${base}-`)) rmSync(join(SHOTS_DIR, f));
  const done = [];
  for (const w of widths) {
    if (w > srcW) continue; // never upscale
    const out = join(SHOTS_DIR, `${base}-${w}.png`);
    run('sips', ['--resampleWidth', String(w), src, '--out', out]);
    if (hasCwebp) run('cwebp', ['-quiet', '-q', '84', '-alpha_q', '95', out, '-o', join(SHOTS_DIR, `${base}-${w}.webp`)]);
    done.push(w);
  }
  const svg = join(PLACEHOLDER_DIR, `${base}.svg`);
  if (done.length && existsSync(svg)) rmSync(svg);
  return done;
}
