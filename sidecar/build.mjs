// esbuild: dist/index.js = the single-file sidecar (node 24, ESM); dist/testkit.js = the same modules for scripts/ and tests.
// Options live in build.config.mjs. The Claude Agent SDK is external (see src/sdk.ts); dist/meta.json is the merged
// esbuild metafile of both entries, for tooling (the licence checker asserts the SDK is not among the inputs).
// SIDECAR_OUT_DIR (tests, tooling) redirects the output without touching dist/.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { common, entries } from './build.config.mjs';

const outDir = process.env.SIDECAR_OUT_DIR;
const meta = { inputs: {}, outputs: {} };
for (const entry of entries) {
  const outfile = outDir ? path.join(outDir, path.basename(entry.outfile)) : entry.outfile;
  const r = await build({ ...common, ...entry, outfile });
  Object.assign(meta.inputs, r.metafile.inputs);
  Object.assign(meta.outputs, r.metafile.outputs);
}
const metaFile = path.join(outDir ?? 'dist', 'meta.json');
mkdirSync(path.dirname(metaFile), { recursive: true });
writeFileSync(metaFile, JSON.stringify(meta));
