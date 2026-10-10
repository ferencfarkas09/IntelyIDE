// The Agent SDK installer program ((design notes: release-packaging-spec) 5.5, task PK10; gate G1).
//
//   node sdk-install.js [--plan | --yes] [--uninstall --yes]
//
// It installs the pinned, user-owned copy of the proprietary Claude Agent SDK into `<home>/Library/Application Support/IntelyIDE/sdk`
// (Linux: `<home>/.local/share/IntelyIDE/sdk`)
// WITHOUT npm: the lock in `sdk-pin/package-lock.json` gives a URL and a sha512 per tarball, `sdk-pin/tree.sha256` the file-by-file
// manifest of the finished tree. Nothing downloaded is ever executed (no lifecycle scripts), nothing is parsed before its sha512
// matches, and the finished tree must equal the manifest exactly (the same `treeLines` the loader in sdk.ts uses) before it is
// moved into place. It runs on the bundled Node, uses only Node built-ins, and has no registry, path or hash override in the
// CLI; tests use the programmatic `installSdk` options. Output is JSON lines on stdout (progress, then one final `result` line).
//
// Defence in depth, not a security boundary: the CLI re-executes itself under Node's permission model (read: this script, the pin
// and the state directory; write: the state directory only; no child processes, workers or addons). The network is not restricted
// by the model in Node 24.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as FS, realpathSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, statfs, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { redact } from './redact.js';
import { parseManifest, SDK_NAME, SDK_PIN, stateDirOf as platformStateDir, treeLines } from './sdk.js';

/** The only registry the CLI talks to. */
export const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const STATE_DIR_NAME = 'IntelyIDE';
const MiB = 1024 * 1024;

export interface Limits {
  /** Compressed bytes per tarball. */
  maxCompressed: number;
  /** Decompressed bytes per tarball. */
  maxUnpacked: number;
  /** Decompressed bytes over all tarballs (kept equal to MAX_BYTES of sdk.ts, a test checks it). */
  maxTotal: number;
  /** Entries over all tarballs (kept equal to MAX_ENTRIES of sdk.ts, a test checks it). */
  maxEntries: number;
  /** Whole run, milliseconds. */
  timeoutMs: number;
  /** No response or no new byte for this long ends a download (undici retries a proxy that drops connections for as long as it is allowed to). */
  idleMs: number;
}
export const DEFAULT_LIMITS: Limits = { maxCompressed: 64 * MiB, maxUnpacked: 64 * MiB, maxTotal: 256 * MiB, maxEntries: 40_000, timeoutMs: 5 * 60_000, idleMs: 30_000 };
/** Free space required before anything is created: 1.5x the conservative unpacked-size cap. */
const FREE_FACTOR = 1.5;
const STALE_TMP_MS = 60 * 60_000;

export type InstallErrorCode =
  | 'env_unsafe' | 'usage' | 'plan_invalid' | 'state_unsafe' | 'busy' | 'disk' | 'network' | 'sdk_unverified' | 'cancelled' | 'internal';

export class InstallError extends Error {
  constructor(readonly code: InstallErrorCode, detail: string) { super(detail); this.name = 'InstallError'; }
}

export interface LockPackage { key: string; name: string; version: string; resolved: string; integrity: string }

export interface SdkPlan {
  version: string;
  packages: LockPackage[];
  /** Optional entries of the lock that are never installed (the platform binaries). */
  skippedOptional: number;
  hosts: string[];
  /** sha256 of each pin file as read, for the confirm-first plan id of the app. */
  pin: { 'package.json': string; 'package-lock.json': string; 'tree.sha256': string; files: number };
  finalDir: string;
  stagingDir: string;
  stateDir: string;
}

export type ProgressEvent =
  | { phase: 'download'; done: number; total: number }
  | { phase: 'verify' } | { phase: 'install' };

export interface InstallOptions {
  /** Home directory (tests). Production: os.homedir(). */
  home?: string;
  /** Platform that picks the state directory (tests). Production: process.platform. */
  platform?: NodeJS.Platform;
  /** Directory holding package.json, package-lock.json, tree.sha256 (Resources/sdk-pin). */
  pinDir: string;
  /** Tests only: a loopback origin standing in for the registry. Anything else than the real registry or a loopback address is refused. */
  registryOrigin?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  log?: (event: ProgressEvent) => void;
  /** Environment to check for refused variables (default process.env). */
  env?: NodeJS.ProcessEnv;
  limits?: Partial<Limits>;
  /** Tests: process id used for the staging and lock names. */
  pid?: number;
  /** Tests: free bytes on the state volume. */
  freeBytes?: () => Promise<number>;
  /** Tests: the SDK version this build accepts (default SDK_PIN). */
  expectedVersion?: string;
}

export interface InstallResult { version: string; files: number; ms: number; packages: number }

// ---------------------------------------------------------------------------------------------------------------------
// masking, environment

const code = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/** Every output line goes through this: home paths become `~`, proxy URLs and anything secret-shaped are masked. */
export function makeScrub(homes: string[], env: NodeJS.ProcessEnv): (s: string) => string {
  const proxies = PROXY_VARS.map((k) => env[k]).filter((v): v is string => typeof v === 'string' && v.length > 3);
  const roots = [...new Set(homes.filter((h) => h.length > 1))].sort((a, b) => b.length - a.length);
  return (s: string) => {
    let t = s;
    for (const p of proxies) t = t.split(p).join('<proxy>');
    for (const h of roots) t = t.split(h).join('~');
    return redact(t);
  };
}

