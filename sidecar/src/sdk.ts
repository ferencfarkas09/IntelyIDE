// Run-time loader for the proprietary Claude Agent SDK ((design notes: licensing-spec) section 6). The SDK is NOT part of the
// sidecar bundle (build.config.mjs marks it external); it is loaded from the user's own copy, and because it runs inside
// this process next to the policy hooks and the API key, nothing is imported unless it is exactly the pinned version:
//
//   source checkout  <sidecar package>/node_modules/@anthropic-ai/claude-agent-sdk (pnpm lockfile = integrity source),
//                    resolved from this file's location by explicit path, never by a bare specifier.
//   packaged build   <state dir>/sdk, derived from the home directory only: owned by the current user, not writable by
//                    group/other, not redirected by a symlink, and EVERY file hashed against sdk-pin/tree.sha256.
//
// Which of the two applies is decided by where this file lives (isPackagedPath: inside <name>.app/Contents/Resources).
// In the packaged app the source-checkout branch does not exist: a Resources/node_modules copy would be accepted after a
// version check alone, with no tree hash ((design notes: release-packaging-spec) 5.5, PK18).
//
// There is no environment variable that changes where the SDK comes from or which mode applies (the sidecar env is an
// allow-list and an env switch would be a persistence vector); tests pass `LoadOptions`. Fail closed: a missing, incompatible, unverified or
// broken SDK throws a typed error and no Claude path starts without it. Only successes are memoized.
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact } from './redact.js';

export const SDK_NAME = '@anthropic-ai/claude-agent-sdk';
/** The one accepted version (no range). Kept equal to sidecar/package.json, sdk-pin/package.json and the lock by sdk-pin.test.ts. */
export const SDK_PIN = '0.3.287';

export type SdkErrorCode = 'sdk_missing' | 'sdk_incompatible' | 'sdk_unverified' | 'sdk_broken';
/** `message` always starts with the stable code prefix (`sdk_missing: ...`); the providers card reads it from Detection.message. */
export class SdkError extends Error {
  constructor(readonly code: SdkErrorCode, detail: string) { super(`${code}: ${detail}`); this.name = new.target.name; }
}
export class SdkMissingError extends SdkError { constructor(detail: string) { super('sdk_missing', detail); } }
export class SdkIncompatibleError extends SdkError { constructor(detail: string) { super('sdk_incompatible', detail); } }
export class SdkUnverifiedError extends SdkError { constructor(detail: string) { super('sdk_unverified', detail); } }
export class SdkBrokenError extends SdkError { constructor(detail: string) { super('sdk_broken', detail); } }

export type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

/** Name of the per-user state directory below ~/Library/Application Support (macOS) or ~/.local/share (Linux); the verified install is `<it>/sdk`. */
export const STATE_DIR_NAME = 'IntelyIDE';

/** The per-user state directory, from the home directory and the platform only (never from XDG_* or any other variable). `platform` is for tests. */
export const stateDirOf = (home: string, platform: NodeJS.Platform = process.platform): string =>
  platform === 'linux' ? path.join(home, '.local', 'share', STATE_DIR_NAME) : path.join(home, 'Library', 'Application Support', STATE_DIR_NAME);

export interface LoadOptions {
  /** Verified-install root (tests). Production: `<state dir>/sdk`. When given, the checkout lookup is skipped. */
  dir?: string;
  /** Source-checkout package directory (tests); `null` skips the checkout lookup. Ignored in packaged mode. */
  checkoutDir?: string | null;
  /** Packaged mode (tests). Production: derived from this file's location, never from the environment. Skips the checkout lookup entirely. */
  packaged?: boolean;
  /** Directory holding `sdk-pin/` and, in a checkout, `node_modules/` (tests). Production: the parent of this file's directory. */
  sidecarDir?: string;
  /** Manifest text (tests). Production: sidecar/sdk-pin/tree.sha256 next to the sidecar. */
  manifest?: string;
  pin?: string;
  /** Home directory used to derive the state dir (tests). Production: os.homedir(). */
  home?: string;
  /** Platform used to derive the state dir (tests). Production: process.platform. */
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
}

