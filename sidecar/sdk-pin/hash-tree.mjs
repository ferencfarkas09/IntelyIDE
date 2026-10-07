#!/usr/bin/env node
// Tree manifest for the pinned Agent SDK install (see README.md). Offline; reads files only.
//
//   node sidecar/sdk-pin/hash-tree.mjs <dir>            print the manifest of <dir> (sorted `sha256  path` lines)
//   node sidecar/sdk-pin/hash-tree.mjs --check <dir>    compare <dir> with sidecar/sdk-pin/tree.sha256, exit 1 on a difference
//
// The rules are the ones sidecar/src/sdk.ts enforces at load time (a test runs both on one fixture and compares):
// only directories and regular files; `node_modules/.bin` and `node_modules/.package-lock.json` (written by npm, never
// imported) are skipped; any other symlink or special file is an error.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules/.bin', 'node_modules/.package-lock.json']);

export function treeLines(root) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(root, rel) : root;
    for (const name of readdirSync(abs)) {
      const r = rel ? `${rel}/${name}` : name;
      if (SKIP.has(r)) continue;
      if (/[\u0000-\u001f\u007f]/.test(r)) throw new Error(`control character in a path: ${JSON.stringify(r)}`);
      const st = lstatSync(path.join(root, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.push([r, createHash('sha256').update(readFileSync(path.join(root, r))).digest('hex')]);
      else throw new Error(`not a regular file or directory: ${r}`);
    }
  };
  walk('');
  out.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  return out.map(([r, h]) => `${h}  ${r}`);
}

export const manifestOf = (root) => `${treeLines(root).join('\n')}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  const dir = check ? args[1] : args[0];
  if (!dir) { console.error('usage: hash-tree.mjs [--check] <dir>'); process.exit(2); }
  const text = manifestOf(path.resolve(dir));
  if (!check) { process.stdout.write(text); process.exit(0); }
  const want = readFileSync(new URL('./tree.sha256', import.meta.url), 'utf8');
  if (want === text) { console.log(`tree matches tree.sha256 (${text.split('\n').length - 1} files)`); process.exit(0); }
  const a = new Set(want.split('\n')), b = new Set(text.split('\n'));
  const diff = [...a].filter((l) => !b.has(l)).concat([...b].filter((l) => !a.has(l))).slice(0, 10);
  console.error(`tree differs from tree.sha256; first differences:\n${diff.join('\n')}`);
  process.exit(1);
}
