// Dependency-free static site build: src/ + data/release.json (+ data/update/ feeds) -> dist/.
// Env overrides: SITE_URL, BASE_PATH (use BASE_PATH= for a custom domain at the root);
// SITE_DATA_DIR and SITE_DIST_DIR (tests only: another data directory / output directory).
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../src/content/en.mjs';
import hu from '../src/content/hu.mjs';
import { FEED_CHANNELS, feedFiles, fillTokens, loadOptiRelease, optiVars, prepareOptiRelease, prepareRelease } from '../src/lib.mjs';
import { pages } from '../src/pages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.SITE_DIST_DIR ?? join(root, 'dist');
const dataDir = process.env.SITE_DATA_DIR ?? join(root, 'data');
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const cfg = readJson('site.config.json');
cfg.siteUrl = (process.env.SITE_URL ?? cfg.siteUrl).replace(/\/$/, '');
cfg.basePath = (process.env.BASE_PATH ?? cfg.basePath).replace(/\/$/, '');
const release = JSON.parse(readFileSync(join(dataDir, 'release.json'), 'utf8'));

const write = (rel, content) => {
  const file = join(dist, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const abs = (path) => `${cfg.siteUrl}${cfg.basePath}${path}`;

rmSync(dist, { recursive: true, force: true });
cpSync(join(root, 'src/static'), dist, { recursive: true });

const PAGES = [['', 'home'], ['intelyide', 'ide'], ['intelyopti', 'opti'], ['download', 'download'], ['privacy', 'privacy'], ['terms', 'terms']];
const langs = [
  { raw: en, prefix: '/', dir: '' },
  { raw: hu, prefix: '/hu/', dir: 'hu/' },
];
const optiRaw = loadOptiRelease(dataDir);
const siteTexts = {};
for (const { raw, prefix, dir } of langs) {
  // One place feeds every price, number and legal link in the copy: site.config.json (see optiVars).
  const t = fillTokens(raw, {
    ...optiVars(cfg, raw.lang),
    privacyHref: `${cfg.basePath}${prefix}privacy/`,
    termsHref: `${cfg.basePath}${prefix}terms/`,
  });
  siteTexts[raw.lang] = t;
  const rel = prepareRelease(release, t);
  const opti = prepareOptiRelease(optiRaw, t);
  for (const [slug, page] of PAGES) {
    const path = `${prefix}${slug ? `${slug}/` : ''}`;
    const ctx = {
      cfg, t, rel, opti, lang: t.lang, path, slug, abs,
      root: '../'.repeat(path.split('/').filter(Boolean).length),
    };
    write(`${dir}${slug ? `${slug}/` : ''}index.html`, pages[page](ctx));
  }
}
const en0 = siteTexts.en;

// GitHub Pages serves 404.html at any depth, so it uses absolute, base-path-aware URLs.
write(
  '404.html',
  pages.notFound({
    cfg, t: en0, rel: prepareRelease(release, en0), opti: {}, lang: 'en', path: '/404.html', slug: '404', abs,
    root: `${cfg.basePath}/`, absoluteLinks: true, noLang: true,
  }),
);

// The signed update feeds (updater spec 4.14): copied byte for byte, never parsed or reformatted.
for (const name of FEED_CHANNELS.flatMap(feedFiles)) {
  const src = join(dataDir, 'update', name);
  if (!existsSync(src)) continue;
  mkdirSync(join(dist, 'update'), { recursive: true });
  copyFileSync(src, join(dist, 'update', name));
}

write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${abs('/sitemap.xml')}\n`);
write(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.flatMap(([slug]) => [`/${slug ? `${slug}/` : ''}`, `/hu/${slug ? `${slug}/` : ''}`])
    .map((p) => `<url><loc>${abs(p)}</loc></url>`)
    .join('\n')}\n</urlset>\n`,
);
write(
  'site.webmanifest',
  JSON.stringify(
    {
      name: 'IntelyHome',
      short_name: 'IntelyHome',
      description: en0.meta.homeDesc,
      start_url: './',
      display: 'browser',
      theme_color: '#7c4dff',
      background_color: '#0b0a14',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
    null,
    2,
  ),
);

// favicon.ico: a one-image ICO wrapping the 32px PNG.
const png = readFileSync(join(root, 'src/static/favicon-32.png'));
const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 32; head[7] = 32; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
write('favicon.ico', Buffer.concat([head, png]));

if (!existsSync(join(dist, 'assets/img/og.png'))) console.warn('warning: assets/img/og.png is missing (social card)');
console.log(`Built ${dist} (siteUrl=${cfg.siteUrl}, basePath="${cfg.basePath}")`);
