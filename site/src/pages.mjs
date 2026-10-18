import { createHash } from 'node:crypto';
import { esc, icon, icons, partnerLogo, picture, preloadHero, relUrl } from './lib.mjs';

// Runs in <head> before first paint: restores the saved theme and marks the page as JS-enabled.
// Its sha256 goes into the CSP, so no 'unsafe-inline' is needed.
const THEME_INIT =
  "try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}document.documentElement.classList.add('js');";
const THEME_HASH = `sha256-${createHash('sha256').update(THEME_INIT).digest('base64')}`;
const CSP = `default-src 'none'; script-src 'self' '${THEME_HASH}' https://www.googletagmanager.com; style-src 'self'; img-src 'self' data: https://*.google-analytics.com https://www.googletagmanager.com; font-src 'self'; manifest-src 'self'; connect-src 'self' https://api.intelyhome.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; base-uri 'none'; form-action 'self'`;

/** ctx = { cfg, t, rel (prepared release), lang, path, root, abs(path) } */
const href = (ctx, to) => (ctx.absoluteLinks ? ctx.cfg.basePath + to : relUrl(ctx.path, to));
// Analytics markers read by assets/analytics.js (event delegation, no per-element handlers).
const ga = (kind, label) => ` data-ga="${kind}" data-ga-label="${label}"`;
const pagePath = (lang, slug = '') => `${lang === 'hu' ? '/hu/' : '/'}${slug ? `${slug}/` : ''}`;
const homePath = (lang) => pagePath(lang);
const dlPath = (lang) => pagePath(lang, 'download');
const releasesUrl = (cfg) => `${cfg.repoUrl}/releases/latest`;

function shell(ctx, { title, desc, body, path, ld = '', preload = '', noindex = false, alternates = true, scripts = '', subnav = null, ogType = 'website', ogImage = 'og.png', ogAlt = null }) {
  const { cfg, t, root } = ctx;
  const og = ctx.abs(`/assets/img/${ogImage}`);
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
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="IntelyHome">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${ctx.abs(path)}">
<meta property="og:locale" content="${t.locale}">
<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(ogAlt || t.meta.ogAlt)}">
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
<script src="${root}assets/analytics.js" defer></script>
${scripts}
${ld}
</head>
<body data-version="${esc(ctx.rel.version)}"${ctx.slug === '' ? ` data-ide-url="${esc(href(ctx, pagePath(ctx.lang, 'intelyide')))}"` : ''}>
<a class="skip" href="#main">${t.ui.skip}</a>
${header(ctx, path)}
${subnav ? subnavBar(ctx, subnav) : ''}
<main id="main">
${body}
</main>
${footer(ctx)}
${consent(ctx)}
</body>
</html>
`;
}

// The supplied lockup SVGs carry an old "INTELYSWITCH IDE" subline, so the site pairs the mark with a live-text wordmark.
function logo(ctx, size = 36) {
  const src = (v) => `${ctx.root}assets/img/mark-${v}.svg`;
  return `<picture><source media="(prefers-color-scheme: dark)" data-theme="dark" srcset="${src('dark')}"><img src="${src('light')}" alt="" width="${size}" height="${size}"></picture><span class="wordmark">Intely<span class="grad">Home</span></span>`;
}

const chevron = '<svg class="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>';

function header(ctx, path) {
  const { t, rel, lang } = ctx;
  const otherLang = lang === 'hu' ? 'en' : 'hu';
  const switchPath = lang === 'hu' ? path.replace(/^\/hu\//, '/') : `/hu${path}`;
  const to = (slug, id = '') => {
    const target = pagePath(lang, slug);
    return `${ctx.path === target && id ? '' : href(ctx, target)}${id ? `#${id}` : ''}`;
  };
  const current = (slug) => (ctx.slug === slug ? ' aria-current="page"' : '');
  const products = `<li class="has-sub">
<button type="button" class="sub-btn" id="products-btn" aria-expanded="false" aria-controls="products-menu"${ga('nav', 'products')}><span>${t.nav.products}</span>${chevron}</button>
<ul class="submenu" id="products-menu" aria-labelledby="products-btn">
<li><a href="${to('intelyide')}"${current('intelyide')}${ga('nav', 'product-ide')}><strong>${t.nav.ide[0]}</strong><span>${t.nav.ide[1]}</span></a></li>
<li><a href="${to('intelyopti')}"${current('intelyopti')}${ga('nav', 'product-opti')}><strong>${t.nav.opti[0]}</strong><span>${t.nav.opti[1]}</span></a></li>
</ul>
</li>`;
  const links = [
    ['features', to('', 'features')],
    ['open', to('intelyide', 'open-source')],
    ['pricing', to('intelyopti', 'pricing')],
    ['faq', to('', 'faq')],
  ]
    .map(([id, u]) => `<li><a href="${u}"${ga('nav', id)}>${t.nav[id]}</a></li>`)
    .join('');
  const dl = rel.multi ? href(ctx, dlPath(ctx.lang)) : (rel.primary?.url ?? releasesUrl(ctx.cfg));
  return `<header class="site-header" id="top">