/** Step 0: variables that can redirect or reconfigure the installer through the environment (NODE_TLS_REJECT_UNAUTHORIZED is an addition). */
export function unsafeEnv(env: NodeJS.ProcessEnv): string | null {
  for (const k of Object.keys(env)) {
    if (k === 'NODE_OPTIONS' || k === 'NODE_PATH' || k === 'NODE_TLS_REJECT_UNAUTHORIZED' || /^npm_config_/i.test(k)) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// the plan: the lock, URL validation

const KEY_RE = /^node_modules\/(?:(?:@[A-Za-z0-9~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~][A-Za-z0-9._~-]*\/node_modules\/)*(?:@[A-Za-z0-9~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~][A-Za-z0-9._~-]*$/;
const NAME_RE = /^(?:@[A-Za-z0-9~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~][A-Za-z0-9._~-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
/** The shape step 1 demands of every `resolved` path (the exact name/version form below is stricter still). */
const PATH_SHAPE = /^\/(@[^/]+\/)?[^/]+\/-\/[^/]+\.tgz$/;

export interface Origin { protocol: string; hostname: string; port: string }
const parseOrigin = (o: string): Origin => { const u = new URL(o); return { protocol: u.protocol, hostname: u.hostname, port: u.port }; };
const PRODUCTION = parseOrigin(REGISTRY_ORIGIN);

/** Returns the reason a `resolved` value is refused, or null. Pure: no network. */
export function resolvedProblem(resolved: unknown, name: string, version: string, origin: Origin = PRODUCTION): string | null {
  if (typeof resolved !== 'string' || resolved.length > 512) return 'resolved is missing or too long';
  let u: URL;
  try { u = new URL(resolved); } catch { return 'resolved is not a URL'; }
  if (u.protocol !== origin.protocol) return `resolved must use ${origin.protocol.replace(':', '')}`;
  if (u.hostname !== origin.hostname) return 'resolved is not on the registry host';
  if (u.port !== origin.port) return 'resolved has an unexpected port';
  if (u.username !== '' || u.password !== '') return 'resolved carries user information';
  if (u.search !== '' || u.hash !== '') return 'resolved has a query or fragment';
  if (u.href !== resolved) return 'resolved is not in canonical form';
  if (!PATH_SHAPE.test(u.pathname)) return 'resolved does not have the registry tarball path shape';
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (u.pathname !== `/${name}/-/${base}-${version}.tgz`) return 'resolved does not belong to the package and version of its lock entry';
  return null;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Reads and validates the pin. Throws InstallError('plan_invalid'). No network, no state directory access. */
export async function readLockPlan(pinDir: string, origin: Origin = PRODUCTION): Promise<{
  packages: LockPackage[]; skippedOptional: number; version: string; pin: SdkPlan['pin'];
}> {
  const invalid = (d: string) => new InstallError('plan_invalid', d);
  const read = async (f: string): Promise<Buffer> => {
    try {
      const p = path.join(pinDir, f);
      if (!(await lstat(p)).isFile()) throw invalid(`${f} of the pin is not a regular file`);
      return await readFile(p);
    } catch (e) { if (e instanceof InstallError) throw e; throw invalid(`the pin file ${f} cannot be read`); }
  };
  const [pkgText, lockText, treeText] = await Promise.all([read('package.json'), read('package-lock.json'), read('tree.sha256')]);
  let lock: { lockfileVersion?: unknown; packages?: Record<string, Record<string, unknown>> };
  try { lock = JSON.parse(lockText.toString('utf8')); } catch { throw invalid('the pin lock is not valid JSON'); }
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object' || !lock.packages['']) throw invalid('the pin lock is not an npm lockfile v3');
  let manifestSize: number;
  try { manifestSize = parseManifest(treeText.toString('utf8')).size; } catch (e) { throw invalid(String((e as Error).message)); }

  const packages: LockPackage[] = [];
  let skippedOptional = 0;
  for (const [key, e] of Object.entries(lock.packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (key === '') continue;
    if (!KEY_RE.test(key) || key.length > 512) throw invalid('a lock entry has an unusable path');
    if (e.optional === true) { skippedOptional++; continue; }
    if (e.link === true || e.inBundle === true || e.bundled === true) throw invalid(`lock entry ${key} is a link or a bundled package`);
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!NAME_RE.test(name)) throw invalid(`lock entry ${key} has an unusable name`);
    if (e.name !== undefined && e.name !== name) throw invalid(`lock entry ${key} is an alias (not supported)`);
    const { version, resolved, integrity } = e as { version?: unknown; resolved?: unknown; integrity?: unknown };
    if (typeof version !== 'string' || !VERSION_RE.test(version)) throw invalid(`lock entry ${key} has an unusable version`);
    if (typeof integrity !== 'string' || !INTEGRITY_RE.test(integrity)) throw invalid(`lock entry ${key} needs a sha512 integrity (and nothing else)`);
    const problem = resolvedProblem(resolved, name, version, origin);
    if (problem) throw invalid(`lock entry ${key}: ${problem}`);
    packages.push({ key, name, version, resolved: resolved as string, integrity });
  }
  if (packages.length === 0) throw invalid('the pin lock lists no package');
  const sdk = packages.find((p) => p.key === `node_modules/${SDK_NAME}`);
  if (!sdk) throw invalid(`the pin lock does not contain ${SDK_NAME}`);
  return { packages, skippedOptional, version: sdk.version, pin: { 'package.json': sha256(pkgText), 'package-lock.json': sha256(lockText), 'tree.sha256': sha256(treeText), files: manifestSize } };
}

// ---------------------------------------------------------------------------------------------------------------------
// the tar reader (ustar plus the two pax records we accept)

export interface TarEntry { path: string; dir: boolean; exec: boolean; data: Buffer }

const bad = (d: string) => new InstallError('sdk_unverified', d);
const CONTROL = /[\u0000-\u001f\u007f]/;

function octal(field: Buffer, what: string): number {
  const s = field.toString('latin1').replace(/\0.*$/s, '').trim();
  if (s === '') return 0;
  if (!/^[0-7]{1,12}$/.test(s)) throw bad(`malformed tar header (${what})`);
  return parseInt(s, 8);
}

/** The bytes up to the first NUL, decoded as strict UTF-8. */
function cstring(field: Buffer): string {
  const nul = field.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(nul < 0 ? field : field.subarray(0, nul));
}

/** Validates a tar member name and returns the path below `package/` ('' for the root directory entry). */
export function entryPath(raw: string, dir: boolean): string {
  if (raw.length === 0 || Buffer.byteLength(raw) > 1024) throw bad('a tar entry has an unusable name');
  if (CONTROL.test(raw) || raw.includes('\\')) throw bad('a tar entry name contains a control character or a backslash');
  let name = raw;
  if (name.endsWith('/')) { if (!dir) throw bad('a file entry name ends with a slash'); name = name.slice(0, -1); }
  if (name === 'package') return '';
  if (!name.startsWith('package/')) throw bad('a tar entry lies outside package/');
  const rel = name.slice('package/'.length);
  for (const part of rel.split('/')) {
    if (part === '' || part === '.' || part === '..') throw bad('a tar entry name has an empty, "." or ".." component');
    if (Buffer.byteLength(part) > 255) throw bad('a tar entry name component is too long');
  }
  return rel;
}

function parsePax(data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  const dec = new TextDecoder('utf-8', { fatal: true });
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) throw bad('malformed pax record');
    const len = data.toString('latin1', i, sp);
    if (!/^[1-9]\d{0,6}$/.test(len)) throw bad('malformed pax record length');
    const end = i + Number(len);
    if (end > data.length || end <= sp + 1 || data[end - 1] !== 0x0a) throw bad('malformed pax record length');
    let rec: string;
    try { rec = dec.decode(data.subarray(sp + 1, end - 1)); } catch { throw bad('a pax record is not valid UTF-8'); }
    const eq = rec.indexOf('=');
    if (eq < 1) throw bad('malformed pax record');
    const key = rec.slice(0, eq), value = rec.slice(eq + 1);
    if (key === 'path') { if (out.path !== undefined) throw bad('duplicate pax path record'); out.path = value; }
    else if (key === 'size') {
      if (out.size !== undefined || !/^\d{1,15}$/.test(value)) throw bad('malformed pax size record');
      out.size = Number(value);
    } else throw bad('unsupported pax record'); // linkpath, mtime, uid, ... : not accepted, the reader stays minimal
    i = end;
  }
  return out;
}

/**
 * Minimal ustar/pax reader. Accepts regular files and directories below `package/` only; every other typeflag (links, devices,
 * FIFOs, GNU long-name records, global pax headers) is refused, as are names with `..`, absolute or control characters,
 * duplicates after NFC normalisation and case folding (APFS is case-insensitive), and entry counts above `maxEntries`.
 */
export function* readTar(buf: Buffer, opts: { maxEntries: number; maxFile: number }): Generator<TarEntry> {
  const seen = new Map<string, 'file' | 'dir'>();
  const implicit = new Set<string>();
  const fold = (p: string) => p.normalize('NFC').toLowerCase();
  let off = 0;
  let count = 0;
  let pax: { path?: string; size?: number } | null = null;
  while (true) {
    if (off + 512 > buf.length) {
      if (off === buf.length && pax === null) return; // an archive without end blocks: tolerated, nothing follows
      throw bad('truncated tar archive');
    }
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      if (pax !== null) throw bad('a pax header is not followed by an entry');
      for (let i = off; i < buf.length; i++) if (buf[i] !== 0) throw bad('data after the end of the tar archive');
      return;
    }
    const stored = octal(h.subarray(148, 156), 'checksum');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== stored) throw bad('tar header checksum mismatch');
    if (++count > opts.maxEntries) throw bad('too many entries in an archive');
    const magic = h.toString('latin1', 257, 265);
    const posix = magic === 'ustar\u000000';
    if (!posix && magic !== 'ustar  \u0000') throw bad('unsupported tar format');
    const flag = h[156]!;
    if (h[124]! & 0x80) throw bad('unsupported tar size encoding');
    const hsize = octal(h.subarray(124, 136), 'size');
    if (flag === 0x78 /* x */) {
      if (pax !== null) throw bad('two pax headers in a row');
      if (hsize > 64 * 1024) throw bad('a pax header is too large');
      if (off + 512 + hsize > buf.length) throw bad('truncated tar archive');
      pax = parsePax(buf.subarray(off + 512, off + 512 + hsize));
      off += 512 + Math.ceil(hsize / 512) * 512;
      continue;
    }
    const isFile = flag === 0 || flag === 0x30, isDir = flag === 0x35;
    if (!isFile && !isDir) throw bad(`unsupported tar entry type ${JSON.stringify(String.fromCharCode(flag))} (links, devices and long-name records are refused)`);
    const size = pax?.size ?? hsize;
    if (size > opts.maxFile) throw bad('a file in an archive is larger than the cap');
    if (isDir && size !== 0) throw bad('a directory entry has data');
    let rawName: string;
    try {
      const prefix = posix ? cstring(h.subarray(345, 500)) : '';
      const name = cstring(h.subarray(0, 100));
      rawName = pax?.path ?? (prefix ? `${prefix}/${name}` : name);
    } catch { throw bad('a tar entry name is not valid UTF-8'); }
    pax = null;
    const rel = entryPath(rawName, isDir);
    const bodyStart = off + 512;
    if (bodyStart + size > buf.length) throw bad('truncated tar archive');
    const data = buf.subarray(bodyStart, bodyStart + size);
    off = bodyStart + Math.ceil(size / 512) * 512;
    if (rel === '') continue; // the package/ root itself
    // duplicates and file/directory conflicts, on the folded name
    const parts = rel.split('/');
    const key = fold(rel);
    for (let i = 1; i < parts.length; i++) {
      const anc = fold(parts.slice(0, i).join('/'));
      if (seen.get(anc) === 'file') throw bad('a tar entry lies below a file');
      implicit.add(anc);
    }
    if (seen.has(key)) throw bad('duplicate tar entry (names are compared case-insensitively and after Unicode normalisation)');
    if (isFile && implicit.has(key)) throw bad('a file entry has the name of a directory');
    seen.set(key, isFile ? 'file' : 'dir');
    yield { path: rel, dir: isDir, exec: (octal(h.subarray(100, 108), 'mode') & 0o111) !== 0, data };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// state directory, lock, staging, atomic replace

const gunzip = promisify(zlib.gunzip) as (b: Buffer, o: zlib.ZlibOptions) => Promise<Buffer>;

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return code(e) === 'EPERM'; }
};

async function homeOf(home: string | undefined): Promise<string> {
  const h = home ?? os.homedir();
  if (!h || !path.isAbsolute(h)) throw new InstallError('state_unsafe', 'the home directory is not an absolute path');
  try { return await realpath(h); } catch (e) {
    // inside the permission sandbox the launcher already passed the real path; a missing home only matters when something is created (ensureStateDir)
    if (code(e) === 'ERR_ACCESS_DENIED' || code(e) === 'ENOENT') return path.resolve(h);
    throw new InstallError('state_unsafe', 'the home directory cannot be resolved');
  }
}
/** Same function as the loader's (one definition in sdk.ts): macOS `<home>/Library/Application Support/IntelyIDE`, Linux `<home>/.local/share/IntelyIDE`. */
export const stateDirOf = (home: string, platform: NodeJS.Platform = process.platform) => platformStateDir(home, platform);

/** Creates the state directory (mode 0700) when it is missing. Used by the launcher and by the installer. */
async function ensureStateDir(stateDir: string): Promise<void> {
  try { await lstat(stateDir); return; } catch (e) { if (code(e) !== 'ENOENT') throw new InstallError('state_unsafe', 'the state directory cannot be inspected'); }
  const home = path.dirname(path.dirname(path.dirname(stateDir)));
  if (!(await lstat(home).then((s) => s.isDirectory(), () => false))) throw new InstallError('state_unsafe', 'the home directory does not exist');
  try {
    await mkdir(path.dirname(stateDir), { recursive: true });
    await mkdir(stateDir, { mode: 0o700 });
  } catch (e) { if (code(e) !== 'EEXIST') throw new InstallError('disk', `cannot create the state directory (${code(e) ?? 'error'})`); }
}

async function checkStateDir(stateDir: string): Promise<void> {
  const st = await lstat(stateDir).catch(() => { throw new InstallError('state_unsafe', 'the state directory is missing'); });
  if (st.isSymbolicLink() || !st.isDirectory()) throw new InstallError('state_unsafe', 'the state directory is not a plain directory');
  if (uid() < 0) throw new InstallError('state_unsafe', 'cannot check file ownership on this platform');
  if (st.uid !== uid()) throw new InstallError('state_unsafe', 'the state directory is not owned by the current user');
  if ((st.mode & 0o022) !== 0) throw new InstallError('state_unsafe', 'the state directory is writable by group or others (run chmod go-w on it)');
}

async function makeWritable(p: string): Promise<void> {
  const st = await lstat(p).catch(() => null);
  if (!st || !st.isDirectory()) return;
  await chmod(p, (st.mode & 0o7777) | 0o700);
  for (const e of await readdir(p, { withFileTypes: true })) if (e.isDirectory()) await makeWritable(path.join(p, e.name));
}
/** Removes a file, a symlink (never followed) or a tree whose directories may have lost their write bit. */
async function forceRemove(p: string): Promise<void> {
  const st = await lstat(p).catch(() => null);
  if (!st) return;
  if (st.isDirectory()) await makeWritable(p);
  await rm(p, { recursive: true, force: true });
}
/** Final modes: files 0444 (0555 when executable), directories 0555, the root 0700 so that it can be renamed and removed. */
async function lockDown(root: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); await chmod(p, 0o555); } else if (e.isFile()) {
        await chmod(p, (await lstat(p)).mode & 0o111 ? 0o555 : 0o444);
      } else throw bad('unexpected entry in the staging tree');
    }
  };
  await walk(root);
  await chmod(root, 0o700);
}

