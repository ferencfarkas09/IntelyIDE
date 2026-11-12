// The "New in 1.15" part of the IntelyIDE page: the sections exist in both languages, the copy about the cards that ask instead of
// blocking promises no more than the safety model does, the pictures are there in both themes, and the version of the download is
// never written into the copy (it comes from data/release.json).
// node --test site/test/whats-new.test.mjs   (builds into a temporary directory; no network)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../src/content/en.mjs';
import hu from '../src/content/hu.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'src/static/assets/img/shots');
// the copy as one string, markup included: the phrases checked below have none inside them
const textOf = (node) => JSON.stringify(node);

describe('what is new in 1.15', () => {
  let dist;
  const pages = {};
  before(() => {
    dist = mkdtempSync(join(tmpdir(), 'site-new-'));
    execFileSync('node', [join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, env: { ...process.env, SITE_DIST_DIR: dist }, stdio: 'pipe' });
    pages.en = readFileSync(join(dist, 'intelyide/index.html'), 'utf8');
    pages.hu = readFileSync(join(dist, 'hu/intelyide/index.html'), 'utf8');
  });
  after(() => rmSync(dist, { recursive: true, force: true }));

  for (const [lang, t] of [['en', en], ['hu', hu]]) {
    it(`${lang}: has the sections, three cards that lead to them, and the two fixes`, () => {
      const html = pages[lang];
      for (const id of ['new', 'ask', 'context', 'gallery', 'trust', 'toolkit']) assert.match(html, new RegExp(`<(section|article)[^>]* id="${id}"`), id);
      assert.equal(t.whatsNew.cards.length, 3);
      for (const c of t.whatsNew.cards) assert.ok(html.includes(`href="#${c.to}"`), c.to);
      assert.equal(t.whatsNew.fixes.length, 2);
      assert.equal((html.match(/class="card ncard"/g) ?? []).length, 3);
      assert.doesNotMatch(html, /<[a-z][^>]* style="/, 'the CSP forbids inline styles');
    });

    it(`${lang}: keeps every point of a folded list on the page`, () => {
      const html = pages[lang];
      assert.ok(html.includes(`<summary>${t.ui.moreDetails}</summary>`));
      for (const f of [...t.whatsNew.items, ...t.features.items]) for (const x of f.list) assert.ok(html.includes(`<li>${x}</li>`), x.slice(0, 40));
    });

    it(`${lang}: shows the gallery and the context meter in both themes`, () => {
      const slots = [...t.gallery.items.map((i) => i.slot), ...t.whatsNew.items.filter((f) => f.shot.length).map((f) => f.shot[0])];
      assert.ok(slots.includes('dashboard') && slots.includes('new-run') && slots.includes('context-meter'));
      // every width as WebP; the PNG fallback may lack 2880 px where that file would be over the 1 MiB limit of the public tree
      for (const slot of slots) for (const theme of ['light', 'dark']) for (const [w, ext] of [[2880, 'webp'], [1440, 'webp'], [720, 'webp'], [1440, 'png'], [720, 'png']]) assert.ok(existsSync(join(SHOTS, `${slot}-${theme}-${w}.${ext}`)), `${slot}-${theme}-${w}.${ext}`);
      for (const i of t.gallery.items) assert.ok(i.alt.length > 60 && i.cap.length > 20);
    });

    it(`${lang}: never writes the version of the download into the copy`, () => {
      assert.doesNotMatch(textOf({ hero: t.hero, n: t.whatsNew, g: t.gallery, tr: t.trust }), /1\.15\.\d/);
    });
  }

  it('promises no more about the asking cards than the safety model: file tools only, the shell stays refused, a phone can only deny', () => {
    const ask = (t) => textOf(t.whatsNew.items.find((f) => f.id === 'ask'));
    assert.match(ask(en), /Shell commands that name a secret file stay refused in every mode/);
    assert.match(ask(en), /file tools on that exact file/);
    assert.match(ask(en), /A paired phone shows the card with Deny only/);
    assert.match(ask(en), /Only a person at the IDE window on the computer can say yes/);
    assert.match(ask(en), /stays a hard stop that nothing lifts: commit, push, merge/);
    assert.match(ask(en), /Best effort/);
    assert.match(ask(en), /Three answers: Deny, Allow once, or Allow for this run/);
    for (const t of [en, hu]) assert.doesNotMatch(textOf({ n: t.whatsNew, tr: t.trust }), /always allow|Always allow|mindig engedélyez|Mindig engedélyez/);
    assert.match(ask(hu), /shell-parancsok minden módban tiltva maradnak/);
    assert.match(ask(hu), /pontosan arra az egy fájlra/);
    assert.match(ask(hu), /telefonon a kártya csak elutasítani enged/);
    assert.match(ask(hu), /kemény tiltás marad, amelyet semmi sem old fel: a commit, a push, a merge/);
    for (const t of [en, hu]) assert.doesNotMatch(textOf(t.whatsNew), /shell command[^.]*allow(ed)? (once|for)|parancs[^.]*engedélyezhető/i);
  });

  it('says that the meter does not estimate and that a nudge is a request, in both languages', () => {
    const ctx = (t) => textOf(t.whatsNew.items.find((f) => f.id === 'context'));
    assert.match(ctx(en), /it does not estimate/);
    assert.match(ctx(en), /A nudge is a request to the agent, not a rule/);
    assert.match(ctx(hu), /nem becsül/);
    assert.match(ctx(hu), /kérés az ügynökhöz, nem szabály/);
  });
});