<div class="wrap bar">
<a class="brand" href="${href(ctx, homePath(lang))}" aria-label="${t.ui.home}">${logo(ctx)}</a>
<nav class="nav" id="site-nav" aria-label="${t.ui.primaryNav}">
<ul>${products}${links}
<li><a href="${ctx.cfg.repoUrl}" class="nav-gh"${ga('cta', 'nav-github')}>${icons.github(18)}<span>${t.nav.github}</span></a></li>
${ctx.noLang ? '' : `<li><a href="${href(ctx, switchPath)}" hreflang="${otherLang}" lang="${otherLang}" class="nav-lang"${ga('lang', otherLang)}>${t.ui.langName}</a></li>`}
</ul>
</nav>
<div class="bar-actions">
${ctx.sticky ? `<a class="btn btn-sm hdr-dl" href="${esc(dl)}"${ga('download', 'header')}>${icons.download('sm')}<span>${rel.multi ? t.dl.buttonGeneric : t.dl.button}</span></a>` : ''}
<button type="button" class="icon-btn js-only" id="theme-toggle"${ga('theme', 'header')} aria-pressed="false" aria-label="${t.ui.theme}">${icons.theme()}</button>
<button type="button" class="icon-btn js-only menu-btn" aria-expanded="false" aria-controls="site-nav" aria-label="${t.ui.menu}">${icons.menu()}</button>
</div>
</div>
</header>`;
}

/** The big download button plus everything directly under it. */
/** The in-page navigation under the header: [[anchor id, label], ...] of the product pages (content: t.subnav.<product>). */
function subnavBar(ctx, items) {
  const { t } = ctx;
  return `<nav class="subnav" aria-label="${esc(t.ui.pageNav)}"><div class="wrap"><ul>${items.map(([id, label]) => `<li><a href="#${esc(id)}">${esc(label)}</a></li>`).join('')}</ul></div></nav>`;
}

function multiDownloadBlock(ctx, id) {
  const { t, rel, cfg } = ctx;
  const ver = `${t.dl.version} ${esc(rel.version)}${rel.statusLabel ? ` ${rel.statusLabel}` : ''}`;
  const pl = rel.platforms;
  const link = (a, platform, { primary = false, text }) =>
    `<a href="${esc(a.url)}" data-platform="${platform}"${primary ? ' data-primary' : ''} data-label="${esc(t.dl.forPlatform[platform])}" data-sub="${esc([ver, a.kindLabel, a.ext, a.sizeLabel, a.archLabel].filter(Boolean).join(' · '))}"${ga('download', id + '-' + platform + (primary ? '' : '-' + a.kind))} data-ga-platform="${platform}">${text}</a>`;
  const win = pl.windows.nsis ?? pl.windows.msi;
  const lin = pl.linux.appimage ?? pl.linux.deb;
  const parts = [
    pl.mac && link(pl.mac, 'mac', { primary: true, text: t.dl.platformName.mac }),
    win && link(win, 'windows', { primary: true, text: t.dl.platformName.windows }),
    lin && `${t.dl.platformName.linux} (${[pl.linux.appimage && link(pl.linux.appimage, 'linux', { primary: true, text: 'AppImage' }), pl.linux.deb && link(pl.linux.deb, 'linux', { text: '.deb' })].filter(Boolean).join(', ')})`,
  ].filter(Boolean);
  const notes = [win && ['windows', t.dl.winNote], lin && ['linux', t.dl.linuxNote]].filter(Boolean);
  return `<div class="dl-block" id="${id}" data-dl-block data-dl-multi>
<a class="dl-btn" href="${esc(rel.notesUrl)}" data-ga-platform="other"${ga('download', id)}>
${icons.download()}
<span class="dl-text"><span class="dl-main" data-default="${esc(t.dl.buttonGeneric)}">${t.dl.buttonGeneric}</span><span class="dl-sub" data-default="${ver}">${ver}</span></span>
</a>
<p class="dl-other">${t.dl.otherPlatforms} ${parts.join(' · ')}</p>
<ul class="dl-notes">${notes.map(([k, text]) => `<li data-note="${k}">${text}</li>`).join('')}</ul>
<p class="dl-meta">${t.dl.minMac} ${esc(rel.minMac)} ${t.dl.orLater}. ${rel.archNote}</p>
<ul class="dl-links">
<li><a href="${esc(rel.notesUrl)}"${ga('cta', 'release-notes')}>${t.dl.notes}</a></li>
${rel.sumsUrl ? `<li><a href="${esc(rel.sumsUrl)}"${ga('cta', 'checksums')}>${t.dl.sums}</a></li>` : ''}
<li><a href="${cfg.repoUrl}"${ga('cta', 'github-repo')}>${icons.github(16)} ${t.dl.github}</a></li>
</ul>
</div>`;
}

function downloadBlock(ctx, { id = 'download' } = {}) {
  const { t, rel, cfg } = ctx;
  if (rel.multi) return multiDownloadBlock(ctx, id);
  const p = rel.primary;
  const sub = (a) =>
    [`${t.dl.version} ${esc(rel.version)}${rel.statusLabel ? ` ${rel.statusLabel}` : ''}`, a.ext, a.sizeLabel, rel.others.length || rel.swap ? a.archLabel : '']
      .filter(Boolean)
      .join(' · ');
  const altText = (a) => `${t.dl.alsoFor} ${a.archLabel} · ${a.sizeLabel}`;
  const alt = rel.others[0];
  const btnSub = p ? sub(p) : `${t.dl.version} ${esc(rel.version)}${rel.statusLabel ? ` ${rel.statusLabel}` : ''}`;
  const btnAttrs = p ? ` data-arch="${p.arch}" data-sub="${esc(sub(p))}" data-alt="${esc(altText(p))}"` : '';
  // Files for macOS only: Windows and Linux visitors get a plain note and the release page instead of a macOS file (site.js reveals it).
  const macOnly = p?.platform === 'mac';
  return `<div class="dl-block" id="${id}" data-dl-block${rel.swap ? ' data-swap' : ''}${macOnly ? ` data-mac-only data-soon-label="${esc(t.dl.soonButton)}" data-soon-href="${esc(rel.notesUrl)}"` : ''}>
