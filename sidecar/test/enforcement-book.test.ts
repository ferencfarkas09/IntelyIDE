// scripts/lib/enforcement-book.mjs: what the live attempt suites write into the host's enforcement.json. The shape is the one
// crates/agent_host/tests/providers.rs reads (the same literal), so the harness and the host cannot drift apart unnoticed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { bookRun, cliVersionOf, mergeBook, recordBook } from '../../scripts/lib/enforcement-book.mjs';

const result = {
  claudeVersion: '2.1.284 (Claude Code)',
  suites: { baseline: 'pass', S1: 'pass', S2: 'fail' },
  layers: { denyRules: 'proven', hook: 'proven', shim: 'notProven', 'shim-path': 'proven' },
};

describe('bookRun', () => {
  it('records S1 and S2 from the attempts, the hook and deny-rule layers from their ablations, never the shim', () => {
    const run = bookRun(result, { at: 7 });
    expect(run).toEqual({
      key: { adapter: 'claude-sdk', authMode: 'subscription', roleMode: 'edit', cliVersion: '2.1.284' },
      suites: { t0: 'notRun', s0: 'notRun', s1: 'pass', s2: 'fail', s3: 'notRun', s4: 'notRun' },
      layersProven: ['denyRules', 'hook'],
      at: 7,
    });
  });

  it('leaves S0 notRun unless the caller says the Rust bypass suite was green, and an inconclusive suite is notRun, not pass', () => {
    expect(bookRun(result).suites.s0).toBe('notRun');
    expect(bookRun(result, { s0: 'pass' }).suites.s0).toBe('pass');
    expect(bookRun({ ...result, suites: { S1: 'notRun', S2: 'notRun' }, layers: {} }).suites).toMatchObject({ s1: 'notRun', s2: 'notRun' });
  });

  it('has the exact shape the host test reads', () => {
    const literal = { key: { adapter: 'opencode', authMode: 'subscription', roleMode: 'readOnly', cliVersion: '1.4.0' }, suites: { t0: 'notRun', s0: 'pass', s1: 'pass', s2: 'notRun', s3: 'notRun', s4: 'notRun' }, layersProven: [], at: 1 };
    const fromScript = bookRun({ claudeVersion: 'x 1.4.0', suites: { S1: 'pass' }, layers: {} }, { s0: 'pass', at: 1, adapter: 'opencode', roleMode: 'readOnly' });
    expect(fromScript).toEqual(literal);
  });
});

describe('recordBook', () => {
  it('writes <dir>/enforcement.json (0600), replaces the same slot, drops evidence for another CLI version and keeps other adapters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intely-book-'));
    try {
      const file = recordBook(dir, bookRun(result, { at: 1 }));
      expect(file).toBe(path.join(dir, 'enforcement.json'));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      recordBook(dir, bookRun({ ...result, claudeVersion: '2.1.284' }, { at: 2, s0: 'pass' }));
      let book = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(book.runs).toHaveLength(1);
      expect(book.runs[0]).toMatchObject({ at: 2, suites: { s0: 'pass' } });
      recordBook(dir, bookRun({ ...result, claudeVersion: '2.1.284' }, { at: 3, adapter: 'codex' }));
      recordBook(dir, bookRun({ ...result, claudeVersion: '2.2.0' }, { at: 4 }));
      book = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(book.runs.map((r: { key: { adapter: string; cliVersion: string } }) => `${r.key.adapter}@${r.key.cliVersion}`).sort()).toEqual(['claude-sdk@2.2.0', 'codex@2.1.284']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mergeBook and cliVersionOf are pure', () => {
    expect(cliVersionOf('claude 2.1.284 (Claude Code)')).toBe('2.1.284');
    expect(cliVersionOf('')).toBe('');
    expect(mergeBook(undefined, bookRun(result)).runs).toHaveLength(1);
  });
});
