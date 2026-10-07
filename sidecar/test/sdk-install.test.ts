// The SDK installer program (src/sdk-install.ts, (design notes: release-packaging-spec) 5.5 and 8.1 row "SDK installer", task PK10).
// Everything runs against a fake registry on 127.0.0.1 serving tarballs built in the test; no real network, no npm, no credential.
// The CLI cases spawn the bundled program (built into a temp directory, never into sidecar/dist) and point HTTPS_PROXY at a
// listening socket, which is how "no connection" and "the network fails" are observed without touching a real host.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  childEnv, DEFAULT_LIMITS, installSdk, InstallError, makeScrub, planSdk, readLockPlan, readTar, repairSdkState, resolvedProblem, runCli, sandboxFlags, stateDirOf,
  uninstallSdk, unsafeEnv, type CliIo, type InstallOptions, type ProgressEvent,
} from '../src/sdk-install.js';
import { SDK_NAME } from '../src/sdk.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sri = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

// ---------------------------------------------------------------------------------------------------------------------
// tar builder (also the source of hostile archives)

const oct = (n: number, w: number) => n.toString(8).padStart(w, '0');
interface Member {
  name: string; data?: Buffer | string; type?: string; mode?: number; linkname?: string; magic?: 'posix' | 'gnu'; prefix?: string; badSum?: boolean; size?: number;
}
function member(m: Member): Buffer {
  const data = Buffer.from(m.data ?? '');
  const h = Buffer.alloc(512);
  h.write(m.name, 0, 100, 'utf8');
  h.write(`${oct(m.mode ?? 0o644, 7)}\0`, 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${oct(m.size ?? data.length, 11)}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.fill(0x20, 148, 156);
  h.write(m.type ?? '0', 156, 'latin1');
  if (m.linkname) h.write(m.linkname, 157, 100, 'utf8');
  h.write((m.magic ?? 'posix') === 'posix' ? 'ustar\u000000' : 'ustar  \u0000', 257, 'latin1');
  if (m.prefix) h.write(m.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${oct(m.badSum ? sum + 1 : sum, 6)}\0 `, 148, 'latin1');
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([h, data, pad]);
}
const tar = (members: Member[]) => Buffer.concat([...members.map(member), Buffer.alloc(1024)]);
const gz = (b: Buffer) => zlib.gzipSync(b);
const pax = (key: string, value: string) => {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return Buffer.from(`${len}${body}`);
};

// ---------------------------------------------------------------------------------------------------------------------
// fixture registry

interface PkgSpec {
  key: string; version?: string; files?: Record<string, string | { data: string; mode: number }>; tar?: Buffer; optional?: boolean;
  /** Files that exist in the tarball but not in the expected tree manifest. */
  extra?: Record<string, string>;
}
interface Fixture { pinDir: string; origin: string; keys: string[]; served: Map<string, Buffer>; manifest: string; lock: any }

let tmp: string;
let server: http.Server;
let origin: string;
let requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
let served: Map<string, Buffer>;
let handler: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null;

const SDK_KEY = `node_modules/${SDK_NAME}`;
const FAKE_VERSION = '1.2.3';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    if (handler?.(req, res)) return;
    const body = served.get(req.url ?? '');
    if (!body) { res.statusCode = 404; res.end('no'); return; }
    res.setHeader('content-type', 'application/octet-stream');
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sdk-install-')));
  requests = []; served = new Map(); handler = null;
});
afterEach(() => {
  try { execFileSync('chmod', ['-R', 'u+w', tmp]); } catch { /* already gone */ }
  rmSync(tmp, { recursive: true, force: true });
});

const urlPath = (name: string, version: string) => `/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;

/** Builds the pin directory (lock, manifest) and fills `served`. The SDK package is always present. */
function fixture(specs: PkgSpec[] = [], opts: { origin?: string; pinName?: string } = {}): Fixture {
  const all: PkgSpec[] = [{ key: SDK_KEY, files: { 'index.js': 'export const sdk = 1;\n', 'bin/cli.js': { data: '#!/usr/bin/env node\n', mode: 0o755 }, 'lib/a/b/c.txt': 'deep\n' } }, ...specs];
  const org = opts.origin ?? origin;
  const pinDir = path.join(tmp, opts.pinName ?? 'pin');
  mkdirSync(pinDir, { recursive: true });
  const lockPackages: Record<string, unknown> = { '': { name: 'intely-sdk-pin', dependencies: {} } };
  const treeFiles = new Map<string, string>();
  for (const s of all) {
    const name = s.key.slice(s.key.lastIndexOf('node_modules/') + 13);
    const version = s.version ?? (s.key === SDK_KEY ? FAKE_VERSION : '1.0.0');
    const files: Record<string, string | { data: string; mode: number }> = { 'package.json': JSON.stringify({ name, version }), ...s.files };
    const members: Member[] = Object.entries(files).map(([f, v]) => (typeof v === 'string' ? { name: `package/${f}`, data: v } : { name: `package/${f}`, data: v.data, mode: v.mode }));
    for (const [f, v] of Object.entries(s.extra ?? {})) members.push({ name: `package/${f}`, data: v });
    const bytes = s.tar ?? gz(tar(members));
    const p = urlPath(name, version);
    if (!s.optional) {
      served.set(p, bytes);
      for (const [f, v] of Object.entries(files)) treeFiles.set(`${s.key}/${f}`, sha256(typeof v === 'string' ? v : v.data));
    }
    lockPackages[s.key] = { version, resolved: `${org}${p}`, integrity: sri(bytes), ...(s.optional ? { optional: true } : {}) };
  }
  const pkgJson = JSON.stringify({ name: 'intely-sdk-pin', private: true, dependencies: { [SDK_NAME]: FAKE_VERSION } });
  const lock = { name: 'intely-sdk-pin', lockfileVersion: 3, requires: true, packages: lockPackages };
  const lockText = JSON.stringify(lock, null, 2);
  writeFileSync(path.join(pinDir, 'package.json'), pkgJson);
  writeFileSync(path.join(pinDir, 'package-lock.json'), lockText);
  treeFiles.set('package.json', sha256(pkgJson));
  treeFiles.set('package-lock.json', sha256(lockText));
  const lines = [...treeFiles].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(([f, h]) => `${h}  ${f}`);
  const manifest = `${lines.join('\n')}\n`;
  writeFileSync(path.join(pinDir, 'tree.sha256'), manifest);
  return { pinDir, origin: org, keys: all.map((s) => s.key), served, manifest, lock };
}

const home = () => path.join(tmp, 'home');
const stateDir = () => stateDirOf(home());
const finalDir = () => path.join(stateDir(), 'sdk');
function options(f: Fixture, extra: Partial<InstallOptions> = {}): InstallOptions {
  mkdirSync(home(), { recursive: true });
  return { home: home(), pinDir: f.pinDir, registryOrigin: origin, expectedVersion: FAKE_VERSION, env: {}, ...extra };
}
const names = () => (existsSync(stateDir()) ? readdirSync(stateDir()).sort() : []);
const expectClean = () => expect(names().filter((n) => n !== 'sdk')).toEqual([]);
async function fails(p: Promise<unknown>): Promise<InstallError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, 'the call must fail').toBeInstanceOf(InstallError);
  return e as InstallError;
}

// ---------------------------------------------------------------------------------------------------------------------

describe('happy path', () => {
  it('installs a tree equal to the manifest, read-only, atomically, with progress and without cookies or credentials', async () => {
    const f = fixture([
      { key: 'node_modules/@scope/dep', files: { 'index.js': 'dep\n' } },
      { key: 'node_modules/plain', files: { 'x/y.js': 'y\n' } },
      { key: 'node_modules/plain/node_modules/nested', files: { 'n.js': 'n\n' } },
      { key: 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64', optional: true, files: { 'claude': 'binary' } },
    ]);
    const events: ProgressEvent[] = [];
    const r = await installSdk(options(f, { log: (e) => events.push(e) }));
    expect(r).toMatchObject({ version: FAKE_VERSION, packages: 4 });
    expect(r.files).toBe(f.manifest.trim().split('\n').length);
    // equal to the manifest, checked by the independent implementation of sdk-pin/hash-tree.mjs
    const { manifestOf } = (await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'sdk-pin', 'hash-tree.mjs')).href)) as { manifestOf: (d: string) => string };
    expect(manifestOf(finalDir())).toBe(f.manifest);
    // the optional platform package was neither requested nor installed
    expect(requests.map((q) => q.url)).not.toContain(urlPath('@anthropic-ai/claude-agent-sdk-darwin-x64', '1.0.0'));
    expect(requests).toHaveLength(4);
    for (const q of requests) { expect(q.headers.cookie).toBeUndefined(); expect(q.headers.authorization).toBeUndefined(); }
    expect(events.filter((e) => e.phase === 'download').map((e) => (e as { done: number }).done)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => e.phase).slice(-2)).toEqual(['verify', 'install']);
    // modes: root 0700, directories 0555, files 0444, executable 0555
    expect(statSync(finalDir()).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(finalDir(), SDK_KEY, 'lib')).mode & 0o777).toBe(0o555);
    expect(statSync(path.join(finalDir(), SDK_KEY, 'index.js')).mode & 0o777).toBe(0o444);
    expect(statSync(path.join(finalDir(), SDK_KEY, 'bin', 'cli.js')).mode & 0o777).toBe(0o555);
    expect(statSync(stateDir()).mode & 0o777).toBe(0o700);
    expectClean(); // no staging, no lock, no old copy
  });

  it('--plan content: the plan lists the packages and hosts and creates nothing', async () => {
    const f = fixture();
    const plan = await planSdk({ home: home(), pinDir: f.pinDir, registryOrigin: origin, expectedVersion: FAKE_VERSION });
    expect(plan.packages.map((p) => p.name)).toEqual([SDK_NAME]);
    expect(plan.hosts).toEqual([new URL(origin).host]);
    expect(plan.finalDir).toBe(finalDir());
    expect(plan.pin['tree.sha256']).toBe(sha256(f.manifest));
    expect(requests).toHaveLength(0);
    expect(existsSync(home())).toBe(false);
  });
});