<a class="dl-btn" href="${esc(p?.url ?? releasesUrl(cfg))}"${btnAttrs}${ga('download', id)}>
${icons.download()}
<span class="dl-text"><span class="dl-main">${t.dl.button}</span><span class="dl-sub">${btnSub}</span></span>
</a>
${macOnly ? `<p class="dl-soon" data-soon hidden>${t.dl.soonNote}</p>` : ''}
${alt ? `<p class="dl-alt-wrap"><a class="dl-alt"${ga('download', id + '-alt')} href="${esc(alt.url)}" data-arch="${alt.arch}" data-sub="${esc(sub(alt))}" data-alt="${esc(altText(alt))}">${altText(alt)}</a></p>` : ''}
<p class="dl-meta">${t.dl.minMac} ${esc(rel.minMac)} ${t.dl.orLater}. ${rel.archNote}</p>
<ul class="dl-links">
<li><a href="${esc(rel.notesUrl)}"${ga('cta', 'release-notes')}>${t.dl.notes}</a></li>
${rel.sumsUrl ? `<li><a href="${esc(rel.sumsUrl)}"${ga('cta', 'checksums')}>${t.dl.sums}</a></li>` : ''}
<li><a href="${cfg.repoUrl}"${ga('cta', 'github-repo')}>${icons.github(16)} ${t.dl.github}</a></li>
</ul>
</div>`;
}

function assetTable(ctx) {
  const { t, rel } = ctx;
  if (!rel.assets.length) return `<p>${t.dl.noAssets}</p>`;
  const rows = rel.assets
    .map(
      (a) => `<tr>
<td data-label="${t.dl.colFile}"><a href="${esc(a.url)}"${ga('download', 'table')} data-ga-platform="${a.platform}">${esc(a.name)}</a></td>
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
  const { t, cfg, lang } = ctx;
  const l = t.footer.links;
  const col = (title, items) =>
    `<div><h2 class="foot-h">${title}</h2><ul class="link-list">${items.map(([u, label, kind]) => `<li><a href="${u}"${ga('cta', `footer-${kind}`)}>${label}</a></li>`).join('')}</ul></div>`;
  const products = col(t.footer.cols.products, [
    [href(ctx, pagePath(lang, 'intelyide')), t.nav.ide[0], 'ide'],
    [href(ctx, pagePath(lang, 'intelyopti')), t.nav.opti[0], 'opti'],
    [href(ctx, dlPath(lang)), l.download, 'download'],
    [`${href(ctx, pagePath(lang, 'intelyopti'))}#get`, l.trial, 'trial'],
  ]);
  const company = col(t.footer.cols.company, [
    [`${href(ctx, homePath(lang))}#about`, l.about, 'about'],
    [cfg.githubUrl, l.author, 'author'],
    [href(ctx, pagePath(lang, 'privacy')), l.privacy, 'privacy'],
    [href(ctx, pagePath(lang, 'terms')), l.terms, 'terms'],
  ]);
  const resources = col(t.footer.cols.resources, [
    [cfg.repoUrl, l.repo, 'repo'],
    [`${cfg.repoUrl}/issues`, l.issues, 'issues'],
    [`${cfg.repoUrl}/discussions`, l.discussions, 'discussions'],
    [`${cfg.repoUrl}/pulls`, l.pulls, 'pulls'],
    [`${cfg.repoUrl}/security/advisories/new`, l.security, 'security'],
    [cfg.intelyopti.releasesRepoUrl, l.releases, 'releases'],
    ...Object.entries(cfg.partners ?? {}).map(([key, p]) => [p.url, p.name, `partner-${key}`]),
  ]);
  // The project publishes no personal contact details: people reach it through GitHub and intelyhome.com.
  return `<footer class="site-footer">
<div class="wrap">
<div class="foot-grid">
<div class="foot-about"><p class="brand-line">${logo(ctx, 28)}</p><p>${t.footer.credit}</p><p>${t.footer.license}</p>
<p><button type="button" class="linkbtn js-only" data-consent-open>${t.consent.settings}</button></p></div>
${products}${company}${resources}
</div>
<p class="legal">${t.footer.trademarks}</p>
</div>
</footer>`;
}

// Cookie banner. Hidden until analytics.js decides to show it; fixed position, so it never shifts the layout.
function consent(ctx) {
  const c = ctx.t.consent;
  return `<div class="consent" id="consent" role="region" aria-label="${c.label}" hidden>
<p>${c.text} <a href="${href(ctx, pagePath(ctx.lang, 'privacy'))}#web-privacy">${c.more}</a></p>
<div class="consent-actions"><button type="button" class="btn btn-sm" data-consent="granted">${c.accept}</button><button type="button" class="btn btn-sm btn-ghost" data-consent="denied">${c.decline}</button></div>
</div>`;
}

// Screenshots carry their own macOS window chrome and a transparent margin, so the frame adds only a soft shadow.
const frame = (inner) => `<figure class="shot">${inner}</figure>`;

// ---- Products, trial and pricing ---------------------------------------------------------------------------

/** Sticky header call-to-action of a product page: the IDE download, or the IntelyOpti trial form. */
function withSticky(ctx, product) {
  const { t, rel, cfg } = ctx;
  const sticky =
    product === 'ide'
      ? { href: rel.primary?.url ?? releasesUrl(cfg), kind: 'download', icon: icons.download('sm'), label: t.dl.button }
      : { href: '#get', kind: 'cta', icon: '', label: t.nav.optiCta };
  return { ...ctx, sticky };
}

const iconTile = (name) => `<span class="ficon">${icon(name, 22)}</span>`;
const external = (ctx) => ` target="_blank" rel="noopener noreferrer"`;