export interface RepairReport { restored: boolean; removed: string[] }
/** Crash repair (5.5 step 7): restore `sdk.old-*` when `sdk` is missing, drop leftovers and stale `sdk.tmp-*` of dead processes older than 1 h. */
export async function repairSdkState(stateDir: string, now = Date.now()): Promise<RepairReport> {
  const report: RepairReport = { restored: false, removed: [] };
  const names = await readdir(stateDir).catch(() => [] as string[]);
  const sdk = path.join(stateDir, 'sdk');
  const hasSdk = await lstat(sdk).then(() => true, () => false);
  const olds = names.filter((n) => /^sdk\.old-\d+$/.test(n)).sort();
  if (!hasSdk && olds.length > 0) { await rename(path.join(stateDir, olds[olds.length - 1]!), sdk); report.restored = true; olds.pop(); }
  for (const n of olds) { await forceRemove(path.join(stateDir, n)); report.removed.push(n); }
  for (const n of names) {
    const m = /^sdk\.tmp-(\d+)$/.exec(n);
    if (!m) continue;
    const st = await lstat(path.join(stateDir, n)).catch(() => null);
    if (st && now - st.mtimeMs > STALE_TMP_MS && !alive(Number(m[1]))) { await forceRemove(path.join(stateDir, n)); report.removed.push(n); }
  }
  return report;
}

