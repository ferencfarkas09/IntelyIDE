// Guard for (design notes: licensing-spec) 6.7: the proprietary Claude Agent SDK (and the claude CLI package) never end up in a
// sidecar bundle. Builds both entries in memory with the exact options of build.mjs; nothing is written to dist/.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const { common, entries } = (await import(/* @vite-ignore */ pathToFileURL(`${root}build.config.mjs`).href)) as {
  common: Record<string, unknown>;
  entries: Array<Record<string, unknown> & { outfile: string }>;
};
const FORBIDDEN = /claude-agent-sdk|claude-code/;

describe('sidecar bundles', () => {
  for (const entry of entries) {
    it(`${entry.outfile} contains no Claude Agent SDK input and no import of it`, async () => {
      const r = await build({ ...common, ...entry, absWorkingDir: root, write: false, logLevel: 'silent' });
      const inputs = Object.keys(r.metafile!.inputs);
      // the SDK installer (src/sdk-install.ts) is deliberately tiny: itself, sdk.ts (tree hashing) and redact.ts, Node built-ins only
      expect(inputs.length).toBeGreaterThan(entry.outfile.endsWith('sdk-install.js') ? 2 : 10);
      expect(inputs.filter((i) => FORBIDDEN.test(i))).toEqual([]);
      for (const out of Object.values(r.metafile!.outputs)) {
        expect(out.imports.filter((i) => FORBIDDEN.test(i.path))).toEqual([]); // not even as an external specifier
      }
      const text = r.outputFiles![0]!.text;
      expect(text).not.toMatch(/from\s*["']@anthropic-ai\/claude-agent-sdk|import\(\s*["']@anthropic-ai\/claude-agent-sdk|require\(\s*["']@anthropic-ai\/claude-agent-sdk/);
      expect(text.startsWith('/*! IntelyIDE sidecar - GPL-3.0-or-later')).toBe(true);
      // the old bundle with the SDK inlined was 2.8 MB
      expect(r.outputFiles![0]!.contents.length).toBeLessThan(2_000_000);
    });
  }

  it('the SDK installer bundle is small and imports nothing but Node built-ins', async () => {
    const entry = entries.find((e) => e.outfile === 'dist/sdk-install.js')!;
    const r = await build({ ...common, ...entry, absWorkingDir: root, write: false, logLevel: 'silent' });
    expect(Object.keys(r.metafile!.inputs).sort()).toEqual(['src/redact.ts', 'src/sdk-install.ts', 'src/sdk.ts']);
    for (const out of Object.values(r.metafile!.outputs)) for (const i of out.imports) expect(i.path, i.path).toMatch(/^node:/);
    expect(r.outputFiles![0]!.contents.length).toBeLessThan(100_000);
  });

  it('nothing in src/ imports the SDK as a value (only erased `import type`) except through src/sdk.ts', () => {
    const files = ['src/adapters/claude-sdk/index.ts', 'src/adapters/claude-sdk/session.ts', 'src/adapters/claude-sdk/gate.ts', 'src/history.ts'];
    for (const f of files) {
      const src = readFileSync(`${root}${f}`, 'utf8');
      const lines = src.split('\n').filter((l) => /from\s+'@anthropic-ai\/claude-agent-sdk'|import\(\s*'@anthropic-ai\/claude-agent-sdk'/.test(l));
      for (const l of lines) expect(l, `${f}: ${l}`).toMatch(/^import type /);
    }
  });
});
