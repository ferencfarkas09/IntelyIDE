// The IntelyIDE split hero: frosted cards on the right, slow ring arcs behind, motion that respects the visitor's settings.
// node --test site/test/hero-split.test.mjs   (builds into a temporary directory; no network)
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
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('split hero', () => {
  let dist;
  const html = {};
  before(() => {
    dist = mkdtempSync(join(tmpdir(), 'site-hero-'));
    execFileSync('node', [join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, env: { ...process.env, SITE_DIST_DIR: dist }, stdio: 'pipe' });
    html.en = readFileSync(join(dist, 'intelyide/index.html'), 'utf8');
    html.hu = readFileSync(join(dist, 'hu/intelyide/index.html'), 'utf8');
  });
  after(() => rmSync(dist, { recursive: true, force: true }));

  for (const [lang, t] of [['en', en], ['hu', hu]]) {
    it(`${lang}: five feature cards with an icon, a label and a line, and the download button stays in the hero`, () => {
      assert.equal(t.hero.cards.length, 5);
      const cards = html[lang].match(/<li class="gcard gc\d"[\s\S]*?<\/li>/g) ?? [];
      assert.equal(cards.length, 5);
      for (const c of cards) assert.match(c, /<span class="ficon"><svg[\s\S]*<strong>[^<]{3,}<\/strong><span>[^<]{8,}<\/span>/);
      const hero = html[lang].slice(html[lang].indexOf('class="hero hero-split"'), html[lang].indexOf('id="speed"'));
      assert.match(hero, /id="hero-dl"/);
      assert.match(hero, /<ul class="hero-cards" aria-label="[^"]+"/);
    });

    it(`${lang}: the ring arcs and the gradient definitions are hidden from assistive technology`, () => {
      const hero = html[lang].slice(html[lang].indexOf('class="hero hero-split"'));
      assert.match(hero, /<div class="hero-bg" aria-hidden="true">/);
      assert.equal((hero.match(/<svg class="arc a\d"/g) ?? []).length, 5);
      assert.doesNotMatch(hero, /<style|style="/);
    });
  }

  it('animates only when motion is allowed, keeps the rings static otherwise, and pauses off screen', () => {
    const css = read('src/static/assets/style.css');
    const block = css.slice(css.indexOf('/* Rings:'));
    assert.match(block, /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*arc-spin[\s\S]*\}/);
    assert.ok(block.indexOf('animation: arc-in') > block.indexOf('prefers-reduced-motion: no-preference'), 'arc animations sit inside the no-preference query');
    assert.match(block, /\.hero\.is-paused \.arc \{ animation-play-state: paused; \}/);
    assert.match(css, /prefers-reduced-motion: reduce\) \{ \* \{ animation: none !important/);
    assert.match(block, /pointer-events: none/);
    assert.match(css, /\.gcard \{[^}]*backdrop-filter: blur/);
  });

  it('drives the cards with transforms only, honours reduced motion and touch, and stops off screen or in a hidden tab', () => {
    const js = read('src/static/assets/hero-fx.js');
    const part = js.slice(js.indexOf('Split hero'));
    assert.match(part, /prefers-reduced-motion: reduce/);
    assert.match(part, /\(hover: hover\) and \(pointer: fine\)/);
    assert.match(part, /IntersectionObserver/);
    assert.match(part, /visibilitychange/);
    assert.match(part, /requestAnimationFrame/);
    assert.match(part, /translate3d/);
    assert.doesNotMatch(part, /\.style\.(left|top|width|height)\b/);
    assert.doesNotMatch(js, /https?:\/\//);
  });
});
