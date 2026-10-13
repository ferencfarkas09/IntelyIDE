// assets/lead.js against a minimal fake DOM and fetch: validation, honeypot, request shape, success and errors.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/static/assets/lead.js'), 'utf8');
const MSGS = { invalid_email: 'bad email', consent_required: 'need consent', rate_limited: 'slow down', server_error: 'oops', network: 'offline', sending: 'sending' };

function setup(response) {
  const attrs = (o) => ({ setAttribute: (k, v) => (o[k] = v), removeAttribute: (k) => delete o[k], getAttribute: (k) => o[k] });
  const input = (extra = {}) => ({ value: '', checked: false, ...attrs({}), addEventListener() {}, focus() { this.focused = true; }, ...extra });
  const link = { ...attrs({ href: '' }) };
  const done = { hidden: true, focus() { this.focused = true; }, querySelector: () => link };
  const status = { textContent: '', classList: { toggle(c, on) { status.error = on; } } };
  const submit = { disabled: false, textContent: 'Go' };
  const email = input(); const consent = input(); const company = input();
  let onSubmit;
  const form = {
    dataset: { msgs: JSON.stringify(MSGS), api: 'https://api.test', kind: 'download', lang: 'en', source: 'product-page', download: 'https://github.com/o/r/dl.dmg', downloadPrefix: 'https://github.com/o/' },
    elements: { email, consent, company }, hidden: false,
    querySelector: (s) => (s === '.form-status' ? status : submit),
    closest: () => ({ querySelector: () => done }),
    addEventListener: (t, f) => (onSubmit = f), ...attrs({}),
  };
  const calls = [];
  const ctx = {
    document: { querySelectorAll: () => [form] },
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); if (response instanceof Error) throw response; return response; },
    AbortController, setTimeout, clearTimeout, JSON,
  };
  vm.runInNewContext(SRC, ctx);
  const send = () => onSubmit({ preventDefault() {} });
  return { form, email, consent, company, status, submit, done, link, calls, send };
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

describe('lead form', () => {
  it('rejects a bad e-mail and a missing consent without calling the API', async () => {
    const s = setup(reply(200, { ok: true }));
    s.email.value = 'nope';
    await s.send();
    assert.equal(s.status.textContent, 'bad email');
    assert.equal(s.calls.length, 0);
    s.email.value = 'ada@example.com';
    await s.send();
    assert.equal(s.status.textContent, 'need consent');
    assert.equal(s.calls.length, 0);
  });

  it('posts the contract body, then reveals the download with the API link', async () => {
    const s = setup(reply(200, { ok: true, downloadUrl: 'https://github.com/o/r/latest.dmg' }));
    s.email.value = ' ada@example.com ';
    s.consent.checked = true;
    await s.send();
    assert.equal(s.calls[0].url, 'https://api.test/api/lead');
    assert.deepEqual(s.calls[0].body, { email: 'ada@example.com', consent: true, product: 'intelyopti', kind: 'download', lang: 'en', source: 'product-page', company: '' });
    assert.equal(s.form.hidden, true);
    assert.equal(s.done.hidden, false);
    assert.equal(s.link.getAttribute('href'), 'https://github.com/o/r/latest.dmg');
    assert.equal(s.submit.disabled, false);
  });

  it('ignores a download link outside the project GitHub', async () => {
    const s = setup(reply(200, { ok: true, downloadUrl: 'https://evil.example/x.dmg' }));
    s.email.value = 'ada@example.com';
    s.consent.checked = true;
    await s.send();
    assert.equal(s.link.getAttribute('href'), 'https://github.com/o/r/dl.dmg');
  });

  it('shows clear messages for rate limit, server error and network failure', async () => {
    for (const [res, text] of [[reply(429, { ok: false, error: 'rate_limited' }), 'slow down'], [reply(500, { ok: false, error: 'server_error' }), 'oops'], [new Error('down'), 'offline']]) {
      const s = setup(res);
      s.email.value = 'ada@example.com';
      s.consent.checked = true;
      await s.send();
      assert.equal(s.status.textContent, text);
      assert.equal(s.status.error, true);
      assert.equal(s.form.hidden, false);
      assert.equal(s.submit.disabled, false);
    }
  });
});