/** Single-flight lock `sdk.lock` (O_EXCL, holds the pid). A lock whose process is gone is taken over. Returns the release function. */
async function acquireLock(stateDir: string, pid: number): Promise<() => Promise<void>> {
  const file = path.join(stateDir, 'sdk.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
      await fh.writeFile(`${pid}\n`);
      await fh.close();
      return async () => { await unlink(file).catch(() => undefined); };
    } catch (e) {
      if (code(e) !== 'EEXIST') throw new InstallError('disk', `cannot create the lock file (${code(e) ?? 'error'})`);
    }
    const st = await lstat(file).catch(() => null);
    if (!st) continue; // vanished meanwhile: try again
    const text = st.isFile() ? await readFile(file, 'utf8').catch(() => '') : '';
    const holder = /^(\d{1,10})\n?$/.exec(text)?.[1];
    const fresh = Date.now() - st.mtimeMs < 10_000;
    if ((holder !== undefined && alive(Number(holder))) || (holder === undefined && fresh)) throw new InstallError('busy', 'another SDK installation is running');
    // stale: move it away atomically (a rename has one winner), then try to create ours
    const grave = `${file}.stale-${pid}`;
    await rename(file, grave).catch(() => undefined);
    await unlink(grave).catch(() => undefined);
  }
  throw new InstallError('busy', 'another SDK installation is running');
}