/** "More from IntelyHome" band linking to the other product. */
function crossBand(ctx, current) {
  const { t, lang } = ctx;
  const other = current === 'ide' ? 'opti' : 'ide';
  const c = t.cross[other];
  const slug = other === 'ide' ? 'intelyide' : 'intelyopti';
  return `<section class="section soft" id="more-products" aria-labelledby="more-products-h">
<div class="wrap narrow cross">
<p class="eyebrow">${t.cross.title}</p>
<h2 id="more-products-h">${c.h}</h2>
<p class="lead">${c.p}</p>
<p><a class="btn btn-grad" href="${href(ctx, pagePath(lang, slug))}"${ga('cta', `cross-${other}`)}>${c.cta}</a></p>
</div>
</section>`;
}

/**
 * The e-mail form shared by the IntelyOpti download and the waitlist. assets/lead.js posts it to
 * {apiBase}/api/lead (see IntelyOpti docs/API.md). Honeypot field "company", consent checkbox, aria-live status.
 */
function leadForm(ctx, { id, kind, source, copy, downloadUrl = '' }) {
  const { t, cfg, lang } = ctx;
  const f = t.opti.form;
  const msgs = esc(JSON.stringify({ ...f.msgs, sending: f.sending }));
  const done =
    kind === 'download'
      ? `<p>${copy.doneP}</p>
<p><a class="dl-btn" data-dl-link href="${esc(downloadUrl)}"${ga('download', 'opti-form')}>${icons.download()}<span class="dl-text"><span class="dl-main">${f.doneBtn}</span><span class="dl-sub">${doneSub(ctx)}</span></span></a></p>`
      : `<p>${copy.doneP}</p>`;
  return `<div class="lead" data-lead-root>
<form class="lead-form" id="${id}-form" data-lead data-kind="${kind}" data-source="${source}" data-lang="${lang}" data-api="${esc(cfg.apiBase)}" data-download="${esc(downloadUrl)}" data-download-prefix="${esc(cfg.githubUrl)}/" data-msgs="${msgs}" method="post" novalidate>
<div class="field">
<label for="${id}-email">${f.email}</label>
<input id="${id}-email" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" required placeholder="${esc(f.placeholder)}" aria-describedby="${id}-status">
</div>
<p class="hp" aria-hidden="true"><label>${f.trap} <input type="text" name="company" tabindex="-1" autocomplete="off"></label></p>
<div class="check">
<input id="${id}-consent" name="consent" type="checkbox" required>
<label for="${id}-consent">${f.consent}</label>
</div>
<button type="submit" class="btn btn-grad btn-wide"${ga('cta', `${id}-submit`)}>${copy.submit}</button>
<p class="form-status" id="${id}-status" role="status" aria-live="polite"></p>
</form>
<div class="lead-done" id="${id}-done" data-lead-done hidden tabindex="-1">
<h3>${copy.doneH}</h3>
${done}
</div>
<noscript><p class="note">${f.noscript} <a href="${esc(cfg.intelyopti.releasesRepoUrl)}/releases"${external()}>${f.noscriptLink}</a></p></noscript>
</div>`;
}

/** Small line under the download button: version, size and minimum macOS from data/intelyopti-release.json. */
function doneSub(ctx) {
  const { t, opti } = ctx;
  const r = t.opti.requirements.release;
  return [opti.version ? `${r.version} ${esc(opti.version)}` : '', opti.size ? esc(opti.size) : '', `${r.min} ${esc(opti.minMacOS ?? ctx.cfg.intelyopti.minMacOS)}+`]
    .filter(Boolean)
    .join(' · ');
}

