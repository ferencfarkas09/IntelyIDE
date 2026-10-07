import { createHash } from 'node:crypto';
import { esc, icons, picture, preloadHero, relUrl } from './lib.mjs';

// Runs in <head> before first paint: restores the saved theme and marks the page as JS-enabled.
// Its sha256 goes into the CSP, so no 'unsafe-inline' is needed.
const THEME_INIT =
  "try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}document.documentElement.classList.add('js');";
const THEME_HASH = `sha256-${createHash('sha256').update(THEME_INIT).digest('base64')}`;
const CSP = `default-src 'none'; script-src 'self' '${THEME_HASH}'; style-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'`;

/** ctx = { cfg, t, rel (prepared release), lang, path, root, abs(path) } */
const href = (ctx, to) => (ctx.absoluteLinks ? ctx.cfg.basePath + to : relUrl(ctx.path, to));
const homePath = (lang) => (lang === 'hu' ? '/hu/' : '/');
const dlPath = (lang) => (lang === 'hu' ? '/hu/download/' : '/download/');
const releasesUrl = (cfg) => `${cfg.repoUrl}/releases/latest`;

function shell(ctx, { title, desc, body, path, ld = '', preload = '', noindex = false, alternates = true, scripts = '' }) {
  const { cfg, t, root } = ctx;
  const og = ctx.abs('/assets/img/og.png');
  const alt = alternates
    ? `<link rel="alternate" hreflang="en" href="${ctx.abs(path.replace(/^\/hu\//, '/'))}">
<link rel="alternate" hreflang="hu" href="${ctx.abs(path.startsWith('/hu/') ? path : `/hu${path}`)}">
<link rel="alternate" hreflang="x-default" href="${ctx.abs(path.replace(/^\/hu\//, '/'))}">`
    : '';
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#7c4dff">
<meta name="color-scheme" content="light dark">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${ctx.abs(path)}">`}
${alt}
<meta property="og:type" content="website">
<meta property="og:site_name" content="IntelyIDE">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${ctx.abs(path)}">
<meta property="og:locale" content="${t.locale}">
<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(t.meta.ogAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${og}">
<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">
<link rel="icon" href="${root}favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="${root}favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="${root}apple-touch-icon.png">
<link rel="manifest" href="${root}site.webmanifest">
<link rel="preload" href="${root}assets/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
${preload}
<link rel="stylesheet" href="${root}assets/style.css">
<script>${THEME_INIT}</script>
<script src="${root}assets/site.js" defer></script>
${scripts}
${ld}
</head>
<body>
<a class="skip" href="#main">${t.ui.skip}</a>
${header(ctx, path)}
<main id="main">
${body}
</main>
${footer(ctx)}
</body>
</html>
`;
}

// The supplied lockup SVGs carry an old "INTELYSWITCH IDE" subline, so the site pairs the mark with a live-text wordmark.
function logo(ctx, size = 36) {
  const src = (v) => `${ctx.root}assets/img/mark-${v}.svg`;
  return `<picture><source media="(prefers-color-scheme: dark)" data-theme="dark" srcset="${src('dark')}"><img src="${src('light')}" alt="" width="${size}" height="${size}"></picture><span class="wordmark">Intely<span class="grad">IDE</span></span>`;
}

function header(ctx, path) {
  const { t, rel, lang } = ctx;
  const otherLang = lang === 'hu' ? 'en' : 'hu';
  const switchPath = lang === 'hu' ? path.replace(/^\/hu\//, '/') : `/hu${path}`;
  const home = homePath(lang);
  const anchor = (id) => (ctx.path === home ? `#${id}` : `${href(ctx, home)}#${id}`);
  const nav = ['features', 'trust', 'open', 'install', 'faq']
    .map((id) => `<li><a href="${anchor(id === 'open' ? 'open-source' : id)}">${t.nav[id]}</a></li>`)
    .join('');
  const dl = rel.primary?.url ?? releasesUrl(ctx.cfg);
  return `<header class="site-header" id="top">
<div class="wrap bar">
<a class="brand" href="${href(ctx, home)}" aria-label="${t.ui.home}">${logo(ctx)}</a>
<nav class="nav" id="site-nav" aria-label="${t.ui.primaryNav}">
<ul>${nav}
<li><a href="${ctx.cfg.repoUrl}" class="nav-gh">${icons.github(18)}<span>${t.nav.github}</span></a></li>
${ctx.noLang ? '' : `<li><a href="${href(ctx, switchPath)}" hreflang="${otherLang}" lang="${otherLang}" class="nav-lang">${t.ui.langName}</a></li>`}
</ul>
</nav>
<div class="bar-actions">
${ctx.sticky ? `<a class="btn btn-sm hdr-dl" href="${esc(dl)}">${icons.download('sm')}<span>${t.dl.button}</span></a>` : ''}
<button type="button" class="icon-btn js-only" id="theme-toggle" aria-pressed="false" aria-label="${t.ui.theme}">${icons.theme()}</button>
<button type="button" class="icon-btn js-only menu-btn" aria-expanded="false" aria-controls="site-nav" aria-label="${t.ui.menu}">${icons.menu()}</button>
</div>
</div>
</header>`;
}

/** The big download button plus everything directly under it. */
function downloadBlock(ctx, { id = 'download' } = {}) {
  const { t, rel, cfg } = ctx;
  const p = rel.primary;
  const sub = (a) =>
    [`${t.dl.version} ${esc(rel.version)}${rel.statusLabel ? ` ${rel.statusLabel}` : ''}`, a.ext, a.sizeLabel, rel.others.length || rel.swap ? a.archLabel : '']
      .filter(Boolean)
      .join(' · ');
  const altText = (a) => `${t.dl.alsoFor} ${a.archLabel} · ${a.sizeLabel}`;
  const alt = rel.others[0];
  const btnSub = p ? sub(p) : `${t.dl.version} ${esc(rel.version)}${rel.statusLabel ? ` ${rel.statusLabel}` : ''}`;
  const btnAttrs = p ? ` data-arch="${p.arch}" data-sub="${esc(sub(p))}" data-alt="${esc(altText(p))}"` : '';
  return `<div class="dl-block" id="${id}" data-dl-block${rel.swap ? ' data-swap' : ''}>
<a class="dl-btn" href="${esc(p?.url ?? releasesUrl(cfg))}"${btnAttrs}>
${icons.download()}
<span class="dl-text"><span class="dl-main">${t.dl.button}</span><span class="dl-sub">${btnSub}</span></span>
</a>
${alt ? `<p class="dl-alt-wrap"><a class="dl-alt" href="${esc(alt.url)}" data-arch="${alt.arch}" data-sub="${esc(sub(alt))}" data-alt="${esc(altText(alt))}">${altText(alt)}</a></p>` : ''}
<p class="dl-meta">${t.dl.minMac} ${esc(rel.minMac)} ${t.dl.orLater}. ${rel.archNote}</p>
<ul class="dl-links">
<li><a href="${esc(rel.notesUrl)}">${t.dl.notes}</a></li>
${rel.sumsUrl ? `<li><a href="${esc(rel.sumsUrl)}">${t.dl.sums}</a></li>` : ''}
<li><a href="${cfg.repoUrl}">${icons.github(16)} ${t.dl.github}</a></li>
</ul>
</div>`;
}

function assetTable(ctx) {
  const { t, rel } = ctx;
  if (!rel.assets.length) return `<p>${t.dl.noAssets}</p>`;
  const rows = rel.assets
    .map(
      (a) => `<tr>
<td data-label="${t.dl.colFile}"><a href="${esc(a.url)}">${esc(a.name)}</a></td>
<td data-label="${t.dl.colArch}">${esc(a.archLabel)}</td>
<td data-label="${t.dl.colSize}">${esc(a.sizeLabel)}</td>
<td data-label="${t.dl.colSha}"><code class="sha">${esc(a.sha256)}</code> <button type="button" class="copy js-only" data-copy="${esc(a.sha256)}" data-done="${t.ui.copied}" aria-label="${t.ui.copyLabel}: ${esc(a.name)}">${t.ui.copy}</button></td>
</tr>`,
    )
    .join('\n');
  return `<table class="assets"><thead><tr><th scope="col">${t.dl.colFile}</th><th scope="col">${t.dl.colArch}</th><th scope="col">${t.dl.colSize}</th><th scope="col">${t.dl.colSha}</th></tr></thead>
<tbody>
${rows}
</tbody></table>`;
}

function gatekeeper(ctx) {
  const { t, rel } = ctx;
  if (rel.signed) return `<p class="note">${t.dl.signedNote}</p>`;
  const g = t.install.gk;
  return `<aside class="callout" aria-labelledby="gk-h">
<h3 id="gk-h">${g.h}</h3>
<p>${g.p}</p>
<ol>${g.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
<p><strong>${g.keep}</strong></p>
</aside>`;
}

function footer(ctx) {
  const { t, cfg } = ctx;
  const l = t.footer.links;
  const links = [
    [cfg.repoUrl, l.repo],
    [`${cfg.repoUrl}/issues`, l.issues],
    [`${cfg.repoUrl}/discussions`, l.discussions],
    [`${cfg.repoUrl}/pulls`, l.pulls],
    [`${cfg.repoUrl}/security/advisories/new`, l.security],
    [cfg.orgUrl, 'intelyhome.com'],
    [cfg.siteUrl, 'intelyide.com'],
    [href(ctx, dlPath(ctx.lang)), l.download],
  ]
    .map(([u, label]) => `<li><a href="${u}">${label}</a></li>`)
    .join('');
  // The project publishes no personal contact details: people reach it through GitHub, intelyhome.com and intelyide.com.
  return `<footer class="site-footer">
<div class="wrap">
<div class="foot-grid">
<div><p class="brand-line">${logo(ctx, 28)}</p><p>${t.footer.credit}</p><p>${t.footer.license}</p></div>
<ul class="link-list">${links}</ul>
</div>
<p class="legal">${t.footer.trademarks}</p>
</div>
</footer>`;
}

const frame = (inner) => `<figure class="win">${inner}</figure>`;

function highlights(t) {
  const items = t.highlights.items
    .map((i) => `<li class="card"><h3>${i.h}</h3><p>${i.p}</p><a href="#${i.id}">${t.highlights.more}<span class="sr"> ${i.h}</span></a></li>`)
    .join('');
  return `<section class="section soft" id="highlights" aria-labelledby="highlights-h">
<div class="wrap"><h2 id="highlights-h">${t.highlights.title}</h2><ul class="cards cards-3">${items}</ul></div>
</section>`;
}

const MONOGRAMS = { goose: 'G', acp: 'ACP' };
function providers(ctx) {
  const { t } = ctx;
  const p = t.providers;
  const tiles = p.items
    .map(([key, name, main]) => {
      const logo = MONOGRAMS[key]
        ? `<span class="prov-logo prov-mono" aria-hidden="true">${MONOGRAMS[key]}</span>`
        : `<span class="prov-logo logo-${key}" aria-hidden="true"></span>`;
      return `<li class="prov${main ? ' prov-main' : ''}">${logo}<strong>${name}</strong><span class="pill">${main ? p.main : p.exp}</span></li>`;
    })
    .join('');
  return `<section class="section" id="providers" aria-labelledby="providers-h">
<div class="wrap">
<h2 id="providers-h">${p.title}</h2>
<p class="lead">${p.lead}</p>
<ul class="prov-grid">${tiles}</ul>
<div class="split">
<div>
<ul class="ticks">${p.list.map((x) => `<li>${x}</li>`).join('')}</ul>
<p class="note">${p.note}</p>
</div>
<div>${frame(picture(ctx.root, 'providers', p.shotAlt))}</div>
</div>
</div>
</section>`;
}

function home(ctx) {
  const { t, cfg, rel } = ctx;
  const dlHome = href(ctx, dlPath(ctx.lang));
  const why = t.why.cards.map((c) => `<li class="card"><h3>${c.h}</h3><p>${c.p}</p></li>`).join('');
  const features = t.features.items
    .map(
      (f) => `<article class="feature" id="${f.id}" aria-labelledby="${f.id}-h">
<div class="feature-text">
<h3 id="${f.id}-h">${f.h}</h3>
${f.pill ? `<p class="pill">${f.pill}</p>` : ''}
<p>${f.p}</p>
<ul class="ticks">${f.list.map((x) => `<li>${x}</li>`).join('')}</ul>
${f.note ? `<p class="note">${f.note}</p>` : ''}
</div>
<div class="feature-media">${f.shots.map(([n, a]) => frame(picture(ctx.root, n, a))).join('')}</div>
</article>`,
    )
    .join('\n');
  const flow = t.trust.flow.map(([h, p]) => `<li><strong>${h}</strong><span>${p}</span></li>`).join('');
  const steps = t.install.steps.map(([h, p]) => `<li><h3>${h}</h3><p>${p}</p></li>`).join('');
  const faq = t.faq.items.map(([q, a]) => `<details class="faq-item"><summary>${q}</summary><p>${a}</p></details>`).join('\n');
  const body = `<section class="hero" aria-labelledby="hero-h">
<div class="hero-bg" aria-hidden="true">
<span class="glow g1"><i></i></span><span class="glow g2"><i></i></span><span class="glow g3"><i></i></span><span class="glow g4"><i></i></span>
<span class="cursor-glow"></span>
</div>
<div class="wrap hero-inner">
<p class="kicker">${t.hero.kicker}</p>
<h1 id="hero-h">${t.hero.title}</h1>
<p class="lead">${t.hero.lead}</p>
${downloadBlock(ctx, { id: 'hero-dl' })}
<details class="dl-more"><summary>${t.dl.more}</summary>
${assetTable(ctx)}
<p><a href="${dlHome}">${t.dl.allDownloads}</a></p>
</details>
${rel.notice ? `<p class="notice">${rel.notice}</p>` : ''}
<div class="hero-shot">${frame(picture(ctx.root, 'hero', t.hero.shotAlt, { eager: true, sizes: '(min-width: 1000px) 1040px, 92vw' }))}</div>
</div>
</section>

${highlights(t)}

<section class="section" id="why" aria-labelledby="why-h">
<div class="wrap"><h2 id="why-h">${t.why.title}</h2><ul class="cards">${why}</ul></div>
</section>

<section class="section soft" id="features" aria-labelledby="features-h">
<div class="wrap"><h2 id="features-h">${t.features.title}</h2>
${features}
</div>
</section>

${providers(ctx)}

<section class="section soft" id="more" aria-labelledby="more-h">
<div class="wrap"><h2 id="more-h">${t.more.title}</h2>
<ul class="chips">${t.more.items.map((x) => `<li>${x}</li>`).join('')}</ul>
<p class="note">${t.more.note}</p></div>
</section>

<section class="section soft" id="trust" aria-labelledby="trust-h">
<div class="wrap"><h2 id="trust-h">${t.trust.title}</h2>
<p class="lead">${t.trust.lead}</p>
<ol class="flow" aria-label="${t.trust.flowLabel}">${flow}</ol>
<div class="trust-grid">
<div><h3>${t.trust.rewindH}</h3><p>${t.trust.rewindP}</p></div>
<div><h3>${t.trust.bestH}</h3><p>${t.trust.bestP}</p></div>
<div><h3>${t.trust.privH}</h3>
<p>${t.trust.privP}</p></div>
</div>
</div>
</section>

<section class="section" id="open-source" aria-labelledby="open-h">
<div class="wrap narrow">
<div>
<h2 id="open-h">${t.open.title}</h2>
<p class="lead">${t.open.p}</p>
<ul class="link-list">
<li><a href="${cfg.repoUrl}">${t.open.links.repo}</a></li>
<li><a href="${cfg.repoUrl}/issues">${t.open.links.issues}</a></li>
<li><a href="${cfg.repoUrl}/discussions">${t.open.links.discussions}</a></li>
<li><a href="${cfg.repoUrl}/security/advisories/new">${t.open.links.security}</a></li>
<li><a href="${cfg.repoUrl}/blob/main/LICENSE">${t.open.links.license}: GPL-3.0-or-later</a></li>
</ul>
<h3>${t.open.contributeH}</h3>
<p>${t.open.contributeP}</p>
<ul class="link-list">
<li><a href="${cfg.repoUrl}/pulls">${t.open.links.pulls}</a></li>
<li><a href="${cfg.repoUrl}/blob/main/CONTRIBUTING.md">${t.open.links.contributing}</a></li>
</ul>
</div>
</div>
</section>

<section class="section soft" id="install" aria-labelledby="install-h">
<div class="wrap"><h2 id="install-h">${t.install.title}</h2>
<ol class="steps">${steps}</ol>
<div class="drag" role="img" aria-label="${t.install.dragAlt}">
<span class="drag-tile"><img src="${ctx.root}assets/img/app-icon.svg" alt="" width="88" height="88"><span>${t.install.dragApp}</span></span>
${icons.arrow()}
<span class="drag-tile">${icons.folder()}<span>${t.install.dragFolder}</span></span>
</div>
${gatekeeper(ctx)}
<p class="center"><a class="btn" href="${esc(rel.primary?.url ?? releasesUrl(cfg))}">${icons.download('sm')}<span>${t.dl.button}</span></a></p>
</div>
</section>

<section class="section" id="faq" aria-labelledby="faq-h">
<div class="wrap narrow"><h2 id="faq-h">${t.faq.title}</h2>
${faq}
</div>
</section>`;
  return shell(ctx, {
    title: t.meta.homeTitle,
    desc: t.meta.homeDesc,
    path: homePath(ctx.lang),
    body,
    preload: preloadHero(ctx.root),
    scripts: `<script src="${ctx.root}assets/hero-fx.js" defer></script>`,
    ld: jsonLd(ctx),
  });
}

function jsonLd(ctx) {
  const { cfg, rel, t } = ctx;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'IntelyIDE',
    description: t.meta.homeDesc,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS',
    softwareVersion: rel.version,
    inLanguage: t.lang,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: `${cfg.repoUrl}/blob/main/LICENSE`,
    downloadUrl: rel.primary?.url ?? releasesUrl(cfg),
    url: ctx.abs(homePath(ctx.lang)),
    author: { '@type': 'Person', name: 'Ferenc Farkas' },
    publisher: { '@type': 'Organization', name: 'IntelyHome', url: cfg.orgUrl },
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

function download(ctx) {
  const { t, rel } = ctx;
  const body = `<section class="section page-head">
<div class="wrap narrow">
<h1>${t.page.dlTitle}</h1>
<p class="lead">${t.page.dlLead}</p>
<p class="dl-date">${t.dl.released}: ${esc(rel.date)}</p>
${downloadBlock(ctx)}
${rel.notice ? `<p class="notice">${rel.notice}</p>` : ''}
</div>
</section>
<section class="section soft" aria-labelledby="all-h">
<div class="wrap">
<h2 id="all-h">${t.dl.allDownloads}</h2>
${assetTable(ctx)}
</div>
</section>
<section class="section" aria-labelledby="verify-h">
<div class="wrap narrow">
<h2 id="verify-h">${t.page.verifyTitle}</h2>
<p>${t.page.verifyP}</p>
<pre><code>cd ~/Downloads
shasum -a 256 -c SHA256SUMS</code></pre>
<p>${t.page.verifyAfter}${rel.sumsUrl ? ` <a href="${esc(rel.sumsUrl)}">${t.dl.sums}</a>` : ''}</p>
${gatekeeper(ctx)}
<p><a href="${href(ctx, homePath(ctx.lang))}">${t.page.backHome}</a></p>
</div>
</section>`;
  return shell(ctx, { title: t.meta.dlTitle, desc: t.meta.dlDesc, path: dlPath(ctx.lang), body });
}

function notFound(ctx) {
  const { t } = ctx;
  const body = `<section class="section page-head">
<div class="wrap narrow">
<h1>${t.page.nfTitle}</h1>
<p class="lead">${t.page.nfP}</p>
<p><a class="btn" href="${href(ctx, '/')}">${t.page.backHome}</a></p>
</div>
</section>`;
  return shell(ctx, { title: t.meta.notFoundTitle, desc: t.meta.notFoundDesc, path: '/404.html', body, noindex: true, alternates: false });
}

export const pages = { home, download, notFound };
