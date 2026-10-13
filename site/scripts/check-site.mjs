// Fails the build on: external URLs outside the allow-list, <img> without alt,
// and (with --prod) any REPLACE_ME / REPO-NAME placeholder left in dist/.
// Also checks the signed update feeds (data/update/ and their verbatim copy in dist/update/).
// Options: --prev-update-dir <dir> (previous published feeds: seq must not go back).
// Env (tests only): SITE_DATA_DIR, SITE_DIST_DIR.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, posix } from 'node:path';
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
// the Google Analytics hosts (loaded only after consent, see assets/analytics.js), and XML/JSON-LD namespace identifiers that are never fetched.
const allowed = [
  cfg.repoUrl, cfg.githubUrl, cfg.orgUrl, siteUrl, cfg.apiBase,
  ...[cfg.checkout?.yearlyUrl, cfg.checkout?.lifetimeUrl].filter(Boolean),
  'https://www.googletagmanager.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://schema.org', 'http://www.w3.org/2000/svg', 'http://www.sitemaps.org/schemas/sitemap/0.9',
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

// ---- Page expectations: every page exists in EN and HU, is well formed, and its internal links resolve ------------
const basePath = (process.env.BASE_PATH ?? cfg.basePath).replace(/\/$/, '');
const SLUGS = ['', 'intelyide', 'intelyopti', 'download', 'privacy', 'terms'];
const pagePathOf = (lang, slug) => `${lang === 'hu' ? '/hu/' : '/'}${slug ? `${slug}/` : ''}`;
const fileOf = (path) => join(dist, path.slice(1), 'index.html');
const read = (file) => readFileSync(file, 'utf8');
const idsOf = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const pageHtml = new Map();
for (const lang of ['en', 'hu']) {
  for (const slug of SLUGS) {
    const path = pagePathOf(lang, slug);
    const file = fileOf(path);
    if (!existsSync(file)) { problems.push(`${path}: page was not built`); continue; }
    pageHtml.set(path, read(file));
  }
}
if (existsSync(join(dist, '404.html'))) pageHtml.set('/404.html', read(join(dist, '404.html')));
else problems.push('404.html: missing');

const expectCsp = ["connect-src 'self' https://api.intelyhome.com", "form-action 'self'", "script-src 'self'", "default-src 'none'"];
for (const [path, html] of pageHtml) {
  const name = `${path}`;
  const count = (re) => (html.match(re) ?? []).length;
  if (count(/<h1[\s>]/g) !== 1) problems.push(`${name}: expected exactly one <h1>, found ${count(/<h1[\s>]/g)}`);
  const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
  if (!title) problems.push(`${name}: missing <title>`);
  if (!/<meta name="description" content="[^"]{20,}"/.test(html)) problems.push(`${name}: missing meta description`);
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
  for (const part of expectCsp) if (!csp.includes(part)) problems.push(`${name}: CSP lacks "${part}"`);
  if (/form-action 'none'/.test(csp) || /unsafe-inline|unsafe-eval/.test(csp)) problems.push(`${name}: CSP is broader than allowed`);
  if (/\son[a-z]+="/i.test(html)) problems.push(`${name}: inline event handler (the CSP forbids it)`);
  if (/\{\{\w+\}\}/.test(html)) problems.push(`${name}: unreplaced {{token}}`);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) problems.push(`${name}: duplicate id ${[...new Set(dup)].join(', ')}`);
  if (path !== '/404.html') {
    if (!html.includes(`<link rel="canonical" href="${siteUrl}${basePath}${path}">`)) problems.push(`${name}: canonical link missing or wrong`);
    const slugPart = path.replace(/^\/hu\//, '/');
    for (const [hl, target] of [['en', slugPart], ['hu', `/hu${slugPart}`], ['x-default', slugPart]]) {
      if (!html.includes(`hreflang="${hl}" href="${siteUrl}${basePath}${target}"`)) problems.push(`${name}: hreflang ${hl} missing or wrong`);
    }
    for (const k of ['og:title', 'og:description', 'og:url', 'og:image']) if (!html.includes(`property="${k}"`)) problems.push(`${name}: ${k} missing`);
    if (!html.includes('name="twitter:card"')) problems.push(`${name}: twitter:card missing`);
    if (!html.includes('class="skip"') || !html.includes('<main id="main">')) problems.push(`${name}: skip link or <main> landmark missing`);
  }
  // JSON-LD must parse; products carry SoftwareApplication data and never an aggregateRating.
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)) {
    try {
      const data = JSON.parse(json);
      if (JSON.stringify(data).includes('aggregateRating')) problems.push(`${name}: JSON-LD contains aggregateRating`);
    } catch (e) { problems.push(`${name}: JSON-LD is not valid JSON (${e.message})`); }
  }
  // Internal links and fragments must resolve to files and ids in dist/.
  for (const [, raw] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|data:|#$)/.test(raw)) continue;
    const [pathPart, frag] = raw.split('#');
    let target;
    if (!pathPart) target = path === '/404.html' ? '/404.html' : path;
    else if (pathPart.startsWith('/')) target = basePath && pathPart.startsWith(basePath + '/') ? pathPart.slice(basePath.length) : pathPart;
    else target = posix.normalize(posix.join(path === '/404.html' ? '/' : path, pathPart));
    const disk = join(dist, target.slice(1));
    const isDir = target.endsWith('/') || (existsSync(disk) && statSync(disk).isDirectory());
    const file = isDir ? join(disk, 'index.html') : disk;
    if (!existsSync(file)) { problems.push(`${name}: broken link ${raw}`); continue; }
    if (frag && file.endsWith('.html')) {
      const targetHtml = pageHtml.get(isDir ? (target.endsWith('/') ? target : `${target}/`) : target) ?? read(file);
      if (!idsOf(targetHtml).has(decodeURIComponent(frag))) problems.push(`${name}: fragment #${frag} not found in ${target}`);
    }
  }
}
// Product pages: JSON-LD type, the lead form contract and the checkout switch.
for (const lang of ['en', 'hu']) {
  const opti = pageHtml.get(pagePathOf(lang, 'intelyopti')) ?? '';
  const ide = pageHtml.get(pagePathOf(lang, 'intelyide')) ?? '';
  if (!/"@type":"SoftwareApplication","name":"IntelyOpti"/.test(opti)) problems.push(`${lang}/intelyopti: SoftwareApplication JSON-LD missing`);
  if (!opti.includes(`"price":"${cfg.intelyopti.yearlyPrice}"`)) problems.push(`${lang}/intelyopti: JSON-LD offer price differs from site.config.json`);
  if (!/"@type":"SoftwareApplication","name":"IntelyIDE"/.test(ide) || !ide.includes('"price":"0"')) problems.push(`${lang}/intelyide: SoftwareApplication JSON-LD (price 0) missing`);
  if (!opti.includes('name="company"') || !opti.includes('data-kind="download"') || !opti.includes('type="checkbox"')) problems.push(`${lang}/intelyopti: download form (e-mail, consent, honeypot "company") missing`);
  if (!opti.includes('role="status" aria-live="polite"')) problems.push(`${lang}/intelyopti: form status is not an aria-live region`);
  if (!cfg.checkout?.enabled && !opti.includes('data-kind="waitlist"')) problems.push(`${lang}/intelyopti: checkout is disabled but the waitlist form is missing`);
  if (cfg.checkout?.enabled && (!cfg.checkout.yearlyUrl || !cfg.checkout.lifetimeUrl)) problems.push('site.config.json: checkout.enabled is true but a checkout URL is empty');
  const home = pageHtml.get(pagePathOf(lang, '')) ?? '';
  for (const id of ['products', 'why', 'features', 'extras', 'showcase', 'faq']) if (!idsOf(home).has(id)) problems.push(`${lang}/: home section #${id} missing`);
  for (const [slug, id] of [['intelyopti', 'pricing'], ['intelyopti', 'trial'], ['intelyide', 'install'], ['privacy', 'web-privacy']]) {
    if (!idsOf(pageHtml.get(pagePathOf(lang, slug)) ?? '').has(id)) problems.push(`${lang}/${slug}: #${id} missing`);
  }
}
// Sitemap lists every page; each shot <img> declares its size.
const sitemap = existsSync(join(dist, 'sitemap.xml')) ? read(join(dist, 'sitemap.xml')) : '';
for (const lang of ['en', 'hu']) for (const slug of SLUGS) {
  if (!sitemap.includes(`<loc>${siteUrl}${basePath}${pagePathOf(lang, slug)}</loc>`)) problems.push(`sitemap.xml: ${pagePathOf(lang, slug)} missing`);
}
for (const [path, html] of pageHtml) {
  for (const [tag] of html.matchAll(/<img\b[^>]*assets\/img\/(?:shots|placeholders)\/[^>]*>/g)) {
    if (!/\bwidth="\d+"/.test(tag) || !/\bheight="\d+"/.test(tag)) problems.push(`${path}: screenshot <img> without width/height`);
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
