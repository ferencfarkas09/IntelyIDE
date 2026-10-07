// The CLAUDE.md files of the run directories reach the model through the system prompt (the CLI is not asked to load them).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeConfigDir, PROJECT_FILE_MAX_BYTES, PROJECT_TOTAL_MAX_BYTES, projectInstructions, USER_MEMORY_MAX_BYTES } from '../src/adapters/claude-sdk/project-notes.js';

const dirs: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isw-pn-'))); dirs.push(d); return d; };
// the developer's real ~/.claude must never reach a test: the config directory is an empty temp one unless a test names another
const saved = process.env.CLAUDE_CONFIG_DIR;
beforeAll(() => { process.env.CLAUDE_CONFIG_DIR = tmp(); });
afterAll(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; });
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('projectInstructions', () => {
  it('is empty when no run directory has a CLAUDE.md, or a directory does not exist', () => {
    expect(projectInstructions([tmp(), '/definitely/not/here'])).toBe('');
  });

  it('reads CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md of the working directory first, then the added directories', () => {
    const cwd = tmp();
    const add = tmp();
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Backend rules\nNever commit.\n');
    fs.writeFileSync(path.join(cwd, '.claude', 'CLAUDE.md'), 'Second file.');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.local.md'), 'Local note.');
    fs.writeFileSync(path.join(add, 'CLAUDE.md'), 'The secret marker is ZEBRA-SEVEN-4821.');
    const out = projectInstructions([cwd, add, cwd]);
    expect(out.startsWith('Project instructions.')).toBe(true);
    const order = ['Never commit.', 'Second file.', 'Local note.', 'ZEBRA-SEVEN-4821'].map((s) => out.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toContain(`--- ${path.join(cwd, 'CLAUDE.md')} ---`);
    expect(out.split('Never commit.').length - 1, 'a directory listed twice is read once').toBe(1);
  });

  it('ignores a CLAUDE.md that is a symlink out of the run directory (the user global instructions) and empty files', () => {
    const cwd = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'global.md'), 'Use smart_read for everything.');
    fs.symlinkSync(path.join(outside, 'global.md'), path.join(cwd, 'CLAUDE.md'));
    fs.writeFileSync(path.join(cwd, 'CLAUDE.local.md'), '');
    expect(projectInstructions([cwd])).toBe('');
  });

  it('shortens a long file and stops at the total cap', () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'a'.repeat(PROJECT_FILE_MAX_BYTES + 5000));
    const one = projectInstructions([cwd]);
    expect(one).toContain('(shortened)');
    expect(one.length).toBeLessThan(PROJECT_FILE_MAX_BYTES + 600);
    const many = Array.from({ length: 5 }, () => { const d = tmp(); fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'b'.repeat(PROJECT_FILE_MAX_BYTES)); return d; });
    const all = projectInstructions(many);
    expect(all.length).toBeLessThan(PROJECT_TOTAL_MAX_BYTES + 2000);
    expect((all.match(/^--- /gm) ?? []).length).toBeLessThanOrEqual(4);
  });
});

describe('the user memory (~/.claude/CLAUDE.md)', () => {
  const home = (text?: string) => { const d = tmp(); if (text !== undefined) fs.writeFileSync(path.join(d, 'CLAUDE.md'), text); return d; };
  const env = (dir: string) => ({ CLAUDE_CONFIG_DIR: dir, HOME: '/nonexistent-home' });

  it('is the first block, labelled as the user own instructions, before the project notes', () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'PROJECT-MARKER');
    const out = projectInstructions([cwd], { env: env(home('USER-MARKER')) });
    expect(out.startsWith("User instructions. This is the user's own global CLAUDE.md")).toBe(true);
    expect(out.indexOf('USER-MARKER')).toBeGreaterThan(0);
    expect(out.indexOf('USER-MARKER')).toBeLessThan(out.indexOf('Project instructions.'));
    expect(out.indexOf('Project instructions.')).toBeLessThan(out.indexOf('PROJECT-MARKER'));
  });

  it('stands alone when the run directories have no notes, and is absent when the file is absent or empty', () => {
    expect(projectInstructions([tmp()], { env: env(home('only me')) })).toContain('only me');
    expect(projectInstructions([tmp()], { env: env(home()) })).toBe('');
    expect(projectInstructions([tmp()], { env: env(home('  \n')) })).toBe('');
    expect(projectInstructions([tmp()], { env: env('/definitely/not/here') })).toBe('');
  });

  it('is left out when the switch is off', () => {
    expect(projectInstructions([tmp()], { includeUserMemory: false, env: env(home('USER-MARKER')) })).toBe('');
  });

  it('is cut at 32 KiB and the project notes get the rest of the 96 KiB', () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'p'.repeat(PROJECT_FILE_MAX_BYTES));
    fs.writeFileSync(path.join(cwd, 'CLAUDE.local.md'), 'q'.repeat(PROJECT_FILE_MAX_BYTES));
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.writeFileSync(path.join(cwd, '.claude', 'CLAUDE.md'), 'r'.repeat(PROJECT_FILE_MAX_BYTES));
    const out = projectInstructions([cwd], { env: env(home('Z'.repeat(USER_MEMORY_MAX_BYTES + 9000))) });
    const [userPart, projectPart] = out.split('Project instructions.');
    expect(userPart).toContain('Z'.repeat(USER_MEMORY_MAX_BYTES));
    expect(userPart).not.toContain('Z'.repeat(USER_MEMORY_MAX_BYTES + 1));
    expect(userPart).toContain('(shortened)');
    expect(out.length).toBeLessThan(PROJECT_TOTAL_MAX_BYTES + 3000);
    expect(projectPart).not.toContain('q'.repeat(100));
    expect(out).toContain('p'.repeat(PROJECT_FILE_MAX_BYTES));
    expect(out).toContain('r'.repeat(PROJECT_FILE_MAX_BYTES));
  });

  it('refuses a symlink, also one that points inside the config directory', () => {
    const dir = tmp();
    const other = home('SECRET-TARGET');
    fs.symlinkSync(path.join(other, 'CLAUDE.md'), path.join(dir, 'CLAUDE.md'));
    expect(projectInstructions([tmp()], { env: env(dir) })).toBe('');
    const dir2 = tmp();
    fs.writeFileSync(path.join(dir2, 'real.md'), 'inside');
    fs.symlinkSync(path.join(dir2, 'real.md'), path.join(dir2, 'CLAUDE.md'));
    expect(projectInstructions([tmp()], { env: env(dir2) })).toBe('');
  });

  it('does not follow @imports', () => {
    const dir = home('See @other.md for more.');
    fs.writeFileSync(path.join(dir, 'other.md'), 'IMPORTED-CONTENT');
    const out = projectInstructions([tmp()], { env: env(dir) });
    expect(out).toContain('@other.md');
    expect(out).not.toContain('IMPORTED-CONTENT');
  });

  it('finds the file through CLAUDE_CONFIG_DIR, else HOME/.claude, and reads the process environment by default', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' })).toBe('/cfg');
    expect(claudeConfigDir({ HOME: '/h' })).toBe('/h/.claude');
    const h = tmp();
    fs.mkdirSync(path.join(h, '.claude'));
    fs.writeFileSync(path.join(h, '.claude', 'CLAUDE.md'), 'FROM-HOME');
    expect(projectInstructions([tmp()], { env: { HOME: h } })).toContain('FROM-HOME');
    process.env.CLAUDE_CONFIG_DIR = home('FROM-PROCESS-ENV');
    expect(projectInstructions([tmp()])).toContain('FROM-PROCESS-ENV');
  });
});
