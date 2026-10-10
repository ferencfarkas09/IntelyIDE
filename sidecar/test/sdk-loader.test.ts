// Verified loader for the proprietary Claude Agent SDK (src/sdk.ts, (design notes: licensing-spec) section 6). Everything runs
// against the fake SDK in fixtures/fake-sdk copied into a throwaway directory; no network, no model call, no env switch.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPackagedPath, loadSdk, parseManifest, resetSdkCache, SDK_NAME, SDK_PIN, SdkBrokenError, SdkError, SdkIncompatibleError, SdkMissingError, sdkReport, sdkSetupHint, SdkUnverifiedError, STATE_DIR_NAME, stateDirOf,
  treeLines, type LoadOptions,
} from '../src/sdk.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-sdk', import.meta.url));
const FAKE_PIN = '0.0.0-fake';
const PKG = path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk');

let tmp: string;
const logs: string[] = [];

/** `<tmp>/state/sdk` holding the fake tree with deterministic modes (git does not keep them), plus its manifest. */
function stage(name = 'state'): { dir: string; manifest: string; opts: LoadOptions } {
  const state = path.join(tmp, name);
  const dir = path.join(state, 'sdk');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  cpSync(FAKE, dir, { recursive: true });
  cpSync(path.join(dir, 'modules'), path.join(dir, 'node_modules'), { recursive: true });
  rmSync(path.join(dir, 'modules'), { recursive: true });
  const fix = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) { chmodSync(f, 0o755); fix(f); } else chmodSync(f, 0o644);
    }
  };
  chmodSync(state, 0o700);
  chmodSync(dir, 0o755);
  fix(dir);
  return { dir, manifest: '', opts: { dir, pin: FAKE_PIN, checkoutDir: null, log: (l) => logs.push(l) } };
}
async function staged(name?: string) {
  const s = stage(name);
  s.manifest = `${(await treeLines(s.dir)).join('\n')}\n`;
  s.opts.manifest = s.manifest;
  return s;
}

/** A verified install at `<home>/Library/Application Support/<stateName>/sdk` (fake tree, deterministic modes) and its manifest. */
async function stageHome(home: string, stateName = STATE_DIR_NAME, platform: NodeJS.Platform = 'darwin'): Promise<{ state: string; dir: string; manifest: string }> {
  const state = path.join(path.dirname(stateDirOf(home, platform)), stateName);
  const dir = path.join(state, 'sdk');
  mkdirSync(state, { recursive: true });
  for (let p = state; p !== tmp; p = path.dirname(p)) chmodSync(p, 0o755);
  chmodSync(state, 0o700);
  cpSync(FAKE, dir, { recursive: true });
  cpSync(path.join(dir, 'modules'), path.join(dir, 'node_modules'), { recursive: true });
  rmSync(path.join(dir, 'modules'), { recursive: true });
  const fix = (p: string) => { for (const e of readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) { chmodSync(f, 0o755); fix(f); } else chmodSync(f, 0o644); } };
  chmodSync(dir, 0o755);
  fix(dir);
  return { state, dir, manifest: `${(await treeLines(dir)).join('\n')}\n` };
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sdk-loader-')));
  logs.length = 0;
  resetSdkCache();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(tmp, { recursive: true, force: true }); delete process.env.INTELY_SDK_DIR; });