export interface SdkReport { version: string; source: 'checkout' | 'verified'; files?: number; verifyMs?: number }

const MAX_ENTRIES = 40_000;
const MAX_BYTES = 256 * 1024 * 1024;
/** Written by npm, never imported: not part of the manifest (kept in step with sdk-pin/hash-tree.mjs). */
const SKIP = new Set(['node_modules/.bin', 'node_modules/.package-lock.json']);

const sidecarDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** True for a file inside `<name>.app/Contents/Resources/` (the bundle layout of (design notes: release-packaging-spec) 4.1), or inside `<dir>/.intely/<version>/resources/sidecar/` (the layout Setup uploads to a remote Linux server). The first is case-insensitive: APFS usually is, and a false positive only makes the loader stricter. */
export const isPackagedPath = (file: string): boolean => {
  const abs = path.resolve(file);
  return /[^/]\.app\/Contents\/Resources\//i.test(abs) || /[^/]\/\.intely\/[^/]+\/resources\/sidecar\//.test(abs);
};
const packagedHere = isPackagedPath(fileURLToPath(import.meta.url));
const mask = (s: string, home = os.homedir()) => redact(home && home.length > 1 ? s.split(home).join('~') : s);
const code = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

const done = new Map<string, Sdk>();
const reports = new Map<string, SdkReport>();
const inflight = new Map<string, Promise<Sdk>>();
let last: SdkReport | null = null;

/**
 * What to tell a person whose run cannot start because the SDK is not usable. In the packaged app the exact command of the installer
 * that sits next to this file (a plan first, then the install); in a source checkout the step that fetches the SDK.
 * `file` and `packaged` are for tests; production passes nothing.
 */
