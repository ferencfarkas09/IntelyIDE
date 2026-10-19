// The speed and agent figures on the IntelyIDE page: always hedged, never naming a product, never exclusive,
// shown with the "results vary" note, and the speed graphic is labelled illustrative and has a text alternative.
// node --test site/test/perf-claims.test.mjs   (builds into a temporary directory; no network)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../src/content/en.mjs';
import hu from '../src/content/hu.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('performance claims', () => {
  let dist;
  const pages = {};
  before(() => {
    dist = mkdtempSync(join(tmpdir(), 'site-perf-'));
    execFileSync('node', [join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, env: { ...process.env, SITE_DIST_DIR: dist }, stdio: 'pipe' });
    pages.en = readFileSync(join(dist, 'intelyide/index.html'), 'utf8');
    pages.hu = readFileSync(join(dist, 'hu/intelyide/index.html'), 'utf8');
  });
  after(() => rmSync(dist, { recursive: true, force: true }));

  for (const [lang, t, hedge, about] of [['en', en, /^up to \d+x$/, /^about 30%$/], ['hu', hu, /^akár \d+x$/, /^kb\. 30%$/]]) {
    describe(lang, () => {
      it('states the three figures, with the multipliers hedged', () => {
        const n = t.hero.stats.map((s) => s.n);
        assert.match(n[0], hedge);
        assert.match(n[1], hedge);
        assert.match(n[2], about);
        assert.ok(n[0].includes('7') && n[1].includes('6'));
        assert.deepEqual(t.perf.agents.figures.map((f) => f.n), [n[1], n[2]]);
      });

      it('names no product, version or measurement method, and claims no exclusivity', () => {
        const all = strip(JSON.stringify({ hero: t.hero, perf: t.perf }));
        assert.doesNotMatch(all, /webstorm|jetbrains|android studio|xcode|vs ?code|visual studio|cursor|intellij/i);
        assert.doesNotMatch(all, /median|medián|\bN ?=|sample|minta|benchmark|mérés|measured|megmért/i);
        assert.doesNotMatch(all, /\bonly (in|with) intely|\bonly intely|csak az intely|egyedül az intely|\bunique\b|egyedülálló/i);
      });

      it('shows the "results vary" note and the illustrative label', () => {
        const html = pages[lang];
        assert.ok(t.hero.note.length > 20);
        assert.ok(html.split(t.hero.note).length - 1 >= 3, 'note under the hero figures, the chart and the agent figures');
        assert.ok(html.includes(`<span class="tag">${t.perf.speed.chartTag}</span>`));
      });

      it('has the sections, anchors and a text alternative for the chart', () => {
        const html = pages[lang];
        for (const id of ['speed', 'agents-fast']) assert.match(html, new RegExp(`<section[^>]* id="${id}"`));
        assert.match(html, /role="img" aria-label="[^"]{40,}"/);
        assert.equal((html.match(/class="stat"/g) ?? []).length, 3);
        assert.equal((html.match(/class="card agent-card"/g) ?? []).length, 4);
        assert.doesNotMatch(html, /<[^>]+ style="/, 'the CSP forbids inline styles');
      });
    });
  }
});
