// One-off: turns the IntelyOpti captures (2400x1600 PNG, macOS window screenshots with rounded corners and a
// transparent margin) at <IntelyOpti>/site-assets/shots/opti-<name>-<light|dark>.png into
// opti-<name>-<theme>-720|1440|2400.png (+ .webp when cwebp exists) in src/static/assets/img/shots/.
// Missing files are skipped: the site shows a neutral placeholder for that slot until the capture exists.
// Run: node scripts/import-opti-shots.mjs   (OPTI_SHOTS_DIR overrides the folder)
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importOne } from './import-lib.mjs';
import { OPTI_SHOTS, OPTI_WIDTHS } from './shots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.env.OPTI_SHOTS_DIR ?? join(here, '../../../IntelyOpti/site-assets/shots');
let n = 0;
let missing = 0;
for (const slot of Object.keys(OPTI_SHOTS)) {
  for (const theme of ['light', 'dark']) {
    const src = join(source, `${slot}-${theme}.png`);
    if (!existsSync(src)) { missing++; continue; }
    importOne(src, slot, theme, OPTI_WIDTHS);
    n++;
  }
}
console.log(`import-opti-shots: ${n} imported, ${missing} not found in ${source}`);