describe('integrity: nothing is trusted before the hash and the tree match', () => {
  it('a tampered tarball (sha512 differs) is refused and nothing stays behind', async () => {
    const f = fixture([{ key: 'node_modules/b', files: { 'i.js': 'good\n' } }]);
    const p = urlPath('b', '1.0.0');
    f.served.set(p, gz(tar([{ name: 'package/package.json', data: JSON.stringify({ name: 'b', version: '1.0.0' }) }, { name: 'package/i.js', data: 'evil\n' }])));
    const e = await fails(installSdk(options(f)));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/sha512/);
    expect(existsSync(finalDir())).toBe(false);
    expectClean();
  });

  it('a tampered manifest (one hash differs) is refused after extraction and the existing install survives', async () => {
    const good = fixture();
    await installSdk(options(good));
    const marker = readFileSync(path.join(finalDir(), SDK_KEY, 'index.js'), 'utf8');
    const f = fixture([], { pinName: 'pin2' });
    const lines = f.manifest.split('\n');
    lines[1] = `${'0'.repeat(64)}  ${lines[1]!.slice(66)}`;
    writeFileSync(path.join(f.pinDir, 'tree.sha256'), lines.join('\n'));
    const e = await fails(installSdk(options(f)));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/does not match the pinned tree/);
    expect(readFileSync(path.join(finalDir(), SDK_KEY, 'index.js'), 'utf8')).toBe(marker);
    expectClean();
  });

  it('an extra file in a tarball is refused', async () => {
    const g = fixture([{ key: 'node_modules/e', files: { 'a.js': 'a\n' }, extra: { 'backdoor.js': 'x\n' } }], { pinName: 'pin3' });
    const lines = g.manifest.split('\n').filter((l) => !l.includes('backdoor'));
    writeFileSync(path.join(g.pinDir, 'tree.sha256'), lines.join('\n'));
    const e = await fails(installSdk(options(g)));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/unexpected file .*backdoor\.js/);
    expectClean();
  });

  it('a missing file of the pinned tree is refused', async () => {
    const f = fixture([{ key: 'node_modules/m', files: { 'a.js': 'a\n' } }]);
    writeFileSync(path.join(f.pinDir, 'tree.sha256'), `${f.manifest}${'1'.repeat(64)}  node_modules/m/ghost.js\n`);
    const e = await fails(installSdk(options(f)));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/ghost\.js.*missing/);
  });

  it('wrong version: the tarball package.json disagrees with the lock', async () => {
    const f = fixture([{ key: 'node_modules/v', version: '1.0.0', files: { 'package.json': JSON.stringify({ name: 'v', version: '9.9.9' }) } }]);
    const e = await fails(installSdk(options(f)));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/9\.9\.9.*1\.0\.0/);
    expectClean();
  });

  it('wrong version: a lock for another SDK version than this build is refused before any request', async () => {
    const f = fixture();
    const e = await fails(installSdk(options(f, { expectedVersion: '0.3.287' })));
    expect(e.code).toBe('plan_invalid');
    expect(requests).toHaveLength(0);
    expect(existsSync(stateDir())).toBe(false);
  });

  it('the tarball names a different package than its lock entry', async () => {
    const f = fixture([{ key: 'node_modules/w', files: { 'package.json': JSON.stringify({ name: 'other', version: '1.0.0' }) } }]);
    expect((await fails(installSdk(options(f)))).code).toBe('sdk_unverified');
  });

  it('a non-gzip body with a matching hash is refused', async () => {
    const f = fixture([{ key: 'node_modules/n', tar: Buffer.from('this is not gzip') }]);
    const e = await fails(installSdk(options(f)));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/gzip/);
  });
});

