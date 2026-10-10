// `--probe` (src/probe.ts, src/index.ts): one JSON line about the machine, the SDK check with the loader's own errors, exit 0.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe } from '../src/probe.js';
import { SdkIncompatibleError, SdkMissingError } from '../src/sdk.js';

describe('probe()', () => {
  it('reports the machine and a loaded SDK', async () => {
    const p = await probe('9.9.9', { load: async () => ({}), report: () => ({ version: '0.3.287' }) });
    expect(p).toEqual({ sidecar: '9.9.9', node: process.version, platform: process.platform, arch: process.arch, home: os.homedir(), sdk: { ok: true, version: '0.3.287' } });
  });
  it('turns an SDK error into code + detail without the code prefix, never throwing', async () => {
    const miss = await probe('x', { load: async () => { throw new SdkMissingError('the SDK is not installed'); } });
    expect(miss.sdk).toEqual({ ok: false, code: 'sdk_missing', detail: 'the SDK is not installed' });
    const inc = await probe('x', { load: async () => { throw new SdkIncompatibleError('found 1.0.0'); } });
    expect(inc.sdk).toMatchObject({ ok: false, code: 'sdk_incompatible' });
    const odd = await probe('x', { load: async () => { throw 'boom'; } });
    expect(odd.sdk).toEqual({ ok: false, code: 'sdk_broken', detail: 'boom' });
  });
  it('redacts secrets in the detail but keeps the real home', async () => {
    const p = await probe('x', { load: async () => { throw new Error('token sk-ant-api03-abcdefghijkl leaked'); } });
    expect(JSON.stringify(p.sdk)).not.toContain('abcdefghijkl');
    expect(p.home).toBe(os.homedir());
  });
  it('gives up on a hanging SDK check', async () => {
    const t0 = Date.now();
    const p = await probe('x', { load: () => new Promise(() => undefined), timeoutMs: 50 });
    expect(p.sdk).toMatchObject({ ok: false, code: 'sdk_broken', detail: expect.stringContaining('timed out') });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('node index.js --probe', () => {
  let out: string;
  beforeAll(() => {
    out = mkdtempSync(path.join(os.tmpdir(), 'intely-probe-'));
    execFileSync(process.execPath, ['build.mjs'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore', env: { ...process.env, SIDECAR_OUT_DIR: out } });
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('prints exactly one JSON line, exits 0 quickly, reads no stdin and sends no heartbeat', async () => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(out, 'index.js'), '--probe'], { stdio: ['pipe', 'pipe', 'pipe'] }); // stdin stays open: the probe must not wait for it
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const j = JSON.parse(lines[0]!);
    expect(j).toMatchObject({ sidecar: expect.any(String), node: process.version, platform: process.platform, arch: process.arch, home: os.homedir() });
    expect(j.sdk.ok === true ? typeof j.sdk.version : j.sdk.code).toEqual(expect.any(String));
    expect(j.type).toBeUndefined(); // not a protocol envelope
  });
});
