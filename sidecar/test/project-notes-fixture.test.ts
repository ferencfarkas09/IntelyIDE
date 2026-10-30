// The shared CLAUDE.md cases (fixtures/claude-notes/cases.json): the IDE's Project notes panel mirrors this file selection in
// crates/files/src/claude_notes.rs and checks the same cases (crates/files/tests/claude_notes_fixture.rs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { instructionFiles } from '../src/adapters/claude-sdk/project-notes.js';

type Spec = { text?: string; repeat?: string; count?: number; then?: string };
type Case = { name: string; user: Spec | null; dirs: Record<string, Spec>[]; runDirs: number[]; expect: { scope: string; dir: number | null; rel: string; length: number; shortened: boolean }[] };

const here = path.dirname(fileURLToPath(import.meta.url));
const cases: Case[] = JSON.parse(fs.readFileSync(path.join(here, '../../fixtures/claude-notes/cases.json'), 'utf8')).cases;
const made: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isw-pnf-'))); made.push(d); return d; };
const content = (s: Spec) => s.text ?? `${(s.repeat ?? '').repeat(s.count ?? 0)}${s.then ?? ''}`;
const write = (dir: string, rel: string, s: Spec) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content(s));
};
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

describe('the shared CLAUDE.md cases', () => {
  for (const c of cases) {
    it(c.name, () => {
      const dirs = c.dirs.map((files) => {
        const d = tmp();
        for (const [rel, s] of Object.entries(files)) write(d, rel, s);
        return d;
      });
      const config = tmp();
      if (c.user) write(config, 'CLAUDE.md', c.user);
      const got = instructionFiles(c.runDirs.map((i) => dirs[i]), { env: { CLAUDE_CONFIG_DIR: config } });
      expect(got.map((f) => ({ scope: f.scope, dir: f.dirIndex === null ? null : c.runDirs[f.dirIndex], rel: f.rel, length: f.text.length, shortened: f.shortened }))).toEqual(c.expect);
    });
  }
});