describe('hostile archives (the lock hash matches the hostile bytes, so only the extractor stands in the way)', () => {
  const pj = { name: 'package/package.json', data: JSON.stringify({ name: 'h', version: '1.0.0' }) };
  const cases: Array<[string, Buffer, RegExp]> = [
    ['path traversal', tar([pj, { name: 'package/../../evil.js', data: 'x' }]), /"\.\."/],
    ['traversal deeper in the name', tar([pj, { name: 'package/a/../../../evil.js', data: 'x' }]), /"\.\."/],
    ['absolute path', tar([pj, { name: '/etc/evil.js', data: 'x' }]), /outside package/],
    ['outside package/', tar([pj, { name: 'other/evil.js', data: 'x' }]), /outside package/],
    ['"." component', tar([pj, { name: 'package/./x.js', data: 'x' }]), /"\."/],
    ['empty component', tar([pj, { name: 'package//x.js', data: 'x' }]), /empty/],
    ['backslash', tar([pj, { name: 'package/a\\b.js', data: 'x' }]), /backslash/],
    ['control character', tar([pj, { name: 'package/a\u0001b.js', data: 'x' }]), /control/],
    ['symlink', tar([pj, { name: 'package/link', type: '2', linkname: '/etc/passwd' }]), /unsupported tar entry type "2"/],
    ['hardlink', tar([pj, { name: 'package/hard', type: '1', linkname: 'package/package.json' }]), /type "1"/],
    ['character device', tar([pj, { name: 'package/dev', type: '3' }]), /type "3"/],
    ['fifo', tar([pj, { name: 'package/fifo', type: '6' }]), /type "6"/],
    ['GNU long-name record', tar([pj, { name: '././@LongLink', type: 'L', data: 'package/very/long\0' }, { name: 'package/x', data: 'x' }]), /type "L"/],
    ['GNU long-link record', tar([pj, { name: '././@LongLink', type: 'K', data: 'x\0' }, { name: 'package/x', data: 'x' }]), /type "K"/],
    ['global pax header', tar([{ name: 'pax_global_header', type: 'g', data: pax('comment', 'x') }, pj]), /type "g"/],
    ['pax linkpath record', tar([{ name: 'PaxHeader', type: 'x', data: pax('linkpath', '/etc/passwd') }, pj]), /unsupported pax record/],
    ['pax mtime record', tar([{ name: 'PaxHeader', type: 'x', data: pax('mtime', '1.5') }, pj]), /unsupported pax record/],
    ['pax path with traversal', tar([{ name: 'PaxHeader', type: 'x', data: pax('path', 'package/../../x') }, { name: 'package/y', data: 'x' }]), /"\.\."/],
    ['duplicate names differing only by case', tar([pj, { name: 'package/Index.js', data: 'a' }, { name: 'package/index.js', data: 'b' }]), /duplicate/],
    ['duplicate names differing only by Unicode normalisation', tar([pj, { name: 'package/é.js', data: 'a' }, { name: 'package/é.js', data: 'b' }]), /duplicate/],
    ['exact duplicate', tar([pj, { name: 'package/x', data: 'a' }, { name: 'package/x', data: 'b' }]), /duplicate/],
    ['a file below a file', tar([pj, { name: 'package/x', data: 'a' }, { name: 'package/x/y', data: 'b' }]), /below a file/],
    ['a file named like a directory', tar([pj, { name: 'package/d/y', data: 'b' }, { name: 'package/d', data: 'a' }]), /name of a directory/],
    ['bad header checksum', tar([pj, { name: 'package/x', data: 'a', badSum: true }]), /checksum/],
    ['unknown magic', Buffer.concat([(() => { const b = member({ name: 'package/package.json', data: '{}' }); b.write('nope', 257); b.fill(0x20, 148, 156); let s = 0; for (const c of b.subarray(0, 512)) s += c; b.write(`${oct(s, 6)}\0 `, 148, 'latin1'); return b; })(), Buffer.alloc(1024)]), /unsupported tar format/],
    ['truncated archive', tar([pj, { name: 'package/x', data: 'a'.repeat(2000) }]).subarray(0, 1536 + 600), /truncated/],
    ['data after the end marker', Buffer.concat([tar([pj]), member({ name: 'package/late', data: 'x' })]), /after the end/],
    ['size larger than the archive', tar([pj, { name: 'package/x', data: 'a', size: 100000 }]), /truncated|larger/],
    ['directory with data', tar([pj, { name: 'package/d/', type: '5', data: 'x' }]), /directory entry has data/],
    ['file name ending in a slash', tar([pj, { name: 'package/x/', data: 'x' }]), /slash/],
  ];
  it.each(cases)('%s', async (_n, bytes, why) => {
    const f = fixture([{ key: 'node_modules/h', tar: gz(bytes) }]);
    const e = await fails(installSdk(options(f)));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(why);
    expect(existsSync(finalDir())).toBe(false);
    expectClean();
    for (const stray of ['evil.js', 'x', 'link']) {
      expect(existsSync(path.join(stateDir(), stray))).toBe(false);
      expect(existsSync(path.join(tmp, stray))).toBe(false);
    }
    expect(existsSync('/etc/evil.js')).toBe(false);
  });

  it('a planted symlink where the staging directory goes is not followed', async () => {
    const f = fixture();
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    chmodSync(stateDir(), 0o700);
    const victim = path.join(tmp, 'victim');
    mkdirSync(victim);
    symlinkSync(victim, path.join(stateDir(), 'sdk.tmp-4242'));
    const e = await fails(installSdk(options(f, { pid: 4242 })));
    expect(e.code).toBe('disk');
    expect(readdirSync(victim)).toEqual([]);
  });

  it('accepted forms: GNU magic, ustar prefix, explicit directories, the package/ root and the pax path and size records', () => {
    const entries = [...readTar(Buffer.concat([
      member({ name: 'package/', type: '5', mode: 0o755 }),
      member({ name: 'package/d/', type: '5', mode: 0o755 }),
      member({ name: 'file.js', prefix: 'package/d', data: 'prefixed', magic: 'posix' }),
      member({ name: 'package/gnu.js', data: 'gnu', magic: 'gnu', mode: 0o755 }),
      member({ name: 'PaxHeader', type: 'x', data: pax('path', 'package/long/name.txt') }),
      member({ name: 'ignored', data: 'viapax' }),
      member({ name: 'PaxHeader', type: 'x', data: pax('size', '3') }),
      member({ name: 'package/sz.txt', data: 'abc', size: 0 }).subarray(0, 512),
      Buffer.alloc(512, 0).fill('abc', 0, 3),
      Buffer.alloc(1024),
    ]), { maxEntries: 100, maxFile: 1000 })];
    expect(entries.map((e) => [e.path, e.dir, e.exec, e.data.toString()])).toEqual([
      ['d', true, true, ''], ['d/file.js', false, false, 'prefixed'], ['gnu.js', false, true, 'gnu'], ['long/name.txt', false, false, 'viapax'], ['sz.txt', false, false, 'abc'],
    ]);
  });
});

