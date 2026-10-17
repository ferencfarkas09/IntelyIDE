// Every screenshot is shown as light and dark in one picture, divided by a 45 degree strip.
// node --test site/test/split-shots.test.mjs   (reads src/ only; no build, no network)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { picture, preloadHero } from '../src/lib.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const css = readFileSync(join(SRC, 'static/assets/style.css'), 'utf8');
const count = (s, re) => (s.match(re) ?? []).length;

describe('split screenshots', () => {
  const html = picture('../', 'hero', 'The main window');

  it('draws both themes, the light one first and the dark one on top', () => {
    assert.equal(count(html, /<picture /g), 2);
    assert.ok(html.startsWith('<span class="duo"><picture class="duo-light">'));
    assert.match(html, /<\/picture><picture class="duo-dark" aria-hidden="true">/);
    assert.match(html, /duo-light[\s\S]*hero-light-1440\.webp[\s\S]*duo-dark[\s\S]*hero-dark-1440\.webp/);
  });

  it('gives the alt text to the light picture only; the dark one is a decoration of it', () => {
    assert.equal(count(html, /alt="The main window"/g), 1);
    assert.equal(count(html, /alt=""/g), 1);
    const dark = html.slice(html.indexOf('<picture class="duo-dark"'));
    assert.match(dark, /alt=""/);
    assert.doesNotMatch(dark, /The main window/);
  });

  it('does not depend on the visitor\'s theme: no media-dependent source, nothing for site.js to switch', () => {
    assert.doesNotMatch(html, /media=/);
    assert.doesNotMatch(html, /data-theme/);
  });

  it('needs no inline style (the content security policy has none)', () => {
    assert.doesNotMatch(html, /style=/);
  });

  it('keeps the size attributes of the images, against layout shift', () => {
    assert.equal(count(html, /width="\d+" height="\d+"/g), 2);
  });

  it('passes the loading hint to both images', () => {
    const eager = picture('../', 'hero', 'x', { eager: true });
    assert.equal(count(eager, /fetchpriority="high"/g), 2);
    assert.equal(count(html, /loading="lazy"/g), 2);
  });

  it('shows a slot that exists in one theme only as a plain picture', () => {
    const one = picture('../', 'no-such-shot', 'Nothing');
    assert.doesNotMatch(one, /duo"/);
    assert.equal(count(one, /<picture /g), 1);
  });

  it('preloads both themes of the hero, with no media condition', () => {
    const tags = preloadHero('../').split('\n');
    assert.equal(tags.length, 2);
    assert.match(tags[0], /hero-light-/);
    assert.match(tags[1], /hero-dark-/);
    assert.doesNotMatch(tags.join(''), /media=/);
  });
});

describe('the split in style.css', () => {
  const rule = (selector) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('divides along a true 45 degree line: a gradient angle, not a polygon in percentages', () => {
    assert.match(rule('.duo'), /--duo-line:\s*135deg/);
    const mask = rule('.duo-dark');
    assert.match(mask, /mask-image:\s*linear-gradient\(var\(--duo-line\),\s*transparent 50%,\s*#000 50%\)/);
    assert.match(mask, /-webkit-mask-image/);
    assert.doesNotMatch(css, /clip-path:\s*polygon[^;]*duo/);
  });

  it('marks the line with a strip that stays inside the picture and does not catch the pointer', () => {
    const strip = rule('.duo::after');
    assert.match(strip, /inset:\s*0/);
    assert.match(strip, /pointer-events:\s*none/);
    assert.match(strip, /linear-gradient\(var\(--duo-line\)/);
    assert.match(rule('.duo'), /overflow:\s*hidden/);
  });

  it('keeps both pictures in one grid cell, so the dark one covers the light one exactly', () => {
    assert.match(rule('.duo > picture'), /grid-area:\s*1 \/ 1/);
    assert.match(rule('.duo'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('does not reuse the two-column layout class of the page', () => {
    assert.doesNotMatch(picture('../', 'hero', 'x'), /class="split/);
  });
});
