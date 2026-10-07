// The pin has four homes that must agree ((design notes: licensing-spec) 6.5): sidecar/package.json devDependency, SDK_PIN in
// src/sdk.ts, sdk-pin/package.json and sdk-pin/package-lock.json; the tree manifest must describe that lock.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseManifest, SDK_NAME, SDK_PIN } from '../src/sdk.js';

const sidecar = fileURLToPath(new URL('..', import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(sidecar, ...p), 'utf8');
const json = (...p: string[]) => JSON.parse(read(...p)) as Record<string, any>;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('pin agreement', () => {
  const pkg = json('package.json');
  const pin = json('sdk-pin', 'package.json');
  const lock = json('sdk-pin', 'package-lock.json');

  it('devDependency, SDK_PIN, sdk-pin/package.json and the lock name one exact version', () => {
    expect(SDK_PIN).toMatch(/^\d+\.\d+\.\d+$/); // no range, no tag
    expect(pkg.devDependencies[SDK_NAME]).toBe(SDK_PIN);
    expect(pin.dependencies[SDK_NAME]).toBe(SDK_PIN);
    expect(lock.packages[''].dependencies[SDK_NAME]).toBe(SDK_PIN);
    expect(lock.packages[`node_modules/${SDK_NAME}`].version).toBe(SDK_PIN);
  });

  it('every dependency of the pin package is an exact version and equals the lock root', () => {
    for (const [name, range] of Object.entries(pin.dependencies as Record<string, string>)) expect(range, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages[''].dependencies).toEqual(pin.dependencies);
    for (const [name, v] of Object.entries(pin.dependencies as Record<string, string>)) expect(lock.packages[`node_modules/${name}`].version).toBe(v);
  });

  it('every lock entry has a resolved URL on the npm registry and a sha512 integrity', () => {
    const entries = Object.entries(lock.packages as Record<string, any>).filter(([k]) => k !== '');
    expect(entries.length).toBeGreaterThan(50);
    for (const [k, e] of entries) {
      expect(e.resolved, k).toMatch(/^https:\/\/registry\.npmjs\.org\/[^\s?#]+\.tgz$/);
      expect(e.integrity, k).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
    expect(lock.lockfileVersion).toBe(3);
  });

  it('the platform binaries are listed as optional only (npm ci --omit=optional never fetches them)', () => {
    const platform = Object.entries(lock.packages as Record<string, any>).filter(([k]) => k.startsWith(`node_modules/${SDK_NAME}-`));
    expect(platform.length).toBe(8);
    for (const [k, e] of platform) expect(e.optional, k).toBe(true);
  });
});

describe('tree.sha256', () => {
  const manifest = parseManifest(read('sdk-pin', 'tree.sha256'));

  it('is sorted, well formed and covers the committed package.json and package-lock.json byte for byte', () => {
    const keys = [...manifest.keys()];
    expect(keys).toEqual([...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    expect(manifest.get('package.json')).toBe(sha(readFileSync(path.join(sidecar, 'sdk-pin', 'package.json'))));
    expect(manifest.get('package-lock.json')).toBe(sha(readFileSync(path.join(sidecar, 'sdk-pin', 'package-lock.json'))));
    for (const k of keys) { expect(k.startsWith('/') || k.includes('..') || k.includes('\\')).toBe(false); }
    expect(read('sdk-pin', 'tree.sha256').endsWith('\n')).toBe(true);
  });

  it('describes every non-optional package of the lock (and no platform binary)', () => {
    const lock = json('sdk-pin', 'package-lock.json');
    for (const [k, e] of Object.entries(lock.packages as Record<string, any>)) {
      if (k === '' || e.optional) continue;
      expect(manifest.has(`${k}/package.json`), k).toBe(true);
    }
    expect([...manifest.keys()].some((k) => k.includes(`${SDK_NAME}-`))).toBe(false);
  });

  it('matches the SDK bytes that the source checkout runs (same package.json and entry)', () => {
    const real = path.join(sidecar, 'node_modules', ...SDK_NAME.split('/'));
    for (const f of ['package.json', 'sdk.mjs']) {
      expect(manifest.get(`node_modules/${SDK_NAME}/${f}`), f).toBe(sha(readFileSync(path.join(real, f))));
    }
  });
});