// ---------------------------------------------------------------------------------------------------------------------
// download

function abortError(signal: AbortSignal): InstallError {
  const r = signal.reason as { name?: string } | undefined;
  return r?.name === 'TimeoutError' ? new InstallError('network', 'timed out') : new InstallError('cancelled', 'cancelled');
}

async function download(p: LockPackage, o: { fetchImpl: typeof fetch; signal: AbortSignal; maxCompressed: number; idleMs: number }): Promise<Buffer> {
  const idle = new AbortController();
  const signal = AbortSignal.any([o.signal, idle.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException('stalled', 'TimeoutError')), o.idleMs); };
  arm();
  try {
    let res: Response;
    try {
      res = await o.fetchImpl(p.resolved, { redirect: 'error', signal, credentials: 'omit', headers: { accept: 'application/octet-stream' } });
    } catch (e) {
      if (signal.aborted) throw abortError(signal);
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      throw new InstallError('network', `cannot download ${p.name} (${cause?.code ?? cause?.message ?? (e as Error)?.message ?? 'error'})`);
    }
    arm();
    const drop = () => res.body?.cancel().catch(() => undefined);
    if (res.status !== 200) { await drop(); throw new InstallError('network', `the registry answered ${res.status} for ${p.name}`); }
    const enc = res.headers.get('content-encoding');
    if (enc && enc.toLowerCase() !== 'identity') { await drop(); throw bad(`unexpected content-encoding for ${p.name}`); }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > o.maxCompressed) { await drop(); throw bad(`the download of ${p.name} is larger than the cap`); }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      const reader = res.body?.getReader();
      if (!reader) throw new InstallError('network', `empty response for ${p.name}`);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        total += value.length;
        if (total > o.maxCompressed) { await reader.cancel().catch(() => undefined); throw bad(`the download of ${p.name} is larger than the cap`); }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } catch (e) {
      if (e instanceof InstallError) throw e;
      if (signal.aborted) throw abortError(signal);
      throw new InstallError('network', `the download of ${p.name} was interrupted (${(e as Error)?.message ?? 'error'})`);
    }
    return Buffer.concat(chunks, total);
  } finally { clearTimeout(timer); }
}