function optiRelease(ctx) {
  const { t, opti } = ctx;
  const r = t.opti.requirements.release;
  const rows = [
    [r.version, opti.version],
    [r.released, opti.date],
    [r.size, opti.size],
    [r.min, `${opti.minMacOS ?? ctx.cfg.intelyopti.minMacOS}`],
    [r.sha, opti.sha256 ? `<code class="sha">${esc(opti.sha256)}</code>` : ''],
  ].filter(([, v]) => v);
  return `<h3>${r.h}</h3><dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

const checkIcon = icon('check', 16);

function pricing(ctx) {
  const { t, cfg } = ctx;
  const p = t.opti.pricing;
  const open = cfg.checkout.enabled;
  const urls = { yearly: cfg.checkout.yearlyUrl, lifetime: cfg.checkout.lifetimeUrl };
  const cards = p.plans
    .map((plan) => {
      let cta;
      if (plan.key === 'free') {
        cta = `<a class="btn btn-ghost btn-wide" href="#get"${ga('cta', 'plan-free')}>${plan.cta}</a>`;
      } else if (open && urls[plan.key]) {
        cta = `<a class="btn btn-grad btn-wide" href="${esc(urls[plan.key])}"${external()}${ga('cta', `buy-${plan.key}`)}>${plan.cta}</a>`;
      } else {
        cta = `<a class="btn ${plan.featured ? 'btn-grad' : 'btn-ghost'} btn-wide" href="#waitlist"${ga('cta', `wait-${plan.key}`)}>${p.waitCta}</a>`;
      }
      return `<li class="plan${plan.featured ? ' plan-featured' : ''}">
<h3>${plan.h}</h3>
<p class="price"><span class="amount">${plan.price}</span> <span class="unit">${plan.unit}</span></p>
<ul class="ticks">${plan.list.map((x) => `<li>${x}</li>`).join('')}</ul>
${cta}
</li>`;
    })
    .join('');
  return `<section class="section" id="pricing" aria-labelledby="pricing-h">
<div class="wrap">
<h2 id="pricing-h">${p.title}</h2>
<p class="lead">${p.lead}</p>
${open ? '' : `<p class="notice">${p.waitNote}</p>`}
<ul class="plans">${cards}</ul>
<p class="note center">${p.trialNote}</p>
${open ? '' : `<div class="wait-card" id="waitlist"><h3>${t.opti.waitlist.title}</h3><p>${t.opti.waitlist.lead}</p>${leadForm(ctx, { id: 'wait', kind: 'waitlist', source: 'pricing', copy: t.opti.waitlist })}</div>`}
</div>
</section>`;
}

function opti(ctx0) {
  const ctx = withSticky(ctx0, 'opti');
  const { t, cfg, lang } = ctx;
  const o = t.opti;
  const features = o.features.items
    .map(
      (f) => `<article class="feature" id="${f.id}" aria-labelledby="${f.id}-h">
<div class="feature-text">
<span class="ficon">${icon(f.icon, 22)}</span>
<h3 id="${f.id}-h">${f.h}</h3>
<p>${f.p}</p>
<ul class="ticks">${f.list.map((x) => `<li>${x}</li>`).join('')}</ul>
</div>
<div class="feature-media">${frame(picture(ctx.root, f.shot[0], f.shot[1]))}</div>
</article>`,
    )
    .join('\n');
  const modes = o.modes.items.map((m) => `<li class="card"><h3>${m.h}</h3><p>${m.p}</p></li>`).join('');
  const advisor = o.advisor.steps.map(([h, p]) => `<li><strong>${h}</strong><span>${p}</span></li>`).join('');
  const trialSteps = o.trial.steps.map(([h, p]) => `<li><h3>${h}</h3><p>${p}</p></li>`).join('');
  const req = o.requirements.items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  const sec = o.security.items.map((i) => `<li class="card">${iconTile(i.icon)}<h3>${i.h}</h3><p>${i.p}</p></li>`).join('');
  const faq = o.faq.items.map(([q, a]) => `<details class="faq-item"><summary>${q}</summary><p>${a}</p></details>`).join('\n');
  const body = `<section class="hero" aria-labelledby="hero-h">
<div class="hero-bg" aria-hidden="true">
<span class="glow g1"><i></i></span><span class="glow g2"><i></i></span><span class="glow g3"><i></i></span><span class="glow g4"><i></i></span>
<span class="cursor-glow"></span>
</div>
<div class="wrap hero-inner">
<p class="kicker">${o.hero.kicker}</p>
<h1 id="hero-h">${o.hero.title}</h1>
<p class="lead">${o.hero.lead}</p>
<div class="cta-row"><a class="btn btn-grad btn-lg" id="hero-dl" href="#get"${ga('cta', 'opti-hero-trial')}>${o.hero.cta}</a><a class="btn btn-ghost btn-lg" href="#pricing"${ga('cta', 'opti-hero-pricing')}>${o.hero.pricing}</a></div>
<p class="note hero-fine">${o.hero.fine}</p>
<ul class="points">${o.hero.points.map((x) => `<li>${checkIcon}${x}</li>`).join('')}</ul>
<div class="hero-shot">${frame(picture(ctx.root, 'opti-dashboard', o.hero.shotAlt, { eager: true, sizes: '(min-width: 1000px) 1040px, 92vw' }))}</div>
</div>
</section>

<section class="section soft" id="get" aria-labelledby="get-h">
<div class="wrap get-grid">
<div>
<h2 id="get-h">${o.form.title}</h2>
<p class="lead">${o.form.lead}</p>
<div class="release">${optiRelease(ctx)}</div>
</div>
<div class="card get-card">${leadForm(ctx, { id: 'get', kind: 'download', source: 'product-page', copy: { ...o.form, doneP: o.form.doneP }, downloadUrl: cfg.intelyopti.downloadUrl })}</div>
</div>
</section>

<section class="section" id="features" aria-labelledby="features-h">
<div class="wrap"><h2 id="features-h">${o.features.title}</h2>
<p class="lead">${o.features.lead}</p>
${features}
<h3 class="more-h">${o.more.title}</h3>
<ul class="chips">${o.more.items.map((x) => `<li>${x}</li>`).join('')}</ul>
</div>
</section>

<section class="section soft" id="modes" aria-labelledby="modes-h">
<div class="wrap">
<h2 id="modes-h">${o.modes.title}</h2>
<p class="lead">${o.modes.lead}</p>
<ul class="cards cards-4">${modes}</ul>
<p class="note">${o.modes.note}</p>
<div class="wide-shot">${frame(picture(ctx.root, o.modes.shot[0], o.modes.shot[1], { sizes: '(min-width: 1000px) 960px, 92vw' }))}</div>
</div>
</section>

<section class="section" id="advisor" aria-labelledby="advisor-h">
<div class="wrap split">
<div>
<h2 id="advisor-h">${o.advisor.title}</h2>
<p class="lead">${o.advisor.lead}</p>
<ol class="flow flow-col">${advisor}</ol>
<p class="note">${o.advisor.note}</p>
</div>
<div>${frame(picture(ctx.root, o.advisor.shot[0], o.advisor.shot[1]))}</div>
</div>
</section>

<section class="section soft" id="trial" aria-labelledby="trial-h">
<div class="wrap">
<h2 id="trial-h">${o.trial.title}</h2>
<p class="lead">${o.trial.lead}</p>
<ol class="steps steps-4">${trialSteps}</ol>
<div class="callout"><h3>${o.trial.factsH}</h3><ul class="ticks">${o.trial.facts.map((x) => `<li>${x}</li>`).join('')}</ul></div>
</div>
</section>

<section class="section" id="requirements" aria-labelledby="requirements-h">
<div class="wrap narrow"><h2 id="requirements-h">${o.requirements.title}</h2><dl class="facts facts-wide">${req}</dl></div>
</section>

${pricing(ctx)}

<section class="section soft" id="security" aria-labelledby="security-h">
<div class="wrap"><h2 id="security-h">${o.security.title}</h2>
<p class="lead">${o.security.lead}</p>
<ul class="cards">${sec}</ul></div>
</section>

<section class="section" id="faq" aria-labelledby="faq-h">
<div class="wrap narrow"><h2 id="faq-h">${o.faq.title}</h2>
${faq}
<p class="changelog"><strong>${o.changelog.h}.</strong> ${o.changelog.p} <a href="${esc(cfg.intelyopti.releasesRepoUrl)}/releases"${external()}${ga('cta', 'opti-changelog')}>${o.changelog.link}</a></p>
</div>
</section>

<section class="section final-cta" aria-labelledby="final-h">
<div class="wrap narrow center">
<h2 id="final-h">${o.cta.title}</h2>
<p class="lead">${o.cta.p}</p>
<p><a class="btn btn-grad btn-lg" href="#get"${ga('cta', 'opti-final')}>${o.cta.btn}</a></p>
</div>
</section>

${crossBand(ctx, 'opti')}`;
  return shell(ctx, {
    title: t.meta.optiTitle,
    desc: t.meta.optiDesc,
    path: pagePath(lang, 'intelyopti'),
    body,
    ogImage: 'og-intelyopti.png',
    ogAlt: 'IntelyOpti: the Mac optimizer built for Intel Macs, with its Smart Care dashboard.',
    subnav: t.subnav.opti,
    preload: '',
    scripts: `<script src="${ctx.root}assets/hero-fx.js" defer></script><script src="${ctx.root}assets/lead.js" defer></script>`,
    ld: optiLd(ctx),
  });
}

function optiLd(ctx) {
  const { cfg, t, opti, lang } = ctx;
  const o = cfg.intelyopti;
  const offer = (name, price, extra = {}) => ({
    '@type': 'Offer', name, price, priceCurrency: o.currency, availability: cfg.checkout.enabled ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder', ...extra,
  });
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'IntelyOpti',
    description: t.meta.optiDesc,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: `macOS ${o.minMacOS} or later`,
    ...(opti.version ? { softwareVersion: opti.version } : {}),
    inLanguage: lang,
    offers: [
      offer('Pro Yearly', o.yearlyPrice, { description: `${o.trialDays}-day free trial, then ${o.yearlyPrice} ${o.currency} per year for one Mac.` }),
      offer('Pro Lifetime', o.lifetimePrice, { description: `${o.trialDays}-day free trial, then ${o.lifetimePrice} ${o.currency} once for one Mac.` }),
    ],
    downloadUrl: o.downloadUrl,
    url: ctx.abs(pagePath(lang, 'intelyopti')),
    author: { '@type': 'Person', name: 'Ferenc Farkas' },
    publisher: { '@type': 'Organization', name: 'IntelyHome', url: cfg.orgUrl },
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

// ---- Company home -------------------------------------------------------------------------------------------

function home(ctx0) {
  const ctx = ctx0;
  const { t, cfg, rel, lang } = ctx;
  const h = t.home;
  const ideUrl = href(ctx, pagePath(lang, 'intelyide'));
  const optiUrl = href(ctx, pagePath(lang, 'intelyopti'));
  const dlUrl = rel.primary?.url ?? releasesUrl(cfg);
  const grid = (items) =>
    `<ul class="fgrid">${items.map((i) => `<li class="fitem">${iconTile(i.icon)}<h4>${i.h}</h4><p>${i.p}</p></li>`).join('')}</ul>`;
  const card = (kind, product, shot, primary) => `<article class="pcard pcard-${kind}">
<div class="pcard-body">
<p class="pill">${product.tag}</p>
<h3>${product.h}</h3>
<p>${product.p}</p>
<div class="cta-row"><a class="btn btn-grad" href="${esc(primary.href)}"${ga(primary.kind, `home-${kind}`)}>${primary.icon ?? ''}<span>${product.cta}</span></a><a class="btn btn-ghost" href="${primary.more}"${ga('cta', `home-${kind}-more`)}>${product.more}</a></div>
</div>
<div class="pcard-shot">${frame(picture(ctx.root, shot, product.shotAlt, { sizes: '(min-width: 1000px) 520px, 92vw' }))}</div>
</article>`;
  const showcase = h.showcase.items
    .map((i) => `<figure class="shot-card">${frame(picture(ctx.root, i.slot, i.alt, { sizes: '(min-width: 1000px) 540px, 92vw' }))}<figcaption><span class="pill">${i.kind === 'ide' ? 'IntelyIDE' : 'IntelyOpti'}</span> ${i.cap}</figcaption></figure>`)
    .join('');
  const faq = h.faq.items.map(([q, a]) => `<details class="faq-item"><summary>${q}</summary><p>${a}</p></details>`).join('\n');
  const body = `<section class="hero" aria-labelledby="hero-h">
<div class="hero-bg" aria-hidden="true">
<span class="glow g1"><i></i></span><span class="glow g2"><i></i></span><span class="glow g3"><i></i></span><span class="glow g4"><i></i></span>
<span class="cursor-glow"></span>
</div>
<div class="wrap hero-inner">
<p class="kicker">${h.hero.kicker}</p>
<h1 id="hero-h">${h.hero.title}</h1>
<p class="lead">${h.hero.lead}</p>
<div class="cta-row"><a class="btn btn-grad btn-lg" href="${esc(dlUrl)}"${ga('download', 'home-hero-ide')}>${icons.download('sm')}<span>${h.hero.ide}</span></a><a class="btn btn-ghost btn-lg" href="${optiUrl}#get"${ga('cta', 'home-hero-opti')}>${h.hero.opti}</a></div>
<ul class="points">${h.hero.points.map((x) => `<li>${checkIcon}${x}</li>`).join('')}</ul>
</div>
</section>

<section class="section tight" id="products" aria-labelledby="products-h">
<div class="wrap">
<h2 id="products-h">${h.products.title}</h2>
<p class="lead">${h.products.lead}</p>
<div class="pcards">
${card('ide', h.products.ide, 'hero', { href: dlUrl, kind: 'download', icon: icons.download('sm'), more: ideUrl })}
${card('opti', h.products.opti, 'opti-dashboard', { href: `${optiUrl}#get`, kind: 'cta', more: optiUrl })}
</div>
</div>
</section>

<section class="section soft" id="why" aria-labelledby="why-h">
<div class="wrap"><h2 id="why-h">${h.why.title}</h2><p class="lead">${h.why.lead}</p>
<ul class="cards">${h.why.items.map((i) => `<li class="card">${iconTile(i.icon)}<h3>${i.h}</h3><p>${i.p}</p></li>`).join('')}</ul></div>
</section>

<section class="section" id="features" aria-labelledby="features-h">
<div class="wrap"><h2 id="features-h">${h.features.title}</h2><p class="lead">${h.features.lead}</p>
<div class="fgroup"><div class="fgroup-head"><h3>${h.features.ide.h}</h3><a href="${ideUrl}#features"${ga('cta', 'home-ide-features')}>${h.features.ide.link}</a></div>${grid(h.features.ideItems)}</div>
<div class="fgroup"><div class="fgroup-head"><h3>${h.features.opti.h}</h3><a href="${optiUrl}#features"${ga('cta', 'home-opti-features')}>${h.features.opti.link}</a></div>${grid(h.features.optiItems)}</div>
</div>
</section>

<section class="section soft" id="extras" aria-labelledby="extras-h">
<div class="wrap"><h2 id="extras-h">${h.extras.title}</h2><p class="lead">${h.extras.lead}</p>
<ul class="extras">${h.extras.items.map((i) => `<li>${iconTile(i.icon)}<div><h3>${i.h}</h3><p>${i.p}</p></div></li>`).join('')}</ul></div>
</section>

<section class="section" id="showcase" aria-labelledby="showcase-h">
<div class="wrap">
<div class="showcase-head"><div><h2 id="showcase-h">${h.showcase.title}</h2><p class="lead">${h.showcase.lead}</p></div>
<div class="theme-switch js-only" role="group" aria-label="${t.ui.themeSwitch}"><button type="button" data-theme-set="light" aria-pressed="false"${ga('theme', 'showcase-light')}>${t.ui.themeLight}</button><button type="button" data-theme-set="dark" aria-pressed="false"${ga('theme', 'showcase-dark')}>${t.ui.themeDark}</button></div></div>
<div class="showcase">${showcase}</div>
</div>
</section>

<section class="section soft" id="faq" aria-labelledby="faq-h">
<div class="wrap narrow"><h2 id="faq-h">${h.faq.title}</h2>
${faq}
<p class="note"><a href="${ideUrl}#faq">IntelyIDE</a> · <a href="${optiUrl}#faq">IntelyOpti</a></p>
</div>
</section>

<section class="section" id="about" aria-labelledby="about-h">
<div class="wrap narrow">
<h2 id="about-h">${h.about.title}</h2>
<p class="lead">${h.about.p}</p>
<p><a href="${cfg.githubUrl}"${ga('cta', 'home-author')}>${icons.github(16)} ${h.about.link}</a></p>
</div>
</section>

<section class="section final-cta" aria-labelledby="final-h">
<div class="wrap narrow center">
<h2 id="final-h">${h.cta.title}</h2>
<p class="lead">${h.cta.p}</p>
<div class="cta-row cta-center"><a class="btn btn-grad btn-lg" href="${esc(dlUrl)}"${ga('download', 'home-final-ide')}>${icons.download('sm')}<span>${t.home.hero.ide}</span></a><a class="btn btn-ghost btn-lg" href="${optiUrl}#get"${ga('cta', 'home-final-opti')}>${t.home.hero.opti}</a></div>
</div>
</section>`;
  return shell(ctx, {
    title: t.meta.homeTitle,
    desc: t.meta.homeDesc,
    path: homePath(lang),
    body,
    scripts: `<script src="${ctx.root}assets/hero-fx.js" defer></script>`,
    ld: companyLd(ctx),
  });
}

function companyLd(ctx) {
  const { cfg, t, lang } = ctx;
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': `${cfg.orgUrl}/#org`, name: 'IntelyHome', url: cfg.orgUrl, founder: { '@type': 'Person', name: 'Ferenc Farkas', url: cfg.githubUrl }, sameAs: [cfg.githubUrl] },
      { '@type': 'WebSite', name: 'IntelyHome', url: ctx.abs(homePath(lang)), inLanguage: lang, description: t.meta.homeDesc, publisher: { '@id': `${cfg.orgUrl}/#org` } },
    ],
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