describe('verified install (<state dir>/sdk)', () => {
  it('loads a tree that matches the manifest, reports version and file count, and memoizes only the success', async () => {
    const s = await staged();
    const sdk = (await loadSdk(s.opts)) as unknown as { fakeSdk: boolean; depSeen: string };
    expect(sdk.fakeSdk).toBe(true);
    expect(sdk.depSeen).toBe('fake-dep@1.0.0'); // the transitive dependency resolves inside the verified tree
    expect(sdkReport()).toMatchObject({ version: FAKE_PIN, source: 'verified', files: 6 });
    expect(typeof sdkReport()?.verifyMs).toBe('number');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[sdk\] @anthropic-ai\/claude-agent-sdk 0\.0\.0-fake verified \(6 files, \d+ ms\)$/);
    expect(logs[0]).not.toContain(tmp);
    expect(await loadSdk(s.opts)).toBe(sdk);
    expect(logs).toHaveLength(1); // not re-hashed
  });

  it('a failed load is not cached: Re-check works once the SDK appears', async () => {
    const state = path.join(tmp, 'state');
    const dir = path.join(state, 'sdk');
    const opts: LoadOptions = { dir, pin: FAKE_PIN, checkoutDir: null, log: () => {} };
    await expect(loadSdk(opts)).rejects.toBeInstanceOf(SdkMissingError);
    await expect(loadSdk(opts)).rejects.toMatchObject({ code: 'sdk_missing' });
    const s = await staged();
    expect(await loadSdk({ ...s.opts, log: () => {} })).toBeTruthy();
  });

  it('every error message carries the stable code prefix', async () => {
    const e = await loadSdk({ dir: path.join(tmp, 'nope'), checkoutDir: null }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkError);
    expect(e.message).toMatch(/^sdk_missing: /);
  });

  it('refuses a different version (sdk_incompatible), before hashing anything', async () => {
    const s = await staged();
    const e = await loadSdk({ ...s.opts, pin: '9.9.9' }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkIncompatibleError);
    expect(e.message).toMatch(/^sdk_incompatible: found .* 0\.0\.0-fake, this build needs exactly 9\.9\.9$/);
  });

  it('refuses a tampered file (hash mismatch) and names the relative path only', async () => {
    const s = await staged();
    const file = path.join(s.dir, PKG, 'sdk.mjs');
    writeFileSync(file, `${'// '.repeat(1)}tampered\nexport const query = () => { process.exit(0); };\n`);
    const e = await loadSdk(s.opts).catch((x) => x);
    expect(e).toBeInstanceOf(SdkUnverifiedError);
    expect(e.message).toBe(`sdk_unverified: file ${PKG.split(path.sep).join('/')}/sdk.mjs does not match the pinned tree`);
    expect(e.message).not.toContain(tmp);
  });

  it('refuses a tampered dependency, an extra file and a missing file', async () => {
    let s = await staged('a');
    writeFileSync(path.join(s.dir, 'node_modules', 'fake-dep', 'index.mjs'), 'export const dep = "evil";\n');
    await expect(loadSdk(s.opts)).rejects.toThrow(/sdk_unverified: file node_modules\/fake-dep\/index\.mjs does not match/);

    s = await staged('b');
    writeFileSync(path.join(s.dir, 'node_modules', 'fake-dep', 'extra.mjs'), 'export {};\n');
    await expect(loadSdk(s.opts)).rejects.toThrow(/sdk_unverified: unexpected file node_modules\/fake-dep\/extra\.mjs/);

    s = await staged('c');
    rmSync(path.join(s.dir, 'node_modules', 'fake-dep', 'index.mjs'));
    await expect(loadSdk(s.opts)).rejects.toThrow(/sdk_unverified: file node_modules\/fake-dep\/index\.mjs of the pinned tree is missing/);
  });

  it('refuses a malformed, empty or duplicated manifest', async () => {
    const s = await staged();
    await expect(loadSdk({ ...s.opts, manifest: 'garbage\n' })).rejects.toThrow(/sdk_unverified: the pin manifest is malformed/);
    await expect(loadSdk({ ...s.opts, manifest: '' })).rejects.toThrow(/sdk_unverified: the pin manifest is empty/);
    const dup = `${s.manifest}${s.manifest.split('\n')[0]}\n`;
    await expect(loadSdk({ ...s.opts, manifest: dup })).rejects.toThrow(/malformed/);
    expect(() => parseManifest(`${'0'.repeat(64)} x\n`)).toThrow(SdkUnverifiedError); // one space only
  });

  it('without a manifest next to the sidecar it fails closed', async () => {
    const s = await staged();
    const { manifest: _m, ...rest } = s.opts;
    // the real sdk-pin/tree.sha256 describes the real SDK, not the fake one: also unverified
    await expect(loadSdk(rest)).rejects.toBeInstanceOf(SdkUnverifiedError);
  });

  it('refuses the sdk directory as a symlink, even to a perfectly good tree', async () => {
    const good = await staged('good');
    const state = path.join(tmp, 'linked');
    mkdirSync(state, { mode: 0o700 });
    symlinkSync(good.dir, path.join(state, 'sdk'));
    const e = await loadSdk({ ...good.opts, dir: path.join(state, 'sdk') }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkUnverifiedError);
    expect(e.message).toMatch(/symbolic link/);
  });

  it('refuses a state directory that is itself a symlink, even to a perfectly good tree', async () => {
    const good = await staged('real');
    const alias = path.join(tmp, 'alias');
    symlinkSync(path.dirname(good.dir), alias);
    const e = await loadSdk({ ...good.opts, dir: path.join(alias, 'sdk') }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkUnverifiedError);
    expect(e.message).toMatch(/state directory is a symbolic link/);
  });

  it('accepts a symlinked ancestor of the state directory (home or Application Support aliases)', async () => {
    const good = await staged('real2');
    const alias = path.join(tmp, 'alias2');
    symlinkSync(path.dirname(path.dirname(good.dir)), alias);
    expect(await loadSdk({ ...good.opts, dir: path.join(alias, path.basename(path.dirname(good.dir)), 'sdk') })).toBeTruthy();
  });

  it('refuses a symlink or special file inside the tree', async () => {
    const s = await staged();
    symlinkSync('/etc/hosts', path.join(s.dir, 'node_modules', 'fake-dep', 'link.mjs'));
    await expect(loadSdk(s.opts)).rejects.toThrow(/sdk_unverified: unexpected entry \(symlink or special file\): node_modules\/fake-dep\/link\.mjs/);
  });

  it('refuses a group- or world-writable directory or file', async () => {
    let s = await staged('a');
    chmodSync(s.dir, 0o775);
    await expect(loadSdk(s.opts)).rejects.toThrow(/the SDK directory is writable by group or others/);

    s = await staged('b');
    chmodSync(path.join(s.dir, 'node_modules', 'fake-dep', 'index.mjs'), 0o666);
    await expect(loadSdk(s.opts)).rejects.toThrow(/file node_modules\/fake-dep\/index\.mjs is writable by group or others/);

    s = await staged('c');
    chmodSync(path.join(s.dir, 'node_modules', 'fake-dep'), 0o757);
    await expect(loadSdk(s.opts)).rejects.toThrow(/directory node_modules\/fake-dep is writable by group or others/);

    s = await staged('d');
    chmodSync(path.dirname(s.dir), 0o770);
    await expect(loadSdk(s.opts)).rejects.toThrow(/the state directory is writable by group or others/);
  });

  it('refuses a directory (or file) owned by another user', async () => {
    const s = await staged();
    const real = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(real + 1);
    const e = await loadSdk(s.opts).catch((x) => x);
    expect(e).toBeInstanceOf(SdkUnverifiedError);
    expect(e.message).toBe('sdk_unverified: the SDK directory is not owned by the current user');
  });

  it('ignores npm\'s own node_modules/.bin and .package-lock.json, nothing else', async () => {
    const s = await staged();
    mkdirSync(path.join(s.dir, 'node_modules', '.bin'));
    symlinkSync('../fake-dep/index.mjs', path.join(s.dir, 'node_modules', '.bin', 'fake'));
    writeFileSync(path.join(s.dir, 'node_modules', '.package-lock.json'), '{}');
    expect(await loadSdk(s.opts)).toBeTruthy();
    writeFileSync(path.join(s.dir, 'node_modules', '.other'), '{}');
    resetSdkCache();
    await expect(loadSdk(s.opts)).rejects.toThrow(/unexpected file node_modules\/\.other/);
  });

  it('a package.json that is not the SDK is sdk_broken, a missing one sdk_missing', async () => {
    const s = await staged();
    writeFileSync(path.join(s.dir, PKG, 'package.json'), '{ "name": "something-else", "version": "1.0.0" }');
    await expect(loadSdk(s.opts)).rejects.toBeInstanceOf(SdkBrokenError);
    rmSync(path.join(s.dir, PKG), { recursive: true });
    await expect(loadSdk(s.opts)).rejects.toBeInstanceOf(SdkMissingError);
  });
});

