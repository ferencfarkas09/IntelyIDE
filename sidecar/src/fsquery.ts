// `fs/query` (remote servers): a read-only file-system oracle for the permission broker, which runs in the IDE while the agent
// (and this sidecar) run on a server. It answers "what is at this path" so the broker judges the SERVER's paths the way it judges
// local ones. It never writes, never spawns, never recurses: every op touches one path (readdir: one directory, capped) and
// every answer is capped. Contract: docs/remote-servers.md (wire) and fixtures/fsquery/canonical-cases.json (`canonical`).
import { constants as FS } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, opendir, readlink, realpath, stat } from 'node:fs/promises';
import type { ProtocolClient } from './protocol.js';

export const MAX_OPS = 64;
export const MAX_PATH_CHARS = 4096;
export const READDIR_DEFAULT = 20_000;
export const READDIR_HARD = 100_000;
export const READ_DEFAULT = 262_144;
export const READ_HARD = 1_048_576;
/** What one request may return in total (read text + directory names): 64 maximal reads must not become one 64 MiB line. */
export const REPLY_BUDGET = 16 * 1024 * 1024;
/** Same limit as MAX_LINKS in `follow_links` (crates/agent_core/src/policy/paths.rs). */
const MAX_LINKS = 40;

export type FsOp =
  | { op: 'canonical' | 'stat' | 'lstat' | 'readlink'; path: string }
  | { op: 'readdir'; path: string; max?: number }
  | { op: 'read'; path: string; max?: number };
export type Kind = 'file' | 'dir' | 'symlink' | 'other';
export type FsResult =
  | { ok: true; path: string }
  | { ok: true; kind: Kind; size: number; exec: boolean }
  | { ok: true; target: string }
  | { ok: true; entries: { name: string; kind: Kind }[]; truncated: boolean }
  | { ok: true; text: string }
  | { ok: false; code?: 'invalid' | 'toobig' | 'binary' | 'notfile' | 'io' | 'budget' };
export type FsQueryReply = { results: FsResult[] } | { error: 'bad_request'; detail: string };

const kindOf = (s: Stats): Kind => (s.isFile() ? 'file' : s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'other');
const fail: FsResult = { ok: false };

/** Port of `follow_links` (paths.rs): a symlink (a dangling one too) is replaced by its target resolved against the link's parent, `..` goes up from the REAL directory. Gives up after 40 links and keeps the rest lexical. `abs` is absolute. */
async function followLinks(abs: string): Promise<string[]> {
  const split = (p: string): string[] => {
    const parts = p.split('/').filter((s) => s !== '' && s !== '.').reverse();
    return p.startsWith('/') ? [...parts, '/'] : parts; // a stack: the first component is last
  };
  const work = split(abs);
  let out: string[] = [];
  let links = 0;
  for (let c = work.pop(); c !== undefined; c = work.pop()) {
    if (c === '/') out = [];
    else if (c === '..') out.pop(); // above the root stays the root (the path is always absolute here)
    else {
      const cand = [...out, c];
      let target: string | null = null;
      if (links < MAX_LINKS) { try { target = await readlink(`/${cand.join('/')}`); } catch { /* not a link, or unreadable: keep the name */ } }
      if (target !== null) {
        links++;
        if (target.startsWith('/')) out = [];
        work.push(...split(target));
      } else out = cand;
    }
  }
  return out;
}

/** Port of `canonical_lossy` (paths.rs): follow the links, then realpath of the longest existing ancestor and re-append the rest. */
export async function canonicalLossy(abs: string): Promise<string> {
  const names = await followLinks(abs);
  const tail: string[] = [];
  const cur = [...names];
  for (;;) {
    try {
      const real = await realpath(`/${cur.join('/')}`);
      return tail.length ? `${real === '/' ? '' : real}/${tail.reverse().join('/')}` : real;
    } catch {
      const name = cur.pop();
      if (name === undefined) return `/${names.join('/')}`; // nothing exists, not even `/`
      tail.push(name);
    }
  }
}