// ---- Privacy and terms --------------------------------------------------------------------------------------

function legal(ctx, key) {
  const { t, lang } = ctx;
  const d = t.legal[key];
  const toc = d.sections.map((s) => `<li><a href="#${s.id}">${s.h}</a></li>`).join('');
  const sections = d.sections
    .map(
      (s) => `<section class="legal-sec" id="${s.id}" aria-labelledby="${s.id}-h">
<h2 id="${s.id}-h">${s.h}</h2>
${(s.paras ?? []).map((p) => `<p>${p}</p>`).join('\n')}
${s.list ? `<ul class="plain">${s.list.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
${(s.after ?? []).map((p) => `<p>${p}</p>`).join('\n')}
</section>`,
    )
    .join('\n');
  const body = `<section class="section page-head">
<div class="wrap narrow">
<h1>${d.h1}</h1>
<p class="lead">${d.lead}</p>
<p class="note">${t.legal.updated}</p>
<nav class="toc" aria-label="${t.ui.pageNav}"><ul>${toc}</ul></nav>
</div>
</section>
<section class="section legal">
<div class="wrap narrow">
${sections}
<p><a href="${href(ctx, homePath(lang))}">${t.page.backHome}</a></p>
</div>
</section>`;
  return shell(ctx, {
    title: t.meta[`${key}Title`],
    desc: t.meta[`${key}Desc`],
    path: pagePath(lang, key),
    body,
  });
}
const privacy = (ctx) => legal(ctx, 'privacy');
const terms = (ctx) => legal(ctx, 'terms');

function highlights(t) {
  const items = t.highlights.items
    .map((i) => `<li class="card"><h3>${i.h}</h3><p>${i.p}</p><a href="#${i.id}">${t.highlights.more}<span class="sr"> ${i.h}</span></a></li>`)
    .join('');
  return `<section class="section soft" id="highlights" aria-labelledby="highlights-h">
<div class="wrap"><h2 id="highlights-h">${t.highlights.title}</h2><ul class="cards cards-3">${items}</ul></div>
</section>`;
}

/** "Works with": the services IntelyIDE connects to, each with its logo and a link to its site. */
function partners(ctx) {
  const { t, cfg, root } = ctx;
  const p = t.partners;
  const cards = p.items
    .map((i) => {
      const partner = cfg.partners?.[i.key];
      if (!partner) return '';
      const logo = partnerLogo(partner.logo ?? i.key);
      const mark = logo
        ? `<img class="partner-logo" src="${root}assets/img/${logo.rel}" alt="${esc(partner.name)}" width="${logo.w}" height="${logo.h}" loading="lazy" decoding="async">`
        : `<span class="partner-name">${esc(partner.name)}</span>`;
      return `<li class="partner" id="partner-${i.key}">
<a class="partner-mark" href="${partner.url}" target="_blank" rel="noopener"${ga('cta', `partner-${i.key}-logo`)}>${mark}</a>
<div class="partner-text">
<h3>${i.h}</h3>
<p>${i.p}</p>
<p><a class="btn btn-ghost btn-sm" href="${partner.url}" target="_blank" rel="noopener"${ga('cta', `partner-${i.key}`)}>${i.cta}</a></p>
</div>
</li>`;
    })
    .join('');
  return `<section class="section" id="partners" aria-labelledby="partners-h">
<div class="wrap">
<h2 id="partners-h">${p.title}</h2>
<p class="lead">${p.lead}</p>
<ul class="partners">${cards}</ul>
<p class="note">${p.note}</p>
</div>
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

function ide(ctx0) {
  const ctx = withSticky(ctx0, 'ide');
  const { t, cfg, rel } = ctx;
  const dlHome = href(ctx, dlPath(ctx.lang));
  const why = t.why.cards.map((c) => `<li class="card"><h3>${c.h}</h3><p>${c.p}</p></li>`).join('');
  const features = t.features.items
    .map(
      (f) => `<article class="feature${f.shots.length ? '' : ' feature-solo'}" id="${f.id}" aria-labelledby="${f.id}-h">
<div class="feature-text">
<h3 id="${f.id}-h">${f.h}</h3>
${f.pill ? `<p class="pill">${f.pill}</p>` : ''}
<p>${f.p}</p>
<ul class="ticks">${f.list.map((x) => `<li>${x}</li>`).join('')}</ul>
${f.note ? `<p class="note">${f.note}</p>` : ''}
</div>
${f.shots.length ? `<div class="feature-media">${f.shots.map(([n, a]) => frame(picture(ctx.root, n, a))).join('')}</div>` : ''}
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
<p><a href="${dlHome}"${ga('cta', 'all-downloads')}>${t.dl.allDownloads}</a></p>
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

${partners(ctx)}

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
<div><h3>${t.trust.signedH}</h3><p>${t.trust.signedP}</p></div>
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
<p class="center"><a class="btn" href="${esc(rel.multi ? href(ctx, dlPath(ctx.lang)) : (rel.primary?.url ?? releasesUrl(cfg)))}"${ga('download', 'install')}>${icons.download('sm')}<span>${rel.multi ? t.dl.buttonGeneric : t.dl.button}</span></a></p>
</div>
</section>

<section class="section" id="faq" aria-labelledby="faq-h">
<div class="wrap narrow"><h2 id="faq-h">${t.faq.title}</h2>
${faq}
</div>
</section>

${crossBand(ctx, 'ide')}`;
  return shell(ctx, {
    title: t.meta.ideTitle,
    desc: t.meta.ideDesc,
    path: pagePath(ctx.lang, 'intelyide'),
    body,
    subnav: t.subnav.ide,
    preload: preloadHero(ctx.root),
    scripts: `<script src="${ctx.root}assets/hero-fx.js" defer></script>`,
    ld: ideLd(ctx),
  });
}

function ideLd(ctx) {
  const { cfg, rel, t } = ctx;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'IntelyIDE',
    description: t.meta.ideDesc,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: rel.multi ? 'macOS, Windows, Linux' : 'macOS',
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

export const pages = { home, ide, opti, privacy, terms, download, notFound };
