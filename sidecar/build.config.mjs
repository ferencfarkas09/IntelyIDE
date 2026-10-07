// Shared esbuild options of the sidecar: used by build.mjs, by test/no-bundled-sdk.test.ts and by the notice generator
// (scripts/licenses), so all three build exactly the same thing. The proprietary Claude Agent SDK is never bundled
// ((design notes: licensing-spec) section 6): it is loaded at run time from the user's own install by src/sdk.ts.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** Standalone-file banner (spec 5.2). L2b's scripts/licenses/lib/banner.mjs owns the final wording; `licenses:check --release` fails while the placeholder is there. */
export const LEGAL_BANNER = '/*! IntelyIDE sidecar - GPL-3.0-or-later - source: https://github.com/ferencfarkas09/IntelyIDE - third-party notices: THIRD_PARTY_LICENSES */';

export const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  loader: { '.jsonl': 'text' },
  // Never inlined. Nothing imports it by name any more (src/sdk.ts uses a file URL); this is the belt for a stray static import.
  external: ['@anthropic-ai/claude-agent-sdk'],
  metafile: true,
  banner: { js: `${LEGAL_BANNER}\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);` },
  logLevel: 'info',
};

export const entries = [
  { entryPoints: ['src/index.ts'], outfile: 'dist/index.js', define: { SIDECAR_VERSION: JSON.stringify(pkg.version) }, minify: false },
  { entryPoints: ['src/testkit.ts'], outfile: 'dist/testkit.js' },
  // The Agent SDK installer program ((design notes: release-packaging-spec) 5.5): Node built-ins only, run by the bundled Node as Resources/sidecar/sdk-install.js.
  { entryPoints: ['src/sdk-install.ts'], outfile: 'dist/sdk-install.js' },
];

/** `--out-dir <dir>` / `--out-dir=<dir>` on the command line, else SIDECAR_OUT_DIR, else undefined (= dist/). Lets scripts/release/stage.sh build without ever touching sidecar/dist/. */
export function outDirFrom(argv = process.argv.slice(2), env = process.env) {
  const i = argv.findIndex((a) => a === '--out-dir' || a.startsWith('--out-dir='));
  if (i >= 0) {
    const v = argv[i].includes('=') ? argv[i].slice('--out-dir='.length) : argv[i + 1];
    if (!v) throw new Error('--out-dir needs a directory');
    return v;
  }
  return env.SIDECAR_OUT_DIR || undefined;
}