const info = (s: Stats): FsResult => ({ ok: true, kind: kindOf(s), size: s.size, exec: (s.mode & 0o111) !== 0 });
const limit = (v: unknown, dflt: number, hard: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 1), hard) : dflt);

async function readdirOp(p: string, max: number, budget: { left: number }): Promise<FsResult> {
  const dir = await opendir(p);
  const entries: { name: string; kind: Kind }[] = [];
  let truncated = false;
  try {
    for await (const d of dir) { // opendir streams: a huge directory is never held whole
      if (entries.length >= max || budget.left <= 0) { truncated = true; break; }
      let kind: Kind | null = d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isFIFO() || d.isSocket() || d.isCharacterDevice() || d.isBlockDevice() ? 'other' : null;
      kind ??= await lstat(`${p}/${d.name}`).then(kindOf, () => 'other' as Kind); // filesystems without d_type
      entries.push({ name: d.name, kind });
      budget.left -= Buffer.byteLength(d.name) + 32;
    }
  } finally { await dir.close().catch(() => undefined); }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, entries, truncated };
}

async function readOp(p: string, max: number, budget: { left: number }): Promise<FsResult> {
  // O_NONBLOCK: opening a FIFO must not wait for a writer; the kind is judged on the OPENED descriptor, so nothing swapped in after a path check is read
  const fh = await open(p, FS.O_RDONLY | FS.O_NONBLOCK | FS.O_NOCTTY).catch(() => null);
  if (!fh) return { ok: false, code: 'io' };
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, code: 'notfile' };
    if (st.size > max) return { ok: false, code: 'toobig' };
    if (budget.left < max) return { ok: false, code: 'budget' };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) { // not trusting st.size (procfs says 0): read until EOF, at most max + 1 bytes
      const buf = Buffer.allocUnsafe(Math.min(65_536, max + 1 - total));
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
      if (total > max) return { ok: false, code: 'toobig' };
    }
    const data = Buffer.concat(chunks, total);
    if (data.includes(0)) return { ok: false, code: 'binary' };
    budget.left -= total;
    try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }; } catch { return { ok: false, code: 'binary' }; }
  } catch { return { ok: false, code: 'io' }; } finally { await fh.close().catch(() => undefined); }
}

async function one(raw: unknown, budget: { left: number }): Promise<FsResult> {
  const o = raw as { op?: unknown; path?: unknown; max?: unknown } | null;
  const p = o?.path;
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_CHARS || !p.startsWith('/') || p.includes('\0')) return { ok: false, code: 'invalid' };
  try {
    switch (o?.op) {
      case 'canonical': return { ok: true, path: await canonicalLossy(p) };
      case 'stat': return info(await stat(p));
      case 'lstat': return info(await lstat(p));
      case 'readlink': return { ok: true, target: await readlink(p) };
      case 'readdir': return await readdirOp(p, limit(o.max, READDIR_DEFAULT, READDIR_HARD), budget);
      case 'read': return await readOp(p, limit(o.max, READ_DEFAULT, READ_HARD), budget);
      default: return { ok: false, code: 'invalid' };
    }
  } catch { return o?.op === 'read' ? { ok: false, code: 'io' } : fail; }
}

/** The request handler. A malformed request (not 1..64 ops) is an `error`; a failing op is only its own `{ok:false}`. Ops run one after the other. */
export async function fsQuery(body: unknown): Promise<FsQueryReply> {
  const ops = (body as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_OPS) return { error: 'bad_request', detail: `ops must be an array of 1..${MAX_OPS}` };
  const budget = { left: REPLY_BUDGET };
  const results: FsResult[] = [];
  for (const op of ops) results.push(await one(op, budget));
  return { results };
}

export function registerFsQuery(proto: ProtocolClient): void { proto.on('fs/query', (b) => fsQuery(b)); }