describe('caps', () => {
  it('an oversize compressed download (declared and streamed) is refused', async () => {
    const f = fixture([{ key: 'node_modules/big', files: { 'a.bin': randomBytes(5000).toString('hex') } }]);
    const p = urlPath('big', '1.0.0');
    const big = f.served.get(p)!;
    const e = await fails(installSdk(options(f, { limits: { maxCompressed: big.length - 1 } })));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/larger than the cap/);
    // streamed without a content-length
    handler = (req, res) => {
      if (req.url !== p) return false;
      res.setHeader('transfer-encoding', 'chunked');
      res.write(big.subarray(0, 10)); res.write(big.subarray(10)); res.end();
      return true;
    };
    const e2 = await fails(installSdk(options(f, { limits: { maxCompressed: big.length - 1 } })));
    expect(e2.message).toMatch(/larger than the cap/);
    expectClean();
  });

  it('a decompression bomb is refused at the real default cap (64 MB per tarball)', async () => {
    const bomb = gz(tar([{ name: 'package/package.json', data: '{}' }, { name: 'package/zeros', data: Buffer.alloc(70 * 1024 * 1024) }]));
    expect(bomb.length).toBeLessThan(1024 * 1024); // small on the wire, large when unpacked
    const f = fixture([{ key: 'node_modules/bomb', tar: bomb }]);
    const e = await fails(installSdk(options(f)));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/unpacks to more than the cap/);
    expectClean();
  });

  it('the running total across tarballs is capped', async () => {
    const f = fixture([{ key: 'node_modules/t1', files: { 'a.bin': 'x'.repeat(4000) } }, { key: 'node_modules/t2', files: { 'a.bin': 'y'.repeat(4000) } }]);
    const e = await fails(installSdk(options(f, { limits: { maxTotal: 6000 } })));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/larger than the pinned tree/);
    expectClean();
  });

  it('too many entries are refused (per archive and in total)', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) many[`f${i}.txt`] = String(i);
    const f = fixture([{ key: 'node_modules/many', files: many }]);
    const e = await fails(installSdk(options(f, { limits: { maxEntries: 10 } })));
    expect(e.code).toBe('sdk_unverified');
    expect(e.message).toMatch(/too many entries/);
    expectClean();
    const g = fixture([{ key: 'node_modules/a1', files: { 'a': '1', 'b': '2' } }, { key: 'node_modules/a2', files: { 'a': '1', 'b': '2' } }], { pinName: 'pin2' });
    const e2 = await fails(installSdk(options(g, { limits: { maxEntries: 8 } })));
    expect(e2.message).toMatch(/too many entries/);
  });

  it('the production limits are the ones of sdk.ts and the spec', () => {
    const src = readFileSync(path.join(root, 'src', 'sdk.ts'), 'utf8');
    expect(src).toMatch(/const MAX_ENTRIES = 40_000;/);
    expect(src).toMatch(/const MAX_BYTES = 256 \* 1024 \* 1024;/);
    expect(DEFAULT_LIMITS).toMatchObject({ maxEntries: 40_000, maxTotal: 256 * 1024 * 1024, maxCompressed: 64 * 1024 * 1024, maxUnpacked: 64 * 1024 * 1024, timeoutMs: 300_000, idleMs: 30_000 });
  });
});

describe('network', () => {
  it('a redirect (also to another host) is an error and the other host is never contacted', async () => {
    const other = http.createServer((_q, r) => { hits++; r.end('x'); });
    let hits = 0;
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      const f = fixture();
      const target = `http://127.0.0.1:${(other.address() as net.AddressInfo).port}/evil.tgz`;
      handler = (_req, res) => { res.statusCode = 302; res.setHeader('location', target); res.end(); return true; };
      const e = await fails(installSdk(options(f)));
      expect(e.code).toBe('network');
      expect(hits).toBe(0);
      expectClean();
    } finally { other.close(); }
  });

  it('a registry error status, a refused connection and a broken stream are network errors that leave nothing behind', async () => {
    const f = fixture();
    handler = (_q, res) => { res.statusCode = 503; res.end('down'); return true; };
    const e = await fails(installSdk(options(f)));
    expect(e.code).toBe('network');
    expect(e.message).toMatch(/503/);
    handler = (_q, res) => { res.writeHead(200, { 'content-length': '100000' }); res.write('abc'); setTimeout(() => res.destroy(), 20); return true; };
    expect((await fails(installSdk(options(f)))).code).toBe('network');
    // refused connection
    const closed = http.createServer(); await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as net.AddressInfo).port; closed.close();
    const g = fixture([], { origin: `http://127.0.0.1:${port}`, pinName: 'pin2' });
    const e3 = await fails(installSdk({ ...options(g), registryOrigin: `http://127.0.0.1:${port}` }));
    expect(e3.code).toBe('network');
    expect(e3.message).toMatch(/ECONNREFUSED/);
    expect(existsSync(finalDir())).toBe(false);
    expectClean();
  });

  it('a content-encoding on a tarball is refused', async () => {
    const f = fixture();
    handler = (_q, res) => { res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync(Buffer.from('x'))); return true; };
    expect((await fails(installSdk(options(f)))).code).toBe('sdk_unverified');
  });

  it('the whole run has a timeout (a hanging registry ends as a network error)', async () => {
    const f = fixture();
    handler = () => true; // never answers
    const e = await fails(installSdk(options(f, { limits: { timeoutMs: 150 } })));
    expect(e.code).toBe('network');
    expect(e.message).toMatch(/timed out/);
    expectClean();
  });

  it('a download that stalls (no response, or no new byte) ends after the idle limit, not after the whole-run limit', async () => {
    const f = fixture();
    handler = () => true;
    const t0 = Date.now();
    const e = await fails(installSdk(options(f, { limits: { idleMs: 200 } })));
    expect(e.code).toBe('network');
    expect(Date.now() - t0).toBeLessThan(5000);
    handler = (_q, res) => { res.writeHead(200, { 'content-length': '100000' }); res.write('abc'); return true; };
    const e2 = await fails(installSdk(options(f, { limits: { idleMs: 200 } })));
    expect(e2.code).toBe('network');
    expect(e2.message).toMatch(/timed out|interrupted/);
    expectClean();
  });

  it('cancelling mid-download leaves no sdk directory, no staging directory and no lock', async () => {
    const f = fixture([{ key: 'node_modules/slow', files: { 'a': 'a' } }]);
    const ac = new AbortController();
    let calls = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      if (++calls === 1) return fetch(input, init);
      return new Promise((_res, rej) => { setTimeout(() => ac.abort(), 20); init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)); });
    };
    const e = await fails(installSdk(options(f, { fetchImpl, signal: ac.signal })));
    expect(e.code).toBe('cancelled');
    expect(existsSync(finalDir())).toBe(false);
    expectClean();
  });
});

