// The one hero every page uses: five frosted cards, thin ring arcs behind, and a motion system with a reduced mode that keeps
// the non-motion effects (border, glow, sheen, breathing arcs) and a footer toggle for visitors whose system asks for less motion.
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
const PAGES = [['home', '', (t) => t.home.hero], ['ide', 'intelyide/', (t) => t.hero], ['opti', 'intelyopti/', (t) => t.opti.hero]];

describe('shared hero', () => {
  let dist;
  const html = {};
  before(() => {
    dist = mkdtempSync(join(tmpdir(), 'site-hero-'));
    execFileSync('node', [join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, env: { ...process.env, SITE_DIST_DIR: dist }, stdio: 'pipe' });
    for (const [key, dir] of PAGES) for (const lang of ['en', 'hu']) html[`${key}-${lang}`] = readFileSync(join(dist, lang === 'hu' ? 'hu' : '', dir, 'index.html'), 'utf8');
  });
  after(() => rmSync(dist, { recursive: true, force: true }));

  for (const [key, , hero] of PAGES) {
    for (const [lang, t] of [['en', en], ['hu', hu]]) {
      describe(`${key} ${lang}`, () => {
        const page = () => html[`${key}-${lang}`];
        const section = () => page().slice(page().indexOf('class="hero hero-split"'), page().indexOf('</section>', page().indexOf('class="hero hero-split"')));

        it('has one hero with five cards (icon, label, line), a heading and a primary call to action', () => {
          assert.equal((page().match(/class="hero hero-split"/g) ?? []).length, 1);
          assert.equal(hero(t).cards.length, 5);
          const cards = section().match(/<li class="gcard gc\d"[\s\S]*?<\/li>/g) ?? [];
          assert.equal(cards.length, 5);
          for (const c of cards) assert.match(c, /<span class="ficon"><svg[\s\S]*<strong>[^<]{3,}<\/strong><span>[^<]{8,}<\/span>/);
          assert.match(section(), /<ul class="hero-cards" aria-label="[^"]+"/);
          assert.match(section(), /<h1 id="hero-h">/);
          assert.match(section(), /id="hero-dl"|class="dl-btn"|class="btn btn-grad btn-lg"/);
          assert.match(section(), /<a [^>]*href="[^"#][^"]*"|<a [^>]*href="#get"/);
        });

        it('hides the arcs and the gradient definitions from assistive technology and uses no inline style', () => {
          assert.match(section(), /<div class="hero-bg" aria-hidden="true">/);
          assert.equal((section().match(/<svg class="arc a\d"/g) ?? []).length, 5);
          assert.doesNotMatch(page(), /<[a-z][^>]* style="/);
          assert.doesNotMatch(section(), /bubble|cursor-glow/);
        });

        it('loads the motion and hero scripts and offers the animations toggle with its hint', () => {
          assert.ok(page().indexOf('assets/motion.js') < page().indexOf('assets/hero-fx.js'));
          assert.match(page(), /data-motion-toggle data-label="[^"]+" data-on="[^"]+" data-off="[^"]+" aria-pressed="false"/);
          assert.ok(page().includes(t.footer.motion.hint));
        });
      });
    }
  }

  it('shows the "Results vary" note only on the page with figures', () => {
    for (const [lang, t] of [['en', en], ['hu', hu]]) {
      assert.ok(html[`ide-${lang}`].includes(t.hero.note));
      assert.ok(!html[`home-${lang}`].includes(t.hero.note));
      assert.ok(!html[`opti-${lang}`].includes(t.hero.note));
    }
  });
});

describe('motion system', () => {
  const css = read('src/static/assets/style.css');
  const fx = read('src/static/assets/hero-fx.js');
  const motion = read('src/static/assets/motion.js');

  it('keeps the old bubble hero out of the styles and the script', () => {
    assert.doesNotMatch(css, /\.bubble|\.cursor-glow|\.is-live/);
    assert.doesNotMatch(fx, /bubble|cursor-glow/);
  });

  it('turns the arcs only in full motion and lets them breathe (opacity) otherwise', () => {
    assert.match(css, /:root\[data-motion='full'\] \.arc \{ animation: arc-in[^}]*arc-spin/);
    assert.match(css, /\.arc \{ animation: arc-breathe/);
    assert.match(css, /@keyframes arc-breathe \{[^}]*opacity[^}]*\}[^}]*opacity/);
    assert.match(css, /\.hero\.is-paused \.arc \{ animation-play-state: paused !important; \}/);
    assert.doesNotMatch(css.slice(css.indexOf('@keyframes arc-breathe'), css.indexOf('/* Cards:')), /transform|rotate/);
  });

  it('kills animation in reduced mode (the arcs excepted) but keeps transitions and hover effects', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ :root:not\(\[data-motion\]\) \*:not\(\.arc\) \{ animation: none !important; \} \}/);
    assert.match(css, /:root\[data-motion='reduced'\] \*:not\(\.arc\) \{ animation: none !important; \}/);
    assert.doesNotMatch(css, /transition: none !important/);
    assert.match(css, /:root:not\(\[data-motion='full'\]\) :is\(\.dl-btn, \.btn, \.stat a\):hover \{ transform: none; \}/);
    assert.match(css, /\.gcard:hover \{ border-color/);
    assert.match(css, /\.gcard::after \{[^}]*animation: sheen/);
    assert.match(css, /\.btn-grad:hover/);
    assert.match(css, /:root\[data-motion='full'\] \.btn:hover \{ transform/);
  });

  it('moves the cards only in full motion, tilts them on hover, and stops off screen or in a hidden tab', () => {
    assert.match(fx, /dataset\.motion === 'full'/);
    assert.match(fx, /motionchange/);
    assert.match(fx, /\(hover: hover\) and \(pointer: fine\)/);
    assert.match(fx, /IntersectionObserver/);
    assert.match(fx, /visibilitychange/);
    assert.match(fx, /requestAnimationFrame/);
    assert.match(fx, /rotateX[\s\S]*rotateY/);
    assert.match(fx, /--mx/);
    assert.doesNotMatch(fx, /\.style\.(left|top|width|height)\b/);
    assert.doesNotMatch(fx, /https?:\/\//);
  });

  it('follows the system setting by default, lets the footer toggle override it, and guards localStorage', () => {
    assert.match(motion, /prefers-reduced-motion: reduce/);
    assert.match(motion, /c === 'on' \? 'full' : c === 'off' \? 'reduced' : mq\.matches \? 'reduced' : 'full'/);
    assert.equal((motion.match(/localStorage\./g) ?? []).length, 2);
    assert.equal((motion.match(/try \{/g) ?? []).length, 2);
    assert.match(motion, /data-motion-toggle/);
    assert.match(motion, /hidden = !mq\.matches/);
  });

  it('has the toggle strings in both languages', () => {
    for (const t of [en, hu]) for (const k of ['label', 'on', 'off', 'hint']) assert.ok(t.footer.motion[k].length > 1);
    assert.match(en.footer.motion.hint, /reduced motion/);
  });
});
