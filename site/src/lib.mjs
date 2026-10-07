import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFeed } from '../../scripts/release/updater/lib/feed.mjs';
import { CHANNELS, LIMITS, PAGES_BASE_PATH, PAGES_HOST, RELEASE_HOST, REPO_SLUG } from '../../scripts/release/updater/names.mjs';
import { WIDTHS } from '../scripts/shots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const IMG = join(here, 'static/assets/img');

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function fmtSize(size) {
  if (typeof size !== 'number') return String(size ?? '');
  return size >= 1048576 ? `${Math.round(size / 1048576)}\u00a0MB` : `${Math.max(1, Math.round(size / 1024))}\u00a0KB`;
}

function fmtDate(value, locale) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value)
    : new Intl.DateTimeFormat(locale.replace('_', '-'), { dateStyle: 'long', timeZone: 'UTC' }).format(d);
}

/** Turns data/release.json into everything the templates need. */
export function prepareRelease(release, t) {
  const assets = (release.assets ?? []).map((a) => ({
    ...a,
    archLabel: t.dl.arch[a.arch] ?? a.arch,
    sizeLabel: fmtSize(a.size),
    ext: extname(a.name),
  }));
  const primary =
    assets.find((a) => a.arch === 'universal') ?? assets.find((a) => a.arch === release.primaryArch) ?? assets[0] ?? null;
  const archs = new Set(assets.map((a) => a.arch));
  let archKey = null;
  if (archs.has('universal')) archKey = 'universal';
  else if (archs.has('x64') && archs.has('arm64')) archKey = 'both';
  else if (archs.has('x64')) archKey = release.appleSiliconPlanned ? 'x64Planned' : 'x64';
  else if (archs.has('arm64')) archKey = 'arm64';
  return {
    version: release.version,
    statusLabel: t.dl.status[release.status] ?? release.status ?? '',
    // A stable release (or no status) carries no pre-release notice; "alpha"/"beta" still do, for old data.
    notice: release.status && release.status !== 'stable' ? t.dl.preNotice : '',
    sumsUrl: release.sha256sumsUrl ?? (primary ? primary.url.replace(/[^/]*$/, 'SHA256SUMS') : ''),
    date: fmtDate(release.date, t.locale),
    minMac: release.minMacOS,
    signed: release.signed === true,
    notesUrl: release.notesUrl,
    assets,
    primary,
    others: assets.filter((a) => a !== primary),
    swap: assets.length === 2 && archs.has('x64') && archs.has('arm64'),
    archNote: archKey ? t.dl.archNote[archKey] : '',
  };
}

