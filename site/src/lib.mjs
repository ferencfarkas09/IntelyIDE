import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFeed } from '../../scripts/release/updater/lib/feed.mjs';
import { CHANNELS, LIMITS, PAGES_BASE_PATH, PAGES_HOST, RELEASE_HOST, REPO_SLUG } from '../../scripts/release/updater/names.mjs';
import { DEFAULT_DIMS, DIMS, OPTI_DIMS, OPTI_WIDTHS, WIDTHS } from '../scripts/shots.mjs';

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

const KIND_BY_EXT = { '.dmg': 'dmg', '.exe': 'nsis', '.msi': 'msi', '.appimage': 'appimage', '.deb': 'deb' };
const PLATFORM_OF = { dmg: 'mac', nsis: 'windows', msi: 'windows', appimage: 'linux', deb: 'linux' };

/**
 * The files of data/release.json as one flat list. Two shapes are read:
 * - assets keyed by platform (current): { mac: {...}, windows: { nsis, msi }, linux: { appimage, deb } }
 * - assets as an array (older data): every entry is classified by its file extension.
 */
function flattenAssets(release) {
  const raw = release.assets ?? [];
  if (Array.isArray(raw)) {
    return raw.map((a) => {
      const kind = KIND_BY_EXT[extname(a.name).toLowerCase()] ?? 'dmg';
      return { ...a, kind, platform: PLATFORM_OF[kind] };
    });
  }
  const list = [];
  if (raw.mac) list.push({ ...raw.mac, kind: 'dmg', platform: 'mac' });
  for (const kind of ['nsis', 'msi']) if (raw.windows?.[kind]) list.push({ ...raw.windows[kind], kind, platform: 'windows' });
  for (const kind of ['appimage', 'deb']) if (raw.linux?.[kind]) list.push({ ...raw.linux[kind], kind, platform: 'linux' });
  return list;
}