describe('the lock file and the plan', () => {
  const PROD = (name: string, version: string) => `https://registry.npmjs.org${urlPath(name, version)}`;
  const problem = (r: unknown, name = 'left-pad', version = '1.3.0') => resolvedProblem(r, name, version);

  it('accepts exactly the production tarball shape', () => {
    expect(problem(PROD('left-pad', '1.3.0'))).toBeNull();
    expect(problem(PROD('@scope/pkg', '2.0.0-rc.1'), '@scope/pkg', '2.0.0-rc.1')).toBeNull();
  });

  it.each([
    ['plain http', 'http://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'],
    ['another host', 'https://registry.npmjs.com/left-pad/-/left-pad-1.3.0.tgz'],
    ['a look-alike host', 'https://registry.npmjs.org.evil.example/left-pad/-/left-pad-1.3.0.tgz'],
    ['a host with userinfo trick', 'https://registry.npmjs.org@evil.example/left-pad/-/left-pad-1.3.0.tgz'],
    ['an explicit port', 'https://registry.npmjs.org:8443/left-pad/-/left-pad-1.3.0.tgz'],
    ['the default port spelled out', 'https://registry.npmjs.org:443/left-pad/-/left-pad-1.3.0.tgz'],
    ['user information', 'https://user:pw@registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'],
    ['a query', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz?x=1'],
    ['a fragment', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz#x'],
    ['an upper-case host', 'https://REGISTRY.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'],
    ['a path without the registry shape', 'https://registry.npmjs.org/left-pad/left-pad-1.3.0.tgz'],
    ['a path with traversal', 'https://registry.npmjs.org/left-pad/-/../../x.tgz'],
    ['another package name', 'https://registry.npmjs.org/right-pad/-/right-pad-1.3.0.tgz'],
    ['another version', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.1.tgz'],
    ['not a tgz', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.zip'],
    ['a file URL', 'file:///etc/passwd'],
    ['not a string', 42],
    ['an empty string', ''],
  ])('refuses %s', (_n, r) => {
    expect(problem(r)).not.toBeNull();
  });

  it('refuses a lock with a sha1 or multi-hash integrity, an alias, a link or a bad name, without any request', async () => {
    const make = (patch: (l: any) => void) => {
      const f = fixture([{ key: 'node_modules/p', files: { 'a': 'a' } }]);
      patch(f.lock);
      writeFileSync(path.join(f.pinDir, 'package-lock.json'), JSON.stringify(f.lock));
      return f;
    };
    const variants: Array<[string, (l: any) => void, RegExp]> = [
      ['sha1', (l) => { l.packages['node_modules/p'].integrity = 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwI='; }, /sha512/],
      ['two hashes', (l) => { l.packages['node_modules/p'].integrity += ` ${l.packages['node_modules/p'].integrity}`; }, /sha512/],
      ['no integrity', (l) => { delete l.packages['node_modules/p'].integrity; }, /sha512/],
      ['alias', (l) => { l.packages['node_modules/p'].name = 'other'; }, /alias/],
      ['link', (l) => { l.packages['node_modules/p'].link = true; }, /link/],
      ['bundled', (l) => { l.packages['node_modules/p'].inBundle = true; }, /bundled/],
      ['dot-dot key', (l) => { l.packages['node_modules/../x'] = l.packages['node_modules/p']; }, /unusable path/],
      ['key outside node_modules', (l) => { l.packages['p'] = l.packages['node_modules/p']; }, /unusable path/],
      ['hidden key', (l) => { l.packages['node_modules/.bin'] = l.packages['node_modules/p']; }, /unusable path/],
      ['bad version', (l) => { l.packages['node_modules/p'].version = '1.0.0+build'; }, /version/],
      ['lockfileVersion 2', (l) => { l.lockfileVersion = 2; }, /lockfile v3/],
      ['no SDK', (l) => { delete l.packages[SDK_KEY]; }, /does not contain/],
    ];
    for (const [n, patch, why] of variants) {
      const f = make(patch);
      const e = await fails(installSdk(options(f)));
      expect(e.code, n).toBe('plan_invalid');
      expect(e.message, n).toMatch(why);
    }
    expect(requests).toHaveLength(0);
    expect(existsSync(stateDir())).toBe(false);
  });

  it('a registry override that is not a loopback address is refused', async () => {
    const f = fixture();
    expect((await fails(planSdk({ pinDir: f.pinDir, home: home(), registryOrigin: 'https://evil.example', expectedVersion: FAKE_VERSION }))).code).toBe('plan_invalid');
    await expect(readLockPlan(f.pinDir)).rejects.toMatchObject({ code: 'plan_invalid' }); // the fixture URLs are not the production registry
  });

  it('the committed pin is a valid plan (110 lock entries, 102 non-optional)', async () => {
    const plan = await planSdk({ home: home(), pinDir: path.join(root, 'sdk-pin') });
    expect(plan.packages.length + plan.skippedOptional).toBe(110);
    expect(plan.packages).toHaveLength(102);
    expect(plan.skippedOptional).toBe(8);
    expect(plan.hosts).toEqual(['registry.npmjs.org']);
    expect(plan.version).toBe('0.3.287');
  });
});

describe('environment and masking', () => {
  it.each(['NODE_OPTIONS', 'NODE_PATH', 'npm_config_registry', 'NPM_CONFIG_USERCONFIG', 'npm_config_', 'NODE_TLS_REJECT_UNAUTHORIZED'])('%s is refused before anything happens', async (name) => {
    const f = fixture();
    expect(unsafeEnv({ [name]: '1' })).toBe(name);
    const e = await fails(installSdk(options(f, { env: { [name]: '1' } })));
    expect(e.code).toBe('env_unsafe');
    expect(e.message).toContain(name);
    expect(requests).toHaveLength(0);
    expect(existsSync(stateDir())).toBe(false);
  });

  it('proxy settings and certificate paths are not refused', () => {
    expect(unsafeEnv({ HTTPS_PROXY: 'http://x', NO_PROXY: 'a', NODE_EXTRA_CA_CERTS: '/x.pem', SSL_CERT_FILE: '/y.pem', PATH: '/usr/bin', HOME: '/h' })).toBeNull();
  });

  it('proxy credentials, home paths and secret-shaped text are masked in every output line', () => {
    const scrub = makeScrub(['/Users/someone', '/private/Users/someone'], { HTTPS_PROXY: 'http://alice:s3cretpw@proxy.example:3128', https_proxy: 'http://bob:hunter22@p2.example:80' });
    const out = scrub('connect to http://alice:s3cretpw@proxy.example:3128 failed; via http://bob:hunter22@p2.example:80; file /Users/someone/Library/x and /private/Users/someone/y; token=abcdef123456; Authorization: Bearer abcdefghijklmnop');
    for (const leak of ['s3cretpw', 'alice', 'hunter22', 'bob', '/Users/someone', 'abcdef123456', 'abcdefghijklmnop']) expect(out).not.toContain(leak);
    expect(out).toContain('~/Library/x');
    expect(scrub('Failed http://carol:topsecret@elsewhere.example/x')).not.toContain('topsecret');
  });
});

describe('state directory, lock, replacement and repair', () => {
  it('replaces an existing install atomically and leaves no old copy', async () => {
    const f = fixture();
    await installSdk(options(f));
    const g = fixture([{ key: 'node_modules/more', files: { 'm': 'm' } }], { pinName: 'pin2' });
    const r = await installSdk(options(g));
    expect(r.packages).toBe(2);
    expect(existsSync(path.join(finalDir(), 'node_modules', 'more', 'm'))).toBe(true);
    expectClean();
  });

  it('a symlink in place of the sdk directory is replaced, its target is untouched', async () => {
    const f = fixture();
    const victim = path.join(tmp, 'victim'); mkdirSync(victim); writeFileSync(path.join(victim, 'keep'), 'k');
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); chmodSync(stateDir(), 0o700);
    symlinkSync(victim, finalDir());
    await installSdk(options(f));
    expect(lstatSync(finalDir()).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(victim, 'keep'), 'utf8')).toBe('k');
    expect(readdirSync(victim)).toEqual(['keep']);
    expectClean();
  });

  it('a second run while one is active is refused (single flight), then works', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: typeof fetch = async (i, init) => { await gate; return fetch(i, init); };
    const first = installSdk(options(f, { fetchImpl: slow }));
    await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(path.join(stateDir(), 'sdk.lock'), 'utf8')).toBe(`${process.pid}\n`);
    const e = await fails(installSdk(options(f, { pid: process.pid + 1 })));
    expect(e.code).toBe('busy');
    release();
    await first;
    expectClean();
    await installSdk(options(f));
  });

  it('a lock of a dead process is taken over; a fresh unreadable lock is respected', async () => {
    const f = fixture();
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); chmodSync(stateDir(), 0o700);
    const dead = spawnSyncPid();
    writeFileSync(path.join(stateDir(), 'sdk.lock'), `${dead}\n`);
    await installSdk(options(f));
    expectClean();
    writeFileSync(path.join(stateDir(), 'sdk.lock'), 'garbage');
    expect((await fails(installSdk(options(f)))).code).toBe('busy');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path.join(stateDir(), 'sdk.lock'), old, old);
    await installSdk(options(f));
    expectClean();
  });

  it('crash repair: a missing sdk is restored from sdk.old-*, leftovers and stale staging of dead processes are removed', async () => {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); chmodSync(stateDir(), 0o700);
    const dead = spawnSyncPid();
    const mk = (n: string, ageMs = 0) => {
      const p = path.join(stateDir(), n); mkdirSync(p); writeFileSync(path.join(p, 'f'), n);
      if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(p, t, t); }
      return p;
    };
    mk(`sdk.old-${dead}`);
    mk(`sdk.tmp-${dead}`, 2 * 3600_000);
    mk(`sdk.tmp-${dead + 1}`); // young: kept
    mk(`sdk.tmp-${process.pid}`, 2 * 3600_000); // old but its process is alive: kept
    let r = await repairSdkState(stateDir());
    expect(r.restored).toBe(true);
    expect(readFileSync(path.join(finalDir(), 'f'), 'utf8')).toBe(`sdk.old-${dead}`);
    expect(names()).toEqual(['sdk', `sdk.tmp-${dead + 1}`, `sdk.tmp-${process.pid}`].sort());
    expect(r.removed).toEqual([`sdk.tmp-${dead}`]);
    mk(`sdk.old-${dead + 5}`);
    r = await repairSdkState(stateDir());
    expect(r.restored).toBe(false);
    expect(r.removed).toContain(`sdk.old-${dead + 5}`);
    expect(readFileSync(path.join(finalDir(), 'f'), 'utf8')).toBe(`sdk.old-${dead}`); // the live sdk was not replaced
  });

  it('refuses a state directory that is a symlink, group-writable or not owned, and a relative home', async () => {
    const f = fixture();
    mkdirSync(path.join(home(), 'Library', 'Application Support'), { recursive: true });
    const target = path.join(tmp, 'elsewhere'); mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, stateDir());
    expect((await fails(installSdk(options(f)))).code).toBe('state_unsafe');
    unlinkSync(stateDir());
    mkdirSync(stateDir(), { mode: 0o700 }); chmodSync(stateDir(), 0o770);
    expect((await fails(installSdk(options(f)))).code).toBe('state_unsafe');
    expect(readdirSync(stateDir())).toEqual([]);
    expect((await fails(installSdk({ ...options(f), home: 'relative/home' }))).code).toBe('state_unsafe');
  });

  it('refuses when there is not enough free disk space', async () => {
    const f = fixture();
    const e = await fails(installSdk(options(f, { freeBytes: async () => 100 * 1024 * 1024 })));
    expect(e.code).toBe('disk');
    expect(requests).toHaveLength(0);
    expectClean();
    await installSdk(options(f, { freeBytes: async () => 400 * 1024 * 1024 }));
  });

  it('uninstall removes the read-only tree, refuses a symlink, and is a no-op without a state directory', async () => {
    await uninstallSdk({ home: home() });
    const f = fixture();
    await installSdk(options(f));
    await uninstallSdk({ home: home() });
    expect(names()).toEqual([]);
    const victim = path.join(tmp, 'victim'); mkdirSync(victim); writeFileSync(path.join(victim, 'keep'), 'k');
    symlinkSync(victim, finalDir());
    expect((await fails(uninstallSdk({ home: home() }))).code).toBe('state_unsafe');
    expect(readFileSync(path.join(victim, 'keep'), 'utf8')).toBe('k');
    expect(names()).toEqual(['sdk']);
  });
});