describe('no environment switch', () => {
  it('INTELY_SDK_DIR (and any similar variable) is never read: a valid tree there is still "missing"', async () => {
    const s = await staged();
    process.env.INTELY_SDK_DIR = s.dir;
    process.env.CLAUDE_AGENT_SDK_DIR = s.dir;
    const emptyHome = path.join(tmp, 'home');
    mkdirSync(emptyHome);
    const e = await loadSdk({ checkoutDir: null, home: emptyHome, manifest: s.manifest, pin: FAKE_PIN }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkMissingError);
  });

  it('the default location is <home>/Library/Application Support/IntelyIDE/sdk and nothing else', async () => {
    expect(STATE_DIR_NAME).toBe('IntelyIDE');
    const home = path.join(tmp, 'home');
    const { manifest } = await stageHome(home);
    expect(await loadSdk({ checkoutDir: null, home, manifest, pin: FAKE_PIN, log: () => {} })).toBeTruthy();
  });

  it('state dir: macOS keeps Library/Application Support, Linux uses ~/.local/share, from the home only', () => {
    expect(stateDirOf('/Users/u', 'darwin')).toBe('/Users/u/Library/Application Support/IntelyIDE');
    expect(stateDirOf('/home/u', 'linux')).toBe('/home/u/.local/share/IntelyIDE');
    const saved = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = '/elsewhere';
    try { expect(stateDirOf('/home/u', 'linux')).toBe('/home/u/.local/share/IntelyIDE'); } finally { if (saved === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved; }
    expect(stateDirOf('/Users/u')).toBe(stateDirOf('/Users/u', process.platform));
  });

  it('linux: the verified install is looked for at <home>/.local/share/IntelyIDE/sdk, and only there', async () => {
    const home = path.join(tmp, 'home');
    const { manifest } = await stageHome(home, STATE_DIR_NAME, 'linux');
    expect(await loadSdk({ checkoutDir: null, home, platform: 'linux', manifest, pin: FAKE_PIN, log: () => {} })).toBeTruthy();
    resetSdkCache();
    const e = await loadSdk({ checkoutDir: null, home, platform: 'darwin', manifest, pin: FAKE_PIN, log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkMissingError); // the macOS location is empty
  });

  it('the pre-rename state directory IntelySwitchIDE is never looked at', async () => {
    const home = path.join(tmp, 'home');
    const { manifest } = await stageHome(home, 'IntelySwitchIDE');
    const e = await loadSdk({ checkoutDir: null, home, manifest, pin: FAKE_PIN, log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkMissingError);
  });

  it('the loader source contains no process.env access', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(fileURLToPath(new URL('../src/sdk.ts', import.meta.url)), 'utf8');
    expect(src.replace(/\/\/.*$/gm, '')).not.toMatch(/process\.env|INTELY_SDK_DIR/);
  });
});

describe('source checkout (pnpm lockfile is the integrity source)', () => {
  it('the real repo checkout resolves by explicit path and is the pinned version', async () => {
    const sdk = await loadSdk({ log: () => {} });
    expect(typeof sdk.query).toBe('function');
    expect(typeof sdk.listSessions).toBe('function');
    expect(sdkReport()).toMatchObject({ version: SDK_PIN, source: 'checkout' });
  });

  it('follows a symlinked package directory (pnpm layout) and checks the version', async () => {
    // pnpm layout: the checkout path is a symlink to a package whose dependencies are its siblings
    const nm = path.join(tmp, 'store2', 'node_modules');
    mkdirSync(path.join(nm, '@anthropic-ai'), { recursive: true });
    cpSync(path.join(FAKE, 'modules', '@anthropic-ai', 'claude-agent-sdk'), path.join(nm, '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
    cpSync(path.join(FAKE, 'modules', 'fake-dep'), path.join(nm, 'fake-dep'), { recursive: true });
    const link2 = path.join(tmp, 'checkout2');
    symlinkSync(path.join(nm, '@anthropic-ai', 'claude-agent-sdk'), link2);
    const ok = (await loadSdk({ checkoutDir: link2, pin: FAKE_PIN, log: () => {} })) as unknown as { fakeSdk: boolean };
    expect(ok.fakeSdk).toBe(true);
    expect(sdkReport()?.source).toBe('checkout');
    resetSdkCache();
    await expect(loadSdk({ checkoutDir: link2, pin: '1.2.3', log: () => {} })).rejects.toBeInstanceOf(SdkIncompatibleError);
  });

  it('a dangling link or an absent checkout falls back to the (absent) install: sdk_missing', async () => {
    symlinkSync(path.join(tmp, 'gone'), path.join(tmp, 'dangling'));
    await expect(loadSdk({ checkoutDir: path.join(tmp, 'dangling'), home: path.join(tmp, 'h'), log: () => {} })).rejects.toBeInstanceOf(SdkMissingError);
    resetSdkCache();
    await expect(loadSdk({ checkoutDir: path.join(tmp, 'absent'), home: path.join(tmp, 'h'), log: () => {} })).rejects.toBeInstanceOf(SdkMissingError);
  });

  it('a missing transitive dependency is sdk_broken naming the dependency, not sdk_missing', async () => {
    const nm = path.join(tmp, 'broken', 'node_modules');
    const pkg = path.join(nm, '@anthropic-ai', 'claude-agent-sdk');
    mkdirSync(path.dirname(pkg), { recursive: true });
    cpSync(path.join(FAKE, 'modules', '@anthropic-ai', 'claude-agent-sdk'), pkg, { recursive: true }); // fake-dep deliberately absent
    const e = await loadSdk({ checkoutDir: pkg, pin: FAKE_PIN, log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkBrokenError);
    expect(e.message).toBe('sdk_broken: dependency fake-dep is missing from the SDK install');
  });

  it('an entry that throws is sdk_broken with a masked message', async () => {
    const pkg = path.join(tmp, 'throws', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: SDK_NAME, version: FAKE_PIN, type: 'module', exports: { '.': { default: './sdk.mjs' } } }));
    writeFileSync(path.join(pkg, 'sdk.mjs'), `throw new Error('boom at ${os.homedir()}/secret token=abcdef123456');\n`);
    const e = await loadSdk({ checkoutDir: pkg, pin: FAKE_PIN, log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkBrokenError);
    expect(e.message).not.toContain(os.homedir());
    expect(e.message).not.toContain('abcdef123456');
  });
});

describe('fail closed', () => {
  afterEach(() => { vi.doUnmock('../src/sdk.js'); vi.resetModules(); });

  async function withMissingSdk() {
    vi.resetModules();
    vi.doMock('../src/sdk.js', async (orig) => {
      const m = await orig<typeof import('../src/sdk.js')>(); // its own error classes: the module was reset, so instanceof needs the same instance
      return { ...m, loadSdk: () => Promise.reject(new m.SdkMissingError('not installed')) };
    });
  }

  it('a Claude session does not start without the SDK: nothing is built, spawned or registered', async () => {
    await withMissingSdk();
    const { ClaudeSession } = await import('../src/adapters/claude-sdk/session.js');
    const host = { registerPid: vi.fn(), unregisterPid: vi.fn() } as never;
    const sink = { emit: vi.fn() } as never;
    const spec = {
      agentId: 'a', provider: 'claude', cwd: tmp, addDirs: [], mcp: {}, env: { claudeBin: '/bin/echo' },
      auth: { mode: 'subscription', key: null }, role: { permission: 'readOnly', model: 'haiku', tools: [] },
    } as never;
    await expect(ClaudeSession.open(spec, sink, {} as never, host)).rejects.toThrow(/^sdk_missing: not installed$/);
    expect((host as { registerPid: ReturnType<typeof vi.fn> }).registerPid).not.toHaveBeenCalled();
    expect((sink as { emit: ReturnType<typeof vi.fn> }).emit).not.toHaveBeenCalled();
  });

  it('detect keeps installed:true and reports the prefixed message; listModels refuses', async () => {
    await withMissingSdk();
    const { default: provider } = await import('../src/adapters/claude-sdk/index.js');
    const ctx = { claudeBin: process.execPath } as never;
    const d = await provider.detect(ctx);
    expect(d).toMatchObject({ installed: true, auth: 'unknown', message: 'sdk_missing: not installed' });
    await expect(provider.listModels(ctx)).rejects.toThrow(/^sdk_missing:/);
  });

  it('history requests report the error and the next request tries again (a failure is not cached)', async () => {
    await withMissingSdk();
    const { HistoryService } = await import('../src/history.js');
    const handlers: Record<string, (b: unknown) => Promise<unknown>> = {};
    new HistoryService({ on: (k: string, f: (b: unknown) => Promise<unknown>) => { handlers[k] = f; } } as never);
    await expect(handlers['history/list']!({})).resolves.toMatchObject({ error: 'history', detail: 'sdk_missing: not installed' });
    await expect(handlers['history/list']!({})).resolves.toMatchObject({ error: 'history', detail: 'sdk_missing: not installed' });
  });
});

describe('tree hashing parity with sdk-pin/hash-tree.mjs', () => {
  it('the human script and the loader produce the same manifest for one tree', async () => {
    const s = await staged();
    mkdirSync(path.join(s.dir, 'node_modules', '.bin'));
    writeFileSync(path.join(s.dir, 'node_modules', '.package-lock.json'), '{}');
    const mod = (await import(/* @vite-ignore */ pathToFileURL(fileURLToPath(new URL('../sdk-pin/hash-tree.mjs', import.meta.url))).href)) as { manifestOf(d: string): string };
    expect(mod.manifestOf(s.dir)).toBe(`${(await treeLines(s.dir)).join('\n')}\n`);
    expect(mod.manifestOf(s.dir)).toBe(s.manifest);
  });
});

// PK18 / (design notes: release-packaging-spec) 5.5: in the packaged app (sidecar under *.app/Contents/Resources) the source-checkout
// branch does not exist. A Resources/node_modules copy of the SDK has no tree hash, so it must never be imported.
describe('packaged mode (PK18)', () => {
  /** `<tmp>/IntelyIDE.app/Contents/Resources` with sdk-pin/tree.sha256 and, optionally, a planted node_modules SDK. */
  function bundle(manifest: string | null, plantCheckout: boolean, planted = FAKE_PIN) {
    const res = path.join(tmp, 'IntelyIDE.app', 'Contents', 'Resources');
    mkdirSync(path.join(res, 'sidecar'), { recursive: true });
    if (manifest !== null) {
      mkdirSync(path.join(res, 'sdk-pin'));
      writeFileSync(path.join(res, 'sdk-pin', 'tree.sha256'), manifest);
    }
    if (plantCheckout) {
      const pkg = path.join(res, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
      cpSync(path.join(FAKE, 'modules', '@anthropic-ai', 'claude-agent-sdk'), pkg, { recursive: true });
      cpSync(path.join(FAKE, 'modules', 'fake-dep'), path.join(res, 'node_modules', 'fake-dep'), { recursive: true });
      if (planted !== FAKE_PIN) writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: SDK_NAME, version: planted, type: 'module', exports: { '.': { default: './sdk.mjs' } } }));
    }
    return res;
  }
  const emptyHome = () => { const h = path.join(tmp, 'home'); mkdirSync(h, { recursive: true }); return h; };

  it('isPackagedPath: only a location inside <name>.app/Contents/Resources counts', () => {
    expect(isPackagedPath('/Applications/IntelyIDE.app/Contents/Resources/sidecar/index.js')).toBe(true);
    expect(isPackagedPath('/Users/x/Downloads/Some Name.app/Contents/Resources/sidecar/sdk-install.js')).toBe(true);
    expect(isPackagedPath('/Applications/IntelyIDE.APP/Contents/Resources/sidecar/index.js')).toBe(true); // case-insensitive volumes: stricter is safe
    expect(isPackagedPath('/Applications/IntelyIDE.app/Contents/MacOS/node')).toBe(false);
    expect(isPackagedPath('/Applications/IntelyIDE.app/Contents/Resources')).toBe(false);
    expect(isPackagedPath('/Applications/.app/Contents/Resources/x.js')).toBe(false);
    expect(isPackagedPath('/Applications/IntelyIDE.app.evil/Contents/Resources/x.js')).toBe(false);
    expect(isPackagedPath('/Users/x/repo/sidecar/dist/index.js')).toBe(false);
    // the layout Setup uploads to a Linux server: <dir>/.intely/<version>/resources/sidecar/...
    expect(isPackagedPath('/home/u/.intely/1.2.0/resources/sidecar/index.js')).toBe(true);
    expect(isPackagedPath('/root/.intely/1.2.0-rc.1/resources/sidecar/sdk-install.js')).toBe(true);
    expect(isPackagedPath('/home/u/.intely/1.2.0/resources/sidecar')).toBe(false);
    expect(isPackagedPath('/home/u/.intely/resources/sidecar/index.js')).toBe(false);
    expect(isPackagedPath('/home/u/.intely/1.2.0/resources/sdk-pin/x')).toBe(false);
    expect(isPackagedPath('/home/u/.intely/a/b/resources/sidecar/index.js')).toBe(false);
    expect(isPackagedPath('/home/u/intely/1.2.0/resources/sidecar/index.js')).toBe(false);
    expect(isPackagedPath('/home/u/.intely2/1.2.0/resources/sidecar/index.js')).toBe(false);
    expect(isPackagedPath('/home/u/x.intely/1.2.0/resources/sidecar/index.js')).toBe(false);
    expect(isPackagedPath('/home/u/.intely/1.2.0/Resources/sidecar/index.js')).toBe(false); // Linux is case-sensitive
    expect(isPackagedPath('/home/u/.intely/../x/resources/sidecar/index.js')).toBe(false); // resolved first
    expect(isPackagedPath(fileURLToPath(new URL('../src/sdk.ts', import.meta.url)))).toBe(false); // the tests themselves run as a source checkout
  });

  it('packaged:true ignores a Resources/node_modules SDK of the right version and reports sdk_missing', async () => {
    const res = bundle('x', true);
    const e = await loadSdk({ packaged: true, sidecarDir: res, home: emptyHome(), pin: FAKE_PIN, log: (l) => logs.push(l) }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkMissingError);
    expect(e.message).toBe(`sdk_missing: ${SDK_NAME} ${FAKE_PIN} is not installed`);
    expect(sdkReport()).toBeNull();
    expect(logs).toEqual([]); // nothing was accepted and logged as "source checkout"
  });

  it('the same planted tree IS accepted with packaged:false (the source-checkout branch is unchanged)', async () => {
    const res = bundle('x', true);
    const sdk = (await loadSdk({ packaged: false, sidecarDir: res, home: emptyHome(), pin: FAKE_PIN, log: () => {} })) as unknown as { fakeSdk: boolean };
    expect(sdk.fakeSdk).toBe(true);
    expect(sdkReport()?.source).toBe('checkout');
  });

  it('packaged:true ignores an explicit checkoutDir too (no caller can re-enable the branch)', async () => {
    const res = bundle('x', true);
    const checkoutDir = path.join(res, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    await expect(loadSdk({ packaged: true, checkoutDir, sidecarDir: res, home: emptyHome(), pin: FAKE_PIN, log: () => {} })).rejects.toBeInstanceOf(SdkMissingError);
  });

  it('a planted tree of the WRONG version is not even reported as incompatible: it is never looked at', async () => {
    const res = bundle('x', true, '9.9.9');
    const e = await loadSdk({ packaged: true, sidecarDir: res, home: emptyHome(), pin: FAKE_PIN, log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkMissingError);
  });

  it('a symlinked Resources/node_modules SDK is ignored as well', async () => {
    const res = bundle('x', false);
    const real = path.join(tmp, 'elsewhere', 'sdk');
    cpSync(path.join(FAKE, 'modules'), path.join(tmp, 'elsewhere', 'nm'), { recursive: true });
    mkdirSync(path.join(res, 'node_modules', '@anthropic-ai'), { recursive: true });
    symlinkSync(path.join(tmp, 'elsewhere', 'nm', '@anthropic-ai', 'claude-agent-sdk'), path.join(res, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'));
    expect(real).toBeTruthy();
    await expect(loadSdk({ packaged: true, sidecarDir: res, home: emptyHome(), pin: FAKE_PIN, log: () => {} })).rejects.toBeInstanceOf(SdkMissingError);
  });

  it('with a planted Resources tree AND a good install under the home, the verified install is the one used', async () => {
    const home = path.join(tmp, 'home');
    const h = await stageHome(home);
    const res = bundle(h.manifest, true); // manifest read from <Resources>/sdk-pin/tree.sha256, no `manifest` option
    const sdk = (await loadSdk({ packaged: true, sidecarDir: res, home, pin: FAKE_PIN, log: (l) => logs.push(l) })) as unknown as { fakeSdk: boolean };
    expect(sdk.fakeSdk).toBe(true);
    expect(sdkReport()).toMatchObject({ version: FAKE_PIN, source: 'verified', files: 6 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/verified \(6 files, \d+ ms\)$/);
    expect(logs[0]).not.toMatch(/source checkout/);
  });

  it('a tampered install is refused (sdk_unverified) and the planted Resources tree is no fallback', async () => {
    const home = path.join(tmp, 'home');
    const h = await stageHome(home);
    const res = bundle(h.manifest, true);
    writeFileSync(path.join(h.dir, PKG, 'sdk.mjs'), 'export const query = () => { process.exit(0); };\n');
    const e = await loadSdk({ packaged: true, sidecarDir: res, home, pin: FAKE_PIN, log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkUnverifiedError);
    expect(e.message).toBe(`sdk_unverified: file ${PKG.split(path.sep).join('/')}/sdk.mjs does not match the pinned tree`);
    expect(e.message).not.toContain(tmp);
    expect(sdkReport()).toBeNull();
  });

  it('an unverified install (extra file, missing file, symlink, group-writable) is refused, never downgraded to the planted tree', async () => {
    for (const [i, tweak] of [
      (d: string) => writeFileSync(path.join(d, 'node_modules', 'fake-dep', 'extra.mjs'), 'export {};\n'),
      (d: string) => rmSync(path.join(d, 'node_modules', 'fake-dep', 'index.mjs')),
      (d: string) => symlinkSync('/etc/hosts', path.join(d, 'node_modules', 'fake-dep', 'link.mjs')),
      (d: string) => chmodSync(path.join(d, 'node_modules', 'fake-dep', 'index.mjs'), 0o666),
    ].entries()) {
      resetSdkCache();
      const home = path.join(tmp, `home${i}`);
      const h = await stageHome(home);
      const res = path.join(tmp, `res${i}`);
      mkdirSync(path.join(res, 'sdk-pin'), { recursive: true });
      writeFileSync(path.join(res, 'sdk-pin', 'tree.sha256'), h.manifest);
      cpSync(path.join(FAKE, 'modules'), path.join(res, 'node_modules'), { recursive: true });
      tweak(h.dir);
      const e = await loadSdk({ packaged: true, sidecarDir: res, home, pin: FAKE_PIN, log: () => {} }).catch((x) => x);
      expect(e, `case ${i}`).toBeInstanceOf(SdkUnverifiedError);
    }
  });

  it('a symlinked sdk directory is refused in packaged mode', async () => {
    const home = path.join(tmp, 'home');
    const h = await stageHome(home);
    const moved = path.join(tmp, 'moved');
    renameSync(h.dir, moved);
    symlinkSync(moved, h.dir);
    const res = bundle(h.manifest, false);
    const e = await loadSdk({ packaged: true, sidecarDir: res, home, pin: FAKE_PIN, log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkUnverifiedError);
    expect(e.message).toMatch(/symbolic link/);
  });

  it('a missing pin manifest in the bundle fails closed (sdk_unverified) even for a perfect install', async () => {
    const home = path.join(tmp, 'home');
    await stageHome(home);
    const res = bundle(null, true);
    const e = await loadSdk({ packaged: true, sidecarDir: res, home, pin: FAKE_PIN, log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkUnverifiedError);
    expect(e.message).toMatch(/pin manifest \(sdk-pin\/tree\.sha256\) is not available/);
  });

  it('the install of another version is sdk_incompatible, again without a fallback', async () => {
    const home = path.join(tmp, 'home');
    const h = await stageHome(home);
    const res = bundle(h.manifest, true);
    const e = await loadSdk({ packaged: true, sidecarDir: res, home, pin: '9.9.9', log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(SdkIncompatibleError);
  });

  it('the memo key separates the modes: a checkout accepted unpackaged is not served to a packaged call', async () => {
    const res = bundle('x', true);
    const home = emptyHome();
    const base = { sidecarDir: res, home, pin: FAKE_PIN, log: () => {} };
    expect(await loadSdk({ ...base, packaged: false })).toBeTruthy();
    expect(sdkReport()?.source).toBe('checkout');
    await expect(loadSdk({ ...base, packaged: true })).rejects.toBeInstanceOf(SdkMissingError);
  });

  it('production callers pass no options: loadSdk() is never given packaged/dir/checkoutDir outside src/sdk.ts', () => {
    const src = path.join(fileURLToPath(new URL('../src', import.meta.url)));
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const calls: string[] = [];
    for (const f of walk(src).filter((x) => x.endsWith('.ts') && !x.endsWith(`${path.sep}sdk.ts`))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bloadSdk\(([^)]*)\)/g)) if (m[1]!.trim() !== '') calls.push(`${path.relative(src, f)}: loadSdk(${m[1]})`);
    }
    expect(calls).toEqual([]);
  });

  it('the shipped default derives from import.meta.url and from nothing else', () => {
    const body = readFileSync(fileURLToPath(new URL('../src/sdk.ts', import.meta.url)), 'utf8').replace(/\/\/.*$/gm, '');
    expect(body).toMatch(/isPackagedPath\(fileURLToPath\(import\.meta\.url\)\)/);
    expect(body).not.toMatch(/process\.(env|argv|execPath)/);
  });
});

describe('what a person is told when the SDK is not usable', () => {
  it('names the installer next to the packaged sidecar, quoted as one shell word', () => {
    const file = '/Applications/My Mac/IntelyIDE.app/Contents/Resources/sidecar/index.js';
    const hint = sdkSetupHint({ file });
    expect(hint).toBe("Install it once in a terminal: node '/Applications/My Mac/IntelyIDE.app/Contents/Resources/sidecar/sdk-install.js' --plan (lists what would be downloaded), then node '/Applications/My Mac/IntelyIDE.app/Contents/Resources/sidecar/sdk-install.js' --yes.");
    expect(sdkSetupHint({ file: "/Volumes/it's/IntelyIDE.app/Contents/Resources/sidecar/index.js" })).toContain("'/Volumes/it'\\''s/IntelyIDE.app/Contents/Resources/sidecar/sdk-install.js'");
  });

  it('sends a source checkout to pnpm install', () => {
    expect(sdkSetupHint({ file: '/work/repo/sidecar/dist/index.js' })).toBe('Run `pnpm install` in the source checkout.');
    expect(sdkSetupHint()).toBe('Run `pnpm install` in the source checkout.');
  });
});
