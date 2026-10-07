#!/usr/bin/env node
// Usage: node scripts/sanitize-golden.mjs [--check] [file.jsonl ...]   (default: fixtures/golden/*.jsonl)
// Rewrites recorded streams in place (idempotent): home/temp/plugin-cache paths, thinking signatures and the MCP/skill/command/plugin
// inventory are stripped. --check changes nothing and exits 1 when anything would still be flagged. The first in-place run keeps a copy
// of the unsanitized originals in .scratch/golden-original/ (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitize, scan } from './lib/golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'fixtures', 'golden');
const args = process.argv.slice(2);
const check = args.includes('--check');
const files = args.filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));
if (!files.length) for (const d of ['.', 'adapter']) if (fs.existsSync(path.join(GOLDEN, d))) files.push(...fs.readdirSync(path.join(GOLDEN, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(GOLDEN, d, f)));

let dirty = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const out = `${text.split('\n').filter(Boolean).map((l) => JSON.stringify(sanitize(JSON.parse(l)))).join('\n')}\n`;
  const problems = scan(out, path.basename(f));
  if (problems.length) { dirty++; console.error(problems.join('\n')); }
  if (check) { if (out !== text) { dirty++; console.error(`${path.basename(f)}: not sanitized`); } continue; }
  if (out === text) continue;
  const keep = path.join(ROOT, '.scratch', 'golden-original', path.basename(f));
  if (!fs.existsSync(keep)) { fs.mkdirSync(path.dirname(keep), { recursive: true }); fs.writeFileSync(keep, text); }
  fs.writeFileSync(f, out);
  console.log(`sanitized ${path.basename(f)}`);
}
if (dirty) process.exit(1);
console.log(check ? 'golden fixtures are clean' : 'done');
