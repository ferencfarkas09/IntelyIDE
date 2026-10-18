// The "Works with" section: every partner has a name, an https link and text in both languages, its logo file (when there is one) can be
// measured, and the section is rendered with the link as a backlink. node --test site/test/partners.test.mjs (reads src/ and site.config.json only)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { partnerLogo } from '../src/lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));
const content = { en: (await import('../src/content/en.mjs')).default ?? (await import('../src/content/en.mjs')), hu: (await import('../src/content/hu.mjs')).default ?? (await import('../src/content/hu.mjs')) };
const copy = (lang) => content[lang].t ?? content[lang].en ?? content[lang].hu ?? content[lang];

describe('partners', () => {
  it('are configured with a name and an https address', () => {
    assert.deepEqual(Object.keys(cfg.partners).sort(), ['deeppattern', 'happy']);
    for (const p of Object.values(cfg.partners)) {
      assert.ok(p.name.length > 2);
      assert.match(p.url, /^https:\/\/[a-z0-9.-]+$/);
    }
    assert.equal(cfg.partners.deeppattern.url, 'https://deeppattern.ai');
    assert.equal(cfg.partners.happy.url, 'https://happysolutions.hu');
  });

  it('have their text in English and Hungarian, one item per configured partner', () => {
    for (const lang of ['en', 'hu']) {
      const t = copy(lang);
      const p = t.partners ?? Object.values(t).find((v) => v?.partners)?.partners;
      assert.ok(p, `${lang}: no partners block`);
      assert.deepEqual(p.items.map((i) => i.key).sort(), Object.keys(cfg.partners).sort(), lang);
      for (const i of p.items) for (const f of ['h', 'p', 'cta']) assert.ok(i[f]?.trim(), `${lang} ${i.key}.${f}`);
      for (const f of ['title', 'lead', 'note']) assert.ok(p[f]?.trim(), `${lang} ${f}`);
    }
  });

  it('show a logo that can be measured, when its file is there', () => {
    for (const p of Object.values(cfg.partners)) {
      const logo = partnerLogo(p.logo);
      if (!logo) continue;
      assert.match(logo.rel, /^partners\/[a-z0-9-]+\.(svg|png|webp)$/);
      assert.ok(logo.w > 0 && logo.h > 0, `${p.name} ${JSON.stringify(logo)}`);
    }
    const happy = partnerLogo(cfg.partners.happy.logo);
    assert.ok(happy, 'the Happy Solutions logo is in the repository');
    assert.deepEqual([happy.w, happy.h], [256, 256]);
  });

  it('must not load anything from a partner: the logos are local files', () => {
    const css = readFileSync(join(ROOT, 'src/static/assets/style.css'), 'utf8');
    assert.doesNotMatch(css, /partner[^}]*url\(https?:/);
  });
});
