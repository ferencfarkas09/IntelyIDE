// One-off: turns the curated IntelyIDE demo screenshots in <repo>/docs/screenshots/<name>-<light|dark>.png
// (1600 px wide) into <slot>-<theme>-720.png / -1440.png (+ .webp) in src/static/assets/img/shots/.
// Needs macOS `sips`. Run: node scripts/import-shots.mjs   (SOURCE_DIR overrides the folder)
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importOne } from './import-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.env.SOURCE_DIR ?? join(here, '../../docs/screenshots');
// site slot <- docs/screenshots name. Slots without an entry (team, team-memory) keep their older files.
const MAP = {
  hero: 'overview',
  'changes-tree': 'changes-tree',
  'push-dialog': 'push-confirm',
  'agent-approval': 'agent-approval',
  rewind: 'rewind',
  'workspaces-welcome': 'welcome',
  preview: 'preview',
  remote: 'remote',
  'mongo-studio': 'mongo',
  providers: 'providers',
  'api-contract': 'api-contract',
  appearance: 'appearance',
  palette: 'palette',
  'diff-graph': 'diff-graph',
};
let n = 0;
for (const [slot, name] of Object.entries(MAP)) {
  for (const theme of ['light', 'dark']) {
    const src = join(source, `${name}-${theme}.png`);
    if (!existsSync(src)) { console.warn(`missing ${src}`); continue; }
    importOne(src, slot, theme, [720, 1440]);
    n++;
  }
}
console.log(`import-shots: ${n} images imported from ${source}`);
