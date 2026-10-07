// Fails the build on: external URLs outside the allow-list, <img> without alt,
// and (with --prod) any REPLACE_ME / REPO-NAME placeholder left in dist/.
// Also checks the signed update feeds (data/update/ and their verbatim copy in dist/update/).
// Options: --prev-update-dir <dir> (previous published feeds: seq must not go back).
// Env (tests only): SITE_DATA_DIR, SITE_DIST_DIR.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEED_CHANNELS, checkUpdateFeeds, feedFiles } from '../src/lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.SITE_DIST_DIR ?? join(root, 'dist');
const dataDir = process.env.SITE_DATA_DIR ?? join(root, 'data');
const prevIdx = process.argv.indexOf('--prev-update-dir');
const prevDir = prevIdx > 0 ? process.argv[prevIdx + 1] : undefined;
const prod = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';
const cfg = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8'));
const siteUrl = (process.env.SITE_URL ?? cfg.siteUrl).replace(/\/$/, '');

// Allowed external URL prefixes: the project's GitHub repository, the IntelyHome site, the site itself,
// and XML/JSON-LD namespace identifiers that are never fetched.
const allowed = [
  cfg.repoUrl, cfg.orgUrl, siteUrl,
  'https://schema.org', 'http://www.w3.org/2000/svg', 'http://www.sitemaps.org/schemas/sitemap/0.9',
];
const textExt = new Set(['.html', '.css', '.js', '.svg', '.xml', '.webmanifest', '.txt']);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const problems = [];
const warnings = [];
for (const file of walk(dist)) {
  const name = file.slice(dist.length + 1);
  if (!textExt.has(extname(file)) || name.endsWith('OFL.txt')) continue;
  const text = readFileSync(file, 'utf8');
  for (const [url] of text.matchAll(/https?:\/\/[^\s"'<>)\\]+/g)) {
    if (!allowed.some((a) => url.startsWith(a))) problems.push(`${name}: external URL ${url}`);
  }
  if (extname(file) === '.html') {
    for (const [tag] of text.matchAll(/<img\b[^>]*>/g)) {
      if (!/\balt=/.test(tag)) problems.push(`${name}: <img> without alt: ${tag.slice(0, 80)}`);
    }
    if (text.includes('TODO-CONFIRM')) warnings.push(`${name}: contains a TODO-CONFIRM marker (maintainer must confirm before launch)`);
  }
  if (prod) {
    for (const marker of ['REPLACE_ME', 'REPO-NAME']) {
      if (text.includes(marker)) problems.push(`${name}: placeholder ${marker} left in production build`);
    }
  }
}

const updateDir = join(dataDir, 'update');
problems.push(
  ...checkUpdateFeeds({ updateDir, release: JSON.parse(readFileSync(join(dataDir, 'release.json'), 'utf8')), prevDir }),
);
// dist/update must be the committed bytes, verbatim.
for (const name of FEED_CHANNELS.flatMap(feedFiles)) {
  const src = join(updateDir, name);
  const out = join(dist, 'update', name);
  if (existsSync(src) && !(existsSync(out) && readFileSync(out).equals(readFileSync(src)))) {
    problems.push(`dist/update/${name}: differs from data/update/${name} (rebuild the site)`);
  }
  if (!existsSync(src) && existsSync(out)) problems.push(`dist/update/${name}: has no source in data/update/`);
}

warnings.forEach((w) => console.warn(`warn: ${w}`));
if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join('\n'));
  process.exit(1);
}
console.log(`check-site: OK (${prod ? 'production' : 'development'} mode)`);
