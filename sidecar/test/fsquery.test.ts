// fs/query: the read-only file-system oracle of the permission broker (src/fsquery.ts).
//
// Format of ../../fixtures/fsquery/canonical-cases.json (shared with the Rust side later):
//   { format: 1, tree: [{path, type: 'dir'|'file'|'symlink', target?}], cases: [{name, input, expected}] }
// The tree is built under an empty temp directory R (dirs, files, then symlinks; `${ROOT}` in a target is R). A case passes when
// canonical(R + '/' + input) === realpath(R) + ('/' + expected), or realpath(R) alone when `expected` is empty; `expectedOneOf`
// (loops) lists the accepted values instead.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalLossy, fsQuery, MAX_OPS, READ_HARD, registerFsQuery, REPLY_BUDGET } from '../src/fsquery.js';
import { ProtocolClient } from '../src/protocol.js';

type Tree = { path: string; type: 'dir' | 'file' | 'symlink'; target?: string }[];
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../fixtures/fsquery/canonical-cases.json'), 'utf8')) as { format: number; tree: Tree; cases: { name: string; input: string; expected?: string; expectedOneOf?: string[] }[] };

let root: string;
let real: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'intely-fsq-'));
  real = realpathSync(root);
  for (const t of ['dir', 'file', 'symlink'] as const) {
    for (const e of fixture.tree.filter((x) => x.type === t)) {
      const p = path.join(root, e.path);
      if (t === 'dir') mkdirSync(p, { recursive: true });
      else if (t === 'file') writeFileSync(p, 'x');
      else symlinkSync(e.target!.replaceAll('${ROOT}', root), p);
    }
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const q = async (...ops: unknown[]) => (await fsQuery({ ops })) as { results: any[] };
const one = async (op: object) => (await q(op)).results[0];

describe('canonical (shared vectors)', () => {
  it('fixture is format 1', () => { expect(fixture.format).toBe(1); expect(fixture.cases.length).toBeGreaterThan(15); });
  for (const c of fixture.cases) {
    it(c.name, async () => {
      const wants = (c.expectedOneOf ?? [c.expected ?? '']).map((e) => (e ? `${real}/${e}` : real));
      expect(wants).toContain(await canonicalLossy(`${root}/${c.input}`));
      const r = await one({ op: 'canonical', path: `${root}/${c.input}` });
      expect(r.ok).toBe(true);
      expect(wants).toContain(r.path);
    });
  }
  it('the file-system root, and .. above it', async () => {
    expect(await canonicalLossy('/')).toBe('/');
    expect(await canonicalLossy('/..')).toBe('/');
    expect(await canonicalLossy('/../..//.')).toBe('/');
    expect(await canonicalLossy('/nonexistent-top-xyz/a')).toBe('/nonexistent-top-xyz/a');
  });
});

describe('stat / lstat / readlink', () => {
  it('stat follows links, lstat does not', async () => {
    expect(await one({ op: 'stat', path: `${root}/ld` })).toMatchObject({ ok: true, kind: 'dir' });
    expect(await one({ op: 'lstat', path: `${root}/ld` })).toMatchObject({ ok: true, kind: 'symlink' });
    expect(await one({ op: 'stat', path: `${root}/a/f.txt` })).toEqual({ ok: true, kind: 'file', size: 1, exec: false });
    expect(await one({ op: 'lstat', path: `${root}/a/f.txt` })).toEqual({ ok: true, kind: 'file', size: 1, exec: false });
  });
  it('dangling links and loops: stat fails, lstat works', async () => {
    expect(await one({ op: 'stat', path: `${root}/dangling` })).toEqual({ ok: false });
    expect(await one({ op: 'stat', path: `${root}/loopa` })).toEqual({ ok: false });
    expect(await one({ op: 'lstat', path: `${root}/dangling` })).toMatchObject({ ok: true, kind: 'symlink' });
  });
  it('exec means any execute bit', async () => {
    const f = path.join(root, 'tool.sh');
    writeFileSync(f, '#!/bin/sh\n', { mode: 0o710 });
    expect(await one({ op: 'stat', path: f })).toMatchObject({ kind: 'file', exec: true });
    expect(await one({ op: 'stat', path: `${root}/a` })).toMatchObject({ kind: 'dir', exec: true });
  });
  it('a FIFO is "other"', async () => {
    const f = path.join(root, 'fifo-stat');
    execFileSync('mkfifo', [f]);
    expect(await one({ op: 'lstat', path: f })).toMatchObject({ ok: true, kind: 'other' });
  });
  it('readlink returns the raw text', async () => {
    expect(await one({ op: 'readlink', path: `${root}/dd` })).toEqual({ ok: true, target: 'a/b/..' });
    expect(await one({ op: 'readlink', path: `${root}/abslink` })).toEqual({ ok: true, target: `${root}/a/b` });
    expect(await one({ op: 'readlink', path: `${root}/a` })).toEqual({ ok: false });
    expect(await one({ op: 'readlink', path: `${root}/nope` })).toEqual({ ok: false });
  });
});

describe('readdir', () => {
  it('lists names with the lstat kind, sorted', async () => {
    const d = path.join(root, 'rd');
    mkdirSync(path.join(d, 'sub'), { recursive: true });
    writeFileSync(path.join(d, 'b.txt'), '');
    symlinkSync('b.txt', path.join(d, 'a-link'));
    execFileSync('mkfifo', [path.join(d, 'z-fifo')]);
    expect(await one({ op: 'readdir', path: d })).toEqual({ ok: true, truncated: false, entries: [
      { name: 'a-link', kind: 'symlink' }, { name: 'b.txt', kind: 'file' }, { name: 'sub', kind: 'dir' }, { name: 'z-fifo', kind: 'other' },
    ] });
  });
  it('truncates at max and says so; max 0 or junk means 1 / the default', async () => {
    const d = path.join(root, 'many');
    mkdirSync(d);
    for (let i = 0; i < 12; i++) writeFileSync(path.join(d, `f${i}`), '');
    const r = await one({ op: 'readdir', path: d, max: 5 });
    expect(r.entries).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect((await one({ op: 'readdir', path: d, max: 12 })).truncated).toBe(false);
    expect((await one({ op: 'readdir', path: d, max: 0 })).entries).toHaveLength(1);
    expect((await one({ op: 'readdir', path: d, max: 'x' })).entries).toHaveLength(12);
  });
  it('a file or a missing directory fails; a link to a directory is followed (the path asked for)', async () => {
    expect(await one({ op: 'readdir', path: `${root}/a/f.txt` })).toEqual({ ok: false });
    expect(await one({ op: 'readdir', path: `${root}/nope` })).toEqual({ ok: false });
    expect((await one({ op: 'readdir', path: `${root}/ld` })).entries.map((e: any) => e.name)).toContain('c.txt');
  });
  it('does not recurse', async () => {
    const r = await one({ op: 'readdir', path: `${root}/a` });
    expect(r.entries.map((e: any) => e.name)).toEqual(['b', 'f.txt']);
  });
});

describe('read', () => {
  const file = (name: string, data: string | Buffer) => { const p = path.join(root, name); writeFileSync(p, data); return p; };
  it('returns utf8 text (BOM and multibyte kept)', async () => {
    expect(await one({ op: 'read', path: file('t1', 'héllo\n日本') })).toEqual({ ok: true, text: 'héllo\n日本' });
    expect(await one({ op: 'read', path: file('t2', '﻿x') })).toEqual({ ok: true, text: '﻿x' });
    expect(await one({ op: 'read', path: file('t3', '') })).toEqual({ ok: true, text: '' });
  });
  it('follows a link to a regular file', async () => {
    file('t4', 'via link');
    symlinkSync('t4', path.join(root, 't4-link'));
    expect(await one({ op: 'read', path: `${root}/t4-link` })).toEqual({ ok: true, text: 'via link' });
  });
  it('binary: a NUL byte or invalid utf8', async () => {
    expect(await one({ op: 'read', path: file('b1', Buffer.from([0x41, 0, 0x42])) })).toEqual({ ok: false, code: 'binary' });
    expect(await one({ op: 'read', path: file('b2', Buffer.from([0xff, 0xfe, 0x41])) })).toEqual({ ok: false, code: 'binary' });
  });
  it('toobig: over max, and the default cap is 262144', async () => {
    expect(await one({ op: 'read', path: file('s1', 'abcdef'), max: 5 })).toEqual({ ok: false, code: 'toobig' });
    expect(await one({ op: 'read', path: file('s2', 'abcde'), max: 5 })).toEqual({ ok: true, text: 'abcde' });
    const big = file('s3', Buffer.alloc(262_145, 0x61));
    expect(await one({ op: 'read', path: big })).toEqual({ ok: false, code: 'toobig' });
    expect((await one({ op: 'read', path: big, max: 300_000 })).ok).toBe(true);
  });
  it('a huge file is refused by its size, without reading it; the hard cap is 1 MiB', async () => {
    const p = path.join(root, 'sparse');
    execFileSync('truncate', ['-s', '5G', p]);
    expect(await one({ op: 'read', path: p, max: 99_999_999 })).toEqual({ ok: false, code: 'toobig' });
    const edge = file('edge', Buffer.alloc(READ_HARD, 0x62));
    expect((await one({ op: 'read', path: edge, max: 99_999_999 })).text).toHaveLength(READ_HARD);
    expect(await one({ op: 'read', path: file('edge2', Buffer.alloc(READ_HARD + 1, 0x62)), max: 99_999_999 })).toEqual({ ok: false, code: 'toobig' });
  });
  it('a directory, a FIFO and a device are notfile (and a FIFO never blocks)', async () => {
    expect(await one({ op: 'read', path: `${root}/a` })).toEqual({ ok: false, code: 'notfile' });
    const f = path.join(root, 'fifo-read');
    execFileSync('mkfifo', [f]);
    expect(await one({ op: 'read', path: f })).toEqual({ ok: false, code: 'notfile' });
    expect(await one({ op: 'read', path: '/dev/null' })).toEqual({ ok: false, code: 'notfile' });
  });
  it('missing, dangling and looping paths are io', async () => {
    for (const n of ['nope', 'dangling', 'loopa']) expect(await one({ op: 'read', path: `${root}/${n}` })).toEqual({ ok: false, code: 'io' });
  });
  it('the reply of one request is bounded', async () => {
    const f = file('rb', Buffer.alloc(READ_HARD, 0x63));
    const r = await q(...Array.from({ length: MAX_OPS }, () => ({ op: 'read', path: f, max: READ_HARD })));
    const ok = r.results.filter((x) => x.ok).length;
    expect(ok).toBe(Math.floor(REPLY_BUDGET / READ_HARD));
    expect(r.results.at(-1)).toEqual({ ok: false, code: 'budget' });
  });
});

describe('request shape', () => {
  it('results come back in order, one per op, and a failing op does not fail the request', async () => {
    const r = await q({ op: 'stat', path: `${root}/a` }, { op: 'stat', path: `${root}/nope` }, { op: 'canonical', path: `${root}/ld` });
    expect(r.results).toHaveLength(3);
    expect(r.results.map((x) => x.ok)).toEqual([true, false, true]);
  });
  it('1..64 ops, an array, else bad_request', async () => {
    for (const body of [null, undefined, {}, { ops: 'x' }, { ops: [] }, { ops: Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'stat', path: '/' })) }, 5]) {
      expect(await fsQuery(body)).toMatchObject({ error: 'bad_request' });
    }
    expect(((await q(...Array.from({ length: MAX_OPS }, () => ({ op: 'stat', path: '/' })))).results)).toHaveLength(MAX_OPS);
  });
  it('invalid ops and paths fail only themselves', async () => {
    const long = `/${'a'.repeat(4096)}`;
    const ok4096 = `/${'a'.repeat(4095)}`;
    const r = await q(
      null, 7, 'stat', {}, { op: 'stat' }, { op: 'stat', path: 5 }, { op: 'stat', path: 'relative/x' }, { op: 'stat', path: '' }, { op: 'stat', path: '~/x' },
      { op: 'stat', path: '/a\0b' }, { op: 'stat', path: long }, { op: 'nope', path: '/' }, { op: 'write', path: '/x' }, { op: 'canonical', path: '../x' },
      { op: 'canonical', path: ok4096 },
    );
    expect(r.results.slice(0, 14)).toEqual(Array.from({ length: 14 }, () => ({ ok: false, code: 'invalid' })));
    expect(r.results[14]).toEqual({ ok: true, path: ok4096 });
  });
  it('never writes: an unknown write-like op does nothing', async () => {
    await q({ op: 'write', path: `${root}/w.txt`, text: 'x' }, { op: 'mkdir', path: `${root}/wd` }, { op: 'unlink', path: `${root}/a/f.txt` });
    expect(await one({ op: 'stat', path: `${root}/w.txt` })).toEqual({ ok: false });
    expect(await one({ op: 'stat', path: `${root}/a/f.txt` })).toMatchObject({ ok: true });
  });
});

describe('registered on the protocol', () => {
  it('answers fs/query requests with the results as the reply body', async () => {
    const out: any[] = [];
    const c = new ProtocolClient({ write: (l) => out.push(JSON.parse(l)) });
    registerFsQuery(c);
    c.receive(JSON.stringify({ v: 1, id: 9, type: 'fs/query', body: { ops: [{ op: 'canonical', path: `${root}/ld` }] } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(out.find((m) => m.type === 'reply' && m.id === 9)?.body).toEqual({ results: [{ ok: true, path: `${real}/a/b` }] });
    c.close();
  });
});
