// Dependency-free static site build: src/ + data/release.json (+ data/update/ feeds) -> dist/.
// Env overrides: SITE_URL, BASE_PATH (use BASE_PATH= for a custom domain at the root);
// SITE_DATA_DIR and SITE_DIST_DIR (tests only: another data directory / output directory).
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../src/content/en.mjs';
import hu from '../src/content/hu.mjs';
import { FEED_CHANNELS, feedFiles, prepareRelease } from '../src/lib.mjs';
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

const langs = [
  { t: en, prefix: '/', dir: '' },
  { t: hu, prefix: '/hu/', dir: 'hu/' },
];
for (const { t, prefix, dir } of langs) {
  const rel = prepareRelease(release, t);
  const make = (path, extra = {}) => ({
    cfg, t, rel, lang: t.lang, path, abs,
    root: '../'.repeat(path.split('/').filter(Boolean).length),
    ...extra,
  });
  write(`${dir}index.html`, pages.home(make(prefix, { sticky: true })));
  write(`${dir}download/index.html`, pages.download(make(`${prefix}download/`)));
}

// GitHub Pages serves 404.html at any depth, so it uses absolute, base-path-aware URLs.
write(
  '404.html',
  pages.notFound({
    cfg, t: en, rel: prepareRelease(release, en), lang: 'en', path: '/404.html', abs,
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
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/', '/download/', '/hu/', '/hu/download/']
    .map((p) => `<url><loc>${abs(p)}</loc></url>`)
    .join('\n')}\n</urlset>\n`,
);
write(
  'site.webmanifest',
  JSON.stringify(
    {
      name: 'IntelyIDE',
      short_name: 'IntelyIDE',
      description: en.meta.homeDesc,
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
