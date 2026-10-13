// Writes one neutral SVG placeholder per screenshot slot (light + dark).
// Each panel prints the exact filename and size of the real image that replaces it.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTI_SHOTS, SHOTS } from './shots.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '../src/static/assets/img/placeholders');
mkdirSync(out, { recursive: true });

const palette = {
  light: { a: '#e9fbf7', b: '#ece6ff', c: '#fbe6fa', ink: '#2a2147', mute: '#5b4b7a', bar: '#ffffff' },
  dark: { a: '#0f2a2a', b: '#1b1340', c: '#2e1238', ink: '#f1ecff', mute: '#b9aedb', bar: '#16102a' },
};

const ALL = { ...SHOTS, ...OPTI_SHOTS };
for (const name of Object.keys(ALL)) {
  for (const theme of ['light', 'dark']) {
    const file0 = join(out, `${name}-${theme}.svg`);
    // Real images exist: no placeholder (the page output carries none).
    if (existsSync(join(out, `../shots/${name}-${theme}-720.png`))) { rmSync(file0, { force: true }); continue; }
    const p = palette[theme];
    const file = `${name}-${theme}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" width="1440" height="900" role="img" aria-label="Placeholder for ${file}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.a}"/><stop offset=".55" stop-color="${p.b}"/><stop offset="1" stop-color="${p.c}"/></linearGradient></defs>
<rect width="1440" height="900" fill="url(#g)"/>
<rect width="1440" height="56" fill="${p.bar}" opacity=".7"/>
<rect x="260" y="120" width="920" height="22" rx="11" fill="${p.mute}" opacity=".18"/>
<rect x="260" y="160" width="640" height="22" rx="11" fill="${p.mute}" opacity=".12"/>
<g font-family="ui-monospace,SFMono-Regular,Menlo,monospace" text-anchor="middle" fill="${p.ink}">
<text x="720" y="440" font-size="56" font-weight="700">${file}</text>
<text x="720" y="500" font-size="30" fill="${p.mute}">screenshot coming soon</text>
<text x="720" y="552" font-size="26" fill="${p.mute}">${ALL[name]}</text>
</g></svg>
`;
    writeFileSync(file0, svg);
  }
}
console.log(`Wrote ${Object.keys(ALL).length * 2} slots (placeholders only where no real image exists) to ${out}`);
