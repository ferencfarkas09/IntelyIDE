// English and Hungarian copy must keep the same shape (keys, array lengths, value types), and every {{token}}
// used in the copy must be one that build.mjs fills.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../src/content/en.mjs';
import hu from '../src/content/hu.mjs';
import { fillTokens, optiVars } from '../src/lib.mjs';

const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../site.config.json'), 'utf8'));

function shapeDiff(a, b, path = '') {
  if (Array.isArray(a) !== Array.isArray(b)) return [`${path}: array vs non-array`];
  if (Array.isArray(a)) {
    const out = a.length === b.length ? [] : [`${path}: length ${a.length} vs ${b.length}`];
    a.forEach((x, i) => i < b.length && out.push(...shapeDiff(x, b[i], `${path}[${i}]`)));
    return out;
  }
  if (a && typeof a === 'object') {
    const out = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push(`${path}.${k}: missing in en`);
      else if (!(k in b)) out.push(`${path}.${k}: missing in hu`);
      else out.push(...shapeDiff(a[k], b[k], `${path}.${k}`));
    }
    return out;
  }
  return typeof a === typeof b ? [] : [`${path}: type ${typeof a} vs ${typeof b}`];
}

describe('content', () => {
  it('en and hu have the same shape', () => assert.deepEqual(shapeDiff(en, hu), []));
  it('fills every token with the numbers from site.config.json', () => {
    for (const t of [en, hu]) {
      const filled = fillTokens(t, { ...optiVars(cfg, t.lang), privacyHref: '/privacy/', termsHref: '/terms/' });
      assert.ok(!/\{\{/.test(JSON.stringify(filled)));
    }
    assert.match(fillTokens('{{yearly}} {{lifetime}} {{trial}}', optiVars(cfg, 'en')), /^\$19\.99 \$39\.99 14$/);
    assert.match(fillTokens('{{yearly}}', optiVars(cfg, 'hu')), /^19,99 USD$/);
  });
  it('hu strings are not copies of en strings in the product copy', () => {
    assert.notEqual(en.opti.hero.lead, hu.opti.hero.lead);
    assert.notEqual(en.home.hero.title, hu.home.hero.title);
  });
});
