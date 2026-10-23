// IntelyFIX is described on the IntelyIDE page in both languages, with its picture in both themes and every width, and the page does not
// promise more than the app does: the agent never commits or pushes, and nothing runs without a click.
// node --test site/test/intelyfix.test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../src/content/en.mjs';
import hu from '../src/content/hu.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const section = (t) => t.features.items.find((s) => s.id === 'intelyfix');

describe('IntelyFIX on the website', () => {
  for (const [lang, t] of [['en', en], ['hu', hu]]) {
    it(`${lang}: has a section with one picture, and a highlight card for it`, () => {
      const s = section(t);
      assert.ok(s, 'an IntelyFIX section');
      assert.deepEqual(s.shots.map((x) => x[0]), ['intelyfix']);
      assert.ok(s.list.length >= 5);
      assert.ok(t.highlights.items.some((i) => i.id === 'intelyfix'));
    });
  }

  it('says that the agent never commits or pushes, and that nothing runs without a click, in both languages', () => {
    assert.match([section(en).p, ...section(en).list].join(' '), /never commits or pushes/);
    assert.match([section(en).p, ...section(en).list].join(' '), /Nothing runs without your click/);
    assert.match([section(hu).p, ...section(hu).list].join(' '), /soha nem commitol és nem pushol/);
    assert.match([section(hu).p, ...section(hu).list].join(' '), /Semmi sem fut a kattintásod nélkül/);
  });

  it('says that Sentry is not affiliated, in both languages', () => {
    assert.match(section(en).list.join(' '), /not endorsed by it/);
    assert.match(section(hu).list.join(' '), /nem támogatja/);
  });

  it('has the screenshot in both themes and every width', () => {
    const dir = join(HERE, '../src/static/assets/img/shots');
    for (const theme of ['light', 'dark']) for (const w of [2880, 1440, 720]) for (const ext of ['png', 'webp']) assert.ok(existsSync(join(dir, `intelyfix-${theme}-${w}.${ext}`)), `intelyfix-${theme}-${w}.${ext}`);
  });
});
