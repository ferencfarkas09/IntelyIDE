// The Versions panel of the IDE (ui/src/modules/versions, docs/versions.md) is described on the IntelyIDE page in both languages: every
// kind of file the panel reads is named, the buttons and labels are the panel's own, the claims about safety are the ones the docs make,
// and the two pictures exist. A new kind of file in the panel that is not on the page fails here.
// node --test site/test/versions.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DIMS, SHOTS } from '../scripts/shots.mjs';
import en from '../src/content/en.mjs';
import hu from '../src/content/hu.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const docs = read('docs/versions.md');
const strings = { en: JSON.parse(read('ui/src/i18n/locales/en/extras.json')), hu: JSON.parse(read('ui/src/i18n/locales/hu/extras.json')) };
const section = (t) => t.features.items.find((s) => s.id === 'versions');
const textOf = (t) => [section(t).p, ...section(t).list].join(' ');

// What the page says for each kind of file of ui/src/modules/versions/types.ts.
const KIND_NAMES = {
  packageJson: ['package.json', 'package-lock.json'],
  pbxproj: ['MARKETING_VERSION', 'CURRENT_PROJECT_VERSION'],
  infoPlist: ['Info.plist'],
  gradle: ['versionName', 'versionCode'],
  cargo: ['Cargo.toml'],
  tauri: ['tauri.conf.json'],
  expo: ['app.json'],
  pyproject: ['pyproject.toml'],
  pubspec: ['pubspec.yaml'],
};
const kinds = [...read('ui/src/modules/versions/types.ts').match(/export type Kind = ([^;]+);/)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
const NOT_READ_YET = ['composer.json', 'pom.xml', 'setup.py', 'gradle.properties'];

describe('the Versions panel on the website', () => {
  it('knows every kind of file the panel reads', () => {
    assert.ok(kinds.length >= 9, 'the kinds of the panel were not found');
    for (const k of kinds) assert.ok(KIND_NAMES[k], `${k} is new in the panel: name it on the page and add it to KIND_NAMES`);
  });

  for (const [lang, t] of [['en', en], ['hu', hu]]) {
    it(`${lang}: names every kind of file the panel reads`, () => {
      const text = textOf(t);
      for (const k of kinds) for (const name of KIND_NAMES[k]) assert.ok(text.includes(name), `${name} is not named (${lang})`);
    });

    it(`${lang}: names the buttons and the labels the panel has`, () => {
      const text = textOf(t);
      const s = strings[lang];
      for (const key of ['patch', 'minor', 'major', 'build']) assert.ok(text.includes(s[`versions.bump.${key}`]), `${s[`versions.bump.${key}`]} is not named (${lang})`);
      assert.ok(text.includes(s['versions.willChange']), `${s['versions.willChange']} is not named (${lang})`);
      const apply = s['versions.apply'].match(/=0 \{([^}]+)\}/)[1];
      assert.ok(text.includes(apply), `${apply} is not named (${lang})`);
    });

    it(`${lang}: has a section with the two pictures, and a highlight card for it`, () => {
      const s = section(t);
      assert.ok(s, 'a Versions section');
      assert.deepEqual(s.shots.map((x) => x[0]), ['versions', 'versions-diff']);
      assert.ok(s.list.length >= 5);
      assert.ok(t.highlights.items.some((i) => i.id === 'versions'));
    });
  }

  it('says that nothing is committed, tagged or pushed and nothing leaves the computer, as the docs and the changelog do', () => {
    assert.match(textOf(en), /It never commits, tags or pushes, and nothing leaves your computer/);
    assert.match(textOf(hu), /Soha nem commitol, nem címkéz és nem pushol, és semmi sem hagyja el a gépedet/);
    assert.match(docs, /never commits, tags or pushes/);
    assert.match(read('CHANGELOG.md'), /nothing is committed or tagged and nothing leaves the computer/);
  });

  it('says that nothing is written before Apply and that a file changed meanwhile is refused, as the docs do', () => {
    assert.match(textOf(en), /It only reads until you press Apply/);
    assert.match(textOf(en), /if a file changed since it was read, the repository is left as it was/);
    assert.match(textOf(hu), /Amíg meg nem nyomod az Alkalmaz gombot, csak olvas/);
    assert.match(textOf(hu), /ha egy fájl megváltozott, mióta beolvasta, a repó érintetlen marad/);
    assert.match(docs, /The panel only reads until you press Apply/);
    assert.match(docs, /changed since it was read/);
  });

  it('claims no more than the docs: every file it names is in docs/versions.md, and what is not read yet is said so', () => {
    for (const names of Object.values(KIND_NAMES)) for (const name of names) assert.ok(docs.includes(name), `${name} is not in docs/versions.md`);
    for (const name of NOT_READ_YET) {
      assert.ok(docs.includes(name), `${name} is not in docs/versions.md`);
      assert.ok(textOf(en).includes(name) && textOf(hu).includes(name), `${name} is not named as not read yet`);
    }
    assert.match(docs, /are not read yet/);
    assert.match(textOf(en), /are not read yet/);
    assert.match(textOf(hu), /még nem olvas/);
  });

  it('says that the product names are the owners’ (no endorsement is implied) in both languages', () => {
    assert.match(section(en).list.join(' '), /belong to their owners/);
    assert.match(section(hu).list.join(' '), /tulajdonosaiké/);
  });

  it('has the screenshots in both themes and every width', () => {
    const dir = join(HERE, '../src/static/assets/img/shots');
    for (const slot of ['versions', 'versions-diff']) for (const theme of ['light', 'dark']) for (const w of [2880, 1440, 720]) for (const ext of ['png', 'webp']) assert.ok(existsSync(join(dir, `${slot}-${theme}-${w}.${ext}`)), `${slot}-${theme}-${w}.${ext}`);
  });

  it('has both slots in the capture script and in the list of shots, with the size the picture declares', () => {
    const capture = readFileSync(join(HERE, '../scripts/capture-shots.mjs'), 'utf8');
    assert.match(capture, /SHOTS\.versions = /);
    assert.match(capture, /SHOTS\["versions-diff"\] = /);
    for (const slot of ['versions', 'versions-diff']) {
      assert.ok(SHOTS[slot], `${slot} is not in shots.mjs`);
      assert.deepEqual(DIMS[slot], [1440, 900]);
    }
  });
});
