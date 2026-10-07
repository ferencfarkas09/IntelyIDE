// Site integration of the signed update feeds (updater spec 4.14, task U12). Throwaway fixtures
// only: unsigned feed bodies and fake .sig text; no key, no network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildFeed, feedBytes } from '../../scripts/release/updater/lib/feed.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'site-upd-'));
  dirs.push(d);
  return d;
};
const SIG = 'untrusted comment: signature from tauri secret key (TEST throwaway)\nRUQfake\ntrusted comment: t\nZmFrZQ==\n';
const sha = (b) => createHash('sha256').update(b).digest('hex');

function feed({ version = '0.1.0', channel = 'stable', seq = 1, mutate } = {}) {
  const o = buildFeed({
    channel, seq, version, generatedAt: '2026-10-20T09:00:00Z', notes: `## ${version}\n`,
    assets: { x64: { signature: 'ZmFrZXNpZw==', bytes: 5 * 1024 * 1024, sha256: 'a'.repeat(64), unpackedBytes: 9 * 1024 * 1024 } },
  });
  mutate?.(o);
  return feedBytes(o);
}

/** A data dir: release.json (version 0.1.0) + update/ with the given files. */
function fixture(files) {
  const data = tmp();
  cpSync(join(SITE, 'data/release.json'), join(data, 'release.json'));
  mkdirSync(join(data, 'update'));
  for (const [n, b] of Object.entries(files)) writeFileSync(join(data, 'update', n), b);
  return data;
}
const env = (data, dist) => ({ ...process.env, SITE_DATA_DIR: data, SITE_DIST_DIR: dist, NODE_ENV: '' });
const node = (script, args, e) => spawnSync(process.execPath, [join(SITE, 'scripts', script), ...args], { env: e, encoding: 'utf8' });
function buildAndCheck(files, args = []) {
  const data = fixture(files);
  const dist = join(tmp(), 'dist');
  const b = node('build.mjs', [], env(data, dist));
  assert.equal(b.status, 0, b.stderr);
  return { data, dist, check: node('check-site.mjs', args, env(data, dist)) };
}

describe('build.mjs copies the feeds verbatim', () => {
  it('dist/update/*.json(.sig) are byte-identical to the inputs', () => {
    const files = {
      'stable.json': feed(), 'stable.json.sig': SIG,
      'alpha.json': feed({ channel: 'alpha', version: '0.1.1-alpha.1' }), 'alpha.json.sig': SIG,
    };
    const { dist, check } = buildAndCheck(files);
    for (const [n, b] of Object.entries(files)) {
      assert.equal(sha(readFileSync(join(dist, 'update', n))), sha(Buffer.from(b)), n);
    }
    assert.equal(check.status, 0, check.stderr);
  });
  it('a feed with CRLF or odd whitespace is not reformatted', () => {
    const odd = Buffer.from(feed().toString('utf8').replace(/\n/g, '\r\n'));
    const { dist } = buildAndCheck({ 'stable.json': odd, 'stable.json.sig': SIG });
    assert.equal(sha(readFileSync(join(dist, 'update/stable.json'))), sha(odd));
  });
  it('an empty update directory builds and checks (no feed published yet)', () => {
    const { dist, check } = buildAndCheck({});
    assert.equal(check.status, 0, check.stderr);
    assert.throws(() => readFileSync(join(dist, 'update/stable.json')));
  });
});

describe('check-site.mjs feed checks', () => {
  const ok = { 'stable.json': feed(), 'stable.json.sig': SIG };
  it('passes for a good feed', () => assert.equal(buildAndCheck(ok).check.status, 0));
  it('fails for a mutated feed URL', () => {
    const bad = feed({ mutate: (o) => { o.platforms['darwin-x86_64'].url = 'https://evil.example/x.app.tar.gz'; } });
    const r = buildAndCheck({ 'stable.json': bad, 'stable.json.sig': SIG }).check;
    assert.equal(r.status, 1);
    assert.match(r.stderr, /url is not the one built from the constants/);
    assert.match(r.stderr, /outside the project hosts/);
  });
  it('fails for a missing .sig, and for a .sig without its feed', () => {
    assert.match(buildAndCheck({ 'stable.json': feed() }).check.stderr, /stable\.json\.sig: missing/);
    assert.match(buildAndCheck({ 'stable.json.sig': SIG }).check.stderr, /stable\.json: missing/);
  });
  it('fails for an empty, oversized or foreign .sig', () => {
    assert.match(buildAndCheck({ 'stable.json': feed(), 'stable.json.sig': '' }).check.stderr, /non-empty/);
    assert.match(buildAndCheck({ 'stable.json': feed(), 'stable.json.sig': SIG + 'x'.repeat(4096) }).check.stderr, /below 4096/);
    assert.match(buildAndCheck({ 'stable.json': feed(), 'stable.json.sig': 'hello' }).check.stderr, /not a minisign/);
  });
  it('fails for a version that differs from data/release.json', () => {
    const r = buildAndCheck({ 'stable.json': feed({ version: '0.1.1' }), 'stable.json.sig': SIG }).check;
    assert.equal(r.status, 1);
    assert.match(r.stderr, /differs from data\/release\.json/);
  });
  it('fails for a channel that does not match the file name, and for invalid JSON', () => {
    assert.match(buildAndCheck({ 'stable.json': feed({ channel: 'alpha', version: '0.1.0' }), 'stable.json.sig': SIG }).check.stderr, /not the requested stable/);
    assert.match(buildAndCheck({ 'stable.json': '{nope', 'stable.json.sig': SIG }).check.stderr, /not JSON/);
  });
  it('fails for an unexpected file in data/update', () => {
    assert.match(buildAndCheck({ ...ok, 'notes.txt': 'x' }).check.stderr, /unexpected file/);
  });
  it('fails when dist/update was changed after the build', () => {
    const { data, dist } = buildAndCheck(ok);
    writeFileSync(join(dist, 'update/stable.json'), 'tampered');
    assert.match(node('check-site.mjs', [], env(data, dist)).stderr, /differs from data\/update\/stable\.json/);
  });
  describe('seq against the previous feeds (--prev-update-dir)', () => {
    const prev = (seq) => {
      const d = tmp();
      writeFileSync(join(d, 'stable.json'), feed({ seq }));
      return d;
    };
    const run = (seq, p, extra) => buildAndCheck({ 'stable.json': feed({ seq, ...extra }), 'stable.json.sig': SIG }, ['--prev-update-dir', p]).check;
    it('passes when seq increases', () => assert.equal(run(3, prev(2)).status, 0));
    it('passes when the feed is byte-identical to the previous one', () => assert.equal(run(2, prev(2)).status, 0));
    it('fails when seq goes back', () => assert.match(run(1, prev(2)).stderr, /below the previous 2/));
    it('fails when seq stands still but the bytes differ', () => {
      const r = run(2, prev(2), { mutate: (o) => { o.notes = 'changed\n'; } });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /unchanged but the bytes differ/);
    });
    it('a floorReset feed (standby) may lower seq', () => {
      assert.equal(run(1, prev(5), { mutate: (o) => { o.floorReset = 1; } }).status, 0);
    });
  });
});

describe('real site data', () => {
  it('the committed tree builds and checks (existing checks still pass)', () => {
    const dist = join(tmp(), 'dist');
    const e = { ...process.env, SITE_DIST_DIR: dist };
    delete e.SITE_DATA_DIR;
    assert.equal(node('build.mjs', [], e).status, 0);
    const r = node('check-site.mjs', [], e);
    assert.equal(r.status, 0, r.stderr);
  });
});
