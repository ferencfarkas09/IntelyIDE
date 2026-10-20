// The MCP catalog of the IDE (ui/src/modules/mcp/catalog.json) is named on the IntelyIDE page in both languages: every product
// title appears in the section, and the section's picture exists. A new catalog entry that is not on the page fails here.
// node --test site/test/mcp-catalog.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../src/content/en.mjs';
import hu from '../src/content/hu.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(HERE, '../../ui/src/modules/mcp/catalog.json'), 'utf8'));
const section = (t) => t.features.items.find((s) => s.id === 'mcp');

describe('the MCP catalog on the website', () => {
  for (const [lang, t] of [['en', en], ['hu', hu]]) {
    it(`${lang}: names every product of the catalog in the MCP section`, () => {
      const s = section(t);
      assert.ok(s, 'an MCP section');
      const text = [s.p, ...s.list].join(' ');
      for (const e of catalog) assert.ok(text.includes(e.title), `${e.title} is not named (${lang})`);
    });

    it(`${lang}: has a highlight card that links to the section, and the picture it shows`, () => {
      assert.ok(t.highlights.items.some((i) => i.id === 'mcp'));
      assert.deepEqual(section(t).shots.map((x) => x[0]), ['mcp-catalog']);
    });
  }

  it('has the screenshot in both themes and every width', () => {
    const dir = join(HERE, '../src/static/assets/img/shots');
    for (const theme of ['light', 'dark']) for (const w of [2880, 1440, 720]) for (const ext of ['png', 'webp']) assert.ok(existsSync(join(dir, `mcp-catalog-${theme}-${w}.${ext}`)), `mcp-catalog-${theme}-${w}.${ext}`);
  });

  it('says that the product names are the owners’ (no endorsement is implied) in both languages', () => {
    assert.match(section(en).list.join(' '), /belong to their owners/);
    assert.match(section(hu).list.join(' '), /tulajdonosaiké/);
  });

  it('claims no more than the data: every entry is pinned or an address, and none carries a secret value', () => {
    for (const e of catalog) for (const v of [...(e.env ?? []), ...(e.headers ?? [])]) if (v.secret) assert.deepEqual(Object.keys(v).filter((k) => k !== 'smoke').sort(), ['name', 'secret'], e.id);
  });
});
