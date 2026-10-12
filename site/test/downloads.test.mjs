// The download block of the site for a release with files for several platforms, and for the older single-file data.
// node --test site/test/downloads.test.mjs   (builds into throwaway folders; no network)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'site-dl-'));
  dirs.push(d);
  return d;
};

const base = 'https://github.com/ferencfarkas09/IntelyIDE/releases/download/v2.0.0';
const file = (name, extra = {}) => ({ name, url: `${base}/${name}`, size: 6 * 1048576, sha256: 'a'.repeat(64), ...extra });
const multi = {
  version: '2.0.0', status: 'stable', date: '2026-11-01', minMacOS: '13.5', signed: true, windowsSigned: false,
  notesUrl: 'https://github.com/ferencfarkas09/IntelyIDE/releases/tag/v2.0.0', sha256sumsUrl: `${base}/SHA256SUMS`,
  assets: {
    mac: file('IntelyIDE_2.0.0_universal.dmg', { arch: 'universal' }),
    windows: { nsis: file('IntelyIDE_2.0.0_x64-setup.exe', { arch: 'x64' }), msi: file('IntelyIDE_2.0.0_x64.msi', { arch: 'x64' }) },
    linux: { appimage: file('IntelyIDE_2.0.0_x86_64.AppImage', { arch: 'x64' }), deb: file('intelyide_2.0.0_amd64.deb', { arch: 'x64' }) },
  },
};
const legacy = { ...multi, assets: [{ ...multi.assets.mac, name: 'IntelyIDE_2.0.0_x64.dmg', url: `${base}/IntelyIDE_2.0.0_x64.dmg`, arch: 'x64' }] };

function build(release, args = ['--prod']) {
  const data = tmp();
  const dist = join(tmp(), 'dist');
  writeFileSync(join(data, 'release.json'), JSON.stringify(release));
  mkdirSync(join(data, 'update'));
  const env = { ...process.env, SITE_DATA_DIR: data, SITE_DIST_DIR: dist, NODE_ENV: '' };
  const run = (script, a) => spawnSync(process.execPath, [join(SITE, 'scripts', script), ...a], { env, encoding: 'utf8' });
  const b = run('build.mjs', []);
  assert.equal(b.status, 0, b.stderr);
  const c = run('check-site.mjs', args);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  const page = (p) => readFileSync(join(dist, p), 'utf8');
  return { dist, page };
}

describe('files for several platforms', () => {
  const { dist, page } = build(multi);
  it('the big button falls back to the release page without JavaScript and every platform has a link', () => {
    const home = page('index.html');
    assert.match(home, /<a class="dl-btn" href="https:\/\/github\.com\/ferencfarkas09\/IntelyIDE\/releases\/tag\/v2\.0\.0" data-ga-platform="other" data-ga="download" data-ga-label="hero-dl">/);
    assert.match(home, /Other platforms: <a href="[^"]*IntelyIDE_2\.0\.0_universal\.dmg" data-platform="mac" data-primary/);
    assert.match(home, /data-platform="windows" data-primary[^>]*>Windows<\/a>/);
    assert.match(home, /Linux \(<a href="[^"]*x86_64\.AppImage" data-platform="linux" data-primary[^>]*>AppImage<\/a>, <a href="[^"]*amd64\.deb" data-platform="linux"[^>]*>\.deb<\/a>\)/);
    assert.ok(!/<a href="[^"]*amd64\.deb"[^>]*data-primary/.test(home), 'the .deb is not the primary Linux file');
  });
  it('each download link carries its platform for the analytics event', () => {
    const home = page('index.html');
    for (const p of ['mac', 'windows', 'linux']) assert.match(home, new RegExp(`data-ga="download" data-ga-label="hero-dl-${p}[^"]*" data-ga-platform="${p}"`));
    assert.match(page('download/index.html'), /data-ga-label="table" data-ga-platform="windows"/);
  });
  it('notes for Windows (unsigned) and Linux (chmod), in English and Hungarian', () => {
    assert.match(page('index.html'), /Run anyway/);
    assert.match(page('index.html'), /chmod \+x IntelyIDE_\*\.AppImage/);
    assert.match(page('hu/index.html'), /Futtatás mindenképpen/);
    assert.match(page('hu/index.html'), /Más platformok:/);
  });
  it('the all-downloads table lists the five files', () => {
    const t = page('download/index.html');
    for (const n of ['universal.dmg', 'x64-setup.exe', 'x64.msi', 'x86_64.AppImage', 'amd64.deb']) assert.ok(t.includes(n), n);
  });
  it('the header and install buttons open the download page, not one platform file', () => {
    const home = page('index.html');
    assert.match(home, /class="btn btn-sm hdr-dl" href="download\/"/);
    assert.match(home, /class="btn" href="download\/" data-ga="download" data-ga-label="install"/);
  });
  it('keeps the CSP strict: no inline handler, no inline script but the theme init and JSON-LD', () => {
    for (const p of ['index.html', 'hu/index.html', 'download/index.html']) {
      const html = page(p);
      assert.doesNotMatch(html, /\son[a-z]+="/);
      for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /src=|type="application\/ld\+json"|^\s*$/, m[0]);
      assert.doesNotMatch(html, /style="/);
    }
    assert.match(readFileSync(join(dist, 'assets/site.js'), 'utf8'), /detectPlatform/);
  });
});

describe('older data with one file per release', () => {
  it('still builds one macOS button that points straight at the file', () => {
    const { page } = build(legacy);
    assert.match(page('index.html'), /<a class="dl-btn" href="[^"]*IntelyIDE_2\.0\.0_x64\.dmg"/);
    assert.doesNotMatch(page('index.html'), /data-dl-multi|Other platforms/);
  });
  it('a macOS-only release in the new shape behaves the same', () => {
    const { page } = build({ ...multi, assets: { mac: multi.assets.mac } });
    assert.match(page('index.html'), /<a class="dl-btn" href="[^"]*universal\.dmg"/);
    assert.doesNotMatch(page('index.html'), /data-dl-multi/);
  });
});