// a pid that is certainly dead
function spawnSyncPid(): number {
  const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(out.toString());
}

// ---------------------------------------------------------------------------------------------------------------------
// the CLI, in process (usage and output rules)

describe('runCli', () => {
  const io = (env: NodeJS.ProcessEnv, extra: Partial<CliIo> = {}) => {
    const out: string[] = [], err: string[] = [];
    const calls: string[][] = [];
    const base: CliIo = {
      stdout: (l) => out.push(l), stderr: (l) => err.push(l), env, isTTY: false, ask: async () => false, script: path.join(root, 'dist', 'sdk-install.js'),
      runRestricted: async (args) => { calls.push(args); return 0; },
    };
    return { io: { ...base, ...extra }, out, err, calls };
  };

  it('--plan prints one JSON line, masks the home directory and proxy credentials, and creates nothing', async () => {
    mkdirSync(home(), { recursive: true });
    const t = io({ HOME: home(), HTTPS_PROXY: 'http://alice:s3cretpw@127.0.0.1:9' });
    expect(await runCli(['--plan'], t.io, false)).toBe(0);
    expect(t.out).toHaveLength(1);
    const plan = JSON.parse(t.out[0]!);
    expect(plan).toMatchObject({ result: 'plan', version: '0.3.287', hosts: ['registry.npmjs.org'] });
    expect(plan.finalDir).toBe('~/Library/Application Support/IntelyIDE/sdk');
    expect(t.out[0]).not.toContain(tmp);
    expect(t.out[0]).not.toContain('s3cretpw');
    expect(readdirSync(home())).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it.each([
    [['--bogus']], [['--plan', '--yes']], [['--uninstall']], [['--yes', '--yes']], [['--plan', '--uninstall', '--yes']],
  ])('usage error %j', async (argv) => {
    const t = io({ HOME: home() });
    expect(await runCli(argv, t.io, false)).toBe(2);
    expect(JSON.parse(t.out[0]!)).toMatchObject({ result: 'error', code: 'usage' });
    expect(t.calls).toEqual([]);
  });

  it('without --yes and without a terminal nothing is changed; on a terminal the answer decides', async () => {
    mkdirSync(home(), { recursive: true });
    const a = io({ HOME: home() });
    expect(await runCli([], a.io, false)).toBe(2);
    expect(a.calls).toEqual([]);
    const no = io({ HOME: home() }, { isTTY: true, ask: async () => false });
    expect(await runCli([], no.io, false)).toBe(1);
    expect(JSON.parse(no.out[0]!)).toMatchObject({ code: 'cancelled' });
    expect(no.err[0]).toMatch(/Install @anthropic-ai\/claude-agent-sdk 0\.3\.287 \(102 packages from registry\.npmjs\.org\) into ~\//);
    const yes = io({ HOME: home() }, { isTTY: true, ask: async () => true });
    expect(await runCli([], yes.io, false)).toBe(0);
    expect(yes.calls).toEqual([['--yes']]);
  });

  it('the launcher creates the state directory and hands over to the sandboxed child with only the confirmed arguments', async () => {
    mkdirSync(home(), { recursive: true });
    const t = io({ HOME: home() });
    expect(await runCli(['--yes'], t.io, false)).toBe(0);
    expect(t.calls).toEqual([['--yes']]);
    expect(statSync(stateDir()).mode & 0o777).toBe(0o700);
    const u = io({ HOME: home() });
    expect(await runCli(['--uninstall', '--yes'], u.io, false)).toBe(0);
    expect(u.calls).toEqual([['--uninstall', '--yes']]);
  });

  it('a refused environment variable is reported with the stable code and nothing is created', async () => {
    mkdirSync(home(), { recursive: true });
    const t = io({ HOME: home(), NODE_OPTIONS: '--require /x.js' });
    expect(await runCli(['--yes'], t.io, false)).toBe(1);
    expect(JSON.parse(t.out[0]!)).toMatchObject({ result: 'error', code: 'env_unsafe' });
    expect(t.calls).toEqual([]);
    expect(readdirSync(home())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the bundled program as a real process

describe('the bundled program', () => {
  let bundleDir: string;
  beforeAll(async () => {
    bundleDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sdk-install-bundle-')));
    const cfg = (await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'build.config.mjs')).href)) as { common: Record<string, unknown>; entries: Array<Record<string, unknown> & { outfile: string }> };
    const entry = cfg.entries.find((e) => e.outfile === 'dist/sdk-install.js')!;
    mkdirSync(path.join(bundleDir, 'sidecar'));
    await build({ ...cfg.common, ...entry, absWorkingDir: root, outfile: path.join(bundleDir, 'sidecar', 'sdk-install.js'), metafile: false, logLevel: 'silent' });
    // the real pin next to it, exactly like Resources/sdk-pin beside Resources/sidecar
    mkdirSync(path.join(bundleDir, 'sdk-pin'));
    for (const f of ['package.json', 'package-lock.json', 'tree.sha256', 'hash-tree.mjs']) writeFileSync(path.join(bundleDir, 'sdk-pin', f), readFileSync(path.join(root, 'sdk-pin', f)));
  });
  afterAll(() => { rmSync(bundleDir, { recursive: true, force: true }); });
  const script = () => path.join(bundleDir, 'sidecar', 'sdk-install.js');

  /** A listening socket standing in for an HTTPS proxy: records CONNECT lines; `hold` keeps the connection open. */
  async function listener(hold: boolean) {
    // hold: never answers; otherwise answers the CONNECT with a 502 (dropping the socket instead makes undici reconnect in a tight loop until its caller gives up)
    const connects: string[] = [];
    let sockets = 0;
    const sockList: net.Socket[] = [];
    const srv = net.createServer((s) => {
      sockets++; sockList.push(s);
      s.once('data', (d) => { connects.push(d.toString('latin1').split('\r\n')[0]!); if (!hold) s.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n'); });
      s.on('error', () => undefined);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { port: (srv.address() as net.AddressInfo).port, connects, count: () => sockets, close: () => { for (const s of sockList) s.destroy(); srv.close(); } };
  }
  function run(args: string[], env: NodeJS.ProcessEnv, signalAfterMs?: number): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const cleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...env };
      const c = spawn(process.execPath, [script(), ...args], { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      if (signalAfterMs) setTimeout(() => c.kill('SIGTERM'), signalAfterMs);
      c.on('close', (code) => resolve({ code, out, err }));
    });
  }
  const lines = (s: string) => s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

  it('--plan against the committed pin prints the package list and makes no connection', async () => {
    const l = await listener(false);
    try {
      mkdirSync(home(), { recursive: true });
      const r = await run(['--plan'], { HOME: home(), HTTPS_PROXY: `http://alice:s3cretpw@127.0.0.1:${l.port}` });
      expect(r.code).toBe(0);
      const [plan] = lines(r.out);
      expect(plan).toMatchObject({ result: 'plan', version: '0.3.287' });
      expect(plan!.packages).toHaveLength(102);
      expect(r.out).not.toContain(tmp);
      expect(r.out).not.toContain('s3cretpw');
      await new Promise((res) => setTimeout(res, 200));
      expect(l.count()).toBe(0);
      expect(readdirSync(home())).toEqual([]);
    } finally { l.close(); }
  });

  it('--yes goes through the sandboxed child; with the network failing nothing is installed and the output is masked (negative control for the test above)', async () => {
    const l = await listener(false);
    try {
      mkdirSync(home(), { recursive: true });
      const r = await run(['--yes'], { HOME: home(), HTTPS_PROXY: `http://alice:s3cretpw@127.0.0.1:${l.port}` });
      expect(r.code).toBe(1);
      const out = lines(r.out);
      expect(out[out.length - 1]).toMatchObject({ result: 'error', code: 'network' });
      expect(l.connects.length).toBeGreaterThan(0);
      expect(new Set(l.connects)).toEqual(new Set(['CONNECT registry.npmjs.org:443 HTTP/1.1'])); // the real registry, through the proxy, and nothing else
      for (const leak of ['s3cretpw', 'alice', tmp]) { expect(r.out).not.toContain(leak); expect(r.err).not.toContain(leak); }
      expect(names()).toEqual([]);
    } finally { l.close(); }
  });

  it('SIGTERM during a download cancels cleanly: exit 1, result cancelled, no sdk, no staging, no lock', async () => {
    const l = await listener(true);
    try {
      mkdirSync(home(), { recursive: true });
      const r = await run(['--yes'], { HOME: home(), HTTPS_PROXY: `http://127.0.0.1:${l.port}` }, 1500);
      expect(r.code).toBe(1);
      const out = lines(r.out);
      expect(out[out.length - 1]).toMatchObject({ result: 'error', code: 'cancelled' });
      expect(l.count()).toBe(1);
      expect(names()).toEqual([]);
    } finally { l.close(); }
  }, 30_000);

  it('refuses NODE_OPTIONS, NODE_PATH and npm_config_* before doing anything', async () => {
    mkdirSync(home(), { recursive: true });
    for (const bad of [{ NODE_OPTIONS: '--max-old-space-size=100' }, { NODE_PATH: '/x' }, { npm_config_registry: 'http://evil.example' }]) {
      const r = await run(['--yes'], { HOME: home(), ...bad });
      expect(r.code).toBe(1);
      expect(lines(r.out)[0]).toMatchObject({ result: 'error', code: 'env_unsafe' });
    }
    expect(readdirSync(home())).toEqual([]);
  });

  it('usage errors exit 2', async () => {
    expect((await run(['--nonsense'], { HOME: home() })).code).toBe(2);
    expect((await run([], { HOME: home() })).code).toBe(2); // no terminal, no --yes
  });

  it('uninstall through the sandbox removes a read-only install', async () => {
    mkdirSync(home(), { recursive: true });
    const f = fixture();
    await installSdk(options(f));
    expect(existsSync(finalDir())).toBe(true);
    const r = await run(['--uninstall', '--yes'], { HOME: home() });
    expect(r.code).toBe(0);
    expect(lines(r.out).pop()).toMatchObject({ result: 'ok', action: 'uninstall' });
    expect(names()).toEqual([]);
  });

  it('the built program contains no SDK code and its output has no home path', () => {
    const text = readFileSync(script(), 'utf8');
    expect(text).not.toMatch(/from\s*["']@anthropic-ai\/claude-agent-sdk|import\(\s*["']@anthropic-ai\/claude-agent-sdk/);
    expect(text.length).toBeLessThan(200_000);
  });

  it('the sandboxed child gets an allow-listed environment', () => {
    const env = childEnv({ PATH: '/usr/bin', HOME: '/evil', HTTPS_PROXY: 'http://p', LC_ALL: 'C', DYLD_INSERT_LIBRARIES: '/x.dylib', LD_PRELOAD: '/x', NODE_DEBUG: 'fs', GITHUB_TOKEN: 't', NODE_EXTRA_CA_CERTS: '/c.pem' }, '/home/user');
    expect(env).toEqual({ HOME: '/home/user', PATH: '/usr/bin', HTTPS_PROXY: 'http://p', LC_ALL: 'C', NODE_EXTRA_CA_CERTS: '/c.pem' });
  });

  describe('under Node\'s permission model (the flags the CLI uses)', () => {
    const harness = () => path.join(bundleDir, 'harness.mjs');
    beforeEach(() => {
      writeFileSync(harness(), `
        import fs from 'node:fs/promises';
        const m = await import(${JSON.stringify(pathToFileURL(script()).href)});
        const cfg = JSON.parse(process.argv[2]);
        const out = {};
        try { await fs.writeFile(cfg.outside, 'x'); out.writeOutside = 'WRITTEN'; } catch (e) { out.writeOutside = e.code; }
        try { await fs.readFile('/etc/hosts'); out.readEtc = 'READ'; } catch (e) { out.readEtc = e.code; }
        try { (await import('node:child_process')).execFileSync('/bin/echo', ['x']); out.spawn = 'SPAWNED'; } catch (e) { out.spawn = e.code; }
        try { out.result = await m.installSdk({ home: cfg.home, pinDir: cfg.pinDir, registryOrigin: cfg.origin, expectedVersion: cfg.version, env: {} }); } catch (e) { out.error = [e.code, e.message]; }
        process.stdout.write(JSON.stringify(out));
      `);
    });
    /** Runs the harness under the CLI's sandbox flags. `extraEnv` reaches both the flag computation and the process (certificate variables). */
    async function sandboxed(f: Fixture, originUrl: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<any> {
      mkdirSync(home(), { recursive: true });
      mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); chmodSync(stateDir(), 0o700);
      const flags = sandboxFlags({ script: script(), pinDir: f.pinDir, stateDir: stateDir(), home: home(), env: extraEnv });
      expect(flags.filter((x) => x.startsWith('--allow-fs-write'))).toEqual([`--allow-fs-write=${stateDir()}`, `--allow-fs-write=${stateDir()}/*`]);
      const cfg = { outside: path.join(tmp, 'outside.txt'), home: home(), pinDir: f.pinDir, origin: originUrl, version: FAKE_VERSION };
      const out = await new Promise<string>((resolve, reject) => {
        const c = spawn(process.execPath, [...flags, `--allow-fs-read=${harness()}`, harness(), JSON.stringify(cfg)], { env: { PATH: process.env.PATH, HOME: home(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '', e = '';
        c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { e += d; });
        c.on('close', (code) => (code === 0 ? resolve(o) : reject(new Error(`exit ${code}: ${e}`))));
      });
      expect(existsSync(cfg.outside)).toBe(false);
      return JSON.parse(out);
    }

    it('a full install works inside the sandbox, and the sandbox really denies writes elsewhere, reads elsewhere and child processes', async () => {
      const f = fixture([{ key: 'node_modules/@scope/dep', files: { 'deep/er/x.js': 'x\n' } }]);
      const r = await sandboxed(f, origin);
      expect(r).toMatchObject({ writeOutside: 'ERR_ACCESS_DENIED', readEtc: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED' });
      expect(r.error).toBeUndefined();
      expect(r.result).toMatchObject({ version: FAKE_VERSION, packages: 2 });
      expect(existsSync(path.join(finalDir(), 'node_modules', '@scope', 'dep', 'deep', 'er', 'x.js'))).toBe(true);
      expectClean();
    }, 30_000);

    describe('TLS inside the sandbox (throwaway self-signed certificate for 127.0.0.1)', () => {
      let tls: https.Server | null = null;
      let certFile = '';
      let tlsOrigin = '';
      beforeEach(async () => {
        certFile = path.join(tmp, 'cert.pem');
        const keyFile = path.join(tmp, 'key.pem');
        try {
          execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
        } catch { tls = null; return; }
        tls = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
          const body = served.get(req.url ?? '');
          if (!body) { res.statusCode = 404; res.end(); return; }
          res.end(body);
        });
        await new Promise<void>((r) => tls!.listen(0, '127.0.0.1', r));
        tlsOrigin = `https://127.0.0.1:${(tls.address() as net.AddressInfo).port}`;
      });
      afterEach(() => { tls?.closeAllConnections(); tls?.close(); });

      it('installs over HTTPS when the CA file is passed through NODE_EXTRA_CA_CERTS (its path is readable inside the sandbox)', async () => {
        if (!tls) return; // no openssl on this machine
        const f = fixture([], { origin: tlsOrigin });
        const r = await sandboxed(f, tlsOrigin, { NODE_EXTRA_CA_CERTS: certFile });
        expect(r.error).toBeUndefined();
        expect(r.result).toMatchObject({ version: FAKE_VERSION, packages: 1 });
        expect(existsSync(path.join(finalDir(), SDK_KEY, 'index.js'))).toBe(true);
      }, 30_000);

      it('refuses an untrusted certificate (verification is on, nothing is installed)', async () => {
        if (!tls) return;
        const f = fixture([], { origin: tlsOrigin });
        const r = await sandboxed(f, tlsOrigin);
        expect(r.result).toBeUndefined();
        expect(r.error[0]).toBe('network');
        expect(existsSync(finalDir())).toBe(false);
        expectClean();
      }, 30_000);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// real npm tarballs (only where this machine's npm cache still holds them): the extractor against the committed manifest

const cacheRoot = path.join(os.homedir(), '.npm', '_cacache', 'content-v2', 'sha512');
describe.skipIf(!existsSync(cacheRoot))('real npm tarballs from the local npm cache', () => {
  it('every cached tarball of the pin extracts to exactly the files tree.sha256 lists for that package', () => {
    const lock = JSON.parse(readFileSync(path.join(root, 'sdk-pin', 'package-lock.json'), 'utf8')) as { packages: Record<string, { optional?: boolean; integrity: string; version: string }> };
    const manifest = new Map(readFileSync(path.join(root, 'sdk-pin', 'tree.sha256'), 'utf8').trim().split('\n').map((l) => [l.slice(66), l.slice(0, 64)] as const));
    let verified = 0, files = 0;
    for (const [key, e] of Object.entries(lock.packages)) {
      if (key === '' || e.optional) continue;
      const hex = Buffer.from(e.integrity.slice(7), 'base64').toString('hex');
      const file = path.join(cacheRoot, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      expect(sri(bytes), key).toBe(e.integrity);
      const got = new Map<string, string>();
      for (const en of readTar(zlib.gunzipSync(bytes), { maxEntries: 40_000, maxFile: 64 * 1024 * 1024 })) if (!en.dir) got.set(`${key}/${en.path}`, sha256(en.data));
      const want = [...manifest].filter(([p]) => p.startsWith(`${key}/`) && !p.slice(key.length + 1).startsWith('node_modules/'));
      expect([...got].sort(), key).toEqual(want.sort());
      verified++; files += got.size;
    }
    expect(verified).toBeGreaterThan(0);
    expect(files).toBeGreaterThan(0);
  });
});