export function sdkSetupHint(opts: { file?: string; packaged?: boolean } = {}): string {
  const file = opts.file ?? fileURLToPath(import.meta.url);
  if (!(opts.packaged ?? isPackagedPath(file))) return 'Run `pnpm install` in the source checkout.';
  const installer = `'${path.join(path.dirname(file), 'sdk-install.js').replace(/'/g, `'\\''`)}'`;
  return `Install it once in a terminal: node ${installer} --plan (lists what would be downloaded), then node ${installer} --yes.`;
}

/** The report of the most recent successful load (version and how it was accepted), or null. */
export const sdkReport = (): SdkReport | null => last;
/** Tests only: forget memoized loads. */
export function resetSdkCache(): void { done.clear(); reports.clear(); inflight.clear(); last = null; }

export function loadSdk(opts: LoadOptions = {}): Promise<Sdk> {
  const home = opts.home ?? os.homedir();
  const packaged = opts.packaged ?? packagedHere;
  const key = `${packaged ? 'pk' : 'src'}:${opts.dir ? `dir:${path.resolve(opts.dir)}` : opts.checkoutDir !== undefined ? `co:${opts.checkoutDir}` : `std:${home}`}`;
  const hit = done.get(key);
  if (hit) { last = reports.get(key) ?? last; return Promise.resolve(hit); }
  let p = inflight.get(key);
  if (!p) {
    p = resolveAndImport(opts, home, packaged).then(
      ({ sdk, report }) => { done.set(key, sdk); reports.set(key, report); last = report; inflight.delete(key); return sdk; },
      (e) => { inflight.delete(key); throw e; },
    );
    inflight.set(key, p);
  }
  return p;
}

async function resolveAndImport(opts: LoadOptions, home: string, packaged: boolean): Promise<{ sdk: Sdk; report: SdkReport }> {
  const pin = opts.pin ?? SDK_PIN;
  const log = opts.log ?? ((l: string) => { process.stderr.write(`${l}\n`); });
  const base = opts.sidecarDir ?? sidecarDir();
  if (!packaged && !opts.dir) {
    const checkout = opts.checkoutDir === undefined ? path.join(base, 'node_modules', ...SDK_NAME.split('/')) : opts.checkoutDir;
    if (checkout) {
      let present = true;
      try { await lstat(checkout); } catch (e) { if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') present = false; else throw new SdkBrokenError(mask(String(e), home)); }
      if (present) {
        const real = await realpath(checkout).catch(() => { throw new SdkMissingError(`${SDK_NAME} is not installed (dangling link)`); });
        const version = await versionOf(real, home);
        if (version !== pin) throw new SdkIncompatibleError(`found ${SDK_NAME} ${version}, this build needs exactly ${pin}`);
        const sdk = await importEntry(real, home);
        log(`[sdk] ${SDK_NAME} ${version} (source checkout)`);
        return { sdk, report: { version, source: 'checkout' } };
      }
    }
  }
  const dir = opts.dir ?? path.join(stateDirOf(home, opts.platform), 'sdk');
  let st;
  try { st = await lstat(dir); } catch (e) {
    if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') throw new SdkMissingError(`${SDK_NAME} ${pin} is not installed`);
    throw new SdkBrokenError(mask(String(e), home));
  }
  const t0 = performance.now();
  const root = await checkRoot(dir, st);
  const pkgDir = path.join(root, 'node_modules', ...SDK_NAME.split('/'));
  const version = await versionOf(pkgDir, home);
  if (version !== pin) throw new SdkIncompatibleError(`found ${SDK_NAME} ${version}, this build needs exactly ${pin}`);
  const manifest = opts.manifest ?? await readManifest(base);
  const files = await verifyTree(root, manifest, home);
  const verifyMs = Math.round(performance.now() - t0);
  const sdk = await importEntry(pkgDir, home);
  log(`[sdk] ${SDK_NAME} ${version} verified (${files} files, ${verifyMs} ms)`);
  return { sdk, report: { version, source: 'verified', files, verifyMs } };
}

type Stat = Stats;
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** Entry-level rules shared by the root and every file below it: ours, not writable by group or other. */
function owned(st: Stat, what: string): void {
  if (uid() < 0) throw new SdkUnverifiedError('cannot check file ownership on this platform');
  if (st.uid !== uid()) throw new SdkUnverifiedError(`${what} is not owned by the current user`);
  if ((Number(st.mode) & 0o022) !== 0) throw new SdkUnverifiedError(`${what} is writable by group or others (run chmod -R go-w on it)`);
}

async function checkRoot(dir: string, st: Stat): Promise<string> {
  const abs = path.resolve(dir);
  if (st.isSymbolicLink()) throw new SdkUnverifiedError('the SDK directory is a symbolic link');
  if (!st.isDirectory()) throw new SdkUnverifiedError('the SDK path is not a directory');
  owned(st, 'the SDK directory');
  // no redirection by a symlink: the real path is the (real) parent plus the directory's own name, and the parent is ours too
  const parent = await realpath(path.dirname(abs));
  const real = await realpath(abs);
  if (real !== path.join(parent, path.basename(abs))) throw new SdkUnverifiedError('the SDK directory is reached through a symbolic link');
  // the state directory itself is a plain directory too (the installer refuses a symlinked one; so does the loader)
  if ((await lstat(path.dirname(abs))).isSymbolicLink()) throw new SdkUnverifiedError('the state directory is a symbolic link');
  owned(await lstat(parent), 'the state directory');
  return real;
}

async function versionOf(pkgDir: string, home: string): Promise<string> {
  const file = path.join(pkgDir, 'package.json');
  let st;
  try { st = await lstat(file); } catch (e) {
    if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') throw new SdkMissingError(`${SDK_NAME} is not installed`);
    throw new SdkBrokenError(mask(String(e), home));
  }
  if (!st.isFile()) throw new SdkBrokenError(`${SDK_NAME}/package.json is not a regular file`);
  try {
    const pkg = JSON.parse(await readFile(file, 'utf8')) as { name?: unknown; version?: unknown };
    if (pkg.name !== SDK_NAME || typeof pkg.version !== 'string') throw new Error('unexpected package.json');
    return pkg.version;
  } catch { throw new SdkBrokenError(`${SDK_NAME}/package.json is unreadable`); }
}

async function readManifest(base: string): Promise<string> {
  try { return await readFile(path.join(base, 'sdk-pin', 'tree.sha256'), 'utf8'); } catch {
    throw new SdkUnverifiedError('the pin manifest (sdk-pin/tree.sha256) is not available next to the sidecar');
  }
}

export function parseManifest(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const r = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!r || m.has(r[2]!)) throw new SdkUnverifiedError('the pin manifest is malformed');
    m.set(r[2]!, r[1]!);
  }
  if (m.size === 0) throw new SdkUnverifiedError('the pin manifest is empty');
  return m;
}

/** Hashes every file under `root` (rules of sdk-pin/hash-tree.mjs) and returns `sha256  path` lines sorted bytewise. Throws SdkUnverifiedError on anything but plain files and directories we own. */
export async function treeLines(root: string): Promise<string[]> {
  const out: [string, string][] = [];
  let bytes = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const name of await readdir(rel ? path.join(root, rel) : root)) {
      const r = rel ? `${rel}/${name}` : name;
      if (SKIP.has(r)) continue;
      if (/[\u0000-\u001f\u007f]/.test(r)) throw new SdkUnverifiedError('a file name contains a control character');
      const full = path.join(root, r);
      const st = await lstat(full);
      if (st.isDirectory()) { owned(st, `directory ${r}`); await walk(r); continue; }
      if (!st.isFile()) throw new SdkUnverifiedError(`unexpected entry (symlink or special file): ${r}`);
      owned(st, `file ${r}`);
      bytes += st.size;
      if (out.length >= MAX_ENTRIES || bytes > MAX_BYTES) throw new SdkUnverifiedError('the SDK directory is larger than the pinned tree');
      out.push([r, createHash('sha256').update(await readFile(full)).digest('hex')]);
    }
  };
  await walk('');
  out.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  return out.map(([r, h]) => `${h}  ${r}`);
}

async function verifyTree(root: string, manifestText: string, home: string): Promise<number> {
  const want = parseManifest(manifestText);
  let lines: string[];
  try { lines = await treeLines(root); } catch (e) {
    if (e instanceof SdkError) throw e;
    throw new SdkUnverifiedError(mask(String(e), home));
  }
  const have = new Map(lines.map((l) => [l.slice(66), l.slice(0, 64)] as const));
  for (const [p, h] of have) {
    const w = want.get(p);
    if (w === undefined) throw new SdkUnverifiedError(`unexpected file ${p} (not part of the pinned tree)`);
    if (w !== h) throw new SdkUnverifiedError(`file ${p} does not match the pinned tree`);
  }
  for (const p of want.keys()) if (!have.has(p)) throw new SdkUnverifiedError(`file ${p} of the pinned tree is missing`);
  return have.size;
}

async function importEntry(pkgDir: string, home: string): Promise<Sdk> {
  let entry: string;
  try {
    const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8')) as { exports?: { '.'?: { default?: unknown } } };
    const rel = pkg.exports?.['.']?.default;
    if (typeof rel !== 'string') throw new Error('no default export');
    entry = path.resolve(pkgDir, rel);
    if (!entry.startsWith(`${pkgDir}${path.sep}`)) throw new Error('entry outside the package');
    if (!(await lstat(entry)).isFile()) throw new Error('entry is not a file');
  } catch { throw new SdkBrokenError(`${SDK_NAME} has no usable entry point`); }
  try {
    return (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as Sdk;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const dep = /Cannot find (?:package|module) '([^']+)'/.exec(msg)?.[1];
    if ((code(e) === 'ERR_MODULE_NOT_FOUND' || code(e) === 'MODULE_NOT_FOUND') && dep) {
      if (dep === SDK_NAME) throw new SdkMissingError(`${SDK_NAME} could not be resolved`);
      throw new SdkBrokenError(`dependency ${dep.startsWith('/') ? path.basename(dep) : dep} is missing from the SDK install`);
    }
    throw new SdkBrokenError(mask(msg, home).slice(0, 300));
  }
}
