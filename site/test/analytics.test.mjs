// Consent logic of assets/analytics.js against a minimal fake browser. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/static/assets/analytics.js'), 'utf8');

function browser(saved) {
  const store = new Map(saved ? [['ga-consent', saved]] : []);
  const appended = [];
  const listeners = {};
  const banner = { hidden: true, querySelector: () => ({ focus() {} }) };
  const doc = {
    cookie: '_ga=1; _ga_ABC=2; other=3',
    documentElement: { lang: 'en', dataset: {} },
    body: { getAttribute: () => '1.2.3' },
    head: { appendChild: (s) => appended.push(s) },
    createElement: () => ({}),
    getElementById: (id) => (id === 'consent' ? banner : null),
    addEventListener: (t, f) => (listeners[t] = f),
  };
  const win = {
    document: doc,
    location: { hostname: 'www.example.com' },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  vm.runInNewContext(SRC, { window: win, decodeURIComponent });
  const el = (attrs, closest = {}) => ({
    getAttribute: (k) => attrs[k] ?? null,
    closest: (sel) => (closest[sel] === undefined ? null : closest[sel]),
  });
  const click = (target) => listeners.click({ target });
  const target = (sel, attrs) => {
    const e = el(attrs);
    return { closest: (s) => (s === sel ? e : null) };
  };
  return { win, banner, appended, store, click, target, doc };
}

describe('analytics consent', () => {
  it('shows the banner and loads nothing on a first visit', () => {
    const b = browser();
    assert.equal(b.banner.hidden, false);
    assert.equal(b.appended.length, 0);
    assert.equal(b.win.dataLayer.length, 0);
  });

  it('loads gtag only after Accept, with advertising consent denied', () => {
    const b = browser();
    b.click(b.target('[data-consent]', { 'data-consent': 'granted' }));
    assert.equal(b.banner.hidden, true);
    assert.equal(b.store.get('ga-consent'), 'granted');
    assert.equal(b.appended[0].src, 'https://www.googletagmanager.com/gtag/js?id=G-NY3S7X9J5P');
    const [def, upd] = b.win.dataLayer.map((a) => [...a]);
    assert.deepEqual(def.slice(0, 2), ['consent', 'default']);
    assert.equal(def[2].ad_storage, 'denied');
    assert.equal(def[2].ad_user_data, 'denied');
    assert.equal(def[2].ad_personalization, 'denied');
    assert.equal(JSON.stringify(upd), JSON.stringify(['consent', 'update', { analytics_storage: 'granted' }]));
  });

  it('sends nothing after Decline', () => {
    const b = browser();
    b.click(b.target('[data-consent]', { 'data-consent': 'denied' }));
    b.click(b.target('[data-ga]', { 'data-ga': 'nav', 'data-ga-label': 'faq' }));
    assert.equal(b.appended.length, 0);
    assert.equal(b.win.dataLayer.length, 0);
    assert.equal(b.store.get('ga-consent'), 'denied');
  });

  it('stays quiet on later visits after Decline and loads on a stored Accept', () => {
    assert.equal(browser('denied').banner.hidden, true);
    assert.equal(browser('denied').appended.length, 0);
    assert.equal(browser('granted').appended.length, 1);
  });

  it('sends download_click with version, file name, location and language', () => {
    const b = browser('granted');
    const n = b.win.dataLayer.length;
    b.click(b.target('[data-ga]', { 'data-ga': 'download', 'data-ga-label': 'hero-dl', href: 'https://github.com/o/r/releases/download/v1.2.3/IntelyIDE_1.2.3_x64.dmg' }));
    const ev = [...b.win.dataLayer[n]];
    assert.equal(ev[0], 'event');
    assert.equal(ev[1], 'download_click');
    assert.deepEqual({ ...ev[2] }, { link_location: 'hero-dl', language: 'en', transport_type: 'beacon', file_name: 'IntelyIDE_1.2.3_x64.dmg', version: '1.2.3' });
  });

  it('keeps the raw file name when the link has a malformed escape', () => {
    const b = browser('granted');
    const n = b.win.dataLayer.length;
    b.click(b.target('[data-ga]', { 'data-ga': 'download', 'data-ga-label': 'hero-dl', href: 'https://example.org/dl/bad%E0%A4%A.dmg' }));
    assert.equal([...b.win.dataLayer[n]][2].file_name, 'bad%E0%A4%A.dmg');
  });

  it('maps the other kinds to their event names', () => {
    const b = browser('granted');
    for (const [kind, name] of [['nav', 'nav_click'], ['cta', 'cta_click'], ['lang', 'language_switch'], ['theme', 'theme_toggle']]) {
      const n = b.win.dataLayer.length;
      b.click(b.target('[data-ga]', { 'data-ga': kind, 'data-ga-label': 'x' }));
      assert.equal([...b.win.dataLayer[n]][1], name);
    }
  });

  it('withdrawing stops events, denies storage and clears the _ga cookies', () => {
    const b = browser('granted');
    b.click(b.target('[data-consent]', { 'data-consent': 'denied' }));
    const n = b.win.dataLayer.length;
    assert.equal(JSON.stringify([...b.win.dataLayer[n - 1]]), JSON.stringify(['consent', 'update', { analytics_storage: 'denied' }]));
    b.click(b.target('[data-ga]', { 'data-ga': 'nav', 'data-ga-label': 'faq' }));
    assert.equal(b.win.dataLayer.length, n);
    assert.equal(b.win['ga-disable-G-NY3S7X9J5P'], true);
    assert.match(b.doc.cookie, /_ga_ABC=; expires=Thu, 01 Jan 1970/);
  });

  it('reopens the banner from Cookie settings', () => {
    const b = browser('denied');
    b.click(b.target('[data-consent-open]', {}));
    assert.equal(b.banner.hidden, false);
  });
});