/** Relative URL from one site path (e.g. "/hu/download/") to another ("/"). */
export function relUrl(from, to) {
  const depth = from.split('/').filter(Boolean).length;
  return '../'.repeat(depth) + to.replace(/^\//, '') || './';
}

const has = (file) => existsSync(join(IMG, file));

/**
 * <picture> for a themed image. Real files named <name>-<theme>-<width>.<fmt> in img/shots win;
 * otherwise the SVG placeholder is used. The dark <source> carries data-theme="dark" so site.js
 * can follow the manual theme toggle (see applyTheme there).
 */
export function picture(root, name, alt, { eager = false, sizes = '(min-width: 1000px) 640px, 92vw', w = 1440, h = 900 } = {}) {
  const dark = '(prefers-color-scheme: dark)';
  const real = (theme, fmt) => WIDTHS.filter((x) => has(`shots/${name}-${theme}-${x}.${fmt}`));
  const hasReal = real('light', 'png').length > 0;
  const loading = eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"';
  if (!hasReal) {
    const src = (theme) => `${root}assets/img/placeholders/${name}-${theme}.svg`;
    return `<picture><source media="${dark}" data-theme="dark" srcset="${src('dark')}" type="image/svg+xml"><img src="${src('light')}" alt="${esc(alt)}" width="${w}" height="${h}" ${loading}></picture>`;
  }
  const srcset = (theme, fmt) =>
    real(theme, fmt).map((x) => `${root}assets/img/shots/${name}-${theme}-${x}.${fmt} ${x}w`).join(', ');
  const types = { avif: 'image/avif', webp: 'image/webp', png: 'image/png' };
  const sources = (theme) =>
    ['avif', 'webp', 'png']
      .filter((fmt) => real(theme, fmt).length)
      .map((fmt) => {
        const media = theme === 'dark' ? ` media="${dark}" data-theme="dark"` : '';
        return `<source${media} type="${types[fmt]}" srcset="${srcset(theme, fmt)}" sizes="${sizes}">`;
      })
      .join('');
  const widths = real('light', 'png');
  const fallback = `${root}assets/img/shots/${name}-light-${widths[widths.length - 1]}.png`;
  return `<picture>${sources('dark')}${sources('light')}<img src="${fallback}" srcset="${srcset('light', 'png')}" sizes="${sizes}" alt="${esc(alt)}" width="${w}" height="${h}" ${loading}></picture>`;
}

/** Hero preload tags; one per colour scheme so only the matching image is fetched. */
export function preloadHero(root) {
  return ['light', 'dark']
    .map((theme) => {
      const real = WIDTHS.filter((x) => has(`shots/hero-${theme}-${x}.webp`));
      const media = `(prefers-color-scheme: ${theme})`;
      if (!real.length) return `<link rel="preload" as="image" href="${root}assets/img/placeholders/hero-${theme}.svg" media="${media}">`;
      const best = real[real.length - 1];
      return `<link rel="preload" as="image" type="image/webp" href="${root}assets/img/shots/hero-${theme}-${best}.webp" imagesrcset="${real.map((x) => `${root}assets/img/shots/hero-${theme}-${x}.webp ${x}w`).join(', ')}" imagesizes="(min-width: 1000px) 1040px, 92vw" media="${media}">`;
    })
    .join('\n');
}

const svg = (attrs, inner) => `<svg ${attrs} aria-hidden="true" focusable="false">${inner}</svg>`;
export const icons = {
  download: (cls = '') =>
    svg(
      `class="icon-dl ${cls}" viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"`,
      '<g class="icon-dl-arrow"><path d="M24 6v24"/><path d="M14 21l10 10 10-10"/></g><path d="M8 33v5a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3v-5"/>',
    ),
  github: (size = 20) =>
    svg(
      `viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"`,
      '<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
    ),
  theme: () =>
    svg(
      'class="icon-theme" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"',
      '<path class="i-moon" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/><g class="i-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g>',
    ),
  menu: () =>
    svg(
      'viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"',
      '<path d="M4 7h16M4 12h16M4 17h16"/>',
    ),
  arrow: () =>
    svg(
      'viewBox="0 0 64 24" width="64" height="24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"',
      '<path d="M2 12h58M50 4l10 8-10 8"/>',
    ),
  folder: () =>
    svg(
      'viewBox="0 0 96 80" width="96" height="80"',
      '<path d="M6 16a8 8 0 0 1 8-8h22l8 10h38a8 8 0 0 1 8 8v42a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z" fill="#4aa8ff"/><path d="M6 30a8 8 0 0 1 8-8h68a8 8 0 0 1 8 8v36a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z" fill="#7cc4ff"/>',
    ),
};

/** Feed files the site serves verbatim under /update/ (updater spec 4.14). */
export const FEED_CHANNELS = CHANNELS;
export const feedFiles = (channel) => [`${channel}.json`, `${channel}.json.sig`];

const SIG_MAX = LIMITS.sigBytes;
const ownLinks = [`https://${RELEASE_HOST}/${REPO_SLUG}/`, `https://${PAGES_HOST}${PAGES_BASE_PATH}/`];

/**
 * Checks the committed, signed feeds in `updateDir` (the bytes the site copies to dist/update/).
 * Pure file checks: the signature itself is verified by verify-feed.mjs (it needs the embedded keys).
 * - `release`: parsed data/release.json; the stable feed must announce the same version.
 * - `prevDir`: optional directory with the previous published feeds; `seq` must not go back or stand
 *   still with different bytes (a feed with `floorReset` is the standby's deliberate exception).
 * @returns {string[]} problems (empty = ok; an empty directory is ok: no feed published yet)
 */
export function checkUpdateFeeds({ updateDir, release, prevDir }) {
  const problems = [];
  const read = (dir, name) => (dir && existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : null);
  const known = new Set(FEED_CHANNELS.flatMap(feedFiles).concat('.gitkeep'));
  if (existsSync(updateDir)) {
    for (const name of readdirSync(updateDir)) if (!known.has(name)) problems.push(`update/${name}: unexpected file`);
  }
  for (const channel of FEED_CHANNELS) {
    const [jsonName, sigName] = feedFiles(channel);
    const body = read(updateDir, jsonName);
    const sig = read(updateDir, sigName);
    if (!body && !sig) continue;
    if (!body) { problems.push(`update/${jsonName}: missing (its .sig is present)`); continue; }
    if (!sig) { problems.push(`update/${sigName}: missing`); continue; }
    if (sig.length === 0 || sig.length >= SIG_MAX) problems.push(`update/${sigName}: must be non-empty and below ${SIG_MAX} bytes`);
    else if (!sig.toString('utf8').startsWith('untrusted comment:')) problems.push(`update/${sigName}: not a minisign signature file`);
    if (body.length > LIMITS.feedBytes) { problems.push(`update/${jsonName}: over ${LIMITS.feedBytes} bytes`); continue; }
    const text = body.toString('utf8');
    let feed;
    try { feed = JSON.parse(text); } catch (e) { problems.push(`update/${jsonName}: not JSON (${e.message})`); continue; }
    for (const p of validateFeed(feed, { channel })) problems.push(`update/${jsonName}: ${p}`);
    for (const [url] of text.matchAll(/https?:\/\/[^\s"'<>)\\]+/g)) {
      if (!ownLinks.some((a) => url.startsWith(a))) problems.push(`update/${jsonName}: URL outside the project hosts: ${url}`);
    }
    if (channel === 'stable' && release && feed.version !== release.version) {
      problems.push(`update/${jsonName}: version ${feed.version} differs from data/release.json ${release.version}`);
    }
    const prevBody = read(prevDir, jsonName);
    if (prevBody) {
      let prev = null;
      try { prev = JSON.parse(prevBody.toString('utf8')); } catch { problems.push(`previous ${jsonName}: not JSON`); }
      if (prev && Number.isInteger(prev.seq) && Number.isInteger(feed.seq) && feed.floorReset === undefined) {
        if (feed.seq < prev.seq) problems.push(`update/${jsonName}: seq ${feed.seq} is below the previous ${prev.seq}`);
        else if (feed.seq === prev.seq && !prevBody.equals(body)) problems.push(`update/${jsonName}: seq ${feed.seq} is unchanged but the bytes differ`);
      }
    }
  }
  return problems;
}