/** Turns data/release.json into everything the templates need. */
export function prepareRelease(release, t) {
  const assets = flattenAssets(release).map((a) => ({
    ...a,
    arch: a.arch ?? 'x64',
    archLabel: a.platform === 'mac' ? (t.dl.arch[a.arch] ?? a.arch) : t.dl.arch.pc,
    kindLabel: t.dl.kind?.[a.kind] ?? a.kind,
    sizeLabel: fmtSize(a.size),
    ext: extname(a.name),
  }));
  const byKind = (k) => assets.find((a) => a.kind === k) ?? null;
  const platforms = { mac: byKind('dmg'), windows: { nsis: byKind('nsis'), msi: byKind('msi') }, linux: { appimage: byKind('appimage'), deb: byKind('deb') } };
  // The macOS file is still `primary` (the metadata, the JSON-LD and the install steps are about the macOS app); with files for
  // other platforms too the page offers the visitor's own file (`multi`).
  const macAssets = assets.filter((a) => a.platform === 'mac');
  const multi = assets.some((a) => a.platform !== 'mac');
  const primary =
    macAssets.find((a) => a.arch === 'universal') ?? macAssets.find((a) => a.arch === release.primaryArch) ?? macAssets[0] ?? (multi ? null : assets[0] ?? null);
  const archs = new Set(macAssets.map((a) => a.arch));
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
    windowsSigned: release.windowsSigned === true,
    notesUrl: release.notesUrl,
    assets,
    platforms,
    multi,
    primary,
    others: macAssets.filter((a) => a !== primary),
    swap: !multi && macAssets.length === 2 && archs.has('x64') && archs.has('arm64'),
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
 * A screenshot as light and dark side by side: both themes are drawn on top of each other and the dark one is masked to the lower right of a
 * 45 degree line through the middle, with a strip along the line (see .duo in style.css). Real files named <name>-<theme>-<width>.<fmt> in
 * img/shots win; otherwise the SVG placeholders are used. The visitor's own theme does not matter here: both are always shown, so there are no
 * media-dependent <source>s and site.js has nothing to switch. The light picture carries the alt text; the dark one repeats it, so it is hidden
 * from assistive technology. A slot with only one theme is shown as a plain picture.
 * Slots named opti-* use the IntelyOpti widths and aspect ratio; any subset of widths is fine.
 */
export function picture(root, name, alt, { eager = false, sizes = '(min-width: 1000px) 640px, 92vw' } = {}) {
  const opti = name.startsWith('opti-');
  const [w, h] = opti ? OPTI_DIMS : (DIMS[name] ?? DEFAULT_DIMS);
  const widths = opti ? OPTI_WIDTHS : WIDTHS;
  const real = (theme, fmt) => widths.filter((x) => has(`shots/${name}-${theme}-${x}.${fmt}`));
  const loading = eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"';
  const types = { avif: 'image/avif', webp: 'image/webp', png: 'image/png' };
  const half = (theme) => {
    const cls = `duo-${theme}`;
    const hidden = theme === 'dark' ? ' aria-hidden="true"' : '';
    const text = theme === 'dark' ? '' : esc(alt);
    if (real(theme, 'png').length === 0) {
      const src = `${root}assets/img/placeholders/${name}-${theme}.svg`;
      return `<picture class="${cls}"${hidden}><img src="${src}" alt="${text}" width="${w}" height="${h}" ${loading}></picture>`;
    }
    const srcset = (fmt) => real(theme, fmt).map((x) => `${root}assets/img/shots/${name}-${theme}-${x}.${fmt} ${x}w`).join(', ');
    const sources = ['avif', 'webp', 'png']
      .filter((fmt) => real(theme, fmt).length)
      .map((fmt) => `<source type="${types[fmt]}" srcset="${srcset(fmt)}" sizes="${sizes}">`)
      .join('');
    const largest = real(theme, 'png');
    const fallback = `${root}assets/img/shots/${name}-${theme}-${largest[largest.length - 1]}.png`;
    return `<picture class="${cls}"${hidden}>${sources}<img src="${fallback}" srcset="${srcset('png')}" sizes="${sizes}" alt="${text}" width="${w}" height="${h}" ${loading}></picture>`;
  };
  const hasTheme = (theme) => real(theme, 'png').length > 0 || has(`placeholders/${name}-${theme}.svg`);
  if (!hasTheme('dark')) return half('light');
  return `<span class="duo">${half('light')}${half('dark')}</span>`;
}

/** Hero preload tags: both themes, since the hero is shown as a split of the two. */
export function preloadHero(root) {
  return ['light', 'dark']
    .map((theme) => {
      const real = WIDTHS.filter((x) => has(`shots/hero-${theme}-${x}.webp`));
      if (!real.length) return `<link rel="preload" as="image" href="${root}assets/img/placeholders/hero-${theme}.svg">`;
      const best = real[real.length - 1];
      return `<link rel="preload" as="image" type="image/webp" href="${root}assets/img/shots/hero-${theme}-${best}.webp" imagesrcset="${real.map((x) => `${root}assets/img/shots/hero-${theme}-${x}.webp ${x}w`).join(', ')}" imagesizes="(min-width: 1000px) 1040px, 92vw">`;
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

const ICON_PATHS = {
  layers: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  rewind: '<path d="M11 19 2 12l9-7v14z"/><path d="M22 19l-9-7 9-7v14z"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  contract: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m22 4-10 10-3-3"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  thermo: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
  wifi: '<path d="M5 12.6a10 10 0 0 1 14 0"/><path d="M1.4 9a15 15 0 0 1 21.2 0"/><path d="M8.5 16.1a6 6 0 0 1 7 0"/><path d="M12 20h.01"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  pie: '<path d="M21.2 15.9A10 10 0 1 1 8 2.8"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
  battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  branch: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8"/><path d="M18 10a6 6 0 0 1-6 6H8"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10"/>',
  feed: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  badge: '<path d="M12 2l2.4 1.8 3 .1 1 2.8 2.4 1.8-.9 2.9.9 2.9-2.4 1.8-1 2.8-3 .1L12 22l-2.4-1.8-3-.1-1-2.8-2.4-1.8.9-2.9-.9-2.9 2.4-1.8 1-2.8 3-.1z"/><path d="m9 12 2 2 4-4"/>',
  chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  drive: '<path d="M22 12H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/><path d="M6 16h.01M10 16h.01"/>',
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><path d="M12 2v10"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
};
/** Decorative stroke icon by name (see ICON_PATHS). */
export const icon = (name, size = 24) =>
  svg(`class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`, ICON_PATHS[name] ?? '');

/** Replaces {{key}} in every string of a content tree (deep copy). Unknown keys fail the build loudly. */
export function fillTokens(node, vars) {
  if (typeof node === 'string') {
    return node.replace(/\{\{(\w+)\}\}/g, (_, k) => {
      if (!(k in vars)) throw new Error(`unknown content token {{${k}}}`);
      return vars[k];
    });
  }
  if (Array.isArray(node)) return node.map((x) => fillTokens(x, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillTokens(v, vars)]));
  return node;
}

/** Money for the page copy, from the plain numbers in site.config.json ("19.99" -> "$19.99" / "19,99 USD"). */
export function money(amount, lang, currency = 'USD') {
  if (lang === 'hu') return `${String(amount).replace('.', ',')} ${currency}`;
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

/** Copy variables for the IntelyOpti numbers: one place (site.config.json) feeds every page and language. */
export function optiVars(cfg, lang) {
  const o = cfg.intelyopti;
  return {
    trial: String(o.trialDays),
    freeMB: String(o.freeCleanMB),
    yearly: money(o.yearlyPrice, lang, o.currency),
    lifetime: money(o.lifetimePrice, lang, o.currency),
    minMac: String(o.minMacOS),
  };
}

/** Display-ready IntelyOpti release facts (size and date formatted); absent fields stay absent. */
export function prepareOptiRelease(raw, t) {
  const out = { ...raw };
  if (out.size !== undefined) out.size = fmtSize(out.size);
  if (out.date !== undefined) out.date = fmtDate(out.date, t.locale);
  return out;
}

/** Reads data/intelyopti-release.json when it exists; the pages work without it. */
export function loadOptiRelease(dataDir) {
  const file = join(dataDir, 'intelyopti-release.json');
  if (!existsSync(file)) return {};
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(r).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== ''));
  } catch {
    return {};
  }
}

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
