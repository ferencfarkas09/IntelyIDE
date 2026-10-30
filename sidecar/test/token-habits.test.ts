// The token-saving habits block (docs/token-saver.md): pinned by fixtures/token-habits/habits.txt, which the UI's preview checks too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IDE_SESSION_NOTE, systemAppend, TOKEN_HABITS_NOTE } from '../src/adapters/claude-sdk/notes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, '../../fixtures/token-habits/habits.txt'), 'utf8').replace(/\r\n/g, '\n').trimEnd();

describe('token-saving habits', () => {
  it('is the text of the shared fixture (the Settings preview shows the same)', () => {
    expect(TOKEN_HABITS_NOTE).toBe(fixture);
  });

  it('says it never overrides the safety rules, the user or the project CLAUDE.md, and names the folders to skip', () => {
    expect(TOKEN_HABITS_NOTE).toContain("the safety rules of this session, the user's own instructions and the project's CLAUDE.md always win");
    for (const dir of ['node_modules', 'dist', 'ios/Pods', 'ios/build', 'android/build', '.gradle', '.cache']) expect(TOKEN_HABITS_NOTE).toContain(dir);
    expect(TOKEN_HABITS_NOTE).toMatch(/offset and limit/);
  });

  it('is added only when switched on, last, and at most once', () => {
    expect(systemAppend([IDE_SESSION_NOTE, '', null, 'Project instructions.'], false)).toBe(`${IDE_SESSION_NOTE}\n\nProject instructions.`);
    expect(systemAppend([IDE_SESSION_NOTE, 'Project instructions.'], true)).toBe(`${IDE_SESSION_NOTE}\n\nProject instructions.\n\n${TOKEN_HABITS_NOTE}`);
    const twice = systemAppend([TOKEN_HABITS_NOTE, IDE_SESSION_NOTE, TOKEN_HABITS_NOTE], true);
    expect(twice.split(TOKEN_HABITS_NOTE).length - 1).toBe(1);
    expect(twice.endsWith(TOKEN_HABITS_NOTE)).toBe(true);
    expect(systemAppend([TOKEN_HABITS_NOTE, IDE_SESSION_NOTE], false)).toBe(IDE_SESSION_NOTE);
  });
});