function integrityMatches(bytes: Buffer, integrity: string): boolean {
  const got = createHash('sha512').update(bytes).digest();
  const want = Buffer.from(integrity.slice('sha512-'.length), 'base64');
  return want.length === got.length && timingSafeEqual(got, want);
}

/** The tarball's own package.json must agree with the lock entry (name and version). */
async function checkPackageJson(base: string, p: LockPackage, present: boolean): Promise<void> {
  if (!present) throw bad(`${p.name} has no package.json`);
  let meta: { name?: unknown; version?: unknown };
  try { meta = JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8')); } catch { throw bad(`${p.name} has an unreadable package.json`); }
  if (meta.name !== p.name) throw bad(`${p.name}: the package.json names a different package`);
  if (meta.version !== p.version) throw bad(`${p.name}: the package.json has version ${String(meta.version)}, the lock says ${p.version}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// public API

export interface PlanOptions { home?: string; platform?: NodeJS.Platform; pinDir: string; registryOrigin?: string; expectedVersion?: string }

function originOf(registryOrigin: string | undefined): Origin {
  if (registryOrigin === undefined) return PRODUCTION;
  const o = parseOrigin(registryOrigin);
  const production = o.protocol === PRODUCTION.protocol && o.hostname === PRODUCTION.hostname && o.port === PRODUCTION.port;
  if (!production && !['127.0.0.1', 'localhost', '[::1]'].includes(o.hostname)) throw new InstallError('plan_invalid', 'the registry override must be a loopback address');
  return o;
}

/** Step 1: the plan. Reads the pin only: no network, nothing created. */
export async function planSdk(opts: PlanOptions): Promise<SdkPlan> {
  const home = await homeOf(opts.home);
  const lock = await readLockPlan(opts.pinDir, originOf(opts.registryOrigin));
  const expected = opts.expectedVersion ?? SDK_PIN;
  if (lock.version !== expected) throw new InstallError('plan_invalid', `the pin lock has ${SDK_NAME} ${lock.version}, this build needs exactly ${expected}`);
  const stateDir = stateDirOf(home, opts.platform);
  return {
    version: lock.version, packages: lock.packages, skippedOptional: lock.skippedOptional, pin: lock.pin,
    hosts: [...new Set(lock.packages.map((p) => new URL(p.resolved).host))],
    stateDir, finalDir: path.join(stateDir, 'sdk'), stagingDir: path.join(stateDir, 'sdk.tmp-<pid>'),
  };
}

export async function installSdk(opts: InstallOptions): Promise<InstallResult> {
  const t0 = Date.now();
  const env = opts.env ?? process.env;
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const log = opts.log ?? (() => undefined);
  const pid = opts.pid ?? process.pid;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const badEnv = unsafeEnv(env);
  if (badEnv) throw new InstallError('env_unsafe', `the environment variable ${badEnv} must not be set`);
  const plan = await planSdk(opts);
  const { stateDir, finalDir } = plan;
  const staging = path.join(stateDir, `sdk.tmp-${pid}`);

  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const check = () => { if (signal.aborted) throw abortError(signal); };
  check();

  // 2. preconditions
  await ensureStateDir(stateDir);
  await checkStateDir(stateDir);
  const free = await (opts.freeBytes ? opts.freeBytes() : statfs(stateDir).then((s) => Number(s.bavail) * Number(s.bsize)).catch(() => { throw new InstallError('disk', 'cannot determine the free disk space'); }));
  if (free < FREE_FACTOR * limits.maxTotal) throw new InstallError('disk', 'not enough free disk space (about 400 MB are needed while installing)');
  const release = await acquireLock(stateDir, pid);
  let cleanStaging = false;
  try {
    await repairSdkState(stateDir).catch(() => undefined);
    // 3. staging, 0700, with the two pin files
    check();
    try { await mkdir(staging, { mode: 0o700 }); } catch (e) { throw new InstallError('disk', `cannot create the staging directory (${code(e) ?? 'error'})`); }
    cleanStaging = true;
    for (const f of ['package.json', 'package-lock.json']) {
      await copyFile(path.join(opts.pinDir, f), path.join(staging, f), FS.COPYFILE_EXCL);
      await chmod(path.join(staging, f), 0o644);
    }
    // 4 + 5. download, sha512 first, then extract
    let entries = 0, bytes = 0, done = 0;
    for (const p of plan.packages) {
      check();
      const gz = await download(p, { fetchImpl, signal, maxCompressed: limits.maxCompressed, idleMs: limits.idleMs });
      if (!integrityMatches(gz, p.integrity)) throw bad(`the download of ${p.name} does not match the pinned sha512`);
      let tar: Buffer;
      try { tar = await gunzip(gz, { maxOutputLength: limits.maxUnpacked }); } catch (e) {
        throw bad(code(e) === 'ERR_BUFFER_TOO_LARGE' ? `${p.name} unpacks to more than the cap` : `${p.name} is not a valid gzip file`);
      }
      const base = path.join(staging, ...p.key.split('/'));
      let sawPackageJson = false;
      try {
        await mkdir(base, { recursive: true });
        for (const en of readTar(tar, { maxEntries: limits.maxEntries - entries, maxFile: limits.maxUnpacked })) {
          check();
          if (++entries > limits.maxEntries) throw bad('too many entries in total');
          bytes += en.data.length;
          if (bytes > limits.maxTotal) throw bad('the SDK is larger than the pinned tree');
          const target = path.join(base, ...en.path.split('/'));
          if (!target.startsWith(`${base}${path.sep}`)) throw bad('a tar entry would leave its package directory');
          if (en.dir) { await mkdir(target, { recursive: true }); continue; }
          await mkdir(path.dirname(target), { recursive: true });
          const fh = await open(target, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
          try { await fh.writeFile(en.data); } finally { await fh.close(); }
          // By path, not through the handle: Node 24.21 and later deny FileHandle.chmod (fchmod) under the permission model, and the
          // file was created a moment ago in the private staging directory, so the path is the file.
          await chmod(target, en.exec ? 0o755 : 0o644);
          if (en.path === 'package.json') sawPackageJson = true;
        }
        await checkPackageJson(base, p, sawPackageJson);
      } catch (e) {
        if (e instanceof InstallError) throw e;
        if (code(e) === 'EEXIST') throw bad(`${p.name} contains a path that collides with another file`);
        throw new InstallError('disk', `cannot write ${p.name} (${code(e) ?? (e as Error)?.message ?? 'error'})`);
      }
      log({ phase: 'download', done: ++done, total: plan.packages.length });
    }
    // 6. the finished tree must equal the manifest exactly
    check();
    log({ phase: 'verify' });
    const want = parseManifest(await readFile(path.join(opts.pinDir, 'tree.sha256'), 'utf8'));
    const lines = await treeLines(staging).catch((e: unknown) => { throw bad(String((e as Error)?.message ?? e)); });
    const have = new Map(lines.map((l) => [l.slice(66), l.slice(0, 64)] as const));
    for (const [rel, h] of have) {
      const w = want.get(rel);
      if (w === undefined) throw bad(`unexpected file ${rel} (not part of the pinned tree)`);
      if (w !== h) throw bad(`file ${rel} does not match the pinned tree`);
    }
    for (const rel of want.keys()) if (!have.has(rel)) throw bad(`file ${rel} of the pinned tree is missing`);
    // 7. install atomically
    check();
    log({ phase: 'install' });
    await lockDown(staging);
    const old = path.join(stateDir, `sdk.old-${pid}`);
    const existing = await lstat(finalDir).then(() => true, () => false);
    try {
      if (existing) await rename(finalDir, old);
      await rename(staging, finalDir);
      cleanStaging = false;
    } catch (e) {
      if (existing) await rename(old, finalDir).catch(() => undefined); // put the previous install back
      throw new InstallError('disk', `cannot move the new install into place (${code(e) ?? 'error'})`);
    }
    if (existing) await forceRemove(old).catch(() => undefined);
    return { version: plan.version, files: have.size, ms: Date.now() - t0, packages: plan.packages.length };
  } finally {
    if (cleanStaging) await forceRemove(staging).catch(() => undefined);
    await release();
  }
}

export async function uninstallSdk(opts: { home?: string; pid?: number }): Promise<void> {
  const home = await homeOf(opts.home);
  const stateDir = stateDirOf(home);
  if (!(await lstat(stateDir).then(() => true, () => false))) return;
  await checkStateDir(stateDir);
  const release = await acquireLock(stateDir, opts.pid ?? process.pid);
  try {
    const dir = path.join(stateDir, 'sdk');
    const s = await lstat(dir).catch(() => null);
    if (s?.isSymbolicLink()) throw new InstallError('state_unsafe', 'the SDK directory is a symbolic link; it was not touched');
    await repairSdkState(stateDir).catch(() => undefined);
    try { await forceRemove(dir); } catch (e) { throw new InstallError('disk', `cannot remove the SDK (${code(e) ?? 'error'})`); }
  } finally { await release(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI

export interface RestrictedPaths { script: string; pinDir: string; stateDir: string; home: string; env: NodeJS.ProcessEnv }

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  /** Asks the question on the terminal; resolves true on "y". */
  ask: (question: string) => Promise<boolean>;
  /** Re-executes the CLI under the permission model and resolves with its exit code. */
  runRestricted: (args: string[], paths: RestrictedPaths) => Promise<number>;
  script: string;
  signal?: AbortSignal;
}

const USAGE = 'usage: sdk-install.js [--plan | --yes] [--uninstall --yes]';

/** `restricted` is true when this process already runs under the permission model (it does the work); false: it launches that child. */
export async function runCli(argv: string[], io: CliIo, restricted: boolean): Promise<number> {
  const scrub = makeScrub([io.env.HOME ?? '', os.homedir()], io.env);
  const emit = (o: Record<string, unknown>) => io.stdout(scrub(JSON.stringify(o)));
  const fail = (e: unknown): number => {
    const ie = e instanceof InstallError ? e : new InstallError('internal', String((e as Error)?.message ?? e));
    emit({ result: 'error', code: ie.code, detail: ie.message });
    return 1;
  };
  const flags = new Set(argv);
  const uninstall = flags.has('--uninstall');
  const usage = argv.some((a) => a !== '--plan' && a !== '--yes' && a !== '--uninstall') || flags.size !== argv.length
    || (flags.has('--plan') && (flags.has('--yes') || uninstall)) || (uninstall && !flags.has('--yes'));
  if (usage) { emit({ result: 'error', code: 'usage', detail: USAGE }); return 2; }
  const unsafe = unsafeEnv(io.env);
  if (unsafe) return fail(new InstallError('env_unsafe', `the environment variable ${unsafe} must not be set; unset it and run again`));
  try {
    const home = await homeOf(io.env.HOME);
    const pinDir = path.resolve(path.dirname(io.script), '..', 'sdk-pin');
    const stateDir = stateDirOf(home);
    if (flags.has('--plan')) {
      emit({ result: 'plan', ...(await planSdk({ home, pinDir })) });
      return 0;
    }
    if (!flags.has('--yes')) {
      if (!io.isTTY) { emit({ result: 'error', code: 'usage', detail: `${USAGE}: refusing to change anything without --yes` }); return 2; }
      const plan = await planSdk({ home, pinDir });
      io.stderr(scrub(`Install ${SDK_NAME} ${plan.version} (${plan.packages.length} packages from ${plan.hosts.join(', ')}) into ${plan.finalDir}?`));
      if (!(await io.ask('Type y to continue: '))) { emit({ result: 'error', code: 'cancelled', detail: 'cancelled' }); return 1; }
    }
    const args = [...(uninstall ? ['--uninstall'] : []), '--yes'];
    if (!restricted) {
      // launcher: create the state directory (the sandbox may not), then run the same program inside the sandbox
      await ensureStateDir(stateDir);
      return await io.runRestricted(args, { script: io.script, pinDir, stateDir, home, env: io.env });
    }
    const ac = new AbortController();
    const onSignal = () => ac.abort();
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(s, onSignal);
    const signal = io.signal ? AbortSignal.any([io.signal, ac.signal]) : ac.signal;
    try {
      if (uninstall) {
        await uninstallSdk({ home });
        emit({ result: 'ok', action: 'uninstall' });
        return 0;
      }
      const r = await installSdk({ home, pinDir, signal, env: io.env, log: (ev) => emit({ ...ev }) });
      emit({ result: 'ok', version: r.version, files: r.files, ms: r.ms });
      return 0;
    } finally {
      for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(s, onSignal);
    }
  } catch (e) { return fail(e); }
}

/** The Node flags of the sandboxed re-execution. Paths containing a comma are not supported by the permission flags. */
export function sandboxFlags(p: RestrictedPaths): string[] {
  const abs = (k: string) => { const v = p.env[k]; return v && path.isAbsolute(v) ? v : null; };
  const files = ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'].map(abs).filter((v): v is string => v !== null);
  const dirs = ['SSL_CERT_DIR'].map(abs).filter((v): v is string => v !== null);
  const flags = [
    '--permission',
    `--allow-fs-read=${p.script}`,
    `--allow-fs-read=${p.pinDir}`, `--allow-fs-read=${p.pinDir}/*`,
    `--allow-fs-read=${p.stateDir}`, `--allow-fs-read=${p.stateDir}/*`,
    ...files.map((f) => `--allow-fs-read=${f}`),
    ...dirs.map((d) => `--allow-fs-read=${d}/*`),
    `--allow-fs-write=${p.stateDir}`, `--allow-fs-write=${p.stateDir}/*`,
  ];
  if (PROXY_VARS.some((k) => p.env[k])) flags.push('--use-env-proxy'); // fetch() honours HTTPS_PROXY / NO_PROXY only with this
  return flags;
}

const CHILD_ENV = new Set(['PATH', 'TMPDIR', 'LANG', 'TERM', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', ...PROXY_VARS]);
/** The sandboxed child gets an allow-list, not the caller's whole environment (no DYLD_*, LD_*, NODE_DEBUG, tokens, ...). */
export function childEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { HOME: home };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (CHILD_ENV.has(k) || k.startsWith('LC_'))) out[k] = v;
  return out;
}

/** Real process wiring: the sandboxed re-execution. */
function spawnRestricted(args: string[], p: RestrictedPaths): Promise<number> {
  const env = childEnv(p.env, p.home);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...sandboxFlags(p), p.script, ...args], { stdio: 'inherit', env });
    const sigs = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
    const handlers = sigs.map((s) => [s, () => { child.kill(s); }] as const);
    for (const [s, h] of handlers) process.on(s, h);
    const end = (c: number) => { for (const [s, h] of handlers) process.off(s, h); resolve(c); };
    child.once('error', () => end(1));
    child.once('close', (c) => end(c ?? 1));
  });
}

function realIo(script: string): CliIo {
  return {
    stdout: (l) => { process.stdout.write(`${l}\n`); },
    stderr: (l) => { process.stderr.write(`${l}\n`); },
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (q) => new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(q, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
    }),
    runRestricted: spawnRestricted,
    script,
  };
}

const scriptPath = (() => { const p = fileURLToPath(import.meta.url); try { return realpathSync(p); } catch { return p; } })();
const isMain = (() => {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === scriptPath; } catch { return false; }
})();
if (isMain) {
  // `process.permission` exists only when Node runs with --permission: that is how the sandboxed child recognises itself.
  const sandboxed = typeof (process as unknown as { permission?: unknown }).permission === 'object';
  runCli(process.argv.slice(2), realIo(scriptPath), sandboxed).then(
    (c) => { process.exitCode = c; setTimeout(() => process.exit(c), 200).unref(); },
    () => { process.exitCode = 1; },
  );
}
